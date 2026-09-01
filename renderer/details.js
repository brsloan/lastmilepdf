// details.js
//
// The tag properties pane: showing the selected tag's attributes, and
// writing edits back through the worker (debounced, so typing in a field
// doesn't fire a round trip per keystroke).
//
// Imports tree-view.js, which imports this module back - see the note at the
// top of tree-view.js for why that cycle exists and why it is safe.

import { updateActualTextReviewUI, updateAtChangeFlagForNode } from './actual-text.js';
import { el } from './dom.js';
import { hasDirectContentLeaf, pullContentText } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { refreshSplitContentPanel, resetSplitContentPanel } from './split-content.js';
import { state } from './state.js';
import { renderTablePreview } from './table-preview.js';
import { applyFreshTree, selectNode } from './tree-view.js';
import { clearHighlight, highlightNodeOnPage } from './viewer.js';

// The Actual Text field's placeholder as authored in index.html - restored
// whenever the selection doesn't warrant swapping in pulled content text
// (see updateActualTextPlaceholder()).
const DEFAULT_ACTUAL_TEXT_PLACEHOLDER = el.fieldActualText.placeholder;

export function setActivePanel(panel) {
  state.activePanel = panel;
  el.tabProperties.classList.toggle('active', panel === 'properties');
  el.tabProperties.setAttribute('aria-selected', String(panel === 'properties'));
  el.tabBookmarks.classList.toggle('active', panel === 'bookmarks');
  el.tabBookmarks.setAttribute('aria-selected', String(panel === 'bookmarks'));
  el.panelProperties.hidden = panel !== 'properties';
  el.panelBookmarks.hidden = panel !== 'bookmarks';
}

// Live-apply (see scheduleLiveApply() below) re-renders this panel from the
// node's own just-saved value right after every debounced keystroke commit,
// while the field the user typed it into is often still focused. Setting
// .value on a focused field yanks the caret to the end even when the value
// is unchanged, which would make mid-string edits unusable - so skip the
// write for whichever field currently has focus; every other field (e.g.
// after a selection change) still gets refreshed normally.
function setFieldValueUnlessFocused(fieldEl, value) {
  if (document.activeElement === fieldEl) return;
  fieldEl.value = value;
}

