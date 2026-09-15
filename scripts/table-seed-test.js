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

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
