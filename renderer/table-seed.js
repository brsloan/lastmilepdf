// table-seed.js
//
// Guesses the Select Content table grid's dividers from the geometry of the
// text under it - the starting point table-grid.js offers before the user
// corrects it by hand. Rows come from the gaps between lines of text,
// columns from vertical stretches of whitespace that most of those lines
// share. Nothing here commits anything: the guess is only where the
// dividers start, and every one of them can be clicked away, dragged, or
// re-guessed.
//
// Why the guess is a starting point and not the answer: the tables this
// tool is pointed at are OCR'd scans, where a cell whose text wraps reads
// as two rows, a header spanning several columns hides the gap between
// them, and a divider a few points off files text under the wrong cell -
// which the Table Editor can't fix afterwards. So the rules below are
// tuned to be cheap and predictable rather than clever, and the honest
// per-cell preview in the cells phase is where the guess gets checked.
//
// This module imports nothing from the renderer, so scripts/table-seed-test.js
// can load it under plain node. Every position is in viewport space, the
// same space as the rectangle selection's box and hits (see table-grid.js).

// A divider this close to the box's edge or to another divider is refused:
// it would make a cell too thin to hold a glyph, and is far more likely a
// double-click than an intention. table-grid.js re-exports it for the mouse.
export const MIN_LINE_GAP_PX = 4;

// Two consecutive line gaps whose heights differ by at least this ratio mark
// the jump between the pitch of a wrapped cell's lines and the space
// between true rows - see seedRows().
const ROW_GAP_JUMP_RATIO = 1.6;

// Glyphs closer than this many median glyph widths are one phrase; a
// stretch at least this wide that no phrase crosses is a column gap. The
// rules between two columns of a scanned table can sit tight enough that
// the gap is barely wider than a word space, so the two are the same.
const WORD_GAP_WIDTHS = 1.5;
const COLUMN_GAP_WIDTHS = 1.5;
// How many lines may run across a column gap without hiding it: a header
// spanning several columns, but not a second long entry.
const SPANNING_LINES = 1;

// --- helpers ---------------------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function midpointInBox(r, box) {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
}

// The baseline tolerance for grouping boxes into lines: OCR baselines
// wander more than born-digital ones, so it scales with the text rather
// than being the fixed pixel-and-a-half linesOfRun() in rect-select.js uses.
function lineTolerance(boxes) {
  return Math.max(1.5, 0.35 * median(boxes.map((b) => b.height)));
}

// The typical glyph width of the selection, from measured glyphs where
// there are any; a leaf given as coarse run boxes only has heights to go
// on, and a glyph is roughly half as wide as it is tall.
function medianGlyphWidth(boxes) {
  const glyphWidths = boxes.filter((b) => !b.coarse && b.width > 0).map((b) => b.width);
  if (glyphWidths.length > 0) return median(glyphWidths);
  return median(boxes.map((b) => b.height)) / 2;
}

// The same rule lineFits() in table-grid.js applies to a click: inside the
// box by MIN_LINE_GAP_PX at either end, and no two dividers closer than
// that. Values are taken in order, so of two that crowd each other the
// first survives.
export function fitLines(values, lo, extent) {
  const min = lo + MIN_LINE_GAP_PX;
  const max = lo + extent - MIN_LINE_GAP_PX;
  const kept = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    if (value < min || value > max) continue;
    if (kept.some((v) => Math.abs(v - value) < MIN_LINE_GAP_PX)) continue;
    kept.push(value);
  }
  return kept;
}

// --- boxes and lines ----------------------------------------------------------

