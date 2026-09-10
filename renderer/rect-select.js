// rect-select.js
//
// The Select Content tool: drag a rectangle over the page preview to select
// the content leaves under it, then press a tagging shortcut to group them
// into one new tag (wrap_leaves() in tag_worker.py).
//
// Where Add Figures (figure-draw.js) turns a rectangle into a region - it
// never looks at what's underneath - this turns a rectangle into a *set of
// existing content leaves*. So the whole job here is answering "how much of
// each leaf did that rectangle actually cover?", and being honest in the
// overlay about the answer.
//
// Coverage is measured per text run, not against a leaf's overall bounding
// box (see getPageLeafRects() in page-content.js for why): a paragraph
// wrapping over six lines has a union box spanning the whole column, so a
// rectangle over one line would score as barely covering it, and a
// rectangle over the column's whitespace would score as covering all of it.
//
// A leaf is taken whole or not at all. Splitting one at the rectangle's
// edge needs to know which *character* the edge falls between, which needs
// the font's /ToUnicode - that's the glyph-advance engine, and it isn't
// built yet. Until it is, a partially covered leaf brings its overhang
// along, and the overlay draws that overhang dashed so it can't pass
// unnoticed: retagging a leaf that is 70% inside a heading's rectangle
// otherwise silently reads 30% of a body paragraph out as part of the
// heading.

import { el } from './dom.js';
import { state } from './state.js';
import { getPageLeafRects, getPageTextContent } from './page-content.js';

// Below this share of its own painted area inside the rectangle, a leaf is
// left out entirely. Half is the natural reading of "mostly inside", and
// makes the tool forgiving of a drag that clips a descender or overshoots
// into the line below.
export const COVERAGE_THRESHOLD = 0.5;

// At or above this, a leaf counts as fully covered: taken whole with no
// overhang to warn about. Not 1 exactly - a rectangle dragged along a line
// of text routinely leaves a fraction of a percent of some glyph box
// outside, and flagging that as an overhang would make the dashed outline
// meaningless through overuse.
const FULL_COVERAGE = 0.995;

// A drag shorter than this (in canvas pixels) is treated as an accidental
// click/jitter rather than a deliberate rectangle - matches
// MIN_FIGURE_DRAW_PX in figure-draw.js.
export const MIN_RECT_SELECT_PX = 6;

export function setRectSelectActive(active) {
  state.rectSelectActive = active;
  el.btnRectSelect.classList.toggle('btn-rect-select-active', active);
  el.btnRectSelect.textContent = active ? 'End Selecting' : 'Select Content';
  el.canvas.classList.toggle('rect-select-mode', active);
  if (!active) clearRectSelect();
}

// Drops the in-progress drag, the overlay and any selection still waiting
// for a role keystroke. Called when the tool is switched off, when Esc is
// pressed, and whenever the document or page changes underneath it.
export function clearRectSelect() {
  state.rectSelectRect = null;
  state.rectSelectHits = null;
  state.rectSelectSkipped = 0;
  state.rectSelectPending = null;
  state.rectSelectIndex = null;
  el.drawOverlay.innerHTML = '';
}

// mcid -> content-leaf node id for one page.
//
// Deliberately not state.mcidIndex, which maps an mcid to the *element*
// that owns it (that's what a click on the page needs, since clicking text
// should select its tag). wrap_leaves() needs the leaf ids themselves, so
// this walks for those instead. Built once per drag rather than per
// mousemove - a document with thousands of nodes would otherwise re-walk
// the whole tree on every pointer event.
export function buildLeafIndexForPage(pageIndex) {
  const index = new Map();
  if (!state.tree) return index;
  (function visit(node) {
    if ((node.type === 'content' || node.type === 'object-ref')
        && node.mcid !== null && node.mcid !== undefined
        && node.page === pageIndex) {
      index.set(node.mcid, node.id);
    }
    for (const child of node.children || []) visit(child);
  })(state.tree);
  return index;
}

