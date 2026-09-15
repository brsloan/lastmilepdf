// proofread.js
//
// View > Proofread: a focused layout for reading through a document's Actual
// Text one tag at a time. Turning it on rearranges the workbench (see
// `body.proofread-mode` in styles.css) and strips the Tag Properties panel
// down to just the Actual Text field (see the state.proofreadMode checks in
// refreshDetailsForSelection(), details.js); this module supplies the
// tag-to-tag stepping that Page Up/Down and the Actual Text field's own
// edge-of-line Up/Down arrows drive (both wired up in renderer.js).

import { setShowAtChanges } from './actual-text.js';
import { el, selectableRows } from './dom.js';
import { flushPendingLiveApply, refreshDetailsForSelection } from './details.js';
import { setStatus } from './shell.js';
import { state } from './state.js';
import { renderTree, selectNode, setTagTreeScrollSpacersActive, setTreePanel } from './tree-view.js';
import { setProofreadScrollSpacersActive } from './viewer.js';

// --- the view settings the mode carries between reading sessions ---------
//
// Show AT Changes and the tree filter are ordinary app-wide settings the
// rest of the time, but proofreading wants its own pair of them: a
// read-through is normally done with the flags up and often narrowed to
// Flagged **, which is not how the same user wants the tree set while
// tagging. So the mode owns them for as long as it is on - it applies its
// own pair on the way in and puts the previous pair back on the way out -
// and remembers whatever they were left at, so the next reading session
// starts where the last one stopped rather than back at the defaults.
//
// Stored in settings.json rather than in this module, so "next time" spans
// restarts too. See get/setProofreadViewPrefs() in preload.js.

// Used until the user has actually changed one of them while proofreading.
// Show AT Changes on, because the tags it flags are the ones a read-through
// is looking for, and having to go turn it on every time is the friction
// this whole arrangement exists to remove. The filter left at All, because
// narrowing to the flagged rows decides how much of the document gets read
// at all - that is the user's call to make, not a default to be dropped
// into silently.
const PROOFREAD_VIEW_DEFAULTS = { showAtChanges: true, filter: 'all' };

// What the tree was set to before the mode took those two settings over -
// null whenever the mode is off. Module-local rather than on `state` for
// the same reason as emptyNodeIds in tree-view.js: nothing outside this
// file reads it.
/** @type {{ showAtChanges: boolean, filter: string } | null} */
let preProofreadView = null;

function currentProofreadViewPrefs() {
  return { showAtChanges: state.showAtChanges, filter: state.filter };
}

// settings.json holds whatever was last written there, which may have come
// from an older or newer build - and state.filter drives lookups (see
// nodeMatchesFilter() in tree-view.js) that assume one of the dropdown's own
// option values. Anything else falls back to the default rather than
// filtering the tree to nothing. Read off the <select> so the accepted set
// cannot drift from what the control actually offers.
function sanitizeProofreadViewPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return null;
  const known = [...el.tagFilter.options].some((option) => option.value === prefs.filter);
  return {
    showAtChanges: prefs.showAtChanges === true,
    filter: known ? /** @type {string} */ (prefs.filter) : PROOFREAD_VIEW_DEFAULTS.filter,
  };
}

// The filter half of the pair. Synchronous, and deliberately kept apart
// from the Show AT Changes half below so it can be in place before the tree
// is first drawn - the tree the mode opens onto is then already the right
// list, rather than the full one narrowing a moment later.
function applyProofreadViewFilter(filter) {
  el.tagFilter.value = filter;
  state.filter = /** @type {typeof state.filter} */ (filter);
}

// The Show AT Changes half. Turning it on re-reads every candidate tag's
// content off the page, which is seconds of waiting on a long document -
// hence the status line, and hence the caller drawing the tree before this
// rather than after it. Neither is needed when the setting is already where
// it is wanted, which is the common case once a reading habit has settled.
//
// The View menu's checkbox is a main-process MenuItem, so it only knows what
// the renderer did here if the renderer says so - otherwise it would sit
// unchecked while the flags are up, and the next click on it would send the
// state the renderer is already in.
async function applyProofreadShowAtChanges(enabled) {
  if (enabled === state.showAtChanges) return false;
  window.api.setMenuShowAtChangesChecked(enabled);
  // Replaced by the caller's own "Proofread Mode on/off" message once this
  // returns - see the onMenuProofread handler in renderer.js.
  if (enabled) setStatus('Scanning tags for Actual Text changed from content…');
  await setShowAtChanges(enabled, { announce: false });
  return true;
}

// Records the pair as it now stands, for the next reading session to start
// from - called from the filter dropdown's and the View menu's own handlers
// in renderer.js, since a change made through either of those while the mode
// is on is a change to the mode's settings. A no-op the rest of the time:
// the same two controls outside Proofread Mode are just the ordinary
// app-wide settings, and must not overwrite what proofreading remembers.
export function rememberProofreadViewPrefs() {
  if (!state.proofreadMode) return;
  window.api.setProofreadViewPrefs(currentProofreadViewPrefs());
}

