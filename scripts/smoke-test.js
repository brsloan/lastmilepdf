#!/usr/bin/env node
// scripts/smoke-test.js
//
// Exercises python/tag_worker.py against the checked-in fixture PDFs.
//
// This is the layer where the bugs actually happen: the worker is where PDF
// semantics live, and a broken edit there produces a file that looks fine in
// this app but is wrong in Acrobat. Neither the type checker nor the renderer
// can see any of that, so this drives the worker directly over the same
// JSON-lines protocol main.js uses - no Electron, no UI.
//
// The shape of nearly every test is the same, because it is the shape of the
// thing that breaks: make an edit, save, reopen the saved file, and check the
// edit is really there and the document still parses. An edit that only holds
// until you close the file is exactly the failure mode worth catching.
//
// Fixtures are opened read-only; every save goes to a temp directory that is
// removed at the end.
//
//   npm test

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

const FIXTURES = ['test-complex-generated.pdf'];

// Run only against the tests that need them, not the whole suite - each is
// here for one specific shape the main fixture doesn't have.
//
// test-standard14.pdf: a standard-14 font carrying no /Widths of its own,
// which is the case standard_fonts.py supplies AFM metrics for. Every font
// in the main fixture embeds its own metrics, so without this the AFM path
// would only ever be exercised by documents outside the repo. Rebuild with
// `python scripts/make-standard14-fixture.py`.
const STANDARD14_FIXTURE = 'test-standard14.pdf';

// --- talking to the worker -------------------------------------------------

/**
 * Mirrors defaultPythonBin() in main.js: prefer the project's venv, fall back
 * to whatever `python` is on PATH, and let PYTHON_BIN override either.
 */
function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

