import { computeAtChangeFlags, updateActualTextReviewUI } from './actual-text.js';
import { hideAiBatchProgress, notifyAiBatchComplete, showAiBatchProgress, updateAiBatchProgressEstimate } from './ai-batch.js';
import { addBookmark, applyFreshOutline, collectHeadingsForBookmarks, deleteSelectedBookmark } from './bookmarks.js';
import { applyDetailsChange, closeDetails, refreshDetailsForSelection, scheduleLiveApply, setActivePanel } from './details.js';
import { performClose, performOpen, performSave, performSaveAs } from './doc-io.js';
import { el, selectableRows } from './dom.js';
import { applyRoleShortcut, attemptHeadingLevelChange, convertSelectionToFigure, convertSelectionToListItem, convertSelectionToParagraph, deleteSelection, groupSelectionIntoList, groupSelectionIntoTable, groupSelectionIntoTr, insertParagraphAfterSelection, joinSelection, moveSelectedSibling, performRedo, performUndo, shiftSelectedHeadingLevels } from './editing.js';
import { MIN_FIGURE_DRAW_PX, canvasPointFromEvent, renderFigureDrawRect, setFigureDrawActive } from './figure-draw.js';
import { doFindNext, findReplaceMatches, positionFindReplaceDialog } from './find-replace.js';
import { findFullPageImageLeafIds, getPageTextContent, hasDirectContentLeaf, pullContentText, pullDirectContentText } from './page-content.js';
import { caretLineExtremes, setProofreadMode, stepProofreadTag } from './proofread.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { addTableEditorColumn, addTableEditorRow, convertTableEditorSelection, deleteTableEditorSelection, refreshTableEditorAfterEdit, renderTableEditor } from './table-editor.js';
import { isDescendant, walkTree } from './tree-index.js';
import { applyFreshTree, extendSelectionTo, isNodeCollapsed, renderTree, selectNode, setTagTreeScrollSpacersActive, toggleNodeCollapsed } from './tree-view.js';
import { renderVerifyResults } from './verify.js';
import { findNodeAtPoint, goToPageFromIndicatorInput, highlightNodeOnPage, refreshPdfPreviewBytes, renderCurrentPage, setProofreadScrollSpacersActive, syncHighlightLayerBounds, updatePageNavUI } from './viewer.js';
import { adjustWalkSpeed, startWalking, stopWalking } from './walk.js';

// renderer.js
//
// Vanilla JS, no framework, no bundler. Loaded as an ES module directly by
// index.html. Talks to the main process only through `window.api`, which
// preload.js attaches - there is no Node/fs access here.

// --- app state ---------------------------------------------------------

// --- DOM refs -----------------------------------------------------------

// --- typed element lookups ----------------------------------------------
//
// document.getElementById() is typed `HTMLElement | null`, which knows about
// neither `.value`/`.disabled`/`.showModal()` nor the fact that every id
// below is a static, always-present part of renderer/index.html. These
// wrappers say which kind of element each id refers to, so the ~170 uses of
// those properties further down are checked rather than silently untyped.
//
// The cast is an assertion, not a check: if an id is renamed in index.html
// without being renamed here, this still compiles and the app breaks at
// runtime exactly as it did before. What it does buy is that *using* a ref
// the wrong way - `el.tagFilter.checked`, say - is now an error.

// --- role -> visual category (drives tag-chip color) ---------------------

// --- tag tree: build the nodesById index -------------------------------

// --- tag tree: rendering --------------------------------------------------

// --- tag tree: filtering ---------------------------------------------------
//
// "Headings" swaps the nested tree for a flat, document-order list of just
// the matching tags (any heading level counts as a match, ignoring how deep
// they're nested) - handy for skimming an outline without wading through
// containers. Since it's a flat list, drag reordering doesn't apply here:
// filtered rows are plain, non-draggable, and get no drop handlers, which is
// what disables moving tags while filtered.
// "Figures" and "Table" instead keep each matching node's real subtree
// intact - only the path down to each match is flattened/skipped, not its
// contents - so alt text, captions, rows/cells, and other nested structure
// stay browsable with normal collapse/expand (rendered via renderTreeNode,
// same as the unfiltered tree). A match nested inside another match of the
// same filter isn't listed again at the top level; it just shows up as part
// of its parent's subtree.
// Up/down arrow navigation keeps working unchanged, since it just walks
// whatever `.tree-row.selectable` rows are currently in the DOM.

// --- details pane tabs ------------------------------------------------

el.tabProperties.addEventListener('click', () => setActivePanel('properties'));

el.tabBookmarks.addEventListener('click', () => setActivePanel('bookmarks'));

// --- bookmarks panel --------------------------------------------------
//
// A separate tree from the tag tree (PDF bookmarks/outlines live in their
// own /Outlines object graph, not /StructTreeRoot - see tag_worker.py), but
// rendered the same visual way: nested rows reusing .tree-row/.tree-children
// so a bookmark's children read exactly like a tag's do. Ids ("bN") are, like
// tag node ids, a fresh depth-first counter assigned on every worker
// response - never assumed stable across a mutation.

window.addEventListener('keydown', (e) => {
  if (!isDeleteShortcut(e)) return;
  if (state.activePanel !== 'bookmarks' || !state.selectedBookmarkId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  deleteSelectedBookmark();
});

el.btnAddBookmark.addEventListener('click', () => {
  addBookmark();
});

el.btnGenerateBookmarks.addEventListener('click', async () => {
  if (!state.docId) return;
  if (!state.pdfDoc) {
    setStatus('Open a PDF preview before generating bookmarks.');
    return;
  }
  document.body.classList.add('busy');
  try {
    setStatus('Generating bookmarks from headings…');
    const headings = await collectHeadingsForBookmarks();
    const result = await window.api.generateBookmarks(state.docId, headings);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    applyUndoState(result);
    setStatus(headings.length > 0
      ? `Generated ${headings.length} bookmark${headings.length === 1 ? '' : 's'} from headings.`
      : 'No headings found - bookmarks cleared.');
  } catch (err) {
    reportError('Could not generate bookmarks', err);
  } finally {
    document.body.classList.remove('busy');
  }
});

// --- details panel --------------------------------------------------------
//
// Multi-select (shift/ctrl+click - see handleRowClick) keeps a single
// "active" tag (state.selectedNodeId) alongside the full selection
// (state.selectedNodeIds, always a superset containing the active one). The
// active tag drives the details panel's displayed values, page highlight,
// and scroll; the full selection drives which rows get the 'multi-selected'
// look, which tags a block drag/move carries, and which tags a Role change
// applies to (see the details form's submit handler).

// --- tag -> content highlight -------------------------------------------
//
// Selecting a tag highlights the marked content it wraps on the page
// preview. We get exact positions from pdf.js's own text layout (font
// metrics, CID widths, etc. already resolved) via
// `getTextContent({ includeMarkedContent: true })`, which interleaves
// ordinary text items with begin/end markers carrying the MCID of the
// marked-content span they bracket - we just track which MCIDs belong to
// the selected tag's subtree (see `collectTargetMcids`), collect the text
// items that fall inside a matching span, and draw a single box around
// their union rather than one box per run (which got noisy and overlapped
// for multi-line/multi-word content).
//
// A Figure/Formula's marked content is normally an image `Do` call or a
// stroked/filled vector path, neither of which getTextContent() reports -
// those rects come from a separate path, getPageGraphicRects(), that walks
// the page's operator list instead (see below).

// --- "Fix All Actual Text (AI)" review UI ---------------------------------
//
// A batch fix (see el.btnFixAllActualText below) doesn't write anything to
// the PDF by itself - it only populates state.aiProposals with
// { original, suggested } per tag id. Selecting a tag with a pending
// proposal shows the suggested text in the (still fully editable) textarea,
// with a highlighted copy of it rendered behind the textarea's own
// (temporarily transparent) text - see the .actual-text-box/.actual-text-
// -highlight CSS. Accept/Reject below resolve the proposal one tag at a
// time while stepping through the tree.

// Keeps the (invisible-text) textarea and the highlighted copy behind it
// scrolling together - only vertical matters in practice since both wrap
// (white-space: pre-wrap), but syncing both is harmless.
el.fieldActualText.addEventListener('scroll', () => {
  el.actualTextHighlight.scrollTop = el.fieldActualText.scrollTop;
  el.actualTextHighlight.scrollLeft = el.fieldActualText.scrollLeft;
});

// Typing directly into a proposal takes ownership of the exact wording -
// drop the proposal and fall back to plain editing rather than keep showing
// a diff against text the user has now moved past.
el.fieldActualText.addEventListener('input', () => {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId || (!state.aiProposals.has(nodeId) && !state.atChangeFlags.has(nodeId))) return;
  state.aiProposals.delete(nodeId);
  state.atChangeFlags.delete(nodeId);
  el.fieldActualText.classList.remove('actual-text-reviewing');
  el.actualTextHighlight.classList.remove('visible');
  el.actualTextHighlight.innerHTML = '';
  el.actualTextReviewBar.hidden = true;
  renderTree(); // drop that row's "AI fix"/"AT changed" flag
});

