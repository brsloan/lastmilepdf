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
// Coverage is never measured against a leaf's overall bounding box: a
// paragraph wrapping over six lines has a union box spanning the whole
// column, so a rectangle over one line would score as barely covering it,
// and a rectangle over the column's whitespace would score as covering all
// of it. It's measured against the leaf's actual painted extent, at
// whichever of two resolutions is available:
//
//   - per character, from the worker's glyph-advance engine
//     (getPageCodeBoxes()), wherever the PDF's fonts can be measured
//   - per text run, from pdf.js (getPageLeafRects()), wherever they can't
//
// The finer of the two also decides whether a leaf is *splittable*: naming a
// cut point needs to know which character the rectangle's edge falls
// between, which needs the font's /ToUnicode. Selecting a leaf whole needs
// only a box, which pdf.js always has - so a leaf the engine refuses stays
// perfectly selectable, just indivisible.
//
// A leaf is still taken whole or not at all: acting on a cut point is Phase
// 3. So a partially covered leaf brings its overhang along, and the overlay
// draws that overhang dashed so it can't pass unnoticed - retagging a leaf
// that is 70% inside a heading's rectangle otherwise silently reads 30% of a
// body paragraph out as part of the heading.

import { el } from './dom.js';
import { state } from './state.js';
import { getPageCodeBoxes, getPageLeafRects, getPageTextContent } from './page-content.js';

// Below this share of its own painted area inside the rectangle, a leaf that
// must be taken WHOLE is left out entirely - half being the natural reading
// of "mostly inside", and forgiving of a drag that clips a descender or
// overshoots into the line below.
//
// It does not apply to a leaf that can be cut: there, any covered run is a
// valid selection however small a fraction of its leaf it happens to be.
// See hitsForRect().
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
  state.rectSelectPage = null;
  el.drawOverlay.innerHTML = '';
}

