// view-memory.js
//
// Where the user was in a document, remembered per file across sessions:
// the selected tag, which tags they had expanded, how far down the tag tree
// was scrolled, which page the preview was on, and whether they were reading
// it in Proofread Mode. Reopening a PDF then resumes the last reading
// position instead of landing back on the structure root with everything
// collapsed - which on a long document meant re-expanding the same dozen
// levels every time.
//
// Stored in settings.json keyed by file path (see get/setFileViewState() in
// preload.js), so "last time" spans restarts. main.js only keys and caps the
// records; deciding whether one is still usable is this module's job, for
// the reason the whole file exists to handle:
//
// Node ids are a per-document depth-first counter (see _rebuild_registry()
// in tag_worker.py), so they are only meaningful against the exact tree they
// were captured from. A document edited elsewhere - or edited here and left
// unsaved when the app closed - comes back with the same ids naming
// different tags, and restoring against it would expand and select an
// apparently random scatter of rows. So every record carries a signature of
// the tree it was taken from, and a record whose signature doesn't match
// what was just opened is dropped whole rather than partly trusted.
//
// Imports only state.js and dom.js on purpose: tree-view.js calls in here on
// every render, so anything this module imported back from there would be a
// cycle. Restoring is therefore split - this module validates a record and
// says which tag to land on, and doc-io.js (which already drives the whole
// open sequence) does the selecting.

import { el } from './dom.js';
import { state } from './state.js';

// How long after the last change the current position is written out. Every
// arrow key through the tree is a change, and each write re-serializes the
// whole settings.json in the main process - long enough to collapse a burst
// of stepping into one write, short enough that the position is already on
// disk by the time a user who has stopped moving quits the app.
const SAVE_DEBOUNCE_MS = 400;

// Collapse/expand overrides kept per record. A record only needs the
// overrides that are actually holding the user's place - and a document
// where the user has toggled thousands of rows is one where settings.json
// shouldn't quietly grow by a thousand ids per file either. Overflow costs
// some expansion on reopen, not correctness - and it drops the oldest
// toggles (a Map iterates in insertion order), which are the ones least
// likely to be holding the user's current place.
const MAX_STORED_OVERRIDES = 2000;

let saveTimerId = null;

// Set while doc-io.js is opening a document and applying its remembered
// position. The open sequence renders the tree several times - once empty,
// once before the PDF preview has loaded - and each render would otherwise
// schedule a save of a position the restore hasn't reached yet, overwriting
// the record with the blank state it is in the middle of replacing.
let restoring = false;

// --- the tree signature -------------------------------------------------

/**
 * A digest of the tree's shape: how many nodes it has and, in depth-first
 * order, what kind each one is. Two opens of an unmodified file produce the
 * same string; any structural edit in between - a tag added, deleted, moved
 * or re-roled - produces a different one, which is exactly the question a
 * stored record needs answered ("do these ids still name these tags?").
 *
 * Attributes deliberately don't come into it. Alt text, Actual Text and
 * language change constantly through normal tagging work and change no id,
 * so folding them in would throw the record away after every edit for no
 * gain.
 *
 * @param {import('../types/domain').TagNode | null} tree
 */
function computeTreeSignature(tree) {
  if (!tree) return null;
  // FNV-1a, 32-bit. Not a cryptographic hash and doesn't need to be: this
  // only has to notice ordinary editing, and a mismatch is the safe answer
  // (the record is dropped) rather than the dangerous one.
  let hash = 0x811c9dc5;
  let count = 0;
  (function visit(node) {
    count += 1;
    const label = `${node.type}:${node.role || ''}|`;
    for (let i = 0; i < label.length; i += 1) {
      hash ^= label.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    for (const child of node.children || []) visit(child);
  })(tree);
  return `${count}.${(hash >>> 0).toString(16)}`;
}

/**
 * The signature of the tree as it now stands. Recomputed only when the tree
 * has actually been replaced: applyFreshTree() builds a new nodesById for
 * every rebuild, so its identity is a reliable "this is a different tree"
 * marker, and the walk above then happens once per edit rather than once per
 * debounced save.
 *
 * @type {{ nodesById: Map<string, unknown> | null, value: string | null }}
 */
let signatureCache = { nodesById: null, value: null };

function currentTreeSignature() {
  if (signatureCache.nodesById !== state.nodesById) {
    signatureCache = { nodesById: state.nodesById, value: computeTreeSignature(state.tree) };
  }
  return signatureCache.value;
}

// --- capturing ----------------------------------------------------------

/**
 * The tag tree's scroll position as the topmost row still showing, plus how
 * much of that row is scrolled off above the pane's top edge.
 *
 * Anchored to a row rather than stored as a raw scrollTop because the rows
 * above the user's position don't all have their final height at restore
 * time: a content leaf's text preview is filled in asynchronously once
 * pdf.js has parsed its page (see loadContentText() in tree-view.js), and
 * every one of those that grows a row above the anchor would otherwise push
 * the remembered position further off. The raw offset is kept as well, for
 * the case where the anchor row can't be found again.
 *
 * @returns {{ nodeId: string, offset: number } | null}
 */
function captureScrollAnchor() {
  const paneTop = el.tagTree.getBoundingClientRect().top;
  const rows = el.tagTree.querySelectorAll('.tree-row[data-node-id]');
  // The first row whose bottom edge is still below the pane's top edge is
  // the first one the user can see any of. Rows sit in the DOM in the order
  // they're drawn, top to bottom, so their bottom edges only ever increase
  // down the list - which makes this a binary search rather than a walk
  // from the top: the tree isn't virtualised, and this runs on every save
  // while the user scrolls, so scrolled to the foot of a document with tens
  // of thousands of rows a walk would measure every one of them each time.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].getBoundingClientRect().bottom > paneTop + 1) hi = mid;
    else lo = mid + 1;
  }
  const row = rows[lo];
  if (!row) return null;
  const nodeId = /** @type {HTMLElement} */ (row).dataset.nodeId;
  return nodeId ? { nodeId, offset: Math.round(paneTop - row.getBoundingClientRect().top) } : null;
}

