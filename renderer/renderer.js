// renderer.js
//
// Vanilla JS, no framework, no bundler. Loaded as an ES module directly by
// index.html. Talks to the main process only through `window.api`, which
// preload.js attaches - there is no Node/fs access here.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

// --- app state ---------------------------------------------------------

const state = {
  docId: null,
  fileName: null,
  savedFilePath: null,  // path last used to save this doc (Save As sets it; Save reuses it), reset per document
  tree: null,           // current full tag tree, as returned by the worker
  nodesById: new Map(), // id -> node, rebuilt every time `tree` is replaced
  mcidIndex: new Map(), // page (0-based) -> Map(mcid -> owning element node id), rebuilt with nodesById
  selectedNodeId: null,      // the "active"/most-recently-clicked tag - drives the details panel, highlight, scroll
  selectedNodeIds: new Set(), // full multi-selection (shift/ctrl+click); always a superset containing selectedNodeId
  selectionAnchorId: null,   // fixed point shift+click range-selects from; updated by plain/ctrl clicks, not by shift+click
  draggedNodeId: null,
  draggedNodeIds: null,
  pdfDoc: null,          // pdf.js document proxy
  currentPage: 1,
  pageCount: 0,
  textContentCache: new Map(), // page number -> { textContent, viewport }, reset per document
  mcidTextCache: new Map(),    // page number -> Map(mcid -> text), reset per document
  highlightToken: 0,           // invalidates in-flight highlight computations when selection/doc changes
  collapseOverrides: new Map(), // nodeId -> boolean, explicit user toggles (absence = use the role-based default)
  filter: 'all',                // 'all' | 'headings' | 'figures' - see renderFilteredTree()
};

// Must match the scale used for page.getViewport() in renderCurrentPage() -
// the highlight overlay is computed in that same viewport's pixel space.
const PAGE_SCALE = 1.4;

// --- DOM refs -----------------------------------------------------------

