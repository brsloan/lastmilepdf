// doc-io.js
//
// Opening, saving and closing a document, including the unsaved-changes
// prompt that guards each of those.

import { computeAtChangeFlags } from './actual-text.js';
import { refreshArtifactList, resetArtifacts } from './artifacts.js';
import { applyFreshOutline } from './bookmarks.js';
import { closeDetails } from './details.js';
import { el } from './dom.js';
import { clearPageCaches } from './page-content.js';
import { setRectSelectActive } from './rect-select.js';
import { updateRunScriptButtonState } from './scripts.js';
import { applyUndoState, markDirty, reportError, setFileName, setStatus } from './shell.js';
import { state } from './state.js';
import { applyFreshTree, renderTree, selectNode } from './tree-view.js';
import { setProofreadMode } from './proofread.js';
import { verifyAfterSave } from './verify.js';
import { loadPdfPreview, renderCurrentPage, updatePageNavUI } from './viewer.js';
import {
  applyRememberedScroll,
  applyRememberedTreeState,
  flushViewState,
  loadViewState,
  rememberedPage,
  rememberedProofreadMode,
  rememberViewState,
  setRestoringViewState,
} from './view-memory.js';
import { stopWalking } from './walk.js';

// Shared gate in front of anything that would throw away the current
// document's unsaved edits. Returns false if the user backed out (or asked
// to save first and that save didn't happen), in which case the caller must
// abandon whatever it was about to do.
async function confirmDiscardChanges(detail) {
  if (!state.dirty || !state.docId) return true;
  const choice = await window.api.confirmDiscard(detail);
  if (choice === 'cancel') return false;
  if (choice === 'save') return performSave();
  return true;
}

// Everything keyed by node id that outlives a single tree rebuild but must
// NOT outlive the document itself. Node ids are a per-document depth-first
// counter (see _rebuild_registry() in tag_worker.py), so an id from the
// outgoing document names a completely unrelated tag in the incoming one -
// leaving these in place is what had a freshly opened PDF come up with an
// apparently random scatter of expanded/collapsed rows inherited from the
// last one.
function resetPerDocumentNodeState() {
  state.collapseOverrides.clear();
  state.findReplaceLastMatchId = null;
  state.pendingPulledActualTextNodeId = null;
  // The rubber-band tool doesn't survive a document change either: its
  // pending selection is a list of node ids, and leaving the mode armed
  // would keep the canvas in crosshair mode behind a button the incoming
  // document may have disabled.
  setRectSelectActive(false);
}

/**
 * @param {string} [filePath] When given (File > Open Recent), opens that
 * path directly instead of showing the picker.
 */