// Typing into a Proofread Mode content-pull that was still sitting
// unconfirmed (see updateActualTextPlaceholder() in details.js) turns it
// into a real edit from here on - applyDetailsChange() only skips saving
// Actual Text while this flag is set, so it has to come off the moment the
// user actually changes anything.
el.fieldActualText.addEventListener('input', () => {
  if (state.pendingPulledActualTextNodeId === el.fieldNodeId.value) {
    state.pendingPulledActualTextNodeId = null;
  }
});

// Discards this tag's AI fix (or, in Show AT Changes mode, its flagged
// difference) by re-pulling its content leaf's raw text (same source "Pull
// Content" uses) and saving that in place of it - no "original" value is
// kept in state to revert to; it's re-derived fresh every time, same as if
// the user clicked Pull Content themselves right now. If the tag has no
// content leaf (nothing to pull), this clears Actual Text entirely rather
// than silently doing nothing.
el.btnRevertAiFix.addEventListener('click', async () => {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId || (!state.aiProposals.has(nodeId) && !state.atChangeFlags.has(nodeId))) return;
  try {
    setStatus('Reverting to the tag’s original content…');
    el.btnRevertAiFix.disabled = true;
    const original = (await pullContentText(nodeId)) || '';
    if (el.fieldNodeId.value !== nodeId) return; // selection changed mid-flight
    el.fieldActualText.value = original;
    state.aiProposals.delete(nodeId);
    state.atChangeFlags.delete(nodeId);
    await applyDetailsChange(); // persists via the normal update path, which also re-renders the tree/field
    setStatus('Reverted to the tag’s original content.');
  } catch (err) {
    reportError('Could not revert', err);
  } finally {
    if (el.fieldNodeId.value === nodeId) el.btnRevertAiFix.disabled = false;
  }
});