const el = {
  btnOpen: document.getElementById('btn-open'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnKillDivs: document.getElementById('btn-kill-divs'),
  tagFilter: document.getElementById('tag-filter'),
  fileName: document.getElementById('file-name'),
  statusMessage: document.getElementById('status-message'),
  statusBar: document.getElementById('status-bar'),
  noStructBanner: document.getElementById('no-struct-banner'),
  canvas: document.getElementById('pdf-canvas'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  pageIndicator: document.getElementById('page-indicator'),
  tagTree: document.getElementById('tag-tree'),
  highlightLayer: document.getElementById('highlight-layer'),
  detailsEmpty: document.getElementById('details-empty'),
  detailsForm: document.getElementById('details-form'),
  fieldNodeId: document.getElementById('field-node-id'),
  fieldRole: document.getElementById('field-role'),
  fieldAlt: document.getElementById('field-alt'),
  fieldActualText: document.getElementById('field-actual-text'),
  fieldLang: document.getElementById('field-lang'),
  btnCancelEdit: document.getElementById('btn-cancel-edit'),
  btnPullContent: document.getElementById('btn-pull-content'),
};

function setStatus(message) {
  el.statusMessage.textContent = message;
  el.statusBar.textContent = message;
}

function reportError(context, err) {
  console.error(context, err);
  setStatus(`${context}: ${err.message || err}`);
}

function applyUndoState(result) {
  el.btnUndo.disabled = !result.canUndo;
  el.btnRedo.disabled = !result.canRedo;
}

// --- role -> visual category (drives tag-chip color) ---------------------

const ROLE_CATEGORY = {};
for (const r of ['H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Title']) ROLE_CATEGORY[r] = 'heading';
for (const r of ['Document', 'Part', 'Art', 'Sect', 'Div', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private']) ROLE_CATEGORY[r] = 'container';
for (const r of ['L', 'LI', 'Lbl', 'LBody']) ROLE_CATEGORY[r] = 'list';
for (const r of ['Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot']) ROLE_CATEGORY[r] = 'table';
for (const r of ['Figure', 'Formula']) ROLE_CATEGORY[r] = 'figure';

function categoryForRole(role) {
  if (!role) return 'leaf';
  return ROLE_CATEGORY[role] || 'inline';
}

// --- tag tree: build the nodesById index -------------------------------

function indexTree(tree) {
  const map = new Map();
  (function visit(node, parentId) {
    map.set(node.id, { node, parentId });
    for (const child of node.children || []) visit(child, node.id);
  })(tree, null);
  return map;
}

function buildMcidIndex(tree) {
  const index = new Map();
  (function visit(node, parentElementId) {
    if (node.type === 'content' && node.mcid !== null && node.mcid !== undefined
        && node.page !== null && node.page !== undefined && parentElementId) {
      if (!index.has(node.page)) index.set(node.page, new Map());
      index.get(node.page).set(node.mcid, parentElementId);
    }
    const nextParent = node.type === 'element' ? node.id : parentElementId;
    for (const child of node.children || []) visit(child, nextParent);
  })(tree, null);
  return index;
}

function isDescendant(candidateAncestorId, nodeId) {
  // true if `nodeId` is candidateAncestorId itself, or lies anywhere under it
  const entry = state.nodesById.get(nodeId);
  if (!entry) return false;
  if (nodeId === candidateAncestorId) return true;
  if (entry.parentId === null) return false;
  return isDescendant(candidateAncestorId, entry.parentId);
}

// --- tag tree: rendering --------------------------------------------------

function renderTree() {
  el.tagTree.innerHTML = '';
  if (!state.tree) {
    const p = document.createElement('p');
    p.className = 'tree-placeholder';
    p.textContent = 'No document loaded.';
    el.tagTree.appendChild(p);
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
  el.tagTree.appendChild(ul);
}

// --- tag tree: filtering ---------------------------------------------------
//
// "Headings"/"Figures" swap the nested tree for a flat, document-order list
// of just the matching tags (any heading level counts as a match, ignoring
// how deep they're nested) - handy for skimming an outline or auditing alt
// text without wading through containers. Since it's a flat list, drag
// reordering doesn't apply here: filtered rows are plain, non-draggable, and
// get no drop handlers, which is what disables moving tags while filtered.
// Up/down arrow navigation keeps working unchanged, since it just walks
// whatever `.tree-row.selectable` rows are currently in the DOM.

function nodeMatchesFilter(node) {
  if (state.filter === 'all') return true;
  if (node.type !== 'element') return false;
  if (state.filter === 'headings') return categoryForRole(node.role) === 'heading';
  if (state.filter === 'figures') return node.role === 'Figure';
  return true;
}

function collectFilteredNodes(node, matches) {
  if (nodeMatchesFilter(node)) matches.push(node);
  for (const child of node.children || []) collectFilteredNodes(child, matches);
}

function renderFilteredTree() {
  const matches = [];
  collectFilteredNodes(state.tree, matches);

  if (matches.length === 0) {
    const p = document.createElement('p');
    p.className = 'tree-placeholder';
    p.textContent = 'No matching tags.';
    el.tagTree.appendChild(p);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const node of matches) {
    ul.appendChild(renderFilteredRow(node));
  }
  el.tagTree.appendChild(ul);
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

function isNodeCollapsed(node) {
  if (state.collapseOverrides.has(node.id)) return state.collapseOverrides.get(node.id);
  return isCollapsedByDefault(node);
}

function toggleNodeCollapsed(node) {
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
    attachDropHandlers(row, node.id);
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
    // 'content' (bare MCID / MCR) or 'object-ref' (OBJR) - read-only leaves
    row.className = 'tree-row';
    const hasTextPreview = node.type === 'content' && node.mcid !== null && node.mcid !== undefined
      && node.page !== null && node.page !== undefined;
    if (!hasTextPreview) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.dataset.category = 'leaf';
      chip.textContent = node.type === 'object-ref' ? 'objref' : 'content';
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
      loadContentText(node.page, node.mcid, textSpan);
    }
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

function attachDropHandlers(row, targetNodeId) {
  row.addEventListener('dragover', (e) => {
    if (!state.draggedNodeId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const draggedIds = state.draggedNodeIds ? Array.from(state.draggedNodeIds) : [];
    state.draggedNodeId = null;
    state.draggedNodeIds = null;
    if (draggedIds.length === 0) return;

    // v1 drop semantics: dropping onto a node appends the dragged tag(s) as
    // its new last child/children. Precise above/below sibling positioning
    // would need a drop-position indicator; left as a follow-up.
    const targetEntry = state.nodesById.get(targetNodeId);
    const newIndex = targetEntry.node.children ? targetEntry.node.children.length : 0;

    if (draggedIds.length === 1) {
      const draggedId = draggedIds[0];
      if (draggedId === targetNodeId) return;
      if (isDescendant(draggedId, targetNodeId)) {
        setStatus("Can't move a tag into its own descendant.");
        return;
      }
      try {
        const result = await window.api.reorderNode(state.docId, draggedId, targetNodeId, newIndex);
        applyFreshTree(result.tree);
        applyUndoState(result);
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
    const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
    const orderedIds = rows.map((r) => r.dataset.nodeId).filter((id) => draggedIds.includes(id));
    const topLevelIds = orderedIds.filter((id) => !orderedIds.some((other) => other !== id && isDescendant(other, id)));

    if (topLevelIds.some((id) => isDescendant(id, targetNodeId))) {
      setStatus("Can't move tags into their own selection or descendants.");
      return;
    }

    try {
      const result = await window.api.reorderMany(state.docId, topLevelIds, targetNodeId, newIndex);
      applyFreshTree(result.tree);
      applyUndoState(result);
      setStatus(`Moved ${topLevelIds.length} tags.`);
    } catch (err) {
      reportError('Could not move tags', err);
    }
  });
}

function applyFreshTree(tree) {
  state.tree = tree;
  state.nodesById = indexTree(tree);
  state.mcidIndex = tree ? buildMcidIndex(tree) : new Map();

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

// --- details panel --------------------------------------------------------
//
// Multi-select (shift/ctrl+click - see handleRowClick) keeps a single
// "active" tag (state.selectedNodeId) alongside the full selection
// (state.selectedNodeIds, always a superset containing the active one). The
// active tag drives the details panel's displayed values, page highlight,
// and scroll; the full selection drives which rows get the 'multi-selected'
// look, which tags a block drag/move carries, and which tags a Role change
// applies to (see the details form's submit handler).

function expandAncestors(nodeId) {
  let entry = state.nodesById.get(nodeId);
  while (entry && entry.parentId !== null) {
    entry = state.nodesById.get(entry.parentId);
    if (entry && entry.node.type === 'element') state.collapseOverrides.set(entry.node.id, false);
  }
}

// Plain click (and keyboard nav / page-click selection): replaces any
// existing selection with just this one tag.
function selectNode(nodeId) {
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
function extendSelectionTo(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type !== 'element') return;

  if (!state.selectionAnchorId || !state.nodesById.has(state.selectionAnchorId)) {
    selectNode(nodeId);
    return;
  }

  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
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
  if (!entry || entry.node.type !== 'element') return;

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

function refreshDetailsForSelection() {
  const nodeId = state.selectedNodeId;
  const entry = nodeId ? state.nodesById.get(nodeId) : null;
  if (!entry || entry.node.type !== 'element') {
    closeDetails();
    return;
  }
  const node = entry.node;
  const multi = state.selectedNodeIds.size > 1;

  el.detailsEmpty.hidden = true;
  el.detailsForm.hidden = false;
  el.fieldNodeId.value = node.id;
  el.fieldRole.value = node.role || '';
  el.fieldAlt.value = node.alt || '';
  el.fieldActualText.value = node.actualText || '';
  el.fieldLang.value = node.lang || '';

  // With multiple tags selected, only Role applies as a block edit (see the
  // submit handler) - disable the other fields rather than let an edit look
  // like it covers the whole selection when it would only touch this one.
  el.fieldAlt.disabled = multi;
  el.fieldActualText.disabled = multi;
  el.fieldLang.disabled = multi;
  el.btnPullContent.disabled = multi;

  const row = el.tagTree.querySelector(`[data-node-id="${nodeId}"]`);
  row?.scrollIntoView({ block: 'nearest' });

  highlightNodeOnPage(nodeId, { allowPageJump: true });
}

function closeDetails() {
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectionAnchorId = null;
  el.detailsForm.hidden = true;
  el.detailsEmpty.hidden = false;
  el.detailsForm.reset();
  el.fieldAlt.disabled = false;
  el.fieldActualText.disabled = false;
  el.fieldLang.disabled = false;
  el.btnPullContent.disabled = false;
  state.highlightToken += 1; // invalidate any highlight computation still in flight
  clearHighlight();
}

// --- tag -> content highlight -------------------------------------------
//
// Selecting a tag highlights the marked content it wraps on the page
// preview. We get exact positions from pdf.js's own text layout (font
// metrics, CID widths, etc. already resolved) via
// `getTextContent({ includeMarkedContent: true })`, which interleaves
// ordinary text items with begin/end markers carrying the MCID of the
// marked-content span they bracket - we just track which MCIDs belong to
// the selected tag's subtree (see `collectTargetMcids`), collect the text
// items that fall inside a matching span, and draw a single box around
// their union rather than one box per run (which got noisy and overlapped
// for multi-line/multi-word content).
//
// Known limitation: this only covers *text* content. A Figure/Formula's
// marked content is normally an image `Do` call, which getTextContent()
// doesn't report, so those tags won't currently highlight anything.

function collectTargetMcids(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) return [];
  const targets = [];
  (function visit(node) {
    if (node.type === 'content' && node.mcid !== null && node.mcid !== undefined
        && node.page !== null && node.page !== undefined) {
      targets.push({ mcid: node.mcid, page: node.page }); // page is 0-based
    }
    for (const child of node.children || []) visit(child);
  })(entry.node);
  return targets;
}

async function getPageTextContent(pageNumber) {
  if (state.textContentCache.has(pageNumber)) return state.textContentCache.get(pageNumber);
  const page = await state.pdfDoc.getPage(pageNumber);
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const entry = { textContent, viewport };
  state.textContentCache.set(pageNumber, entry);
  return entry;
}

// Builds a page's mcid -> text lookup once (cached) rather than re-walking
// textContent.items per leaf node - a page's content leaves all share one
// walk instead of paying O(items) per node.
async function getPageMcidTextMap(pageNumber) {
  if (state.mcidTextCache.has(pageNumber)) return state.mcidTextCache.get(pageNumber);
  const { textContent } = await getPageTextContent(pageNumber);
  const map = new Map();
  const mcidStack = [];
  for (const item of textContent.items) {
    if (item.str === undefined) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        mcidStack.push(extractMcidFromItemId(item.id));
      } else if (item.type === 'endMarkedContent') {
        mcidStack.pop();
      }
      continue;
    }
    const currentMcid = mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : null;
    if (currentMcid === null || !item.str) continue;
    const existing = map.get(currentMcid) || '';
    map.set(currentMcid, existing + item.str + (item.hasEOL ? '\n' : ''));
  }
  for (const [mcid, text] of map) map.set(mcid, text.trim());
  state.mcidTextCache.set(pageNumber, map);
  return map;
}

// Collects a tag's own content text (its content-leaf descendants' text,
// per collectTargetMcids), joined with a single space between blocks - used
// by the "Pull Content" button to seed Actual Text.
async function pullContentText(nodeId) {
  const targets = collectTargetMcids(nodeId);
  const parts = [];
  for (const target of targets) {
    const pageNumber = target.page + 1;
    if (pageNumber < 1 || pageNumber > state.pageCount) continue;
    const map = await getPageMcidTextMap(pageNumber);
    const text = map.get(target.mcid);
    if (text) parts.push(text);
  }
  return parts.join(' ');
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
    targetEl.textContent = text ? `“${text}”` : '';
    targetEl.title = text || '';
  } catch (err) {
    console.error('Could not load content text for mcid', mcid, err);
  }
}

function extractMcidFromItemId(id) {
  // pdf.js formats this as "<pageObjId>_mc<mcid>" - the prefix is opaque
  // and irrelevant here since we already scope the lookup to one page.
  if (!id) return null;
  const match = /_mc(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

// Fraction of item.height treated as rising above the text baseline, the
// rest as descent below it. pdf.js's own text-layer builder leans on a
// similar per-font ascent ratio (it has real font-metric tables for it);
// this fixed ratio is an approximation, but is close enough for a highlight
// box and avoids depending on pdf.js's private font-metrics internals.
const TEXT_ASCENT_RATIO = 0.75;

// item.transform places a text run's local origin (its baseline) in PDF
// page space and gives its local x/y axis directions - but item.width/
// item.height are already absolute page-space lengths along those axes,
// not unit-square coordinates. Re-running them through the full transform
// (which still has font size baked into its a/d components) double-scales
// them - that was inflating every box by roughly the font size and pushing
// wide/large text off the page. Instead, build the run's quad directly in
// page space using the transform's *unit* axis directions, split around
// the baseline by TEXT_ASCENT_RATIO, then map that quad through the
// viewport transform.
function itemRectInViewport(item, viewport) {
  const [a, b, c, d, e, f] = item.transform;
  const xAxisLen = Math.hypot(a, b) || 1;
  const yAxisLen = Math.hypot(c, d) || 1;
  const ux = [a / xAxisLen, b / xAxisLen];
  const uy = [c / yAxisLen, d / yAxisLen];
  const ascent = item.height * TEXT_ASCENT_RATIO;
  const descent = item.height - ascent;

  const pageCorners = [
    [e - uy[0] * descent, f - uy[1] * descent],
    [e + ux[0] * item.width - uy[0] * descent, f + ux[1] * item.width - uy[1] * descent],
    [e + uy[0] * ascent, f + uy[1] * ascent],
    [e + ux[0] * item.width + uy[0] * ascent, f + ux[1] * item.width + uy[1] * ascent],
  ];
  const corners = pageCorners.map((p) => pdfjsLib.Util.applyTransform(p, viewport.transform));
  const xs = corners.map((c2) => c2[0]);
  const ys = corners.map((c2) => c2[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function computeHighlightRects(textContent, viewport, mcidSet) {
  const rects = [];
  const activeStack = []; // bool per open marked-content span: is it (or an ancestor) a target?

  for (const item of textContent.items) {
    if (item.str === undefined) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        const mcid = extractMcidFromItemId(item.id);
        const parentActive = activeStack.length > 0 && activeStack[activeStack.length - 1];
        activeStack.push(parentActive || (mcid !== null && mcidSet.has(mcid)));
      } else if (item.type === 'endMarkedContent') {
        activeStack.pop();
      }
      continue;
    }

    const isActive = activeStack.length > 0 && activeStack[activeStack.length - 1];
    if (!isActive || !item.str || !item.str.trim()) continue;
    rects.push(itemRectInViewport(item, viewport));
  }

  return rects;
}

// --- content -> tag selection (reverse of the above) ---------------------
//
// Clicking the PDF preview hit-tests the current page's text items against
// the click point, walking the same begin/end-marked-content markers to
// find which MCID (if any) the clicked run belongs to, then looks up the
// struct element that directly owns that MCID via `state.mcidIndex` and
// selects it. Same text-only limitation as the highlight feature.

async function findNodeAtPoint(x, y) {
  const pageMcids = state.mcidIndex.get(state.currentPage - 1); // node.page is 0-based
  if (!pageMcids || pageMcids.size === 0) return null;

  const { textContent, viewport } = await getPageTextContent(state.currentPage);
  const mcidStack = [];

  for (const item of textContent.items) {
    if (item.str === undefined) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        mcidStack.push(extractMcidFromItemId(item.id));
      } else if (item.type === 'endMarkedContent') {
        mcidStack.pop();
      }
      continue;
    }
    if (!item.str || !item.str.trim()) continue;

    const currentMcid = mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : null;
    if (currentMcid === null || !pageMcids.has(currentMcid)) continue;

    const box = itemRectInViewport(item, viewport);
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
      return pageMcids.get(currentMcid);
    }
  }

  return null;
}

el.canvas.addEventListener('click', async (e) => {
  if (!state.pdfDoc) return;
  const rect = el.canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (el.canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (el.canvas.height / rect.height);

  try {
    const nodeId = await findNodeAtPoint(x, y);
    if (nodeId) selectNode(nodeId);
  } catch (err) {
    console.error('Could not resolve tag at click point:', err);
  }
});

function unionRects(rects) {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function syncHighlightLayerBounds() {
  el.highlightLayer.style.left = `${el.canvas.offsetLeft}px`;
  el.highlightLayer.style.top = `${el.canvas.offsetTop}px`;
  el.highlightLayer.style.width = `${el.canvas.clientWidth}px`;
  el.highlightLayer.style.height = `${el.canvas.clientHeight}px`;
}

function renderHighlightRects(rects, viewport) {
  el.highlightLayer.innerHTML = '';
  for (const r of rects) {
    const box = document.createElement('div');
    box.className = 'highlight-box';
    // Percentages of the viewport's own pixel size so boxes stay aligned
    // even though the canvas is scaled down by CSS (max-width: 100%).
    box.style.left = `${(100 * r.x / viewport.width).toFixed(3)}%`;
    box.style.top = `${(100 * r.y / viewport.height).toFixed(3)}%`;
    box.style.width = `${(100 * r.width / viewport.width).toFixed(3)}%`;
    box.style.height = `${(100 * r.height / viewport.height).toFixed(3)}%`;
    el.highlightLayer.appendChild(box);
  }
}

function clearHighlight() {
  el.highlightLayer.innerHTML = '';
}

async function highlightNodeOnPage(nodeId, { allowPageJump }) {
  const token = ++state.highlightToken;
  if (!state.pdfDoc || !nodeId) {
    clearHighlight();
    return;
  }

  const targets = collectTargetMcids(nodeId);
  if (targets.length === 0) {
    clearHighlight();
    return;
  }

  const hasContentOnCurrentPage = targets.some((t) => t.page + 1 === state.currentPage);
  if (!hasContentOnCurrentPage && allowPageJump) {
    const candidatePages = targets.map((t) => t.page + 1).filter((p) => p >= 1 && p <= state.pageCount);
    if (candidatePages.length > 0) {
      state.currentPage = Math.min(...candidatePages);
      await renderCurrentPage();
      updatePageNavUI();
      if (token !== state.highlightToken) return; // superseded by a newer selection/page change
    }
  }

  const mcidSet = new Set(
    targets.filter((t) => t.page + 1 === state.currentPage).map((t) => t.mcid)
  );
  if (mcidSet.size === 0) {
    clearHighlight();
    return;
  }

  try {
    const { textContent, viewport } = await getPageTextContent(state.currentPage);
    if (token !== state.highlightToken) return;
    const box = unionRects(computeHighlightRects(textContent, viewport, mcidSet));
    syncHighlightLayerBounds();
    renderHighlightRects(box ? [box] : [], viewport);
  } catch (err) {
    console.error('Could not compute tag highlight:', err);
  }
}

window.addEventListener('resize', () => {
  if (state.pdfDoc) syncHighlightLayerBounds();
});

el.detailsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;

  const multi = state.selectedNodeIds.size > 1;

  try {
    let result;
    if (multi) {
      // With multiple tags selected, only Role applies as a block edit -
      // the other fields are disabled in the form for this reason (see
      // refreshDetailsForSelection()).
      const role = el.fieldRole.value.trim();
      if (!role) {
        setStatus('Enter a role to apply it to the selected tags.');
        return;
      }
      const selectedIds = Array.from(state.selectedNodeIds);
      result = await window.api.updateNodes(state.docId, selectedIds, { role });
      applyFreshTree(result.tree);
      applyUndoState(result);
      setStatus(`Updated role for ${selectedIds.length} tags.`);
      refreshDetailsForSelection();
    } else {
      const changes = {
        role: el.fieldRole.value.trim(),
        alt: el.fieldAlt.value.trim(),
        actualText: el.fieldActualText.value.trim(),
        lang: el.fieldLang.value.trim(),
      };
      result = await window.api.updateNode(state.docId, nodeId, changes);
      applyFreshTree(result.tree);
      applyUndoState(result);
      setStatus('Updated tag.');
      // Keep the same node selected/visible after the tree re-renders.
      selectNode(nodeId);
    }
  } catch (err) {
    reportError('Could not update tag', err);
  }
});

el.btnCancelEdit.addEventListener('click', () => closeDetails());

el.btnPullContent.addEventListener('click', async () => {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;
  if (!state.pdfDoc) {
    setStatus('Open a PDF preview before pulling content text.');
    return;
  }
  try {
    setStatus('Pulling content text…');
    const text = await pullContentText(nodeId);
    el.fieldActualText.value = text;
    setStatus(text ? 'Pulled content text into Actual Text.' : 'No content text found in this tag.');
  } catch (err) {
    reportError('Could not pull content text', err);
  }
});

// --- undo / redo -----------------------------------------------------------
//
// History lives entirely on the Python side (see tag_worker.py) as whole-
// document snapshots, not as an invertible list of edits. Node ids are
// freshly assigned on every tree rebuild, so a node id from before an undo
// has no reliable correspondence to "the same" element afterwards - rather
// than guess, we just clear the selection and let the user re-pick.

async function performUndo() {
  if (!state.docId || el.btnUndo.disabled) return;
  try {
    const result = await window.api.undo(state.docId);
    applyFreshTree(result.tree);
    applyUndoState(result);
    closeDetails();
    setStatus('Undid last change.');
  } catch (err) {
    reportError('Could not undo', err);
  }
}

async function performRedo() {
  if (!state.docId || el.btnRedo.disabled) return;
  try {
    const result = await window.api.redo(state.docId);
    applyFreshTree(result.tree);
    applyUndoState(result);
    closeDetails();
    setStatus('Redid change.');
  } catch (err) {
    reportError('Could not redo', err);
  }
}

el.btnUndo.addEventListener('click', () => performUndo());
el.btnRedo.addEventListener('click', () => performRedo());
window.api.onMenuUndo(() => performUndo());
window.api.onMenuRedo(() => performRedo());

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
  if (!isUndo && !isRedo) return;

  // Let native undo/redo happen inside a focused text field instead of
  // hijacking it to revert the whole tag tree out from under the user.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  e.preventDefault();
  if (isUndo) performUndo();
  else performRedo();
});

// Up/Down arrows step the current selection through the tree in visible
// order - i.e. the same order rows appear in the DOM, since a collapsed
// element's children simply aren't rendered (see renderTreeNode).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+Up/Down reorders instead - see below
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
  const currentIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectedNodeId);
  if (currentIndex === -1) return;

  const nextIndex = e.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= rows.length) return;

  e.preventDefault();
  selectNode(rows[nextIndex].dataset.nodeId);
});

// Ctrl/Cmd+Up/Down moves the selected tag one place earlier/later among its
// siblings (a keyboard equivalent of dragging it past its neighbor). At the
// first/last child slot it instead outdents the tag to just before/after
// its own parent - see moveSelectedSibling(). Disabled while a
// Headings/Figures filter is active, same as drag-and-drop - the flat
// filtered list doesn't reflect sibling adjacency in the real tree.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!state.selectedNodeId || state.filter !== 'all') return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  moveSelectedSibling(e.key === 'ArrowUp' ? -1 : 1);
});

