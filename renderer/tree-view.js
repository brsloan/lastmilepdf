// tree-view.js
//
// The tag tree in the left pane: building its rows, filtering them, the
// collapse/expand state, drag-and-drop reordering, and which tags are
// selected.
//
// Selection lives here rather than in its own module because it is what the
// rows are: clicking, shift-clicking and ctrl-clicking a row are the same
// code path that draws it.
//
// This module and details.js import each other: selecting a row refreshes
// the properties pane, and an edit made in that pane rewrites the tree. That
// is a real two-way relationship, not an accident of layout, and it is the
// only import cycle in the renderer. It is safe because everything crossing
// it is a `function` declaration - those are hoisted and fully initialized
// before any of this code runs - and because neither module calls into the
// other while it is being evaluated. Keep it that way: if you ever convert
// one of the crossing functions to `const fn = () => ...`, it will become a
// load-order bug rather than an error.

import { pruneStaleAiProposals } from './actual-text.js';
import { closeDetails, refreshDetailsForSelection } from './details.js';
import { el, selectableRows } from './dom.js';
import { getPageMcidGraphicsInfo, getPageMcidTextMap, hasDirectContentLeaf } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { buildMcidIndex, indexTree, isDescendant, nodePathFromRoot, resolveNodeByPath } from './tree-index.js';
import { categoryForRole } from './util.js';

// Node ids that have no AT change of their own but have a descendant (at any
// depth) flagged in state.atChangeFlags - recomputed once per render pass
// (not per node) and consulted by appendElementChipAndFlag() so an ancestor
// can show a "changes below" badge instead of silently hiding them behind a
// collapsed subtree.
let descendantAtChangeIds = new Set();

function computeDescendantAtChangeIds() {
  const ids = new Set();
  if (!state.showAtChanges || !state.tree) return ids;
  function walk(node) {
    let below = false;
    for (const child of node.children || []) {
      if (walk(child)) below = true;
    }
    if (below) ids.add(node.id);
    return below || state.atChangeFlags.has(node.id);
  }
  walk(state.tree);
  return ids;
}

export function renderTree() {
  el.tagTreeContent.innerHTML = '';
  descendantAtChangeIds = computeDescendantAtChangeIds();
  if (!state.tree) {
    const p = document.createElement('p');
    p.className = 'tree-placeholder';
    p.textContent = 'No document loaded.';
    el.tagTreeContent.appendChild(p);
    return;
  }
  // Proofread Mode (View > Proofread) overrides the dropdown filter
  // entirely rather than folding into state.filter - that way the
  // dropdown's own selection is left untouched underneath it and the tree
  // just falls back to whatever it was already set to the moment
  // proofreading turns back off (see setProofreadMode() in proofread.js).
  if (state.proofreadMode) {
    renderProofreadTree();
    return;
  }
  if (state.filter !== 'all') {
    renderFilteredTree();
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  ul.appendChild(renderTreeNode(state.tree));
  el.tagTreeContent.appendChild(ul);
}

function nodeMatchesFilter(node) {
  if (state.filter === 'all') return true;
  if (node.type !== 'element') return false;
  if (state.filter === 'headings') return categoryForRole(node.role) === 'heading';
  if (state.filter === 'figures') return node.role === 'Figure';
  if (state.filter === 'table') return node.role === 'Table';
  return true;
}

function collectFilteredNodes(node, matches, stopAtMatch) {
  if (nodeMatchesFilter(node)) {
    matches.push(node);
    if (stopAtMatch) return;
  }
  for (const child of node.children || []) collectFilteredNodes(child, matches, stopAtMatch);
}

function renderFilteredTree() {
  const nested = state.filter === 'figures' || state.filter === 'table';
  const matches = [];
  collectFilteredNodes(state.tree, matches, nested);

  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'tree-placeholder';
    p.textContent = 'No matching tags.';
    el.tagTreeContent.appendChild(p);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const node of matches) {
    ul.appendChild(nested ? renderTreeNode(node) : renderFilteredRow(node));
  }
  el.tagTreeContent.appendChild(ul);
}

