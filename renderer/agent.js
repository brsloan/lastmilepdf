// agent.js
//
// The renderer's half of the Claude connection (see lib/agent-server.js for
// the other half and for why requests come here at all rather than going
// straight to the worker). main.js forwards each tool call as an
// 'agent:request'; the handlers below answer from the same `state` and the
// same helpers the UI itself draws from, so what Claude is told is what the
// user is looking at.
//
// Reading and moving the view are always available. Editing only happens
// inside an editing session (begin_editing ... end_editing), which locks the
// user's input for its duration - see the "editing session" section below for
// why, and for how the user gets their controls back.
//
// Pages: the tree's `node.page` is 0-based, the UI and every tool are
// 1-based. Conversion happens here, at the edge, and nowhere else.

import { runFlattenAll, runScopeTables } from './actions.js';
import { regenerateBookmarksFromHeadings } from './bookmarks.js';
import { closeDetails, flushPendingLiveApply, refreshDetailsForSelection } from './details.js';
import { el } from './dom.js';
import { applyTagShortcutAction, performUndo } from './editing.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { collectTargetMcids, getPageMcidTextMap, getPageTextContent, hasDirectContentLeaf, pullContentText, pullDirectContentText } from './page-content.js';
import { cropNodeImages, renderRegionToPng } from './page-crop.js';
import { ACTION_DEFS, listSavedScripts, runScriptSteps } from './scripts.js';
import { TAG_SHORTCUT_ACTIONS, state } from './state.js';
import { isDescendant, walkTree } from './tree-index.js';
import { applyFreshTree, computeEmptyNodeIds, selectNode, selectNodes } from './tree-view.js';
import { categoryForRole } from './util.js';
import { runAccessibilityChecks } from './verify.js';
import { refreshHighlightForCurrentPage, refreshPdfPreviewBytes, renderCurrentPage, updatePageNavUI } from './viewer.js';

const SNIPPET_CHARS = 120;
const NODE_TEXT_CHARS = 400;

// find_nodes with a text query has to pull page content for every candidate,
// which means pdf.js text extraction for every page they sit on. Bounded so
// a vague query over a thousand-page scan answers in seconds, and says it
// stopped short rather than implying it looked everywhere.
const TEXT_SCAN_LIMIT = 3000;

const HEADING_OUTLINE_LIMIT = 200;

function requireDocument() {
  if (!state.docId) throw new Error('No PDF is open in the app. Ask the user to open one.');
}

function requireTree() {
  requireDocument();
  if (!state.tree) throw new Error('The open PDF has no tag tree (it is untagged).');
}

function requireNode(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) {
    throw new Error(`No tag with id "${nodeId}". Ids are renumbered by every edit - look it up again with find_nodes or get_nodes.`);
  }
  return entry;
}

/**
 * Why the view shouldn't be moved out from under the user right now, or null.
 * Turning the page discards a drawn rectangle; changing the selection
 * re-targets an open Table Editor. An editing session can't begin while any
 * of this is going on either, for the same reasons and one more: each holds
 * tag ids, and an edit renumbers them.
 * @returns {string | null}
 */
export function busyReason() {
  // The session bar is itself a modal dialog, and must not count: it being
  // open is Claude's doing, not the user's.
  const dialog = document.querySelector('dialog[open]:not(#agent-lock-dialog)');
  if (dialog) {
    const title = dialog.querySelector('h2')?.textContent?.trim();
    return title ? `the ${title} dialog is open` : 'a dialog is open';
  }
  if (state.tableGrid) return 'a Select Content table grid is in progress';
  if (state.rectSelectActive || state.rectSelectPending) return 'a Select Content selection is in progress';
  if (state.figureDrawActive) return 'Add Figure drawing is in progress';
  if (state.walking) return 'Walk is running';
  if (document.body.classList.contains('busy')) return 'the app is part-way through a long-running job';
  return null;
}