async function moveSelectedSibling(direction) {
  if (state.selectedNodeIds.size > 1) {
    await moveSelectedBlock(direction);
    return;
  }

  const nodeId = state.selectedNodeId;
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type !== 'element' || entry.parentId === null) return;
  const parentId = entry.parentId;
  const parentEntry = state.nodesById.get(parentId);
  if (!parentEntry) return;

  const siblings = parentEntry.node.children || [];
  const currentIndex = siblings.findIndex((child) => child.id === nodeId);
  if (currentIndex === -1) return;

  let newParentId = parentId;
  let newIndex = currentIndex + direction;

  if (newIndex < 0 || newIndex >= siblings.length) {
    // At the edge of its sibling list - outdent past the parent instead of
    // doing nothing: moving up out of the first child slot drops the tag
    // just before its (former) parent; moving down out of the last child
    // slot drops it just after. Only possible if the parent itself has a
    // parent to become a sibling under (i.e. it isn't the struct root).
    if (parentEntry.parentId === null) return;
    const grandParentId = parentEntry.parentId;
    const grandParentEntry = state.nodesById.get(grandParentId);
    if (!grandParentEntry) return;
    const parentSiblings = grandParentEntry.node.children || [];
    const parentIndex = parentSiblings.findIndex((child) => child.id === parentId);
    if (parentIndex === -1) return;
    newParentId = grandParentId;
    newIndex = direction < 0 ? parentIndex : parentIndex + 1;
  }

  try {
    const result = await window.api.reorderNode(state.docId, nodeId, newParentId, newIndex);
    applyFreshTree(result.tree);
    applyUndoState(result);
    // Node ids are reassigned by depth-first position on every rebuild (see
    // tag_worker.py), so the moved tag's id changes - but an ancestor's own
    // id doesn't (it's assigned before its children are visited, and this
    // move never changes an ancestor's position among *its* siblings), so
    // we can still find the tag by its known new (parent, index) and keep
    // it selected.
    const movedNode = state.nodesById.get(newParentId)?.node.children?.[newIndex];
    if (movedNode) selectNode(movedNode.id);
    setStatus('Moved tag.');
  } catch (err) {
    reportError('Could not move tag', err);
  }
}

