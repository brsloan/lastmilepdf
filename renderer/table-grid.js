// table-grid.js
//
// Select Content -> Table: the grid the user draws over a dragged rectangle
// before it becomes a Table tag. With a rectangle selection pending, the
// Group into Table shortcut (T by default) makes the rectangle the table's
// outer boundary; column dividers, then row dividers, are placed by
// clicking; the cells that result can be merged and switched between header
// and data; Enter builds the tag (tag_rect_table() in tag_worker.py),
// cutting leaves at the cell edges the same way the plain rectangle cuts
// them at its own.
//
// Why the grid is drawn by hand rather than inferred from the text: rows
// by baseline and columns by whitespace go wrong on exactly the tables this
// tool is pointed at - a cell whose text wraps reads as two rows, a header
// spanning several columns hides the gap between them, and a divider a few
// points off files text under the wrong cell. That last one is the killer:
// the Table Editor can fix headers, scope and spans afterwards, but it
// cannot move content from one cell to another, so a wrong grid can only be
// undone, never corrected. So nothing here commits until the grid has been
// looked at, with the text each cell will receive outlined inside it. A
// later stage will seed the dividers from the geometry; the interaction
// stays the same, the user just starts from a guess instead of from nothing.
//
// Every position is in viewport space (pdf.js's page pixels, which is also
// the canvas's own pixel size - see renderCurrentPage() in viewer.js), the
// same space as the rectangle selection's box and hits, so a divider at x
// can be compared with a glyph at x with no conversion.

import { el } from './dom.js';
import { commitTableGrid } from './editing.js';
import { canvasPointFromEvent } from './figure-draw.js';
import { glyphsInRun, intersectionArea, renderRectSelectOverlay } from './rect-select.js';
import { setStatus } from './shell.js';
import { state } from './state.js';

// How close (in canvas pixels) a click has to land to an existing divider to
// pick it up rather than place a new one beside it.
export const LINE_HIT_PX = 6;
// A divider this close to the box's edge or to another divider is refused:
// it would make a cell too thin to hold a glyph, and is far more likely a
// double-click than an intention.
export const MIN_LINE_GAP_PX = 4;
// A mousedown that travels less than this before mouseup is a click, and a
// click on a divider removes it; travelling further is a drag that moves it.
const DRAG_THRESHOLD_PX = 3;

const PROMPTS = {
  columns: 'Columns: click inside the box to add a divider, click a divider to remove it, or drag one to move it. Enter for rows, Esc to drop the grid.',
  rows: 'Rows: click to add a divider, click one to remove it, or drag it. Enter to review the cells, Backspace to go back to columns.',
};

// --- geometry ------------------------------------------------------------

// The x positions of the grid's vertical edges, outer edges included: cell
// c spans xs[c] .. xs[c + 1].
function columnEdges(grid) {
  return [grid.box.x, ...grid.columns, grid.box.x + grid.box.width];
}

function rowEdges(grid) {
  return [grid.box.y, ...grid.rows, grid.box.y + grid.box.height];
}

export function cellRect(grid, cell) {
  const xs = columnEdges(grid);
  const ys = rowEdges(grid);
  return {
    x: xs[cell.col],
    y: ys[cell.row],
    width: xs[cell.col + cell.colSpan] - xs[cell.col],
    height: ys[cell.row + cell.rowSpan] - ys[cell.row],
  };
}

