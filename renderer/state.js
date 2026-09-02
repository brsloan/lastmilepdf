// state.js
//
// The renderer's single mutable `state` object, plus the app-wide constants
// that other modules need to agree on.
//
// This module deliberately has no imports: everything else in the renderer
// imports it, so keeping it a leaf is what stops the module graph developing
// cycles. The walk-speed helpers live here rather than in walk.js because
// `state` calls loadWalkSpeed() as part of its own initialization.

// Referenced by loadWalkSpeed() below, which runs immediately as part of
// `state`'s own initialization - must be declared (not just hoisted, which
// wouldn't be enough for `const`) before that point.
const WALK_SPEED_STORAGE_KEY = 'pdfTagEditor.walkTagsPerSecond';

const WALK_SPEED_DEFAULT = 1;

export const WALK_SPEED_MIN = 0.5;

export const WALK_SPEED_MAX = 10;

export const WALK_SPEED_STEP = 0.5;

export const APP_NAME = 'LastMilePDF';

/** @type {import('../types/app-state').AppState} */
export const state = {
  docId: null,
  fileName: null,
  savedFilePath: null,  // path last used to save this doc (Save As sets it; Save reuses it), reset per document
  tree: null,           // current full tag tree, as returned by the worker
  nodesById: new Map(), // id -> node, rebuilt every time `tree` is replaced
  hiddenDocumentId: null, // id of the sole top-level /Document wrapper, or null - see findHiddenDocumentWrapperId() in tree-index.js
  mcidIndex: new Map(), // page (0-based) -> Map(mcid -> owning element node id), rebuilt with nodesById
  selectedNodeId: null,      // the "active"/most-recently-clicked tag - drives the details panel, highlight, scroll
  selectedNodeIds: new Set(), // full multi-selection (shift/ctrl+click); always a superset containing selectedNodeId
  selectionAnchorId: null,   // fixed point shift+click range-selects from; updated by plain/ctrl clicks, not by shift+click
  activePanel: 'properties', // 'properties' | 'bookmarks' - which details-pane tab is showing
  outline: null,             // current bookmark tree, as returned by the worker (null before a doc is opened)
  bookmarksById: new Map(),  // id -> { node, parentId }, rebuilt every time `outline` is replaced - mirrors nodesById
  selectedBookmarkId: null,
  draggedNodeId: null,
  draggedNodeIds: null,
  pdfDoc: null,          // pdf.js document proxy
  currentPage: 1,
  pageCount: 0,
  renderTask: null,      // in-flight pdf.js RenderTask, so a new page render can cancel it
  renderToken: 0,        // invalidates a render whose getPage() await was overtaken - see renderCurrentPage()
  dirty: false,          // tag edits made since the last save - see markDirty()
  canUndo: false,        // mirrors the Edit menu's Undo/Redo enabled state - see applyUndoState()
  canRedo: false,
  textContentCache: new Map(), // page number -> { textContent, viewport }, reset per document
  mcidTextCache: new Map(),    // page number -> Map(mcid -> text), reset per document
  mcidGraphicsCache: new Map(), // page number -> { imageRects, vectorMcids }, reset per document
  highlightToken: 0,           // invalidates in-flight highlight computations when selection/doc changes
  tablePreviewToken: 0,        // invalidates in-flight table-preview builds when selection/doc changes
  actualTextPlaceholderToken: 0, // invalidates in-flight Actual Text placeholder pulls when selection/doc changes
  splitContentToken: 0,          // invalidates an in-flight get_leaf_text() pull superseded by a newer one - see split-content.js
  splitContentNodeId: null,      // the content leaf the Split Content panel currently shows, or null
  tableEditorToken: 0,          // invalidates in-flight Table Editor dialog builds (see renderTableEditor())
  tableEditorTableId: null,     // id of the Table tag currently open in the Table Editor dialog
  tableEditorSelectedIds: new Set(), // selected TH/TD cell ids within the Table Editor
  tableEditorAnchorId: null,    // last explicitly clicked/arrow-selected cell, for shift-click range selection
  tableEditorGrid: null,        // { positions, colCount } from the most recent renderTableEditor() build
  collapseOverrides: new Map(), // nodeId -> boolean, explicit user toggles (absence = use the role-based default)
  filter: 'all',                // 'all' | 'headings' | 'figures' | 'table' - see renderFilteredTree()
  walking: false,               // true while the Walk button's auto-advance is running
  walkTimerId: null,
  walkSpeed: loadWalkSpeed(),   // tags per second; persisted across sessions, see loadWalkSpeed()/saveWalkSpeed()
  figureDrawActive: false,      // true while the Add Figure button's rubber-band draw mode is armed
  figureDrawRect: null,         // { start: {x,y}, current: {x,y} } in canvas-pixel space, while dragging
  docInfo: { title: null, author: null }, // PDF document-info Title/Author, shown when the /Document tag is selected
  hasStructTree: false, // whether the current document has a /StructTreeRoot at all - used by the Verify report
  aiProposals: new Map(), // nodeId -> { original, suggested } - a "Fix All Actual Text (AI)" fix already applied to that tag; kept only to render the inline diff highlight (see updateActualTextReviewUI()) and to detect a stale/reverted/edited-since tag (see pruneStaleAiProposals()) - not a pending/unsaved edit, the fix is already the tag's real Actual Text.
  findReplaceLastMatchId: null, // id most recently found/replaced by the Find/Replace dialog - see doFindNext()
  showAtChanges: false, // Tools > Show AT Changes toggle - see computeAtChangeFlags()
  proofreadMode: false, // View > Proofread toggle - see proofread.js
  pendingPulledActualTextNodeId: null, // nodeId whose Actual Text field currently shows an unconfirmed Proofread Mode content-pull (real value, but not yet applied) - see updateActualTextPlaceholder() in details.js
  showTagTypeLabel: true, // File > Settings > Preferences > Show Tag Type Label - overwritten from the persisted value shortly after startup, see the window.api.getShowTagTypeLabel() call below
  notifyDesktop: true, // File > Settings > Preferences > Desktop Notification - overwritten from the persisted value shortly after startup, see the window.api.getNotifyDesktop() call below
  notifyChime: true, // File > Settings > Preferences > Play Chime - overwritten from the persisted value shortly after startup, see the window.api.getNotifyChime() call below
  extraDeleteKeyCode: null, // File > Settings > Preferences > Extra Delete/Artifact key - a KeyboardEvent.code (e.g. "CapsLock") that also triggers the Tag Tree/Bookmarks Delete shortcut, or null when unset - overwritten from the persisted value shortly after startup, see the window.api.getExtraDeleteKeyCode() call below
  atChangeFlags: new Map(), // nodeId -> { original, suggested } - tags whose Actual Text no longer matches their pulled content text, found by the Show AT Changes sweep (computeAtChangeFlags()). Same shape as aiProposals so it shares renderActualTextDiff()/pruneStaleAiProposals(), but recomputed from the file itself rather than from in-session state, so it still works after a save/reopen.
  atChangeSweepToken: 0, // invalidates an in-flight computeAtChangeFlags() sweep superseded by a newer one (toggle off/on again, or a fresh document)
};

// Must match the scale used for page.getViewport() in renderCurrentPage() -
// the highlight overlay is computed in that same viewport's pixel space.
export const PAGE_SCALE = 1.4;

function loadWalkSpeed() {
  try {
    const raw = Number(localStorage.getItem(WALK_SPEED_STORAGE_KEY));
    if (Number.isFinite(raw) && raw >= WALK_SPEED_MIN && raw <= WALK_SPEED_MAX) return raw;
  } catch (err) {
    // localStorage unavailable (e.g. disabled storage) - fall through to default
  }
  return WALK_SPEED_DEFAULT;
}

export function saveWalkSpeed(speed) {
  try {
    localStorage.setItem(WALK_SPEED_STORAGE_KEY, String(speed));
  } catch (err) {
    // ignore - speed just won't persist this session
  }
}