// Ctrl/Cmd+Up/Down with multiple tags selected: steps the whole block one
// slot earlier/later, same as the single-tag case, but only when the
// selection is a single contiguous run of siblings under one parent - no
// outdent generalization for blocks, since "just before/after the parent"
// isn't well-defined once more than one tag is moving.
async function moveSelectedBlock(direction) {
  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
  const orderedIds = rows.map((r) => r.dataset.nodeId).filter((id) => state.selectedNodeIds.has(id));
  const topLevelIds = orderedIds.filter((id) => !orderedIds.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  const parentIds = new Set(topLevelIds.map((id) => state.nodesById.get(id)?.parentId));
  if (parentIds.size !== 1) {
    setStatus("Can't move: selected tags don't share a parent.");
    return;
  }
  const parentId = Array.from(parentIds)[0];
  const parentEntry = state.nodesById.get(parentId);
  if (!parentEntry) return;

  const siblings = parentEntry.node.children || [];
  const siblingIds = siblings.map((s) => s.id);
  const blockIndices = topLevelIds.map((id) => siblingIds.indexOf(id)).sort((a, b) => a - b);
  if (blockIndices.some((i) => i === -1)) return;
  for (let i = 1; i < blockIndices.length; i++) {
    if (blockIndices[i] !== blockIndices[i - 1] + 1) {
      setStatus("Can't move: selected tags aren't contiguous.");
      return;
    }
  }

  const firstIndex = blockIndices[0];
  const newFirstIndex = firstIndex + direction;
  if (newFirstIndex < 0 || newFirstIndex + blockIndices.length > siblings.length) return;
  const orderedBlockIds = blockIndices.map((i) => siblingIds[i]);

  try {
    const result = await window.api.reorderMany(state.docId, orderedBlockIds, parentId, newFirstIndex);
    applyFreshTree(result.tree);
    applyUndoState(result);
    const newSiblings = state.nodesById.get(parentId)?.node.children || [];
    const movedIds = newSiblings.slice(newFirstIndex, newFirstIndex + orderedBlockIds.length).map((c) => c.id);
    if (movedIds.length > 0) {
      state.selectedNodeIds = new Set(movedIds);
      state.selectedNodeId = movedIds[movedIds.length - 1];
      state.selectionAnchorId = movedIds[0];
      renderTree();
      refreshDetailsForSelection();
    }
    setStatus('Moved tags.');
  } catch (err) {
    reportError('Could not move tags', err);
  }
}

// Left/Right arrows collapse/expand the current selection, when it's an
// element with children to hide. While filtered to Headings, there's
// nothing to collapse/expand (it's a flat list), so plain Left/Right steps
// the heading level directly instead of requiring Ctrl/Cmd - see
// attemptHeadingLevelChange().
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey) return; // handled by the Ctrl/Cmd+Left/Right listener below
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (state.filter === 'headings') {
    if (attemptHeadingLevelChange(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
    return;
  }

  const entry = state.nodesById.get(state.selectedNodeId);
  if (!entry || entry.node.type !== 'element') return;
  const node = entry.node;
  if (!node.children || node.children.length === 0) return;

  const collapsed = isNodeCollapsed(node);
  if (e.key === 'ArrowRight' && collapsed) {
    e.preventDefault();
    toggleNodeCollapsed(node);
  } else if (e.key === 'ArrowLeft' && !collapsed) {
    e.preventDefault();
    toggleNodeCollapsed(node);
  }
});

