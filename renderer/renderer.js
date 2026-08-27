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
  tree: null,           // current full tag tree, as returned by the worker
  nodesById: new Map(), // id -> node, rebuilt every time `tree` is replaced
  mcidIndex: new Map(), // page (0-based) -> Map(mcid -> owning element node id), rebuilt with nodesById
  selectedNodeId: null,
  draggedNodeId: null,
  pdfDoc: null,          // pdf.js document proxy
  currentPage: 1,
  pageCount: 0,
  textContentCache: new Map(), // page number -> { textContent, viewport }, reset per document
  mcidTextCache: new Map(),    // page number -> Map(mcid -> text), reset per document
  highlightToken: 0,           // invalidates in-flight highlight computations when selection/doc changes
  collapseOverrides: new Map(), // nodeId -> boolean, explicit user toggles (absence = use the role-based default)
};

// Must match the scale used for page.getViewport() in renderCurrentPage() -
// the highlight overlay is computed in that same viewport's pixel space.
const PAGE_SCALE = 1.4;

// --- DOM refs -----------------------------------------------------------

const el = {
  btnOpen: document.getElementById('btn-open'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnSave: document.getElementById('btn-save'),
  btnKillDivs: document.getElementById('btn-kill-divs'),
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
  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  ul.appendChild(renderTreeNode(state.tree));
  el.tagTree.appendChild(ul);
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
    if (node.id === state.selectedNodeId) row.classList.add('selected');
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

    row.addEventListener('click', () => selectNode(node.id));
    row.addEventListener('dragstart', (e) => {
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
    const draggedId = state.draggedNodeId;
    state.draggedNodeId = null;
    if (!draggedId || draggedId === targetNodeId) return;

    if (isDescendant(draggedId, targetNodeId)) {
      setStatus("Can't move a tag into its own descendant.");
      return;
    }

    try {
      // v1 drop semantics: dropping onto a node appends the dragged node as
      // its new last child. Precise above/below sibling positioning would
      // need a drop-position indicator; left as a follow-up.
      const targetEntry = state.nodesById.get(targetNodeId);
      const newIndex = targetEntry.node.children ? targetEntry.node.children.length : 0;
      const result = await window.api.reorderNode(state.docId, draggedId, targetNodeId, newIndex);
      applyFreshTree(result.tree);
      applyUndoState(result);
      setStatus('Moved tag.');
    } catch (err) {
      reportError('Could not move tag', err);
    }
  });
}

function applyFreshTree(tree) {
  state.tree = tree;
  state.nodesById = indexTree(tree);
  state.mcidIndex = tree ? buildMcidIndex(tree) : new Map();
  if (state.selectedNodeId && !state.nodesById.has(state.selectedNodeId)) {
    closeDetails();
  }
  renderTree();
}

// --- details panel --------------------------------------------------------

function expandAncestors(nodeId) {
  let entry = state.nodesById.get(nodeId);
  while (entry && entry.parentId !== null) {
    entry = state.nodesById.get(entry.parentId);
    if (entry && entry.node.type === 'element') state.collapseOverrides.set(entry.node.id, false);
  }
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  const entry = state.nodesById.get(nodeId);
  expandAncestors(nodeId);
  renderTree(); // re-render so the 'selected' class moves
  if (!entry || entry.node.type !== 'element') {
    closeDetails();
    return;
  }
  const node = entry.node;
  el.detailsEmpty.hidden = true;
  el.detailsForm.hidden = false;
  el.fieldNodeId.value = node.id;
  el.fieldRole.value = node.role || '';
  el.fieldAlt.value = node.alt || '';
  el.fieldActualText.value = node.actualText || '';
  el.fieldLang.value = node.lang || '';

  const row = el.tagTree.querySelector(`[data-node-id="${nodeId}"]`);
  row?.scrollIntoView({ block: 'nearest' });

  highlightNodeOnPage(nodeId, { allowPageJump: true });
}

function closeDetails() {
  state.selectedNodeId = null;
  el.detailsForm.hidden = true;
  el.detailsEmpty.hidden = false;
  el.detailsForm.reset();
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

  const changes = {
    role: el.fieldRole.value.trim(),
    alt: el.fieldAlt.value.trim(),
    actualText: el.fieldActualText.value.trim(),
    lang: el.fieldLang.value.trim(),
  };

  try {
    const result = await window.api.updateNode(state.docId, nodeId, changes);
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus('Updated tag.');
    // Keep the same node selected/visible after the tree re-renders.
    state.selectedNodeId = nodeId;
    selectNode(nodeId);
  } catch (err) {
    reportError('Could not update tag', err);
  }
});

el.btnCancelEdit.addEventListener('click', () => closeDetails());

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

el.btnOpen.addEventListener('click', async () => {
  try {
    setStatus('Opening\u2026');
    const opened = await window.api.openPdf();
    if (!opened) {
      setStatus('Ready.');
      return;
    }

    state.docId = opened.docId;
    state.fileName = opened.filePath.split(/[\\/]/).pop();
    el.fileName.textContent = state.fileName;
    el.btnSave.disabled = false;
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
});

el.btnSave.addEventListener('click', async () => {
  if (!state.docId) return;
  try {
    setStatus('Saving\u2026');
    const suggested = state.fileName ? state.fileName.replace(/\.pdf$/i, '-tagged.pdf') : 'tagged.pdf';
    const savedPath = await window.api.savePdf(state.docId, suggested);
    setStatus(savedPath ? `Saved to ${savedPath}` : 'Ready.');
  } catch (err) {
    reportError('Could not save PDF', err);
  }
});

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

setStatus('Ready.');