export async function performOpen(filePath) {
  if (!(await confirmDiscardChanges('Save them before opening another PDF?'))) {
    setStatus('Ready.');
    return;
  }
  try {
    setStatus('Opening\u2026');
    const opened = filePath ? await window.api.openPdfPath(filePath) : await window.api.openPdf();
    if (!opened) {
      setStatus('Ready.');
      return;
    }

    // Where the outgoing document was left, before anything below starts
    // dismantling it - and where the incoming one was left last time, read
    // now so the restore below has it in hand. Nothing else may write a
    // position until that restore has happened: the open sequence redraws
    // the tree several times on the way (empty, then again once the preview
    // has loaded), and each of those renders would otherwise save the blank
    // state it is passing through over the record being restored from. See
    // view-memory.js.
    flushViewState();
    setRestoringViewState(true);
    const remembered = await loadViewState(opened.filePath);

    // The worker keeps every document it has opened - along with its undo
    // snapshots, which for a large PDF dwarf the file itself - until it's
    // told to let go. Release the outgoing one now that its replacement is
    // safely open (not before: if the open above had failed, we'd have
    // thrown away a document the user still had on screen).
    const previousDocId = state.docId;
    if (previousDocId && previousDocId !== opened.docId) {
      window.api.closeDoc(previousDocId).catch((err) => {
        console.error('Could not release the previous document', err);
      });
    }

    state.docId = opened.docId;
    setFileName(opened.filePath.split(/[\\/]/).pop());
    state.savedFilePath = opened.filePath; // Save overwrites the file it was opened from until Save As picks a new one
    el.btnFlatten.disabled = !opened.hasStructTree;
    el.btnScopeTables.disabled = !opened.hasStructTree;
    el.btnSmartifact.disabled = !opened.hasStructTree;
    el.btnAddFigure.disabled = !opened.hasStructTree;
    el.btnRectSelect.disabled = !opened.hasStructTree;
    el.btnAddP.disabled = !opened.hasStructTree;
    el.btnWalk.disabled = !opened.hasStructTree;
    el.btnFixAllActualText.disabled = !opened.hasStructTree;
    state.hasStructTree = !!opened.hasStructTree;
    updateRunScriptButtonState();
    el.btnVerify.disabled = false; // Verify's Document-level checks apply even to an untagged PDF
    stopWalking();
    state.aiProposals = new Map(); // ids from the outgoing document don't carry over
    state.atChangeFlags = new Map(); // stale sweep results for the outgoing document
    state.atChangeSweepToken += 1;   // invalidate any per-node flag refresh still in flight for the outgoing document
    resetPerDocumentNodeState();

    resetArtifacts(); // the list belongs to the outgoing document
    el.noStructBanner.hidden = !!opened.hasStructTree;
    state.docInfo = opened.docInfo || { title: null, author: null };
    applyFreshTree(opened.tree || null);
    state.selectedBookmarkId = null;
    applyFreshOutline(opened.outline || []);
    el.btnAddBookmark.disabled = false;
    el.btnGenerateBookmarks.disabled = !opened.hasStructTree;
    applyUndoState(opened);
    markDirty(false); // freshly opened: applyUndoState above assumes a mutation
    closeDetails();

    await loadPdfPreview(opened.pdfBase64);
    // The tag tree was already rendered (by applyFreshTree() above) with no
    // pdfDoc yet, so content leaves' loadContentText() calls bailed out
    // immediately - re-render now that pdf.js can actually resolve
    // marked-content text.
    renderTree();

    // Show AT Changes is a session-wide toggle (see the menu handler above),
    // so a document opened while it's already on gets swept immediately
    // rather than waiting for the user to re-toggle it - needs state.pdfDoc,
    // hence only now that loadPdfPreview() above has set it. The tree and
    // PDF preview are already fully rendered by this point (applyFreshTree()/
    // loadPdfPreview() above), so without the status line below this sweep
    // - which can take a few seconds on a document with existing Actual Text
    // spread across many pages - runs silently behind an apparently-finished
    // UI, reading as broken rather than still working.
    let atChangesSummary = '';
    if (state.showAtChanges) {
      setStatus('Loaded. Scanning tags for Actual Text changed from content…');
      await computeAtChangeFlags();
      renderTree();
      atChangesSummary = state.atChangeFlags.size > 0
        ? ` Found ${state.atChangeFlags.size} tag${state.atChangeFlags.size === 1 ? '' : 's'} with Actual Text changed from content.`
        : ' No tags have Actual Text that differs from their pulled content.';
    }

    // Back to where this document was left last time, if it is still the
    // same document - applyRememberedTreeState() answers null when the file
    // has been edited since (its node ids would name different tags now),
    // and the defaults below take over.
    //
    // The page goes back first and the tag second: selecting a tag jumps the
    // preview to that tag's own page, so it gets the last word where the two
    // disagree, and the remembered page is what answers for a document left
    // on the structure root, or on a tag with no page of its own.
    const rememberedNodeId = applyRememberedTreeState(remembered);
    const rememberedPageNumber = rememberedPage(remembered);
    if (rememberedPageNumber !== null && rememberedPageNumber !== state.currentPage) {
      state.currentPage = rememberedPageNumber;
      await renderCurrentPage();
      updatePageNavUI();
    }

    // Land on the structure root by default, once the preview (and so
    // state.pdfDoc) is in place for the resulting highlight to target - its
    // details panel is where Title/Author/Language get set (see
    // showRootDetails() in details.js).
    if (state.tree) selectNode(rememberedNodeId || 'root');

    // A document left in Proofread Mode reopens in it, resuming from the tag
    // that was being read. The mode replaces the tree with its own flat list
    // and scrolls that list to line the selected row up with the Actual Text
    // field (see refreshDetailsForSelection() in details.js), so the selected
    // tag IS the position there and the remembered scroll offset has nothing
    // to add - hence one branch or the other, not both.
    //
    // Only entered from here, never left: see rememberedProofreadMode(). And
    // only when the mode isn't already on, since setProofreadMode() captures
    // the settings it is displacing on the way in, and calling it a second
    // time would capture its own.
    if (!state.proofreadMode && rememberedProofreadMode(remembered)) {
      await setProofreadMode(true, { landOn: rememberedNodeId });
      atChangesSummary += ' Proofread Mode is on, where you left it.';
    } else if (!state.proofreadMode) {
      // Only once the tree has been drawn with the selection in it - which
      // expands that tag's ancestors, and so decides which rows exist at all
      // - is there a tree to put back where it was scrolled to. Skipped when
      // the app was already proofreading before this document was opened:
      // that mode aligns the tree itself, and a scroll offset set here would
      // just be undone.
      applyRememberedScroll(remembered);
    }

    // Landing on the root above puts the pane back on the tag tree, so this
    // only has anything to do for an untagged PDF - which has no root to
    // land on, and can still perfectly well have artifacts to list.
    if (state.treePanel === 'artifacts') await refreshArtifactList();

    setStatus((opened.hasStructTree ? 'Loaded.' : 'Loaded (untagged PDF).') + atChangesSummary);
  } catch (err) {
    reportError('Could not open PDF', err);
  } finally {
    // Whether the open finished or threw, the renderer is done standing off
    // the record and can go back to keeping it current - starting with what
    // is on screen right now, so that a document whose remembered position
    // was rejected as stale records a usable one without waiting for the
    // user to move something first.
    setRestoringViewState(false);
    rememberViewState();
  }
}