// File > Settings > Preferences > Appearance/Notifications - persisted in
// settings.json via main.js (not localStorage) so it's remembered between
// sessions; this loads the renderer's copy at startup and the Preferences
// dialog below keeps it in sync when the user changes it.
window.api.getShowTagTypeLabel().then((value) => {
  state.showTagTypeLabel = value;
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

window.api.getNotifyDesktop().then((value) => { state.notifyDesktop = value; });

window.api.getNotifyChime().then((value) => { state.notifyChime = value; });

window.api.getExtraDeleteKeyCode().then((value) => { state.extraDeleteKeyCode = value; });

window.api.getAutoSaveEnabled().then((value) => { state.autoSaveEnabled = value; });

// Friendly names for the KeyboardEvent.code values a user is likely to pick
// as their extra Delete key (see the recorder below) - falls back to
// stripping the Key/Digit prefix off a letter/digit code, then to splitting
// an unrecognized code's camelCase (e.g. "IntlBackslash" -> "Intl Backslash")
// so it's never blank.
const KEY_CODE_LABELS = {
  CapsLock: 'Caps Lock',
  Tab: 'Tab',
  Space: 'Space',
  Escape: 'Esc',
  Backquote: '`',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
};

function formatKeyCode(code) {
  if (!code) return 'Not set';
  if (KEY_CODE_LABELS[code]) return KEY_CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function updateDeleteKeyDisplay() {
  el.preferencesDeleteKeyDisplay.textContent = formatKeyCode(state.extraDeleteKeyCode);
  el.btnClearDeleteKey.hidden = !state.extraDeleteKeyCode;
}

// Delete also fires on this extra key, if the user has set one - see the
// two Delete keydown handlers below (bookmarks panel, tag tree).
function isDeleteShortcut(e) {
  return e.key === 'Delete' || (!!state.extraDeleteKeyCode && e.code === state.extraDeleteKeyCode);
}

window.api.onMenuPreferences(() => {
  el.preferencesShowTagTypeLabel.checked = state.showTagTypeLabel;
  el.preferencesAutoSave.checked = state.autoSaveEnabled;
  el.preferencesNotifyDesktop.checked = state.notifyDesktop;
  el.preferencesNotifyChime.checked = state.notifyChime;
  updateDeleteKeyDisplay();
  el.preferencesDialog.showModal();
});

el.btnClosePreferences.addEventListener('click', () => el.preferencesDialog.close());

el.preferencesDialog.addEventListener('click', (e) => {
  if (e.target === el.preferencesDialog) el.preferencesDialog.close();
});

el.preferencesShowTagTypeLabel.addEventListener('change', () => {
  const checked = el.preferencesShowTagTypeLabel.checked;
  state.showTagTypeLabel = checked;
  window.api.setShowTagTypeLabel(checked);
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

el.preferencesAutoSave.addEventListener('change', () => {
  state.autoSaveEnabled = el.preferencesAutoSave.checked;
  window.api.setAutoSaveEnabled(state.autoSaveEnabled);
});

el.preferencesNotifyDesktop.addEventListener('change', () => {
  state.notifyDesktop = el.preferencesNotifyDesktop.checked;
  window.api.setNotifyDesktop(state.notifyDesktop);
});

el.preferencesNotifyChime.addEventListener('change', () => {
  state.notifyChime = el.preferencesNotifyChime.checked;
  window.api.setNotifyChime(state.notifyChime);
});

// Recorded in the capture phase and stopped from propagating further, so
// the keypress that sets/replaces the extra Delete key can't also fall
// through to the app's other keydown handlers (Delete itself, the P/L/I/T/…
// role shortcuts, etc.) further down this file.
el.btnRecordDeleteKey.addEventListener('click', () => {
  el.preferencesDeleteKeyDisplay.textContent = 'Press a key…';
  el.btnRecordDeleteKey.disabled = true;
  const onKeydown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', onKeydown, true);
    el.btnRecordDeleteKey.disabled = false;
    if (e.key === 'Escape') {
      updateDeleteKeyDisplay();
      return;
    }
    state.extraDeleteKeyCode = e.code;
    window.api.setExtraDeleteKeyCode(e.code);
    updateDeleteKeyDisplay();
  };
  window.addEventListener('keydown', onKeydown, true);
});

el.btnClearDeleteKey.addEventListener('click', () => {
  state.extraDeleteKeyCode = null;
  window.api.setExtraDeleteKeyCode(null);
  updateDeleteKeyDisplay();
});

window.api.onMenuShowAtChanges(async (_event, checked) => {
  state.showAtChanges = checked;
  if (!checked) {
    state.atChangeFlags = new Map();
    renderTree();
    updateActualTextReviewUI(state.selectedNodeIds.size > 1 ? null : state.selectedNodeId);
    setStatus('Hid Actual Text change highlighting.');
    return;
  }
  setStatus('Scanning tags for Actual Text changed from content…');
  await computeAtChangeFlags();
  renderTree();
  updateActualTextReviewUI(state.selectedNodeIds.size > 1 ? null : state.selectedNodeId);
  setStatus(state.atChangeFlags.size > 0
    ? `Found ${state.atChangeFlags.size} tag${state.atChangeFlags.size === 1 ? '' : 's'} with Actual Text changed from content - flagged in the tag tree.`
    : 'No tags have Actual Text that differs from their pulled content.');
});

// View > Proofread - see proofread.js for the layout/field-hiding toggle
// itself and the tag-to-tag stepping the keydown handlers below drive.
window.api.onMenuProofread(async (_event, checked) => {
  await setProofreadMode(checked);
  setStatus(checked
    ? 'Proofread Mode on - Page Down/Up (or Up/Down at the edges of Actual Text) steps through tags.'
    : 'Proofread Mode off.');
});

// --- table tag -> generated HTML preview ---------------------------------
//
// Selecting a Table tag swaps its Actual Text field for a read-only preview
// built from the tag's own row/cell structure (see refreshDetailsForSelection()).

// --- table editor (Expand dialog's interactive variant) ------------------
//
// Same generated table as the read-only preview above, but with an extra
// leading row/column of arrow buttons for whole row/column selection and a
// fields section (see index.html) below for editing the selected cells'
// Scope/Column span/Row span or converting them between TH/TD. Every edit
// goes through the same update APIs the main details panel uses, then
// rebuilds this table from the resulting fresh tree - there's no separate
// "editor" copy of the data, just a different view onto the same nodes.

el.tableEditorForm.addEventListener('submit', (e) => e.preventDefault());

el.tableEditorForm.addEventListener('change', async () => {
  const ids = Array.from(state.tableEditorSelectedIds).filter((id) => state.nodesById.has(id));
  if (ids.length === 0) return;

  const changes = {};
  if (!el.tableEditorScopeWrap.hidden) changes.scope = el.tableEditorScope.value;
  changes.colSpan = el.tableEditorColSpan.value.trim();
  changes.rowSpan = el.tableEditorRowSpan.value.trim();

  try {
    const result = await window.api.updateNodes(state.docId, ids, changes);
    applyFreshTree(result.tree);
    applyUndoState(result);
    state.tableEditorSelectedIds = new Set(ids.filter((id) => state.nodesById.has(id)));
    await refreshTableEditorAfterEdit();
    setStatus(`Updated ${ids.length} table cell${ids.length === 1 ? '' : 's'}.`);
  } catch (err) {
    reportError('Could not update table cells', err);
  }
});

el.btnTableEditorToTh.addEventListener('click', () => convertTableEditorSelection('TH'));

el.btnTableEditorToTd.addEventListener('click', () => convertTableEditorSelection('TD'));

el.btnTableEditorAddRow.addEventListener('click', () => addTableEditorRow());

el.btnTableEditorAddColumn.addEventListener('click', () => addTableEditorColumn());

// The Table Editor is a modal dialog, but none of the app's *keyboard*
// shortcuts know that - they all live on window/document (role shortcuts,
// arrow-key tree nav, Ctrl+Z/Y, Ctrl+P, Delete...) and only check whether
// document.activeElement is an INPUT/TEXTAREA/SELECT before acting, not
// whether a modal dialog is open over everything. Since this dialog's own
// UI has plenty of keydown targets that AREN'T text fields - the row/column
// arrows, the cells themselves between edits - any stray keystroke while
// one of those (or nothing) has focus falls straight through to those
// global handlers and acts on whatever's still selected in the tree behind
// the modal, e.g. the very Table tag this dialog has open: a role-shortcut
// letter ('t'/'d'/'h'/'p'/...) silently relabels it, an arrow key moves the
// tree selection, Ctrl+Z undoes something unrelated - all invisibly, since
// this dialog is on top. Stopping propagation here, unconditionally, for
// every key (not just the Delete case below) is what actually isolates it.
// Native behavior *inside* the dialog - typing in the inline cell editor or
// the Scope/Span fields, Escape-to-close, Tab focus-trapping - is
// unaffected: stopPropagation() only blocks the event from reaching
// ancestors further out, never the target's own listeners or the browser's
// own default handling. isDeleteShortcut() isn't defined yet at module-eval
// time when this listener is registered, but it only needs to exist by the
// time a keydown actually happens, so that's fine.
el.tablePreviewDialog.addEventListener('keydown', (e) => {
  e.stopPropagation();
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!isDeleteShortcut(e)) return;
  e.preventDefault();
  deleteTableEditorSelection();
});

// --- content -> tag selection (reverse of the above) ---------------------
//
// Clicking the PDF preview hit-tests the current page's text items against
// the click point, walking the same begin/end-marked-content markers to
// find which MCID (if any) the clicked run belongs to, then looks up the
// struct element that directly owns that MCID via `state.mcidIndex` and
// selects it. Falls back to the image/vector-path rects (see
// getPageGraphicRects) so clicking a Figure's picture or drawing also
// selects its tag.

el.canvas.addEventListener('click', async (e) => {
  // A completed rubber-band drag still fires a native 'click' on mouseup
  // (mousedown and mouseup landed on the same element) - while Add Figure's
  // draw mode is active, that click means "finished drawing", not "select
  // the tag under the cursor", so it's handled entirely by the mouseup
  // listener below instead.
  if (!state.pdfDoc || state.figureDrawActive) return;
  const rect = el.canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (el.canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (el.canvas.height / rect.height);

  try {
    const nodeId = await findNodeAtPoint(x, y);
    if (nodeId) selectNode(nodeId);
  } catch (err) {
    console.error('Could not resolve tag at click point:', err);
  }
});

window.addEventListener('resize', () => {
  if (state.pdfDoc) syncHighlightLayerBounds();
  // Both spacers are sized from their pane's clientHeight at the moment they
  // grow, so a resize leaves them measured against the old layout - too short
  // to still align a tag sitting at the very top/bottom, until the next
  // selection happens to regrow them. Re-measure now instead; each call also
  // compensates its pane's scrollTop by the delta, so the view stays put.
  if (state.proofreadMode) {
    setProofreadScrollSpacersActive(true);
    setTagTreeScrollSpacersActive(true);
  }
});

el.detailsForm.addEventListener('input', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.tagName === 'SELECT') return;
  scheduleLiveApply();
});

// Still needed for select elements (immediate on pick) and as the
// immediate-commit path when a field is blurred before the live-apply timer
// above fires - applyDetailsChange() clears that pending timer itself, so
// this never double-applies.
el.detailsForm.addEventListener('change', applyDetailsChange);

// Splits the leaf the Split Content panel is currently showing at the
// field's own cursor position - backs both the Split button and pressing
// Enter in the field below. Reselects the first of the two new leaves
// afterward (which re-populates this same panel with its now-shorter text
// via refreshDetailsForSelection()), so the row the user was just looking
// at stays selected/scrolled-to rather than the selection silently
// dropping.
async function performSplitContent() {
  const nodeId = state.splitContentNodeId;
  if (!nodeId || !state.docId || el.btnSplitContent.disabled) return;
  const splitIndex = el.splitContentField.selectionStart;

  try {
    el.btnSplitContent.disabled = true;
    const result = await window.api.splitLeaf(state.docId, nodeId, splitIndex);
    // split_leaf() is the one command that rewrites a page's content
    // stream - re-feed pdf.js the resulting bytes, and clear the stale
    // per-page text/graphics caches that come with it, *before* applying
    // the fresh tree below. applyFreshTree() re-renders every tree row
    // synchronously, and a content leaf's row text is filled in from
    // whatever's already cached for its page (see formatCachedLeafText() in
    // tree-view.js) - doing this the other way around would render the two
    // new leaves once against the pre-split cache (wrong/missing text) with
    // nothing left to trigger a second render once the real bytes arrived.
    if (state.pdfDoc) await refreshPdfPreviewBytes(result.pdfBase64);
    applyFreshTree(result.tree);
    applyUndoState(result);
    const [firstId] = result.newNodeIds;
    if (firstId && state.nodesById.has(firstId)) {
      selectNode(firstId);
    }
    setStatus('Split content into two.');
  } catch (err) {
    reportError('Could not split this content', err);
    el.btnSplitContent.disabled = false;
  }
}

el.btnSplitContent.addEventListener('click', performSplitContent);

// The field isn't actually editable - split_leaf() only ever reads its
// cursor position, never any typed change - but it also isn't marked
// `readonly` in index.html, because Chromium doesn't render a visible/
// blinking caret (or respond to arrow-key navigation) in a readonly
// textarea. A plain editable textarea gets normal click-to-position,
// arrow-key, Home/End, and shift-select caret behavior for free; this
// listener just vetoes the one thing that shouldn't happen - the text
// actually changing - by blocking every edit-producing 'beforeinput' (typed
// characters, paste, delete/backspace, ...). Caret movement and selection
// don't fire 'beforeinput' at all, so they're untouched.
el.splitContentField.addEventListener('beforeinput', (e) => e.preventDefault());

// Enter splits at the cursor same as clicking the button, instead of the
// newline a plain textarea would otherwise insert there.
el.splitContentField.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  performSplitContent();
});

el.btnPullContent.addEventListener('click', async () => {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;
  if (!state.pdfDoc) {
    setStatus('Open a PDF preview before pulling content text.');
    return;
  }
  try {
    setStatus('Pulling content text…');
    const text = await pullContentText(nodeId);
    if (el.fieldNodeId.value !== nodeId) return; // selection changed mid-flight
    el.fieldActualText.value = text;
    setStatus(text ? 'Pulled content text into Actual Text.' : 'No content text found in this tag.');
  } catch (err) {
    reportError('Could not pull content text', err);
  }
});