// A selection belongs to the page it was drawn on: its overlay is positioned
// in that page's viewport, and its leaf ids name that page's content. Called
// from renderCurrentPage(), which is the one place every page change funnels
// through - the page number is reached from the page buttons, the page-number
// field, a bookmark, and a tag selection that jumps pages, and hooking each
// of those separately is how a stale overlay keeps coming back.
export function discardRectSelectIfPageChanged() {
  if (state.rectSelectPage === null) return;
  if (state.rectSelectPage === state.currentPage) return;
  clearRectSelect();
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
export function hitsForRect(box, leafRects, leafIndex, pageGlyphs = null) {
  const hits = [];
  // Leaves the rectangle touched but didn't cover enough of. Counted rather
  // than discarded so the status line can tell "there's nothing there" apart
  // from "you clipped the edge of a paragraph" - which, with whole-leaf
  // selection and a half-coverage bar, is much the more likely mistake.
  let skipped = 0;
  for (const [mcid, rects] of leafRects) {
    const nodeId = leafIndex.get(mcid);
    if (!nodeId) continue; // painted content the struct tree doesn't claim

    // Per-character geometry where the worker could measure the font, per
    // text run where it couldn't. Both answer the same question; the glyph
    // boxes just answer it at the resolution a split would need, and are
    // what tells us the leaf is splittable at all.
    const glyphs = pageGlyphs?.byMcid.get(mcid);
    const measured = glyphs && glyphs.length > 0 ? glyphs : rects;
    const coverage = coverageOf(measured, box);
    if (coverage <= 0) continue;

    const full = coverage >= FULL_COVERAGE;
    const run = full || !glyphs ? null : coveredRun(glyphs, box);

    // The coverage bar only applies to a leaf that has to be taken whole.
    // It answers "is enough of this inside to be worth swallowing all of
    // it?" - a question that stops meaning anything once the leaf can be
    // cut, where what matters is simply which characters were covered.
    //
    // Applying it regardless made the tool feel imprecise in exactly the
    // way you'd notice: one real paragraph came to 46% of its leaf, so
    // dragging over it selected nothing until the drag reached into the
    // next paragraph and crossed 50% - at which point it grabbed both.
    if (!run && coverage < COVERAGE_THRESHOLD) {
      skipped += 1;
      continue;
    }
    hits.push({
      nodeId,
      rects,
      coverage,
      full,
      glyphs: glyphs || null,
      // The text the rectangle actually covers, where it can be known.
      // Tagging as a list item needs it, to tell a bare bullet apart from
      // ordinary body text the same way the tree's 'I' shortcut does.
      runText: glyphs ? textOfRun(glyphs, run) : null,
      // The run to keep, as character offsets into this leaf's own decoded
      // text. Null when there's nothing to cut (the leaf is fully covered)
      // or nothing we can cut by (its font wasn't measurable, or the
      // covered glyphs aren't contiguous - see coveredRun).
      run,
      // Whether the rectangle's edges can actually divide this leaf. A leaf
      // that can't is still perfectly selectable, just taken whole - which
      // is what the dashed overhang outline warns about.
      splittable: !!run,
    });
  }
  return { hits, skipped };
}

// Which characters of one leaf the rectangle covers, as {startIndex,
// endIndex} offsets into its decoded text - or null if the cover isn't a
// single unbroken run.
//
// Contiguity is the thing worth refusing on. Text runs in painting order, so
// a rectangle over the first two lines of a wrapped paragraph, or over a
// band through its middle, covers an unbroken stretch and cuts cleanly. A
// rectangle down a vertical slice of a multi-line leaf doesn't: it clips
// each line, and the covered glyphs come in several disconnected pieces with
// untouched text between them. There's no single pair of cuts that keeps
// those and only those, so rather than cut somewhere plausible-looking and
// quietly retag the gaps too, this declines and the leaf is taken whole with
// its overhang drawn.
export function coveredRun(glyphs, box) {
  let first = -1;
  let last = -1;
  let covered = 0;
  for (let i = 0; i < glyphs.length; i += 1) {
    const g = glyphs[i];
    const inside = g.x + g.width / 2 >= box.x
      && g.x + g.width / 2 <= box.x + box.width
      && g.y + g.height / 2 >= box.y
      && g.y + g.height / 2 <= box.y + box.height;
    if (!inside) continue;
    if (first === -1) first = i;
    last = i;
    covered += 1;
  }
  if (first === -1) return null;
  if (covered !== last - first + 1) return null; // gaps: not one run

  let startIndex = 0;
  for (let i = 0; i < first; i += 1) startIndex += glyphs[i].text.length;
  let endIndex = startIndex;
  for (let i = first; i <= last; i += 1) endIndex += glyphs[i].text.length;
  return { startIndex, endIndex };
}

// The character offset a rectangle edge at viewport x `edgeX` implies within
// one leaf: every glyph whose horizontal midpoint sits left of the edge is
// on the near side of the cut.
//
// Counts len(text) rather than 1 per glyph because a ligature decodes to
// more than one character, and split_leaf() indexes the decoded string.
// Nothing calls this yet - Phase 3 does, and it is here so the offset is
// computed from the same glyph boxes the overlay is already drawn from.
export function splitIndexAtX(glyphs, edgeX) {
  let index = 0;
  for (const glyph of glyphs) {
    if (glyph.x + glyph.width / 2 >= edgeX) break;
    index += glyph.text.length;
  }
  return index;
}

// The text a run covers, or the whole leaf's text when there's no run to
// narrow it to (a fully covered leaf).
function textOfRun(glyphs, run) {
  if (!run) return glyphs.map((g) => g.text).join('');
  let offset = 0;
  let out = '';
  for (const g of glyphs) {
    const start = offset;
    offset += g.text.length;
    if (start >= run.startIndex && start < run.endIndex) out += g.text;
  }
  return out;
}

// The glyph boxes a run covers, merged into one rect per line so the overlay
// draws a few boxes rather than one per character - which at a few thousand
// glyphs a page would be both slow and visually noisy.
function glyphsInRun(glyphs, run) {
  let offset = 0;
  const lines = new Map();
  for (const g of glyphs) {
    const start = offset;
    offset += g.text.length;
    if (start < run.startIndex || start >= run.endIndex) continue;
    const key = Math.round(g.y);
    const existing = lines.get(key);
    if (!existing) {
      lines.set(key, { x: g.x, y: g.y, width: g.width, height: g.height });
      continue;
    }
    const right = Math.max(existing.x + existing.width, g.x + g.width);
    const bottom = Math.max(existing.y + existing.height, g.y + g.height);
    existing.x = Math.min(existing.x, g.x);
    existing.y = Math.min(existing.y, g.y);
    existing.width = right - existing.x;
    existing.height = bottom - existing.y;
  }
  return Array.from(lines.values());
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
    // What gets outlined, and how, is the honest preview of what pressing a
    // tagging shortcut will do:
    //   - fully covered, or cuttable: solid, around just the text that ends
    //     up in the new tag (the covered glyphs, where there was a cut)
    //   - taken whole because it couldn't be cut: dashed, around the leaf's
    //     entire extent, so the part the user never dragged over is visible
    // One outline per run/glyph rather than one around the union: a wrapped
    // paragraph's union box covers the whitespace either side of every short
    // line and reads as selecting far more than it does.
    const outlined = hit.splittable && hit.glyphs
      ? glyphsInRun(hit.glyphs, hit.run)
      : hit.rects;
    for (const r of outlined) {
      const outline = document.createElement('div');
      outline.className = hit.full || hit.splittable
        ? 'select-box'
        : 'select-box select-overhang';
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
  const [leafRects, { viewport }, pageGlyphs] = await Promise.all([
    getPageLeafRects(state.currentPage),
    getPageTextContent(state.currentPage),
    getPageCodeBoxes(state.currentPage),
  ]);
  if (!state.rectSelectRect) return empty; // drag ended while we awaited
  if (!state.rectSelectIndex) {
    state.rectSelectIndex = buildLeafIndexForPage(state.currentPage - 1);
  }
  const result = hitsForRect(box, leafRects, state.rectSelectIndex, pageGlyphs);
  state.rectSelectHits = result.hits;
  state.rectSelectSkipped = result.skipped;
  renderRectSelectOverlay(box, result.hits, viewport.width, viewport.height);
  return result;
}
