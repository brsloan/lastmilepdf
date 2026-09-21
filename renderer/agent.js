// agent.js
//
// The renderer's half of the Claude connection (see lib/agent-server.js for
// the other half and for why requests come here at all rather than going
// straight to the worker). main.js forwards each tool call as an
// 'agent:request'; the handlers below answer from the same `state` and the
// same helpers the UI itself draws from, so what Claude is told is what the
// user is looking at.
//
// Everything here is read-only or view-only (turn the page, change the
// selection). Nothing calls a mutating window.api method - that is stage two,
// and it goes through busyReason() first.
//
// Pages: the tree's `node.page` is 0-based, the UI and every tool are
// 1-based. Conversion happens here, at the edge, and nowhere else.

import { el } from './dom.js';
import { reportError, setStatus } from './shell.js';
import { collectTargetMcids, getPageTextContent, hasDirectContentLeaf, pullContentText, pullDirectContentText } from './page-content.js';
import { cropNodeImages, renderRegionToPng } from './page-crop.js';
import { state } from './state.js';
import { walkTree } from './tree-index.js';
import { computeEmptyNodeIds, selectNode, selectNodes } from './tree-view.js';
import { categoryForRole } from './util.js';
import { runAccessibilityChecks } from './verify.js';
import { refreshHighlightForCurrentPage, renderCurrentPage, updatePageNavUI } from './viewer.js';

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
 * re-targets an open Table Editor. Stage two's edit guard starts from this.
 * @returns {string | null}
 */
export function busyReason() {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    const title = dialog.querySelector('h2')?.textContent?.trim();
    return title ? `the ${title} dialog is open` : 'a dialog is open';
  }
  if (state.tableGrid) return 'a Select Content table grid is in progress';
  if (state.rectSelectActive || state.rectSelectPending) return 'a Select Content selection is in progress';
  if (state.figureDrawActive) return 'Add Figure drawing is in progress';
  if (state.walking) return 'Walk is running';
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

  /** @param {{ nodeId?: string, depth?: number, maxNodes?: number, includeText?: boolean }} [params] */
  async getNodes({ nodeId, depth = 3, maxNodes = 300, includeText = true } = {}) {
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
};

/**
 * Answers one forwarded tool call. Errors travel back as their message only:
 * that text is what Claude reads, so every throw above is written for it.
 */
async function handleRequest({ id, method, params }) {
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown agent method "${method}".`);
    window.api.agentReply({ id, result: await handler(params || {}) });
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