// Ctrl/Cmd+Right/Left steps a heading tag (H1-H6) down/up a level. No-op on
// anything else, including the bare "H" role, which has no numbered level.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (attemptHeadingLevelChange(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
});

// Changes the selected node's heading level by `direction` (+1/-1) if it's
// currently H1-H6, clamped to that range. Returns true if the tag is a
// heading at all (regardless of whether it was already at the clamp), so
// callers know to treat the key as handled either way. Only acts on a
// single selected tag - unlike Role, heading level isn't specified as a
// block operation, so applying it to just the active tag out of several
// selected would be a silent partial edit.
function attemptHeadingLevelChange(direction) {
  if (state.selectedNodeIds.size > 1) return false;
  const entry = state.nodesById.get(state.selectedNodeId);
  if (!entry || entry.node.type !== 'element') return false;
  const match = /^H([1-6])$/.exec(entry.node.role || '');
  if (!match) return false;

  const level = Number(match[1]);
  const newLevel = level + direction;
  if (newLevel >= 1 && newLevel <= 6) changeHeadingLevel(state.selectedNodeId, newLevel);
  return true;
}

async function changeHeadingLevel(nodeId, newLevel) {
  try {
    const result = await window.api.updateNode(state.docId, nodeId, { role: `H${newLevel}` });
    applyFreshTree(result.tree);
    applyUndoState(result);
    // A role-only change doesn't touch the tree's structure, so the
    // depth-first id assignment (see tag_worker.py) reproduces the same id.
    selectNode(nodeId);
    setStatus(`Changed to H${newLevel}.`);
  } catch (err) {
    reportError('Could not change heading level', err);
  }
}