function requireIdle(action) {
  const reason = busyReason();
  if (reason) throw new Error(`Can't ${action} right now: ${reason} in the user's window. Ask them to finish or close it.`);
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A tag's own `page` is only what its /Pg says, and a container - a Table, a
// heading wrapping Spans - routinely has none while everything inside it
// does. "Which page is this table on" still has an obvious answer, so fall
// back to where its first piece of content sits.
function pageOf(node) {
  if (node.page !== null && node.page !== undefined) return node.page + 1;
  if (node.type !== 'element') return null;
  const page = firstContentPage(node);
  return page === null ? null : page + 1;
}

/** 0-based page of the first content leaf under `node`, stopping as soon as one is found. */
function firstContentPage(node) {
  for (const child of node.children || []) {
    if (child.type === 'content' && child.page !== null && child.page !== undefined) return child.page;
    const below = firstContentPage(child);
    if (below !== null) return below;
  }
  return null;
}

/** Roles from the top of the tree down to the node's parent, "Document > Sect > Table". */
function rolePath(nodeId) {
  const roles = [];
  let cur = state.nodesById.get(nodeId)?.parentId;
  while (cur && cur !== 'root') {
    const entry = state.nodesById.get(cur);
    if (!entry) break;
    roles.unshift(entry.node.role || entry.node.type);
    cur = entry.parentId;
  }
  return roles.join(' > ');
}

/** The attributes worth reporting, leaving out the ones that are unset. */
function attributesOf(node) {
  const out = {};
  for (const key of ['alt', 'actualText', 'lang', 'scope', 'colSpan', 'rowSpan']) {
    if (node[key] !== null && node[key] !== undefined && node[key] !== '') out[key] = node[key];
  }
  return out;
}

/** One compact row for a tag: what find_nodes and get_view list. */
async function nodeRow(node) {
  /** @type {Record<string, any>} */
  const row = { id: node.id, role: node.role || node.type, page: pageOf(node), path: rolePath(node.id), ...attributesOf(node) };
  if (row.actualText) row.actualText = clip(row.actualText, SNIPPET_CHARS);
  if (row.alt) row.alt = clip(row.alt, SNIPPET_CHARS);
  if (node.type === 'element') {
    const text = clip(await pullContentText(node.id), SNIPPET_CHARS);
    if (text) row.text = text;
  }
  return row;
}

const handlers = {
  async getStatus() {
    if (!state.docId) return { documentOpen: false };
    return {
      documentOpen: true,
      fileName: state.fileName,
      filePath: state.savedFilePath,
      pageCount: state.pageCount,
      tagged: state.hasStructTree,
      unsavedChanges: state.dirty,
      title: state.docInfo?.title ?? null,
      author: state.docInfo?.author ?? null,
      language: state.docInfo?.lang ?? null,
      bookmarkCount: countBookmarks(state.outline),
    };
  },

  async getView() {
    requireDocument();
    const selected = [];
    for (const id of state.selectedNodeIds) {
      const entry = state.nodesById.get(id);
      if (entry) selected.push(await nodeRow(entry.node));
    }
    return {
      currentPage: state.currentPage,
      pageCount: state.pageCount,
      activeNodeId: state.selectedNodeId,
      selected,
      treeFilter: state.filter,
      proofreadMode: state.proofreadMode,
      userBusyWith: busyReason(),
      editingSessionOpen: session !== null,
    };
  },

  async getTreeSummary() {
    requireTree();
    const roleCounts = {};
    const tagsPerPage = {};
    const headings = [];
    let tagCount = 0;
    let contentLeafCount = 0;
    let maxDepth = 0;
    let figuresMissingAlt = 0;

    (function visit(node, depth) {
      if (node.type === 'element') {
        tagCount += 1;
        maxDepth = Math.max(maxDepth, depth);
        roleCounts[node.role] = (roleCounts[node.role] || 0) + 1;
        const page = pageOf(node);
        if (page !== null) tagsPerPage[page] = (tagsPerPage[page] || 0) + 1;
        if (categoryForRole(node.role) === 'heading') headings.push(node);
        if ((node.role === 'Figure' || node.role === 'Formula') && !node.alt) figuresMissingAlt += 1;
      } else if (node.type === 'content') {
        contentLeafCount += 1;
      }
      for (const child of node.children || []) visit(child, depth + 1);
    })(state.tree, 0);

    const outline = [];
    for (const node of headings.slice(0, HEADING_OUTLINE_LIMIT)) {
      outline.push({
        id: node.id,
        role: node.role,
        page: pageOf(node),
        text: clip(node.actualText || await pullContentText(node.id), SNIPPET_CHARS),
      });
    }

    return {
      pageCount: state.pageCount,
      tagCount,
      contentLeafCount,
      maxDepth,
      roleCounts,
      tagsPerPage,
      figuresMissingAlt,
      emptyTagCount: computeEmptyNodeIds().size,
      headings: outline,
      headingsTruncated: headings.length > HEADING_OUTLINE_LIMIT,
    };
  },

  /** @param {{ nodeId?: string, depth?: number, maxNodes?: number, includeText?: boolean, includeLeaves?: boolean }} [params] */
  async getNodes({ nodeId, depth = 3, maxNodes = 300, includeText = true, includeLeaves = false } = {}) {
    requireTree();
    const start = nodeId ? requireNode(nodeId).node : state.tree;
    let budget = maxNodes;
    let truncated = false;

    async function describe(node, levelsLeft) {
      budget -= 1;
      /** @type {Record<string, any>} */
      const out = { id: node.id, role: node.role || node.type, page: pageOf(node), ...attributesOf(node) };
      const kids = node.children || [];
      // Content leaves are reported as a count, not listed: an OCR'd
      // paragraph is routinely dozens of them, and the text they paint is
      // already on the tag that holds them.
      const elementKids = kids.filter((k) => k.type !== 'content');
      const leafCount = kids.length - elementKids.length;
      if (leafCount > 0) out.contentLeaves = leafCount;
      // ...unless asked for, which is what wrap_content needs: the leaves'
      // own ids, each with the text it paints, in the order they sit among
      // this tag's children (`position`, since they are listed apart from
      // the child tags they may be interleaved with).
      if (includeLeaves && leafCount > 0) {
        out.leaves = [];
        for (let position = 0; position < kids.length; position += 1) {
          const kid = kids[position];
          if (kid.type !== 'content') continue;
          budget -= 1;
          /** @type {Record<string, any>} */
          const leaf = { id: kid.id, position, page: pageOf(kid), mcid: kid.mcid ?? null };
          if (includeText && kid.page !== null && kid.page !== undefined && kid.mcid !== null && kid.mcid !== undefined) {
            const text = clip((await getPageMcidTextMap(kid.page + 1)).get(kid.mcid), SNIPPET_CHARS);
            if (text) leaf.text = text;
          }
          out.leaves.push(leaf);
        }
      }
      if (includeText && node.type === 'element' && hasDirectContentLeaf(node)) {
        const text = clip(await pullDirectContentText(node.id), NODE_TEXT_CHARS);
        if (text) out.text = text;
      }
      if (elementKids.length === 0) return out;
      if (levelsLeft <= 0 || budget < elementKids.length) {
        out.childCount = elementKids.length;
        out.truncated = true;
        truncated = true;
        // A cut-off tag still says what it holds - otherwise a table read
        // two levels deep is a grid of cells with nothing in them, since a
        // cell's text usually sits in a P one level further down.
        if (includeText && !out.text) {
          const text = clip(await pullContentText(node.id), SNIPPET_CHARS);
          if (text) out.text = text;
        }
        return out;
      }
      out.children = [];
      for (const kid of elementKids) out.children.push(await describe(kid, levelsLeft - 1));
      return out;
    }

    const tree = await describe(start, depth);
    return {
      tree,
      truncated,
      ...(truncated ? { hint: 'Tags marked truncated have more below them - call get_nodes again with that id.' } : {}),
    };
  },

  /** @param {{ roles?: string[], text?: string, pageFrom?: number, pageTo?: number, missingAlt?: boolean, limit?: number }} [params] */
  async findNodes({ roles, text, pageFrom, pageTo, missingAlt = false, limit = 50 } = {}) {
    requireTree();
    const wantedRoles = roles && roles.length ? new Set(roles) : null;
    const needle = text ? text.toLowerCase() : null;

    const candidates = [];
    walkTree(state.tree, (node) => {
      if (node.type !== 'element' || node.id === state.hiddenDocumentId) return;
      if (wantedRoles && !wantedRoles.has(node.role)) return;
      if (missingAlt && !((node.role === 'Figure' || node.role === 'Formula') && !node.alt)) return;
      const page = pageOf(node);
      if (pageFrom && (page === null || page < pageFrom)) return;
      if (pageTo && (page === null || page > pageTo)) return;
      candidates.push(node);
    });

    let matches = candidates;
    let scanTruncated = false;
    if (needle) {
      matches = [];
      let scanned = 0;
      for (const node of candidates) {
        if (matches.length >= limit) break;
        if (scanned >= TEXT_SCAN_LIMIT) {
          scanTruncated = true;
          break;
        }
        scanned += 1;
        const own = `${node.actualText || ''}\n${node.alt || ''}`.toLowerCase();
        if (own.includes(needle) || (await pullContentText(node.id)).toLowerCase().includes(needle)) {
          matches.push(node);
        }
      }
    }

    const rows = [];
    for (const node of matches.slice(0, limit)) rows.push(await nodeRow(node));
    return {
      // With a text query the search stops at `limit`, so the true total
      // isn't known - only that there may be more.
      totalMatches: needle ? null : matches.length,
      returned: rows.length,
      mayHaveMore: needle ? (rows.length >= limit || scanTruncated) : matches.length > limit,
      ...(scanTruncated ? { note: `Text search stopped after ${TEXT_SCAN_LIMIT} tags - narrow it with roles or a page range.` } : {}),
      nodes: rows,
    };
  },

  async verify({ maxInstances = 20 } = {}) {
    requireDocument();
    const { groups, failCount, warnCount, passCount } = await runAccessibilityChecks();
    return {
      failCount,
      warnCount,
      passCount,
      groups: groups.map((group) => ({
        name: group.name,
        checks: group.checks.map((check) => ({
          title: check.title,
          status: check.status,
          detail: check.detail,
          instanceCount: check.instances.length,
          instances: check.instances.slice(0, maxInstances).map((i) => ({ nodeId: i.nodeId, detail: i.detail })),
          ...(check.fix ? { oneClickFixInApp: check.fix.label } : {}),
        })),
      })),
    };
  },

  /** @param {{ page?: number, nodeId?: string }} [params] */
  async getPageImage({ page, nodeId } = {}) {
    requireDocument();
    if (nodeId) {
      requireTree();
      const { node } = requireNode(nodeId);
      const images = await cropNodeImages(nodeId);
      if (images.length === 0) {
        throw new Error(`Tag ${nodeId} (${node.role || node.type}) has no content on any page to show.`);
      }
      const pagesSpanned = new Set(collectTargetMcids(nodeId).map((t) => t.page)).size;
      const pages = images.map((i) => i.page).join(', ');
      const more = pagesSpanned > images.length ? ` It spans ${pagesSpanned} pages; only the first ${images.length} are shown.` : '';
      return { images, note: `${node.role || node.type} ${nodeId}, cropped from page ${pages}.${more}` };
    }
    const pageNumber = page ?? state.currentPage;
    if (pageNumber < 1 || pageNumber > state.pageCount) {
      throw new Error(`Page ${pageNumber} is out of range - the document has ${state.pageCount} pages.`);
    }
    const { viewport } = await getPageTextContent(pageNumber);
    const image = await renderRegionToPng(pageNumber, { x: 0, y: 0, width: viewport.width, height: viewport.height });
    return { images: [image], note: `Page ${pageNumber} of ${state.pageCount}.` };
  },

  async goToPage({ page }) {
    requireDocument();
    if (page < 1 || page > state.pageCount) {
      throw new Error(`Page ${page} is out of range - the document has ${state.pageCount} pages.`);
    }
    requireIdle('turn the page');
    if (page !== state.currentPage) {
      state.currentPage = page;
      await renderCurrentPage();
      updatePageNavUI();
      refreshHighlightForCurrentPage();
    }
    return { currentPage: state.currentPage, pageCount: state.pageCount };
  },

  async selectNodes({ nodeIds }) {
    requireTree();
    requireIdle('change the selection');
    const found = nodeIds.filter((id) => state.nodesById.has(id));
    const missing = nodeIds.filter((id) => !state.nodesById.has(id));
    if (found.length === 0) {
      throw new Error('None of those ids exist. Ids are renumbered by every edit - look them up again.');
    }
    if (found.length === 1) selectNode(found[0]);
    else selectNodes(found);
    return { selected: found, ...(missing.length ? { notFound: missing } : {}) };
  },

  // --- editing (all inside a session - see below) -------------------------

  async beginEditing({ description }) {
    requireTree();
    if (session) throw new Error('An editing session is already open. Carry on editing, or call end_editing first.');
    if (stoppedByUser) {
      // Said once, then cleared: the tool can't know whether the user has
      // since asked for more, only make sure Claude stops to consider it.
      stoppedByUser = false;
      throw new Error('The user pressed Stop on your last editing session. Only begin another if they have asked you to since then - if so, call begin_editing again.');
    }
    requireIdle('start editing');
    // Whatever the user had half-typed into the properties pane is theirs:
    // commit it before the lock takes the field away from them - and before
    // the session's undo group opens, or their edit would become part of
    // Claude's step and be taken back with it. Blurring fires the field's own
    // 'change' commit now rather than when the session bar steals focus; its
    // request goes out ahead of setUndoGroup()'s on the same ordered channel.
    const focused = /** @type {HTMLElement | null} */ (document.activeElement);
    if (focused && focused !== document.body) focused.blur();
    await flushPendingLiveApply();
    openSession(clip(description, 200));
    return {
      editing: true,
      note: `The user's input is locked until you call end_editing, so don't hold the session open while you think or talk - begin, make the edits, end. It ends by itself after ${SESSION_IDLE_TIMEOUT_MS / 1000}s without a call from you. Everything you change in this session is ONE undo step for the user.`,
    };
  },

  /** @param {{ summary?: string }} [params] */
  async endEditing({ summary } = {}) {
    if (!session) return { editing: false, note: 'No editing session was open.' };
    const { editCount, touched, deletedCount } = session;
    const what = summary ? `Claude finished: ${clip(summary, 200).replace(/\.$/, '')}.` : 'Claude finished.';
    closeSession(editCount > 0
      ? `${what} ${UNDO_HINT}`
      : 'Claude finished without changing anything.');
    return { editing: false, editCount, tagsChanged: touched.length, tagsDeleted: deletedCount, unsavedChanges: state.dirty };
  },

  /** @param {{ revision: number, updates: { nodeIds: string[], changes: Record<string, string> }[] }} params */
  async updateNodes({ revision: readAt, updates }) {
    const current = requireSession();
    requireFreshIds(readAt, updates.flatMap((u) => u.nodeIds));
    // Checked up front, all of it, so a bad id in the fifth entry doesn't
    // leave the first four applied.
    for (const { nodeIds } of updates) {
      for (const id of nodeIds) {
        const { node } = requireNode(id);
        if (node.type !== 'element') throw new Error(`${id} is a ${node.type} node, not a tag - only tags have attributes.`);
      }
    }
    const touched = [];
    for (const { nodeIds, changes } of updates) {
      await commitEdit(current, await window.api.updateNodes(state.docId, nodeIds, changes));
      touched.push(...nodeIds);
    }
    noteTouched(current, touched);
    showResult(touched);
    // Attribute changes never reshape the tree, so no id moved.
    return { updated: touched.length, idsUnchanged: true };
  },

  /** @param {{ revision: number, nodeIds: string[], action: string }} params */
  async applyTagAction({ revision: readAt, nodeIds, action }) {
    const current = requireSession();
    requireFreshIds(readAt, nodeIds);
    if (!TAG_SHORTCUT_ACTIONS.some((a) => a.id === action)) {
      throw new Error(`Unknown action "${action}". Use one of: ${TAG_SHORTCUT_ACTIONS.map((a) => a.id).join(', ')}.`);
    }
    for (const id of nodeIds) requireNode(id);
    // Literally what the user's own keystroke does: select, then run the
    // shortcut's action. That is the point - list-label detection, which tag
    // a join lands in, what gets selected afterwards - all of it is the
    // app's existing behaviour rather than a second implementation of it.
    const before = shapeOf(state.tree);
    const earliest = earliestIndex(before, nodeIds);
    const treeBefore = state.tree;
    if (nodeIds.length === 1) selectNode(nodeIds[0]);
    else selectNodes(nodeIds);
    await applyTagShortcutAction(action);
    const message = el.statusBar.textContent.trim();
    // Those actions report failure to the status bar instead of throwing, so
    // "did the tree get replaced" is the only reliable sign one worked.
    if (state.tree === treeBefore) throw new Error(`Nothing changed. The app said: "${message}"`);
    current.editCount += 1;
    // The app leaves its selection on whatever the action produced.
    noteTouched(current, Array.from(state.selectedNodeIds));
    return { message, ...idReport(before, earliest), nowSelected: await selectedRows() };
  },

  /** @param {{ revision: number, nodeIds: string[], newParentId: string, index: number }} params */
  async moveNodes({ revision: readAt, nodeIds, newParentId, index }) {
    const current = requireSession();
    requireFreshIds(readAt, [...nodeIds, newParentId]);
    const parent = requireNode(newParentId).node;
    if (parent.type === 'content' || parent.type === 'object-ref') throw new Error(`${newParentId} is a content leaf and can't hold other tags.`);
    for (const id of nodeIds) {
      requireNode(id);
      if (isDescendant(id, newParentId)) throw new Error(`Can't move ${id} into ${newParentId}: that is itself or something inside it.`);
    }
    const before = shapeOf(state.tree);
    // The worker places them in the order given, and means document order.
    const ordered = [...nodeIds].sort((a, b) => before.index.get(a) - before.index.get(b));
    const slot = (parent.children || [])[index];
    const earliest = Math.min(earliestIndex(before, ordered), slot ? before.index.get(slot.id) : before.index.get(newParentId));
    // Taken before the move: afterwards these ids may name other tags, but
    // the content under them is the same content wherever it lands.
    const keys = contentKeysFor(ordered);
    await commitEdit(current, await window.api.reorderMany(state.docId, ordered, newParentId, index));
    current.touched.push(...keys);
    closeDetails();
    return { moved: ordered.length, ...idReport(before, earliest) };
  },

  /** @param {{ revision: number, nodeIds: string[] }} params */
  async deleteNodes({ revision: readAt, nodeIds }) {
    const current = requireSession();
    requireFreshIds(readAt, nodeIds);
    for (const id of nodeIds) {
      const { node } = requireNode(id);
      if (node.type === 'root') throw new Error('The root of the tag tree can\'t be deleted.');
      // Deleting a bare content leaf hides that text from assistive technology
      // and does nothing else - never what "delete this tag" means. The user
      // can still do it by hand; Claude has to name a tag.
      if (node.type !== 'element') throw new Error(`${id} is a ${node.type} leaf, not a tag. delete_nodes only takes tags.`);
    }
    const topLevel = nodeIds.filter((id) => !nodeIds.some((other) => other !== id && isDescendant(other, id)));
    const before = shapeOf(state.tree);
    const earliest = earliestIndex(before, topLevel);
    await commitEdit(current, await window.api.deleteNodes(state.docId, topLevel));
    current.deletedCount += topLevel.length;
    closeDetails();
    return { deleted: topLevel.length, ...idReport(before, earliest) };
  },

  /** @param {{ revision: number, leafIds: string[], role: string }} params */
  async wrapContent({ revision: readAt, leafIds, role }) {
    const current = requireSession();
    requireFreshIds(readAt, leafIds);
    // A list needs to know where each item starts and a table needs a grid -
    // the app gets both from a rectangle drawn on the page, which Claude
    // can't draw. Wrapping as paragraphs and grouping those is the same
    // result by a route that needs neither.
    if (role === 'L' || role === 'Table') {
      throw new Error(`wrap_content can't build a ${role} directly. Wrap each item's or cell's content as P (or TD/TH) first, then group those with apply_tag_action ("list", or "tr" then "table").`);
    }
    for (const id of leafIds) {
      const { node } = requireNode(id);
      if (node.type !== 'content') throw new Error(`${id} is a ${node.type === 'element' ? `${node.role} tag` : node.type}, not a content leaf. To change a tag's role use update_nodes; get leaf ids from get_nodes with includeLeaves.`);
    }
    const before = shapeOf(state.tree);
    const earliest = earliestIndex(before, leafIds);
    const result = await window.api.wrapLeaves(state.docId, leafIds, role);
    await commitEdit(current, result);
    noteTouched(current, [result.newNodeId]);
    showResult([result.newNodeId]);
    return {
      newNodeId: result.newNodeId,
      // True when the leaves were the whole content of one tag, which was
      // relabelled in place (keeping its alt text and so on) instead.
      relabelledExistingTag: result.relabelled,
      emptiedTagsRemoved: result.removedTagCount,
      ...idReport(before, earliest),
    };
  },

  /** @param {{ revision: number, splits: { leafId: string, cutBefore: string[] }[] }} params */
  async splitContent({ revision: readAt, splits }) {
    const current = requireSession();
    const leafIds = splits.map((s) => s.leafId);
    requireFreshIds(readAt, leafIds);
    for (const id of leafIds) {
      const { node } = requireNode(id);
      if (node.type !== 'content') throw new Error(`${id} is a ${node.type === 'element' ? `${node.role} tag` : node.type}, not a content leaf. Get leaf ids from get_nodes with includeLeaves.`);
    }
    const before = shapeOf(state.tree);
    const earliest = earliestIndex(before, leafIds);
    // Taken before the cut, by the tags holding the leaves: those are what
    // the user will want to look at afterwards, and their content keys
    // survive a split (the first piece keeps its mcid).
    const parentKeys = contentKeysFor(leafIds.map((id) => state.nodesById.get(id)?.parentId).filter(Boolean));
    const result = await window.api.splitLeaves(state.docId, splits.map((s) => ({ nodeId: s.leafId, cutBefore: s.cutBefore })));
    await commitEdit(current, result);
    current.touched.push(...parentKeys);
    const pieceIds = result.splits.flatMap((s) => s.pieces.map((p) => p.nodeId)).filter(Boolean);
    showResult(pieceIds);
    return {
      cutsMade: result.cutCount,
      splits: result.splits.map((s) => ({ leaf: s.leafId, pieces: s.pieces.map((p) => ({ id: p.nodeId, text: clip(p.text, SNIPPET_CHARS) })) })),
      ...idReport(before, earliest),
    };
  },

  async listScripts() {
    const { scripts, activeScriptId } = await listSavedScripts();
    return {
      scripts: scripts.map((script) => ({
        name: script.name,
        assignedToRunScriptButton: script.id === activeScriptId,
        runnableByClaude: !script.steps.some((step) => step.type === AI_STEP),
        steps: script.steps.map((step) => describeScriptStep(step)),
      })),
      note: scripts.length === 0 ? 'The user has not saved any scripts (Tools > Scripts… in the app).' : undefined,
    };
  },

  /** @param {{ name: string }} params */
  async runScript({ name }) {
    const current = requireSession();
    const { scripts } = await listSavedScripts();
    const wanted = name.trim().toLowerCase();
    const script = scripts.find((s) => s.name.trim().toLowerCase() === wanted);
    if (!script) {
      throw new Error(`No saved script is called "${name}". The user's scripts: ${scripts.map((s) => `"${s.name}"`).join(', ') || 'none'}.`);
    }
    if (script.steps.length === 0) throw new Error(`Script "${script.name}" has no steps.`);
    // That step sends the whole document's text to the AI provider on the
    // user's own key and runs for minutes - their money and their wait, so
    // theirs to start. It would also outlast the session's idle timeout.
    if (script.steps.some((step) => step.type === AI_STEP)) {
      throw new Error(`Script "${script.name}" includes Fix All Actual Text (AI), which spends the user's AI credit and can run for minutes. Ask them to run it themselves with the Run Script button.`);
    }
    const before = shapeOf(state.tree);
    const treeBefore = state.tree;
    let results;
    try {
      results = await runScriptSteps(script, (i, label) => {
        setStatus(`Claude is running "${script.name}" - step ${i + 1}/${script.steps.length}: ${label}…`);
      });
    } finally {
      // Counted even when a later step failed: the steps before it were
      // applied, and they are part of this session's undo step.
      if (state.tree !== treeBefore) current.editCount += 1;
    }
    closeDetails();
    return { script: script.name, steps: results, ...idReport(before, 0) };
  },

  async generateBookmarks() {
    const current = requireSession();
    // The Generate button clears the outline when there are no headings. A
    // user pressing it can see that happen; Claude asking for bookmarks on an
    // untitled-heading document almost certainly didn't mean "delete them".
    let hasHeadings = false;
    walkTree(state.tree, (node) => {
      if (node.type === 'element' && /^H[1-6]$/.test(node.role || '')) hasHeadings = true;
    });
    if (!hasHeadings) {
      throw new Error('The document has no H1-H6 headings to build bookmarks from, so nothing was changed. Tag the headings first (apply_tag_action "h1"-"h6"), then generate.');
    }
    const replaced = countBookmarks(state.outline);
    const count = await regenerateBookmarksFromHeadings();
    current.editCount += 1;
    setStatus(`Claude generated ${count} bookmark${count === 1 ? '' : 's'} from headings.`);
    return { bookmarksGenerated: count, bookmarksReplaced: replaced, bookmarks: describeOutline(state.outline) };
  },

  /** @param {{ title?: string, author?: string, language?: string }} params */
  async setDocumentProperties({ title, author, language }) {
    const current = requireSession();
    /** @type {import('../types/domain').DocInfoChanges} */
    const changes = {};
    if (title !== undefined) changes.title = title.trim();
    if (author !== undefined) changes.author = author.trim();
    if (language !== undefined) changes.lang = language.trim();
    if (Object.keys(changes).length === 0) throw new Error('Give at least one of title, author or language.');
    const result = await window.api.updateDocInfo(state.docId, changes);
    state.docInfo = result.docInfo;
    applyUndoState(result);
    current.editCount += 1;
    // The properties pane shows these fields when the document root is
    // selected; redraw it so the user sees the new values land.
    if (state.selectedNodeId === 'root') refreshDetailsForSelection({ allowPageJump: false });
    setStatus('Claude updated the document properties.');
    const { title: newTitle, author: newAuthor, lang } = state.docInfo;
    return { title: newTitle ?? null, author: newAuthor ?? null, language: lang ?? null, idsUnchanged: true };
  },

  async flattenAll() {
    return runWholeDocumentAction(requireSession(), runFlattenAll);
  },

  async scopeTables() {
    return runWholeDocumentAction(requireSession(), runScopeTables);
  },

  async undoSessionEdits() {
    const current = requireSession();
    // Only ever Claude's own work, and the worker is asked rather than the
    // edit count trusted: not everything counted here pushes an undo step (a
    // Scope Tables that found nothing doesn't), and being wrong by one would
    // take back something the user did. All of its work, too, not the last
    // piece - a session is one undo step (see the undo group below), so there
    // is no smaller unit to step back by.
    const { undoGroup } = await window.api.getUndoOwner(state.docId);
    if (undoGroup !== current.token) throw new Error('You have changed nothing in this session, so there is nothing of yours to undo.');
    const treeBefore = state.tree;
    await performUndo();
    if (state.tree === treeBefore) throw new Error(`Undo did not go through. The app said: "${el.statusBar.textContent.trim()}"`);
    const undone = current.editCount;
    current.editCount = 0;
    current.touched = [];
    current.deletedCount = 0;
    return { undone, note: 'The document is back to how it was when this session began, and the session is still open. Tag ids may have changed - re-read before editing further.' };
  },
};

// --- editing session ---------------------------------------------------------
//
// Claude's edits and the user's are both just calls to the worker, and the
// worker takes them one at a time, so the *document* can't be corrupted by the
// two overlapping. What can go wrong is everything that holds a tag id: ids
// are a depth-first counter reassigned on every rebuild, so an edit by one
// side quietly changes which tag the other side's ids mean. The user's
// half-made selection, an open Table Editor, the id Claude looked up a moment
// ago - each would go on to name the wrong tag with nothing to show for it.
//
// So edits take turns. A session can only begin when the user is idle
// (busyReason()), and for as long as it lasts the window is locked: the
// session bar is a modal <dialog>, which makes everything behind it inert,
// and preload.js holds back the application menu, which a modal can't reach.
// The user can always see what is happening, and always has Stop.
//
// A session that goes quiet ends itself. Claude can crash, be interrupted, or
// simply forget end_editing, and none of those may leave the user locked out
// of their own document.
//
// A session is also one undo step. For its duration every request to the
// worker carries the session's token (main.js adds it - see setUndoGroup() in
// preload.js), and the worker snapshots once for the lot: "fix these thirty
// tables" is one Ctrl+Z, not thirty, and thirty fewer full copies of the PDF.

const SESSION_IDLE_TIMEOUT_MS = 120000;

const UNDO_HINT = 'One Ctrl+Z undoes all of it.';

/**
 * @typedef {{ page: number, mcid: number, role: string | null }} ContentKey
 * @type {{ token: string, editCount: number, touched: ContentKey[], deletedCount: number, idleTimer: ReturnType<typeof setTimeout> | null } | null}
 */
let session = null;
let stoppedByUser = false;
let sessionCounter = 0;

function openSession(description) {
  sessionCounter += 1;
  session = { token: `claude-${Date.now()}-${sessionCounter}`, editCount: 0, touched: [], deletedCount: 0, idleTimer: null };
  hideChangesButton();
  window.api.setUndoGroup(session.token);
  touchSession();
  el.agentLockDescription.textContent = description || '';
  window.api.setMenuLocked(true);
  el.agentLockDialog.showModal();
  el.btnAgentStop.focus();
  setStatus('Claude is editing…');
}

function closeSession(statusMessage) {
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const { touched } = session;
  session = null;
  window.api.setUndoGroup(null);
  window.api.setMenuLocked(false);
  el.agentLockDialog.close();
  setStatus(statusMessage);
  offerChanges(touched);
}

/** Any call from Claude counts as a sign of life, reads included. */
function touchSession() {
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    const count = session ? session.editCount : 0;
    closeSession(`Claude went quiet, so its editing session was ended. Your controls are back.${count > 0 ? ` ${UNDO_HINT}` : ''}`);
  }, SESSION_IDLE_TIMEOUT_MS);
}