// Sends the current Actual Text through the user's own AI provider key
// (see File > Settings > API Key…) to clean up OCR/transcription errors, replacing
// the field in place. Opt-in per click rather than run automatically on
// every pull - an accessibility-critical field is worse off silently
// "fixed" wrong than left as raw OCR output the user can still review.
el.btnFixActualText.addEventListener('click', async () => {
  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;
  const text = el.fieldActualText.value.trim();
  if (!text) {
    setStatus('Nothing in Actual Text to fix.');
    return;
  }
  try {
    setStatus('Fixing Actual Text with AI…');
    el.btnFixActualText.disabled = true;
    const fixed = await window.api.fixActualText(text);
    if (el.fieldNodeId.value !== nodeId) return; // selection changed mid-flight
    el.fieldActualText.value = fixed;
    // Commit explicitly rather than relying on the form's native 'change'
    // event (el.detailsForm's 'change' listener, see applyDetailsChange()
    // below) - that only fires on blur if the textarea was focused when its
    // value changed, which isn't the case here since the click never
    // focused the field, so it would otherwise sit there unsaved until the
    // user happened to edit it further.
    await applyDetailsChange();
    setStatus('Fixed Actual Text with AI.');
  } catch (err) {
    reportError('Could not fix Actual Text with AI', err);
  } finally {
    if (el.fieldNodeId.value === nodeId) el.btnFixActualText.disabled = false;
  }
});

// Not user-dismissable - it just reflects an in-flight request, so Escape
// (which would otherwise fire 'cancel' then close the native <dialog>) is
// suppressed; only hideAiBatchProgress() ever closes it.
el.aiBatchProgressDialog.addEventListener('cancel', (e) => e.preventDefault());

// Sends every tag's current Actual Text to AI in one request (see
// ai:fix-actual-text-batch in main.js), so the model can keep proper nouns,
// abbreviations, and technical terms consistent across the whole document -
// something it can't do looking at one tag in isolation. Every changed tag
// is written immediately, as one undo step (see tags:update-actual-texts /
// update_actual_texts() in tag_worker.py) - the fix is accepted by default,
// not held pending. state.aiProposals then only remembers each changed
// tag's pre-fix text long enough to render the inline diff highlight (see
// updateActualTextReviewUI()) and flag its tag-tree row - stepping through
// the tree and clicking Revert (above) is how you back one out.
el.btnFixAllActualText.addEventListener('click', async () => {
  if (!state.tree) return;

  el.btnFixAllActualText.disabled = true;
  showAiBatchProgress();
  try {
    // A tag that already has Actual Text is sent as-is. A tag with none,
    // but a content leaf directly inside it, has that leaf's raw text
    // pulled first - scoped to just its own directly-nested leaves
    // (pullDirectContentText(), not the whole-subtree pullContentText() the
    // single-tag "Pull Content" button uses) - so the model sees the whole
    // document's text, giving it the full context for cross-tag consistency
    // instead of just the fields someone already filled in by hand, without
    // resending a nested element's text twice under both its own id and an
    // ancestor's. Table/Document tags are skipped - their Actual Text field
    // is swapped out for a table preview / doc-info fields respectively (see
    // refreshDetailsForSelection()), so a highlight for one could never be
    // shown.
    const candidates = [];
    walkTree(state.tree, (node) => {
      if (node.type !== 'element' || node.role === 'Table' || node.role === 'Document') return;
      if (node.actualText && node.actualText.trim()) {
        candidates.push({ id: node.id, text: node.actualText });
      } else if (state.pdfDoc && hasDirectContentLeaf(node)) {
        candidates.push({ id: node.id, text: null }); // text pulled below
      }
    });

    const toPull = candidates.filter((candidate) => candidate.text === null);
    if (toPull.length > 0) {
      setStatus(`Pulling content text from ${toPull.length} tag${toPull.length === 1 ? '' : 's'} with no Actual Text yet…`);
      for (const candidate of toPull) {
        candidate.text = (await pullDirectContentText(candidate.id)) || '';
      }
    }

    const items = candidates.filter((candidate) => candidate.text && candidate.text.trim());
    if (items.length === 0) {
      setStatus('No tags have Actual Text (or pullable content) to fix.');
      return;
    }

    setStatus(`Fixing Actual Text across ${items.length} tag${items.length === 1 ? '' : 's'} with AI…`);
    const requestItems = items.map(({ id, text }) => ({ id, text }));
    // Same size main.js's estimateAiBatchMs() keys its average on (it charges
    // the char count of the JSON it actually sends - see JSON.stringify(items)
    // in the ai:fix-actual-text-batch handler) - so the estimate lines up with
    // what recordAiBatchTiming() will log for this run.
    updateAiBatchProgressEstimate(await window.api.estimateAiBatchTime(JSON.stringify(requestItems).length));
    const results = await window.api.fixActualTextBatch(requestItems);
    const byId = new Map(items.map((item) => [item.id, item]));
    /** @type {Record<string, string>} */
    const updates = {};
    const proposals = new Map();
    for (const result of results) {
      const candidate = byId.get(result.id);
      // Ignore any id the model returned that wasn't in the request, and
      // skip anything it says needs no change - no point writing/flagging a
      // "fix" that changes nothing (and, for a pulled-content tag, no point
      // filling in Actual Text with a pull the AI found nothing to correct
      // in - that's a separate feature from fixing transcription errors).
      if (!candidate || result.text === candidate.text) continue;
      updates[result.id] = result.text;
      proposals.set(result.id, { original: candidate.text, suggested: result.text });
    }

    if (Object.keys(updates).length === 0) {
      setStatus('AI found no changes to make.');
      return;
    }

    const result = await window.api.updateActualTexts(state.docId, updates);
    state.aiProposals = proposals; // set before applyFreshTree() so pruneStaleAiProposals() sees the fixes it just wrote
    applyFreshTree(result.tree);
    applyUndoState(result);
    refreshDetailsForSelection();
    const pulledCount = toPull.filter((candidate) => candidate.text && candidate.text.trim()).length;
    setStatus(
      `AI fixed ${proposals.size} of ${items.length} tags (${pulledCount} pulled from content with no prior Actual Text) - step through the tag tree to review (flagged rows) or Revert any of them.`,
    );
  } catch (err) {
    reportError('Could not fix Actual Text with AI', err);
  } finally {
    el.btnFixAllActualText.disabled = false;
    hideAiBatchProgress();
    notifyAiBatchComplete(el.statusBar.textContent);
  }
});

// Focusing an empty Actual Text field auto-pulls the tag's own content into
// it, same as clicking "Pull Content", when the selected tag has a content
// leaf directly inside it - saves the extra click for the common case of
// replacing a tag's own text/image/graphic content. A tag without one (or a
// field that already has a value) is left alone.
//
// In Proofread Mode this same pull instead runs from updateActualTextPlaceholder()
// in details.js, on every tag landed on rather than only on this field's
// first focus of the session - and marks it pending rather than writing a
// real, immediately-savable value, since silently reading through a run of
// untouched empty tags shouldn't leave every one of them with a real Actual
// Text nobody asked for.
el.fieldActualText.addEventListener('focus', async () => {
  if (state.proofreadMode) return;
  if (el.fieldActualText.value) return;
  const nodeId = el.fieldNodeId.value;
  if (!nodeId || !state.pdfDoc) return;
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type !== 'element' || !hasDirectContentLeaf(entry.node)) return;
  try {
    const text = await pullContentText(nodeId);
    // Selection may have moved, or the user may have typed something, while
    // the pull was in flight - don't clobber either.
    if (el.fieldActualText.value || el.fieldNodeId.value !== nodeId) return;
    if (text) {
      el.fieldActualText.value = text;
      setStatus('Pulled content text into Actual Text.');
    }
  } catch (err) {
    reportError('Could not pull content text', err);
  }
});