// Every glyph whose midpoint lies in the box, as `{ x, y, width, height,
// text, nodeId, hit, index, coarse }`, where `hit` and `index` say which
// hit and which of its glyphs it came from. A leaf the engine couldn't
// measure (`glyphs` null) contributes its pdf.js run rects as coarse boxes
// instead, so it still votes for rows and columns. Whitespace glyphs carry
// no ink and are left out; wordsInGrid() looks at them separately.
export function boxesInGrid(hits, box) {
  const boxes = [];
  (hits || []).forEach((hit, hitIndex) => {
    if (hit.glyphs && hit.glyphs.length > 0) {
      hit.glyphs.forEach((glyph, index) => {
        if (!glyph.text.trim()) return;
        if (glyph.width <= 0 || glyph.height <= 0) return;
        if (!midpointInBox(glyph, box)) return;
        boxes.push({
          x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height,
          text: glyph.text, nodeId: hit.nodeId, hit: hitIndex, index, coarse: false,
        });
      });
      return;
    }
    (hit.rects || []).forEach((rect, index) => {
      if (rect.width <= 0 || rect.height <= 0) return;
      if (!midpointInBox(rect, box)) return;
      boxes.push({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        text: '', nodeId: hit.nodeId, hit: hitIndex, index, coarse: true,
      });
    });
  });
  return boxes;
}

// Groups boxes into lines of text across leaves: sorted by vertical
// midpoint, a box joins the line whose running mean midpoint is within
// the tolerance, else starts the next. Lines come back top to bottom as
// `{ top, bottom, mid, boxes }` with their boxes left to right, and each
// box is stamped with its line's index.
//
// The midpoint rather than the top or the baseline: a glyph box from the
// engine is the font's box, uniform along a line, but a coarse run rect or
// an OCR engine's tight box is not, and the midpoint moves least between a
// capital, an x-height letter and a descender.
export function clusterLines(boxes) {
  if (boxes.length === 0) return [];
  const tolerance = lineTolerance(boxes);
  const sorted = [...boxes].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
  const lines = [];
  let current = null;
  let sum = 0;
  for (const box of sorted) {
    const mid = box.y + box.height / 2;
    if (current && Math.abs(mid - sum / current.boxes.length) <= tolerance) {
      current.boxes.push(box);
      sum += mid;
      current.top = Math.min(current.top, box.y);
      current.bottom = Math.max(current.bottom, box.y + box.height);
    } else {
      current = { top: box.y, bottom: box.y + box.height, mid: 0, boxes: [box] };
      sum = mid;
      lines.push(current);
    }
    current.mid = sum / current.boxes.length;
  }
  lines.forEach((line, i) => {
    line.boxes.sort((a, b) => a.x - b.x);
    for (const box of line.boxes) box.line = i;
  });
  return lines;
}

// --- rows --------------------------------------------------------------------

// Row dividers from the gaps between consecutive lines. A divider goes at
// each gap's centre - or, where descenders overlap the next line's
// ascenders and the gap is negative, halfway between the two lines'
// midpoints, since touching lines are still two lines.
//
// The one refinement: a cell whose text wraps produces two lines at normal
// line pitch, while true row boundaries usually carry more space. So if
// the gap heights, sorted, jump by ROW_GAP_JUMP_RATIO somewhere, only the
// gaps at or above the jump become dividers. Gaps all alike means a plain
// unwrapped table, and every gap is a boundary. A wrapped cell in a table
// with uniform spacing still seeds a divider through the cell; that one is
// visible, and a click removes it.
export function seedRows(lines, box) {
  if (lines.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const above = lines[i - 1];
    const below = lines[i];
    const height = below.top - above.bottom;
    const at = height > 0 ? (above.bottom + below.top) / 2 : (above.mid + below.mid) / 2;
    gaps.push({ height, at });
  }

  // Gaps that touch or overlap can't be compared by ratio; they are all
  // "no space", and count as the smallest gap there is.
  const sorted = gaps.map((g) => Math.max(g.height, 0.5)).sort((a, b) => a - b);
  let threshold = -Infinity;
  let bestRatio = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const ratio = sorted[i] / sorted[i - 1];
    if (ratio > bestRatio) {
      bestRatio = ratio;
      threshold = sorted[i];
    }
  }
  const keep = bestRatio >= ROW_GAP_JUMP_RATIO
    ? gaps.filter((g) => Math.max(g.height, 0.5) >= threshold)
    : gaps;
  return fitLines(keep.map((g) => g.at), box.y, box.height);
}

// --- columns -------------------------------------------------------------------

