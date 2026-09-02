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
import { renderListPreview } from './list-preview.js';
import { hasDirectContentLeaf, pullContentText } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { refreshSplitContentPanel, resetSplitContentPanel } from './split-content.js';
import { state } from './state.js';
import { renderTablePreview } from './table-preview.js';
import { alignSelectedTagTreeRow, applyFreshTree, selectNode } from './tree-view.js';
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
// write for whichever field currently has focus, but ONLY when it's still
// showing the SAME tag as before (a live-apply re-render always is, since it
// re-selects the tag it just committed). A real selection change to a
// DIFFERENT tag must always win even if the field never lost focus - e.g.
// Proofread Mode's tag-to-tag stepping and the Alt Text field's Enter-to-
// next-tag jump (see proofread.js / renderer.js) both deliberately keep a
// field focused across a selection change, and without this they'd leave
// the previous tag's stale value sitting in the field.
function setFieldValueUnlessFocused(fieldEl, value, sameNode) {
  if (sameNode && document.activeElement === fieldEl) return;
  fieldEl.value = value;
}

// Keeps the tag tree scrolled to the current selection. In Proofread Mode,
// levels the row with the Actual Text field's own top edge, the same way
// the PDF preview's highlight box does (see alignSelectedTagTreeRow() in
// tree-view.js); otherwise just brings it into view like before.
function scrollTagTreeRowIntoView(row) {
  if (!row) return;
  if (state.proofreadMode) {
    alignSelectedTagTreeRow(row);
  } else {
    row.scrollIntoView({ block: 'nearest' });
  }
}

export function refreshDetailsForSelection() {
  const nodeId = state.selectedNodeId;
  const entry = nodeId ? state.nodesById.get(nodeId) : null;
  if (!entry) {
    closeDetails();
    return;
  }
  if (entry.node.type === 'root') {
    showRootDetails(nodeId);
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
    scrollTagTreeRowIntoView(el.tagTree.querySelector(`[data-node-id="${nodeId}"]`));
    highlightNodeOnPage(nodeId, { allowPageJump: true });
    return;
  }
  const node = entry.node;
  const multi = state.selectedNodeIds.size > 1;
  const sameNode = el.fieldNodeId.value === node.id;
  // A pending Proofread Mode content-pull (see updateActualTextPlaceholder()
  // below) only protects the tag it was pulled for - landing on a genuinely
  // different tag drops it, whether or not this new one gets a pull of its
  // own.
  if (!sameNode) state.pendingPulledActualTextNodeId = null;

  el.detailsEmpty.hidden = true;
  el.splitContentPanel.hidden = true;
  resetSplitContentPanel();
  el.detailsForm.hidden = false;
  el.fieldNodeId.value = node.id;
  setFieldValueUnlessFocused(el.fieldRole, node.role || '', sameNode);
  setFieldValueUnlessFocused(el.fieldAlt, node.alt || '', sameNode);
  setFieldValueUnlessFocused(el.fieldActualText, node.actualText || '', sameNode);
  setFieldValueUnlessFocused(el.fieldLang, node.lang || '', sameNode);
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

  el.fieldDocInfoSection.hidden = true;
  el.fieldRoleWrap.hidden = false;
  el.fieldAltWrap.hidden = state.proofreadMode;
  el.fieldLangLabel.textContent = 'Language';

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
  el.thSection.hidden = !allCell || state.proofreadMode;
  el.fieldScopeWrap.hidden = !allTH;
  el.fieldScope.value = allTH ? (node.scope || '') : '';
  setFieldValueUnlessFocused(el.fieldColSpan, allCell && node.colSpan != null ? node.colSpan : '', sameNode);
  setFieldValueUnlessFocused(el.fieldRowSpan, allCell && node.rowSpan != null ? node.rowSpan : '', sameNode);

  // A Table or List tag's Actual Text is swapped out for a generated
  // read-only HTML preview of its own structure - more useful here than a
  // free-text field, since what actually matters is the shape (a table's
  // rows/cells, a list's items - see renderTablePreview()/renderListPreview()).
  // The underlying field/value is left untouched (just hidden) so Apply
  // still round-trips whatever actualText it had.
  const isTable = !multi && node.role === 'Table';
  const isList = !multi && node.role === 'L';
  el.fieldActualTextWrap.hidden = (isTable || isList) && !state.proofreadMode;
  el.tablePreviewWrap.hidden = !isTable || state.proofreadMode;
  el.listPreviewWrap.hidden = !isList || state.proofreadMode;
  el.fieldRoleLangRow.hidden = state.proofreadMode;
  if (isTable) {
    renderTablePreview(node);
  } else {
    state.tablePreviewToken += 1;
    el.tablePreviewContainer.innerHTML = '';
  }
  if (isList) {
    renderListPreview(node);
  } else {
    state.listPreviewToken += 1;
    el.listPreviewContainer.innerHTML = '';
  }

  scrollTagTreeRowIntoView(el.tagTree.querySelector(`[data-node-id="${nodeId}"]`));

  highlightNodeOnPage(nodeId, { allowPageJump: true });
}