/**
 * What to remember about where the app currently is, or null when there is
 * nothing worth remembering - which also tells main.js to forget whatever it
 * had for this file (see setFileViewState() there).
 */
function captureViewState() {
  if (!state.savedFilePath || !state.tree) return null;

  // The tree filter isn't per-file - it's a dropdown the user leaves set
  // wherever their work needs it - but a position captured under one filter
  // means nothing under another, since the list of rows is a different list.
  // Record which filter it was taken under and let the restore compare.
  // While Proofread Mode is on, what's recorded here is that mode's own
  // filter rather than the ordinary one (setProofreadMode() swaps the two
  // around state.filter), which is the right half of the pair to compare
  // against on a reopen that goes back into the mode.
  return {
    treeSignature: currentTreeSignature(),
    filter: state.filter,
    proofreadMode: state.proofreadMode,
    selectedNodeId: state.selectedNodeId,
    collapseOverrides: Array.from(state.collapseOverrides.entries()).slice(-MAX_STORED_OVERRIDES),
    scrollAnchor: captureScrollAnchor(),
    scrollTop: Math.round(el.tagTree.scrollTop),
    currentPage: state.currentPage,
  };
}

function writeViewStateNow() {
  saveTimerId = null;
  if (restoring) return;
  const filePath = state.savedFilePath;
  if (!filePath) return;
  window.api.setFileViewState(filePath, captureViewState()).catch((err) => {
    console.error('Could not remember where this document was left', err);
  });
}

/**
 * Schedules a save of the current position. Cheap and safe to call from
 * anywhere something moved - the work all happens in the debounced callback,
 * which reads the live DOM and state at the moment it fires, so a caller
 * that runs *before* the thing it is reacting to (renderTree(), which calls
 * this on the way in) still records the finished result.
 */
export function rememberViewState() {
  if (restoring) return;
  // Restarted on every call, so a burst of moves produces one write after
  // the burst ends - not one every SAVE_DEBOUNCE_MS for as long as it lasts.
  if (saveTimerId !== null) clearTimeout(saveTimerId);
  saveTimerId = setTimeout(writeViewStateNow, SAVE_DEBOUNCE_MS);
}

/**
 * Writes the current position immediately, for the moments right before it
 * stops being available: closing the document, or opening another one over
 * the top of it.
 */
export function flushViewState() {
  if (saveTimerId !== null) {
    clearTimeout(saveTimerId);
    saveTimerId = null;
  }
  writeViewStateNow();
}

// --- restoring ----------------------------------------------------------

/**
 * Held on for the length of an open, so the renders that happen along the
 * way don't write a half-built position over the record being restored from.
 *
 * @param {boolean} active
 */
export function setRestoringViewState(active) {
  restoring = active;
  if (active && saveTimerId !== null) {
    clearTimeout(saveTimerId);
    saveTimerId = null;
  }
}

/**
 * Reads back what was remembered for `filePath`, or null if there is
 * nothing. Shape-checks only - whether the record still *applies* to the
 * document depends on the tree, which isn't loaded yet at the point
 * doc-io.js asks for this.
 *
 * @param {string} filePath
 */