// The x-intervals a line's boxes occupy, neighbours merged when the gap
// between them is a word space inside a phrase rather than a column gap.
function intervalsOfLine(line, wordGap) {
  const intervals = [];
  for (const box of line.boxes) {
    const last = intervals[intervals.length - 1];
    if (last && box.x - last.end <= wordGap) {
      last.end = Math.max(last.end, box.x + box.width);
    } else {
      intervals.push({ start: box.x, end: box.x + box.width });
    }
  }
  return intervals;
}

// Column dividers from the vertical stretches of white space that no line
// of text runs across. Each line's boxes are merged into the phrases they
// form, and a pixel column is crossed by however many phrases cover it; a
// stretch crossed by nothing, wide enough to be more than a word space,
// and not touching the box's own edge, is a column gap with the divider at
// its centre.
//
// Counted by crossings rather than by lines that leave the stretch empty,
// because the continuation lines of wrapped cells have text in only one
// or two columns and would otherwise vote "empty" across every other
// column - with enough of them, most of a column of short entries next to
// one long one reads as a gap, and the divider lands in the text.
//
// A header spanning several columns crosses the gaps under it, so one
// crossing phrase is tolerated: the stretch it lets through is bounded by
// the other lines, and the divider goes at the centre of the widest part
// that nothing crosses at all, if there is one wide enough, else at the
// centre of the whole stretch - the header being the only thing over it.
// Preferring the uncrossed part is what keeps a single long entry from
// dragging the divider under its own tail.
//
// Known miss: a two-word column ("John Smith") whose inner space happens
// to line up down the whole table seeds a divider through it. It is
// visible, and one click.
export function seedColumns(lines, box) {
  if (lines.length < 2) return [];
  const boxes = lines.flatMap((line) => line.boxes);
  const glyphWidth = medianGlyphWidth(boxes);
  if (!(glyphWidth > 0)) return [];
  const wordGap = WORD_GAP_WIDTHS * glyphWidth;
  const minGap = COLUMN_GAP_WIDTHS * glyphWidth;

  const width = Math.ceil(box.width);
  if (width <= 0) return [];
  const crossings = new Int32Array(width);
  for (const line of lines) {
    for (const { start, end } of intervalsOfLine(line, wordGap)) {
      // A pixel column counts as covered when its centre lies in the phrase.
      const from = Math.max(0, Math.ceil(start - box.x - 0.5));
      const to = Math.min(width - 1, Math.floor(end - box.x - 0.5));
      for (let x = from; x <= to; x += 1) crossings[x] += 1;
    }
  }

  // Maximal runs of pixel columns where `test` holds, as [start, end].
  const runsWhere = (test, from, to) => {
    const runs = [];
    let runStart = -1;
    for (let x = from; x <= to + 1; x += 1) {
      const holds = x <= to && test(crossings[x]);
      if (holds && runStart === -1) runStart = x;
      if (!holds && runStart !== -1) {
        runs.push([runStart, x - 1]);
        runStart = -1;
      }
    }
    return runs;
  };

  const dividers = [];
  for (const [runStart, runEnd] of runsWhere((n) => n <= SPANNING_LINES, 0, width - 1)) {
    if (runStart === 0 || runEnd === width - 1) continue;
    if (runEnd - runStart + 1 < minGap) continue;
    const clear = runsWhere((n) => n === 0, runStart, runEnd)
      .filter(([a, b]) => b - a + 1 >= minGap)
      .sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
    const [a, b] = clear || [runStart, runEnd];
    dividers.push(box.x + (a + b + 1) / 2);
  }
  return fitLines(dividers, box.x, box.width);
}

// --- words -----------------------------------------------------------------------

