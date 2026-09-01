#!/usr/bin/env node
// scripts/typecheck.js
//
// Runs both type-check projects and reports only problems in our own code.
//
//   jsconfig.json           main.js + preload.js  (CommonJS, Node globals)
//   renderer/jsconfig.json  renderer.js           (ES module, DOM globals)
//
// Nothing is compiled or emitted - this only reports. The app still runs the
// .js files directly.
//
// Why the filtering: renderer.js imports pdf.js by relative path
// (../node_modules/pdfjs-dist/build/pdf.mjs), which is exactly what lets the
// browser load it with no bundler - but it also means TypeScript pulls
// pdf.js's own source into the program and checks it, producing ~250 errors
// from inside a library we don't maintain. `skipLibCheck` doesn't help (it
// only skips .d.ts files), and neither `exclude` nor `paths` applies to a
// relative import, so filtering by path is the way to get a usable signal.
// Anything outside node_modules is still reported and still fails the run.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECTS = ['jsconfig.json', 'renderer/jsconfig.json'];

// Resolved from the package root rather than hardcoded, so it keeps working
// wherever npm actually put the package. Only package.json is reachable
// through the package's `exports` map, so the bin path is built from there.
const TSC = path.join(
  path.dirname(require.resolve('typescript/package.json')),
  'bin',
  'tsc',
);

/** A diagnostic line starts at column 0; its detail lines are indented. */
function isNewDiagnostic(line) {
  return line.length > 0 && !/^\s/.test(line);
}

/** True for a diagnostic pointing inside node_modules - library noise. */
function isLibraryNoise(line) {
  const filePath = line.split('(')[0];
  return filePath.split(/[\\/]/).includes('node_modules');
}

/**
 * Drops node_modules diagnostics along with their indented detail lines,
 * which would otherwise be orphaned under the wrong error.
 */
function filterDiagnostics(output) {
  const kept = [];
  let keepingCurrent = false;
  for (const line of output.split(/\r?\n/)) {
    if (isNewDiagnostic(line)) keepingCurrent = !isLibraryNoise(line);
    if (keepingCurrent && line.trim()) kept.push(line);
  }
  return kept;
}

// Counts everything worth failing the run for: type errors plus unexpected
// module cycles.
let ourErrors = 0;
let suppressed = 0;

for (const project of PROJECTS) {
  const result = spawnSync(process.execPath, [TSC, '-p', project, '--noEmit'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const kept = filterDiagnostics(output);

  const total = output.split(/\r?\n/).filter((l) => /error TS/.test(l)).length;
  const mine = kept.filter((l) => /error TS/.test(l)).length;
  suppressed += total - mine;
  ourErrors += mine;

  if (kept.length) {
    console.log(`\n${project}:`);
    console.log(kept.join('\n'));
  }
}

// --- module import cycles -------------------------------------------------
//
// The renderer is split into modules with exactly one deliberate cycle,
// tree-view <-> details, explained at the top of tree-view.js. That cycle is
// safe only because everything crossing it is a hoisted `function`
// declaration. A NEW cycle is very likely an accident and worth knowing
// about, so this reports any cycle that isn't the known one.

const ALLOWED_CYCLES = new Set(['details|tree-view']);

function moduleCycles() {
  const dir = path.resolve(__dirname, '..', 'renderer');
  const graph = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const deps = new Set(
      [...src.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => m[1]),
    );
    graph.set(file.replace(/\.js$/, ''), deps);
  }

  const found = new Set();
  const visit = (node, trail, seen) => {
    for (const next of graph.get(node) || []) {
      const at = trail.indexOf(next);
      if (at !== -1) {
        found.add([...new Set(trail.slice(at).concat(next))].sort().join('|'));
      } else if (!seen.has(next)) {
        seen.add(next);
        visit(next, trail.concat(next), seen);
      }
    }
  };
  for (const node of graph.keys()) visit(node, [node], new Set());
  return [...found];
}

const cycles = moduleCycles();
const unexpected = cycles.filter((c) => !ALLOWED_CYCLES.has(c));
if (unexpected.length) {
  console.log('\nUNEXPECTED IMPORT CYCLES:');
  for (const c of unexpected) console.log(`  ${c.split('|').join(' <-> ')}`);
  console.log('  (see the note at the top of renderer/tree-view.js)');
  ourErrors += unexpected.length;
}

console.log('');
if (ourErrors === 0) {
  console.log('No problems found.');
} else {
  console.log(`${ourErrors} problem${ourErrors === 1 ? '' : 's'} found.`);
}
if (suppressed > 0) {
  console.log(`(${suppressed} suppressed from node_modules - see the note in scripts/typecheck.js)`);
}

process.exit(ourErrors === 0 ? 0 : 1);