function stopSessionByUser() {
  if (!session) return;
  const { editCount } = session;
  stoppedByUser = true;
  closeSession(editCount > 0
    ? `Stopped Claude after ${editCount} edit${editCount === 1 ? '' : 's'}. ${UNDO_HINT}`
    : 'Stopped Claude before it changed anything.');
}

// Returns the session rather than just checking for one, and the edit
// handlers count against what it returned: an edit that outlives its session
// (the user pressed Stop mid-call) must not be counted against the next one.
function requireSession() {
  requireTree();
  if (session) return session;
  if (stoppedByUser) {
    throw new Error('The user pressed Stop, which ended your editing session. Tell them what was and wasn\'t done, and don\'t start again unless they ask.');
  }
  throw new Error('No editing session is open. Call begin_editing first (if one was open, it timed out).');
}

/** The three steps every edit in this app ends with - see shell.js's applyUndoState(). */
async function commitEdit(current, result) {
  // Present only when the edit rewrote a page's content stream, which leaves
  // pdf.js parsing bytes the new tree no longer describes.
  if (result.pdfBase64) await refreshPdfPreviewBytes(result.pdfBase64);
  applyFreshTree(result.tree);
  applyUndoState(result);
  current.editCount += 1;
}

/** Puts the selection on what was just edited, so the user watching sees where Claude is working. */
function showResult(nodeIds) {
  const ids = nodeIds.filter((id) => state.nodesById.has(id));
  if (ids.length === 1) selectNode(ids[0]);
  else if (ids.length > 1) selectNodes(ids);
}