export async function setProofreadMode(enabled) {
  // Turning the mode on re-selects (below), and turning it off re-renders -
  // either way a debounced edit still sitting in the Actual Text field has to
  // be committed first, while el.fieldNodeId still names the tag it belongs
  // to. See flushPendingLiveApply() in details.js.
  await flushPendingLiveApply();
  state.proofreadMode = enabled;
  document.body.classList.toggle('proofread-mode', enabled);
  // The dropdown filter stays, and stacks: in Proofread Mode it narrows the
  // mode's own flat list rather than replacing it (see renderProofreadTree()
  // in tree-view.js), so setting it to Flagged ** is a read-through of
  // exactly the tags whose words changed, in the same order and the same
  // flat shape the mode reads everything else in. What it is set to is the
  // mode's own remembered setting for as long as the mode is on, though -
  // see the view-settings section at the top of this file.
  //
  // The Artifacts tab does go. An artifact has no Actual Text to read, so
  // there is nothing in that panel for this mode to do - and the tree pane
  // is a slim strip here (see body.proofread-mode in styles.css), with room
  // for one tab above the filter rather than two beside it. Anything
  // already showing there is switched back to the tree first, so the mode
  // never opens onto a panel whose tab has just been hidden.
  el.tabArtifacts.hidden = enabled;
  if (enabled) setTreePanel('tree');

  // Swap the two view settings over. The filter goes in before the render
  // below, so the mode opens straight onto the list it is meant to read;
  // Show AT Changes follows it, after that render, because its sweep is slow
  // enough that waiting on it would leave the pane showing the old tree.
  // Turning the mode on captures the pair it is displacing first; turning it
  // off hands that same pair back, so a proofreading detour leaves the tree
  // exactly as it found it.
  /** @type {boolean | null} */
  let pendingShowAtChanges = null;
  if (enabled) {
    preProofreadView = currentProofreadViewPrefs();
    const prefs = sanitizeProofreadViewPrefs(await window.api.getProofreadViewPrefs())
      || PROOFREAD_VIEW_DEFAULTS;
    applyProofreadViewFilter(prefs.filter);
    pendingShowAtChanges = prefs.showAtChanges;
  } else if (preProofreadView) {
    const restore = preProofreadView;
    preProofreadView = null;
    applyProofreadViewFilter(restore.filter);
    pendingShowAtChanges = restore.showAtChanges;
  }

  renderTree(); // switches the tree between its normal and flat proofread-only rendering - see renderProofreadTree() in tree-view.js

  // A second render only when the sweep actually ran: the flags it raises (or
  // clears) change both the rows' change-flag badges and, under a Flagged
  // filter, which rows are there at all.
  if (pendingShowAtChanges !== null && await applyProofreadShowAtChanges(pendingShowAtChanges)) {
    renderTree();
  }

  // That sweep is the one long await in here, and the menu item driving it is
  // a checkbox the user can click again while it runs. If they did, the later
  // call has already put the mode where it belongs and finishing this one on
  // top of it would undo that - on the way in, by selecting a tag and taking
  // over the Actual Text field in a mode that is now off.
  if (state.proofreadMode !== enabled) return;

  if (!enabled) {
    // Drops both the PDF preview and the tag tree straight back to their
    // normal "can't scroll past the content's own edges" behavior - see
    // setProofreadScrollSpacersActive() in viewer.js and
    // setTagTreeScrollSpacersActive() in tree-view.js. Turning proofreading
    // back on grows them lazily, the next time a selection is aligned.
    setProofreadScrollSpacersActive(false);
    setTagTreeScrollSpacersActive(false);
    if (state.selectedNodeId) refreshDetailsForSelection();
    return;
  }

  // Land on the first proofread-worthy tag (selectableRows() already
  // reflects the flat, filtered tree just rendered above) with its Actual
  // Text selected, so proofreading can start right away without an extra
  // click - regardless of whatever happened to be selected before turning
  // Proofread Mode on. selectNode() re-renders the tree/details panel again
  // on top of the renderTree() call above, which is fine - the same minor
  // redundancy stepProofreadTag() already accepts on every step.
  const firstRow = selectableRows()[0];
  if (firstRow) {
    selectNode(firstRow.dataset.nodeId);
    el.fieldActualText.focus();
    el.fieldActualText.select();
  } else if (state.selectedNodeId) {
    refreshDetailsForSelection();
  }
}