// Enter (not Shift+Enter, which still inserts a newline) commits the alt
// text like a blur would, then jumps to the next tag in tree order and
// keeps this field focused - lets you type alt text for a run of
// figures/tables back-to-back without reaching for the mouse. Skips over
// content/object-ref leaves since they have no alt text field of their own
// (see refreshDetailsForSelection, which hides the whole form for those).
el.fieldAlt.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();

  await applyDetailsChange();

  const rows = selectableRows();
  const currentIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectedNodeId);
  if (currentIndex === -1) return;

  const nextRow = rows.slice(currentIndex + 1).find((row) => {
    return state.nodesById.get(row.dataset.nodeId)?.node.type === 'element';
  });
  if (!nextRow) return;

  selectNode(nextRow.dataset.nodeId);
  el.fieldAlt.focus();
  el.fieldAlt.select();
});

// Proofread Mode (View > Proofread): with the caret collapsed (no range
// selected) on the field's very first line, Up jumps to the previous tag's
// Actual Text field with the caret at its end; on the very last line, Down
// jumps to the next tag's with the caret at its start - reading and fixing
// straight through a document without leaving the keyboard. Off the
// top/bottom line (a multi-line field the caret isn't at either edge of),
// or with any modifier held, this steps out of the way and lets the
// textarea move the caret up/down a line as usual.
el.fieldActualText.addEventListener('keydown', (e) => {
  if (!state.proofreadMode) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (el.fieldActualText.selectionStart !== el.fieldActualText.selectionEnd) return;

  const { isFirstLine, isLastLine } = caretLineExtremes(el.fieldActualText);
  if (e.key === 'ArrowUp' && isFirstLine) {
    e.preventDefault();
    stepProofreadTag(-1, 'end');
  } else if (e.key === 'ArrowDown' && isLastLine) {
    e.preventDefault();
    stepProofreadTag(1, 'start');
  }
});

// --- undo / redo -----------------------------------------------------------
//
// History lives entirely on the Python side (see tag_worker.py) as whole-
// document snapshots, not as an invertible list of edits. Node ids are
// freshly assigned on every tree rebuild, so a node id from before an undo
// has no reliable correspondence to "the same" element afterwards - rather
// than guess, we just clear the selection and let the user re-pick.

window.api.onMenuUndo(() => performUndo());

window.api.onMenuRedo(() => performRedo());

// The native <dialog> already closes on Escape and backdrop-click-outside
// is handled via the click listener below (clicking the dialog element
// itself only happens on the backdrop, since the visible content is inside
// a child that would catch the click first).
el.btnExpandTablePreview.addEventListener('click', () => {
  const nodeId = el.fieldNodeId.value;
  const entry = nodeId ? state.nodesById.get(nodeId) : null;
  if (!entry) return;
  state.tableEditorTableId = nodeId;
  state.tableEditorSelectedIds = new Set();
  state.tableEditorAnchorId = null;
  state.tableEditorSelectionKind = null;
  state.tableEditorSelectedRowId = null;
  state.tableEditorSelectedColIndex = null;
  renderTableEditor(entry.node);
  el.tablePreviewDialog.showModal();
});

el.btnCloseTablePreview.addEventListener('click', () => el.tablePreviewDialog.close());

el.tablePreviewDialog.addEventListener('click', (e) => {
  if (e.target === el.tablePreviewDialog) el.tablePreviewDialog.close();
});

// Fires on Escape too (native <dialog> behavior), not just the explicit
// close paths above - a single place to drop the editor's own selection
// state so it doesn't leak into the next table it's opened on.
el.tablePreviewDialog.addEventListener('close', () => {
  state.tableEditorToken += 1; // invalidate any render still in flight
  state.tableEditorTableId = null;
  state.tableEditorSelectedIds = new Set();
  state.tableEditorAnchorId = null;
  state.tableEditorGrid = null;
  state.tableEditorSelectionKind = null;
  state.tableEditorSelectedRowId = null;
  state.tableEditorSelectedColIndex = null;
});

window.api.onMenuShortcuts(() => el.shortcutsDialog.showModal());

el.btnCloseShortcuts.addEventListener('click', () => el.shortcutsDialog.close());

el.shortcutsDialog.addEventListener('click', (e) => {
  if (e.target === el.shortcutsDialog) el.shortcutsDialog.close();
});

window.api.onMenuHelpDoc(() => el.helpDialog.showModal());

el.btnCloseHelp.addEventListener('click', () => el.helpDialog.close());

el.helpDialog.addEventListener('click', (e) => {
  if (e.target === el.helpDialog) el.helpDialog.close();
});

window.api.onMenuAbout((_event, data) => {
  el.aboutVersion.textContent = data?.version || '';
  el.aboutDialog.showModal();
});

el.btnCloseAbout.addEventListener('click', () => el.aboutDialog.close());

el.aboutDialog.addEventListener('click', (e) => {
  if (e.target === el.aboutDialog) el.aboutDialog.close();
});

// Settings dialog: holds the BYOK key(s) "Fix with AI" uses (see the
// btnFixActualText handler above) - the built-in Anthropic slot, and one
// slot PER OTHER PROVIDER for a custom OpenAI chat-completions-compatible
// endpoint. A single dropdown (el.settingsProvider) picks between Anthropic,
// a named preset (which - the first time it's picked - fills in Base URL +
// Model as a starting point, still editable, e.g. to pick a different model
// from the same provider), and "Custom" for anything else not listed - a
// university-hosted service, a local model server, etc. Every provider
// keeps its own saved key and config (see main.js's per-provider settings
// storage), so switching the selector and back always shows what you saved
// for THAT specific provider, not whatever was saved last for a different
// one. main.js also remembers the exact provider id last selected here
// (not just "anthropic vs. something else"), so it's what's used again next
// time the app opens. A raw key never round-trips back from main.js - only
// whether one is currently saved - so the status lines are the only
// feedback on save/remove.
//
// Alphabetical by label, since that's how they're listed in the dropdown.
const AI_PROVIDER_OPTIONS = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'custom' },
  { id: 'gemini', label: 'Google Gemini', kind: 'preset', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-pro' },
  { id: 'groq', label: 'Groq', kind: 'preset', baseUrl: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  { id: 'mistral', label: 'Mistral', kind: 'preset', baseUrl: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest' },
  { id: 'openai', label: 'OpenAI', kind: 'preset', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5.1' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'preset', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/auto' },
  { id: 'purdue-genai', label: 'Purdue GenAI Studio', kind: 'preset', baseUrl: 'https://genai.rcac.purdue.edu/api/chat/completions', model: 'llama4:latest' },
];

for (const option of AI_PROVIDER_OPTIONS) {
  const optionEl = document.createElement('option');
  optionEl.value = option.id;
  optionEl.textContent = option.label;
  el.settingsProvider.appendChild(optionEl);
}

async function refreshSettingsApiKeyStatus() {
  const has = await window.api.hasApiKey();
  el.settingsApiKeyStatus.textContent = has ? 'A key is saved on this device.' : 'No key set.';
  return has;
}

async function refreshSettingsCustomApiKeyStatus(providerId) {
  const has = await window.api.hasCustomApiKey(providerId);
  el.settingsCustomApiKeyStatus.textContent = has ? 'A key is saved on this device.' : 'No key set.';
  return has;
}

function updateSettingsProviderVisibility() {
  const isAnthropic = el.settingsProvider.value === 'anthropic';
  el.settingsAnthropicFields.hidden = !isAnthropic;
  el.settingsCustomFields.hidden = isAnthropic;
}

// Loads the Base URL/Model/key-status fields for whichever non-Anthropic
// provider is now selected, from THAT provider's own saved slot - falling
// back to a preset's canonical default only when nothing has been saved for
// it yet, so a provider you've already configured shows what you actually
// saved rather than being reset to the preset default every time you visit
// it.
async function loadCustomProviderFields(providerId) {
  el.settingsCustomApiKey.value = '';
  const [config, hasKey] = await Promise.all([
    window.api.getCustomProviderConfig(providerId),
    window.api.hasCustomApiKey(providerId),
  ]);
  const preset = AI_PROVIDER_OPTIONS.find((o) => o.id === providerId);
  el.settingsCustomBaseUrl.value = config.baseUrl || preset?.baseUrl || '';
  el.settingsCustomModel.value = config.model || preset?.model || '';
  el.settingsCustomApiKeyStatus.textContent = hasKey ? 'A key is saved on this device.' : 'No key set.';
}

el.settingsProvider.addEventListener('change', async () => {
  updateSettingsProviderVisibility();
  const providerId = el.settingsProvider.value;
  if (providerId !== 'anthropic') await loadCustomProviderFields(providerId);
});

window.api.onMenuSettings(async () => {
  el.settingsApiKey.value = '';
  const provider = await window.api.getAiProvider();
  el.settingsProvider.value = AI_PROVIDER_OPTIONS.some((o) => o.id === provider) ? provider : 'anthropic';
  updateSettingsProviderVisibility();
  await Promise.all([
    refreshSettingsApiKeyStatus(),
    el.settingsProvider.value === 'anthropic' ? Promise.resolve() : loadCustomProviderFields(el.settingsProvider.value),
  ]);
  el.settingsDialog.showModal();
});

el.btnCloseSettings.addEventListener('click', () => el.settingsDialog.close());

el.settingsDialog.addEventListener('click', (e) => {
  if (e.target === el.settingsDialog) el.settingsDialog.close();
});

el.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const providerId = el.settingsProvider.value;
  const isAnthropic = providerId === 'anthropic';
  try {
    await window.api.setAiProvider(providerId);
    if (isAnthropic) {
      const key = el.settingsApiKey.value.trim();
      if (key) {
        await window.api.setApiKey(key);
        el.settingsApiKey.value = '';
      }
      await refreshSettingsApiKeyStatus();
    } else {
      await window.api.setCustomProviderConfig(
        providerId,
        el.settingsCustomBaseUrl.value.trim(),
        el.settingsCustomModel.value.trim(),
      );
      const key = el.settingsCustomApiKey.value.trim();
      if (key) {
        await window.api.setCustomApiKey(providerId, key);
        el.settingsCustomApiKey.value = '';
      }
      await refreshSettingsCustomApiKeyStatus(providerId);
    }
    setStatus('AI provider settings saved.');
  } catch (err) {
    reportError('Could not save AI provider settings', err);
  }
});