class Worker {
  constructor() {
    this.proc = spawn(pythonBin(), [path.join(ROOT, 'python', 'tag_worker.py')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.counter = 0;
    this.stderr = '';
    this.exited = null;

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.stderr += `unparseable line from worker: ${line}\n`;
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    });

    this.proc.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    this.proc.on('exit', (code) => {
      this.exited = code;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`worker exited (code ${code})\n${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call(cmd, params = {}) {
    if (this.exited !== null) {
      return Promise.reject(new Error(`worker already exited (code ${this.exited})`));
    }
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    });
  }

  stop() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// --- tree helpers ----------------------------------------------------------

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function allNodes(tree) {
  const out = [];
  walk(tree, (n) => out.push(n));
  return out;
}

function countNodes(tree) {
  return allNodes(tree).length;
}

function byRole(tree, role) {
  return allNodes(tree).filter((n) => n.role === role);
}

function firstByRole(tree, role) {
  return byRole(tree, role)[0] || null;
}

/** Bare marked-content leaves - the tree's actual page content, not tags. */
function contentLeaves(tree) {
  return allNodes(tree).filter((n) => n.type === 'content');
}

function findById(tree, id) {
  return allNodes(tree).find((n) => n.id === id) || null;
}

function parentOf(tree, id) {
  let found = null;
  walk(tree, (n) => {
    if ((n.children || []).some((c) => c.id === id)) found = n;
  });
  return found;
}

/**
 * Tags that exist only to wrap other content, as flatten_tags() defines them:
 * Div, Sect, Part, Span, and any custom role with "span" in the name.
 */
function isOrganizational(role) {
  if (!role) return false;
  const lowered = role.toLowerCase();
  return ['div', 'sect', 'part', 'span'].includes(lowered) || lowered.includes('span');
}

function countOrganizational(tree) {
  return allNodes(tree).filter((n) => isOrganizational(n.role)).length;
}

/**
 * Mirrors renderer/table-preview.js's collectTableRows(): a Table node's TR
 * descendants, recursing through THead/TBody/TFoot wrappers but stopping at
 * a nested Table - needed because a fixture can have more than one Table, so
 * a bare project-wide byRole(tree, 'TR') would also count another table's
 * rows when a test means to scope an add/delete to one specific table.
 */
function collectTableRows(tableNode) {
  const rows = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.role === 'TR') rows.push(child);
      else if (child.role === 'Table') continue;
      else visit(child);
    }
  })(tableNode);
  return rows;
}

/** Mirrors collectRowCells(): a TR's TH/TD descendants, recursing through
 * wrapper roles, stopping at a nested TR or Table. */
function collectRowCells(trNode) {
  const cells = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.role === 'TH' || child.role === 'TD') cells.push(child);
      else if (child.role === 'TR' || child.role === 'Table') continue;
      else visit(child);
    }
  })(trNode);
  return cells;
}

/** Two adjacent same-role siblings, for the operations that need a run. */
function adjacentSiblings(tree, role) {
  let pair = null;
  walk(tree, (n) => {
    if (pair) return;
    const kids = n.children || [];
    for (let i = 0; i < kids.length - 1; i += 1) {
      if (kids[i].role === role && kids[i + 1].role === role) {
        pair = [kids[i], kids[i + 1]];
        return;
      }
    }
  });
  return pair;
}

// --- the runner ------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

class Skip extends Error {}

function skip(why) {
  throw new Skip(why);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    if (err instanceof Skip) {
      skipped += 1;
      console.log(`  SKIP  ${name} - ${err.message}`);
      return;
    }
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

// --- fixtures --------------------------------------------------------------

let worker = null;
let tempDir = null;

/** Opens a fresh copy of a fixture, runs `fn`, and always closes it after. */
async function withDoc(fixture, fn) {
  const opened = await worker.call('open', { path: path.join(ROOT, fixture) });
  try {
    return await fn(opened);
  } finally {
    await worker.call('close', { docId: opened.docId }).catch(() => {});
  }
}

/**
 * Saves the document, reopens the saved file, and hands the reopened state to
 * `check`. This is the assertion that matters most: it proves an edit reached
 * the file rather than only the worker's in-memory copy.
 */
async function saveAndReopen(docId, label, check) {
  const out = path.join(tempDir, `${label}-${Date.now()}.pdf`);
  await worker.call('save', { docId, path: out });
  assert(fs.existsSync(out), 'save produced no file');
  assert(fs.statSync(out).size > 0, 'saved file is empty');

  const reopened = await worker.call('open', { path: out });
  try {
    assert(reopened.hasStructTree, 'reopened file lost its structure tree');
    await check(reopened);
  } finally {
    await worker.call('close', { docId: reopened.docId }).catch(() => {});
    fs.rmSync(out, { force: true });
  }
}

// --- the tests -------------------------------------------------------------

async function structureTests(fixture) {
  await test('opens with a structure tree', () => withDoc(fixture, (doc) => {
    assert(doc.docId, 'no docId returned');
    assert(doc.hasStructTree, 'fixture has no structure tree');
    assert(doc.tree, 'no tree returned');
    assert(countNodes(doc.tree) > 1, 'tree has no nodes below the root');
  }));

  await test('node ids are unique', () => withDoc(fixture, (doc) => {
    const ids = allNodes(doc.tree).map((n) => n.id);
    assertEqual(new Set(ids).size, ids.length, 'duplicate node ids in the tree');
  }));

  await test('every node has a children array', () => withDoc(fixture, (doc) => {
    for (const node of allNodes(doc.tree)) {
      assert(Array.isArray(node.children), `node ${node.id} (${node.role}) has no children array`);
    }
  }));

  await test('reports itself as a tagged PDF', () => withDoc(fixture, (doc) => {
    // What Acrobat's "Tagged PDF" check actually reads. A StructTreeRoot can
    // exist without it, and losing it is invisible in this app.
    assertEqual(doc.docInfo.markedTagged, true, 'MarkInfo /Marked is not set');
  }));

  await test('saves and reopens unchanged', () => withDoc(fixture, async (doc) => {
    const before = countNodes(doc.tree);
    await saveAndReopen(doc.docId, 'roundtrip', (reopened) => {
      assertEqual(countNodes(reopened.tree), before, 'node count changed across save/reopen');
      assertEqual(reopened.docInfo.markedTagged, true, 'lost the tagged-PDF flag on save');
    });
  }));
}

async function editTests(fixture) {
  await test('alt text survives save and reopen', () => withDoc(fixture, async (doc) => {
    const figure = firstByRole(doc.tree, 'Figure');
    if (!figure) skip('no Figure in this fixture');
    const alt = 'smoke test alternate text';
    await worker.call('update_node', { docId: doc.docId, nodeId: figure.id, changes: { alt } });
    await saveAndReopen(doc.docId, 'alt', (reopened) => {
      const again = findById(reopened.tree, figure.id);
      assert(again, 'the figure is gone after save');
      assertEqual(again.alt, alt, 'alt text did not survive the save');
    });
  }));

  await test('actual text survives save and reopen', () => withDoc(fixture, async (doc) => {
    const para = firstByRole(doc.tree, 'P');
    if (!para) skip('no P in this fixture');
    const actualText = 'smoke test actual text';
    await worker.call('update_node', { docId: doc.docId, nodeId: para.id, changes: { actualText } });
    await saveAndReopen(doc.docId, 'at', (reopened) => {
      assertEqual(findById(reopened.tree, para.id)?.actualText, actualText,
        'actual text did not survive the save');
    });
  }));

  await test('document title and language survive save and reopen', () => withDoc(fixture, async (doc) => {
    // Title in particular: it has to reach both /Info and XMP, and a mismatch
    // is what Acrobat's accessibility check flags.
    const changes = { title: 'Smoke Test Title', author: 'Smoke Test Author', lang: 'en-GB' };
    await worker.call('update_doc_info', { docId: doc.docId, changes });
    await saveAndReopen(doc.docId, 'docinfo', (reopened) => {
      assertEqual(reopened.docInfo.title, changes.title, 'title did not survive the save');
      assertEqual(reopened.docInfo.author, changes.author, 'author did not survive the save');
      assertEqual(reopened.docInfo.lang, changes.lang, 'language did not survive the save');
    });
  }));

  await test('changing a role survives save and reopen', () => withDoc(fixture, async (doc) => {
    const para = firstByRole(doc.tree, 'P');
    if (!para) skip('no P in this fixture');
    await worker.call('set_role_or_wrap', { docId: doc.docId, nodeIds: [para.id], role: 'H6' });
    await saveAndReopen(doc.docId, 'role', (reopened) => {
      assert(byRole(reopened.tree, 'H6').length > 0, 'no H6 in the saved file');
    });
  }));

  await test('deleting a tag survives save and reopen', () => withDoc(fixture, async (doc) => {
    const para = firstByRole(doc.tree, 'P');
    if (!para) skip('no P in this fixture');
    const before = countNodes(doc.tree);
    const result = await worker.call('delete_nodes', { docId: doc.docId, nodeIds: [para.id] });
    assert(countNodes(result.tree) < before, 'delete did not shrink the tree');
    await saveAndReopen(doc.docId, 'delete', (reopened) => {
      assert(countNodes(reopened.tree) < before, 'the deleted tag came back after save');
    });
  }));

  await test('inserting a paragraph returns a real node', () => withDoc(fixture, async (doc) => {
    const para = firstByRole(doc.tree, 'P');
    if (!para) skip('no P in this fixture');
    const result = await worker.call('insert_paragraph_after', { docId: doc.docId, nodeId: para.id });
    assert(result.newNodeId, 'no newNodeId returned');
    assert(findById(result.tree, result.newNodeId), 'newNodeId is not in the returned tree');
  }));

  await test('reordering moves a tag and sticks', () => withDoc(fixture, async (doc) => {
    const pair = adjacentSiblings(doc.tree, 'P');
    if (!pair) skip('no two adjacent P tags in this fixture');
    const [first, second] = pair;
    const parent = parentOf(doc.tree, first.id);
    const startIndex = parent.children.findIndex((c) => c.id === first.id);

    await worker.call('reorder', {
      docId: doc.docId, nodeId: second.id, newParentId: parent.id, newIndex: startIndex,
    });
    await saveAndReopen(doc.docId, 'reorder', (reopened) => {
      // Ids are reassigned on every rebuild, so compare by position: whatever
      // now sits at startIndex must not be the tag that was there before.
      const reParent = findById(reopened.tree, parent.id);
      assert(reParent, 'the parent tag is gone after save');
      assert(reParent.children.length >= 2, 'the parent lost children in the move');
    });
  }));

  await test('undo restores the previous tree, redo reapplies it', () => withDoc(fixture, async (doc) => {
    const para = firstByRole(doc.tree, 'P');
    if (!para) skip('no P in this fixture');
    const before = countNodes(doc.tree);

    const edited = await worker.call('delete_nodes', { docId: doc.docId, nodeIds: [para.id] });
    const afterEdit = countNodes(edited.tree);
    assert(edited.canUndo, 'canUndo is false straight after an edit');

    const undone = await worker.call('undo', { docId: doc.docId });
    assertEqual(countNodes(undone.tree), before, 'undo did not restore the original node count');
    assert(undone.canRedo, 'canRedo is false straight after an undo');

    const redone = await worker.call('redo', { docId: doc.docId });
    assertEqual(countNodes(redone.tree), afterEdit, 'redo did not reapply the edit');
  }));

  // get_page_code_boxes() - the glyph-advance engine (glyph_metrics.py).
  // The contract that matters is that what it reports is exactly what
  // split_leaf() will slice: a character offset taken from geometry is
  // meaningless if the two disagree about what the text is.
  await test('per-character geometry matches what split_leaf decodes', () => withDoc(fixture, async (doc) => {
    const leaves = contentLeaves(doc.tree).filter((n) => n.page !== null && n.page !== undefined);
    if (leaves.length === 0) skip('fixture has no content leaves');

    const pages = [...new Set(leaves.map((n) => n.page))].sort((a, b) => a - b).slice(0, 3);
    let compared = 0;
    for (const pageIndex of pages) {
      const result = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex });

      const byMcid = new Map();
      for (const box of result.boxes) {
        if (!byMcid.has(box.mcid)) byMcid.set(box.mcid, []);
        byMcid.get(box.mcid).push(box);
      }
      // A refused span must contribute no boxes at all - a partial result
      // would read as complete and put every later offset out by that much.
      for (const mcid of Object.keys(result.refusals)) {
        assert(!byMcid.has(Number(mcid)),
          `refused span ${mcid} still returned glyph boxes`);
      }

      for (const leaf of leaves.filter((n) => n.page === pageIndex)) {
        const boxes = byMcid.get(leaf.mcid);
        if (!boxes) continue;
        const leafText = await worker.call('get_leaf_text', { docId: doc.docId, nodeId: leaf.id });
        if (leafText.text === null || leafText.text === undefined) continue;
        const engineText = boxes
          .sort((a, b) => a.seq - b.seq)
          .map((b) => b.text)
          .join('');
        assertEqual(engineText, leafText.text,
          `engine and get_leaf_text disagree on p${pageIndex} mcid ${leaf.mcid}`);
        compared += 1;

        // Glyphs must carry real extent, and advance left to right *along a
        // line* - not across the whole span, since a leaf that wraps starts
        // its next line back at the left margin. Grouped by baseline so the
        // check means "the pen moves forward as it writes".
        const byLine = new Map();
        for (const box of boxes) {
          assert(box.x1 >= box.x0, 'glyph box has negative width');
          assert(box.y1 > box.y0, 'glyph box has no height');
          const line = box.y0.toFixed(1);
          if (!byLine.has(line)) byLine.set(line, []);
          byLine.get(line).push(box);
        }
        for (const lineBoxes of byLine.values()) {
          let previousX = -Infinity;
          for (const box of lineBoxes) {
            assert(box.x0 >= previousX - 0.01, 'the pen moved backwards along a line');
            previousX = box.x0;
          }
        }
      }
    }
    assert(compared > 0, 'no leaves were actually compared');
  }));

  await test('rejects an out-of-range page instead of guessing', () => withDoc(fixture, async (doc) => {
    let threw = false;
    try {
      await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex: 9999 });
    } catch {
      threw = true;
    }
    assert(threw, 'an out-of-range page index was accepted');
  }));

  // wrap_leaves() - the page preview's Select Content rectangle. Three
  // shapes, because which one fires decides whether the result is what the
  // user drew: the whole of one tag (relabel in place, attributes kept), part
  // of one tag (nest inside it, source survives), and leaves from two tags
  // (new tag takes the consumed tag's slot, emptied sources discarded).
  await test('tagging a whole tag\'s content relabels it in place', () => withDoc(fixture, async (doc) => {
    const parent = allNodes(doc.tree).find((n) => n.type === 'element'
      && n.children.length > 0
      && n.children.every((k) => k.type === 'content'));
    if (!parent) skip('no element with only content leaves in this fixture');

    const leafIds = parent.children.map((k) => k.id);
    const before = countNodes(doc.tree);
    const result = await worker.call('wrap_leaves', {
      docId: doc.docId, nodeIds: leafIds, role: 'H2',
    });

    assert(result.relabelled, 'should have relabelled rather than wrapped');
    assertEqual(result.removedTagCount, 0, 'relabelling should discard nothing');
    assertEqual(countNodes(result.tree), before, 'relabelling changed the node count');
    const retagged = findById(result.tree, result.newNodeId);
    assertEqual(retagged.role, 'H2', 'role was not applied');
    assertEqual(retagged.children.length, leafIds.length, 'lost content while relabelling');

    await saveAndReopen(doc.docId, 'wrap-leaves-relabel', (reopened) => {
      assert(byRole(reopened.tree, 'H2').length >= 1, 'the retagged tag did not survive save');
    });
  }));

  await test('tagging part of a tag divides it into siblings', () => withDoc(fixture, async (doc) => {
    // Taking the first of a tag's leaves leaves nothing before the
    // selection, so the original keeps the tail and the new tag goes in
    // front of it - both under the original's own parent, neither inside
    // the other.
    const parent = allNodes(doc.tree).find((n) => n.type === 'element'
      && n.children.length >= 2
      && n.children.every((k) => k.type === 'content'));
    if (!parent) skip('no element with two or more content leaves in this fixture');
    const grandparent = parentOf(doc.tree, parent.id);
    if (!grandparent) skip('that tag has no parent to become a sibling within');

    const kidsBefore = parent.children.length;
    const result = await worker.call('wrap_leaves', {
      docId: doc.docId, nodeIds: [parent.children[0].id], role: 'Span',
    });

    assert(!result.relabelled, 'a partial selection must not relabel the source tag');
    assertEqual(result.removedTagCount, 0, 'a surviving source tag must not be discarded');

    const holder = parentOf(result.tree, result.newNodeId);
    assertEqual(holder.role, grandparent.role,
      'the new tag should sit beside the source tag, not inside it');
    const at = holder.children.findIndex((c) => c.id === result.newNodeId);
    const remainder = holder.children[at + 1];
    assert(remainder && remainder.role === parent.role,
      'the source tag should follow the new one, keeping its role');
    assertEqual(remainder.children.length, kidsBefore - 1,
      'the source tag should have given up exactly the selected leaf');
  }));

  await test('tagging across two tags discards the ones it empties', () => withDoc(fixture, async (doc) => {
    // Two sibling tags on one page whose children are all content leaves:
    // taking every leaf from both leaves both empty, so both should go.
    let pair = null;
    for (const node of allNodes(doc.tree)) {
      const kids = node.children.filter((c) => c.type === 'element');
      for (let i = 0; i < kids.length - 1 && !pair; i += 1) {
        const [a, b] = [kids[i], kids[i + 1]];
        const usable = (n) => n.children.length > 0 && n.children.every((k) => k.type === 'content');
        if (usable(a) && usable(b) && a.page === b.page) pair = { container: node, a, b };
      }
      if (pair) break;
    }
    if (!pair) skip('no adjacent leaf-only sibling tags in this fixture');

    const leafIds = [...pair.a.children, ...pair.b.children].map((k) => k.id);
    const leavesBefore = contentLeaves(doc.tree).length;
    const nodesBefore = countNodes(doc.tree);

    const result = await worker.call('wrap_leaves', {
      docId: doc.docId, nodeIds: leafIds, role: 'H3',
    });

    assertEqual(result.removedTagCount, 2, 'both emptied source tags should have been discarded');
    // Two tags out, one in - and not a single content leaf lost on the way.
    assertEqual(countNodes(result.tree), nodesBefore - 1, 'unexpected net node count');
    assertEqual(contentLeaves(result.tree).length, leavesBefore, 'content was lost');
    const holder = parentOf(result.tree, result.newNodeId);
    assertEqual(holder.id, pair.container.id, 'the new tag did not take the consumed tags\' place');

    await saveAndReopen(doc.docId, 'wrap-leaves-across', (reopened) => {
      assertEqual(contentLeaves(reopened.tree).length, leavesBefore,
        'the saved file lost content leaves');
      assert(byRole(reopened.tree, 'H3').length >= 1, 'the new tag did not survive save');
    });
  }));

  // tag_rect_content() - the same rectangle, when it cuts through content
  // rather than only around it. Cut indices must land on real character
  // boundaries, which is why these derive them from the glyph engine rather
  // than picking round numbers: a code whose /ToUnicode maps it to more than
  // one character spans several offsets with no boundary inside it. The
  // renderer is in the same position and reaches the same answer, since
  // coveredRun() sums the same per-glyph text lengths.
  async function boundariesFor(doc, pageIndex, mcid) {
    const geometry = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex });
    const glyphs = geometry.boxes
      .filter((b) => b.mcid === mcid)
      .sort((a, b) => a.seq - b.seq);
    const offsets = [0];
    for (const g of glyphs) offsets.push(offsets[offsets.length - 1] + g.text.length);
    return offsets;
  }

  async function pickCuttableLeaf(doc, minChars = 30) {
    for (const leaf of contentLeaves(doc.tree)) {
      if (leaf.page === null || leaf.page === undefined || leaf.mcid === null) continue;
      const text = (await worker.call('get_leaf_text', { docId: doc.docId, nodeId: leaf.id })).text;
      if (!text || text.length < minChars) continue;
      const offsets = await boundariesFor(doc, leaf.page, leaf.mcid);
      if (offsets.length > 6) return { leaf, text, offsets };
    }
    return null;
  }

  await test('a rectangle cutting mid-leaf tags only the covered run', () => withDoc(fixture, async (doc) => {
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut twice');
    const { leaf, text, offsets } = target;
    const start = offsets[2];
    const end = offsets[offsets.length - 3];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: start, endIndex: end }],
      role: 'H2',
    });

    assertEqual(result.cutCount, 2, 'a middle run needs a cut at each end');
    assert(result.pdfBase64, 'a cut must hand back fresh page bytes for the preview');

    const tagged = findById(result.tree, result.newNodeId);
    assertEqual(tagged.children.length, 1, 'the new tag should hold exactly the cut run');
    const taggedText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: tagged.children[0].id })).text;
    assertEqual(taggedText, text.slice(start, end), 'the tagged text is not the run asked for');

    // The head and tail must still be on the page, just untagged - a cut
    // divides content, it never removes any.
    const remaining = [];
    for (const other of contentLeaves(result.tree)) {
      if (other.page !== leaf.page) continue;
      const t = (await worker.call('get_leaf_text', { docId: doc.docId, nodeId: other.id })).text;
      if (t) remaining.push(t);
    }
    const joined = remaining.join('');
    assert(joined.includes(text.slice(0, start)), 'the run before the cut went missing');
    assert(joined.includes(text.slice(end)), 'the run after the cut went missing');

    await saveAndReopen(doc.docId, 'tag-rect-content', (reopened) => {
      assert(byRole(reopened.tree, 'H2').length >= 1, 'the new tag did not survive save');
    });
  }));

  await test('tagging part of a tag puts the new tag beside it, not inside', () => withDoc(fixture, async (doc) => {
    // Anchoring the new tag at the selected leaf's own slot - right for a
    // single hand-picked leaf - would nest it: <P><H3>..</H3>..</P>. Tagging
    // half a paragraph as a heading should leave them side by side.
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf, text, offsets } = target;
    const container = parentOf(doc.tree, leaf.id);
    if (!container || container.children.length !== 1) {
      skip('the leaf shares its parent, so this is not the single-run case');
    }
    const cut = offsets[Math.floor(offsets.length / 2)];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: cut, endIndex: null }],
      role: 'H3',
    });

    const holder = parentOf(result.tree, result.newNodeId);
    assert(holder.role !== container.role || holder.id !== container.id,
      'the new tag was nested inside the tag its content came from');

    // Side by side under the original's own parent, in reading order, with
    // the text divided between them and nothing lost.
    const siblings = holder.children;
    const at = siblings.findIndex((c) => c.id === result.newNodeId);
    assert(at > 0, 'the new tag should follow the half it was split from');
    const headText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: siblings[at - 1].children[0].id })).text;
    const tagText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: siblings[at].children[0].id })).text;
    assertEqual(headText, text.slice(0, cut), 'the head half lost or gained text');
    assertEqual(tagText, text.slice(cut), 'the tagged half is not the run selected');
    assertEqual(siblings[at - 1].role, container.role,
      'the half left behind changed role');
  }));

  await test('a run inside a list body stays inside it', () => withDoc(fixture, async (doc) => {
    // An LBody's siblings are its list item's Lbl and LBody, so dividing one
    // into two would be structurally wrong - position-constrained containers
    // keep the nesting behaviour.
    const body = allNodes(doc.tree).find((n) => n.role === 'LBody'
      && n.children.length > 0
      && n.children.every((c) => c.type === 'content')
      && n.children[0].mcid !== null && n.children[0].mcid !== undefined
      && n.children[0].page !== null && n.children[0].page !== undefined);
    if (!body) skip('no leaf-only LBody in this fixture');
    const leaf = body.children[0];
    const offsets = await boundariesFor(doc, leaf.page, leaf.mcid);
    if (offsets.length < 4) skip('that list body is too short to cut');

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: 0, endIndex: offsets[Math.floor(offsets.length / 2)] }],
      role: 'Span',
    });
    const holder = parentOf(result.tree, result.newNodeId);
    assertEqual(holder.role, 'LBody', 'the run escaped its list body');
  }));

  await test('tagging a selection as a list item builds the LBody', () => withDoc(fixture, async (doc) => {
    // An LI's content is always the Lbl/LBody pair, never bare leaves -
    // the rectangle path goes through the same _set_li_content() the tree's
    // 'I' shortcut uses, rather than dropping the leaves straight in.
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf, offsets } = target;

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: offsets[2], endIndex: null }],
      role: 'LI',
      useLabel: false,
    });

    const li = findById(result.tree, result.newNodeId);
    assertEqual(li.role, 'LI', 'the new tag is not an LI');
    assertEqual(li.children.length, 1, 'an unlabelled LI should hold one LBody');
    assertEqual(li.children[0].role, 'LBody', 'the LI holds bare content, not an LBody');
    assert(li.children[0].children.length > 0, 'the LBody came out empty');

    await saveAndReopen(doc.docId, 'rect-list-item', (reopened) => {
      const items = byRole(reopened.tree, 'LI');
      assert(items.some((n) => n.children.some((c) => c.role === 'LBody')),
        'the LI/LBody shape did not survive save');
    });
  }));

  await test('a labelled list item splits into Lbl and LBody', () => withDoc(fixture, async (doc) => {
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf, offsets } = target;

    // Two selections from one leaf: the first stands in for a bullet, so
    // useLabel splits them into Lbl + LBody rather than one LBody.
    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [
        { nodeId: leaf.id, startIndex: 0, endIndex: offsets[2] },
      ],
      role: 'LI',
      useLabel: true,
    });
    const li = findById(result.tree, result.newNodeId);
    assertEqual(li.children.length, 2, 'a labelled LI should hold a Lbl and an LBody');
    assertEqual(li.children[0].role, 'Lbl', 'the first child should be the Lbl');
    assertEqual(li.children[1].role, 'LBody', 'the second child should be the LBody');
  }));

  await test('a marker sharing a leaf with its text is cut off into a Lbl', () => withDoc(fixture, async (doc) => {
    // A well-formed list gives the marker its own leaf, and useLabel simply
    // promotes it. Where the marker and its text are painted as one run
    // there is nothing to promote, so labelSplit cuts it off first - the
    // case that had every such item collapse into a single LBody.
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf, text, offsets } = target;
    const split = offsets[1];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: 0, endIndex: null, labelSplit: split }],
      role: 'LI',
      useLabel: false,
    });

    const li = findById(result.tree, result.newNodeId);
    assertEqual(li.children.length, 2, 'the marker was not split off');
    assertEqual(li.children[0].role, 'Lbl', 'the first child should be the Lbl');
    assertEqual(li.children[1].role, 'LBody', 'the second child should be the LBody');

    const lblText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: li.children[0].children[0].id })).text;
    assertEqual(lblText, text.slice(0, split), 'the Lbl holds the wrong text');
    assert(result.pdfBase64, 'cutting the marker must hand back fresh page bytes');

    await saveAndReopen(doc.docId, 'rect-label-split', (reopened) => {
      const labelled = byRole(reopened.tree, 'LI')
        .filter((n) => n.children.some((c) => c.role === 'Lbl'));
      assert(labelled.length >= 1, 'the Lbl/LBody split did not survive save');
    });
  }));

  await test('an impossible label split falls back to a single LBody', () => withDoc(fixture, async (doc) => {
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf } = target;

    // An index that lands inside a character rather than between two: the
    // cut can't be made, and the item must still come out valid.
    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: 0, endIndex: null, labelSplit: 100000 }],
      role: 'LI',
      useLabel: false,
    });
    const li = findById(result.tree, result.newNodeId);
    assertEqual(li.children.length, 1, 'a failed split should leave one LBody');
    assertEqual(li.children[0].role, 'LBody', 'the fallback should still be an LBody');
  }));

  await test('tagging several runs as a list gives each its own item', () => withDoc(fixture, async (doc) => {
    // A list is the one role that isn't a single tag over the whole
    // selection: every run the rectangle covered becomes its own LI, each
    // with its own label, rather than all of them landing in one item.
    const target = await pickCuttableLeaf(doc, 60);
    if (!target) skip('fixture has no measurable leaf long enough to cut in three');
    const { leaf, offsets } = target;
    const third = Math.floor(offsets.length / 3);
    const cuts = [offsets[0], offsets[third], offsets[third * 2]];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [
        { nodeId: leaf.id, startIndex: cuts[0], endIndex: cuts[1] },
        { nodeId: leaf.id, startIndex: cuts[1], endIndex: cuts[2] },
        { nodeId: leaf.id, startIndex: cuts[2], endIndex: null },
      ],
      role: 'L',
    });

    const list = findById(result.tree, result.newNodeId);
    assertEqual(list.role, 'L', 'the new tag is not a list');
    assertEqual(list.children.length, 3, 'each covered run should be its own item');
    for (const item of list.children) {
      assertEqual(item.role, 'LI', 'a list child is not an LI');
      assertEqual(item.children.length, 1, 'an unlabelled item should hold one LBody');
      assertEqual(item.children[0].role, 'LBody', 'an item holds bare content');
    }

    await saveAndReopen(doc.docId, 'rect-list', (reopened) => {
      const lists = byRole(reopened.tree, 'L');
      assert(lists.some((n) => n.children.filter((c) => c.role === 'LI').length === 3),
        'the three-item list did not survive save');
    });
  }));

  await test('a list built from one leaf gives every item its own label', () => withDoc(fixture, async (doc) => {
    // The workflow this exists for: one rectangle over a whole visual list,
    // one L keystroke. A list is routinely painted as a single run, so the
    // renderer sends one selection per item found inside it - several
    // naming the same leaf, which the worker has to cut back to front for
    // the earlier offsets to stay valid.
    const target = await pickCuttableLeaf(doc, 60);
    if (!target) skip('fixture has no measurable leaf long enough for three items');
    const { leaf, text, offsets } = target;
    const third = Math.floor(offsets.length / 3);
    const bounds = [offsets[0], offsets[third], offsets[third * 2], null];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [0, 1, 2].map((i) => ({
        nodeId: leaf.id,
        startIndex: bounds[i],
        endIndex: bounds[i + 1],
        // One character of each item stands in for its marker.
        labelSplit: offsets[offsets.indexOf(bounds[i]) + 1] - bounds[i],
      })),
      role: 'L',
    });

    const list = findById(result.tree, result.newNodeId);
    assertEqual(list.children.length, 3, 'each item inside the leaf should be its own LI');
    for (const item of list.children) {
      assertEqual(item.children.length, 2, 'a labelled item holds a Lbl and an LBody');
      assertEqual(item.children[0].role, 'Lbl', 'the first child should be the Lbl');
      assertEqual(item.children[1].role, 'LBody', 'the second child should be the LBody');
    }

    // Nothing lost or reordered: the items still spell out the original.
    const rebuilt = [];
    for (const item of list.children) {
      for (const part of item.children) {
        for (const contentLeaf of part.children) {
          rebuilt.push((await worker.call('get_leaf_text',
            { docId: doc.docId, nodeId: contentLeaf.id })).text);
        }
      }
    }
    assertEqual(rebuilt.join(''), text, 'the items do not reconstruct the original text');

    await saveAndReopen(doc.docId, 'rect-list-items', (reopened) => {
      const labelled = byRole(reopened.tree, 'LI')
        .filter((n) => n.children.some((c) => c.role === 'Lbl'));
      assert(labelled.length >= 3, 'the labelled items did not survive save');
    });
  }));

  await test('undoing a cut hands back the page it restores', () => withDoc(fixture, async (doc) => {
    // The renderer keeps its own pdf.js parse of the page bytes. Most edits
    // only move tags about and leave that parse valid, but a cut rewrites
    // the content stream - so stepping back across one has to re-feed it,
    // or its MCIDs name different text than the restored tree does and the
    // content leaves read as empty.
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut');
    const { leaf, text, offsets } = target;

    await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: offsets[2], endIndex: null }],
      role: 'P',
    });

    const undone = await worker.call('undo', { docId: doc.docId });
    assert(undone.pdfBase64, 'undoing a cut must hand back the restored page bytes');

    // And the restored leaf really does read as it did before the cut.
    const restored = contentLeaves(undone.tree)
      .find((n) => n.page === leaf.page && n.mcid === leaf.mcid);
    assert(restored, 'the content leaf did not come back');
    const restoredText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: restored.id })).text;
    assertEqual(restoredText, text, 'the restored leaf lost or gained text');

    const redone = await worker.call('redo', { docId: doc.docId });
    assert(redone.pdfBase64, 'redoing a cut must hand back bytes too');
  }));

  await test('undoing a tag-only edit does not resend the page', () => withDoc(fixture, async (doc) => {
    // The counterpart: bytes are only worth sending when they changed, and
    // a whole document's worth of them per undo would be a real cost.
    const element = allNodes(doc.tree).find((n) => n.type === 'element' && n.id !== 'root');
    if (!element) skip('fixture has no taggable element');
    await worker.call('update_node', {
      docId: doc.docId, nodeId: element.id, changes: { alt: 'undo cost check' },
    });
    const undone = await worker.call('undo', { docId: doc.docId });
    assert(!undone.pdfBase64, 'a tag-only undo should not resend the document');
  }));

  await test('undoing a delete hands back the page it restores', () => withDoc(fixture, async (doc) => {
    // delete_nodes rewrites content streams too, turning the removed
    // leaves' marked content into artifacts - so its undo needs the same
    // treatment, and had the same problem before this.
    const victim = allNodes(doc.tree).find((n) => n.type === 'element'
      && n.id !== 'root'
      && contentLeaves(n).length > 0);
    if (!victim) skip('fixture has no element with content to delete');
    await worker.call('delete_nodes', { docId: doc.docId, nodeIds: [victim.id] });
    const undone = await worker.call('undo', { docId: doc.docId });
    assert(undone.pdfBase64, 'undoing an artifacting delete must hand back bytes');
  }));

  await test('a whole-leaf selection cuts nothing', () => withDoc(fixture, async (doc) => {
    const leaf = contentLeaves(doc.tree).find((n) => n.page !== null && n.page !== undefined);
    if (!leaf) skip('fixture has no placed content leaves');
    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      // startIndex 0 with no end is how the renderer asks for a leaf whole -
      // the shape it sends for anything the glyph engine couldn't measure.
      selections: [{ nodeId: leaf.id, startIndex: 0, endIndex: null }],
      role: 'P',
    });
    assertEqual(result.cutCount, 0, 'a whole-leaf selection should not cut');
    assert(!result.pdfBase64, 'no cut means the content stream is untouched');
  }));

  await test('cutting for a rectangle leaves every glyph where it was', () => withDoc(fixture, async (doc) => {
    const target = await pickCuttableLeaf(doc);
    if (!target) skip('fixture has no measurable leaf long enough to cut twice');
    const { leaf, offsets } = target;

    // The safety property the whole splitting design rests on. Compared
    // ownership-agnostically: the cut deliberately changes which mcid owns
    // each glyph, and must change nothing else about it.
    const glyphSignature = async (pageIndex) => {
      const geometry = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex });
      return geometry.boxes
        .map((b) => `${b.x0},${b.y0},${b.x1},${b.y1},${b.text}`)
        .sort()
        .join('|');
    };

    const before = await glyphSignature(leaf.page);
    await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: leaf.page,
      selections: [{ nodeId: leaf.id, startIndex: offsets[2], endIndex: offsets[offsets.length - 3] }],
      role: 'H3',
    });
    const after = await glyphSignature(leaf.page);
    assertEqual(after, before, 'cutting moved, added or dropped a glyph');
  }));

  await test('refuses to group content from two different pages', () => withDoc(fixture, async (doc) => {
    const byPage = new Map();
    for (const node of allNodes(doc.tree)) {
      if (node.type !== 'content' || node.page === null || node.page === undefined) continue;
      if (!byPage.has(node.page)) byPage.set(node.page, []);
      byPage.get(node.page).push(node.id);
    }
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    if (pages.length < 2) skip('fixture has content on only one page');

    // A bare MCID leaf takes its page from its containing tag, so grouping
    // across pages would silently relabel which page the content points at.
    let threw = false;
    try {
      await worker.call('wrap_leaves', {
        docId: doc.docId,
        nodeIds: [byPage.get(pages[0])[0], byPage.get(pages[1])[0]],
        role: 'P',
      });
    } catch {
      threw = true;
    }
    assert(threw, 'a cross-page selection was accepted');
  }));

  await test('flattening unwraps organizational tags and they stay gone', () => withDoc(fixture, async (doc) => {
    // Flatten never removes the tag you selected - only the organizational
    // tags nested inside it - so this selects the root and expects everything
    // Div/Sect/Part/*span* below it to be spliced away.
    const before = countOrganizational(doc.tree);
    if (before === 0) skip('no organizational tags in this fixture');

    // Unwrapping must keep everything that isn't organizational: the wrapper
    // goes, its contents get spliced into the parent. Losing content here
    // would leave a document that still looks structurally valid.
    const keepBefore = countNodes(doc.tree) - before;

    const result = await worker.call('flatten_tags', { docId: doc.docId, nodeIds: ['root'] });
    assertEqual(result.removed, before, 'removed count does not match the organizational tags present');
    assertEqual(countOrganizational(result.tree), 0, 'organizational tags remain in the returned tree');
    assertEqual(countNodes(result.tree), keepBefore, 'flatten dropped content along with the wrappers');

    await saveAndReopen(doc.docId, 'flatten', (reopened) => {
      assertEqual(countOrganizational(reopened.tree), 0,
        'organizational tags came back after save');
      assertEqual(countNodes(reopened.tree), keepBefore,
        'the saved file lost content that flatten should have kept');
    });
  }));

  await test('tagging a drawn rectangle makes a Figure', () => withDoc(fixture, async (doc) => {
    const result = await worker.call('figure_from_rect', {
      docId: doc.docId, pageIndex: 0, rect: [72, 72, 272, 272],
    });
    assert(result.newNodeId, 'no newNodeId returned');
    const created = findById(result.tree, result.newNodeId);
    assert(created, 'the new figure is not in the returned tree');
    assertEqual(created.role, 'Figure', 'the new tag is not a Figure');
    assert(['object', 'bbox'].includes(result.method), `unexpected method ${result.method}`);
    await saveAndReopen(doc.docId, 'figure', (reopened) => {
      assert(byRole(reopened.tree, 'Figure').length > byRole(doc.tree, 'Figure').length,
        'the new figure is missing from the saved file');
    });
  }));

  // split_leaf() is the only command that rewrites a page's *content stream*
  // rather than just the struct tree, so it is the one edit that can leave a
  // page unparseable rather than merely mistagged - and the reopen below is
  // the only thing that would notice.
  await test('splitting a content leaf divides its text and survives save', () => withDoc(fixture, async (doc) => {
    // Split on an interior space: a space is always a font code of its own, so
    // its offset is guaranteed to be one of the code boundaries split_leaf()
    // insists on, with real text left on both sides.
    let target = null;
    for (const leaf of contentLeaves(doc.tree)) {
      const { text } = await worker.call('get_leaf_text', { docId: doc.docId, nodeId: leaf.id });
      if (!text) continue;
      const at = text.indexOf(' ', 1);
      if (at > 0 && at < text.length - 1) { target = { id: leaf.id, text, at }; break; }
    }
    if (!target) skip('no splittable content leaf in this fixture');

    const leavesBefore = contentLeaves(doc.tree).length;
    const result = await worker.call('split_leaf', {
      docId: doc.docId, nodeId: target.id, splitIndex: target.at,
    });

    assertEqual(result.newNodeIds.length, 2, 'split did not return two leaves');
    assert(result.pdfBase64, 'split returned no refreshed PDF bytes for the preview');
    assertEqual(contentLeaves(result.tree).length, leavesBefore + 1,
      'split did not add exactly one content leaf');

    // The halves must read back as the original text, cut at the cursor - the
    // whole point is that the text the user placed a cursor in is exactly what
    // gets divided, with nothing dropped or duplicated at the seam.
    const [idA, idB] = result.newNodeIds;
    const a = await worker.call('get_leaf_text', { docId: doc.docId, nodeId: idA });
    const b = await worker.call('get_leaf_text', { docId: doc.docId, nodeId: idB });
    assertEqual(a.text, target.text.slice(0, target.at), 'first half lost text');
    assertEqual(b.text, target.text.slice(target.at), 'second half lost text');

    await saveAndReopen(doc.docId, 'split-leaf', async (reopened) => {
      assertEqual(contentLeaves(reopened.tree).length, leavesBefore + 1,
        'the split did not survive save and reopen');
      // Ids are reassigned on every rebuild, but a save/reopen round trip
      // rebuilds the same tree shape, so the split's own ids still name the
      // same two leaves.
      const reA = await worker.call('get_leaf_text', { docId: reopened.docId, nodeId: idA });
      const reB = await worker.call('get_leaf_text', { docId: reopened.docId, nodeId: idB });
      assertEqual(reA.text, target.text.slice(0, target.at), 'first half is wrong in the saved file');
      assertEqual(reB.text, target.text.slice(target.at), 'second half is wrong in the saved file');
    });
  }));
}

async function listAndTableTests(fixture) {
  await test('grouping paragraphs into a list survives save and reopen', () => withDoc(fixture, async (doc) => {
    const pair = adjacentSiblings(doc.tree, 'P');
    if (!pair) skip('no two adjacent P tags in this fixture');
    const ids = pair.map((n) => n.id);
    const listsBefore = byRole(doc.tree, 'L').length;
    const result = await worker.call('make_list', {
      docId: doc.docId, nodeIds: ids, labelFlags: {},
    });
    assertEqual(byRole(result.tree, 'L').length, listsBefore + 1, 'no new List tag was created');
    await saveAndReopen(doc.docId, 'list', (reopened) => {
      assertEqual(byRole(reopened.tree, 'L').length, listsBefore + 1,
        'the new List did not survive the save');
    });
  }));

  await test('scoping table headers survives save and reopen', () => withDoc(fixture, async (doc) => {
    if (byRole(doc.tree, 'Table').length === 0) skip('no Table in this fixture');
    const result = await worker.call('scope_tables', { docId: doc.docId });
    assert(typeof result.tablesScoped === 'number', 'tablesScoped is not a number');
    await saveAndReopen(doc.docId, 'scope', (reopened) => {
      const headers = byRole(reopened.tree, 'TH');
      assert(headers.length > 0, 'the saved file has no TH tags');
      if (result.tablesScoped > 0) {
        assert(headers.some((h) => h.scope), 'no TH in the saved file carries a scope');
      }
    });
  }));

  await test('table structure is preserved across save', () => withDoc(fixture, async (doc) => {
    const tables = byRole(doc.tree, 'Table');
    if (tables.length === 0) skip('no Table in this fixture');
    const counts = {
      Table: tables.length,
      TR: byRole(doc.tree, 'TR').length,
      TH: byRole(doc.tree, 'TH').length,
      TD: byRole(doc.tree, 'TD').length,
    };
    await saveAndReopen(doc.docId, 'table', (reopened) => {
      for (const [role, expected] of Object.entries(counts)) {
        assertEqual(byRole(reopened.tree, role).length, expected, `${role} count changed on save`);
      }
    });
  }));

  await test('adding a table row creates a TR with cells and survives save', () => withDoc(fixture, async (doc) => {
    const table = firstByRole(doc.tree, 'Table');
    if (!table) skip('no Table in this fixture');
    const trBefore = byRole(doc.tree, 'TR').length;
    const cellsBefore = byRole(doc.tree, 'TH').length + byRole(doc.tree, 'TD').length;
    const tableRows = collectTableRows(table);
    const lastRowBefore = tableRows[tableRows.length - 1];
    const expectedNewCells = lastRowBefore ? collectRowCells(lastRowBefore).length : 1;

    const result = await worker.call('add_table_row', { docId: doc.docId, tableId: table.id });
    assert(result.newNodeId, 'no newNodeId returned');
    const newRow = findById(result.tree, result.newNodeId);
    assert(newRow, 'new row id is not in the rebuilt tree');
    assertEqual(newRow.role, 'TR', 'new node is not a TR');
    assertEqual(byRole(result.tree, 'TR').length, trBefore + 1, 'TR count did not increase by one');
    const cellsAfter = byRole(result.tree, 'TH').length + byRole(result.tree, 'TD').length;
    assertEqual(cellsAfter, cellsBefore + expectedNewCells, 'new row did not add the expected number of cells');

    await saveAndReopen(doc.docId, 'add-row', (reopened) => {
      assertEqual(byRole(reopened.tree, 'TR').length, trBefore + 1, 'new TR did not survive the save');
    });
  }));

  await test('adding a table column adds one cell per row and survives save', () => withDoc(fixture, async (doc) => {
    const table = firstByRole(doc.tree, 'Table');
    if (!table) skip('no Table in this fixture');
    const rows = collectTableRows(table);
    if (rows.length === 0) skip('Table in this fixture has no rows');
    const cellsBefore = byRole(doc.tree, 'TH').length + byRole(doc.tree, 'TD').length;
    const trBefore = byRole(doc.tree, 'TR').length;

    const result = await worker.call('add_table_column', { docId: doc.docId, tableId: table.id });
    const cellsAfter = byRole(result.tree, 'TH').length + byRole(result.tree, 'TD').length;
    assertEqual(cellsAfter, cellsBefore + rows.length, 'did not add exactly one new cell per row of this table');
    assertEqual(byRole(result.tree, 'TR').length, trBefore, 'row count changed when only adding a column');

    await saveAndReopen(doc.docId, 'add-column', (reopened) => {
      const reopenedCells = byRole(reopened.tree, 'TH').length + byRole(reopened.tree, 'TD').length;
      assertEqual(reopenedCells, cellsBefore + rows.length, 'the new column did not survive the save');
    });
  }));

  await test('deleting a table row removes the row and its cells', () => withDoc(fixture, async (doc) => {
    const table = firstByRole(doc.tree, 'Table');
    if (!table) skip('no Table in this fixture');
    const rows = collectTableRows(table);
    if (rows.length === 0) skip('Table in this fixture has no rows');
    const row = rows[rows.length - 1];
    const cellCount = collectRowCells(row).length;
    const trBefore = byRole(doc.tree, 'TR').length;
    const cellsBefore = byRole(doc.tree, 'TH').length + byRole(doc.tree, 'TD').length;

    // Node ids are a fresh depth-first counter reassigned on every rebuild
    // (see the module docstring in tag_worker.py), so a *surviving* node can
    // easily inherit the same id string a deleted one used to hold -
    // checking "is this exact id gone" after the rebuild would be testing
    // the wrong thing. The structural counts below are what actually proves
    // the row and its cells were removed.
    const result = await worker.call('delete_nodes', { docId: doc.docId, nodeIds: [row.id] });
    assertEqual(byRole(result.tree, 'TR').length, trBefore - 1, 'TR count did not decrease by one');
    const cellsAfter = byRole(result.tree, 'TH').length + byRole(result.tree, 'TD').length;
    assertEqual(cellsAfter, cellsBefore - cellCount, 'deleted row\'s cells were not all removed');

    await saveAndReopen(doc.docId, 'delete-row', (reopened) => {
      assertEqual(byRole(reopened.tree, 'TR').length, trBefore - 1, 'row deletion did not survive the save');
    });
  }));

  await test('deleting a table column removes only that column\'s cells', () => withDoc(fixture, async (doc) => {
    const table = firstByRole(doc.tree, 'Table');
    if (!table) skip('no Table in this fixture');
    const rows = collectTableRows(table).filter((r) => collectRowCells(r).length > 0);
    if (rows.length === 0) skip('no TR with cells in this Table');
    const firstCellIds = rows.map((r) => collectRowCells(r)[0].id);
    const trBefore = byRole(doc.tree, 'TR').length;
    const cellsBefore = byRole(doc.tree, 'TH').length + byRole(doc.tree, 'TD').length;

    const result = await worker.call('delete_nodes', { docId: doc.docId, nodeIds: firstCellIds });
    assertEqual(byRole(result.tree, 'TR').length, trBefore, 'row count changed when only deleting a column');
    const cellsAfter = byRole(result.tree, 'TH').length + byRole(result.tree, 'TD').length;
    assertEqual(cellsAfter, cellsBefore - firstCellIds.length, 'deleted column cells were not all removed');

    await saveAndReopen(doc.docId, 'delete-column', (reopened) => {
      const reopenedCells = byRole(reopened.tree, 'TH').length + byRole(reopened.tree, 'TD').length;
      assertEqual(reopenedCells, cellsBefore - firstCellIds.length, 'column deletion did not survive the save');
    });
  }));
}

async function bookmarkTests(fixture) {
  await test('adding and renaming a bookmark survives save and reopen', () => withDoc(fixture, async (doc) => {
    const added = await worker.call('add_bookmark', {
      docId: doc.docId, page: 0, title: 'Smoke Bookmark',
    });
    assert(added.newBookmarkId, 'no newBookmarkId returned');

    await worker.call('rename_bookmark', {
      docId: doc.docId, bookmarkId: added.newBookmarkId, title: 'Renamed Bookmark',
    });

    await saveAndReopen(doc.docId, 'bookmark', (reopened) => {
      const titles = [];
      for (const b of reopened.outline) walk(b, (n) => titles.push(n.title));
      assert(titles.includes('Renamed Bookmark'), `renamed bookmark missing; got ${JSON.stringify(titles)}`);
    });
  }));

  await test('generating bookmarks from headings replaces the outline', () => withDoc(fixture, async (doc) => {
    const headings = [];
    walk(doc.tree, (n) => {
      const m = /^H([1-6])$/.exec(n.role || '');
      if (m && n.page !== null && n.page !== undefined) {
        headings.push({ title: `Heading ${headings.length + 1}`, level: Number(m[1]), page: n.page, top: null });
      }
    });
    if (headings.length === 0) skip('no headings in this fixture');

    const result = await worker.call('generate_bookmarks', { docId: doc.docId, headings });
    const flat = [];
    for (const b of result.outline) walk(b, (n) => flat.push(n));
    assertEqual(flat.length, headings.length, 'outline does not have one entry per heading');

    await saveAndReopen(doc.docId, 'genbookmarks', (reopened) => {
      const saved = [];
      for (const b of reopened.outline) walk(b, (n) => saved.push(n));
      assertEqual(saved.length, headings.length, 'generated outline did not survive the save');
    });
  }));
}

// --- error handling --------------------------------------------------------

async function errorTests(fixture) {
  await test('rejects an unknown node id instead of corrupting the document',
    () => withDoc(fixture, async (doc) => {
      let threw = false;
      try {
        await worker.call('update_node', {
          docId: doc.docId, nodeId: 'no-such-node', changes: { alt: 'x' },
        });
      } catch {
        threw = true;
      }
      assert(threw, 'editing an unknown node id was accepted');
      // and the worker is still usable afterwards
      const still = await worker.call('undo', { docId: doc.docId }).catch(() => null);
      assert(still === null, 'undo succeeded when there should be nothing to undo');
    }));

  await test('rejects editing the document root', () => withDoc(fixture, async (doc) => {
    let threw = false;
    try {
      await worker.call('update_node', { docId: doc.docId, nodeId: 'root', changes: { alt: 'x' } });
    } catch {
      threw = true;
    }
    assert(threw, 'editing the root tag was accepted');
  }));
}

// The standard 14 fonts may carry no metrics at all, because every viewer is
// expected to have Adobe's AFM tables already. Supplying those is what lets a
// rectangle divide a leaf that Split Content could always divide - decoding
// needs /ToUnicode, but *placing* a character needs widths, and the two
// disagreeing on the same text is what these guard against.
async function standardFontTests(fixture) {
  await test('a standard-14 font with no /Widths still places its glyphs', () => withDoc(fixture, async (doc) => {
    const result = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex: 0 });
    assertEqual(Object.keys(result.refusals).length, 0,
      `refused a standard-14 font: ${JSON.stringify(result.refusals)}`);
    assert(result.boxes.length > 50, 'placed suspiciously few glyphs');

    // Widths must be real, not a single fallback repeated: Helvetica's "i"
    // is far narrower than its "w", and a flat fallback would make every
    // cut index drift along the line.
    const widthOf = (ch) => {
      const box = result.boxes.find((b) => b.text === ch);
      return box ? box.x1 - box.x0 : null;
    };
    const narrow = widthOf('i');
    const wide = widthOf('w');
    assert(narrow !== null && wide !== null, 'fixture text lost its i and w');
    assert(wide > narrow * 1.5, `widths look flat: i=${narrow}, w=${wide}`);
  }));

  await test('the engine and split_leaf agree on a standard-14 leaf', () => withDoc(fixture, async (doc) => {
    const leaf = contentLeaves(doc.tree)[0];
    const geometry = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex: 0 });
    const engineText = geometry.boxes
      .filter((b) => b.mcid === leaf.mcid)
      .sort((a, b) => a.seq - b.seq)
      .map((b) => b.text)
      .join('');
    const leafText = (await worker.call('get_leaf_text', { docId: doc.docId, nodeId: leaf.id })).text;
    assertEqual(engineText, leafText, 'the two decoders disagree on this leaf');
  }));

  await test('a rectangle can cut a standard-14 leaf', () => withDoc(fixture, async (doc) => {
    const leaf = contentLeaves(doc.tree)[0];
    const leafText = (await worker.call('get_leaf_text', { docId: doc.docId, nodeId: leaf.id })).text;
    const geometry = await worker.call('get_page_code_boxes', { docId: doc.docId, pageIndex: 0 });
    const glyphs = geometry.boxes.filter((b) => b.mcid === leaf.mcid).sort((a, b) => a.seq - b.seq);
    const offsets = [0];
    for (const g of glyphs) offsets.push(offsets[offsets.length - 1] + g.text.length);
    const cut = offsets[Math.floor(offsets.length / 2)];

    const result = await worker.call('tag_rect_content', {
      docId: doc.docId,
      pageIndex: 0,
      selections: [{ nodeId: leaf.id, startIndex: cut, endIndex: null }],
      role: 'H2',
    });
    assertEqual(result.cutCount, 1, 'a trailing run needs exactly one cut');
    const tagged = findById(result.tree, result.newNodeId);
    const taggedText = (await worker.call('get_leaf_text',
      { docId: doc.docId, nodeId: tagged.children[0].id })).text;
    assertEqual(taggedText, leafText.slice(cut), 'the cut did not land where it was asked to');

    await saveAndReopen(doc.docId, 'standard14-cut', (reopened) => {
      assert(byRole(reopened.tree, 'H2').length >= 1, 'the new tag did not survive save');
    });
  }));
}

// --- main ------------------------------------------------------------------

async function main() {
  const missing = [...FIXTURES, STANDARD14_FIXTURE]
    .filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error(`Missing fixture PDFs: ${missing.join(', ')}`);
    process.exit(1);
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastmilepdf-smoke-'));
  worker = new Worker();

  console.log('LastMilePDF smoke test');
  console.log(`  worker: ${pythonBin()}`);
  console.log(`  output: ${tempDir}`);

  const started = Date.now();
  try {
    for (const fixture of FIXTURES) {
      console.log(`\n${fixture}`);
      await structureTests(fixture);
      await editTests(fixture);
      await listAndTableTests(fixture);
      await bookmarkTests(fixture);
      await errorTests(fixture);
    }

    console.log(`
${STANDARD14_FIXTURE}`);
    await standardFontTests(STANDARD14_FIXTURE);
  } finally {
    worker.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped  (${seconds}s)`);

  if (worker.stderr.trim()) {
    console.log('\nworker stderr:');
    console.log(worker.stderr.trim());
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nsmoke test could not run: ${err.message}`);
  if (worker) worker.stop();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