function rectContains(r, x, y) {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

// Whether `inner` sits within `outer`, give or take a hair: pdf.js run
// boxes and the grid's own edges are both fractional, and a run whose edge
// lands a tenth of a pixel outside its cell is not overhanging anything.
function rectWithin(inner, outer, slack = 0.5) {
  return inner.x >= outer.x - slack
    && inner.y >= outer.y - slack
    && inner.x + inner.width <= outer.x + outer.width + slack
    && inner.y + inner.height <= outer.y + outer.height + slack;
}

function cellIndexAt(grid, x, y) {
  return grid.cells.findIndex((cell) => rectContains(cellRect(grid, cell), x, y));
}

// --- dividers --------------------------------------------------------------

function activeLines(grid) {
  return grid.phase === 'columns' ? grid.columns : grid.rows;
}

// The coordinate a divider in the current phase is placed by.
function lineValueOf(grid, point) {
  return grid.phase === 'columns' ? point.x : point.y;
}

// The interval a divider may sit in: inside the box, clear of its edges.
function lineBounds(grid) {
  const lo = grid.phase === 'columns' ? grid.box.x : grid.box.y;
  const extent = grid.phase === 'columns' ? grid.box.width : grid.box.height;
  return { lo: lo + MIN_LINE_GAP_PX, hi: lo + extent - MIN_LINE_GAP_PX };
}

function lineIndexNear(lines, value) {
  let best = -1;
  let bestDistance = LINE_HIT_PX;
  lines.forEach((v, i) => {
    const distance = Math.abs(v - value);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

// Whether a divider can sit at `value` without crowding another (the one at
// `ignoreIndex` excepted - it's the divider being moved).
function lineFits(grid, value, ignoreIndex = -1) {
  const { lo, hi } = lineBounds(grid);
  if (value < lo || value > hi) return false;
  return activeLines(grid).every((v, i) => i === ignoreIndex || Math.abs(v - value) >= MIN_LINE_GAP_PX);
}

function sortLines(lines) {
  lines.sort((a, b) => a - b);
}

// --- cells ------------------------------------------------------------------

function buildCells(grid) {
  const cells = [];
  const rowCount = grid.rows.length + 1;
  const colCount = grid.columns.length + 1;
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      // The first row is the header row until told otherwise - almost every
      // table has one, and H in this phase corrects the ones that don't.
      cells.push({ row, col, rowSpan: 1, colSpan: 1, role: row === 0 ? 'TH' : 'TD' });
    }
  }
  return cells;
}

function sortCells(cells) {
  cells.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
}

function cellsIntersecting(cells, block) {
  const out = [];
  cells.forEach((cell, i) => {
    if (cell.row <= block.r1 && cell.row + cell.rowSpan - 1 >= block.r0
        && cell.col <= block.c1 && cell.col + cell.colSpan - 1 >= block.c0) {
      out.push(i);
    }
  });
  return out;
}

// The rectangular block of cells between two of them, grown until it holds
// every merged cell it touches in full - the same rule as the Table
// Editor's shift-click, but iterated, since a merged cell brought in at the
// edge can in turn touch another.
function blockBetween(grid, a, b) {
  const cells = grid.cells;
  const block = {
    r0: Math.min(cells[a].row, cells[b].row),
    r1: Math.max(cells[a].row + cells[a].rowSpan - 1, cells[b].row + cells[b].rowSpan - 1),
    c0: Math.min(cells[a].col, cells[b].col),
    c1: Math.max(cells[a].col + cells[a].colSpan - 1, cells[b].col + cells[b].colSpan - 1),
  };
  for (;;) {
    let grew = false;
    for (const i of cellsIntersecting(cells, block)) {
      const cell = cells[i];
      const r1 = cell.row + cell.rowSpan - 1;
      const c1 = cell.col + cell.colSpan - 1;
      if (cell.row < block.r0) { block.r0 = cell.row; grew = true; }
      if (r1 > block.r1) { block.r1 = r1; grew = true; }
      if (cell.col < block.c0) { block.c0 = cell.col; grew = true; }
      if (c1 > block.c1) { block.c1 = c1; grew = true; }
    }
    if (!grew) return block;
  }
}

function selectBlock(grid, a, b) {
  grid.selected = new Set(cellsIntersecting(grid.cells, blockBetween(grid, a, b)));
}

function blockOfSelection(grid) {
  const chosen = [...grid.selected].map((i) => grid.cells[i]);
  return {
    r0: Math.min(...chosen.map((c) => c.row)),
    r1: Math.max(...chosen.map((c) => c.row + c.rowSpan - 1)),
    c0: Math.min(...chosen.map((c) => c.col)),
    c1: Math.max(...chosen.map((c) => c.col + c.colSpan - 1)),
  };
}

function mergeSelection(grid) {
  if (grid.selected.size === 0) {
    setStatus('Select the cells to merge first - click one and drag, or Shift+click another.');
    return;
  }
  if (grid.selected.size === 1) {
    const index = [...grid.selected][0];
    const cell = grid.cells[index];
    if (cell.rowSpan === 1 && cell.colSpan === 1) {
      setStatus('Select a block of two or more cells to merge them - or a merged cell to split it back up.');
      return;
    }
    // M on a merged cell undoes the merge: back to its 1x1 cells, all
    // keeping its role, and all selected so H can still act on them.
    const pieces = [];
    for (let r = cell.row; r < cell.row + cell.rowSpan; r += 1) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c += 1) {
        pieces.push({ row: r, col: c, rowSpan: 1, colSpan: 1, role: cell.role });
      }
    }
    grid.cells.splice(index, 1, ...pieces);
    sortCells(grid.cells);
    grid.selected = new Set(pieces.map((p) => grid.cells.indexOf(p)));
    refreshContents(grid);
    setStatus(`Split back into ${pieces.length} cells.`);
    return;
  }

  const block = blockOfSelection(grid);
  const area = [...grid.selected].reduce((sum, i) => sum + grid.cells[i].rowSpan * grid.cells[i].colSpan, 0);
  const blockArea = (block.r1 - block.r0 + 1) * (block.c1 - block.c0 + 1);
  if (area !== blockArea) {
    setStatus('Only a rectangular block of cells can be merged.');
    return;
  }
  // The block's top-left cell lends the merged cell its role: a header
  // that spans several columns started as the leftmost of them.
  const topLeft = [...grid.selected].map((i) => grid.cells[i])
    .find((c) => c.row === block.r0 && c.col === block.c0);
  const merged = {
    row: block.r0, col: block.c0,
    rowSpan: block.r1 - block.r0 + 1, colSpan: block.c1 - block.c0 + 1,
    role: topLeft ? topLeft.role : 'TD',
  };
  grid.cells = grid.cells.filter((_, i) => !grid.selected.has(i));
  grid.cells.push(merged);
  sortCells(grid.cells);
  grid.selected = new Set([grid.cells.indexOf(merged)]);
  refreshContents(grid);
  setStatus(`Merged into one ${merged.rowSpan}×${merged.colSpan} cell.`);
}