el.btnClearApiKey.addEventListener('click', async () => {
  const providerId = el.settingsProvider.value;
  const isAnthropic = providerId === 'anthropic';
  try {
    if (isAnthropic) {
      await window.api.clearApiKey();
      el.settingsApiKey.value = '';
      await refreshSettingsApiKeyStatus();
    } else {
      await window.api.clearCustomApiKey(providerId);
      el.settingsCustomApiKey.value = '';
      await refreshSettingsCustomApiKeyStatus(providerId);
    }
    setStatus('API key removed.');
  } catch (err) {
    reportError('Could not remove API key', err);
  }
});

el.btnFindNext.addEventListener('click', () => doFindNext());

el.btnFindReplaceOne.addEventListener('click', async () => {
  const findRole = el.findReplaceFind.value.trim();
  const replaceRole = el.findReplaceReplace.value.trim();
  if (!findRole || !replaceRole) {
    el.findReplaceStatus.textContent = 'Enter both a tag type to find and one to replace it with.';
    return;
  }
  // No valid current match to act on yet (dialog just opened, or the tree
  // changed under us) - just locate one instead of replacing blindly.
  const entry = state.findReplaceLastMatchId ? state.nodesById.get(state.findReplaceLastMatchId) : null;
  if (!entry || entry.node.role !== findRole) {
    doFindNext();
    return;
  }
  const targetId = state.findReplaceLastMatchId;
  try {
    const result = await window.api.updateNode(state.docId, targetId, { role: replaceRole });
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus(`Replaced /${findRole} with /${replaceRole}.`);
    doFindNext();
  } catch (err) {
    reportError('Could not replace tag', err);
  }
});

el.btnFindReplaceAll.addEventListener('click', async () => {
  const findRole = el.findReplaceFind.value.trim();
  const replaceRole = el.findReplaceReplace.value.trim();
  if (!findRole || !replaceRole) {
    el.findReplaceStatus.textContent = 'Enter both a tag type to find and one to replace it with.';
    return;
  }
  if (!state.tree) {
    el.findReplaceStatus.textContent = 'No document loaded.';
    return;
  }
  const matches = findReplaceMatches(findRole);
  if (matches.length === 0) {
    el.findReplaceStatus.textContent = `No /${findRole} tags found.`;
    return;
  }
  try {
    const result = await window.api.updateNodes(state.docId, matches, { role: replaceRole });
    applyFreshTree(result.tree);
    applyUndoState(result);
    state.findReplaceLastMatchId = null;
    const count = matches.length;
    el.findReplaceStatus.textContent = `Replaced ${count} tag${count === 1 ? '' : 's'}.`;
    setStatus(`Replaced ${count} /${findRole} tag${count === 1 ? '' : 's'} with /${replaceRole}.`);
  } catch (err) {
    reportError('Could not replace tags', err);
  }
});

window.api.onMenuFindReplace(() => {
  state.findReplaceLastMatchId = null;
  el.findReplaceStatus.textContent = '';
  positionFindReplaceDialog();
  el.findReplaceDialog.show();
  el.findReplaceFind.focus();
});

el.btnCloseFindReplace.addEventListener('click', () => el.findReplaceDialog.close());

window.addEventListener('resize', () => {
  if (el.findReplaceDialog.open) positionFindReplaceDialog();
});

// Non-modal (see above), so unlike the app's other dialogs it doesn't get
// Escape-to-close for free from showModal() - wire it up to match.
el.findReplaceDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    el.findReplaceDialog.close();
  }
});

// Enter in either field acts like clicking the button below it, so the
// dialog is usable without reaching for the mouse.
el.findReplaceFind.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doFindNext();
  }
});

el.findReplaceReplace.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.btnFindReplaceOne.click();
  }
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
  if (!isUndo && !isRedo) return;

  // Let native undo/redo happen inside a focused text field instead of
  // hijacking it to revert the whole tag tree out from under the user.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  e.preventDefault();
  if (isUndo) performUndo();
  else performRedo();
});

// Ctrl/Cmd+A selects every visible tag in the tree - the root isn't
// included, matching selectableRows()/shift+click/arrow-nav's notion of
// "selectable".
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() !== 'a') return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const rows = selectableRows();
  if (rows.length === 0) return;

  e.preventDefault();
  state.selectedNodeIds = new Set(rows.map((row) => row.dataset.nodeId));
  if (!state.selectedNodeId || !state.selectedNodeIds.has(state.selectedNodeId)) {
    state.selectedNodeId = rows[0].dataset.nodeId;
  }
  state.selectionAnchorId = rows[0].dataset.nodeId;
  renderTree();
  refreshDetailsForSelection();
});

// Ctrl/Cmd+P inserts a new Paragraph tag after the selection - see
// insertParagraphAfterSelection(). Distinct from the bare 'P' shortcut
// handled further below, which converts the selection instead of inserting
// next to it.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() !== 'p') return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  insertParagraphAfterSelection();
});

// Proofread Mode (View > Proofread): Page Down/Up step to the next/previous
// tag the same way the Actual Text field's own edge-of-line Up/Down does
// (see stepProofreadTag() in proofread.js) - but from anywhere, including
// while the Actual Text field itself is focused, since that's exactly where
// this is meant to be used from. A textarea has no native use for Page Up/
// Down (unlike Up/Down, which moves the caret a line), so this doesn't need
// to check what's focused the way the plain arrow-key tree nav below does -
// except for bailing out while a modal dialog (Settings, Table Editor,
// Find/Replace...) has focus, so it doesn't hijack Page Up/Down from an
// unrelated field there.
window.addEventListener('keydown', (e) => {
  if (!state.proofreadMode) return;
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
  if (!state.selectedNodeId) return;
  if (document.activeElement?.closest('dialog[open]')) return;

  e.preventDefault();
  stepProofreadTag(e.key === 'PageUp' ? -1 : 1, e.key === 'PageUp' ? 'end' : 'start');
});

// Up/Down arrows step the current selection through the tree in visible
// order - i.e. the same order rows appear in the DOM, since a collapsed
// element's children simply aren't rendered (see renderTreeNode). Holding
// Shift extends the selection instead of replacing it, growing/shrinking
// from the fixed anchor exactly like shift+click (see extendSelectionTo).
//
// The Document root row isn't in selectableRows() (see the comment in
// renderTreeNode() - it has no parent/siblings to drag/bulk-edit alongside),
// so it's handled as a special case here: Down from root lands on the first
// selectable row, and Up from that first row lands back on root. Root can't
// be part of a Shift-extended range (extendSelectionTo() refuses it, same
// as shift+click), so Shift+Up/Down simply doesn't step onto/off of it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+Up/Down reorders instead - see below
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const rows = selectableRows();

  if (state.selectedNodeId === 'root') {
    if (e.key !== 'ArrowDown' || e.shiftKey || rows.length === 0) return;
    e.preventDefault();
    selectNode(rows[0].dataset.nodeId);
    return;
  }

  const currentIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectedNodeId);
  if (currentIndex === -1) return;

  if (e.key === 'ArrowUp' && currentIndex === 0 && !e.shiftKey) {
    e.preventDefault();
    selectNode('root');
    return;
  }

  const nextIndex = e.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= rows.length) return;

  e.preventDefault();
  if (e.shiftKey) {
    if (!state.selectionAnchorId) state.selectionAnchorId = state.selectedNodeId;
    extendSelectionTo(rows[nextIndex].dataset.nodeId);
  } else {
    selectNode(rows[nextIndex].dataset.nodeId);
  }
});