function renderFilteredRow(node) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.dataset.nodeId = node.id;
  row.className = 'tree-row selectable';
  applySelectionClasses(row, node.id);

  appendElementChipAndFlag(row, node);
  row.addEventListener('click', (e) => handleRowClick(node.id, e));

  li.appendChild(row);
  return li;
}

// Matches _is_organizational_role()'s "span" half in tag_worker.py (the
// Flatten feature's own definition of a Span-like tag) - Span itself plus
// any custom role name containing "span" case-insensitively, to catch
// vendor-specific inline-span variants some generators emit under their own
// namespaced names.
function isSpanLikeRole(role) {
  return !!role && role.toLowerCase().includes('span');
}

// Proofread Mode's own tag - there's nothing meaningful to proofread on a
// tag with neither Actual Text of its own nor real page content directly
// inside it (a bare Div/Sect wrapper, say), so it's left out rather than
// shown as an empty stop along the way. Lbl (a list item's own bullet/
// number label) and any Span-like tag are excluded outright even when they
// qualify otherwise - Lbl is auto-generated marker text rather than prose,
// and a Span is normally just an inline run inside a paragraph that already
// gets its own stop, so listing either separately would mostly be noise.
// Figure is excluded too - its own text field is Alt Text, not Actual Text,
// so it's not something this mode's Actual Text field has any business
// stepping onto (a Figure that itself carries real Actual Text is the rare
// exception, not worth keeping the general case around for).
function nodeQualifiesForProofread(node) {
  return node.type === 'element' && node.role !== 'Lbl' && node.role !== 'Figure' && !isSpanLikeRole(node.role)
    && (!!(node.actualText && node.actualText.trim()) || hasDirectContentLeaf(node));
}

// Unlike collectFilteredNodes()'s figures/table case, this never stops at a
// match - a qualifying tag can itself contain another qualifying tag (e.g.
// a Figure with its own Actual Text wrapping a Caption that has its own),
// and proofreading is meant to visit both in document order, not just the
// outermost one.
function collectProofreadNodes(node, matches) {
  if (nodeQualifiesForProofread(node)) matches.push(node);
  for (const child of node.children || []) collectProofreadNodes(child, matches);
}

// The whole tree flattened down to just its proofread-worthy tags, each a
// plain row with no toggle/indentation - a straight, stacked sequence
// reflecting only document order, since Proofread Mode's own Page Up/Down
// and edge-of-line Up/Down stepping (see proofread.js) is the only way
// through it and has no use for expand/collapse or nesting.
function renderProofreadTree() {
  const matches = [];
  collectProofreadNodes(state.tree, matches);

  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'tree-placeholder';
    p.textContent = 'No tags with Actual Text or content to proofread.';
    el.tagTreeContent.appendChild(p);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const node of matches) ul.appendChild(renderFilteredRow(node));
  el.tagTreeContent.appendChild(ul);
}

// Proofread Mode (View > Proofread) needs to scroll the tag tree so the
// selected row lines up with the Actual Text field's own top edge even
// when that row sits at the very top/bottom of the (flat, filtered) list -
// past what #tag-tree would otherwise let it scroll to, since normally
// there's nothing beyond the list's own first/last row to scroll into.
// #tag-tree-scroll-spacer-top/-bottom (zero height outside Proofread Mode -
// see the CSS) exist purely to give that extra room. Mirrors
// setProofreadScrollSpacersActive() in viewer.js, which does the same thing
// for the PDF preview's highlight box - including the same "apply the
// height before compensating scrollTop" ordering, since scrollTop
// assignments are clamped to whatever range exists at that exact moment.
export function setTagTreeScrollSpacersActive(active) {
  const desired = active ? Math.round(el.tagTree.clientHeight) : 0;
  const previousTopHeight = el.tagTreeScrollSpacerTop.offsetHeight;
  el.tagTreeScrollSpacerTop.style.height = `${desired}px`;
  el.tagTreeScrollSpacerBottom.style.height = `${desired}px`;
  if (previousTopHeight !== desired) {
    el.tagTree.scrollTop += desired - previousTopHeight;
  }
}

