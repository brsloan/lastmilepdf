#!/usr/bin/env node
// scripts/table-seed-test.js
//
// Exercises renderer/table-seed.js - the geometry that guesses the Select
// Content table grid's dividers - against synthetic glyph layouts.
//
// The module imports nothing from the renderer, which is what lets plain
// node load it here: no Electron, no DOM, no PDF. Each fixture is a small
// table laid out from `row()` calls, with glyph boxes shaped the way the
// worker's glyph engine shapes them (one box per character, whitespace
// included), and the checks are about where the dividers land relative to
// the gaps the fixture actually has.
//
//   npm test

const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = path.resolve(__dirname, '..', 'renderer', 'table-seed.js');

// Every fixture glyph is this size: monospaced, so a word's width is its
// length times GLYPH_W, and the gaps are easy to reason about by hand.
const GLYPH_W = 6;
const GLYPH_H = 10;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

// Each divider within `slack` of the matching expected position, and the
// same number of them.
function assertNear(actual, expected, slack, message) {
  const shown = `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual.map((v) => Math.round(v * 10) / 10))}`;
  assertEqual(actual.length, expected.length, `${message}: wrong count${shown}`);
  expected.forEach((want, i) => {
    assert(Math.abs(actual[i] - want) <= slack, `${message}: divider ${i} is ${actual[i].toFixed(1)}, wanted ${want}±${slack}${shown}`);
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

// --- fixtures ------------------------------------------------------------------

// One line of text painted as one leaf, the way OCR paints a table row:
// `[[x, "text"], …]` places each phrase at x, one glyph box per character,
// and the phrases are joined by the spaces that would separate them so the
// leaf's glyph order is the reading order.
function row(y, phrases, nodeId = `leaf-${y}`) {
  const glyphs = [];
  phrases.forEach(([x, text], i) => {
    if (i > 0) {
      const prev = glyphs[glyphs.length - 1];
      glyphs.push({ seq: glyphs.length, text: ' ', x: prev.x + GLYPH_W, y, width: GLYPH_W, height: GLYPH_H, invisible: false });
    }
    for (let c = 0; c < text.length; c += 1) {
      glyphs.push({ seq: glyphs.length, text: text[c], x: x + c * GLYPH_W, y, width: GLYPH_W, height: GLYPH_H, invisible: false });
    }
  });
  const inked = glyphs.filter((g) => g.text.trim());
  const left = Math.min(...inked.map((g) => g.x));
  const right = Math.max(...inked.map((g) => g.x + g.width));
  return {
    nodeId,
    rects: [{ x: left, y, width: right - left, height: GLYPH_H }],
    coverage: 1, full: true, splittable: true, run: null, runText: null,
    glyphs,
  };
}

// The same row where the engine couldn't measure the font: no glyphs, one
// coarse rect per phrase.
function coarseRow(y, phrases, nodeId = `coarse-${y}`) {
  return {
    nodeId,
    rects: phrases.map(([x, text]) => ({ x, y, width: text.length * GLYPH_W, height: GLYPH_H })),
    coverage: 1, full: true, splittable: false, run: null, runText: null,
    glyphs: null,
  };
}

// Four columns at x = 0, 100, 200, 300; the box has a 10 px margin.
const COLS = [0, 100, 200, 300];
const BOX = { x: -10, y: -10, width: 400, height: 100 };
// Between "Alpha" (30 px wide, ends at 30) and the next column at 100 the
// gap centre is 65; "Beta" is four glyphs, so its gap centres on 162, and
// "Gamma" ends at 230 for 265.
const COLUMN_CENTRES = [65, 162, 265];

function plainRow(y, words = ['Alpha', 'Beta', 'Gamma', 'Delta']) {
  return row(y, COLS.map((x, i) => [x, words[i]]));
}

// --- tests -----------------------------------------------------------------------

async function main() {
  console.log('LastMilePDF table-seed test');
  const seed = await import(pathToFileURL(MODULE).href);

  await test('plain 4x3 table: a divider at every column and row gap', () => {
    // Rows at 0, 20, 40 with 10 px of space between: gap centres 15 and 35.
    const hits = [plainRow(0), plainRow(20), plainRow(40)];
    const grid = seed.seedGrid(hits, { ...BOX, height: 60 });
    assertEqual(grid.lineCount, 3, 'line count');
    assertNear(grid.columns, COLUMN_CENTRES, 2, 'columns');
    assertNear(grid.rows, [15, 35], 2, 'rows');
  });

  await test('a header spanning columns 2-4 does not hide the gaps under it', () => {
    const hits = [
      row(0, [[0, 'Name'], [100, 'Quarterly results for the region']]),
      plainRow(20), plainRow(40), plainRow(60),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 80 });
    assertNear(grid.columns, COLUMN_CENTRES, 2, 'columns');
    assertNear(grid.rows, [15, 35, 55], 2, 'rows');
  });

  await test('a wrapped cell at line pitch is not a row boundary', () => {
    // Row A wraps in column 2: its second line sits 2 px under the first,
    // while true rows are 18 and 10 px apart.
    const hits = [
      plainRow(0, ['Alpha', 'Beta', 'Gamma', 'Delta']),
      row(12, [[100, 'continued']]),
      plainRow(40),
      plainRow(60),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 80 });
    assertNear(grid.rows, [31, 55], 2, 'rows');
    assert(grid.rows.every((y) => Math.abs(y - 11) > 4), `a divider landed in the wrap: ${grid.rows}`);
    // "continued" runs past "Beta" to 154, so the second gap centres on 177.
    assertNear(grid.columns, [65, 177, 265], 2, 'columns');
  });

  await test('uniform spacing: every gap is a row, wrap or not', () => {
    const hits = [plainRow(0), plainRow(20), plainRow(40), plainRow(60)];
    const grid = seed.seedGrid(hits, { ...BOX, height: 80 });
    assertNear(grid.rows, [15, 35, 55], 2, 'rows');
  });

  await test('a sparse row adds no column divider and loses none', () => {
    const hits = [
      plainRow(0),
      row(20, [[100, 'Beta']]),
      plainRow(40),
      plainRow(60),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 80 });
    assertNear(grid.columns, COLUMN_CENTRES, 2, 'columns');
    assertNear(grid.rows, [15, 35, 55], 2, 'rows');
  });

  await test('wrapped continuation lines do not vote a column of short entries empty', () => {
    // The Joyce table: column 1 has short entries and one long one, and
    // the wrapped cells' continuation lines have text in one or two
    // columns only. The column 1 divider belongs after the long entry
    // ("Abcdefghijklmn" ends at 84), not in the space past the short ones.
    const hits = [
      plainRow(0),
      row(12, [[200, 'more'], [300, 'text']]),
      row(40, [[0, 'Abcdefghijklmn'], [100, 'Beta'], [200, 'Gamma'], [300, 'Delta']]),
      row(52, [[300, 'wrap']]),
      plainRow(80),
      row(92, [[200, 'again']]),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 120 });
    assertNear(grid.columns, [92, 162, 265], 2, 'columns');
  });

  await test('two long entries in a column keep the divider out of the column', () => {
    // With two lines running past the short entries, the stretch past
    // them is crossed twice and is no gap; the divider sits after both.
    const hits = [
      plainRow(0),
      row(20, [[0, 'Abcdefghijklmn'], [100, 'Beta'], [200, 'Gamma'], [300, 'Delta']]),
      row(40, [[0, 'Abcdefghijkl'], [100, 'Beta'], [200, 'Gamma'], [300, 'Delta']]),
      plainRow(60),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 80 });
    assertNear(grid.columns, [92, 162, 265], 2, 'columns');
  });

  await test('an unmeasurable leaf counts through its coarse rects', () => {
    const hits = [
      plainRow(0),
      coarseRow(20, COLS.map((x) => [x, 'Beta'])),
      plainRow(40),
    ];
    const grid = seed.seedGrid(hits, { ...BOX, height: 60 });
    assertEqual(grid.lineCount, 3, 'line count');
    assertNear(grid.rows, [15, 35], 2, 'rows');
    assertNear(grid.columns, COLUMN_CENTRES, 2, 'columns');

    // Coarse rects alone still make a grid.
    const coarseOnly = [0, 20, 40].map((y) => coarseRow(y, COLS.map((x) => [x, 'Beta'])));
    const grid2 = seed.seedGrid(coarseOnly, { ...BOX, height: 60 });
    assertNear(grid2.rows, [15, 35], 2, 'coarse-only rows');
    assertEqual(grid2.columns.length, 3, `coarse-only columns: ${grid2.columns}`);
  });

  await test('touching lines still divide, halfway between them', () => {
    // Rows overlap by 2 px (descenders into ascenders).
    const hits = [plainRow(0), plainRow(8), plainRow(16)];
    const grid = seed.seedGrid(hits, { ...BOX, height: 40 });
    assertNear(grid.rows, [9, 17], 1, 'rows');
  });

  await test('text outside the box is ignored', () => {
    const hits = [plainRow(0), plainRow(20), plainRow(40), plainRow(200)];
    const grid = seed.seedGrid(hits, { ...BOX, height: 60 });
    assertEqual(grid.lineCount, 3, 'line count');
    assertNear(grid.rows, [15, 35], 2, 'rows');
  });

  await test('empty selection and a single line seed nothing', () => {
    const empty = seed.seedGrid([], BOX);
    assertEqual(empty.columns.length, 0, 'empty columns');
    assertEqual(empty.rows.length, 0, 'empty rows');
    assertEqual(empty.lineCount, 0, 'empty line count');

    const one = seed.seedGrid([plainRow(0)], BOX);
    assertEqual(one.columns.length, 0, 'one-line columns');
    assertEqual(one.rows.length, 0, 'one-line rows');
    assertEqual(one.lineCount, 1, 'one-line line count');

    const none = seed.seedGrid(null, BOX);
    assertEqual(none.lineCount, 0, 'null hits');
  });

  await test('fitLines keeps dividers off the edges and apart', () => {
    const kept = seed.fitLines([2, 50, 52, 95, 120], 0, 100);
    assertNear(kept, [50, 95], 0, 'fitted');
  });

  await test('wordsInGrid splits at spaces and lines, in reading order', () => {
    const hits = [
      row(20, [[0, 'Second'], [100, 'row here']]),
      row(0, [[0, 'First'], [100, 'row']]),
    ];
    const words = seed.wordsInGrid(hits, { ...BOX, height: 40 });
    assertEqual(words.map((w) => w.text).join('|'), 'First|row|Second|row|here', 'texts');
    assertEqual(words.map((w) => w.id).join(','), 'w1,w2,w3,w4,w5', 'ids');
    assertEqual(words.map((w) => w.line).join(','), '0,0,1,1,1', 'lines');
    const here = words[4];
    assertEqual(here.x, 100 + 4 * GLYPH_W, 'x of "here"');
    assertEqual(here.width, 4 * GLYPH_W, 'width of "here"');
    assertEqual(here.nodeId, 'leaf-20', 'nodeId of "here"');
  });

  await test('wordsInGrid breaks a word at a jump with no space glyph', () => {
    const hit = row(0, [[0, 'ab']]);
    // Two more glyphs placed a column away, with no space between.
    hit.glyphs.push(
      { seq: 2, text: 'c', x: 100, y: 0, width: GLYPH_W, height: GLYPH_H, invisible: false },
      { seq: 3, text: 'd', x: 106, y: 0, width: GLYPH_W, height: GLYPH_H, invisible: false },
    );
    const words = seed.wordsInGrid([hit, plainRow(20)], { ...BOX, height: 40 });
    assertEqual(words.slice(0, 2).map((w) => w.text).join('|'), 'ab|cd', 'texts');
  });

  // --- gridFromProposal: the AI's reading turned into dividers ------------------

  // Three plain rows: words w1-w4 on row 0, w5-w8 on row 1, w9-w12 on row 2.
  const PROPOSAL_HITS = [plainRow(0), plainRow(20), plainRow(40)];
  const PROPOSAL_BOX = { ...BOX, height: 60 };
  const PROPOSAL_WORDS = seed.wordsInGrid(PROPOSAL_HITS, PROPOSAL_BOX);
  const PROPOSAL_SEED = seed.seedGrid(PROPOSAL_HITS, PROPOSAL_BOX);

  const cell = (text, words, extra = {}) => ({ text, words, colSpan: 1, rowSpan: 1, header: false, ...extra });
  // Row r of the plain fixture as the AI would return it: one cell per word.
  const plainProposalRow = (r, extra = {}) => ({
    cells: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((text, c) => cell(text, [`w${r * 4 + c + 1}`], extra)),
  });
  const cellAt = (result, row, col) => result.cells.find((c) => c.row === row && c.col === col);

  await test('a clean proposal puts the dividers at the gap centres and keeps the roles', () => {
    const proposal = { rows: [plainProposalRow(0, { header: true }), plainProposalRow(1), plainProposalRow(2)] };
    const result = seed.gridFromProposal(proposal, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!result.error, `unexpected error: ${result.error}`);
    assertNear(result.columns, COLUMN_CENTRES, 0.01, 'columns');
    assertNear(result.rows, [15, 35], 0.01, 'rows');
    assertEqual(result.cells.length, 12, 'cell count');
    assertEqual(cellAt(result, 0, 0).role, 'TH', 'header row role');
    assertEqual(cellAt(result, 1, 0).role, 'TD', 'data row role');
    assertEqual(result.conflicts, 0, 'conflicts');
    assertEqual(result.misfiled, 0, 'misfiled');
    assertEqual(result.rebuilt, false, 'rebuilt');
  });

  await test('a header spanning two columns is one cell, and the dividers come from the rows beneath', () => {
    const proposal = {
      rows: [
        { cells: [cell('Alpha', ['w1'], { header: true }), cell('Beta Gamma', ['w2', 'w3'], { header: true, colSpan: 2 }), cell('Delta', ['w4'], { header: true })] },
        plainProposalRow(1),
        plainProposalRow(2),
      ],
    };
    const result = seed.gridFromProposal(proposal, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!result.error, `unexpected error: ${result.error}`);
    assertNear(result.columns, COLUMN_CENTRES, 0.01, 'columns');
    assertEqual(result.cells.length, 11, 'cell count');
    const spanning = cellAt(result, 0, 1);
    assertEqual(spanning.colSpan, 2, 'colSpan');
    assertEqual(spanning.role, 'TH', 'role');
    assertEqual(cellAt(result, 0, 2), undefined, 'no cell under the span');
  });

  await test('a cell spanning two rows is one cell, and the row dividers come from the rest', () => {
    const proposal = {
      rows: [
        { cells: [cell('Alpha Alpha', ['w1', 'w5'], { rowSpan: 2 }), cell('Beta', ['w2']), cell('Gamma', ['w3']), cell('Delta', ['w4'])] },
        { cells: [cell('Beta', ['w6']), cell('Gamma', ['w7']), cell('Delta', ['w8'])] },
        plainProposalRow(2),
      ],
    };
    const result = seed.gridFromProposal(proposal, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!result.error, `unexpected error: ${result.error}`);
    assertNear(result.rows, [15, 35], 0.01, 'rows');
    assertEqual(result.cells.length, 11, 'cell count');
    assertEqual(cellAt(result, 0, 0).rowSpan, 2, 'rowSpan');
    assertEqual(cellAt(result, 1, 0), undefined, 'no cell under the span');
    assertEqual(cellAt(result, 1, 1).col, 1, 'the second row starts at column 1');
  });

  await test('a cell with no word ids but matching text is matched by its text', () => {
    const byText = { cells: ['alpha', 'BETA', 'Gamma ', ' delta'].map((text) => cell(text, [])) };
    const proposal = { rows: [plainProposalRow(0, { header: true }), byText, plainProposalRow(2)] };
    const result = seed.gridFromProposal(proposal, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!result.error, `unexpected error: ${result.error}`);
    assertEqual(result.matchedByText, 4, 'matched by text');
    assertNear(result.columns, COLUMN_CENTRES, 0.01, 'columns');
    assertNear(result.rows, [15, 35], 0.01, 'rows');
    assertEqual(result.misfiled, 0, 'misfiled');
  });

  await test('ragged, unknown, reused and overlong proposals are each refused by name', () => {
    const ragged = { rows: [plainProposalRow(0), plainProposalRow(1), { cells: [cell('Alpha', ['w9']), cell('Beta', ['w10']), cell('Gamma', ['w11'])] }] };
    const r1 = seed.gridFromProposal(ragged, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(r1.error && /Row 3 .* 3 columns wide but row 1 is 4/.test(r1.error), `ragged: ${r1.error}`);

    const unknown = { rows: [plainProposalRow(0), { cells: [cell('Alpha', ['w99']), cell('Beta', ['w6']), cell('Gamma', ['w7']), cell('Delta', ['w8'])] }, plainProposalRow(2)] };
    const r2 = seed.gridFromProposal(unknown, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(r2.error && r2.error.includes('w99'), `unknown: ${r2.error}`);

    const reused = { rows: [plainProposalRow(0), { cells: [cell('Alpha', ['w5']), cell('Beta', ['w2']), cell('Gamma', ['w7']), cell('Delta', ['w8'])] }, plainProposalRow(2)] };
    const r3 = seed.gridFromProposal(reused, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(r3.error && r3.error.includes('"Beta" (w2)'), `reused: ${r3.error}`);

    const overlong = { rows: [plainProposalRow(0), plainProposalRow(1), { cells: [cell('Alpha', ['w9'], { rowSpan: 2 }), cell('Beta', ['w10']), cell('Gamma', ['w11']), cell('Delta', ['w12'])] }] };
    const r4 = seed.gridFromProposal(overlong, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(r4.error && r4.error.includes('spans past the last row'), `overlong: ${r4.error}`);

    const empty = seed.gridFromProposal({ rows: [] }, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(empty.error, 'empty proposal should be refused');
    const junk = seed.gridFromProposal(null, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(junk.error, 'null proposal should be refused');
  });

  await test('cells whose words overlap still get a divider, and the conflict is counted', () => {
    // The AI files row 0's "Beta" (w2) under row 1's cell: the cell reaches
    // up into row 0, so the first row divider cuts through it.
    const proposal = {
      rows: [
        { cells: [cell('Alpha', ['w1']), cell('', []), cell('Gamma', ['w3']), cell('Delta', ['w4'])] },
        { cells: [cell('Alpha', ['w5']), cell('Beta Beta', ['w2', 'w6']), cell('Gamma', ['w7']), cell('Delta', ['w8'])] },
        plainProposalRow(2),
      ],
    };
    const result = seed.gridFromProposal(proposal, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!result.error, `unexpected error: ${result.error}`);
    assertEqual(result.conflicts, 1, 'conflicts');
    // Row 0's cells end at 10, the straddling cell starts at 0: overlap centre 5.
    assertNear(result.rows, [5, 35], 0.01, 'rows');
    assertEqual(result.misfiled, 1, 'w2 lands in row 0, not the cell the AI named');
    assertEqual(result.cells.length, 12, 'cell count');
  });

  await test('a boundary with no words on one side falls back to the seed, else to an even split', () => {
    // The AI leaves column 4 empty (Delta not part of the table).
    const rows = [0, 1, 2].map((r) => ({
      cells: [cell('Alpha', [`w${r * 4 + 1}`]), cell('Beta', [`w${r * 4 + 2}`]), cell('Gamma', [`w${r * 4 + 3}`]), cell('', [])],
    }));
    const seeded = seed.gridFromProposal({ rows }, PROPOSAL_WORDS, PROPOSAL_BOX, PROPOSAL_SEED);
    assert(!seeded.error, `unexpected error: ${seeded.error}`);
    assertNear(seeded.columns, COLUMN_CENTRES, 0.01, 'columns with a seed');

    const unseeded = seed.gridFromProposal({ rows }, PROPOSAL_WORDS, PROPOSAL_BOX, null);
    assert(!unseeded.error, `unexpected error: ${unseeded.error}`);
    // Boundary 3 of 4 columns across the 400 px box from x = -10: 290.
    assertNear(unseeded.columns, [65, 162, 290], 0.01, 'columns without a seed');
  });

  await test('dividers the crowding rule drops leave a plain grid, flagged as rebuilt', () => {
    // Column 2 is empty and the seed puts its two boundaries 3 px apart.
    const rows = [0, 1, 2].map((r) => ({
      cells: [cell('Alpha', [`w${r * 4 + 1}`]), cell('', []), cell('Beta', [`w${r * 4 + 2}`]), cell('Gamma Delta', [`w${r * 4 + 3}`, `w${r * 4 + 4}`])],
    }));
    const result = seed.gridFromProposal({ rows }, PROPOSAL_WORDS, PROPOSAL_BOX, { columns: [88, 91], rows: [] });
    assert(!result.error, `unexpected error: ${result.error}`);
    assertEqual(result.rebuilt, true, 'rebuilt');
    assertNear(result.columns, [88, 162], 0.01, 'surviving columns');
    assertEqual(result.cells.length, 9, 'plain 3x3 cells');
    assertEqual(cellAt(result, 0, 0).role, 'TH', 'top row as headers');
    assert(result.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1), 'no spans survive a rebuild');
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
