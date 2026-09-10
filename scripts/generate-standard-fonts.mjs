// Generates python/standard_fonts_data.py from pdf.js's own tables.
//
// The standard 14 fonts are allowed to omit /Widths entirely: their metrics
// live in Adobe's AFM files, which a PDF viewer is expected to already have.
// pikepdf has none, so glyph_metrics.py could not place a single character of
// such a font and refused the leaf outright - even though split_leaf() could
// divide the same text happily, since decoding only needs /ToUnicode.
//
// Rather than transcribe the tables (14 fonts x ~300 glyphs, plus three
// 256-entry encoding vectors) this lifts them from pdfjs-dist, which already
// ships them and is already a dependency. Both source modules are plain data
// behind pdf.js's own tiny `getLookupTableFactory` helper, so they can simply
// be evaluated with a stub for it.
//
// Run after a pdfjs-dist upgrade; the output is checked in, so a normal build
// never needs this. Verified against known AFM values before writing.
//
//   node scripts/generate-standard-fonts.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs');
const outPath = path.join(root, 'python', 'standard_fonts_data.py');

const source = fs.readFileSync(worker, 'utf8');

// Slice one bundled module out of the worker bundle by its own path comment.
function moduleSource(name) {
  const start = source.indexOf(`./src/core/${name}.js`);
  if (start === -1) throw new Error(`could not find ${name}.js in the pdf.js bundle`);
  const end = source.indexOf(';// ./src/core/', start + 10);
  if (end === -1) throw new Error(`could not find the end of ${name}.js`);
  return source.slice(start + `./src/core/${name}.js`.length, end);
}

// pdf.js's own lazy-table helper: calls the populating function once against a
// fresh object. Reproduced here so the extracted source can just run.
const getLookupTableFactory = (populate) => {
  let table = null;
  return () => {
    if (table === null) {
      table = Object.create(null);
      populate(table);
    }
    return table;
  };
};

function evaluate(src, exported) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('getLookupTableFactory', `${src}\nreturn { ${exported.join(', ')} };`);
  return fn(getLookupTableFactory);
}

const metricsModule = evaluate(moduleSource('metrics'), ['getMetrics']);
const encodingsModule = evaluate(moduleSource('encodings'),
  ['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding', 'SymbolSetEncoding', 'ZapfDingbatsEncoding']);

const metrics = metricsModule.getMetrics();

// The 14 names the PDF spec names, exactly as they appear in a /BaseFont.
const STANDARD_14 = [
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats',
];

const widths = {};
for (const name of STANDARD_14) {
  const entry = metrics[name];
  if (entry === undefined) throw new Error(`pdf.js has no metrics for ${name}`);
  // The Courier faces are monospaced, so pdf.js stores one number for the
  // whole font rather than a per-glyph table.
  widths[name] = typeof entry === 'number' ? entry : entry();
}

// Spot-check widely-known AFM values, so a bad extraction (wrong module
// sliced out, factory left un-invoked) fails here rather than silently
// misplacing text later. Only values worth asserting are listed - a number
// nobody can check from memory would make this a tautology, not a test.
const expectations = [
  ['Helvetica', 'space', 278], ['Helvetica', 'W', 944],
  ['Times-Roman', 'space', 250], ['Times-Roman', 'W', 944],
  ['Times-Bold', 'period', 250], ['Helvetica-Bold', 'space', 278],
  ['Symbol', 'alpha', 631],
];
for (const [font, glyph, expected] of expectations) {
  const got = widths[font][glyph];
  if (got !== expected) {
    throw new Error(`AFM check failed: ${font}/${glyph} is ${got}, expected ${expected}`);
  }
}
if (widths.Courier !== 600) throw new Error('Courier should be a fixed 600');

// The two symbolic faces get a shape check instead: a real table, with the
// glyphs their own built-in encodings actually reference.
for (const font of ['Symbol', 'ZapfDingbats']) {
  const table = widths[font];
  if (typeof table !== 'object' || Object.keys(table).length < 100) {
    throw new Error(`${font} has no usable width table`);
  }
  if (typeof table.space !== 'number') throw new Error(`${font} is missing a space width`);
}

const encodings = {
  StandardEncoding: encodingsModule.StandardEncoding,
  WinAnsiEncoding: encodingsModule.WinAnsiEncoding,
  MacRomanEncoding: encodingsModule.MacRomanEncoding,
  SymbolSetEncoding: encodingsModule.SymbolSetEncoding,
  ZapfDingbatsEncoding: encodingsModule.ZapfDingbatsEncoding,
};
for (const [name, table] of Object.entries(encodings)) {
  if (!Array.isArray(table) || table.length !== 256) {
    throw new Error(`${name} is not a 256-entry vector`);
  }
}
if (encodings.WinAnsiEncoding[65] !== 'A') throw new Error('WinAnsiEncoding looks wrong');
if (encodings.StandardEncoding[39] !== 'quoteright') throw new Error('StandardEncoding looks wrong');

const py = (value, indent) => JSON.stringify(value, null, indent)
  .replace(/\bnull\b/g, 'None')
  .replace(/\btrue\b/g, 'True')
  .replace(/\bfalse\b/g, 'False');

const version = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'package.json'), 'utf8')).version;

const out = `"""
standard_fonts_data.py - GENERATED, do not edit by hand.

Adobe's AFM metrics for the 14 standard fonts, and the standard encoding
vectors that turn a character code into the glyph name those metrics are
keyed by. Extracted from pdfjs-dist ${version} by
scripts/generate-standard-fonts.mjs - run that again after a pdf.js upgrade.

A standard-14 font may legally carry no /Widths at all, because every viewer
is expected to have these already. Without them glyph_metrics.py cannot place
a single character of such a font; see standard_fonts.py for how they're used.

WIDTHS maps a /BaseFont name to either one number (the Courier faces are
monospaced) or a {glyph name: width} table, in 1/1000 em.

ENCODINGS maps an encoding name to a 256-entry list of glyph names, with ""
where that code is unused.
"""

WIDTHS = ${py(widths, 0)}

ENCODINGS = ${py(encodings, 0)}
`;

fs.writeFileSync(outPath, out, 'utf8');

const glyphCounts = Object.entries(widths)
  .map(([n, w]) => `${n}=${typeof w === 'number' ? 'fixed' : Object.keys(w).length}`)
  .join(' ');
console.log(`wrote ${path.relative(root, outPath)} from pdfjs-dist ${version}`);
console.log(`  widths:    ${glyphCounts}`);
console.log(`  encodings: ${Object.keys(encodings).join(', ')}`);
