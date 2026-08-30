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

// Referenced by loadWalkSpeed() below, which runs immediately as part of
// `state`'s own initialization - must be declared (not just hoisted, which
// wouldn't be enough for `const`) before that point.
const WALK_SPEED_STORAGE_KEY = 'pdfTagEditor.walkTagsPerSecond';
const WALK_SPEED_DEFAULT = 1;
const WALK_SPEED_MIN = 0.5;
const WALK_SPEED_MAX = 10;
const WALK_SPEED_STEP = 0.5;

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
  activePanel: 'properties', // 'properties' | 'bookmarks' - which details-pane tab is showing
  outline: null,             // current bookmark tree, as returned by the worker (null before a doc is opened)
  bookmarksById: new Map(),  // id -> { node, parentId }, rebuilt every time `outline` is replaced - mirrors nodesById
  selectedBookmarkId: null,
  draggedNodeId: null,
  draggedNodeIds: null,
  pdfDoc: null,          // pdf.js document proxy
  currentPage: 1,
  pageCount: 0,
  textContentCache: new Map(), // page number -> { textContent, viewport }, reset per document
  mcidTextCache: new Map(),    // page number -> Map(mcid -> text), reset per document
  mcidGraphicsCache: new Map(), // page number -> { imageRects, vectorMcids }, reset per document
  highlightToken: 0,           // invalidates in-flight highlight computations when selection/doc changes
  tablePreviewToken: 0,        // invalidates in-flight table-preview builds when selection/doc changes
  tablePreviewTableEl: null,   // most recently built <table> (see renderTablePreview()), reused by the Expand dialog
  actualTextPlaceholderToken: 0, // invalidates in-flight Actual Text placeholder pulls when selection/doc changes
  collapseOverrides: new Map(), // nodeId -> boolean, explicit user toggles (absence = use the role-based default)
  filter: 'all',                // 'all' | 'headings' | 'figures' | 'table' - see renderFilteredTree()
  walking: false,               // true while the Walk button's auto-advance is running
  walkTimerId: null,
  walkSpeed: loadWalkSpeed(),   // tags per second; persisted across sessions, see loadWalkSpeed()/saveWalkSpeed()
  figureDrawActive: false,      // true while the Add Figure button's rubber-band draw mode is armed
  figureDrawRect: null,         // { start: {x,y}, current: {x,y} } in canvas-pixel space, while dragging
  docInfo: { title: null, author: null }, // PDF document-info Title/Author, shown when the /Document tag is selected
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
  btnScopeTables: document.getElementById('btn-scope-tables'),
  btnSmartifact: document.getElementById('btn-smartifact'),
  btnAddFigure: document.getElementById('btn-add-figure'),
  btnWalk: document.getElementById('btn-walk'),
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
  drawOverlay: document.getElementById('draw-overlay'),
  detailsEmpty: document.getElementById('details-empty'),
  detailsForm: document.getElementById('details-form'),
  fieldNodeId: document.getElementById('field-node-id'),
  fieldRole: document.getElementById('field-role'),
  fieldAlt: document.getElementById('field-alt'),
  fieldAltWrap: document.getElementById('field-alt-wrap'),
  fieldActualText: document.getElementById('field-actual-text'),
  fieldActualTextWrap: document.getElementById('field-actual-text-wrap'),
  fieldDocInfoSection: document.getElementById('field-docinfo-section'),
  fieldDocTitle: document.getElementById('field-doc-title'),
  fieldDocAuthor: document.getElementById('field-doc-author'),
  tablePreviewWrap: document.getElementById('field-table-preview'),
  tablePreviewContainer: document.getElementById('table-preview-container'),
  btnExpandTablePreview: document.getElementById('btn-expand-table-preview'),
  tablePreviewDialog: document.getElementById('table-preview-dialog'),
  tablePreviewDialogContainer: document.getElementById('table-preview-dialog-container'),
  btnCloseTablePreview: document.getElementById('btn-close-table-preview'),
  fieldLang: document.getElementById('field-lang'),
  thSection: document.getElementById('field-th-section'),
  fieldScopeWrap: document.getElementById('field-scope-wrap'),
  fieldScope: document.getElementById('field-scope'),
  fieldColSpan: document.getElementById('field-col-span'),
  fieldRowSpan: document.getElementById('field-row-span'),
  btnPullContent: document.getElementById('btn-pull-content'),
  shortcutsDialog: document.getElementById('shortcuts-dialog'),
  btnCloseShortcuts: document.getElementById('btn-close-shortcuts'),
  tabProperties: document.getElementById('tab-properties'),
  tabBookmarks: document.getElementById('tab-bookmarks'),
  panelProperties: document.getElementById('panel-properties'),
  panelBookmarks: document.getElementById('panel-bookmarks'),
  btnGenerateBookmarks: document.getElementById('btn-generate-bookmarks'),
  bookmarksEmpty: document.getElementById('bookmarks-empty'),
  bookmarkTree: document.getElementById('bookmark-tree'),
};

// The Actual Text field's placeholder as authored in index.html - restored
// whenever the selection doesn't warrant swapping in pulled content text
// (see updateActualTextPlaceholder()).
const DEFAULT_ACTUAL_TEXT_PLACEHOLDER = el.fieldActualText.placeholder;

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
// "Headings" swaps the nested tree for a flat, document-order list of just
// the matching tags (any heading level counts as a match, ignoring how deep
// they're nested) - handy for skimming an outline without wading through
// containers. Since it's a flat list, drag reordering doesn't apply here:
// filtered rows are plain, non-draggable, and get no drop handlers, which is
// what disables moving tags while filtered.
// "Figures" and "Table" instead keep each matching node's real subtree
// intact - only the path down to each match is flattened/skipped, not its
// contents - so alt text, captions, rows/cells, and other nested structure
// stay browsable with normal collapse/expand (rendered via renderTreeNode,
// same as the unfiltered tree). A match nested inside another match of the
// same filter isn't listed again at the top level; it just shows up as part
// of its parent's subtree.
// Up/down arrow navigation keeps working unchanged, since it just walks
// whatever `.tree-row.selectable` rows are currently in the DOM.

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
    el.tagTree.appendChild(p);
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
      loadContentText(node.page, node.mcid, textSpan);
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
      try {
        const result = await window.api.reorderNode(state.docId, draggedId, newParentId, newIndex);
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

    if (topLevelIds.some((id) => isDescendant(id, newParentId))) {
      setStatus("Can't move tags into their own selection or descendants.");
      return;
    }
    if (siblingId && topLevelIds.includes(siblingId)) return;

    const newIndex = computeDropIndex(newParentId, siblingId, zone, new Set(topLevelIds));
    try {
      const result = await window.api.reorderMany(state.docId, topLevelIds, newParentId, newIndex);
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

// --- details pane tabs ------------------------------------------------

function setActivePanel(panel) {
  state.activePanel = panel;
  el.tabProperties.classList.toggle('active', panel === 'properties');
  el.tabProperties.setAttribute('aria-selected', String(panel === 'properties'));
  el.tabBookmarks.classList.toggle('active', panel === 'bookmarks');
  el.tabBookmarks.setAttribute('aria-selected', String(panel === 'bookmarks'));
  el.panelProperties.hidden = panel !== 'properties';
  el.panelBookmarks.hidden = panel !== 'bookmarks';
}

el.tabProperties.addEventListener('click', () => setActivePanel('properties'));
el.tabBookmarks.addEventListener('click', () => setActivePanel('bookmarks'));

// --- bookmarks panel --------------------------------------------------
//
// A separate tree from the tag tree (PDF bookmarks/outlines live in their
// own /Outlines object graph, not /StructTreeRoot - see tag_worker.py), but
// rendered the same visual way: nested rows reusing .tree-row/.tree-children
// so a bookmark's children read exactly like a tag's do. Ids ("bN") are, like
// tag node ids, a fresh depth-first counter assigned on every worker
// response - never assumed stable across a mutation.

function indexOutline(outline) {
  const map = new Map();
  (function visit(nodes, parentId) {
    for (const node of nodes) {
      map.set(node.id, { node, parentId });
      visit(node.children || [], node.id);
    }
  })(outline || [], null);
  return map;
}

function applyFreshOutline(outline) {
  state.outline = outline || [];
  state.bookmarksById = indexOutline(state.outline);
  if (state.selectedBookmarkId && !state.bookmarksById.has(state.selectedBookmarkId)) {
    state.selectedBookmarkId = null;
  }
  renderBookmarkTree();
}

function renderBookmarkTree() {
  el.bookmarkTree.innerHTML = '';
  const hasBookmarks = state.outline && state.outline.length > 0;
  el.bookmarksEmpty.hidden = hasBookmarks;
  el.bookmarkTree.hidden = !hasBookmarks;
  if (!hasBookmarks) return;

  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const node of state.outline) ul.appendChild(renderBookmarkNode(node));
  el.bookmarkTree.appendChild(ul);
}

function renderBookmarkNode(node) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row selectable';
  row.dataset.bookmarkId = node.id;
  if (node.id === state.selectedBookmarkId) row.classList.add('selected');

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle-spacer';
  row.appendChild(spacer);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'bookmark-title';
  titleSpan.textContent = node.title || '(untitled)';
  row.appendChild(titleSpan);

  if (node.page !== null && node.page !== undefined) {
    const pageSpan = document.createElement('span');
    pageSpan.className = 'tree-node-meta';
    pageSpan.textContent = `p. ${node.page + 1}`;
    row.appendChild(pageSpan);
  }

  row.addEventListener('click', () => selectBookmark(node.id));
  row.addEventListener('dblclick', () => startRenamingBookmark(node.id));

  li.appendChild(row);

  if (node.children && node.children.length > 0) {
    const childUl = document.createElement('ul');
    childUl.className = 'tree-children';
    for (const child of node.children) childUl.appendChild(renderBookmarkNode(child));
    li.appendChild(childUl);
  }

  return li;
}