// Scrolls #tag-tree purely vertically so `row`'s top edge lands at the same
// viewport y-coordinate as the Actual Text field's top edge - the tag-tree
// counterpart to alignActiveBoxWithActualText() in viewer.js. Unlike that
// one, `row` is an ordinary in-flow element rather than a separately
// positioned/synced overlay, so growing the spacer above it is enough on
// its own to leave getBoundingClientRect() reporting its real, already-
// shifted position - no extra "resync" step needed.
export function alignSelectedTagTreeRow(row) {
  setTagTreeScrollSpacersActive(true);
  const rowTop = row.getBoundingClientRect().top;
  const fieldTop = el.fieldActualText.getBoundingClientRect().top;
  el.tagTree.scrollTop += rowTop - fieldTop;
}

// Shared by both tree-render paths: 'selected' marks the active/focused tag
// (the one the details panel, highlight, and scroll follow); 'multi-selected'
// marks every OTHER member of a >1-tag selection with a lighter tint, so the
// active tag still reads as visually distinct from the rest of the block.
function applySelectionClasses(row, nodeId) {
  if (state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(nodeId)) row.classList.add('multi-selected');
  if (nodeId === state.selectedNodeId) row.classList.add('selected');
}

// Document (root) and Div/Document elements default to expanded; every
// other element defaults to collapsed, with a +/- toggle to reveal its
// nested contents.
function isCollapsedByDefault(node) {
  return node.type === 'element' && node.role !== 'Div' && node.role !== 'Document';
}

export function isNodeCollapsed(node) {
  if (state.collapseOverrides.has(node.id)) return state.collapseOverrides.get(node.id);
  return isCollapsedByDefault(node);
}

export function toggleNodeCollapsed(node) {
  state.collapseOverrides.set(node.id, !isNodeCollapsed(node));
  renderTree();
}

function appendElementChipAndFlag(row, node) {
  const chip = document.createElement('span');
  chip.className = 'tag-chip';
  chip.dataset.category = categoryForRole(node.role);
  chip.textContent = `/${node.role}`;
  row.appendChild(chip);

  if ((node.role === 'Figure' || node.role === 'Formula') && !node.alt) {
    const flag = document.createElement('span');
    flag.className = 'missing-alt-flag';
    flag.textContent = 'no alt text';
    row.appendChild(flag);
  }

  if (state.aiProposals.has(node.id)) {
    const aiFlag = document.createElement('span');
    aiFlag.className = 'ai-fix-flag';
    aiFlag.textContent = 'AI fix';
    row.appendChild(aiFlag);
  } else if (state.showAtChanges && state.atChangeFlags.has(node.id)) {
    const atFlag = document.createElement('span');
    atFlag.className = 'ai-fix-flag';
    // Proofread Mode's tree is a narrow, flat strip (see renderProofreadTree()
    // above) - the full "AT changed" label doesn't fit it the way it does the
    // normal tree, so it collapses to a bare asterisk there, with the full
    // wording still available as a tooltip.
    atFlag.textContent = state.proofreadMode ? '*' : 'AT changed';
    if (state.proofreadMode) atFlag.title = 'Actual Text changed from content';
    row.appendChild(atFlag);
  } else if (state.showAtChanges && descendantAtChangeIds.has(node.id)) {
    const atFlag = document.createElement('span');
    atFlag.className = 'ai-fix-flag';
    atFlag.textContent = state.proofreadMode ? '*' : '↓ AT changed';
    if (state.proofreadMode) atFlag.title = 'A tag below this one has Actual Text changed from content';
    row.appendChild(atFlag);
  }
}