async function selectedRows() {
  const rows = [];
  for (const id of state.selectedNodeIds) {
    const entry = state.nodesById.get(id);
    if (entry) rows.push(await nodeRow(entry.node));
  }
  return rows;
}

// --- what Claude changed -----------------------------------------------------
//
// After a session the status bar offers to select every tag it touched, so a
// batch can be reviewed rather than taken on trust. Ids are no use for
// remembering them - the session's own later edits renumber them - so a tag
// is remembered by the first piece of page content under it, which keeps its
// (page, mcid) wherever the tag around it goes, plus the role it was left
// with. Resolved only when asked for, against the tree as it is then - so the
// offer stays good while the user goes on editing, and after an undo it shows
// where the changes *were*. Tags with no content under them can't be
// remembered this way and are left out; deleted ones are gone by definition.

/** @type {{ docId: string, keys: ContentKey[] } | null} */
let lastChanges = null;

function firstContentLeaf(node) {
  for (const child of node.children || []) {
    if (child.type === 'content' && child.mcid !== null && child.mcid !== undefined
        && child.page !== null && child.page !== undefined) return child;
    const below = firstContentLeaf(child);
    if (below) return below;
  }
  return null;
}

/** @returns {ContentKey[]} */
function contentKeysFor(nodeIds) {
  const keys = [];
  for (const id of nodeIds) {
    const node = state.nodesById.get(id)?.node;
    const leaf = node && node.type === 'element' ? firstContentLeaf(node) : null;
    if (leaf) keys.push({ page: leaf.page, mcid: leaf.mcid, role: node.role });
  }
  return keys;
}

