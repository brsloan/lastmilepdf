// proofread.js
//
// View > Proofread: a focused layout for reading through a document's Actual
// Text one tag at a time. Turning it on rearranges the workbench (see
// `body.proofread-mode` in styles.css) and strips the Tag Properties panel
// down to just the Actual Text field (see the state.proofreadMode checks in
// refreshDetailsForSelection(), details.js); this module supplies the
// tag-to-tag stepping that Page Up/Down and the Actual Text field's own
// edge-of-line Up/Down arrows drive (both wired up in renderer.js).

import { el, selectableRows } from './dom.js';
import { refreshDetailsForSelection } from './details.js';
import { state } from './state.js';
import { selectNode } from './tree-view.js';

export function setProofreadMode(enabled) {
  state.proofreadMode = enabled;
  document.body.classList.toggle('proofread-mode', enabled);
  if (state.selectedNodeId) refreshDetailsForSelection();
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
export function stepProofreadTag(direction, caretTo) {
  const row = findProofreadNeighborRow(direction);
  if (!row) return;
  selectNode(row.dataset.nodeId);
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