// The structure tree root has no /S role or accessibility attributes of its
// own to edit - it stands in for the PDF's document-info/catalog fields
// instead (Title/Author from /Info, Language from the catalog's /Lang -
// see update_doc_info() in tag_worker.py), the same fields that used to be
// shown in place of Alt/Actual Text when the /Document tag itself was
// selected. Its own details form is just those three fields: everything
// tag-shaped (Role, Alt, Actual Text, table attributes) is hidden.
function showRootDetails(nodeId) {
  const sameNode = el.fieldNodeId.value === nodeId;
  state.pendingPulledActualTextNodeId = null;

  el.detailsEmpty.hidden = true;
  el.splitContentPanel.hidden = true;
  resetSplitContentPanel();
  el.detailsForm.hidden = false;
  el.fieldNodeId.value = nodeId;

  state.actualTextPlaceholderToken += 1; // invalidate any pull still in flight
  el.fieldActualText.placeholder = DEFAULT_ACTUAL_TEXT_PLACEHOLDER;
  updateActualTextReviewUI(null);

  el.fieldRoleWrap.hidden = true;
  el.fieldAltWrap.hidden = true;
  el.fieldActualTextWrap.hidden = true;
  el.tablePreviewWrap.hidden = true;
  el.listPreviewWrap.hidden = true;
  el.thSection.hidden = true;
  el.fieldScopeWrap.hidden = true;
  el.fieldRoleLangRow.hidden = false;
  state.tablePreviewToken += 1;
  el.tablePreviewContainer.innerHTML = '';
  state.listPreviewToken += 1;
  el.listPreviewContainer.innerHTML = '';

  el.btnPullContent.disabled = true;
  el.btnFixActualText.disabled = true;

  el.fieldDocInfoSection.hidden = false;
  setFieldValueUnlessFocused(el.fieldDocTitle, state.docInfo.title || '', sameNode);
  setFieldValueUnlessFocused(el.fieldDocAuthor, state.docInfo.author || '', sameNode);
  el.fieldLangLabel.textContent = 'Document language';
  setFieldValueUnlessFocused(el.fieldLang, state.docInfo.lang || '', sameNode);
  el.fieldLang.disabled = false;

  scrollTagTreeRowIntoView(el.tagTree.querySelector(`[data-node-id="${nodeId}"]`));
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
  el.fieldRoleWrap.hidden = false;
  el.fieldDocInfoSection.hidden = true;
  el.fieldActualTextWrap.hidden = false;
  el.tablePreviewWrap.hidden = true;
  state.tablePreviewToken += 1; // invalidate any table-preview build still in flight
  el.btnExpandTablePreview.disabled = true;
  el.tablePreviewContainer.innerHTML = '';
  el.listPreviewWrap.hidden = true;
  state.listPreviewToken += 1; // invalidate any list-preview build still in flight
  el.listPreviewContainer.innerHTML = '';
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

  // Proofread Mode (View > Proofread): show the pulled text as the field's
  // real value - the same as clicking Pull Content - rather than leaving it
  // as just a greyed-out placeholder, since proofreading is meant to read
  // like the tag's actual text, not a hint. It is NOT applied to the tag
  // unless the user goes on to edit it (the 'input' listener on
  // el.fieldActualText in renderer.js clears pendingPulledActualTextNodeId
  // the moment they do, and applyDetailsChange() below treats a still-
  // pending field as unchanged) - otherwise stepping past every tag with no
  // Actual Text of its own would silently give each one a real Actual Text
  // nobody asked for. Guarded on the field still being empty and still
  // showing this same tag, in case the user typed something or moved on
  // while the pull was in flight.
  if (state.proofreadMode && text && !el.fieldActualText.value && el.fieldNodeId.value === nodeId) {
    el.fieldActualText.value = text;
    state.pendingPulledActualTextNodeId = nodeId;
  }
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

// Commits a debounced edit that hasn't fired yet, for callers about to move
// the selection while the field the user typed into keeps focus - Proofread
// Mode's tag-to-tag stepping (see proofread.js) is the case this exists for.
// Normal navigation blurs the field, so the form's 'change' listener commits
// first and there's nothing pending by the time the selection moves; keeping
// focus skips that entirely, leaving the timer as the only save path - and by
// the time it fires, refreshDetailsForSelection() has already replaced the
// field's contents with the NEXT tag's, so the edit is applied to nothing and
// silently lost.
//
// Gated on a timer actually being pending rather than always calling through:
// applyDetailsChange() re-selects the node in el.fieldNodeId on its way out,
// which for a content-leaf selection (the form is hidden, but the field still
// holds the last *element* selected - see refreshDetailsForSelection()) would
// yank the selection off the leaf. A pending timer can only exist when the
// form is visible and the user typed into it, so this can't fire spuriously.
export async function flushPendingLiveApply() {
  if (!liveApplyTimer) return;
  await applyDetailsChange();
}

// True if `changes` would leave the tag exactly as it already is. Every
// mutating worker call costs an undo snapshot - a full serialization of the
// PDF, see _push_undo_snapshot() in tag_worker.py - so applying a form
// nobody actually edited shouldn't push one. Every field is compared as the
// trimmed string the form holds, against the node's own value normalized
// the same way (null/undefined -> '', numeric spans -> their digits).
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
    } else if (nodeId === 'root') {
      // The structure root has no struct-element attributes of its own (see
      // update_node() in tag_worker.py, which rejects it outright) - only
      // the PDF's document-info/catalog fields apply, via a separate call
      // from the node-level update below, and only when actually changed -
      // an unconditional call here would push an empty undo snapshot on
      // every unrelated field edit.
      const title = el.fieldDocTitle.value.trim();
      const author = el.fieldDocAuthor.value.trim();
      const lang = el.fieldLang.value.trim();
      let changedAnything = false;
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
      setStatus(changedAnything ? 'Updated document properties.' : 'No changes to apply.');
      selectNode(nodeId);
    } else {
      // A Proofread Mode content-pull the user never actually edited (see
      // updateActualTextPlaceholder() above) reads as unchanged here rather
      // than as a real edit - falls back to the node's own current Actual
      // Text (whatever that already is, normally '') instead of the pulled
      // text sitting unconfirmed in the field.
      const isPendingPull = state.pendingPulledActualTextNodeId === nodeId;
      const changes = {
        role: el.fieldRole.value.trim(),
        alt: el.fieldAlt.value.trim(),
        actualText: isPendingPull
          ? (state.nodesById.get(nodeId)?.node.actualText || '')
          : el.fieldActualText.value.trim(),
        lang: el.fieldLang.value.trim(),
      };
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