// --- PDF.js viewer -------------------------------------------------------

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadPdfPreview(base64Data) {
  const bytes = base64ToUint8Array(base64Data);
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdfDoc = await loadingTask.promise;
  state.pageCount = state.pdfDoc.numPages;
  state.currentPage = 1;
  state.textContentCache.clear();
  state.mcidTextCache.clear();
  el.viewerPlaceholder.hidden = true;
  await renderCurrentPage();
  updatePageNavUI();
  // The tag tree was already rendered (from applyFreshTree(), before this
  // resolved) with no pdfDoc yet, so content leaves' loadContentText() calls
  // bailed out immediately - re-render now that pdf.js can actually resolve
  // marked-content text.
  renderTree();
}

async function renderCurrentPage() {
  if (!state.pdfDoc) return;
  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const context = el.canvas.getContext('2d');
  el.canvas.width = viewport.width;
  el.canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;
}

function updatePageNavUI() {
  el.pageIndicator.textContent = state.pdfDoc ? `${state.currentPage} / ${state.pageCount}` : '\u2014';
  el.btnPrevPage.disabled = !state.pdfDoc || state.currentPage <= 1;
  el.btnNextPage.disabled = !state.pdfDoc || state.currentPage >= state.pageCount;
}

el.btnPrevPage.addEventListener('click', async () => {
  if (state.currentPage <= 1) return;
  state.currentPage -= 1;
  await renderCurrentPage();
  updatePageNavUI();
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

el.btnNextPage.addEventListener('click', async () => {
  if (state.currentPage >= state.pageCount) return;
  state.currentPage += 1;
  await renderCurrentPage();
  updatePageNavUI();
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

// --- open / save ----------------------------------------------------------

async function performOpen() {
  try {
    setStatus('Opening\u2026');
    const opened = await window.api.openPdf();
    if (!opened) {
      setStatus('Ready.');
      return;
    }

    state.docId = opened.docId;
    state.fileName = opened.filePath.split(/[\\/]/).pop();
    state.savedFilePath = opened.filePath; // Save overwrites the file it was opened from until Save As picks a new one
    el.fileName.textContent = state.fileName;
    el.btnKillDivs.disabled = !opened.hasStructTree;

    el.noStructBanner.hidden = !!opened.hasStructTree;
    applyFreshTree(opened.tree || null);
    applyUndoState(opened);
    closeDetails();

    await loadPdfPreview(opened.pdfBase64);
    setStatus(opened.hasStructTree ? 'Loaded.' : 'Loaded (untagged PDF).');
  } catch (err) {
    reportError('Could not open PDF', err);
  }
}

el.btnOpen.addEventListener('click', () => performOpen());
window.api.onMenuOpen(() => performOpen());

// Save overwrites the current file (the path it was opened from, or
// wherever Save As last pointed it). Falls back to the Save As dialog in
// the (normally unreachable) case there's no known path yet.
async function performSave() {
  if (!state.docId) return;
  if (!state.savedFilePath) {
    await performSaveAs();
    return;
  }
  try {
    setStatus('Saving\u2026');
    await window.api.saveToPath(state.docId, state.savedFilePath);
    setStatus(`Saved to ${state.savedFilePath}`);
  } catch (err) {
    reportError('Could not save PDF', err);
  }
}

async function performSaveAs() {
  if (!state.docId) return;
  try {
    setStatus('Saving\u2026');
    const suggested = state.fileName ? state.fileName : '.pdf';
    const savedPath = await window.api.savePdf(state.docId, suggested);
    if (savedPath) {
      state.savedFilePath = savedPath;
      state.fileName = savedPath.split(/[\\/]/).pop();
      el.fileName.textContent = state.fileName;
    }
    setStatus(savedPath ? `Saved to ${savedPath}` : 'Ready.');
  } catch (err) {
    reportError('Could not save PDF', err);
  }
}

window.api.onMenuSave(() => performSave());
window.api.onMenuSaveAs(() => performSaveAs());

el.btnKillDivs.addEventListener('click', async () => {
  if (!state.docId) return;
  try {
    setStatus('Removing Div tags…');
    const result = await window.api.killDivs(state.docId);
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus(result.removed > 0 ? `Removed ${result.removed} Div tag${result.removed === 1 ? '' : 's'}.` : 'No Div tags found.');
  } catch (err) {
    reportError('Could not remove Div tags', err);
  }
});

el.tagFilter.addEventListener('change', () => {
  state.filter = el.tagFilter.value;
  renderTree();
});

setStatus('Ready.');