function noteTouched(current, nodeIds) {
  current.touched.push(...contentKeysFor(nodeIds));
}

/** The ids those keys name in the tree as it is now, in the order recorded, without repeats. */
function resolveContentKeys(keys) {
  const ids = [];
  const seen = new Set();
  for (const key of keys) {
    const ownerId = state.mcidIndex.get(key.page)?.get(key.mcid);
    if (!ownerId) continue;
    // The tag that was touched is the content's owner or something above it
    // (a Table, for its first cell's text): climb to the nearest tag with the
    // role it was left with, and settle for the owner if there isn't one.
    let match = ownerId;
    let cur = ownerId;
    while (cur && cur !== 'root') {
      const entry = state.nodesById.get(cur);
      if (!entry) break;
      if (entry.node.role === key.role) {
        match = cur;
        break;
      }
      cur = entry.parentId;
    }
    if (!seen.has(match) && match !== state.hiddenDocumentId) {
      seen.add(match);
      ids.push(match);
    }
  }
  return ids;
}

function hideChangesButton() {
  lastChanges = null;
  el.btnShowAgentChanges.hidden = true;
}

function offerChanges(keys) {
  const count = state.docId ? resolveContentKeys(keys).length : 0;
  if (count === 0) {
    hideChangesButton();
    return;
  }
  lastChanges = { docId: state.docId, keys };
  el.btnShowAgentChanges.textContent = `Show the ${count === 1 ? 'tag' : `${count} tags`} Claude changed`;
  el.btnShowAgentChanges.hidden = false;
}