function toggleHeaderRole(grid) {
  if (grid.selected.size === 0) {
    setStatus('Select the cells to change first.');
    return;
  }
  const chosen = [...grid.selected].map((i) => grid.cells[i]);
  const allHeaders = chosen.every((c) => c.role === 'TH');
  for (const cell of chosen) cell.role = allHeaders ? 'TD' : 'TH';
  setStatus(allHeaders
    ? `${chosen.length} cell${chosen.length === 1 ? '' : 's'} set to data (TD).`
    : `${chosen.length} cell${chosen.length === 1 ? '' : 's'} set to header (TH).`);
}

// --- what each cell receives ---------------------------------------------

// Assigns the selection's content to the grid's cells: for each leaf the
// rectangle covered, which runs of its text land in which cell, and what to
// outline where.
//
// A measurable leaf is divided glyph by glyph, each glyph going to the cell
// its midpoint falls in, and consecutive glyphs sharing a cell become one
// run to cut - so a table row painted as one run contributes one piece per
// cell, and a wrapped cell in a leaf painted line by line contributes
// several pieces to one cell. Whitespace follows the glyph before it rather
// than being placed by its own midpoint, so the space between two cells'
// words trails the first rather than leading the second.
//
// Deliberately ignores the hit's own `run` and `splittable`: those judged
// the leaf against the whole box, and asked whether the covered glyphs were
// one contiguous stretch. Per cell there is no such requirement - a leaf
// can be cut as many times as it has pieces.
//
// A leaf the engine couldn't measure has no glyphs to divide, so it goes
// whole to the cell most of it lies in and is outlined dashed wherever it
// reaches outside that cell - the same warning the plain rectangle gives.
export function cellContentsForGrid(grid, hits) {
  const rects = grid.cells.map((cell) => cellRect(grid, cell));
  const contents = new Map();
  const contentFor = (index) => {
    if (!contents.has(index)) contents.set(index, { selections: [], outlines: [], overhangs: [] });
    return contents.get(index);
  };
  const cellOfPoint = (x, y) => rects.findIndex((r) => rectContains(r, x, y));

  for (const hit of hits || []) {
    if (hit.glyphs && hit.glyphs.length > 0) {
      const pieces = [];
      let current = null;
      let offset = 0;
      let lastCell = -1;
      for (const glyph of hit.glyphs) {
        const start = offset;
        offset += glyph.text.length;
        if (glyph.text.length === 0) continue;
        const cellIndex = !glyph.text.trim() && lastCell !== -1
          ? lastCell
          : cellOfPoint(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
        if (cellIndex === -1) {
          // Outside the table altogether: the rectangle didn't cover it.
          if (current) pieces.push(current);
          current = null;
          lastCell = -1;
          continue;
        }
        if (current && current.cellIndex === cellIndex && current.endIndex === start) {
          current.endIndex = offset;
        } else {
          if (current) pieces.push(current);
          current = { cellIndex, startIndex: start, endIndex: offset };
        }
        lastCell = cellIndex;
      }
      if (current) pieces.push(current);

      const total = offset;
      for (const piece of pieces) {
        if (piece.endIndex <= piece.startIndex) continue;
        const content = contentFor(piece.cellIndex);
        content.selections.push({
          nodeId: hit.nodeId,
          startIndex: piece.startIndex,
          // "Runs to the end" stays null where it really does, so the worker
          // can skip decoding a leaf it doesn't need to cut.
          endIndex: piece.endIndex >= total ? null : piece.endIndex,
        });
        content.outlines.push(...glyphsInRun(hit.glyphs, piece));
      }
      continue;
    }

    let best = -1;
    let bestArea = 0;
    rects.forEach((cell, i) => {
      const area = hit.rects.reduce((sum, r) => sum + intersectionArea(r, cell), 0);
      if (area > bestArea) {
        best = i;
        bestArea = area;
      }
    });
    if (best === -1) continue;
    const content = contentFor(best);
    content.selections.push({ nodeId: hit.nodeId, startIndex: 0, endIndex: null });
    const inside = hit.rects.every((r) => rectWithin(r, rects[best]));
    (inside ? content.outlines : content.overhangs).push(...hit.rects);
  }
  return contents;
}

function refreshContents(grid) {
  grid.contents = cellContentsForGrid(grid, state.rectSelectHits || []);
}

// The worker's view of the grid: rows of the cells that *start* in each
// row, in column order, each with the runs it receives. A cell spanning
// down appears only in its first row - the TR it belongs to.
export function tableGridPayload(grid) {
  const rows = Array.from({ length: grid.rows.length + 1 }, () => []);
  grid.cells.forEach((cell, index) => {
    rows[cell.row].push({ cell, index });
  });
  return rows.map((entries) => entries
    .sort((a, b) => a.cell.col - b.cell.col)
    .map(({ cell, index }) => ({
      role: cell.role,
      colSpan: cell.colSpan,
      rowSpan: cell.rowSpan,
      selections: grid.contents?.get(index)?.selections || [],
    })));
}

// --- the overlay -------------------------------------------------------------

function place(element, r, width, height) {
  element.style.left = `${(100 * r.x / width).toFixed(3)}%`;
  element.style.top = `${(100 * r.y / height).toFixed(3)}%`;
  element.style.width = `${(100 * r.width / width).toFixed(3)}%`;
  element.style.height = `${(100 * r.height / height).toFixed(3)}%`;
}

function drawOutlines(rects, className, width, height) {
  for (const rect of rects) {
    const outline = document.createElement('div');
    outline.className = className;
    place(outline, rect, width, height);
    el.drawOverlay.appendChild(outline);
  }
}

function lineElement(grid, value, vertical, extraClass, width, height) {
  const line = document.createElement('div');
  line.className = `table-grid-line ${vertical ? 'table-grid-line-v' : 'table-grid-line-h'}${extraClass ? ` ${extraClass}` : ''}`;
  const r = vertical
    ? { x: value, y: grid.box.y, width: 0, height: grid.box.height }
    : { x: grid.box.x, y: value, width: grid.box.width, height: 0 };
  place(line, r, width, height);
  return line;
}

export function renderTableGridOverlay() {
  const grid = state.tableGrid;
  el.drawOverlay.innerHTML = '';
  if (!grid) return;
  const width = el.canvas.width;
  const height = el.canvas.height;

  const box = document.createElement('div');
  box.className = 'table-grid-box';
  place(box, grid.box, width, height);
  el.drawOverlay.appendChild(box);

  if (grid.phase === 'cells' && grid.cells) {
    grid.cells.forEach((cell, index) => {
      const r = cellRect(grid, cell);
      const cellEl = document.createElement('div');
      cellEl.className = 'table-grid-cell'
        + (cell.role === 'TH' ? ' table-grid-cell-th' : '')
        + (grid.selected.has(index) ? ' table-grid-cell-selected' : '');
      place(cellEl, r, width, height);
      const label = document.createElement('span');
      label.className = 'table-grid-cell-label';
      label.textContent = cell.role;
      cellEl.appendChild(label);
      el.drawOverlay.appendChild(cellEl);

      // The honest preview: what each cell will actually hold. Solid for
      // text cut to fit, dashed - and reaching past the cell - for a leaf
      // that couldn't be cut and comes along whole.
      const content = grid.contents?.get(index);
      if (!content) return;
      drawOutlines(content.outlines, 'select-box', width, height);
      drawOutlines(content.overhangs, 'select-box select-overhang', width, height);
    });
    return;
  }

  for (const x of grid.columns) el.drawOverlay.appendChild(lineElement(grid, x, true, '', width, height));
  for (const y of grid.rows) el.drawOverlay.appendChild(lineElement(grid, y, false, '', width, height));
  if (grid.hover !== null && !grid.drag) {
    el.drawOverlay.appendChild(lineElement(grid, grid.hover, grid.phase === 'columns', 'table-grid-line-hover', width, height));
  }
}

// --- the phases ---------------------------------------------------------------

export function startTableGrid(box) {
  state.tableGrid = {
    phase: 'columns',
    box,
    columns: [],
    rows: [],
    hover: null,
    drag: null,
    cells: null,
    selected: new Set(),
    anchor: null,
    contents: null,
  };
  renderTableGridOverlay();
  setStatus(PROMPTS.columns);
}

function cellsPrompt(grid) {
  const rowCount = grid.rows.length + 1;
  const colCount = grid.columns.length + 1;
  let overhanging = 0;
  for (const content of grid.contents?.values() || []) {
    if (content.overhangs.length > 0) overhanging += 1;
  }
  let prompt = `${rowCount}×${colCount} cells: click or drag to select, M merges the selection`
    + ' (or splits a merged cell), H switches header/data. Enter tags the table, Backspace goes back to rows.';
  if (overhanging > 0) {
    prompt += ` ${overhanging} cell${overhanging === 1 ? '' : 's'} will take text that can't be cut to fit (dashed).`;
  }
  return prompt;
}

function enterCellsPhase(grid) {
  grid.phase = 'cells';
  grid.hover = null;
  grid.drag = null;
  grid.cells = buildCells(grid);
  grid.selected = new Set();
  grid.anchor = null;
  refreshContents(grid);
  setStatus(cellsPrompt(grid));
}

async function advance(grid) {
  if (grid.phase === 'columns') {
    grid.phase = 'rows';
    grid.hover = null;
    grid.drag = null;
    renderTableGridOverlay();
    setStatus(PROMPTS.rows);
    return;
  }
  if (grid.phase === 'rows') {
    enterCellsPhase(grid);
    renderTableGridOverlay();
    return;
  }
  const payload = tableGridPayload(grid);
  if (!payload.some((row) => row.some((cell) => cell.selections.length > 0))) {
    setStatus('No text falls inside the grid - nothing to build a table from.');
    return;
  }
  await commitTableGrid(payload);
}

function back(grid) {
  if (grid.phase === 'rows') {
    grid.phase = 'columns';
    grid.hover = null;
    grid.drag = null;
    setStatus(PROMPTS.columns);
  } else if (grid.phase === 'cells') {
    grid.phase = 'rows';
    grid.cells = null;
    grid.contents = null;
    grid.selected = new Set();
    grid.anchor = null;
    grid.drag = null;
    setStatus(PROMPTS.rows);
  } else {
    setStatus('Already at the first step - Esc drops the grid.');
  }
  renderTableGridOverlay();
}

// Drops the grid but keeps the rectangle selection it was drawn over, so a
// change of mind still leaves the box ready for another tagging shortcut.
export function cancelTableGrid() {
  state.tableGrid = null;
  if (state.rectSelectBox && state.rectSelectHits) {
    renderRectSelectOverlay(state.rectSelectBox, state.rectSelectHits, el.canvas.width, el.canvas.height);
  } else {
    el.drawOverlay.innerHTML = '';
  }
  setStatus('Table grid dropped - the selection is still there; press a tagging shortcut, or Esc to clear it.');
}

// --- input ----------------------------------------------------------------------

// True when the key was the grid's to handle. Every plain letter is taken
// while a grid is up, even ones the grid has no use for: the tagging
// shortcuts fall through to the pending rectangle otherwise, and P pressed
// in the middle of laying out a table would tag the whole box as a
// paragraph.
export function handleTableGridKey(e) {
  const grid = state.tableGrid;
  if (!grid) return false;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;

  if (e.key === 'Enter') {
    advance(grid);
    return true;
  }
  if (e.key === 'Backspace') {
    back(grid);
    return true;
  }
  if (e.key === 'Escape') {
    cancelTableGrid();
    return true;
  }
  if (grid.phase === 'cells') {
    const key = e.key.toLowerCase();
    if (key === 'm') {
      mergeSelection(grid);
      renderTableGridOverlay();
      return true;
    }
    if (key === 'h') {
      toggleHeaderRole(grid);
      renderTableGridOverlay();
      return true;
    }
  }
  if (e.key.length === 1) {
    setStatus(grid.phase === 'cells'
      ? 'Finish the table first: Enter tags it, Esc drops the grid.'
      : 'Finish the grid first: Enter moves to the next step, Esc drops the grid.');
    return true;
  }
  return false;
}

export function handleTableGridMouseDown(e) {
  const grid = state.tableGrid;
  if (!grid) return;
  e.preventDefault();
  const point = canvasPointFromEvent(e);

  if (grid.phase === 'cells') {
    const index = cellIndexAt(grid, point.x, point.y);
    if (index === -1) return;
    if (e.shiftKey && grid.anchor !== null) {
      selectBlock(grid, grid.anchor, index);
    } else {
      grid.anchor = index;
      grid.selected = new Set([index]);
    }
    grid.drag = { kind: 'select', current: index };
    renderTableGridOverlay();
    return;
  }

  const lines = activeLines(grid);
  const value = lineValueOf(grid, point);
  const existing = lineIndexNear(lines, value);
  if (existing !== -1) {
    grid.drag = { kind: 'line', index: existing, origin: value, moved: false, fresh: false };
    return;
  }
  if (!lineFits(grid, value)) return;
  lines.push(value);
  sortLines(lines);
  // A freshly placed divider is immediately draggable, so a click that
  // lands a little off can be nudged without letting go - and mouseup
  // without moving must not then count as the click that removes it.
  grid.drag = { kind: 'line', index: lines.indexOf(value), origin: value, moved: false, fresh: true };
  grid.hover = null;
  renderTableGridOverlay();
}

export function handleTableGridMouseMove(e) {
  const grid = state.tableGrid;
  if (!grid) return;
  const point = canvasPointFromEvent(e);

  if (grid.phase === 'cells') {
    if (grid.drag?.kind === 'select' && grid.anchor !== null) {
      const index = cellIndexAt(grid, point.x, point.y);
      if (index !== -1 && index !== grid.drag.current) {
        grid.drag.current = index;
        selectBlock(grid, grid.anchor, index);
        renderTableGridOverlay();
      }
    }
    return;
  }

  const value = lineValueOf(grid, point);
  if (grid.drag?.kind === 'line') {
    if (!grid.drag.moved && Math.abs(value - grid.drag.origin) < DRAG_THRESHOLD_PX) return;
    grid.drag.moved = true;
    const lines = activeLines(grid);
    const { lo, hi } = lineBounds(grid);
    const clamped = Math.min(hi, Math.max(lo, value));
    if (!lineFits(grid, clamped, grid.drag.index)) return;
    lines[grid.drag.index] = clamped;
    renderTableGridOverlay();
    return;
  }

  const inside = rectContains(grid.box, point.x, point.y);
  const next = inside ? value : null;
  if (next !== grid.hover) {
    grid.hover = next;
    renderTableGridOverlay();
  }
}

export function handleTableGridMouseUp() {
  const grid = state.tableGrid;
  if (!grid || !grid.drag) return;
  const drag = grid.drag;
  grid.drag = null;
  if (drag.kind === 'line') {
    const lines = activeLines(grid);
    if (!drag.moved && !drag.fresh) {
      lines.splice(drag.index, 1);
    } else {
      // The divider may have been dragged past a neighbour's old position;
      // keep the array in order so cell indices stay left-to-right.
      sortLines(lines);
    }
  }
  renderTableGridOverlay();
}