function renderTreeNode(node) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.dataset.nodeId = node.id;

  if (node.type === 'root') {
    row.className = 'tree-row';
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.category = 'container';
    chip.textContent = 'Document';
    row.appendChild(chip);
    const meta = document.createElement('span');
    meta.className = 'tree-node-meta';
    meta.textContent = 'structure root';
    row.appendChild(meta);
    // Root can't be selected or dragged, but it IS a valid drop target
    // (for promoting a node to top-level), so it still gets drop handlers.
    // It has no parent/siblings of its own, so only "into" makes sense.
    attachDropHandlers(row, node.id, { allowBeforeAfter: false });
  } else if (node.type === 'element') {
    row.className = 'tree-row selectable';
    applySelectionClasses(row, node.id);
    row.draggable = true;

    const hasChildren = !!(node.children && node.children.length > 0);
    const collapsed = hasChildren && isNodeCollapsed(node);
    if (hasChildren) {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      toggle.textContent = collapsed ? '+' : '−';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNodeCollapsed(node);
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'tree-toggle-spacer';
      row.appendChild(spacer);
    }

    appendElementChipAndFlag(row, node);

    row.addEventListener('click', (e) => handleRowClick(node.id, e));
    row.addEventListener('dragstart', (e) => {
      // Dragging a tag that's part of the current multi-selection drags the
      // whole block; dragging any other tag is just a single-tag drag,
      // regardless of what else happens to be selected.
      const isBlockDrag = state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(node.id);
      state.draggedNodeIds = isBlockDrag ? new Set(state.selectedNodeIds) : new Set([node.id]);
      state.draggedNodeId = node.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.id);
    });
    attachDropHandlers(row, node.id);
  } else {
    // 'content' (bare MCID / MCR) or 'object-ref' (OBJR) - not editable, but
    // (like element tags) selectable and movable: dragged/reordered the same
    // way. It can't hold children (see the backend's _is_container check),
    // so it's never an "into" drop target - but it can still anchor a
    // before/after drop, letting a tag land beside a leaf in the list.
    row.className = 'tree-row selectable';
    applySelectionClasses(row, node.id);
    row.draggable = true;

    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle-spacer';
    row.appendChild(spacer);

    const hasTextPreview = node.type === 'content' && node.mcid !== null && node.mcid !== undefined
      && node.page !== null && node.page !== undefined;
    if (!hasTextPreview) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.category = 'leaf';
      chip.textContent = node.type === 'object-ref'
        ? (node.objType ? `[${node.objType}]` : 'objref')
        : 'content';
      row.appendChild(chip);
      if (node.mcid !== null && node.mcid !== undefined) {
        const meta = document.createElement('span');
        meta.className = 'tree-node-meta';
        meta.textContent = `mcid ${node.mcid}`;
        row.appendChild(meta);
      }
    } else {
      const textSpan = document.createElement('span');
      textSpan.className = 'tree-node-text';
      row.appendChild(textSpan);
      const cached = formatCachedLeafText(node.page, node.mcid);
      if (cached) {
        textSpan.textContent = cached.text;
        textSpan.title = cached.title;
      } else {
        loadContentText(node.page, node.mcid, textSpan);
      }
    }

    row.addEventListener('click', (e) => handleRowClick(node.id, e));
    row.addEventListener('dragstart', (e) => {
      // Same block-vs-single logic as an element tag's dragstart, above.
      const isBlockDrag = state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(node.id);
      state.draggedNodeIds = isBlockDrag ? new Set(state.selectedNodeIds) : new Set([node.id]);
      state.draggedNodeId = node.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.id);
    });
    attachDropHandlers(row, node.id, { allowInto: false });
  }

  li.appendChild(row);

  const isCollapsedElement = node.type === 'element' && isNodeCollapsed(node);
  if (node.children && node.children.length > 0 && !isCollapsedElement) {
    const ul = document.createElement('ul');
    ul.className = 'tree-children';
    for (const child of node.children) {
      ul.appendChild(renderTreeNode(child));
    }
    li.appendChild(ul);
  }

  return li;
}

const DRAG_OVER_CLASSES = ['drag-over-into', 'drag-over-before', 'drag-over-after'];

// Which third of a row the pointer is over decides the drop zone: the top
// and bottom bands mean "insert as a sibling before/after this row", the
// middle band means "append as a child of this row". A row that can't
// accept children (allowInto: false, e.g. a content/object-ref leaf) skips
// straight to a 50/50 split between before/after. A row with no siblings of
// its own to insert next to (allowBeforeAfter: false, i.e. the root) is
// always "into".
function dropZoneForEvent(e, row, { allowInto, allowBeforeAfter }) {
  if (!allowBeforeAfter) return 'into';
  const rect = row.getBoundingClientRect();
  const frac = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
  if (!allowInto) return frac < 0.5 ? 'before' : 'after';
  if (frac < 0.25) return 'before';
  if (frac > 0.75) return 'after';
  return 'into';
}

