// viewer.js
//
// The page preview pane: rendering PDF pages to the canvas with pdf.js, the
// page navigation controls, and the highlight overlay that shows where the
// selected tag's content sits on the page (plus the reverse lookup, turning
// a click on the page into the tag that owns it).
//
// Page rendering and highlighting are one module rather than two because
// they call each other: jumping to a tag on another page has to render that
// page, and rendering a page has to redraw the overlay on top of it. Split
// apart they would be a circular import; together they are one subsystem.

import { pdfjsLib } from './pdfjs.js';
import { el } from './dom.js';
import { collectTargetBBoxes, collectTargetMcids, getPageGraphicRects, getPageTextContent } from './page-content.js';
import { PAGE_SCALE, state } from './state.js';
import { base64ToUint8Array, categoryForRole, extractMcidFromItemId, pointInRect, unionRects } from './util.js';

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

export function computeHighlightRects(textContent, viewport, mcidSet) {
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

export async function findNodeAtPoint(x, y) {
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

export function syncHighlightLayerBounds() {
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
  for (const { rect: r, active, isFigure, role } of boxes) {
    const box = document.createElement('div');
    box.className = active ? 'highlight-box' : 'highlight-box secondary';
    // Percentages of the viewport's own pixel size so boxes stay aligned
    // even though the canvas is scaled down by CSS (max-width: 100%).
    const leftPct = 100 * r.x / viewport.width;
    const topPct = 100 * r.y / viewport.height;
    box.style.left = `${leftPct.toFixed(3)}%`;
    box.style.top = `${topPct.toFixed(3)}%`;
    box.style.width = `${(100 * r.width / viewport.width).toFixed(3)}%`;
    box.style.height = `${(100 * r.height / viewport.height).toFixed(3)}%`;
    el.highlightLayer.appendChild(box);
    if (active) activeBox = box;
    if (isFigure) for (const line of buildCrosshair(r, viewport)) el.highlightLayer.appendChild(line);
    // Only the actively-selected tag (not other members of a multi-selection)
    // gets role labels - one resting on top of the box, one hanging below it,
    // both left-aligned to the box, so the role reads clearly regardless of
    // which edge of the box is scrolled into view. Both reuse the tree
    // chip's category color so they read as "the same tag" at a glance (see
    // categoryForRole()).
    if (active && role && state.showTagTypeLabel) {
      const category = categoryForRole(role);
      const bottomEdgePct = 100 * (r.y + r.height) / viewport.height;

      const topLabel = document.createElement('div');
      topLabel.className = 'highlight-label above';
      topLabel.dataset.category = category;
      topLabel.textContent = `/${role}`;
      topLabel.style.left = `${leftPct.toFixed(3)}%`;
      topLabel.style.top = `${topPct.toFixed(3)}%`;
      el.highlightLayer.appendChild(topLabel);

      const bottomLabel = document.createElement('div');
      bottomLabel.className = 'highlight-label below';
      bottomLabel.dataset.category = category;
      bottomLabel.textContent = `/${role}`;
      bottomLabel.style.left = `${leftPct.toFixed(3)}%`;
      bottomLabel.style.top = `${bottomEdgePct.toFixed(3)}%`;
      el.highlightLayer.appendChild(bottomLabel);
    }
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

export function clearHighlight() {
  el.highlightLayer.innerHTML = '';
}

export async function highlightNodeOnPage(nodeId, { allowPageJump }) {
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
  // per-leaf-resolved content pages, so for page-selection purposes bbox
  // targets only apply as a fallback when mcid targets came up empty.
  const targetsByNode = new Map(selectedIds.map((id) => [id, collectTargetMcids(id)]));
  const bboxTargetsByNode = new Map(selectedIds.map((id) => [
    id, targetsByNode.get(id).length > 0 ? [] : collectTargetBBoxes(id),
  ]));
  // For drawing the box on whichever page we land on, though, a Figure's own
  // bbox is worth including even when it also has mcid content - e.g. a
  // Figure whose /Layout /BBox covers its whole drawn region but whose
  // content is just one text leaf dragged into it (or, for a Figure built
  // around a full-size image clipped down to a small visible slice, whose
  // content rect balloons out past the clip - see getPageMcidGraphicsInfo).
  // Unioning the bbox in (rather than swapping to it) only ever grows the
  // box toward the tag's real footprint, never shrinks a correct one, and
  // it's filtered to the current page below, so it can't fight the page
  // chosen above. Scoped to the 'figure' category (Figure/Formula) rather
  // than every element, so this doesn't resurrect the stale-Table-bbox risk
  // the comment above warns about.
  const renderBBoxTargetsByNode = new Map(selectedIds.map((id) => {
    const role = state.nodesById.get(id)?.node.role;
    return [id, categoryForRole(role) === 'figure' ? collectTargetBBoxes(id) : []];
  }));
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
      const bboxTargets = (renderBBoxTargetsByNode.get(id) || []).filter((t) => t.page + 1 === state.currentPage);
      for (const t of bboxTargets) rects.push(bboxRectInViewport(t.bbox, viewport));
      if (rects.length === 0) continue;
      const rect = unionRects(rects);
      const role = state.nodesById.get(id)?.node.role;
      if (rect) boxes.push({ rect, active: id === nodeId, isFigure: categoryForRole(role) === 'figure', role });
    }
    syncHighlightLayerBounds();
    renderHighlightRects(boxes, viewport);
  } catch (err) {
    console.error('Could not compute tag highlight:', err);
  }
}

// Shared by loadPdfPreview() (a brand new document - jumps to page 1) and
// refreshPdfPreviewBytes() (the same document, just-edited - stays on
// whatever page the user was looking at): swaps in a fresh pdf.js
// PDFDocumentProxy parsed from `base64Data` and drops every per-page cache
// derived from the old one (see page-content.js) - it's not just a stale
// value at that point, it's a cache keyed by page *number*, not by which
// document it came from, so pdf.js's own new Page objects would otherwise
// go unused in favor of an old page's already-cached (and now wrong)
// text/graphics.
async function swapPdfDocument(base64Data) {
  // Drop the outgoing document before adopting the new one: a render still
  // in flight would otherwise paint the old file's page onto the canvas
  // after the swap, and each PDFDocumentProxy left undestroyed keeps its
  // pdf.js worker-side document (and the file's bytes) alive for the rest
  // of the session.
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  state.renderToken++;
  if (state.pdfDoc) {
    const previous = state.pdfDoc;
    state.pdfDoc = null;
    previous.destroy().catch(() => {}); // best-effort; never block the new load
  }

  const bytes = base64ToUint8Array(base64Data);
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  state.pdfDoc = await loadingTask.promise;
  state.pageCount = state.pdfDoc.numPages;
  state.textContentCache.clear();
  state.mcidTextCache.clear();
  state.mcidGraphicsCache.clear();
}

export async function loadPdfPreview(base64Data) {
  await swapPdfDocument(base64Data);
  state.currentPage = 1;
  el.viewerPlaceholder.hidden = true;
  await renderCurrentPage();
  updatePageNavUI();
}

// Re-syncs the preview with the *same* document's latest bytes after an
// edit that rewrote a page's content stream (currently only split_leaf() -
// see its docstring in tag_worker.py) - unlike loadPdfPreview(), stays on
// the page the user was already looking at instead of jumping to page 1,
// since this is a mid-edit refresh, not opening a new file. Callers still
// need to re-run highlightNodeOnPage() themselves afterward for whatever's
// currently selected, same as they would after any other tree mutation.
export async function refreshPdfPreviewBytes(base64Data) {
  await swapPdfDocument(base64Data);
  state.currentPage = Math.min(state.currentPage, state.pageCount) || 1;
  await renderCurrentPage();
  updatePageNavUI();
}

// pdf.js refuses two concurrent render() calls against the same canvas - it
// tracks in-use canvases in a static set and throws outright - so every
// render has to be either finished or explicitly cancelled before the next
// one starts. Overlapping calls are routine here, not exotic: Walk schedules
// its next tick without awaiting the render the previous one kicked off (at
// up to 10 tags/sec), and holding down Next Page does the same. Two things
// are needed to serialize them, because there's an await in the middle:
//   - cancel any render already in flight (RenderTask.cancel() releases the
//     canvas synchronously, so the new render can claim it immediately), and
//   - a token, for the window between getPage() being awaited and render()
//     being called, where a second caller would otherwise sail past the
//     cancel check (there's no task to cancel yet) and collide anyway.
export async function renderCurrentPage() {
  if (!state.pdfDoc) return;

  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  const token = ++state.renderToken;

  const page = await state.pdfDoc.getPage(state.currentPage);
  if (token !== state.renderToken) return; // a newer render started while we waited

  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const context = el.canvas.getContext('2d');
  el.canvas.width = viewport.width;
  el.canvas.height = viewport.height;

  const task = page.render({ canvasContext: context, viewport });
  state.renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    // Being superseded is the expected outcome here, not a failure.
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (state.renderTask === task) state.renderTask = null;
  }
}

export function updatePageNavUI() {
  el.pageIndicatorInput.disabled = !state.pdfDoc;
  if (state.pdfDoc) {
    el.pageIndicatorTotal.textContent = `/ ${state.pageCount}`;
    if (document.activeElement !== el.pageIndicatorInput) {
      el.pageIndicatorInput.value = String(state.currentPage);
    }
  } else {
    el.pageIndicatorTotal.textContent = '\u2014';
    el.pageIndicatorInput.value = '';
  }
  el.btnPrevPage.disabled = !state.pdfDoc || state.currentPage <= 1;
  el.btnNextPage.disabled = !state.pdfDoc || state.currentPage >= state.pageCount;
}

export async function goToPageFromIndicatorInput() {
  if (!state.pdfDoc) return;
  const pageNumber = parseInt(el.pageIndicatorInput.value, 10);
  if (!Number.isFinite(pageNumber)) {
    updatePageNavUI();
    return;
  }
  const clamped = Math.min(Math.max(pageNumber, 1), state.pageCount);
  if (clamped !== state.currentPage) {
    state.currentPage = clamped;
    await renderCurrentPage();
    if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
  }
  updatePageNavUI();
}