// Re-runs the accessibility report after a save and appends its fail/pass
// count to the status line the save just wrote - a save is the moment the
// file on disk is what a checker would see, so it's the natural point to
// say whether that file would pass, without the user having to open Verify
// to find out.
//
// Deliberately not awaited. performSave() is what the unsaved-changes prompt
// calls on the way to closing the document or quitting the app, and the
// report includes a content-stream scan of every page (see
// buildOrphanedContentGroup() in verify.js) - awaiting it would put that
// scan between the user clicking "Save" and the window actually closing.
// The save is already complete and reported by the time this starts; the
// count just lands a moment later.
//
// Which is also why it re-checks before writing: by the time it finishes,
// the status line may have moved on to something the user is more
// interested in (another save, an error, a document close). It only ever
// replaces the exact message it was handed, on the same document.
//
// Deliberately *not* wired to the autosave tick below either: that same
// whole-document scan is fine as the tail of something the user asked for,
// and wrong as a thing that happens on a timer behind their work.
function reportAccessibilityAfterSave(savedMessage) {
  const docId = state.docId;
  verifyAfterSave().then((summary) => {
    if (!summary) return;
    if (state.docId !== docId || el.statusBar.textContent !== savedMessage) return;
    setStatus(`${savedMessage} — ${summary}`);
  }).catch((err) => {
    console.error('Could not report the accessibility check after saving', err);
  });
}

// Guards performSave()/performSaveAs()/the autosave tick below from
// overlapping - e.g. the autosave timer firing while a manual Save is still
// writing, or while the Save As dialog is up (both are awaited spans during
// which the renderer's event loop keeps running).
let saveInFlight = false;

// Save overwrites the current file (the path it was opened from, or
// wherever Save As last pointed it). Falls back to the Save As dialog in
// the (normally unreachable) case there's no known path yet.
// Both save paths return true only if the file actually reached disk -
// confirmDiscardChanges() and the window-close prompt both rely on that to
// decide whether it's safe to drop the document.
export async function performSave() {
  if (!state.docId) return false;
  if (!state.savedFilePath) {
    return performSaveAs();
  }
  if (saveInFlight) return false;
  try {
    saveInFlight = true;
    setStatus('Saving\u2026');
    await window.api.saveToPath(state.docId, state.savedFilePath);
    markDirty(false);
    setStatus(`Saved to ${state.savedFilePath}`);
    reportAccessibilityAfterSave(`Saved to ${state.savedFilePath}`);
    return true;
  } catch (err) {
    reportError('Could not save PDF', err);
    return false;
  } finally {
    saveInFlight = false;
  }
}