// Where a node lands among `newParentId`'s children once every dragged id
// has already been removed from wherever it used to live - matching how the
// backend computes it (reorder_node/reorder_many both remove first, then
// insert at newIndex against that already-reduced list). Computing it the
// same way here means a drop that reorders within the same parent lands
// exactly on the requested side of the target, not off-by-one.
function computeDropIndex(newParentId, targetSiblingId, zone, excludeIds) {
  const parentEntry = state.nodesById.get(newParentId);
  const children = (parentEntry?.node.children || []).map((c) => c.id);
  const reduced = children.filter((id) => !excludeIds.has(id));
  if (zone === 'into') return reduced.length;
  const idx = reduced.indexOf(targetSiblingId);
  const base = idx === -1 ? reduced.length : idx;
  return zone === 'after' ? base + 1 : base;
}

function attachDropHandlers(row, targetNodeId, opts = {}) {
  const allowInto = opts.allowInto !== false;
  const allowBeforeAfter = opts.allowBeforeAfter !== false;

  row.addEventListener('dragover', (e) => {
    if (!state.draggedNodeId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = dropZoneForEvent(e, row, { allowInto, allowBeforeAfter });
    row.dataset.dropZone = zone;
    row.classList.remove(...DRAG_OVER_CLASSES);
    row.classList.add(`drag-over-${zone}`);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove(...DRAG_OVER_CLASSES);
    delete row.dataset.dropZone;
  });
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    const zone = row.dataset.dropZone || 'into';
    row.classList.remove(...DRAG_OVER_CLASSES);
    delete row.dataset.dropZone;
    const draggedIds = state.draggedNodeIds ? Array.from(state.draggedNodeIds) : [];
    state.draggedNodeId = null;
    state.draggedNodeIds = null;
    if (draggedIds.length === 0) return;

    // "into" the hovered row makes it the new parent; "before"/"after"
    // instead makes ITS parent the new parent, and the hovered row the
    // sibling to land next to.
    let newParentId = targetNodeId;
    let siblingId = null;
    if (zone !== 'into') {
      const targetEntry = state.nodesById.get(targetNodeId);
      if (!targetEntry || targetEntry.parentId === null) return;
      newParentId = targetEntry.parentId;
      siblingId = targetNodeId;
    }

    if (draggedIds.length === 1) {
      const draggedId = draggedIds[0];
      if (isDescendant(draggedId, newParentId)) {
        setStatus("Can't move a tag into its own descendant.");
        return;
      }
      const newIndex = computeDropIndex(newParentId, siblingId, zone, new Set([draggedId]));
      const newParentPath = nodePathFromRoot(newParentId);
      try {
        const result = await window.api.reorderNode(state.docId, draggedId, newParentId, newIndex);
        applyFreshTree(result.tree);
        applyUndoState(result);
        // Re-select the moved node at its new (post-rebuild) id - besides
        // being a nice "here's where it landed" cue, selectNode()'s
        // expandAncestors() call is what keeps the destination tag open.
        // Without it the destination's collapse override (if any) stays
        // attached to whatever id it had before the drop, which the
        // depth-first renumbering may have handed to a different node -
        // see nodePathFromRoot() above.
        const freshParent = newParentPath ? resolveNodeByPath(newParentPath) : null;
        const movedNode = freshParent?.children?.[newIndex];
        if (movedNode) selectNode(movedNode.id);
        setStatus('Moved tag.');
      } catch (err) {
        reportError('Could not move tag', err);
      }
      return;
    }

    // Block move: only the outermost dragged tags actually move - a
    // dragged descendant of another dragged tag just comes along inside
    // its (also-moving) ancestor - ordered by their current document
    // position regardless of click/drag order.
    const rows = selectableRows();
    const orderedIds = rows.map((r) => r.dataset.nodeId).filter((id) => draggedIds.includes(id));
    const topLevelIds = orderedIds.filter((id) => !orderedIds.some((other) => other !== id && isDescendant(other, id)));

    if (topLevelIds.some((id) => isDescendant(id, newParentId))) {
      setStatus("Can't move tags into their own selection or descendants.");
      return;
    }
    if (siblingId && topLevelIds.includes(siblingId)) return;

    const newIndex = computeDropIndex(newParentId, siblingId, zone, new Set(topLevelIds));
    const newParentPath = nodePathFromRoot(newParentId);
    try {
      const result = await window.api.reorderMany(state.docId, topLevelIds, newParentId, newIndex);
      applyFreshTree(result.tree);
      applyUndoState(result);
      // Same re-selection/re-expansion as the single-node drop above, just
      // over the whole moved block (mirrors moveSelectedBlock()).
      const freshParent = newParentPath ? resolveNodeByPath(newParentPath) : null;
      const movedIds = (freshParent?.children || []).slice(newIndex, newIndex + topLevelIds.length).map((c) => c.id);
      if (movedIds.length > 0) {
        state.selectedNodeIds = new Set(movedIds);
        state.selectedNodeId = movedIds[movedIds.length - 1];
        state.selectionAnchorId = movedIds[0];
        expandAncestors(state.selectedNodeId);
        renderTree();
        refreshDetailsForSelection();
      }
      setStatus(`Moved ${topLevelIds.length} tags.`);
    } catch (err) {
      reportError('Could not move tags', err);
    }
  });
}