// Ctrl/Cmd+Up/Down moves the selected tag one place earlier/later among its
// siblings (a keyboard equivalent of dragging it past its neighbor). At the
// first/last child slot it instead outdents the tag to just before/after
// its own parent - unless it's a content/object-ref leaf and there's an
// adjacent tag at that same boundary, in which case it jumps straight into
// that tag's content instead (see moveSelectedSibling()). Disabled while a
// Headings/Figures filter is active - the top-level filtered list (flat for
// Headings, one entry per matched figure for Figures) doesn't reflect
// sibling adjacency in the real tree.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!state.selectedNodeId || state.filter !== 'all') return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  moveSelectedSibling(e.key === 'ArrowUp' ? -1 : 1);
});

// Left/Right arrows collapse/expand the current selection, when it's an
// element with children to hide. While filtered to Headings, there's
// nothing to collapse/expand (it's a flat list), so plain Left/Right steps
// the heading level directly instead of requiring Ctrl/Cmd - see
// attemptHeadingLevelChange().
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return; // handled by the Shift/Ctrl/Cmd+Left/Right listeners below
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (state.filter === 'headings') {
    const direction = e.key === 'ArrowRight' ? 1 : -1;
    if (state.selectedNodeIds.size > 1) {
      e.preventDefault();
      shiftSelectedHeadingLevels(direction);
    } else if (attemptHeadingLevelChange(direction)) {
      e.preventDefault();
    }
    return;
  }

  const entry = state.nodesById.get(state.selectedNodeId);
  if (!entry || entry.node.type !== 'element') return;
  const node = entry.node;
  if (!node.children || node.children.length === 0) return;

  const collapsed = isNodeCollapsed(node);
  if (e.key === 'ArrowRight' && collapsed) {
    e.preventDefault();
    toggleNodeCollapsed(node);
  } else if (e.key === 'ArrowLeft' && !collapsed) {
    e.preventDefault();
    toggleNodeCollapsed(node);
  }
});

// Shift+Left/Right collapses/expands the current selection AND every tag
// nested under it, recursively (vs. plain Left/Right above, which only
// toggles the selected tag itself).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!e.shiftKey || e.ctrlKey || e.metaKey) return;
  if (!state.selectedNodeId) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const entry = state.nodesById.get(state.selectedNodeId);
  if (!entry || entry.node.type !== 'element') return;
  if (!entry.node.children || entry.node.children.length === 0) return;

  e.preventDefault();
  const collapse = e.key === 'ArrowLeft';
  walkTree(entry.node, (node) => {
    if (node.type === 'element') state.collapseOverrides.set(node.id, collapse);
  });
  renderTree();
});

// Ctrl/Cmd+Left collapses every tag in the tree, including top-level ones -
// each still gets its own row (a collapsed tag's row stays put; only its
// children are hidden), so the tree just folds down to one line per
// top-level tag.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft') return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!state.tree) return;

  e.preventDefault();
  walkTree(state.tree, (node) => {
    if (node.type !== 'element') return;
    state.collapseOverrides.set(node.id, true);
  });
  renderTree();
});

// Ctrl/Cmd+Right expands every tag in the tree - the mirror of Ctrl/Cmd+Left
// above.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight') return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!state.tree) return;

  e.preventDefault();
  walkTree(state.tree, (node) => {
    if (node.type !== 'element') return;
    state.collapseOverrides.set(node.id, false);
  });
  renderTree();
});

// Delete (or the extra key set in File > Settings > Preferences, see
// isDeleteShortcut() above) removes the current selection from the struct
// tree. A tag (element node) is deleted along with its whole subtree; a
// content/object-ref leaf is unlinked from its tag and its underlying
// content is turned into a real PDF artifact - see
// delete_nodes()/_artifact_leaves() in tag_worker.py.
window.addEventListener('keydown', (e) => {
  if (!isDeleteShortcut(e)) return;
  if (state.activePanel === 'bookmarks') return; // handled by the Bookmarks-panel Delete listener instead
  if (state.selectedNodeIds.size === 0) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  e.preventDefault();
  deleteSelection();
});

// 1-6/P/L/I/T/R/D/H/F/C convert the current selection's role, each via a
// dedicated backend op (set_role_or_wrap/convert_to_paragraph/make_list/
// make_table/make_tr/convert_to_figure/convert_to_list_item in tag_worker.py)
// rather than a plain Role edit, since a content/object-ref leaf has no role
// of its own to set - these wrap it in a brand-new struct element instead.
// See each handler below for what its shortcut actually does structurally.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.selectedNodeIds.size === 0) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (/^[1-6]$/.test(e.key)) {
    e.preventDefault();
    applyRoleShortcut(`H${e.key}`);
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'p') {
    e.preventDefault();
    convertSelectionToParagraph();
  } else if (key === 'l') {
    e.preventDefault();
    groupSelectionIntoList();
  } else if (key === 'i') {
    e.preventDefault();
    convertSelectionToListItem();
  } else if (key === 't') {
    e.preventDefault();
    groupSelectionIntoTable();
  } else if (key === 'r') {
    e.preventDefault();
    groupSelectionIntoTr();
  } else if (key === 'd') {
    e.preventDefault();
    applyRoleShortcut('TD');
  } else if (key === 'h') {
    e.preventDefault();
    applyRoleShortcut('TH');
  } else if (key === 'f') {
    e.preventDefault();
    convertSelectionToFigure();
  } else if (key === 'c') {
    e.preventDefault();
    applyRoleShortcut('Caption');
  } else if (key === 'j') {
    e.preventDefault();
    joinSelection();
  }
});

// --- accessibility verify --------------------------------------------------
//
// A lightweight, local approximation of Adobe Acrobat's "Full Check" report,
// scoped to what this editor's own data already covers: document-level
// metadata (docInfo, from _get_doc_info() in tag_worker.py), the tag tree,
// and the outline/page count already loaded for the current document. It
// does not attempt anything that needs rendering pixels (colour contrast),
// form fields, or raw content-stream analysis (reading order, tab order,
// scripts) - those aren't backed by any data this app reads today.
//
// Each check returns zero or more "instances" - specific tag ids the issue
// was found on - which the report renders as clickable rows (see
// jumpToVerifyInstance()) that select the tag, matching how clicking a row
// in the Tag Tree itself works.

el.btnVerify.addEventListener('click', () => {
  if (!state.docId) return;
  renderVerifyResults();
  el.verifyDialog.showModal();
});

el.btnCloseVerify.addEventListener('click', () => el.verifyDialog.close());

el.verifyDialog.addEventListener('click', (e) => {
  if (e.target === el.verifyDialog) el.verifyDialog.close();
});

// --- PDF.js viewer -------------------------------------------------------

el.btnPrevPage.addEventListener('click', async () => {
  if (state.currentPage <= 1) return;
  state.currentPage -= 1;
  await renderCurrentPage();
  updatePageNavUI();
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

el.btnNextPage.addEventListener('click', async () => {
  if (state.currentPage >= state.pageCount) return;
  state.currentPage += 1;
  await renderCurrentPage();
  updatePageNavUI();
  if (state.selectedNodeId) highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
});

el.pageIndicatorInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    el.pageIndicatorInput.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    el.pageIndicatorInput.value = String(state.currentPage);
    el.pageIndicatorInput.blur();
  }
});

el.pageIndicatorInput.addEventListener('focus', () => {
  el.pageIndicatorInput.select();
});

el.pageIndicatorInput.addEventListener('blur', goToPageFromIndicatorInput);

// --- open / save ----------------------------------------------------------

el.btnOpen.addEventListener('click', () => performOpen());

window.api.onMenuOpen(() => performOpen());

window.api.onMenuSave(() => performSave());

window.api.onMenuSaveAs(() => performSaveAs());

window.api.onMenuClose(() => performClose());

