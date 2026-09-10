#!/usr/bin/env node
// scripts/contrast-check.js
//
// Checks renderer/styles.css against the contrast targets each of its two
// themes claims to meet.
//
// This exists because the claim is easy to make and easy to break. Both
// palettes were chosen by measuring, but a later "make this a bit dimmer"
// gets no pushback from the type checker or the smoke test, and a token
// missing from one theme block is invisible until someone switches to that
// theme and finds one theme's text on another theme's ground. Both are the
// sort of thing a person cannot eyeball reliably, so they are asserted here.
//
// What it checks, per theme:
//   * both theme blocks declare the same palette - no gaps, no extras
//   * every var(--x) used anywhere in the stylesheet actually resolves
//   * every foreground clears its target on every surface it can land on
//   * the on-page overlays clear 3:1 against the PDF page, not against chrome
//   * the translucent page washes do not dim the page's own glyphs
//   * the state tints (row selection, the AI review bar) stay distinguishable
//
// Targets: 4.5:1 text for dark (WCAG 2.1 AA, 1.4.3) and 7:1 for light (AAA),
// 3:1 for control boundaries and meaningful graphics (1.4.11). Nothing here
// is large-text: the base font is 13px.
//
//   npm test
//   node scripts/contrast-check.js

const fs = require('fs');
const path = require('path');

const CSS_PATH = path.resolve(__dirname, '..', 'renderer', 'styles.css');

// Comments are stripped first so the ratios quoted in them are never mistaken
// for declarations.
const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared in one rule block, as { '--name': 'value' }. */
function readBlock(selector) {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw new Error(`styles.css has no "${selector}" block`);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  // Every color token has to be a hex literal. A named color or a var()
  // indirection would otherwise sail through as NaN, and NaN compares false
  // against every threshold - failing for the wrong reason, or worse, being
  // read as a pass by a future refactor of this file.
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    throw new Error(`not a hex color, cannot measure contrast: ${JSON.stringify(hex)}`);
  }
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** `fg` at `alpha` composited over `bg` - what color-mix(..., transparent)
 *  actually puts on screen once the ground shows through. */