function showLastChanges() {
  if (!lastChanges || lastChanges.docId !== state.docId) {
    hideChangesButton();
    return;
  }
  const reason = busyReason();
  if (reason) {
    setStatus(`Can't change the selection while ${reason}.`);
    return;
  }
  const ids = resolveContentKeys(lastChanges.keys);
  if (ids.length === 0) {
    hideChangesButton();
    setStatus('The tags Claude changed are no longer in the document.');
    return;
  }
  if (ids.length === 1) selectNode(ids[0]);
  else selectNodes(ids);
  setStatus(`Selected the ${ids.length === 1 ? 'tag' : `${ids.length} tags`} Claude changed.`);
}

// --- bookmarks ---------------------------------------------------------------

function countBookmarks(outline) {
  let count = 0;
  for (const node of outline || []) count += 1 + countBookmarks(node.children);
  return count;
}

const OUTLINE_REPORT_LIMIT = 300;

/** The outline as nested {title, page}, 1-based pages, capped so a huge one stays readable. */
function describeOutline(outline) {
  let budget = OUTLINE_REPORT_LIMIT;
  const visit = (nodes) => {
    const out = [];
    for (const node of nodes || []) {
      if (budget <= 0) break;
      budget -= 1;
      /** @type {Record<string, any>} */
      const item = { title: node.title, page: node.page === null || node.page === undefined ? null : node.page + 1 };
      if (node.children && node.children.length) item.children = visit(node.children);
      out.push(item);
    }
    return out;
  };
  return visit(outline);
}