export async function loadViewState(filePath) {
  try {
    const raw = await window.api.getFileViewState(filePath);
    if (!raw || typeof raw !== 'object') return null;
    const record = /** @type {Record<string, any>} */ (raw);
    if (typeof record.treeSignature !== 'string') return null;
    const anchor = record.scrollAnchor;
    return {
      treeSignature: record.treeSignature,
      filter: typeof record.filter === 'string' ? record.filter : 'all',
      proofreadMode: record.proofreadMode === true,
      selectedNodeId: typeof record.selectedNodeId === 'string' ? record.selectedNodeId : null,
      collapseOverrides: Array.isArray(record.collapseOverrides)
        ? /** @type {[string, boolean][]} */ (record.collapseOverrides.filter((entry) => Array.isArray(entry)
            && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'))
        : /** @type {[string, boolean][]} */ ([]),
      scrollAnchor: anchor && typeof anchor.nodeId === 'string'
        ? { nodeId: anchor.nodeId, offset: Number(anchor.offset) || 0 }
        : null,
      scrollTop: Number(record.scrollTop) || 0,
      currentPage: Number.isFinite(record.currentPage) && record.currentPage >= 1
        ? Math.floor(record.currentPage)
        : 1,
    };
  } catch (err) {
    console.error('Could not read where this document was left', err);
    return null;
  }
}

/** @typedef {NonNullable<Awaited<ReturnType<typeof loadViewState>>>} ViewState */

/**
 * Whether `view` was taken from the tree that is now open. Everything the
 * record holds is keyed by node id, so this is all-or-nothing: a record that
 * fails here is worth nothing at all, rather than worth a best effort.
 *
 * @param {ViewState | null} view
 */
function viewStateApplies(view) {
  return !!view && !!state.tree && view.treeSignature === currentTreeSignature();
}

/**
 * Puts back the expanded/collapsed rows, and answers which tag to select -
 * null meaning "nothing usable remembered, land wherever you would have
 * anyway". Ids missing from the reopened document are dropped rather than
 * trusted, the same way selectNodes() drops them.
 *
 * Doesn't render: the caller's selectNode() does that anyway, and expanding
 * rows only to redraw them a line later is a visible flicker on a big tree.
 *
 * @param {ViewState | null} view
 * @returns {string | null}
 */
export function applyRememberedTreeState(view) {
  if (!viewStateApplies(view)) return null;
  const record = /** @type {ViewState} */ (view);
  for (const [nodeId, collapsed] of record.collapseOverrides) {
    if (state.nodesById.get(nodeId)?.node.type === 'element') {
      state.collapseOverrides.set(nodeId, collapsed);
    }
  }
  const selected = record.selectedNodeId;
  if (!selected || !state.nodesById.has(selected) || selected === state.hiddenDocumentId) return null;
  return selected;
}

/**
 * The page the preview was left on. Only worth applying when the remembered
 * selection doesn't already answer it: selecting a tag jumps the preview to
 * that tag's own page, which is the more specific answer and the one that
 * matches the tree.
 *
 * @param {ViewState | null} view
 * @returns {number | null}
 */
export function rememberedPage(view) {
  if (!viewStateApplies(view)) return null;
  const record = /** @type {ViewState} */ (view);
  return record.currentPage >= 1 && record.currentPage <= state.pageCount ? record.currentPage : null;
}

/**
 * Whether the document was being read in Proofread Mode when it was last
 * closed (View > Proofread).
 *
 * Only ever used to turn the mode ON. Nothing here turns it off: the mode is
 * a way of working the user has chosen for the session they are in, and
 * dropping them out of it because the file they just opened has a history of
 * being read outside it would be the app overruling a live decision with a
 * stale one. Opening a document while proofreading therefore stays in the
 * mode, exactly as it did before any of this was remembered.
 *
 * @param {ViewState | null} view
 */
export function rememberedProofreadMode(view) {
  return viewStateApplies(view) && /** @type {ViewState} */ (view).proofreadMode;
}

/**
 * Puts the tag tree back where it was scrolled to. Must run after the
 * selection has been restored: selecting a tag expands its ancestors and
 * scrolls its row into view, which moves the tree out from under any scroll
 * position set before it.
 *
 * Skipped when the tree filter has moved on since the record was written -
 * the rows on screen are then a different list, and a position within the
 * old one would land somewhere arbitrary in the new one. The selected tag is
 * still restored in that case; it's only the scroll offset that has nothing
 * to say.
 *
 * @param {ViewState | null} view
 */
export function applyRememberedScroll(view) {
  if (!viewStateApplies(view)) return;
  const record = /** @type {ViewState} */ (view);
  if (record.filter !== state.filter) return;
  const anchor = record.scrollAnchor;
  const row = anchor
    ? el.tagTree.querySelector(`.tree-row[data-node-id="${CSS.escape(anchor.nodeId)}"]`)
    : null;
  if (row && anchor) {
    const paneTop = el.tagTree.getBoundingClientRect().top;
    // Scroll by however far the anchor row currently sits from where it
    // belongs: `offset` pixels above the pane's own top edge.
    el.tagTree.scrollTop += row.getBoundingClientRect().top - (paneTop - anchor.offset);
  } else {
    // The anchor row isn't rendered (collapsed under something, or filtered
    // out). The raw offset is the best remaining answer.
    el.tagTree.scrollTop = record.scrollTop;
  }
}

// The tag tree's own scrolling is the one move that changes the remembered
// position without going through a render, so it needs its own trigger. The
// rest - selecting, expanding, collapsing, filtering, editing - all end up
// in renderTree(), which calls rememberViewState() itself.
el.tagTree.addEventListener('scroll', rememberViewState, { passive: true });

// Last chance to get the current position onto disk. The window's close
// button is handled entirely in the main process (see the 'close' handler in
// createWindow(), main.js), so nothing in the renderer gets to run an
// orderly shutdown first - this fires while the page is being torn down, and
// is best-effort on top of the debounced saves rather than instead of them.
window.addEventListener('pagehide', flushViewState);