function intersectionArea(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

// What share of `rects`' combined painted area falls inside `box`.
function coverageOf(rects, box) {
  let total = 0;
  let covered = 0;
  for (const r of rects) {
    const area = r.width * r.height;
    if (area <= 0) continue;
    total += area;
    covered += intersectionArea(r, box);
  }
  return total > 0 ? covered / total : 0;
}

// Turns a dragged rectangle (in viewport coordinates) into the leaves it
// selects. `leafIndex` comes from buildLeafIndexForPage(); `leafRects` from
// getPageLeafRects(). Returned in no particular order - wrap_leaves() sorts
// into document order itself, which is the only ordering that matters.
export function hitsForRect(box, leafRects, leafIndex) {
  const hits = [];
  // Leaves the rectangle touched but didn't cover enough of. Counted rather
  // than discarded so the status line can tell "there's nothing there" apart
  // from "you clipped the edge of a paragraph" - which, with whole-leaf
  // selection and a half-coverage bar, is much the more likely mistake.
  let skipped = 0;
  for (const [mcid, rects] of leafRects) {
    const nodeId = leafIndex.get(mcid);
    if (!nodeId) continue; // painted content the struct tree doesn't claim
    const coverage = coverageOf(rects, box);
    if (coverage <= 0) continue;
    if (coverage < COVERAGE_THRESHOLD) {
      skipped += 1;
      continue;
    }
    hits.push({ nodeId, rects, coverage, full: coverage >= FULL_COVERAGE });
  }
  return { hits, skipped };
}

export function normalizedDragBox(rect) {
  const { start, current } = rect;
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

// Draws the drag rectangle plus one outline per selected leaf: solid where
// the leaf is fully inside, dashed where it isn't. The dashed box is drawn
// around the leaf's *whole* extent, deliberately overflowing the drag
// rectangle - that overflow is the thing the user needs to see, since it's
// exactly the content they didn't drag over but will still be retagging.
export function renderRectSelectOverlay(box, hits, viewportWidth, viewportHeight) {
  el.drawOverlay.innerHTML = '';
  const pct = (v, of) => `${(100 * v / of).toFixed(3)}%`;

  if (box) {
    const drag = document.createElement('div');
    drag.className = 'draw-box';
    drag.style.left = pct(box.x, viewportWidth);
    drag.style.top = pct(box.y, viewportHeight);
    drag.style.width = pct(box.width, viewportWidth);
    drag.style.height = pct(box.height, viewportHeight);
    el.drawOverlay.appendChild(drag);
  }

  for (const hit of hits || []) {
    // One outline per run, not one around the union: a wrapped paragraph's
    // union box would cover the whitespace either side of every short line
    // and read as selecting far more than it does.
    for (const r of hit.rects) {
      const outline = document.createElement('div');
      outline.className = hit.full ? 'select-box' : 'select-box select-overhang';
      outline.style.left = pct(r.x, viewportWidth);
      outline.style.top = pct(r.y, viewportHeight);
      outline.style.width = pct(r.width, viewportWidth);
      outline.style.height = pct(r.height, viewportHeight);
      el.drawOverlay.appendChild(outline);
    }
  }
}

// Recomputes the selection for the current drag and repaints the overlay.
// Returns the hits so the caller can report a count without recomputing.
export async function refreshRectSelectPreview() {
  const empty = { hits: [], skipped: 0 };
  if (!state.rectSelectRect || !state.pdfDoc) return empty;
  const box = normalizedDragBox(state.rectSelectRect);
  const [leafRects, { viewport }] = await Promise.all([
    getPageLeafRects(state.currentPage),
    getPageTextContent(state.currentPage),
  ]);
  if (!state.rectSelectRect) return empty; // drag ended while we awaited
  if (!state.rectSelectIndex) {
    state.rectSelectIndex = buildLeafIndexForPage(state.currentPage - 1);
  }
  const result = hitsForRect(box, leafRects, state.rectSelectIndex);
  state.rectSelectHits = result.hits;
  state.rectSelectSkipped = result.skipped;
  renderRectSelectOverlay(box, result.hits, viewport.width, viewport.height);
  return result;
}