export function refreshDetailsForSelection() {
  const nodeId = state.selectedNodeId;
  const entry = nodeId ? state.nodesById.get(nodeId) : null;
  if (!entry) {
    closeDetails();
    return;
  }
  if (entry.node.type !== 'element') {
    // A content/object-ref leaf - a valid selection (movable, like a tag),
    // just not an editable one in the usual sense; it gets the Split Content
    // panel instead of the details form. Don't wipe the tree selection the
    // way closeDetails() would (that's only for "nothing is selected"), and
    // still scroll/highlight it like a tag selection.
    el.detailsEmpty.hidden = true;
    el.splitContentPanel.hidden = false;
    el.detailsForm.hidden = true;
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
    updateActualTextReviewUI(null);
    refreshSplitContentPanel(nodeId);
    const row = el.tagTree.querySelector(`[data-node-id="${nodeId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    highlightNodeOnPage(nodeId, { allowPageJump: true });
    return;
  }
  const node = entry.node;
  const multi = state.selectedNodeIds.size > 1;

  el.detailsEmpty.hidden = true;
  el.splitContentPanel.hidden = true;
  resetSplitContentPanel();
  el.detailsForm.hidden = false;
  el.fieldNodeId.value = node.id;
  setFieldValueUnlessFocused(el.fieldRole, node.role || '');
  setFieldValueUnlessFocused(el.fieldAlt, node.alt || '');
  setFieldValueUnlessFocused(el.fieldActualText, node.actualText || '');
  setFieldValueUnlessFocused(el.fieldLang, node.lang || '');
  if (multi) {
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
  } else {
    updateActualTextPlaceholder(node, nodeId);
  }
  // No meaningful single tag to show a proposal for during a multi-select.
  updateActualTextReviewUI(multi ? null : nodeId);

  // With multiple tags selected, only Role applies as a block edit (see the
  // submit handler) - disable the other fields rather than let an edit look
  // like it covers the whole selection when it would only touch this one.
  el.fieldAlt.disabled = multi;
  el.fieldActualText.disabled = multi;
  el.fieldLang.disabled = multi;
  el.btnPullContent.disabled = multi;
  el.btnFixActualText.disabled = multi;

  // The /Document tag doesn't carry meaningful accessibility text of its
  // own - swap Alt/Actual Text out for the PDF's document-info Title/Author
  // instead (see update_doc_info() in tag_worker.py). The underlying Alt/
  // Actual Text fields are left populated (just hidden), same reasoning as
  // the Table preview swap below: Apply still round-trips whatever value
  // they held.
  const isDocument = !multi && node.role === 'Document';
  el.fieldDocInfoSection.hidden = !isDocument;
  el.fieldAltWrap.hidden = isDocument;
  if (isDocument) {
    setFieldValueUnlessFocused(el.fieldDocTitle, state.docInfo.title || '');
    setFieldValueUnlessFocused(el.fieldDocAuthor, state.docInfo.author || '');
    // The /Document tag's own /Lang attribute is rarely set and, per the
    // PDF spec, isn't what governs the document's overall language - the
    // catalog's /Lang is. Same field, different backing value: source it
    // from docInfo here instead of node.lang (set above), and route the
    // Apply-side write through updateDocInfo() below to match.
    setFieldValueUnlessFocused(el.fieldLang, state.docInfo.lang || '');
  }
  el.fieldLangLabel.textContent = isDocument ? 'Document language' : 'Language';

  // Table-cell attributes (Scope/Column span/Row span, PDF's Table attribute
  // owner - see _get_table_attrs() in tag_worker.py). Column span/Row span
  // apply to both TH and TD cells, so they're shown whenever every selected
  // tag is a TH or TD; Scope only has meaning on TH per the PDF spec, so it
  // stays hidden unless every selected tag is a TH specifically. Gating on
  // "every selected tag" (rather than just this one) means the fields can't
  // silently misrepresent a mixed selection. Unlike Alt/Actual text/
  // Language, these stay enabled in a multi-select: same block-apply-to-all
  // shape as Role, just applied to Table-attribute fields instead - see the
  // submit handler.
  const allSelectedIds = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const allTH = allSelectedIds.length > 0
    && allSelectedIds.every((id) => state.nodesById.get(id)?.node.role === 'TH');
  const allCell = allSelectedIds.length > 0
    && allSelectedIds.every((id) => {
      const role = state.nodesById.get(id)?.node.role;
      return role === 'TH' || role === 'TD';
    });
  el.thSection.hidden = !allCell;
  el.fieldScopeWrap.hidden = !allTH;
  el.fieldScope.value = allTH ? (node.scope || '') : '';
  setFieldValueUnlessFocused(el.fieldColSpan, allCell && node.colSpan != null ? node.colSpan : '');
  setFieldValueUnlessFocused(el.fieldRowSpan, allCell && node.rowSpan != null ? node.rowSpan : '');

  // A Table tag's Actual Text is swapped out for a generated read-only HTML
  // preview of its own row/cell structure - more useful here than a free-
  // text field, since what actually matters for a table is its shape (see
  // renderTablePreview()). The underlying field/value is left untouched
  // (just hidden) so Apply still round-trips whatever actualText it had.
  const isTable = !multi && node.role === 'Table';
  el.fieldActualTextWrap.hidden = isTable || isDocument;
  el.tablePreviewWrap.hidden = !isTable;
  if (isTable) {
    renderTablePreview(node);
  } else {
    state.tablePreviewToken += 1;
    el.tablePreviewContainer.innerHTML = '';
  }

  const row = el.tagTree.querySelector(`[data-node-id="${nodeId}"]`);
  row?.scrollIntoView({ block: 'nearest' });

  highlightNodeOnPage(nodeId, { allowPageJump: true });
}

export function closeDetails() {
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectionAnchorId = null;
  el.detailsForm.hidden = true;
  el.splitContentPanel.hidden = true;
  resetSplitContentPanel();
  el.detailsEmpty.hidden = false;
  el.detailsForm.reset();
  state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
  el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
  updateActualTextReviewUI(null);
  el.fieldAlt.disabled = false;
  el.fieldActualText.disabled = false;
  el.fieldLang.disabled = false;
  el.btnPullContent.disabled = false;
  el.btnFixActualText.disabled = false;
  el.thSection.hidden = true;
  el.fieldScopeWrap.hidden = true;
  el.fieldActualTextWrap.hidden = false;
  el.tablePreviewWrap.hidden = true;
  state.tablePreviewToken += 1; // invalidate any table-preview build still in flight
  el.btnExpandTablePreview.disabled = true;
  el.tablePreviewContainer.innerHTML = '';
  state.highlightToken += 1; // invalidate any highlight computation still in flight
  clearHighlight();
}

// Swaps the Actual Text field's placeholder for the tag's own content text
// (pulled the same way the "Pull Content" button does) when the tag has a
// content leaf directly inside it - a strong hint that Actual Text exists to
// replace that content. Any other tag (no content leaf, or one buried under
// nested elements) keeps the generic default placeholder from index.html.
async function updateActualTextPlaceholder(node, nodeId) {
  if (!hasDirectContentLeaf(node)) {
    state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
    el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
    return;
  }
  const token = ++state.actualTextPlaceholderToken;
  const text = await pullContentText(nodeId);
  if (token !== state.actualTextPlaceholderToken) return; // selection changed mid-flight
  el.fieldActualText.placeholder = text || DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
}

// Auto-applies as the user types, not just when a text/textarea field is
// committed via blur - 'input' fires on every keystroke, so this is
// debounced (see scheduleLiveApply()) rather than calling straight through,
// which would push an undo snapshot (a full PDF serialization, see
// nodeChangesAreNoOp() below) per keystroke. Select elements fire their own
// 'change' immediately on pick and don't need debouncing, so they're
// excluded here and left to the 'change' listener below.
let liveApplyTimer = null;

const LIVE_APPLY_DEBOUNCE_MS = 500;

export function scheduleLiveApply() {
  if (liveApplyTimer) clearTimeout(liveApplyTimer);
  liveApplyTimer = setTimeout(applyDetailsChange, LIVE_APPLY_DEBOUNCE_MS);
}

// True if `changes` would leave the tag exactly as it already is. Every
// mutating worker call costs an undo snapshot - a full serialization of the
// PDF, see _push_undo_snapshot() in tag_worker.py - so applying a form
// nobody actually edited shouldn't push one. It matters most on the
// /Document tag, where Title/Author/Language go out as a *second* call:
// without this, editing just the title left an empty node-level edit
// sitting in front of it, and the first Ctrl+Z appeared to do nothing.
// Every field is compared as the trimmed string the form holds, against
// the node's own value normalized the same way (null/undefined -> '',
// numeric spans -> their digits).
function nodeChangesAreNoOp(node, changes) {
  const normalized = (current) =>
    current === null || current === undefined ? '' : String(current);
  return Object.entries(changes).every(
    ([key, value]) => value === normalized(node[key]),
  );
}

export async function applyDetailsChange() {
  if (liveApplyTimer) {
    clearTimeout(liveApplyTimer);
    liveApplyTimer = null;
  }

  const nodeId = el.fieldNodeId.value;
  if (!nodeId) return;

  const multi = state.selectedNodeIds.size > 1;

  try {
    let result;
    if (multi) {
      // With multiple tags selected, only Role and (when every selected tag
      // is a TH) the TH attributes apply as a block edit - the other fields
      // are disabled in the form for this reason (see
      // refreshDetailsForSelection()).
      const role = el.fieldRole.value.trim();
      if (!role) {
        setStatus('Enter a role to apply it to the selected tags.');
        return;
      }
      const changes = { role };
      if (!el.fieldScopeWrap.hidden) {
        changes.scope = el.fieldScope.value;
      }
      if (!el.thSection.hidden) {
        changes.colSpan = el.fieldColSpan.value.trim();
        changes.rowSpan = el.fieldRowSpan.value.trim();
      }
      const selectedIds = Array.from(state.selectedNodeIds);
      result = await window.api.updateNodes(state.docId, selectedIds, changes);
      applyFreshTree(result.tree);
      applyUndoState(result);
      setStatus(`Updated role for ${selectedIds.length} tags.`);
      refreshDetailsForSelection();
    } else {
      // /Document tag selected: the Language field shows/edits the
      // catalog's overall /Lang rather than this struct element's own -
      // route it through updateDocInfo() below (alongside Title/Author)
      // instead of into the node-level change, so it doesn't clobber
      // whatever /Lang the /Document struct element itself happens to hold.
      const isDocument = !el.fieldDocInfoSection.hidden;
      const changes = {
        role: el.fieldRole.value.trim(),
        alt: el.fieldAlt.value.trim(),
        actualText: el.fieldActualText.value.trim(),
      };
      if (!isDocument) {
        changes.lang = el.fieldLang.value.trim();
      }
      if (!el.fieldScopeWrap.hidden) {
        changes.scope = el.fieldScope.value;
      }
      if (!el.thSection.hidden) {
        changes.colSpan = el.fieldColSpan.value.trim();
        changes.rowSpan = el.fieldRowSpan.value.trim();
      }
      const entry = state.nodesById.get(nodeId);
      let changedAnything = false;
      if (!entry || !nodeChangesAreNoOp(entry.node, changes)) {
        result = await window.api.updateNode(state.docId, nodeId, changes);
        applyFreshTree(result.tree);
        applyUndoState(result);
        changedAnything = true;
      }

      // Title/Author/Language here are PDF document-info/catalog fields,
      // not struct-element attributes, so they're edited via a separate
      // call, and only when actually changed - unlike the node-level
      // changes above, there's no single combined undo step for all three,
      // so an unconditional call here would push an empty undo snapshot on
      // every unrelated field edit.
      if (isDocument) {
        const title = el.fieldDocTitle.value.trim();
        const author = el.fieldDocAuthor.value.trim();
        const lang = el.fieldLang.value.trim();
        if (
          title !== (state.docInfo.title || '')
          || author !== (state.docInfo.author || '')
          || lang !== (state.docInfo.lang || '')
        ) {
          const infoResult = await window.api.updateDocInfo(state.docId, { title, author, lang });
          state.docInfo = infoResult.docInfo;
          applyUndoState(infoResult);
          changedAnything = true;
        }
      }

      // Refresh this tag's own Show AT Changes flag before selectNode()
      // below re-renders the tree/details - see updateAtChangeFlagForNode().
      if (state.showAtChanges && changedAnything) {
        await updateAtChangeFlagForNode(nodeId);
      }

      setStatus(changedAnything ? 'Updated tag.' : 'No changes to apply.');
      // Keep the same node selected/visible after the tree re-renders.
      selectNode(nodeId);
    }
  } catch (err) {
    reportError('Could not update tag', err);
  }
}