// The selection's text as words: consecutive measured glyphs of one leaf
// on one line, split at whitespace, at a glyph the box doesn't cover, and
// at a horizontal jump wider than a word space (an OCR layer that places
// words by offset rather than by space characters). In reading order, ids
// `w1`, `w2`, … - what a layout proposal names the words by.
export function wordsInGrid(hits, box) {
  const boxes = boxesInGrid(hits, box).filter((b) => !b.coarse);
  const lines = clusterLines(boxes);
  if (lines.length === 0) return [];
  const wordGap = WORD_GAP_WIDTHS * medianGlyphWidth(boxes);

  const words = [];
  let current = null;
  const close = () => {
    if (current) words.push(current);
    current = null;
  };
  for (const line of lines) {
    for (const glyph of line.boxes) {
      const joins = current
        && current.hit === glyph.hit
        && current.lastIndex === glyph.index - 1
        && glyph.x - (current.x + current.width) <= wordGap;
      if (joins) {
        current.text += glyph.text;
        const right = Math.max(current.x + current.width, glyph.x + glyph.width);
        const bottom = Math.max(current.y + current.height, glyph.y + glyph.height);
        current.x = Math.min(current.x, glyph.x);
        current.y = Math.min(current.y, glyph.y);
        current.width = right - current.x;
        current.height = bottom - current.y;
        current.lastIndex = glyph.index;
      } else {
        close();
        current = {
          text: glyph.text, x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height,
          line: glyph.line, nodeId: glyph.nodeId, hit: glyph.hit, lastIndex: glyph.index,
        };
      }
    }
    close();
  }
  words.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.x - b.x));
  return words.map((w, i) => ({
    id: `w${i + 1}`,
    text: w.text,
    x: w.x, y: w.y, width: w.width, height: w.height,
    line: w.line,
    nodeId: w.nodeId,
  }));
}

// --- the grid -------------------------------------------------------------------

// What table-grid.js starts a grid from: the guessed dividers, and how many
// lines of text they were guessed from (fewer than two, and there was
// nothing to guess from, so both lists are empty).
export function seedGrid(hits, box) {
  const boxes = boxesInGrid(hits, box);
  const lines = clusterLines(boxes);
  if (lines.length < 2) return { columns: [], rows: [], lineCount: lines.length };
  return {
    columns: seedColumns(lines, box),
    rows: seedRows(lines, box),
    lineCount: lines.length,
  };
}

// --- a proposal from the AI ---------------------------------------------------------

// "Try with AI" (see tryTableGridWithAi() in table-grid.js) sends the box's
// image and its words to the model and gets back the table as rows of
// cells, each naming the words it holds by id. What comes back is a
// reading of the picture, not a set of divider positions, and it is turned
// into a grid here: the dividers go halfway between the words of
// neighbouring cells, so the grid the user then sees is the model's
// reading made concrete - and where the reading contradicts the geometry
// (a "cell" whose words straddle the next column's), the contradiction is
// counted and shown rather than smoothed over. Nothing here commits; the
// result lands in the cells phase to be looked at like any other grid.