function composite(fg, alpha, bg) {
  const [f, b] = [fg.replace('#', ''), bg.replace('#', '')];
  const parts = [0, 2, 4].map((i) =>
    Math.round(alpha * parseInt(f.substr(i, 2), 16) + (1 - alpha) * parseInt(b.substr(i, 2), 16)));
  return '#' + parts.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const dark = readBlock(':root');
const light = readBlock(':root[data-theme="light"]');

// Light's target is 7 and not 4.5, which is deliberate rather than a typo.
// It began as the high-contrast option of two light themes; when the weaker
// one was dropped, the stronger one became the light theme outright.
const THEMES = [
  { name: 'dark', tokens: dark, text: 4.5 },
  { name: 'light', tokens: light, text: 7 },
];

// Declared once on purpose, because the surface behind them does not change
// with the theme. Everything else must appear in both blocks.
const INVARIANT = new Set([
  '--page-ground', '--surface-subtle', '--font-ui', '--font-mono', '--radius', '--na-text',
  '--overlay-primary', '--overlay-secondary', '--overlay-draw', '--overlay-warn',
  '--overlay-crosshair', '--overlay-halo',
  '--overlay-wash', '--overlay-wash-alt', '--overlay-wash-draw', '--overlay-wash-warn',
]);

// Every chrome surface a foreground can end up on. Checking each foreground
// against all of them rather than against its "intended" one is deliberate:
// the two defects found while building these themes were both a token landing
// on a surface nobody had thought about.
const GROUNDS = ['--bg', '--panel', '--panel-alt', '--panel-sunken'];
const FOREGROUNDS = [
  '--text', '--text-dim', '--text-faint', '--accent', '--accent-strong',
  '--cat-heading', '--cat-container', '--cat-list', '--cat-table', '--cat-figure',
  '--cat-inline', '--cat-leaf', '--warn-text', '--pass-text', '--fail-text',
  '--ai-highlight-text',
];

const failures = [];
const fail = (msg) => failures.push(msg);
const show = (label, value, need, note = '') => {
  const ok = value >= need;
  console.log(`    ${label.padEnd(24)}${value.toFixed(2).padStart(6)}  ${ok ? 'ok' : 'FAIL'}   ${note}`);
  return ok;
};
const require_ = (theme, label, value, need, note = '') => {
  if (!show(label, value, need, note)) {
    fail(`${theme}: ${label} is ${value.toFixed(2)}, needs ${need} (${note})`);
  }
};

// ---- 1. both blocks must describe the same palette ------------------------
console.log('theme blocks:');
const palette = Object.keys(dark).filter((k) => !INVARIANT.has(k));
for (const { name, tokens } of THEMES.slice(1)) {
  const missing = palette.filter((k) => !(k in tokens));
  const extra = Object.keys(tokens).filter((k) => !palette.includes(k));
  if (missing.length) fail(`${name} is missing: ${missing.join(', ')}`);
  if (extra.length) fail(`${name} declares tokens dark does not have: ${extra.join(', ')}`);
  console.log(missing.length || extra.length
    ? `  ${name}: MISMATCH`
    : `  ${name}: all ${palette.length} palette tokens present`);
}

// ---- 2. every var() reference must resolve --------------------------------
const declared = new Set([...Object.keys(dark), ...Object.keys(light)]);
const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
const undeclared = [...used].filter((u) => !declared.has(u));
if (undeclared.length) fail(`used but never declared: ${undeclared.join(', ')}`);
console.log(undeclared.length
  ? '  ** some var() references do not resolve'
  : `  all ${used.size} var() references resolve`);
const unused = [...declared].filter((d) => !used.has(d) && d !== '--na-text');
if (unused.length) console.log(`  note: declared but unused - ${unused.join(', ')}`);

// Stop here if the palette itself is malformed. Measuring contrast against a
// token that does not exist throws out of luminance(), which would bury the
// one useful message ("light is missing --cat-table") under a stack trace.
if (failures.length) {
  console.log(`\n${failures.length} problem(s) with the theme blocks:`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nFix these first - contrast cannot be measured until every theme');
  console.log('declares every token.');
  process.exit(1);
}

// ---- 3. per-theme contrast ------------------------------------------------
for (const { name, tokens: t, text: min } of THEMES) {
  console.log(`\n${name} (text needs ${min}:1):`);

  let worst = Infinity;
  let worstAt = '';
  for (const fg of FOREGROUNDS) {
    for (const ground of GROUNDS) {
      const v = ratio(t[fg], t[ground]);
      if (v < worst) { worst = v; worstAt = `${fg} on ${ground}`; }
      if (v < min) fail(`${name}: ${fg} on ${ground} is ${v.toFixed(2)}, needs ${min}`);
    }
  }
  show('worst foreground', worst, min, worstAt);

  require_(name, 'border-control', Math.min(...GROUNDS.map((g) => ratio(t['--border-control'], t[g]))),
    3, 'control boundaries, 1.4.11');
  require_(name, 'btn-ink on accent', ratio(t['--btn-ink'], t['--accent']), min);
  require_(name, 'warn-text on fill', ratio(t['--warn-text'], t['--warn-bg']), min);
  require_(name, 'ai mark ink on fill', ratio(t['--ai-highlight-ink'], t['--ai-highlight-bg']), min);

  // The trough the PDF page floats in has to stay distinct from the page, or
  // a white page on a white ground loses its edge entirely.
  require_(name, 'page edge', ratio(t['--canvas-ground'], dark['--page-ground']), 1.5,
    'trough vs the page');

  // State tints. Percentages of an accent over an unknown ground are exactly
  // what breaks quietly when the ground's polarity flips. Tree rows sit on
  // --bg: nothing between them sets a background.
  const multiSelected = composite(t['--accent'], 0.16, t['--bg']);
  require_(name, 'row hover fill', ratio(t['--panel-alt'], t['--bg']), 1.05, 'panel-alt vs --bg');
  require_(name, 'multi-select fill', ratio(multiSelected, t['--bg']), 1.15, 'accent 16% vs --bg');
  require_(name, 'text on multi-select', ratio(t['--text'], multiSelected), min);
  // Must differ from the panel by luminance and not by hue alone - the tint
  // IS the signal that AI rewrote this text, so 1.4.1 applies to it.
  require_(name, 'ai review tint', ratio(t['--ai-highlight-tint'], t['--panel-alt']), 1.10,
    'vs panel-alt');
  require_(name, 'text on review tint', ratio(t['--text'], t['--ai-highlight-tint']), min);

  // Reported, not enforced: --ai-highlight-border is squeezed between three
  // surfaces (the bright mark, the review tint, the panel outside it), so
  // lightening it to clear 3:1 against one pushes it under 3:1 against
  // another. It is a decorative container edge, which 1.4.11 exempts.
  const edge = Math.max(ratio(t['--ai-highlight-border'], t['--ai-highlight-tint']),
    ratio(t['--ai-highlight-border'], t['--panel-alt']));
  console.log(`    ${'review edge (info)'.padEnd(24)}${edge.toFixed(2).padStart(6)}         best of its two neighbours`);
}

// ---- 4. the on-page overlays ---------------------------------------------
// Measured against the PDF page, never against chrome - that mix-up is the
// bug this group was split out to fix. A dark figure is the other surface
// they cross, and the dark outlines lose there by design; --overlay-halo is
// what has to carry the edge when they do.
const PAGE = dark['--page-ground'];
const DARK_FIGURE = '#1a1a1a';
console.log(`\non-page overlays (3:1 against the page, ${PAGE}):`);
for (const token of ['--overlay-primary', '--overlay-secondary', '--overlay-draw',
  '--overlay-warn', '--overlay-crosshair']) {
  const v = ratio(dark[token], PAGE);
  if (v < 3) fail(`${token} is ${v.toFixed(2)} against the page, needs 3`);
  show(token, v, 3, `over a dark figure: ${ratio(dark[token], DARK_FIGURE).toFixed(2)}`);
}
const halo = ratio(dark['--overlay-halo'], DARK_FIGURE);
if (halo < 3) fail(`--overlay-halo is ${halo.toFixed(2)} over a dark figure, needs 3`);
show('--overlay-halo', halo, 3, 'vs a dark figure - the case the outlines lose');

console.log('\npage washes must not dim the page’s own glyphs:');
for (const [token, alpha] of [['--overlay-wash', 0.28], ['--overlay-wash-alt', 0.26],
  ['--overlay-wash-draw', 0.22], ['--overlay-wash-warn', 0.20]]) {
  const wash = composite(dark[token], alpha, PAGE);
  const v = ratio('#000000', wash);
  if (v < 4.5) fail(`${token} leaves black glyphs at ${v.toFixed(1)}, needs 4.5`);
  show(token, v, 4.5, `wash resolves to ${wash}`);
}

// ---- result --------------------------------------------------------------
if (failures.length) {
  console.log(`\n${failures.length} contrast problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nboth themes and the overlay group pass their targets.');