export function applyFreshTree(tree) {
  state.tree = tree;
  state.nodesById = indexTree(tree);
  state.mcidIndex = tree ? buildMcidIndex(tree) : new Map();
  pruneStaleAiProposals();

  if (state.selectedNodeIds.size > 0) {
    state.selectedNodeIds = new Set(Array.from(state.selectedNodeIds).filter((id) => state.nodesById.has(id)));
  }
  if (state.selectedNodeId && !state.nodesById.has(state.selectedNodeId)) {
    if (state.selectedNodeIds.size > 0) {
      state.selectedNodeId = Array.from(state.selectedNodeIds).pop();
    } else {
      closeDetails();
    }
  }
  renderTree();
}

function expandAncestors(nodeId) {
  let entry = state.nodesById.get(nodeId);
  while (entry && entry.parentId !== null) {
    entry = state.nodesById.get(entry.parentId);
    if (entry && entry.node.type === 'element') state.collapseOverrides.set(entry.node.id, false);
  }
}

// Plain click (and keyboard nav / page-click selection): replaces any
// existing selection with just this one tag.
export function selectNode(nodeId) {
  state.selectedNodeIds = new Set([nodeId]);
  state.selectionAnchorId = nodeId;
  state.selectedNodeId = nodeId;
  expandAncestors(nodeId);
  renderTree();
  refreshDetailsForSelection();
}

function handleRowClick(nodeId, e) {
  if (e.shiftKey) {
    extendSelectionTo(nodeId);
  } else if (e.ctrlKey || e.metaKey) {
    toggleSelectionMember(nodeId);
  } else {
    selectNode(nodeId);
  }
}

// Shift+click: selects every visible row between the fixed anchor (the last
// plain or ctrl+click) and the clicked tag, inclusive - same DOM-order list
// arrow-key navigation uses, so it naturally follows collapse/filter state.
export function extendSelectionTo(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type === 'root') return;

  if (!state.selectionAnchorId || !state.nodesById.has(state.selectionAnchorId)) {
    selectNode(nodeId);
    return;
  }

  const rows = selectableRows();
  const anchorIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectionAnchorId);
  const targetIndex = rows.findIndex((row) => row.dataset.nodeId === nodeId);
  if (anchorIndex === -1 || targetIndex === -1) {
    selectNode(nodeId);
    return;
  }

  const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  state.selectedNodeIds = new Set(rows.slice(start, end + 1).map((row) => row.dataset.nodeId));
  state.selectedNodeId = nodeId;
  renderTree();
  refreshDetailsForSelection();
}