function selectBookmark(bookmarkId) {
  state.selectedBookmarkId = bookmarkId;
  renderBookmarkTree();
  const node = state.bookmarksById.get(bookmarkId)?.node;
  if (node && node.page !== null && node.page !== undefined) {
    jumpToPage(node.page + 1, node.top);
  }
}

// `top`, when given, is a page-space y-coordinate (see computeHeadingTop())
// to scroll to within the target page - used by bookmarks that carry a
// specific position rather than just a page. Applied even when the page
// itself doesn't change (e.g. two bookmarks on the same page), unlike the
// page-render/highlight-resync above it, which only a real page change
// needs.
async function jumpToPage(pageNumber, top) {
  if (!state.pdfDoc) return;
  if (pageNumber < 1 || pageNumber > state.pageCount) return;
  if (pageNumber !== state.currentPage) {
    state.currentPage = pageNumber;
    await renderCurrentPage();
    updatePageNavUI();
    await highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
  }
  await scrollToHeadingTop(top);
}

// Swaps a bookmark row's title for a text input on double-click, committing
// on Enter/blur (skipped if unchanged or emptied) and discarding on Escape -
// there's no dedicated rename dialog elsewhere in the app, so this mirrors
// the lightest-touch inline-edit pattern that fits a tree row.
function startRenamingBookmark(bookmarkId) {
  const entry = state.bookmarksById.get(bookmarkId);
  if (!entry) return;
  const row = el.bookmarkTree.querySelector(`[data-bookmark-id="${bookmarkId}"]`);
  const titleSpan = row?.querySelector('.bookmark-title');
  if (!row || !titleSpan) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bookmark-title-input';
  input.value = entry.node.title || '';
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;

  const commit = async () => {
    if (settled) return;
    settled = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === entry.node.title) {
      renderBookmarkTree();
      return;
    }
    try {
      const result = await window.api.renameBookmark(state.docId, bookmarkId, newTitle);
      state.selectedBookmarkId = bookmarkId;
      applyFreshOutline(result.outline);
      applyUndoState(result);
      setStatus('Renamed bookmark.');
    } catch (err) {
      reportError('Could not rename bookmark', err);
      renderBookmarkTree();
    }
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    renderBookmarkTree();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

async function deleteSelectedBookmark() {
  const bookmarkId = state.selectedBookmarkId;
  if (!bookmarkId) return;
  try {
    const result = await window.api.deleteBookmark(state.docId, bookmarkId);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    applyUndoState(result);
    setStatus('Deleted bookmark.');
  } catch (err) {
    reportError('Could not delete bookmark', err);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete') return;
  if (state.activePanel !== 'bookmarks' || !state.selectedBookmarkId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  deleteSelectedBookmark();
});

// Walks the tag tree for every H1-H6 node, in document order, collecting
// what generate_bookmarks() (tag_worker.py) needs to rebuild a nested
// outline matching the heading hierarchy: level (for nesting), page (from
// the tag tree's own resolved /Pg, already 0-based), title text - pulled
// via pullContentText(), the same content-extraction path the "Pull
// Content" button uses, since pikepdf has no equivalent way to recover a
// heading's visible text from its marked content - and top (the heading's
// vertical position on the page, so the generated bookmark scrolls straight
// to it instead of just the page's top edge; see computeHeadingTop()).
// Headings with no numbered level (a bare "H" or "Title" role) are skipped -
// there'd be no level to nest them by.
async function collectHeadingsForBookmarks() {
  const headingNodes = [];
  (function visit(node) {
    if (node.type === 'element') {
      const match = /^H([1-6])$/.exec(node.role || '');
      if (match) headingNodes.push({ id: node.id, level: Number(match[1]) });
    }
    for (const child of node.children || []) visit(child);
  })(state.tree);

  const headings = [];
  for (const { id, level } of headingNodes) {
    const node = state.nodesById.get(id)?.node;
    if (!node || node.page === null || node.page === undefined) continue;
    const title = (await pullContentText(id)).trim() || `Untitled ${node.role}`;
    const top = await computeHeadingTop(id, node.page);
    headings.push({ title, level, page: node.page, top });
  }
  return headings;
}

// A heading's y-coordinate on its page, in the same default-page-space
// units (unscaled, PAGE_SCALE === 1) that a PDF destination's /FitH "top"
// expects - measured from the page's own bottom-left origin, increasing
// upward. Pulled from the same mcid text-run rects tag highlighting uses
// (see computeHighlightRects), just against a scale-1 viewport instead of
// PAGE_SCALE, and flipped from pdf.js's top-down pixel space back to PDF
// space. null if the heading's marked content isn't findable (e.g. an empty
// heading with no runs on this page).
async function computeHeadingTop(nodeId, pageIndex) {
  const mcidSet = new Set(
    collectTargetMcids(nodeId).filter((t) => t.page === pageIndex).map((t) => t.mcid)
  );
  if (mcidSet.size === 0) return null;
  const page = await state.pdfDoc.getPage(pageIndex + 1);
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  const viewport = page.getViewport({ scale: 1 });
  const rect = unionRects(computeHighlightRects(textContent, viewport, mcidSet));
  return rect ? viewport.height - rect.y : null;
}

// Scrolls the canvas-wrap pane so page-space y-coordinate `top` (see
// computeHeadingTop()) sits at the top edge of the visible area - the
// on-page counterpart to jumpToPage()'s page-level navigation, used when a
// bookmark carries a specific position rather than just a page. Positions a
// throwaway 1px marker at that coordinate (reusing the highlight layer's
// existing percentage-of-viewport placement, which already accounts for the
// canvas's CSS scaling) and scrolls it into view, since there's no other
// element guaranteed to already sit exactly there.
async function scrollToHeadingTop(top) {
  if (top === null || top === undefined || !state.pdfDoc) return;
  const { viewport } = await getPageTextContent(state.currentPage);
  const pixelY = viewport.height - top * PAGE_SCALE;
  syncHighlightLayerBounds();
  const marker = document.createElement('div');
  marker.style.position = 'absolute';
  marker.style.left = '0';
  marker.style.width = '1px';
  marker.style.height = '1px';
  marker.style.top = `${(100 * pixelY / viewport.height).toFixed(3)}%`;
  el.highlightLayer.appendChild(marker);
  marker.scrollIntoView({ block: 'start', inline: 'nearest' });
  marker.remove();
}

el.btnGenerateBookmarks.addEventListener('click', async () => {
  if (!state.docId) return;
  if (!state.pdfDoc) {
    setStatus('Open a PDF preview before generating bookmarks.');
    return;
  }
  document.body.classList.add('busy');
  try {
    setStatus('Generating bookmarks from headings…');
    const headings = await collectHeadingsForBookmarks();
    const result = await window.api.generateBookmarks(state.docId, headings);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    applyUndoState(result);
    setStatus(headings.length > 0
      ? `Generated ${headings.length} bookmark${headings.length === 1 ? '' : 's'} from headings.`
      : 'No headings found - bookmarks cleared.');
  } catch (err) {
    reportError('Could not generate bookmarks', err);
  } finally {
    document.body.classList.remove('busy');
  }
});

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
  if (!entry || entry.node.type === 'root') return;

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

function refreshDetailsForSelection() {
  const nodeId = state.selectedNodeId;
  const entry = nodeId ? state.nodesById.get(nodeId) : null;
  if (!entry) {
    closeDetails();
    return;
  }
  if (entry.node.type !== 'element') {
    // A content/object-ref leaf - a valid selection (movable, like a tag),
    // just not an editable one. Hide the details form without wiping the
    // tree selection the way closeDetails() would (that's only for "nothing
    // is selected"), and still scroll/highlight it like a tag selection.
    el.detailsEmpty.hidden = false;
    el.detailsForm.hidden = true;
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
    const row = el.tagTree.querySelector(`[data-node-id="${nodeId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    highlightNodeOnPage(nodeId, { allowPageJump: true });
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
  if (multi) {
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
  } else {
    updateActualTextPlaceholder(node, nodeId);
  }

  // With multiple tags selected, only Role applies as a block edit (see the
  // submit handler) - disable the other fields rather than let an edit look
  // like it covers the whole selection when it would only touch this one.
  el.fieldAlt.disabled = multi;
  el.fieldActualText.disabled = multi;
  el.fieldLang.disabled = multi;
  el.btnPullContent.disabled = multi;

  // The /Document tag doesn't carry meaningful accessibility text of its
  // own - swap Alt/Actual Text out for the PDF's document-info Title/Author
  // instead (see update_doc_info() in tag_worker.py). The underlying Alt/
  // Actual Text fields are left populated (just hidden), same reasoning as
  // the Table preview swap below: Apply still round-trips whatever value
  // they held.
  const isDocument = !multi && node.role === 'Document';
  el.fieldDocInfoSection.hidden = !isDocument;
  el.fieldAltWrap.hidden = isDocument;
  if (isDocument) {
    el.fieldDocTitle.value = state.docInfo.title || '';
    el.fieldDocAuthor.value = state.docInfo.author || '';
  }

  // Table-cell attributes (Scope/Column span/Row span, PDF's Table attribute
  // owner - see _get_table_attrs() in tag_worker.py). Column span/Row span
  // apply to both TH and TD cells, so they're shown whenever every selected
  // tag is a TH or TD; Scope only has meaning on TH per the PDF spec, so it
  // stays hidden unless every selected tag is a TH specifically. Gating on
  // "every selected tag" (rather than just this one) means the fields can't
  // silently misrepresent a mixed selection. Unlike Alt/Actual text/
  // Language, these stay enabled in a multi-select: same block-apply-to-all
  // shape as Role, just applied to Table-attribute fields instead - see the
  // submit handler.
  const allSelectedIds = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const allTH = allSelectedIds.length > 0
    && allSelectedIds.every((id) => state.nodesById.get(id)?.node.role === 'TH');
  const allCell = allSelectedIds.length > 0
    && allSelectedIds.every((id) => {
      const role = state.nodesById.get(id)?.node.role;
      return role === 'TH' || role === 'TD';
    });
  el.thSection.hidden = !allCell;
  el.fieldScopeWrap.hidden = !allTH;
  el.fieldScope.value = allTH ? (node.scope || '') : '';
  el.fieldColSpan.value = allCell && node.colSpan != null ? node.colSpan : '';
  el.fieldRowSpan.value = allCell && node.rowSpan != null ? node.rowSpan : '';

  // A Table tag's Actual Text is swapped out for a generated read-only HTML
  // preview of its own row/cell structure - more useful here than a free-
  // text field, since what actually matters for a table is its shape (see
  // renderTablePreview()). The underlying field/value is left untouched
  // (just hidden) so Apply still round-trips whatever actualText it had.
  const isTable = !multi && node.role === 'Table';
  el.fieldActualTextWrap.hidden = isTable || isDocument;
  el.tablePreviewWrap.hidden = !isTable;
  if (isTable) {
    renderTablePreview(node);
  } else {
    state.tablePreviewToken += 1;
    el.tablePreviewContainer.innerHTML = '';
  }

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
  state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
  el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
  el.fieldAlt.disabled = false;
  el.fieldActualText.disabled = false;
  el.fieldLang.disabled = false;
  el.btnPullContent.disabled = false;
  el.thSection.hidden = true;
  el.fieldScopeWrap.hidden = true;
  el.fieldActualTextWrap.hidden = false;
  el.tablePreviewWrap.hidden = true;
  state.tablePreviewToken += 1; // invalidate any table-preview build still in flight
  state.tablePreviewTableEl = null;
  el.btnExpandTablePreview.disabled = true;
  el.tablePreviewContainer.innerHTML = '';
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
// A Figure/Formula's marked content is normally an image `Do` call or a
// stroked/filled vector path, neither of which getTextContent() reports -
// those rects come from a separate path, getPageGraphicRects(), that walks
// the page's operator list instead (see below).

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

// A tag has no marked content at all when it was created by the "Add
// Figure" draw tool over a region with no isolable image object (see
// figure_from_rect()'s "bbox" strategy in tag_worker.py) - it carries a
// /Layout /BBox attribute instead of any /K. collectTargetMcids() finds
// nothing for it, so highlightNodeOnPage() needs this parallel walk to
// still know where the tag is - mirrors collectTargetMcids' shape
// ({page, ...}, page 0-based) but keyed on a page-space rect instead of an
// mcid to look up in the text/graphics layers.
function collectTargetBBoxes(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) return [];
  const targets = [];
  (function visit(node) {
    if (node.type === 'element' && Array.isArray(node.bbox) && node.page !== null && node.page !== undefined) {
      targets.push({ bbox: node.bbox, page: node.page });
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

// Builds a page's mcid -> image-xobject rect(s) lookup, its mcid -> vector-
// path rect(s) lookup, and its set of mcids painted via vector path
// operators (stroke/fill), in one pass over the operator list (cached per
// page). This is the non-text-content counterpart to getPageMcidTextMap():
// image `Do` calls and path stroke/fill ops don't show up in
// getTextContent(), so a Figure's placement has to be recovered from the
// raw operator list instead. Image rects come from mapping the unit square
// [0,1]x[0,1] - where an image is painted - through the current CTM
// (accumulated the same way a PDF interpreter would, via save/restore/
// transform/form-xobject) into page space. Vector rects come from the same
// CTM applied to the bounding box pdf.js itself precomputes for each path
// (constructPath's third arg) - it doesn't track curve control points, so a
// curve-only path (no preceding moveTo/lineTo/rectangle) yields an empty
// bound and is skipped, same as this file's other "close enough" rect
// approximations.
async function getPageMcidGraphicsInfo(pageNumber) {
  if (state.mcidGraphicsCache.has(pageNumber)) return state.mcidGraphicsCache.get(pageNumber);
  const page = await state.pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const { fnArray, argsArray } = await page.getOperatorList();
  const { OPS, Util } = pdfjsLib;

  const imageRects = new Map(); // mcid -> rect[]
  const vectorRects = new Map(); // mcid -> rect[]
  const vectorMcids = new Set();
  const mcidStack = [];
  const ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let currentPathMinMax = null; // [minX, minY, maxX, maxY] in user space, or null once painted

  const currentMcid = () => (mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : null);

  const rectFromCorners = (corners) => {
    const transformed = corners
      .map((p) => Util.applyTransform(p, ctm))
      .map((p) => Util.applyTransform(p, viewport.transform));
    const xs = transformed.map((c) => c[0]);
    const ys = transformed.map((c) => c[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  };

  const unitSquareRectForCurrentMcid = () => {
    const mcid = currentMcid();
    if (mcid === null) return;
    const rect = rectFromCorners([[0, 0], [1, 0], [0, 1], [1, 1]]);
    const existing = imageRects.get(mcid);
    if (existing) existing.push(rect); else imageRects.set(mcid, [rect]);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        ctmStack.push(ctm);
        break;
      case OPS.restore:
        ctm = ctmStack.length > 0 ? ctmStack.pop() : ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        ctmStack.push(ctm);
        if (args && args[0]) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = ctmStack.length > 0 ? ctmStack.pop() : ctm;
        break;
      case OPS.beginMarkedContentProps:
        mcidStack.push(typeof args[1] === 'number' ? args[1] : null);
        break;
      case OPS.beginMarkedContent:
        mcidStack.push(null);
        break;
      case OPS.endMarkedContent:
        mcidStack.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        unitSquareRectForCurrentMcid();
        break;
      case OPS.constructPath:
        currentPathMinMax = args[2];
        break;
      // A path is built by constructPath and only actually painted by one
      // of these - a clip-only path (W n with no stroke/fill) shouldn't
      // count as visible vector content, so we key off the paint ops
      // rather than constructPath itself.
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke: {
        const mcid = currentMcid();
        if (mcid !== null) {
          vectorMcids.add(mcid);
          if (currentPathMinMax && Number.isFinite(currentPathMinMax[0])) {
            const [minX, minY, maxX, maxY] = currentPathMinMax;
            const rect = rectFromCorners([[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]);
            const existing = vectorRects.get(mcid);
            if (existing) existing.push(rect); else vectorRects.set(mcid, [rect]);
          }
        }
        // A painted path's current path is cleared per spec - don't let it
        // leak into some later paint op that (invalidly) skips its own
        // constructPath.
        currentPathMinMax = null;
        break;
      }
      default:
        break;
    }
  }

  const info = { imageRects, vectorRects, vectorMcids };
  state.mcidGraphicsCache.set(pageNumber, info);
  return info;
}

// Merges image and vector-path rects into one mcid -> rect[] lookup, for
// consumers (highlighting, click hit-testing) that don't care which kind of
// graphic a Figure/Formula's content actually is.
async function getPageGraphicRects(pageNumber) {
  const { imageRects, vectorRects } = await getPageMcidGraphicsInfo(pageNumber);
  const merged = new Map();
  for (const [mcid, rects] of imageRects) merged.set(mcid, [...rects]);
  for (const [mcid, rects] of vectorRects) {
    const existing = merged.get(mcid);
    if (existing) existing.push(...rects); else merged.set(mcid, [...rects]);
  }
  return merged;
}

async function getPageVectorMcids(pageNumber) {
  return (await getPageMcidGraphicsInfo(pageNumber)).vectorMcids;
}

// A content leaf's image rect must cover at least this fraction of the
// page's own width/height (independently, not just by area) to count as
// "the same size as the page" - auto-tagged full-page scans are typically
// placed with a few points of margin rather than flush to the MediaBox
// edges (e.g. one real sample: a 499x645 scan on a 514x657 page, ~97%
// coverage per side), while an intentionally-sized figure sharing the page
// with other content falls well short of this on at least one axis.
const FULL_PAGE_LEAF_COVERAGE = 0.9;

// Finds content leaves (bare-MCID leaves whose content is an image `Do`
// call - see getPageMcidGraphicsInfo()) whose painted rect is essentially
// the full page. These are almost always a full-page scan background that
// auto-tagging wrapped in a Figure alongside the real (searchable) text
// layer - the image itself carries no accessible information a screen
// reader can use, so it belongs artifacted, not left in a Figure tag. Does
// not cover /OBJR image leaves (annotation-style object references): they
// aren't wrapped in marked content, so recovering their placement would
// mean matching pdf.js's parsed resources back to the specific pikepdf
// object identity behind /Obj, which isn't currently feasible from here -
// and in practice this full-page-background pattern shows up as bare MCID
// leaves, not OBJR ones.
async function findFullPageImageLeafIds() {
  if (!state.pdfDoc) return [];

  const leavesByPage = new Map(); // page (0-based) -> [{nodeId, mcid}]
  for (const [nodeId, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'content' || node.mcid === null || node.mcid === undefined) continue;
    if (node.page === null || node.page === undefined) continue;
    const list = leavesByPage.get(node.page);
    if (list) list.push({ nodeId, mcid: node.mcid });
    else leavesByPage.set(node.page, [{ nodeId, mcid: node.mcid }]);
  }

  const matches = [];
  for (const [page0, leaves] of leavesByPage) {
    const pageNumber = page0 + 1;
    if (pageNumber < 1 || pageNumber > state.pageCount) continue;
    const page = await state.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PAGE_SCALE });
    const { imageRects } = await getPageMcidGraphicsInfo(pageNumber);
    const minWidth = viewport.width * FULL_PAGE_LEAF_COVERAGE;
    const minHeight = viewport.height * FULL_PAGE_LEAF_COVERAGE;
    for (const { nodeId, mcid } of leaves) {
      const rects = imageRects.get(mcid);
      if (!rects) continue;
      if (rects.some((r) => r.width >= minWidth && r.height >= minHeight)) {
        matches.push(nodeId);
      }
    }
  }
  return matches;
}

// Collects a tag's own content text (its content-leaf descendants' text,
// per collectTargetMcids), joined with a single space between blocks - used
// by the "Pull Content" button to seed Actual Text, and by the table preview
// (see renderTablePreview()) to fill in each generated cell. A leaf with no
// text run of its own (an image `Do` call or a stroked/filled vector path -
// see getPageMcidGraphicsInfo()) contributes a bracketed type label instead
// of being silently dropped, the same fallback loadContentText() uses for a
// content leaf's tree-row preview.
async function pullContentText(nodeId) {
  const targets = collectTargetMcids(nodeId);
  const parts = [];
  for (const target of targets) {
    const pageNumber = target.page + 1;
    if (pageNumber < 1 || pageNumber > state.pageCount) continue;
    const map = await getPageMcidTextMap(pageNumber);
    const text = map.get(target.mcid);
    if (text) {
      parts.push(text);
      continue;
    }
    const { imageRects, vectorMcids } = await getPageMcidGraphicsInfo(pageNumber);
    if (imageRects.has(target.mcid)) parts.push('[Image]');
    else if (vectorMcids.has(target.mcid)) parts.push('[Graphic]');
  }
  return parts.join(' ');
}

// True when a tag has a content leaf (bare MCID, node.type === 'content')
// directly among its children - a strong hint that Actual Text exists to
// replace that content, whether by an automatic placeholder pull (see
// updateActualTextPlaceholder()) or by focusing the empty field (see the
// fieldActualText 'focus' listener below). A content leaf buried under
// nested elements doesn't count - same "immediately inside" scope both
// call sites want.
function hasDirectContentLeaf(node) {
  return (node.children || []).some((child) => child.type === 'content');
}

// Swaps the Actual Text field's placeholder for the tag's own content text
// (pulled the same way the "Pull Content" button does) when the tag has a
// content leaf directly inside it - a strong hint that Actual Text exists to
// replace that content. Any other tag (no content leaf, or one buried under
// nested elements) keeps the generic default placeholder from index.html.
async function updateActualTextPlaceholder(node, nodeId) {
  if (!hasDirectContentLeaf(node)) {
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
    return;
  }
  const token = ++state.actualTextPlaceholderToken;
  const text = await pullContentText(nodeId);
  if (token !== state.actualTextPlaceholderToken) return; // selection changed mid-flight
  el.fieldActualText.placeholder = text || DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
}

// --- table tag -> generated HTML preview ---------------------------------
//
// Selecting a Table tag swaps its Actual Text field for a read-only preview
// built from the tag's own row/cell structure (see refreshDetailsForSelection()).

// Walks a Table tag's subtree for its TR descendants, in document order.
// Recurses through wrapper roles (THead/TBody/TFoot, or auto-tagging's
// stray Divs) to find rows nested under them, but never descends into a
// nested Table - that inner table's rows belong to it, not this one.
function collectTableRows(tableNode) {
  const rows = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TR') rows.push(child);
      else if (child.role === 'Table') continue;
      else visit(child);
    }
  })(tableNode);
  return rows;
}

// Same idea for a TR's TH/TD descendants: recurse through wrappers, but stop
// at a nested TR or Table so a cell's own nested structure never leaks in as
// extra columns of the outer row.
function collectRowCells(trNode) {
  const cells = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TH' || child.role === 'TD') cells.push(child);
      else if (child.role === 'TR' || child.role === 'Table') continue;
      else visit(child);
    }
  })(trNode);
  return cells;
}

// scope -> { glyph, class } for the little direction indicator drawn in a TH
// preview cell: pointing down for a column header, right for a row header,
// both ways for scope="Both", or a red X when scope isn't set at all.
const SCOPE_ICONS = {
  Column: { glyph: '↓', cls: 'scope-col' },
  Row: { glyph: '→', cls: 'scope-row' },
  Both: { glyph: '↓→', cls: 'scope-both' },
};

async function renderTablePreview(tableNode) {
  const token = ++state.tablePreviewToken;
  el.btnExpandTablePreview.disabled = true;

  if (!state.pdfDoc) {
    state.tablePreviewTableEl = null;
    el.tablePreviewContainer.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'table-preview-empty';
    p.textContent = 'Open the PDF preview to generate a table preview.';
    el.tablePreviewContainer.appendChild(p);
    return;
  }

  const rows = collectTableRows(tableNode);

  if (rows.length === 0) {
    state.tablePreviewTableEl = null;
    el.tablePreviewContainer.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'table-preview-empty';
    p.textContent = 'No rows found in this table.';
    el.tablePreviewContainer.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'generated-table';

  for (const tr of rows) {
    const trEl = document.createElement('tr');
    for (const cell of collectRowCells(tr)) {
      const isHeader = cell.role === 'TH';
      const text = await pullContentText(cell.id);
      if (token !== state.tablePreviewToken) return; // selection changed mid-flight

      const cellEl = document.createElement(isHeader ? 'th' : 'td');
      const colSpan = Number(cell.colSpan) || 1;
      const rowSpan = Number(cell.rowSpan) || 1;
      if (colSpan > 1) cellEl.colSpan = colSpan;
      if (rowSpan > 1) cellEl.rowSpan = rowSpan;

      if (isHeader) {
        const icon = SCOPE_ICONS[cell.scope];
        const iconEl = document.createElement('span');
        iconEl.className = `scope-icon ${icon ? icon.cls : 'scope-none'}`;
        iconEl.textContent = icon ? icon.glyph : '✕';
        cellEl.appendChild(iconEl);
      }
      cellEl.appendChild(document.createTextNode(text));
      trEl.appendChild(cellEl);
    }
    table.appendChild(trEl);
  }

  if (token !== state.tablePreviewToken) return;
  state.tablePreviewTableEl = table;
  el.tablePreviewContainer.innerHTML = '';
  el.tablePreviewContainer.appendChild(table);
  el.btnExpandTablePreview.disabled = false;
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
      targetEl.textContent = `“${text}”`;
      targetEl.title = text;
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
      targetEl.textContent = '[Image]';
    } else if (vectorMcids.has(mcid)) {
      targetEl.textContent = '[Graphic]';
    } else {
      targetEl.textContent = '';
    }
    targetEl.title = '';
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

// Same corners-through-viewport-transform approach as itemRectInViewport()
// above, for a plain page-space [x0, y0, x1, y1] rect (a tag's /Layout
// /BBox) rather than a text item's glyph box.
function bboxRectInViewport(bbox, viewport) {
  const [x0, y0, x1, y1] = bbox;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map((p) => pdfjsLib.Util.applyTransform(p, viewport.transform));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
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
// selects it. Falls back to the image/vector-path rects (see
// getPageGraphicRects) so clicking a Figure's picture or drawing also
// selects its tag.

function pointInRect(x, y, box) {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

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
    if (pointInRect(x, y, box)) return pageMcids.get(currentMcid);
  }

  const graphicRectMap = await getPageGraphicRects(state.currentPage);
  for (const [mcid, rects] of graphicRectMap) {
    if (!pageMcids.has(mcid)) continue;
    if (rects.some((box) => pointInRect(x, y, box))) return pageMcids.get(mcid);
  }

  return null;
}

el.canvas.addEventListener('click', async (e) => {
  // A completed rubber-band drag still fires a native 'click' on mouseup
  // (mousedown and mouseup landed on the same element) - while Add Figure's
  // draw mode is active, that click means "finished drawing", not "select
  // the tag under the cursor", so it's handled entirely by the mouseup
  // listener below instead.
  if (!state.pdfDoc || state.figureDrawActive) return;
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
  for (const layer of [el.highlightLayer, el.drawOverlay]) {
    layer.style.left = `${el.canvas.offsetLeft}px`;
    layer.style.top = `${el.canvas.offsetTop}px`;
    layer.style.width = `${el.canvas.clientWidth}px`;
    layer.style.height = `${el.canvas.clientHeight}px`;
  }
}

function renderHighlightRects(boxes, viewport) {
  el.highlightLayer.innerHTML = '';
  let activeBox = null;
  for (const { rect: r, active, isFigure } of boxes) {
    const box = document.createElement('div');
    box.className = active ? 'highlight-box' : 'highlight-box secondary';
    // Percentages of the viewport's own pixel size so boxes stay aligned
    // even though the canvas is scaled down by CSS (max-width: 100%).
    box.style.left = `${(100 * r.x / viewport.width).toFixed(3)}%`;
    box.style.top = `${(100 * r.y / viewport.height).toFixed(3)}%`;
    box.style.width = `${(100 * r.width / viewport.width).toFixed(3)}%`;
    box.style.height = `${(100 * r.height / viewport.height).toFixed(3)}%`;
    el.highlightLayer.appendChild(box);
    if (active) activeBox = box;
    if (isFigure) for (const line of buildCrosshair(r, viewport)) el.highlightLayer.appendChild(line);
  }
  // Tall/wide pages can overflow the canvas-wrap pane (it scrolls), so the
  // newly-selected tag's box may be off-screen even though it's on the
  // current page - bring it into view, but don't scroll if already visible.
  activeBox?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Figures can be tiny relative to the page, so a plain box is easy to miss.
// A reticle centered on the box - four lines running out to the page edges,
// absent inside the box itself - draws the eye to the right neighborhood.
function buildCrosshair(r, viewport) {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const pct = (v, of) => `${(100 * v / of).toFixed(3)}%`;

  const segments = [
    // above the box
    { left: pct(cx, viewport.width), top: '0', width: '1px', height: pct(r.y, viewport.height), transform: 'translateX(-50%)' },
    // below the box
    { left: pct(cx, viewport.width), top: pct(r.y + r.height, viewport.height), width: '1px', height: pct(viewport.height - (r.y + r.height), viewport.height), transform: 'translateX(-50%)' },
    // left of the box
    { left: '0', top: pct(cy, viewport.height), width: pct(r.x, viewport.width), height: '1px', transform: 'translateY(-50%)' },
    // right of the box
    { left: pct(r.x + r.width, viewport.width), top: pct(cy, viewport.height), width: pct(viewport.width - (r.x + r.width), viewport.width), height: '1px', transform: 'translateY(-50%)' },
  ];
  return segments.map((s) => {
    const line = document.createElement('div');
    line.className = 'highlight-crosshair';
    Object.assign(line.style, s);
    return line;
  });
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

  // With a multi-tag selection, highlight every member (not just the active
  // one) - one box per tag, the active tag's box styled like a single
  // selection and the rest tinted like .tree-row.multi-selected.
  const selectedIds = state.selectedNodeIds.has(nodeId) && state.selectedNodeIds.size > 1
    ? Array.from(state.selectedNodeIds)
    : [nodeId];

  // collectTargetBBoxes() exists for tags with NO marked content at all (see
  // its comment) - a node's own /Layout /BBox page is only trustworthy in
  // that case. When a node also has real mcid content, its /Pg (if unset)
  // inherits from wherever the struct tree happens to set it above - which
  // can land on a page nowhere near where the node's actual content lives
  // (e.g. a Table whose own dict has a stale /BBox but no /Pg, inheriting an
  // ancestor's page while every /TR's content sits many pages later). Using
  // that bbox page as a highlight/jump target there would fight the real,
  // per-leaf-resolved content pages, so bbox targets only apply as a
  // fallback when mcid targets came up empty.
  const targetsByNode = new Map(selectedIds.map((id) => [id, collectTargetMcids(id)]));
  const bboxTargetsByNode = new Map(selectedIds.map((id) => [
    id, targetsByNode.get(id).length > 0 ? [] : collectTargetBBoxes(id),
  ]));
  const activeTargets = [...(targetsByNode.get(nodeId) || []), ...(bboxTargetsByNode.get(nodeId) || [])];
  const allTargets = [...Array.from(targetsByNode.values()).flat(), ...Array.from(bboxTargetsByNode.values()).flat()];
  if (allTargets.length === 0) {
    clearHighlight();
    return;
  }

  const hasContentOnCurrentPage = allTargets.some((t) => t.page + 1 === state.currentPage);
  if (!hasContentOnCurrentPage && allowPageJump) {
    const pageSourceTargets = activeTargets.length > 0 ? activeTargets : allTargets;
    const candidatePages = pageSourceTargets.map((t) => t.page + 1).filter((p) => p >= 1 && p <= state.pageCount);
    if (candidatePages.length > 0) {
      state.currentPage = Math.min(...candidatePages);
      await renderCurrentPage();
      updatePageNavUI();
      if (token !== state.highlightToken) return; // superseded by a newer selection/page change
    }
  }

  try {
    const { textContent, viewport } = await getPageTextContent(state.currentPage);
    const graphicRectMap = await getPageGraphicRects(state.currentPage);
    if (token !== state.highlightToken) return;

    const boxes = [];
    for (const id of selectedIds) {
      const targets = targetsByNode.get(id) || [];
      const mcidSet = new Set(targets.filter((t) => t.page + 1 === state.currentPage).map((t) => t.mcid));
      const rects = mcidSet.size > 0 ? computeHighlightRects(textContent, viewport, mcidSet) : [];
      for (const mcid of mcidSet) {
        const graphicRects = graphicRectMap.get(mcid);
        if (graphicRects) rects.push(...graphicRects);
      }
      const bboxTargets = (bboxTargetsByNode.get(id) || []).filter((t) => t.page + 1 === state.currentPage);
      for (const t of bboxTargets) rects.push(bboxRectInViewport(t.bbox, viewport));
      if (rects.length === 0) continue;
      const rect = unionRects(rects);
      const role = state.nodesById.get(id)?.node.role;
      if (rect) boxes.push({ rect, active: id === nodeId, isFigure: categoryForRole(role) === 'figure' });
    }
    syncHighlightLayerBounds();
    renderHighlightRects(boxes, viewport);
  } catch (err) {
    console.error('Could not compute tag highlight:', err);
  }
}

window.addEventListener('resize', () => {
  if (state.pdfDoc) syncHighlightLayerBounds();
});

// Auto-applies on the form's native 'change' event (fires when a text/
// textarea field is committed via blur, and immediately for select
// elements) rather than requiring an explicit Apply button.
el.detailsForm.addEventListener('change', applyDetailsChange);

async function applyDetailsChange() {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;

  const multi = state.selectedNodeIds.size > 1;

  try {
    let result;
    if (multi) {
      // With multiple tags selected, only Role and (when every selected tag
      // is a TH) the TH attributes apply as a block edit - the other fields
      // are disabled in the form for this reason (see
      // refreshDetailsForSelection()).
      const role = el.fieldRole.value.trim();
      if (!role) {
        setStatus('Enter a role to apply it to the selected tags.');
        return;
      }
      const changes = { role };
      if (!el.fieldScopeWrap.hidden) {
        changes.scope = el.fieldScope.value;
      }
      if (!el.thSection.hidden) {
        changes.colSpan = el.fieldColSpan.value.trim();
        changes.rowSpan = el.fieldRowSpan.value.trim();
      }
      const selectedIds = Array.from(state.selectedNodeIds);
      result = await window.api.updateNodes(state.docId, selectedIds, changes);
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
      if (!el.fieldScopeWrap.hidden) {
        changes.scope = el.fieldScope.value;
      }
      if (!el.thSection.hidden) {
        changes.colSpan = el.fieldColSpan.value.trim();
        changes.rowSpan = el.fieldRowSpan.value.trim();
      }
      result = await window.api.updateNode(state.docId, nodeId, changes);
      applyFreshTree(result.tree);
      applyUndoState(result);

      // /Document tag selected: Title/Author (PDF document-info, not a
      // struct-element attribute) are edited via a separate call, and only
      // when actually changed - unlike alt/actualText/lang above, there's no
      // single combined undo step for both, so an unconditional call here
      // would push an empty undo snapshot on every unrelated field edit.
      if (!el.fieldDocInfoSection.hidden) {
        const title = el.fieldDocTitle.value.trim();
        const author = el.fieldDocAuthor.value.trim();
        if (title !== (state.docInfo.title || '') || author !== (state.docInfo.author || '')) {
          const infoResult = await window.api.updateDocInfo(state.docId, { title, author });
          state.docInfo = infoResult.docInfo;
          applyUndoState(infoResult);
        }
      }

      setStatus('Updated tag.');
      // Keep the same node selected/visible after the tree re-renders.
      selectNode(nodeId);
    }
  } catch (err) {
    reportError('Could not update tag', err);
  }
}

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

// Focusing an empty Actual Text field auto-pulls the tag's own content into
// it, same as clicking "Pull Content", when the selected tag has a content
// leaf directly inside it - saves the extra click for the common case of
// replacing a tag's own text/image/graphic content. A tag without one (or a
// field that already has a value) is left alone.
el.fieldActualText.addEventListener('focus', async () => {
  if (el.fieldActualText.value) return;
  const nodeId = el.fieldNodeId.value;
  if (!nodeId || !state.pdfDoc) return;
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type !== 'element' || !hasDirectContentLeaf(entry.node)) return;
  try {
    const text = await pullContentText(nodeId);
    // Selection may have moved, or the user may have typed something, while
    // the pull was in flight - don't clobber either.
    if (el.fieldActualText.value || el.fieldNodeId.value !== nodeId) return;
    if (text) {
      el.fieldActualText.value = text;
      setStatus('Pulled content text into Actual Text.');
    }
  } catch (err) {
    reportError('Could not pull content text', err);
  }
});

// Enter (not Shift+Enter, which still inserts a newline) commits the alt
// text like a blur would, then jumps to the next tag in tree order and
// keeps this field focused - lets you type alt text for a run of
// figures/tables back-to-back without reaching for the mouse. Skips over
// content/object-ref leaves since they have no alt text field of their own
// (see refreshDetailsForSelection, which hides the whole form for those).
el.fieldAlt.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();

  await applyDetailsChange();

  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
  const currentIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectedNodeId);
  if (currentIndex === -1) return;

  const nextRow = rows.slice(currentIndex + 1).find((row) => {
    return state.nodesById.get(row.dataset.nodeId)?.node.type === 'element';
  });
  if (!nextRow) return;

  selectNode(nextRow.dataset.nodeId);
  el.fieldAlt.focus();
  el.fieldAlt.select();
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
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    state.docInfo = result.docInfo || { title: null, author: null };
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
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    state.docInfo = result.docInfo || { title: null, author: null };
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

// The native <dialog> already closes on Escape and backdrop-click-outside
// is handled via the click listener below (clicking the dialog element
// itself only happens on the backdrop, since the visible content is inside
// a child that would catch the click first).
el.btnExpandTablePreview.addEventListener('click', () => {
  if (!state.tablePreviewTableEl) return;
  el.tablePreviewDialogContainer.innerHTML = '';
  el.tablePreviewDialogContainer.appendChild(state.tablePreviewTableEl.cloneNode(true));
  el.tablePreviewDialog.showModal();
});
el.btnCloseTablePreview.addEventListener('click', () => el.tablePreviewDialog.close());
el.tablePreviewDialog.addEventListener('click', (e) => {
  if (e.target === el.tablePreviewDialog) el.tablePreviewDialog.close();
});

window.api.onMenuShortcuts(() => el.shortcutsDialog.showModal());
el.btnCloseShortcuts.addEventListener('click', () => el.shortcutsDialog.close());
el.shortcutsDialog.addEventListener('click', (e) => {
  if (e.target === el.shortcutsDialog) el.shortcutsDialog.close();
});

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
// element's children simply aren't rendered (see renderTreeNode). Holding
// Shift extends the selection instead of replacing it, growing/shrinking
// from the fixed anchor exactly like shift+click (see extendSelectionTo).
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
  if (e.shiftKey) {
    if (!state.selectionAnchorId) state.selectionAnchorId = state.selectedNodeId;
    extendSelectionTo(rows[nextIndex].dataset.nodeId);
  } else {
    selectNode(rows[nextIndex].dataset.nodeId);
  }
});

// Ctrl/Cmd+Up/Down moves the selected tag one place earlier/later among its
// siblings (a keyboard equivalent of dragging it past its neighbor). At the
// first/last child slot it instead outdents the tag to just before/after
// its own parent - unless it's a content/object-ref leaf and there's an
// adjacent tag at that same boundary, in which case it jumps straight into
// that tag's content instead (see moveSelectedSibling()). Disabled while a
// Headings/Figures filter is active - the top-level filtered list (flat for
// Headings, one entry per matched figure for Figures) doesn't reflect
// sibling adjacency in the real tree.
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
  if (!entry || entry.node.type === 'root' || entry.parentId === null) return;
  const parentId = entry.parentId;
  const parentEntry = state.nodesById.get(parentId);
  if (!parentEntry) return;

  const siblings = parentEntry.node.children || [];
  const currentIndex = siblings.findIndex((child) => child.id === nodeId);
  if (currentIndex === -1) return;

  let newParentId = parentId;
  let newIndex = currentIndex + direction;

  // Set only for the "jump into the adjacent tag" case below - the usual
  // (parent, index) reselect trick doesn't work there (see the comment by
  // the reselect logic), so this carries what it needs instead.
  let jumpGrandParentId = null;
  let jumpAdjacentIndex = -1;

  if (newIndex < 0 || newIndex >= siblings.length) {
    // At the edge of its sibling list. Only possible to go any further if
    // the parent itself has a parent to work with (i.e. it isn't the
    // struct root).
    if (parentEntry.parentId === null) return;
    const grandParentId = parentEntry.parentId;
    const grandParentEntry = state.nodesById.get(grandParentId);
    if (!grandParentEntry) return;
    const parentSiblings = grandParentEntry.node.children || [];
    const parentIndex = parentSiblings.findIndex((child) => child.id === parentId);
    if (parentIndex === -1) return;

    // A content/object-ref leaf pushed past the end/start of its own
    // parent's children jumps into the *adjacent* tag at that same level
    // instead of merely outdenting - the next tag below when moving past
    // the last child, the previous tag above when moving past the first -
    // landing in its first/last content slot respectively. That's the
    // content-leaf equivalent of "keep moving in this direction", since
    // sitting it beside its own parent wouldn't make it content of
    // anything. Element tags always just outdent (the `else` branch).
    const isContentLeaf = entry.node.type === 'content' || entry.node.type === 'object-ref';
    const adjacentTag = isContentLeaf ? parentSiblings[parentIndex + direction] : undefined;

    if (adjacentTag && adjacentTag.type === 'element') {
      newParentId = adjacentTag.id;
      newIndex = direction < 0 ? adjacentTag.children.length : 0;
      jumpGrandParentId = grandParentId;
      jumpAdjacentIndex = parentIndex + direction;
    } else {
      // Outdent past the parent instead: moving up out of the first child
      // slot drops the tag just before its (former) parent; moving down
      // out of the last child slot drops it just after.
      newParentId = grandParentId;
      newIndex = direction < 0 ? parentIndex : parentIndex + 1;
    }
  }

  try {
    const result = await window.api.reorderNode(state.docId, nodeId, newParentId, newIndex);
    applyFreshTree(result.tree);
    applyUndoState(result);
    // Node ids are reassigned by depth-first position on every rebuild (see
    // tag_worker.py). For a plain sibling move or an outdent, newParentId
    // is always an *ancestor* of the moved node's old position, and an
    // ancestor's id is stable across the rebuild (it's assigned before its
    // own children are visited, and neither move changes its position
    // among its siblings) - so the usual (parent, index) lookup still
    // finds the right node. Jumping into an adjacent tag is different: that
    // tag is a *sibling*, and moving a leaf out of one side of it and into
    // the other shifts the depth-first counter enough that the sibling's
    // own id can change (it may even end up reused by the node we just
    // moved). Its *grandparent* and its position among *its* siblings are
    // still both stable though (neither was touched by this move), so
    // re-locate it structurally through those instead of trusting the
    // captured id.
    let movedNode;
    if (jumpGrandParentId !== null) {
      const freshAdjacentTag = state.nodesById.get(jumpGrandParentId)?.node.children?.[jumpAdjacentIndex];
      movedNode = freshAdjacentTag?.children?.[newIndex];
    } else {
      movedNode = state.nodesById.get(newParentId)?.node.children?.[newIndex];
    }
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
    const direction = e.key === 'ArrowRight' ? 1 : -1;
    if (state.selectedNodeIds.size > 1) {
      e.preventDefault();
      shiftSelectedHeadingLevels(direction);
    } else if (attemptHeadingLevelChange(direction)) {
      e.preventDefault();
    }
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

// Delete removes the current selection from the struct tree. A tag
// (element node) is deleted along with its whole subtree; a content/
// object-ref leaf is just unlinked from its tag, which is what "artifact"
// it amounts to here - see delete_nodes() in tag_worker.py.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete') return;
  if (state.activePanel === 'bookmarks') return; // handled by the Bookmarks-panel Delete listener instead
  if (state.selectedNodeIds.size === 0) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  deleteSelection();
});

async function deleteSelection() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  // Only the top-level selected nodes need to be sent - deleting an
  // ancestor already takes its whole subtree, including any selected
  // descendants, with it.
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  let tagCount = 0;
  let contentCount = 0;
  for (const id of topLevelIds) {
    const entry = state.nodesById.get(id);
    if (entry?.node.type === 'element') tagCount += 1;
    else contentCount += 1;
  }

  try {
    const result = await window.api.deleteNodes(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);
    closeDetails();

    const parts = [];
    if (tagCount > 0) parts.push(`deleted ${tagCount} tag${tagCount === 1 ? '' : 's'}`);
    if (contentCount > 0) parts.push(`artifacted ${contentCount} content element${contentCount === 1 ? '' : 's'}`);
    const message = parts.join(' and ');
    setStatus(message.charAt(0).toUpperCase() + message.slice(1) + '.');
  } catch (err) {
    reportError('Could not delete selection', err);
  }
}

// 1-6/P/L/I/T/R/D/H/F convert the current selection's role, each via a
// dedicated backend op (set_role_or_wrap/convert_to_paragraph/make_list/
// make_table/make_tr/convert_to_figure in tag_worker.py) rather than a plain
// Role edit, since a content/object-ref leaf has no role of its own to set -
// these wrap it in a brand-new struct element instead. See each handler
// below for what its shortcut actually does structurally.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.selectedNodeIds.size === 0) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (/^[1-6]$/.test(e.key)) {
    e.preventDefault();
    applyRoleShortcut(`H${e.key}`);
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'p') {
    e.preventDefault();
    convertSelectionToParagraph();
  } else if (key === 'l') {
    e.preventDefault();
    groupSelectionIntoList();
  } else if (key === 'i') {
    e.preventDefault();
    applyRoleShortcut('LI');
  } else if (key === 't') {
    e.preventDefault();
    groupSelectionIntoTable();
  } else if (key === 'r') {
    e.preventDefault();
    groupSelectionIntoTr();
  } else if (key === 'd') {
    e.preventDefault();
    applyRoleShortcut('TD');
  } else if (key === 'h') {
    e.preventDefault();
    applyRoleShortcut('TH');
  } else if (key === 'f') {
    e.preventDefault();
    convertSelectionToFigure();
  }
});

// Backs the H1-H6 and 'I' shortcuts: relabels each already-tagged selected
// node's role in place, and wraps any selected content/object-ref leaf in a
// brand-new element with that role. A wrapped leaf's id ends up pointing at
// its new wrapper rather than the leaf itself (it lands in the same
// depth-first slot the leaf used to occupy - see set_role_or_wrap() in
// tag_worker.py), which is what we want selected afterward anyway.
async function applyRoleShortcut(role) {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;
  const allElements = ids.every((id) => state.nodesById.get(id)?.node.type === 'element');

  try {
    const result = await window.api.setRoleOrWrap(state.docId, ids, role);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (ids.length === 1) {
      if (state.nodesById.has(ids[0])) selectNode(ids[0]);
      else closeDetails();
    } else if (allElements) {
      // A pure batch of role relabels doesn't touch tree shape, so every id
      // is still exactly where it was - safe to keep the whole selection,
      // same as the bulk Role field edit does.
      state.selectedNodeIds = new Set(ids.filter((id) => state.nodesById.has(id)));
      state.selectedNodeId = state.selectedNodeIds.has(state.selectedNodeId)
        ? state.selectedNodeId
        : Array.from(state.selectedNodeIds).pop();
      renderTree();
      refreshDetailsForSelection();
    } else {
      // A mix of tags and content leaves: wrapping any one of the leaves
      // shifts the ids of everything after it in document order, so the
      // rest of the captured ids can no longer be trusted to point at the
      // right nodes - drop the selection rather than risk a silent
      // mis-select.
      closeDetails();
    }
    setStatus(`Set ${ids.length} tag${ids.length === 1 ? '' : 's'} to ${role}.`);
  } catch (err) {
    reportError(`Could not convert to ${role}`, err);
  }
}

// Backs the 'P' shortcut: converts each selected tag to a Paragraph, except
// a List/Span/Div, which gets flattened into paragraphs instead (see
// convert_to_paragraph() in tag_worker.py for why). Reselects on a single
// target the same way applyRoleShortcut() does - the old id still resolves
// to whatever now occupies that slot, whether that's the relabeled tag, a
// wrapped leaf, or (for a flattened container) the first of its
// replacements. A multi-target conversion can restructure arbitrarily much
// of the tree at once, so it just clears the selection instead.
async function convertSelectionToParagraph() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  try {
    const result = await window.api.convertToParagraph(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (topLevelIds.length === 1 && state.nodesById.has(topLevelIds[0])) {
      selectNode(topLevelIds[0]);
    } else {
      closeDetails();
    }
    setStatus(`Converted ${topLevelIds.length} tag${topLevelIds.length === 1 ? '' : 's'} to paragraph.`);
  } catch (err) {
    reportError('Could not convert to paragraph', err);
  }
}

// Backs the 'F' shortcut: converts each selected tag to a Figure, collapsing
// its whole subtree down to just its content/object-ref leaves (see
// convert_to_figure() in tag_worker.py for why - a Figure holds its content
// directly rather than through nested structure). Reselects on a single
// target the same way convertSelectionToParagraph() does. A multi-target
// conversion can restructure arbitrarily much of the tree at once, so it
// just clears the selection instead.
async function convertSelectionToFigure() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  try {
    const result = await window.api.convertToFigure(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (topLevelIds.length === 1 && state.nodesById.has(topLevelIds[0])) {
      selectNode(topLevelIds[0]);
    } else {
      closeDetails();
    }
    setStatus(`Converted ${topLevelIds.length} tag${topLevelIds.length === 1 ? '' : 's'} to figure.`);
  } catch (err) {
    reportError('Could not convert to figure', err);
  }
}

// Backs the 'L' shortcut: groups the whole selection into a newly created
// List (see make_list() in tag_worker.py) - every selected node becomes an
// LI, and the List lands where the first one (in document order) used to
// sit. That new List always ends up occupying the depth-first slot the
// first selected item's old id pointed to, so reselecting via that id shows
// the new List itself once the tree refreshes.
async function groupSelectionIntoList() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;

  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
  const orderedIds = rows.map((row) => row.dataset.nodeId).filter((id) => ids.includes(id));
  const firstId = orderedIds[0] ?? ids[0];

  try {
    const result = await window.api.makeList(state.docId, ids);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (state.nodesById.has(firstId)) selectNode(firstId);
    else closeDetails();
    setStatus(`Grouped ${ids.length} tag${ids.length === 1 ? '' : 's'} into a new list.`);
  } catch (err) {
    reportError('Could not create list', err);
  }
}

// Shared by the 'T' and 'R' shortcuts: both group the whole selection into
// a newly created container (Table/TR) the same way 'L' does for List, via
// `apiCall` - each selected node becomes a child of the new container,
// converted to TD unless it's already one of `preservedRoles`. See
// make_table()/make_tr() in tag_worker.py for the per-role conversion rule.
async function groupSelectionIntoContainer(apiCall, label) {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;

  const rows = Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
  const orderedIds = rows.map((row) => row.dataset.nodeId).filter((id) => ids.includes(id));
  const firstId = orderedIds[0] ?? ids[0];

  try {
    const result = await apiCall(state.docId, ids);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (state.nodesById.has(firstId)) selectNode(firstId);
    else closeDetails();
    setStatus(`Grouped ${ids.length} tag${ids.length === 1 ? '' : 's'} into a new ${label}.`);
  } catch (err) {
    reportError(`Could not create ${label}`, err);
  }
}

function groupSelectionIntoTable() {
  return groupSelectionIntoContainer(window.api.makeTable, 'table');
}

function groupSelectionIntoTr() {
  return groupSelectionIntoContainer(window.api.makeTr, 'table row');
}

// Changes the selected node's heading level by `direction` (+1/-1) if it's
// currently H1-H6, clamped to that range. Returns true if the tag is a
// heading at all (regardless of whether it was already at the clamp), so
// callers know to treat the key as handled either way. Only acts on a
// single selected tag - unlike Role, heading level isn't specified as a
// block operation, so applying it to just the active tag out of several
// selected would be a silent partial edit. When multiple tags are selected
// in the Headings filter, callers use shiftSelectedHeadingLevels() instead,
// which steps every selection independently.
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

// Steps every selected heading's level by `direction` independently (an H1
// and H3 both selected become H2 and H4), clamped to H1-H6, as one undo
// step. Used when Left/Right is pressed in the Headings filter with more
// than one tag selected.
async function shiftSelectedHeadingLevels(direction) {
  const selectedIds = Array.from(state.selectedNodeIds);
  try {
    const result = await window.api.shiftHeadingLevels(state.docId, selectedIds, direction);
    applyFreshTree(result.tree);
    applyUndoState(result);
    // Role-only changes don't touch the tree's structure, so ids survive.
    refreshDetailsForSelection();
    setStatus(`Changed heading level for ${selectedIds.length} tags.`);
  } catch (err) {
    reportError('Could not change heading levels', err);
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
  state.mcidGraphicsCache.clear();
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
    el.btnScopeTables.disabled = !opened.hasStructTree;
    el.btnSmartifact.disabled = !opened.hasStructTree;
    el.btnAddFigure.disabled = !opened.hasStructTree;
    el.btnWalk.disabled = !opened.hasStructTree;
    stopWalking();

    el.noStructBanner.hidden = !!opened.hasStructTree;
    state.docInfo = opened.docInfo || { title: null, author: null };
    applyFreshTree(opened.tree || null);
    state.selectedBookmarkId = null;
    applyFreshOutline(opened.outline || []);
    el.btnGenerateBookmarks.disabled = !opened.hasStructTree;
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

el.btnScopeTables.addEventListener('click', async () => {
  if (!state.docId) return;
  try {
    setStatus('Scoping tables…');
    const result = await window.api.scopeTables(state.docId);
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus(result.tablesScoped > 0 ? `Scoped ${result.tablesScoped} table${result.tablesScoped === 1 ? '' : 's'}.` : 'No tables matched a recognized header shape.');
  } catch (err) {
    reportError('Could not scope tables', err);
  }
});

el.btnSmartifact.addEventListener('click', async () => {
  if (!state.docId || !state.pdfDoc) return;
  document.body.classList.add('busy');
  try {
    setStatus('Scanning for full-page images…');
    const ids = await findFullPageImageLeafIds();
    if (ids.length === 0) {
      setStatus('No full-page image leaves found.');
      return;
    }
    const result = await window.api.deleteNodes(state.docId, ids);
    applyFreshTree(result.tree);
    applyUndoState(result);
    closeDetails();
    setStatus(`Artifacted ${ids.length} full-page image${ids.length === 1 ? '' : 's'}.`);
  } catch (err) {
    reportError('Could not smartify', err);
  } finally {
    document.body.classList.remove('busy');
  }
});

// --- Add Figure: drag a rectangle on the page preview to tag a figure the
// autotagger missed (backed by figure_from_rect() in tag_worker.py) ------
//
// A toggleable draw mode, mirroring Walk's state.walking/button-label
// pattern below. While active, dragging on the canvas shows a live
// rubber-band rectangle; releasing sends its PDF-space bounds to the
// backend, which decides for itself whether a distinct image XObject sits
// under it (tagged directly via /OBJR) or not (falls back to a /BBox-only
// Figure - see figure_from_rect's module comment in tag_worker.py for why).
// The new tag is selected and its Alt text field focused immediately, same
// as any other freshly created tag needs its Alt text filled in by hand.
// Stays active after each rectangle rather than a one-shot toggle, since
// tagging missed figures across a scanned document is usually a batch job.

function setFigureDrawActive(active) {
  state.figureDrawActive = active;
  el.btnAddFigure.classList.toggle('btn-figure-draw-active', active);
  el.btnAddFigure.textContent = active ? 'Cancel Add Figure' : 'Add Figure';
  el.canvas.classList.toggle('figure-draw-mode', active);
  if (!active) {
    state.figureDrawRect = null;
    el.drawOverlay.innerHTML = '';
  }
}

function canvasPointFromEvent(e) {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.canvas.width / rect.width),
    y: (e.clientY - rect.top) * (el.canvas.height / rect.height),
  };
}

function renderFigureDrawRect(viewportWidth, viewportHeight) {
  el.drawOverlay.innerHTML = '';
  if (!state.figureDrawRect) return;
  const { start, current } = state.figureDrawRect;
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  const box = document.createElement('div');
  box.className = 'draw-box';
  // Same percentage-of-viewport placement as renderHighlightRects(), so the
  // box stays aligned even though the canvas is scaled down by CSS.
  box.style.left = `${(100 * x / viewportWidth).toFixed(3)}%`;
  box.style.top = `${(100 * y / viewportHeight).toFixed(3)}%`;
  box.style.width = `${(100 * width / viewportWidth).toFixed(3)}%`;
  box.style.height = `${(100 * height / viewportHeight).toFixed(3)}%`;
  el.drawOverlay.appendChild(box);
}

// A drag shorter than this (in canvas pixels) is treated as an accidental
// click/jitter rather than a deliberate rectangle.
const MIN_FIGURE_DRAW_PX = 6;

el.canvas.addEventListener('mousedown', (e) => {
  if (!state.figureDrawActive || !state.pdfDoc) return;
  e.preventDefault(); // avoid native text/image drag-selection while dragging
  const p = canvasPointFromEvent(e);
  state.figureDrawRect = { start: p, current: p };
  syncHighlightLayerBounds();
});

// mousemove/mouseup listen on window rather than the canvas so a drag that
// briefly leaves the canvas bounds (fast mouse movement) still tracks and
// completes normally, matching typical rubber-band-select behavior.
window.addEventListener('mousemove', async (e) => {
  if (!state.figureDrawRect) return;
  state.figureDrawRect.current = canvasPointFromEvent(e);
  const { viewport } = await getPageTextContent(state.currentPage);
  renderFigureDrawRect(viewport.width, viewport.height);
});

window.addEventListener('mouseup', async () => {
  if (!state.figureDrawRect) return;
  const { start, current } = state.figureDrawRect;
  state.figureDrawRect = null;
  el.drawOverlay.innerHTML = '';

  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  if (width < MIN_FIGURE_DRAW_PX || height < MIN_FIGURE_DRAW_PX) return;

  try {
    const { viewport } = await getPageTextContent(state.currentPage);
    const [px0, py0] = viewport.convertToPdfPoint(start.x, start.y);
    const [px1, py1] = viewport.convertToPdfPoint(current.x, current.y);
    const rect = [Math.min(px0, px1), Math.min(py0, py1), Math.max(px0, px1), Math.max(py0, py1)];

    setStatus('Tagging figure…');
    const result = await window.api.figureFromRect(state.docId, state.currentPage - 1, rect);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (result.newNodeId && state.nodesById.has(result.newNodeId)) {
      selectNode(result.newNodeId);
      el.fieldAlt.focus();
    }
    setStatus(result.method === 'object'
      ? 'Tagged figure from its image object - add Alt text below.'
      : 'Tagged figure region (no separate image object under it, so it got a bounding box instead) - add Alt text below.');
  } catch (err) {
    reportError('Could not tag figure', err);
  }
});

el.btnAddFigure.addEventListener('click', () => {
  if (!state.docId) return;
  setFigureDrawActive(!state.figureDrawActive);
  if (state.figureDrawActive) setStatus('Drag a rectangle around the figure to tag it (Esc to cancel).');
});

// Escape exits draw mode without tagging anything - captured ahead of any
// other keydown handling, same as Walk's speed/stop listener below.
window.addEventListener('keydown', (e) => {
  if (!state.figureDrawActive || e.key !== 'Escape') return;
  e.preventDefault();
  setFigureDrawActive(false);
  setStatus('Add Figure cancelled.');
}, true);

// --- Walk: auto-advance the tag selection --------------------------------
//
// Steps state.selectedNodeId forward through whatever `.tree-row.selectable`
// rows are currently in the DOM (same document-order list arrow-key nav and
// drag reordering use), one tag at a time, at state.walkSpeed tags/second.
// Starts from the currently selected tag if there is one, else the first row.
// While walking, +/- adjust the speed (and persist it as the new default for
// next time - see saveWalkSpeed()); any other key stops the walk. Re-reads
// the row list and the current selection's position fresh on every tick
// rather than caching an index, so it stays correct even though
// selectNode() re-renders the tree (expanding ancestors, changing which rows
// exist) on every step.

function loadWalkSpeed() {
  try {
    const raw = Number(localStorage.getItem(WALK_SPEED_STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= WALK_SPEED_MIN && raw <= WALK_SPEED_MAX) return raw;
  } catch (err) {
    // localStorage unavailable (e.g. disabled storage) - fall through to default
  }
  return WALK_SPEED_DEFAULT;
}

function saveWalkSpeed(speed) {
  try {
    localStorage.setItem(WALK_SPEED_STORAGE_KEY, String(speed));
  } catch (err) {
    // ignore - speed just won't persist this session
  }
}

function getWalkRows() {
  return Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'));
}

function updateWalkButtonUI() {
  el.btnWalk.textContent = state.walking ? 'Stop Walk' : 'Walk';
  el.btnWalk.classList.toggle('btn-walk-active', state.walking);
}

function startWalking() {
  if (state.walking) return;
  const rows = getWalkRows();
  if (rows.length === 0) return;

  if (!state.selectedNodeId || !rows.some((r) => r.dataset.nodeId === state.selectedNodeId)) {
    selectNode(rows[0].dataset.nodeId);
  }

  state.walking = true;
  updateWalkButtonUI();
  setStatus(`Walking at ${state.walkSpeed}/sec…`);
  scheduleWalkTick();
}

function stopWalking() {
  if (!state.walking) return;
  state.walking = false;
  if (state.walkTimerId !== null) {
    clearTimeout(state.walkTimerId);
    state.walkTimerId = null;
  }
  updateWalkButtonUI();
}

function scheduleWalkTick() {
  if (state.walkTimerId !== null) clearTimeout(state.walkTimerId);
  state.walkTimerId = setTimeout(walkTick, 1000 / state.walkSpeed);
}

function walkTick() {
  if (!state.walking) return;
  const rows = getWalkRows();
  const currentIndex = rows.findIndex((r) => r.dataset.nodeId === state.selectedNodeId);
  const nextIndex = currentIndex + 1;
  if (currentIndex === -1 || nextIndex >= rows.length) {
    stopWalking();
    setStatus(currentIndex === -1 ? 'Walk stopped.' : 'Walk finished.');
    return;
  }
  selectNode(rows[nextIndex].dataset.nodeId);
  scheduleWalkTick();
}

function adjustWalkSpeed(direction) {
  const next = Math.min(WALK_SPEED_MAX, Math.max(WALK_SPEED_MIN, state.walkSpeed + direction * WALK_SPEED_STEP));
  if (next === state.walkSpeed) return;
  state.walkSpeed = next;
  saveWalkSpeed(next);
  setStatus(`Walk speed: ${next}/sec`);
  if (state.walking) scheduleWalkTick(); // apply the new rate starting from the next tick
}

el.btnWalk.addEventListener('click', () => {
  if (state.walking) {
    stopWalking();
    setStatus('Walk stopped.');
  } else {
    startWalking();
  }
});

// Captured ahead of every other keydown listener so that, while walking,
// +/- adjust speed and nothing else (arrow-key nav, delete, role shortcuts,
// etc.) fires - and any other key stops the walk instead.
window.addEventListener('keydown', (e) => {
  if (!state.walking) return;
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta'
    || e.key === 'CapsLock' || e.key === 'NumLock' || e.key === 'ScrollLock' || e.key === 'AltGraph') {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === '+' || e.key === '=') {
    adjustWalkSpeed(1);
  } else if (e.key === '-' || e.key === '_') {
    adjustWalkSpeed(-1);
  } else {
    stopWalking();
    setStatus('Walk stopped.');
  }
}, true);

el.tagFilter.addEventListener('change', () => {
  state.filter = el.tagFilter.value;
  renderTree();
  // Switching back to the full tree can leave the still-selected tag
  // scrolled out of view (it may have been far from the filtered rows
  // that were showing) - bring it back into sight without touching the
  // PDF page/highlight, which the filter change had no effect on.
  if (state.filter === 'all' && state.selectedNodeId) {
    const row = el.tagTree.querySelector(`[data-node-id="${state.selectedNodeId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }
});

setStatus('Ready.');