function normaliseText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function unionOf(boxes) {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function isSpan(value) {
  return Number.isInteger(value) && value >= 1;
}

// Lays the proposal's cells out the way an HTML table would: each row's
// cells take the first free columns left to right, and a cell spanning
// rows reserves its columns in the rows below. The same rule
// tag_rect_table() applies when it builds the tag, so a proposal that
// passes here builds. Returns `{ cells, rowCount, colCount }` with each
// cell placed, or `{ error }` naming what is wrong with it.
function placeProposalCells(proposal) {
  const rows = proposal?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return { error: 'The AI returned no rows.' };
  /** @type {Set<number>[]} */
  const taken = rows.map(() => new Set());
  const cells = [];
  let width = -1;
  for (let r = 0; r < rows.length; r += 1) {
    const entries = rows[r]?.cells;
    if (!Array.isArray(entries)) return { error: `Row ${r + 1} of the AI's table has no cells.` };
    let col = 0;
    for (const entry of entries) {
      const colSpan = entry?.colSpan ?? 1;
      const rowSpan = entry?.rowSpan ?? 1;
      if (!isSpan(colSpan) || !isSpan(rowSpan)) {
        return { error: `A cell in row ${r + 1} of the AI's table has an invalid span.` };
      }
      if (r + rowSpan > rows.length) {
        return { error: `A cell in row ${r + 1} of the AI's table spans past the last row.` };
      }
      while (taken[r].has(col)) col += 1;
      for (let i = 0; i < rowSpan; i += 1) {
        for (let c = col; c < col + colSpan; c += 1) {
          if (taken[r + i].has(c)) {
            return { error: `Two cells in the AI's table overlap at row ${r + i + 1}, column ${c + 1}.` };
          }
          taken[r + i].add(c);
        }
      }
      cells.push({
        row: r, col, rowSpan, colSpan,
        role: entry?.header === true ? 'TH' : 'TD',
        text: normaliseText(entry?.text),
        wordIds: Array.isArray(entry?.words) ? entry.words : [],
        words: [],
        box: null,
      });
      col += colSpan;
    }
    const rowWidth = taken[r].size === 0 ? 0 : Math.max(...taken[r]) + 1;
    if (taken[r].size !== rowWidth) {
      return { error: `Row ${r + 1} of the AI's table leaves a gap between its cells.` };
    }
    if (width === -1) width = rowWidth;
    if (rowWidth !== width) {
      return { error: `Row ${r + 1} of the AI's table is ${rowWidth} columns wide but row 1 is ${width} - every row has to add up to the same width.` };
    }
  }
  if (width === 0) return { error: 'The AI returned a table with no cells.' };
  return { cells, rowCount: rows.length, colCount: width };
}

// Gives each cell the words the proposal put in it. By id first, all cells
// before any text matching, so an id claimed outright is never taken by a
// looser match; then a cell with no valid ids but some text is matched
// against the still-unassigned words in reading order, whitespace and case
// aside. A cell that ends up with no words has no box and no vote.
function assignWords(cells, words) {
  const byId = new Map(words.map((w) => [w.id, w]));
  const assigned = new Map(); // word id -> cell
  for (const cell of cells) {
    for (const id of cell.wordIds) {
      const word = byId.get(id);
      if (!word) return { error: `The AI named a word that isn't in the selection (${String(id)}).` };
      if (assigned.has(id)) return { error: `The AI put the word "${word.text}" (${id}) in two cells.` };
      assigned.set(id, cell);
      cell.words.push(word);
    }
  }
  let matchedByText = 0;
  for (const cell of cells) {
    if (cell.words.length > 0 || !cell.text) continue;
    const tokens = cell.text.split(' ');
    for (let i = 0; i + tokens.length <= words.length; i += 1) {
      let fits = true;
      for (let j = 0; j < tokens.length; j += 1) {
        const word = words[i + j];
        if (assigned.has(word.id) || normaliseText(word.text) !== tokens[j]) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      for (let j = 0; j < tokens.length; j += 1) {
        assigned.set(words[i + j].id, cell);
        cell.words.push(words[i + j]);
      }
      matchedByText += 1;
      break;
    }
  }
  for (const cell of cells) cell.box = unionOf(cell.words);
  return { assigned, matchedByText };
}

// The dividers along one axis. For the boundary between grid lines b and
// b + 1, the cells ending at b vote with their far edges and the cells
// starting at b + 1 with their near edges (a spanning cell votes only at
// its own ends), and the divider goes halfway between the two sides. A
// side with no voters - an empty column, a column of empty cells - falls
// back to the nearest divider the geometry guessed that no boundary has
// claimed yet, else to an even split. Two sides that overlap (a cell on
// the left reaching past a cell on the right) still get a divider, at the
// centre of the overlap, and the overlap is counted as a conflict for the
// status line to report.
function dividersAlong(cells, count, seedLines, lo, extent, axis) {
  const start = axis === 'x' ? (c) => c.col : (c) => c.row;
  const span = axis === 'x' ? (c) => c.colSpan : (c) => c.rowSpan;
  const near = axis === 'x' ? (b) => b.x : (b) => b.y;
  const far = axis === 'x' ? (b) => b.x + b.width : (b) => b.y + b.height;
  const unusedSeeds = [...(seedLines || [])];
  const takeNearestSeed = (reference) => {
    if (unusedSeeds.length === 0) return null;
    let best = 0;
    unusedSeeds.forEach((v, i) => {
      if (Math.abs(v - reference) < Math.abs(unusedSeeds[best] - reference)) best = i;
    });
    return unusedSeeds.splice(best, 1)[0];
  };

  const dividers = [];
  let conflicts = 0;
  for (let b = 0; b < count - 1; b += 1) {
    const before = cells.filter((c) => c.box && start(c) + span(c) - 1 === b).map((c) => far(c.box));
    const after = cells.filter((c) => c.box && start(c) === b + 1).map((c) => near(c.box));
    const even = lo + extent * (b + 1) / count;
    if (before.length > 0 && after.length > 0) {
      const farEdge = Math.max(...before);
      const nearEdge = Math.min(...after);
      if (farEdge > nearEdge) conflicts += 1;
      dividers.push((farEdge + nearEdge) / 2);
      continue;
    }
    const reference = before.length > 0 ? Math.max(...before) : after.length > 0 ? Math.min(...after) : even;
    const seeded = takeNearestSeed(reference);
    dividers.push(seeded === null ? even : seeded);
  }
  return { dividers, conflicts };
}

function plainCells(rowCount, colCount) {
  const cells = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      cells.push({ row, col, rowSpan: 1, colSpan: 1, role: row === 0 ? 'TH' : 'TD' });
    }
  }
  return cells;
}

