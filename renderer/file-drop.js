// file-drop.js
//
// Dropping a PDF onto the Page Preview pane opens it - the third door onto
// performOpen(), beside the toolbar's Open button and File > Open.
//
// Only while nothing is loaded. Once a document is open the pane belongs to
// the tools that draw on it (Add Figures, Select Content), and a stray drop
// there would throw away whatever the user was mid-way through; they can
// close the document, or use File > Open, which asks about unsaved changes
// first. So the drop target is exactly the empty state the placeholder is
// already describing.

import { performOpen } from './doc-io.js';
import { el } from './dom.js';
import { setStatus } from './shell.js';
import { state } from './state.js';

// A drag of files from the OS, as opposed to one of the tag tree's own rows
// being dragged around inside the app (those carry 'text/plain'). Checked
// rather than assumed, since both kinds of drag pass through the same
// window-level handlers below.
function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function canAcceptDrop(event) {
  return !state.docId && isFileDrag(event);
}

function setDropTarget(active) {
  el.canvasWrap.classList.toggle('drop-target', active);
}

// Chromium's default for a file dropped anywhere in the window is to
// navigate to it, which in a packaged app means the whole UI is replaced by
// the PDF and there is no way back. So every file drag is swallowed at the
// window level, and only the pane below opts back in.
window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none';
});

window.addEventListener('drop', (e) => {
  if (isFileDrag(e)) e.preventDefault();
  setDropTarget(false);
});

el.canvasWrap.addEventListener('dragover', (e) => {
  if (!canAcceptDrop(e)) return;
  e.preventDefault();
  e.stopPropagation(); // the window handler above would otherwise refuse it again
  e.dataTransfer.dropEffect = 'copy';
  setDropTarget(true);
});

// Moving between the pane's own children (canvas, highlight layers) fires
// dragleave on the way out of each one, so the class only comes off when the
// pointer has left the wrap itself - relatedTarget is the element it moved
// to, and is null when it left the window entirely.
el.canvasWrap.addEventListener('dragleave', (e) => {
  const movedTo = /** @type {Node | null} */ (e.relatedTarget);
  if (!movedTo || !el.canvasWrap.contains(movedTo)) setDropTarget(false);
});

el.canvasWrap.addEventListener('drop', (e) => {
  setDropTarget(false);
  if (!canAcceptDrop(e)) return;
  e.preventDefault();
  e.stopPropagation();

  // A drop can carry several files (and a folder, which arrives as a file
  // with no usable path). Take the first PDF among them rather than the
  // first file, so one PDF dragged along with its notes still opens.
  const files = Array.from(e.dataTransfer.files);
  const pdf = files.find((file) => /\.pdf$/i.test(file.name));
  if (!pdf) {
    setStatus(files.length ? 'That isn’t a PDF.' : 'Nothing to open.');
    return;
  }

  const filePath = window.api.pathForDroppedFile(pdf);
  if (!filePath) {
    setStatus('Could not open PDF: that file has no path on disk.');
    return;
  }
  performOpen(filePath);
});
