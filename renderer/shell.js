// shell.js
//
// The window chrome the rest of the app talks to: title bar, status line,
// error reporting, the unsaved-changes flag and the Edit menu's undo state.

import { el } from './dom.js';
import { APP_NAME, state } from './state.js';

export function setFileName(fileName) {
  state.fileName = fileName;
  // A leading * is the conventional "unsaved changes" marker; markDirty()
  // re-calls this whenever that state flips.
  const marker = state.dirty ? '*' : '';
  document.title = fileName ? `${APP_NAME} — ${marker}${fileName}` : APP_NAME;
}

export function setStatus(message) {
  el.statusBar.textContent = message;
}

export function reportError(context, err) {
  console.error(context, err);
  setStatus(`${context}: ${err.message || err}`);
}

// Tracks whether there are tag edits that aren't on disk, and mirrors the
// answer into the title bar and up to the main process (which owns the
// window-close prompt - see main.js). Deliberately conservative: undoing
// back to the original state still counts as dirty, since the file on disk
// may already have been written to in between. Erring toward one extra
// prompt is the safe direction; erring the other way loses work silently.
export function markDirty(dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  setFileName(state.fileName); // re-renders the title with/without its * marker
  window.api.setDirty(dirty);
}

// Called after every successful mutating worker call - which makes it the
// one place that reliably sees "the document just changed", so dirty
// tracking hangs off it too. The three non-mutating callers (performOpen,
// and undo/redo, which genuinely do move the document away from the saved
// file) set the flag themselves.
export function applyUndoState(result) {
  state.canUndo = !!result.canUndo;
  state.canRedo = !!result.canRedo;
  window.api.setUndoState({ canUndo: state.canUndo, canRedo: state.canRedo });
  markDirty(true);
}
