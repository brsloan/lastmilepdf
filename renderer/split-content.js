// split-content.js
//
// The Tag Properties panel's "Split Content" section: shown in place of the
// (non-editable) empty state when a content leaf is selected - see
// refreshDetailsForSelection() in details.js, the only caller of the two
// panel functions below. Lets the user split one content leaf's underlying
// marked content into two (e.g. "1.) Blah" into "1.)" and "Blah"), so each
// half can be tagged separately.
//
// The field's text comes from tag_worker.py's get_leaf_text() - not pdf.js's
// own text layer, which the tag tree's row preview uses elsewhere - because
// split_leaf() has to operate on exactly the text shown here. A pdf.js/
// Python decode mismatch would make the cursor position lie about where the
// split actually lands; see the "content-leaf text splitting" section atop
// tag_worker.py for the full reasoning.

import { el } from './dom.js';
import { state } from './state.js';

// Pulls `nodeId`'s text and shows either the (read-only, cursor-placeable)
// field or the unavailable-with-reason message in its place - a leaf whose
// font has no /ToUnicode, whose marked content nests other marked content,
// or that isn't text at all (an /OBJR) can't be safely split (see
// tag_worker.py's _decode_leaf()), and this is where that reason surfaces.
export async function refreshSplitContentPanel(nodeId) {
  state.splitContentNodeId = nodeId;
  const token = ++state.splitContentToken;
  el.splitContentField.value = '';
  el.splitContentField.hidden = true;
  el.splitContentUnavailable.hidden = true;
  el.btnSplitContent.disabled = true;

  let result;
  try {
    result = await window.api.getLeafText(state.docId, nodeId);
  } catch (err) {
    result = { text: null, reason: err?.message || 'Could not read this content leaf.' };
  }
  // Selection (or document) changed while the request was in flight.
  if (token !== state.splitContentToken || state.splitContentNodeId !== nodeId) return;

  if (result.text === null || result.text === undefined) {
    el.splitContentUnavailable.textContent = result.reason || "This content can't be split.";
    el.splitContentUnavailable.hidden = false;
    el.splitContentField.hidden = true;
    el.btnSplitContent.disabled = true;
    return;
  }

  el.splitContentField.value = result.text;
  el.splitContentField.hidden = false;
  el.splitContentUnavailable.hidden = true;
  el.btnSplitContent.disabled = false;
}

// Hides/invalidates the panel - mirrors closeDetails() and the "an element
// (not a leaf) is selected" branch of refreshDetailsForSelection().
export function resetSplitContentPanel() {
  state.splitContentNodeId = null;
  state.splitContentToken += 1;
  el.splitContentField.value = '';
  el.splitContentField.hidden = true;
  el.splitContentUnavailable.hidden = true;
  el.btnSplitContent.disabled = true;
}