// Re-lands the selection after the dropdown filter has narrowed (or widened)
// the proofread list - called from the filter's own change handler in
// renderer.js, once the tree has been re-rendered.
//
// The mode steps from the selected row to its neighbor (see
// findProofreadNeighborRow below), so a filter that takes the selected tag
// off the list would leave Page Up/Down with nothing to step from. Landing
// on the first row that survived puts the caret at the start of its Actual
// Text, ready to read - the same place stepping forward with Page Down
// lands, and deliberately NOT the select-all that turning the mode on uses:
// changing the filter is a navigation step, so the next keystroke must not
// wipe out the tag's text. A selection the filter kept stays put and is just
// re-levelled with the Actual Text field, since the re-render reset the
// tree's scroll position under it.
export async function relandProofreadAfterFilterChange() {
  if (!state.proofreadMode) return;
  const rows = selectableRows();
  if (rows.some((row) => row.dataset.nodeId === state.selectedNodeId)) {
    refreshDetailsForSelection();
    return;
  }
  if (rows.length === 0) return;
  // Same ordering as stepProofreadTag(): read the id off the row before the
  // flush, which re-renders and detaches every row element in the DOM.
  const targetId = rows[0].dataset.nodeId;
  await flushPendingLiveApply();
  if (!state.nodesById.has(targetId)) return;
  selectNode(targetId);
  el.fieldActualText.focus();
  el.fieldActualText.setSelectionRange(0, 0);
}

// Next/previous selectable row that's an actual tag - the same 'element'-only
// filter the Alt Text field's Enter-to-next-tag jump uses in renderer.js,
// since content/object-ref leaves have no Actual Text field to land in.
function findProofreadNeighborRow(direction) {
  const rows = selectableRows();
  const currentIndex = rows.findIndex((row) => row.dataset.nodeId === state.selectedNodeId);
  if (currentIndex === -1) return null;
  for (let i = currentIndex + direction; i >= 0 && i < rows.length; i += direction) {
    if (state.nodesById.get(rows[i].dataset.nodeId)?.node.type === 'element') return rows[i];
  }
  return null;
}

// Selects the next/previous tag and drops the caret into its Actual Text
// field - at the end when stepping backward (picking up reading where the
// previous tag left off) or the start when stepping forward.
export async function stepProofreadTag(direction, caretTo) {
  const row = findProofreadNeighborRow(direction);
  if (!row) return;
  // Read the target id off the row BEFORE flushing: the flush re-renders the
  // tree, detaching every row element currently in the DOM. The id itself
  // survives, since a rebuild only reassigns ids when the tree's *shape*
  // changes and applyDetailsChange() only ever edits attributes (see the note
  // above pruneStaleAiProposals() in actual-text.js).
  const targetId = row.dataset.nodeId;
  await flushPendingLiveApply();
  if (!state.nodesById.has(targetId)) return;
  selectNode(targetId);
  el.fieldActualText.focus();
  const pos = caretTo === 'end' ? el.fieldActualText.value.length : 0;
  el.fieldActualText.setSelectionRange(pos, pos);
}

// --- caret-line detection, for the Actual Text field's Up/Down handling ---
//
// A textarea only reports selectionStart/End as a character offset, not
// which *wrapped* visual line the caret is on - so telling "caret is on the
// field's first/last line" (as opposed to just the first/last logical line,
// which wrapping can split into several) apart takes mirroring the field
// into an off-screen div with identical box/font metrics and identical text,
// then reading the offsetTop of a marker planted at the caret's character
// offset. This is the standard trick for getting a textarea caret's pixel
// position (e.g. the "textarea-caret-position" package); reimplemented here
// rather than pulled in since it's ~20 lines and used nowhere else.
const MIRROR_STYLE_PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontSize', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize',
];

function buildTextareaMirror(textarea) {
  const div = document.createElement('div');
  const computed = getComputedStyle(textarea);
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.wordBreak = 'break-word';
  for (const prop of MIRROR_STYLE_PROPS) div.style[prop] = computed[prop];
  return div;
}

// { isFirstLine, isLastLine } for the caret's current position - both true
// at once for a single-line (or empty) field. Markers at the very start and
// end of the text bracket the caret's own marker so "first/last line" comes
// from comparing offsetTops to those, rather than to a hardcoded 0 - which
// would be wrong by exactly the field's padding-top.
function makeMarker() {
  const span = document.createElement('span');
  span.textContent = String.fromCharCode(8203); // zero-width - an empty span can collapse onto the previous line's box in some engines
  return span;
}

export function caretLineExtremes(textarea) {
  const caretPos = textarea.selectionStart;
  const div = buildTextareaMirror(textarea);

  const startMarker = makeMarker();
  div.appendChild(startMarker);
  div.appendChild(document.createTextNode(textarea.value.slice(0, caretPos)));
  const caretMarker = makeMarker();
  div.appendChild(caretMarker);
  div.appendChild(document.createTextNode(textarea.value.slice(caretPos)));
  const endMarker = makeMarker();
  div.appendChild(endMarker);

  document.body.appendChild(div);
  const isFirstLine = caretMarker.offsetTop === startMarker.offsetTop;
  const isLastLine = caretMarker.offsetTop === endMarker.offsetTop;
  document.body.removeChild(div);
  return { isFirstLine, isLastLine };
}