export async function performSaveAs() {
  if (!state.docId) return false;
  if (saveInFlight) return false;
  try {
    saveInFlight = true;
    setStatus('Saving\u2026');
    const suggested = state.fileName ? state.fileName : '.pdf';
    const savedPath = await window.api.savePdf(state.docId, suggested);
    if (savedPath) {
      state.savedFilePath = savedPath;
      markDirty(false);
      setFileName(savedPath.split(/[\\/]/).pop());
      // The document now belongs to a different path, and the position on
      // screen is that path's position - recorded here rather than left to
      // whatever next happens to redraw the tree. The old path keeps the
      // record it already had, which still describes the file still sitting
      // there. See view-memory.js.
      flushViewState();
    }
    setStatus(savedPath ? `Saved to ${savedPath}` : 'Ready.');
    if (savedPath) reportAccessibilityAfterSave(`Saved to ${savedPath}`);
    return !!savedPath; // false when the user cancelled the dialog
  } catch (err) {
    reportError('Could not save PDF', err);
    return false;
  } finally {
    saveInFlight = false;
  }
}

// How often the autosave tick below checks in. Deliberately an interval
// rather than a per-edit debounce: performSave() re-serializes the whole PDF
// through the Python worker (see save_document() in tag_worker.py), which
// isn't cheap enough to run on every keystroke, and the atomic write plus
// temp-folder backup it does (see the same function) bounds how much a
// periodic save can lose to at most one interval's worth of edits.
const AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000;

// File > Settings > Preferences > Auto-Save. Runs unconditionally on a
// timer for the life of the app; each tick is a no-op unless the setting is
// on, a document with a known path is open, and it actually has unsaved
// edits. A failed tick is silent (besides the console) rather than routed
// through reportError() - a background save hiccup shouldn't interrupt
// whatever the user is doing, and the next tick (or their next manual Save)
// will retry.
setInterval(async () => {
  if (!state.autoSaveEnabled || !state.dirty || !state.docId || !state.savedFilePath || saveInFlight) return;
  try {
    saveInFlight = true;
    await window.api.saveToPath(state.docId, state.savedFilePath);
    markDirty(false);
    setStatus(`Auto-saved to ${state.savedFilePath}`);
  } catch (err) {
    console.error('Auto-save failed', err);
  } finally {
    saveInFlight = false;
  }
}, AUTOSAVE_INTERVAL_MS);

// Releases the current document and returns the UI to its pre-open state,
// without exiting the app - the mirror image of performOpen() adopting one.
export async function performClose() {
  if (!state.docId) return;
  if (!(await confirmDiscardChanges('Save them before closing?'))) {
    setStatus('Ready.');
    return;
  }

  // Last look at where the user was, while the tree is still on screen to
  // be read - everything below this takes it apart. See view-memory.js.
  flushViewState();

  stopWalking();
  const previousDocId = state.docId;
  window.api.closeDoc(previousDocId).catch((err) => {
    console.error('Could not release the document', err);
  });

  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }
  state.renderToken++;
  if (state.pdfDoc) {
    const previous = state.pdfDoc;
    state.pdfDoc = null;
    previous.destroy().catch(() => {});
  }

  state.docId = null;
  state.savedFilePath = null;
  state.hasStructTree = false;
  state.docInfo = { title: null, author: null };
  state.aiProposals = new Map();
  state.atChangeFlags = new Map();
  state.atChangeSweepToken += 1;
  resetPerDocumentNodeState();
  state.selectedBookmarkId = null;
  state.pageCount = 0;
  state.currentPage = 1;
  clearPageCaches();

  closeDetails();
  resetArtifacts();
  applyFreshTree(null);
  applyFreshOutline([]);
  setFileName(null);
  markDirty(false);

  el.btnFlatten.disabled = true;
  el.btnScopeTables.disabled = true;
  el.btnSmartifact.disabled = true;
  el.btnAddFigure.disabled = true;
  el.btnRectSelect.disabled = true;
  el.btnAddP.disabled = true;
  el.btnWalk.disabled = true;
  el.btnFixAllActualText.disabled = true;
  el.btnVerify.disabled = true;
  el.btnAddBookmark.disabled = true;
  el.btnGenerateBookmarks.disabled = true;
  updateRunScriptButtonState();
  state.canUndo = false;
  state.canRedo = false;
  window.api.setUndoState({ canUndo: false, canRedo: false });
  el.noStructBanner.hidden = true;

  el.canvas.getContext('2d').clearRect(0, 0, el.canvas.width, el.canvas.height);
  el.viewerPlaceholder.hidden = false;
  updatePageNavUI();

  setStatus('Ready.');
}
