// find-replace.js
//
// The Find/Replace dialog: locating matching tags in document order and
// stepping through them.

import { selectNode } from './tree-view.js';
import { el } from './dom.js';
import { state } from './state.js';

// Find/Replace dialog: relabels tags by role. "Find" steps through every
// /<role> element in document order (wrapping around); "Replace" swaps the
// currently-found tag's role and advances to the next match; "Replace All"
// relabels every match in one batch call. Matches are recomputed fresh on
// every click rather than cached, since a replace changes which tags match.
// The hidden /Document wrapper (see findHiddenDocumentWrapperId() in
// tree-index.js) is never shown in the tag tree and has no editable role of
// its own (see showRootDetails() in details.js) - Find/Replace must skip it
// too, or "Find" could land on a tag with no visible row to select, and
// "Replace"/"Replace All" could relabel a tag the user can't see or undo by
// clicking back onto it.
function allElementIdsInOrder() {
  const ids = [];
  if (!state.tree) return ids;
  (function visit(node) {
    if (node.type === 'element' && node.id !== state.hiddenDocumentId) ids.push(node.id);
    for (const child of node.children || []) visit(child);
  })(state.tree);
  return ids;
}

export function findReplaceMatches(role) {
  const matches = [];
  if (!state.tree || !role) return matches;
  (function visit(node) {
    if (node.type === 'element' && node.role === role && node.id !== state.hiddenDocumentId) matches.push(node.id);
    for (const child of node.children || []) visit(child);
  })(state.tree);
  return matches;
}

// Advances from wherever findReplaceLastMatchId last landed (tracked by
// document position, not by list index, so it still lands in the right
// place after a Replace changes which tags match) to the next /<role> tag,
// wrapping back to the first match past the end.
export function doFindNext() {
  const role = el.findReplaceFind.value.trim();
  if (!role) {
    el.findReplaceStatus.textContent = 'Enter a tag type to find.';
    return null;
  }
  if (!state.tree) {
    el.findReplaceStatus.textContent = 'No document loaded.';
    return null;
  }
  const matches = findReplaceMatches(role);
  if (matches.length === 0) {
    state.findReplaceLastMatchId = null;
    el.findReplaceStatus.textContent = `No /${role} tags found.`;
    return null;
  }
  let nextIndex = 0;
  if (state.findReplaceLastMatchId) {
    const order = allElementIdsInOrder();
    const anchorPos = order.indexOf(state.findReplaceLastMatchId);
    if (anchorPos !== -1) {
      const idx = matches.findIndex((id) => order.indexOf(id) > anchorPos);
      if (idx !== -1) nextIndex = idx;
    }
  }
  const nextId = matches[nextIndex];
  state.findReplaceLastMatchId = nextId;
  selectNode(nextId);
  el.findReplaceStatus.textContent = `Match ${nextIndex + 1} of ${matches.length}.`;
  return nextId;
}

// Docks the dialog directly over the details-pane column (rather than the
// centered/dimmed spot a plain showModal() would use) so the Viewer and Tag
// Tree panes beside it stay visible and clickable while it's open - see the
// .find-replace-dialog comment in styles.css. Re-measured on every open and
// on resize since the details-pane's rect shifts with the no-struct banner
// and window size, and there's no CSS-only way to pin an absolutely/fixed
// positioned dialog to a grid column's live box.
export function positionFindReplaceDialog() {
  const rect = el.detailsPane.getBoundingClientRect();
  el.findReplaceDialog.style.top = `${rect.top}px`;
  el.findReplaceDialog.style.left = `${rect.left}px`;
  el.findReplaceDialog.style.width = `${rect.width}px`;
}