// Ctrl/Cmd+click: adds/removes just the clicked tag, leaving the rest of
// the selection alone, and becomes the new shift+click anchor.
function toggleSelectionMember(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type === 'root') return;

  const next = new Set(state.selectedNodeIds);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);

  state.selectedNodeIds = next;
  state.selectionAnchorId = nodeId;

  if (next.size === 0) {
    closeDetails();
    return;
  }
  state.selectedNodeId = next.has(nodeId) ? nodeId : Array.from(next).pop();
  renderTree();
  refreshDetailsForSelection();
}

// Synchronous counterpart to loadContentText(), for when the page's mcid
// lookups are already cached (e.g. it's the page currently showing in the
// preview, or a content leaf on it was rendered before). Lets
// renderTreeNode() give a leaf its final text/height on the very same
// render instead of always starting blank and growing a tick later - that
// late growth, multiplied across every content leaf on a page, was what
// made arrow-key navigation through an expanded tag feel erratic (each
// keypress re-renders the whole tree - see renderTree() - so every leaf's
// text was being torn down and re-fetched on every step; by the time it
// came back the already-scrolled-to selection had been shoved off screen
// by rows above it changing height). Returns null when the page hasn't
// been looked up yet, so the caller falls back to the async path.
function formatCachedLeafText(page0, mcid) {
  const pageNumber = page0 + 1;
  const textMap = state.mcidTextCache.get(pageNumber);
  if (!textMap) return null;
  const text = textMap.get(mcid);
  if (text) return { text: `“${text}”`, title: text };
  const graphics = state.mcidGraphicsCache.get(pageNumber);
  if (!graphics) return null;
  if (graphics.imageRects.has(mcid)) return { text: '[Image]', title: '' };
  if (graphics.vectorMcids.has(mcid)) return { text: '[Graphic]', title: '' };
  return { text: '', title: '' };
}

// Sets a leaf's text/title and, since that can change its row's height,
// re-anchors the current selection - a leaf higher up the tree resolving
// its text after the selection was already scrolled into view would
// otherwise be able to push the selection off screen with no way to bring
// it back short of navigating again.
function applyLeafText(targetEl, { text, title }) {
  targetEl.textContent = text;
  targetEl.title = title;
  const selectedRow = state.selectedNodeId
    ? el.tagTree.querySelector(`[data-node-id="${state.selectedNodeId}"]`)
    : null;
  selectedRow?.scrollIntoView({ block: 'nearest' });
}

// Fills in a content leaf's text preview once pdf.js has parsed its page.
// Async and fired off from renderTreeNode(), which is otherwise synchronous
// - guards against the tree having been replaced/re-rendered by the time
// the lookup resolves by checking the target span is still in the DOM.
async function loadContentText(page0, mcid, targetEl) {
  if (!state.pdfDoc) return; // preview hasn't loaded yet; re-triggered by loadPdfPreview()
  const pageNumber = page0 + 1;
  if (pageNumber < 1 || pageNumber > state.pageCount) return;
  try {
    const map = await getPageMcidTextMap(pageNumber);
    if (!targetEl.isConnected) return;
    const text = map.get(mcid);
    if (text) {
      applyLeafText(targetEl, { text: `“${text}”`, title: text });
      return;
    }
    // No text run carries this mcid - the usual reason is that its content
    // is an image `Do` call or a stroked/filled vector path instead
    // (getTextContent() never reports those; see getPageMcidGraphicsInfo()).
    // Fall back to a bracketed type label so the leaf isn't left blank, the
    // same way an /OBJR leaf's objType is shown.
    const { imageRects, vectorMcids } = await getPageMcidGraphicsInfo(pageNumber);
    if (!targetEl.isConnected) return;
    if (imageRects.has(mcid)) {
      applyLeafText(targetEl, { text: '[Image]', title: '' });
    } else if (vectorMcids.has(mcid)) {
      applyLeafText(targetEl, { text: '[Graphic]', title: '' });
    } else {
      applyLeafText(targetEl, { text: '', title: '' });
    }
  } catch (err) {
    console.error('Could not load content text for mcid', mcid, err);
  }
}