// The window-close prompt's "Save" button (see createWindow in main.js).
// Main can't run the save itself - the docId and the target path live here -
// so it defers the close until we report back. A failed save (or a
// cancelled Save As dialog) reports false, which leaves the window open
// with the changes intact rather than closing over the error.
window.api.onMenuSaveAndClose(async () => {
  let saved = false;
  try {
    saved = await performSave();
  } finally {
    window.api.reportSaveComplete(saved);
  }
});

// Flattens organizational tags (Div/Sect/Part/Span and Span-like custom
// types - see flatten_tags() in tag_worker.py) found within each selected
// tag's subtree, keeping their contents in place. Falls back to the whole
// document (root) when nothing is selected, so the button still does
// something useful with a single click, the same way the old whole-document
// Kill Divs did.
el.btnFlatten.addEventListener('click', async () => {
  if (!state.docId) return;
  const ids = Array.from(state.selectedNodeIds);
  const targetIds = ids.length > 0
    ? ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)))
    : ['root'];
  try {
    setStatus('Flattening tags…');
    const result = await window.api.flattenTags(state.docId, targetIds);
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus(result.removed > 0 ? `Flattened ${result.removed} tag${result.removed === 1 ? '' : 's'}.` : 'No organizational tags found.');
  } catch (err) {
    reportError('Could not flatten tags', err);
  }
});

el.btnScopeTables.addEventListener('click', async () => {
  if (!state.docId) return;
  try {
    setStatus('Scoping tables…');
    const result = await window.api.scopeTables(state.docId);
    applyFreshTree(result.tree);
    applyUndoState(result);
    setStatus(result.tablesScoped > 0 ? `Scoped ${result.tablesScoped} table${result.tablesScoped === 1 ? '' : 's'}.` : 'No tables matched a recognized header shape.');
  } catch (err) {
    reportError('Could not scope tables', err);
  }
});

el.btnSmartifact.addEventListener('click', async () => {
  if (!state.docId || !state.pdfDoc) return;
  document.body.classList.add('busy');
  try {
    setStatus('Scanning for full-page images…');
    const ids = await findFullPageImageLeafIds();
    if (ids.length === 0) {
      setStatus('No full-page image leaves found.');
      return;
    }
    const result = await window.api.deleteNodes(state.docId, ids);
    applyFreshTree(result.tree);
    applyUndoState(result);
    closeDetails();
    setStatus(`Artifacted ${ids.length} full-page image${ids.length === 1 ? '' : 's'}.`);
  } catch (err) {
    reportError('Could not smartify', err);
  } finally {
    document.body.classList.remove('busy');
  }
});

// --- Add Figure: drag a rectangle on the page preview to tag a figure the
// autotagger missed (backed by figure_from_rect() in tag_worker.py) ------
//
// A toggleable draw mode, mirroring Walk's state.walking/button-label
// pattern below. While active, dragging on the canvas shows a live
// rubber-band rectangle; releasing sends its PDF-space bounds to the
// backend, which decides for itself whether a distinct image XObject sits
// under it (tagged directly via /OBJR) or not (falls back to a /BBox-only
// Figure - see figure_from_rect's module comment in tag_worker.py for why).
// The new tag is selected and its Alt text field focused immediately, same
// as any other freshly created tag needs its Alt text filled in by hand.
// Stays active after each rectangle rather than a one-shot toggle, since
// tagging missed figures across a scanned document is usually a batch job.

el.canvas.addEventListener('mousedown', (e) => {
  if (!state.figureDrawActive || !state.pdfDoc) return;
  e.preventDefault(); // avoid native text/image drag-selection while dragging
  const p = canvasPointFromEvent(e);
  state.figureDrawRect = { start: p, current: p };
  syncHighlightLayerBounds();
});

// mousemove/mouseup listen on window rather than the canvas so a drag that
// briefly leaves the canvas bounds (fast mouse movement) still tracks and
// completes normally, matching typical rubber-band-select behavior.
window.addEventListener('mousemove', async (e) => {
  if (!state.figureDrawRect) return;
  state.figureDrawRect.current = canvasPointFromEvent(e);
  const { viewport } = await getPageTextContent(state.currentPage);
  renderFigureDrawRect(viewport.width, viewport.height);
});

window.addEventListener('mouseup', async () => {
  if (!state.figureDrawRect) return;
  const { start, current } = state.figureDrawRect;
  state.figureDrawRect = null;
  el.drawOverlay.innerHTML = '';

  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  if (width < MIN_FIGURE_DRAW_PX || height < MIN_FIGURE_DRAW_PX) return;

  try {
    const { viewport } = await getPageTextContent(state.currentPage);
    const [px0, py0] = viewport.convertToPdfPoint(start.x, start.y);
    const [px1, py1] = viewport.convertToPdfPoint(current.x, current.y);
    const rect = [Math.min(px0, px1), Math.min(py0, py1), Math.max(px0, px1), Math.max(py0, py1)];

    setStatus('Tagging figure…');
    const result = await window.api.figureFromRect(state.docId, state.currentPage - 1, rect);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (result.newNodeId && state.nodesById.has(result.newNodeId)) {
      selectNode(result.newNodeId);
      el.fieldAlt.focus();
    }
    setStatus(result.method === 'object'
      ? 'Tagged figure from its image object - add Alt text below.'
      : 'Tagged figure region (no separate image object under it, so it got a bounding box instead) - add Alt text below.');
  } catch (err) {
    reportError('Could not tag figure', err);
  }
});

el.btnAddFigure.addEventListener('click', () => {
  if (!state.docId) return;
  setFigureDrawActive(!state.figureDrawActive);
  if (state.figureDrawActive) setStatus('Drag a rectangle around the figure to tag it (Esc to cancel).');
});

el.btnAddP.addEventListener('click', () => {
  insertParagraphAfterSelection();
});

// Escape exits draw mode without tagging anything - captured ahead of any
// other keydown handling, same as Walk's speed/stop listener below.
window.addEventListener('keydown', (e) => {
  if (!state.figureDrawActive || e.key !== 'Escape') return;
  e.preventDefault();
  setFigureDrawActive(false);
  setStatus('Add Figure cancelled.');
}, true);

// --- Walk: auto-advance the tag selection --------------------------------
//
// Steps state.selectedNodeId forward through whatever `.tree-row.selectable`
// rows are currently in the DOM (same document-order list arrow-key nav and
// drag reordering use), one tag at a time, at state.walkSpeed tags/second.
// Starts from the currently selected tag if there is one, else the first row.
// While walking, +/- adjust the speed (and persist it as the new default for
// next time - see saveWalkSpeed()); any other key stops the walk. Re-reads
// the row list and the current selection's position fresh on every tick
// rather than caching an index, so it stays correct even though
// selectNode() re-renders the tree (expanding ancestors, changing which rows
// exist) on every step.

el.btnWalk.addEventListener('click', () => {
  if (state.walking) {
    stopWalking();
    setStatus('Walk stopped.');
  } else {
    startWalking();
  }
});

// Captured ahead of every other keydown listener so that, while walking,
// +/- adjust speed and nothing else (arrow-key nav, delete, role shortcuts,
// etc.) fires - and any other key stops the walk instead.
window.addEventListener('keydown', (e) => {
  if (!state.walking) return;
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta'
    || e.key === 'CapsLock' || e.key === 'NumLock' || e.key === 'ScrollLock' || e.key === 'AltGraph') {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === '+' || e.key === '=') {
    adjustWalkSpeed(1);
  } else if (e.key === '-' || e.key === '_') {
    adjustWalkSpeed(-1);
  } else {
    stopWalking();
    setStatus('Walk stopped.');
  }
}, true);

el.tagFilter.addEventListener('change', () => {
  state.filter = /** @type {typeof state.filter} */ (el.tagFilter.value);
  renderTree();
  // Move focus off the <select> and back to the tree so arrow keys
  // immediately navigate rows again - keyboard tree nav bails out
  // whenever document.activeElement is an INPUT/TEXTAREA/SELECT.
  el.tagFilter.blur();
  // Switching back to the full tree can leave the still-selected tag
  // scrolled out of view (it may have been far from the filtered rows
  // that were showing) - bring it back into sight without touching the
  // PDF page/highlight, which the filter change had no effect on.
  if (state.filter === 'all' && state.selectedNodeId) {
    const row = el.tagTree.querySelector(`[data-node-id="${state.selectedNodeId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }
});

setStatus('Ready.');