// --- the user's saved scripts ---------------------------------------------------

const AI_STEP = 'fix-actual-text-ai';

function describeScriptStep(step) {
  const def = ACTION_DEFS.find((d) => d.type === step.type);
  const label = def ? def.label : step.type;
  return step.type === 'find-replace'
    ? `${label}: every /${step.findRole} becomes /${step.replaceRole}`
    : `${label} - ${def ? def.hint : ''}`;
}

/** Flatten All and Scope Tables: no targets, a message back, and maybe no change at all. */
async function runWholeDocumentAction(current, run) {
  const before = shapeOf(state.tree);
  const message = await run();
  // These re-apply the tree even when they found nothing to do, so a new tree
  // object alone doesn't mean an undo step was pushed - the message does.
  const changed = !/^No /.test(message);
  if (changed) current.editCount += 1;
  return { message, changed, ...idReport(before, 0) };
}

// --- which ids survived an edit ----------------------------------------------
//
// Ids are a counter handed out in document (depth-first) order on every
// rebuild, so an edit leaves every tag *before* the first thing it touched
// with the id it had, and may hand every id after that to a different tag.
// An id Claude read a moment ago can therefore come to name something else
// entirely - and an edit made with it would land, without any error, on the
// wrong tag.
//
// So the tree has a revision number, sent back with every result, and every
// edit must say which revision its ids were read at. Each renumbering is
// recorded as "revision N renumbered from id nK onward"; an id is accepted
// only if no renumbering since the revision it was read at reaches it. That
// still lets Claude keep using ids from before the edit point - which is why
// a long run of structural edits is best made from the end of the document
// backwards - while making the dangerous case impossible rather than
// merely documented.
//
// Changes are noticed by comparing trees, not by hooking the edit paths, so
// the user's own edits, undo/redo and opening another file are all covered
// without any of that code having to know this exists.

let revision = 0;

/** @type {{ docId: string, tree: object, shape: ReturnType<typeof shapeOf> } | null} */
let tracked = null;

/** @type {{ revision: number, boundaryNum: number }[]} */
const renumberings = [];
const RENUMBERINGS_KEPT = 500;