// Which of `cells` the point falls in, given the dividers - the same
// answer cellContentsForGrid() in table-grid.js gives for a glyph.
function cellIndexOfPoint(cells, columns, rows, x, y) {
  const col = columns.filter((v) => v < x).length;
  const row = rows.filter((v) => v < y).length;
  return cells.findIndex((c) => row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan);
}

/**
 * Turns the AI's table proposal into a grid for table-grid.js to show:
 * `{ columns, rows, cells, rowCount, colCount, conflicts, matchedByText,
 * misfiled, rebuilt }`, or `{ error }` when the proposal can't be used and
 * the grid should stay as it was. `words` is wordsInGrid()'s output for the
 * same box, whose ids the proposal names; `seed` is the geometry's guess
 * (seedGrid()), the fallback for a boundary no cell has words at.
 *
 * `conflicts` counts dividers that cut through words the AI put in one
 * cell, `misfiled` the words that end up in a different cell from the one
 * the AI named once the dividers are drawn - both signs the reading and
 * the geometry disagree, for the user to look at. `rebuilt` is set when
 * the crowding rule (fitLines) threw a divider out: the proposal's spans
 * and roles no longer line up with the dividers that are left, so the
 * cells come back plain, one per grid square with the top row as headers.
 */
export function gridFromProposal(proposal, words, box, seed) {
  const placed = placeProposalCells(proposal);
  if (placed.error) return { error: placed.error };
  const { cells, rowCount, colCount } = placed;
  const assignment = assignWords(cells, words || []);
  if (assignment.error) return { error: assignment.error };
  if (!cells.some((c) => c.box)) {
    return { error: "None of the AI's cells could be matched to the words in the selection." };
  }

  const cols = dividersAlong(cells, colCount, seed?.columns, box.x, box.width, 'x');
  const rws = dividersAlong(cells, rowCount, seed?.rows, box.y, box.height, 'y');
  const columns = fitLines(cols.dividers, box.x, box.width);
  const rows = fitLines(rws.dividers, box.y, box.height);
  const kept = (raw, fitted) => raw.length === fitted.length && raw.every((v, i) => v === fitted[i]);
  const rebuilt = !kept(cols.dividers, columns) || !kept(rws.dividers, rows);

  const outCells = rebuilt
    ? plainCells(rows.length + 1, columns.length + 1)
    : cells.map(({ row, col, rowSpan, colSpan, role }) => ({ row, col, rowSpan, colSpan, role }));

  let misfiled = 0;
  if (!rebuilt) {
    cells.forEach((cell, index) => {
      for (const word of cell.words) {
        const at = cellIndexOfPoint(outCells, columns, rows, word.x + word.width / 2, word.y + word.height / 2);
        if (at !== index) misfiled += 1;
      }
    });
  }

  return {
    columns,
    rows,
    cells: outCells,
    rowCount: rows.length + 1,
    colCount: columns.length + 1,
    conflicts: cols.conflicts + rws.conflicts,
    matchedByText: assignment.matchedByText,
    misfiled,
    rebuilt,
  };
}