function idNumber(id) {
  const match = /^n(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * The tree flattened in document order. `marks` say what sits at each
 * position - depth, kind, and for a content leaf which marked content it is -
 * but not role or attributes: a relabel changes no id, and leaving those out
 * is what lets one be recognised as such. The mcid is what makes swapping two
 * same-shaped siblings show up as the change it is.
 * @returns {{ ids: string[], marks: string[], index: Map<string, number>, ordered: boolean }}
 */
function shapeOf(tree) {
  const ids = [];
  const marks = [];
  const index = new Map();
  let ordered = true;
  let last = -1;
  (function visit(node, depth) {
    index.set(node.id, ids.length);
    ids.push(node.id);
    marks.push(`${depth}:${node.type}:${node.mcid ?? ''}:${node.type === 'content' ? node.page ?? '' : ''}`);
    if (node.id !== 'root') {
      const n = idNumber(node.id);
      if (n <= last) ordered = false;
      last = n;
    }
    for (const child of node.children || []) visit(child, depth + 1);
  })(tree, 0);
  return { ids, marks, index, ordered };
}

function earliestIndex(shape, nodeIds) {
  return Math.min(...nodeIds.map((id) => shape.index.get(id) ?? 0));
}

/** Position of the first difference between two shapes, or null if there is none. */
function firstDifference(before, after) {
  const shared = Math.min(before.marks.length, after.marks.length);
  let i = 0;
  while (i < shared && before.marks[i] === after.marks[i]) i += 1;
  return i === before.marks.length && i === after.marks.length ? null : i;
}

function recordRenumbering(boundaryNum) {
  revision += 1;
  renumberings.push({ revision, boundaryNum });
  if (renumberings.length > RENUMBERINGS_KEPT) renumberings.shift();
}

/**
 * Brings `revision` up to date with whatever the tree is now. Cheap when
 * nothing has changed (one identity comparison), so it runs around every call.
 * @param {number} [earliestTouched] Position of the first tag an edit named -
 *   a floor under the comparison, for anything it might not see.
 */
function syncRevision(earliestTouched) {
  if (!state.tree || !state.docId) {
    tracked = null;
    return;
  }
  if (tracked && tracked.docId === state.docId && tracked.tree === state.tree) return;
  const shape = shapeOf(state.tree);
  if (!tracked || tracked.docId !== state.docId) {
    // A different document: nothing read before it means anything now.
    recordRenumbering(0);
    if (lastChanges && lastChanges.docId !== state.docId) hideChangesButton();
  } else {
    const diff = firstDifference(tracked.shape, shape);
    if (diff !== null) {
      const at = Math.min(diff, earliestTouched ?? diff);
      // If ids ever turned out not to run in document order, "before the
      // boundary" would mean nothing - so invalidate everything instead.
      recordRenumbering(tracked.shape.ordered && shape.ordered ? idNumber(tracked.shape.ids[at]) : 0);
    }
  }
  tracked = { docId: state.docId, tree: state.tree, shape };
}

/** Lowest id number renumbered since `since`, or Infinity if nothing was. */
function renumberedFromSince(since) {
  if (renumberings.length > 0 && since < renumberings[0].revision - 1) return 0; // older than the history kept
  let lowest = Infinity;
  for (const entry of renumberings) {
    if (entry.revision > since) lowest = Math.min(lowest, entry.boundaryNum);
  }
  return lowest;
}

function requireFreshIds(readAtRevision, nodeIds) {
  if (readAtRevision > revision) {
    throw new Error(`treeRevision ${readAtRevision} hasn't happened yet - the tree is at ${revision}. Pass the treeRevision from the result you read these ids in.`);
  }
  const from = renumberedFromSince(readAtRevision);
  const stale = nodeIds.filter((id) => id !== 'root' && idNumber(id) >= from);
  if (stale.length === 0) return;
  const many = stale.length > 1;
  throw new Error(
    `Refused: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? '…' : ''} ${many ? 'were' : 'was'} read at treeRevision ${readAtRevision}, `
    + `and the tree has since been renumbered from n${from} onward (it is now at ${revision}), so ${many ? 'they' : 'it'} may name different tags now. `
    + 'Look them up again with find_nodes or get_nodes and use the treeRevision that comes back. Nothing was changed.',
  );
}

/**
 * What an edit's result says about ids. Run after the edit, it also advances
 * the revision - so the treeRevision sent back with this result is already
 * the one to use for whatever comes next.
 * @param {ReturnType<typeof shapeOf>} before
 * @param {number} earliestTouched
 */
function idReport(before, earliestTouched) {
  const at = revision;
  syncRevision(earliestTouched);
  if (revision === at) return { idsUnchanged: true };
  const from = renumberings[renumberings.length - 1].boundaryNum;
  if (from === 0) {
    return { idsUnchanged: false, renumberedFrom: 'the start', note: 'Every tag id may now name a different tag - look up again anything you still need.' };
  }
  return {
    idsUnchanged: false,
    renumberedFrom: `n${from}`,
    note: `Tags with ids below n${from} kept them and can still be used with the new treeRevision. n${from} and above may now name different tags - look those up again.`,
  };
}

/**
 * Answers one forwarded tool call. Errors travel back as their message only:
 * that text is what Claude reads, so every throw above is written for it.
 */
async function handleRequest({ id, method, params }) {
  touchSession();
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown agent method "${method}".`);
    // Before, so an edit the user made since the last call is accounted for
    // when this one's ids are checked; after, so the revision sent back is
    // the one describing the tree this call left behind.
    syncRevision();
    const result = await handler(params || {});
    syncRevision();
    window.api.agentReply({ id, result: state.tree ? { ...result, treeRevision: revision } : result });
  } catch (err) {
    console.error(`[agent] ${method} failed:`, err);
    window.api.agentReply({ id, error: String((err && err.message) || err) });
  }
}

// --- File > Settings > Preferences > Claude connection ----------------------

/** @param {import('../types/domain').AgentConfig} config */
function drawAgentPreferences(config) {
  el.preferencesAgentEnabled.checked = config.enabled;
  el.preferencesAgentDetails.hidden = !config.running;
  el.preferencesAgentCommand.value = config.running ? config.command : '';
  el.preferencesAgentJson.value = config.running ? config.mcpJson : '';
  if (config.error) el.preferencesAgentStatus.textContent = config.error;
  else if (config.running) el.preferencesAgentStatus.textContent = `On - listening at ${config.url}`;
  else el.preferencesAgentStatus.textContent = 'Off.';
}

/** Called as the Preferences dialog opens, so it shows the server's state now rather than at launch. */
export async function refreshAgentPreferences() {
  try {
    drawAgentPreferences(await window.api.getAgentConfig());
  } catch (err) {
    reportError('Could not read the Claude connection settings', err);
  }
}

export function initAgentBridge() {
  window.api.onAgentRequest((_event, request) => { handleRequest(request); });

  el.btnAgentStop.addEventListener('click', stopSessionByUser);
  el.btnShowAgentChanges.addEventListener('click', showLastChanges);
  // Escape on a modal dialog fires 'cancel' and then closes it. Closing the
  // bar without ending the session would leave the menu locked and Claude
  // still editing behind an unlocked window, so Escape means Stop.
  el.agentLockDialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    stopSessionByUser();
  });
  window.api.onMenuBlocked(() => {
    setStatus('Claude is editing - press Stop (or Escape) to take back control first.');
  });

  el.preferencesAgentEnabled.addEventListener('change', async () => {
    try {
      drawAgentPreferences(await window.api.setAgentEnabled(el.preferencesAgentEnabled.checked));
    } catch (err) {
      reportError('Could not change the Claude connection', err);
    }
  });

  el.preferencesAgentCommand.addEventListener('focus', () => el.preferencesAgentCommand.select());

  const copyOnClick = (button, field, what) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(field.value);
        setStatus(`Copied the Claude connection ${what}.`);
      } catch (err) {
        reportError(`Could not copy the ${what}`, err);
      }
    });
  };
  copyOnClick(el.btnCopyAgentCommand, el.preferencesAgentCommand, 'command');
  copyOnClick(el.btnCopyAgentJson, el.preferencesAgentJson, 'file contents');
}
