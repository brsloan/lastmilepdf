// artifacts.js
//
// The Tag Tree pane's Artifacts tab: what the document marks `/Artifact`
// rather than tags, listed so it can be looked at and, where it shouldn't
// have been an artifact in the first place, tagged.
//
// The tag tree answers "what does this document say about its content?".
// This answers the other half - "and what has it declined to say anything
// about?" - which until now was invisible in the app even though several of
// its own commands put content there: deleting a tag artifacts its content,
// and so do Smartifact and Repair Orphaned Content (see _artifact_leaves()
// in tag_worker.py). That made artifacting a one-way door. The Tag button
// here is the way back.
//
// The list comes from the worker's own walk of every page's content stream
// (list_artifacts() / page_artifact_spans()), because an artifact has no
// marked-content id and so appears nowhere in the struct tree the rest of
// the renderer works from. That walk costs a parse per page, so it is read
// lazily: applyFreshTree() marks it stale after any edit and this module
// pays for it the next time the tab is actually shown.

import { artifactRows, el } from './dom.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { applyFreshTree, selectNode, setTreePanel } from './tree-view.js';
import { clearHighlight, highlightArtifactOnPage, refreshHighlightForCurrentPage, refreshPdfPreviewBytes } from './viewer.js';

// The role a restored artifact starts out as. A paragraph is the neutral
// choice - it claims the content is content and nothing more - and the tag
// lands selected in the tree, where its role can be changed like any other.
const RESTORE_ROLE = 'P';

// What each kind of artifact is called in its row, and in the sentence the
// Tag button's status line uses.
const KIND_LABELS = {
  text: 'text',
  image: 'image',
  path: 'drawing',
  mixed: 'mixed',
  region: 'region',
};

export function selectedArtifact() {
  return state.artifacts.find((entry) => entry.id === state.selectedArtifactId) || null;
}

// Every selected artifact, in the order they are listed - which is the order
// they will be read in once tagged, since the list is in page then
// content-stream order. Filtered against the list rather than trusted: ids
// are per-response (see the module comment), so a selection that outlived a
// refresh names rows that may no longer be there.
function selectedArtifacts() {
  return state.artifacts.filter((entry) => state.selectedArtifactIds.has(entry.id));
}

// Switches the pane to the Artifacts tab, reading the list first if it has
// gone stale (or was never read). The tab click awaits this, so the busy
// cursor covers the whole-document walk on a long file.
export async function showArtifactsPanel() {
  setTreePanel('artifacts');
  renderArtifactList();
  await refreshArtifactList();
}

export function showTagTreePanel() {
  setTreePanel('tree');
  refreshHighlightForCurrentPage();
}

// Re-reads the list from the worker when it's stale, and redraws. A no-op
// when the list is already current, so it's safe to call on every switch to
// the tab.
//
// `artifactsToken` guards the await the same way the highlight and preview
// tokens do: a document closed or swapped while the walk was in flight must
// not have the outgoing document's artifacts land in the new one's list.
export async function refreshArtifactList() {
  if (!state.docId) {
    state.artifacts = [];
    state.artifactsTruncated = false;
    state.artifactsStale = false;
    renderArtifactList();
    return;
  }
  if (!state.artifactsStale) return;

  const token = ++state.artifactsToken;
  el.artifactsEmpty.hidden = false;
  el.artifactsEmpty.textContent = 'Reading the page content streams…';
  el.artifactList.hidden = true;
  document.body.classList.add('busy');
  try {
    const result = await window.api.listArtifacts(state.docId);
    if (token !== state.artifactsToken) return;
    state.artifacts = result.artifacts || [];
    state.artifactsTruncated = !!result.truncated;
    state.artifactsStale = false;
    // A fresh read reassigns every id, so a selection made against the old
    // one names whatever happens to sit in those slots now - which is not
    // what the user picked out. Dropping it is the honest answer, and the
    // same one applyFreshTree() gives a rectangle selection.
    clearArtifactSelection();
  } catch (err) {
    if (token !== state.artifactsToken) return;
    state.artifacts = [];
    state.artifactsTruncated = false;
    // Left stale on purpose: the walk failed, so the list is unknown rather
    // than empty, and switching to the tab again should try it afresh.
    reportError('Could not list this document’s artifacts', err);
  } finally {
    document.body.classList.remove('busy');
    if (token === state.artifactsToken) renderArtifactList();
  }
}

// Called when a document is opened or closed: the list belongs to the
// document, so it goes with it.
export function resetArtifacts() {
  state.artifactsToken++;
  state.artifacts = [];
  state.artifactsTruncated = false;
  state.artifactsStale = true;
  clearArtifactSelection();
  if (state.treePanel === 'artifacts') renderArtifactList();
}

function clearArtifactSelection() {
  state.selectedArtifactId = null;
  state.selectedArtifactIds = new Set();
  state.artifactAnchorId = null;
}

function emptyMessage() {
  if (!state.docId) return 'Open a PDF to list its artifacts.';
  return 'No artifacts in this document. Content becomes an artifact when its tag is deleted, '
    + 'and when Smartifact or Repair Orphaned Content runs.';
}

function noteText() {
  if (!state.docId || state.artifacts.length === 0) return '';
  // With several picked out, what the button is about to do matters more
  // than how long the list is - Tag puts them under one tag, not one each,
  // and that is worth saying before it happens rather than after.
  if (state.selectedArtifactIds.size > 1) {
    return `${state.selectedArtifactIds.size} selected — Tag puts them under one <${RESTORE_ROLE}>`;
  }
  const count = `${state.artifacts.length} artifact${state.artifacts.length === 1 ? '' : 's'}`;
  return state.artifactsTruncated ? `First ${count} — this document has more` : count;
}

export function renderArtifactList() {
  el.artifactList.innerHTML = '';
  const hasArtifacts = state.artifacts.length > 0;
  el.artifactsEmpty.hidden = hasArtifacts;
  el.artifactsEmpty.textContent = emptyMessage();
  el.artifactList.hidden = !hasArtifacts;
  el.artifactsNote.textContent = noteText();
  el.btnRestoreArtifact.disabled = state.selectedArtifactIds.size === 0;

  if (!hasArtifacts) return;
  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  for (const artifact of state.artifacts) ul.appendChild(renderArtifactRow(artifact));
  el.artifactList.appendChild(ul);
}

// One row, built the way a content leaf's row in the tag tree is built, so
// the two lists read as the same kind of thing: the leading spacer that
// lines rows up under the tree's collapse arrows, a chip saying what it is,
// then whatever text it has, then its page.
function renderArtifactRow(artifact) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row selectable';
  row.dataset.artifactId = artifact.id;
  applyArtifactSelectionClasses(row, artifact.id);
  row.title = rowTitle(artifact);

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle-spacer';
  row.appendChild(spacer);

  const chip = document.createElement('span');
  chip.className = 'tag-chip';
  chip.dataset.category = 'leaf';
  chip.textContent = KIND_LABELS[artifact.kind] || artifact.kind;
  row.appendChild(chip);

  // /Subtype is the file's own word for what the artifact is for - "Header",
  // "Footer", "Watermark" - and is worth more than anything this could infer,
  // so it goes next to the chip when the file bothered to say.
  if (artifact.subtype) {
    const subtype = document.createElement('span');
    subtype.className = 'tree-node-meta';
    subtype.textContent = artifact.subtype;
    row.appendChild(subtype);
  }

  const text = document.createElement('span');
  text.className = 'tree-node-text artifact-row-text';
  text.textContent = artifact.text;
  row.appendChild(text);

  const page = document.createElement('span');
  page.className = 'tree-node-meta';
  page.textContent = `p. ${artifact.pageIndex + 1}`;
  row.appendChild(page);

  row.addEventListener('click', (e) => handleArtifactRowClick(artifact.id, e));
  row.addEventListener('dblclick', () => restoreSelectedArtifacts());

  li.appendChild(row);
  return li;
}

function rowTitle(artifact) {
  const parts = [];
  if (artifact.text) parts.push(artifact.text);
  const declared = [artifact.artifactType, artifact.subtype].filter(Boolean).join(' / ');
  if (declared) parts.push(`Declared as ${declared}`);
  if (artifact.nested) parts.push('Sits inside other marked content');
  if (!artifact.bbox && !artifact.declaredBBox) {
    parts.push('Nowhere to outline it on the page - see the Artifacts help');
  } else if (artifact.unmeasured) {
    parts.push('Part of this could not be placed, so the outline may be short of it');
  }
  return parts.join('\n');
}

// The same two classes the tag tree marks its selection with (see
// applySelectionClasses() in tree-view.js), so a multi-selection reads the
// same in both lists.
function applyArtifactSelectionClasses(row, artifactId) {
  row.setAttribute('aria-selected', String(state.selectedArtifactIds.has(artifactId)));
  row.classList.toggle(
    'multi-selected',
    state.selectedArtifactIds.size > 1 && state.selectedArtifactIds.has(artifactId),
  );
  row.classList.toggle('selected', artifactId === state.selectedArtifactId);
}

// Moves the selection without rebuilding the list. The tag tree can afford
// to re-render on every selection change because a filtered/collapsed tree is
// a few dozen rows; this list is flat and whole-document, and stepping
// through a scanned book with the arrow keys would otherwise rebuild a couple
// of thousand rows per keypress.
function syncArtifactRowSelection() {
  for (const row of artifactRows()) applyArtifactSelectionClasses(row, row.dataset.artifactId);
  el.btnRestoreArtifact.disabled = state.selectedArtifactIds.size === 0;
  el.artifactsNote.textContent = noteText();
}

// Click, shift+click and ctrl/cmd+click behave as they do in the tag tree -
// replace, extend from the anchor, toggle one member.
function handleArtifactRowClick(artifactId, e) {
  if (e.shiftKey) {
    extendArtifactSelectionTo(artifactId);
  } else if (e.ctrlKey || e.metaKey) {
    toggleArtifactSelectionMember(artifactId);
  } else {
    selectArtifact(artifactId);
  }
}

// Plain click and keyboard navigation: replaces any existing selection with
// just this one.
export function selectArtifact(artifactId) {
  state.selectedArtifactIds = new Set([artifactId]);
  state.artifactAnchorId = artifactId;
  afterArtifactSelectionChange(artifactId);
}

function toggleArtifactSelectionMember(artifactId) {
  const next = new Set(state.selectedArtifactIds);
  if (next.has(artifactId)) next.delete(artifactId);
  else next.add(artifactId);
  state.selectedArtifactIds = next;
  state.artifactAnchorId = artifactId;

  if (next.size === 0) {
    state.selectedArtifactId = null;
    syncArtifactRowSelection();
    clearHighlight();
    return;
  }
  // Ctrl+clicking a row *off* leaves the active one to whatever is still
  // selected, the same fallback toggleSelectionMember() makes in the tree.
  afterArtifactSelectionChange(next.has(artifactId) ? artifactId : Array.from(next).pop());
}

// Shift+click and shift+arrow: selects every row between the fixed anchor
// and this one, inclusive - the DOM row order, which is the order they are
// listed and the order they would be tagged in.
function extendArtifactSelectionTo(artifactId) {
  const rows = artifactRows();
  const anchorIndex = rows.findIndex((row) => row.dataset.artifactId === state.artifactAnchorId);
  const targetIndex = rows.findIndex((row) => row.dataset.artifactId === artifactId);
  if (anchorIndex === -1 || targetIndex === -1) {
    selectArtifact(artifactId);
    return;
  }
  const [from, to] = anchorIndex <= targetIndex
    ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  state.selectedArtifactIds = new Set(
    rows.slice(from, to + 1).map((row) => row.dataset.artifactId),
  );
  afterArtifactSelectionChange(artifactId);
}

function afterArtifactSelectionChange(activeId) {
  state.selectedArtifactId = activeId;
  syncArtifactRowSelection();
  highlightArtifactOnPage(activeId, { allowPageJump: true });
  const artifact = selectedArtifact();
  if (artifact && !artifact.bbox && !artifact.declaredBBox) {
    setStatus('This artifact paints nothing that could be placed on the page, so there is nothing to outline.');
  }
}

// Arrow-key navigation over the rows on show, matching the tag tree's - it
// walks the DOM rows rather than the array so it always follows what is
// actually listed. Holding Shift extends from the anchor instead of
// replacing, again as the tree does.
export function moveArtifactSelection(delta, { extend = false } = {}) {
  const rows = artifactRows();
  if (rows.length === 0) return;
  const index = rows.findIndex((row) => row.dataset.artifactId === state.selectedArtifactId);
  const next = index === -1
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(Math.max(index + delta, 0), rows.length - 1);
  if (next === index) return;
  const artifactId = rows[next].dataset.artifactId;
  if (extend && state.artifactAnchorId) extendArtifactSelectionTo(artifactId);
  else selectArtifact(artifactId);
  rows[next].scrollIntoView({ block: 'nearest' });
}

// Backs the Tag button (and double-clicking a row): turns the selected
// artifacts back into tagged content and hands the selection to the new tag,
// which also switches the pane back to the tag tree (see selectNode()).
//
// A multi-selection becomes *one* tag holding all of it, not one tag each -
// which is the point of being able to select several. A running head the
// file artifacted as three separate spans is one paragraph; tagging it three
// times would just move the problem into the tree.
//
// Page content streams are rewritten by this, so the preview's pdf.js copy
// is replaced before the tree is applied - the same order split_leaf()'s
// callers use, since the new tag's content leaves can only be read out of
// the new bytes.
export async function restoreSelectedArtifacts() {
  const artifacts = selectedArtifacts();
  if (artifacts.length === 0 || !state.docId) return;

  document.body.classList.add('busy');
  try {
    const result = await window.api.restoreArtifacts(
      state.docId,
      artifacts.map((a) => ({ pageIndex: a.pageIndex, index: a.index })),
      RESTORE_ROLE,
    );
    if (result.pdfBase64 && state.pdfDoc) await refreshPdfPreviewBytes(result.pdfBase64);
    applyFreshTree(result.tree);
    applyUndoState(result);
    if (result.newNodeId) selectNode(result.newNodeId);
    setStatus(restoredStatus(artifacts, result.taggedCount));
  } catch (err) {
    reportError(artifacts.length === 1 ? 'Could not tag this artifact' : 'Could not tag these artifacts', err);
  } finally {
    document.body.classList.remove('busy');
  }
}

function restoredStatus(artifacts, taggedCount) {
  if (artifacts.length === 1) {
    const [only] = artifacts;
    const kind = KIND_LABELS[only.kind] || only.kind;
    return `Tagged a ${kind} artifact on page ${only.pageIndex + 1} as <${RESTORE_ROLE}>.`;
  }
  const pages = new Set(artifacts.map((a) => a.pageIndex));
  const where = pages.size === 1
    ? `page ${artifacts[0].pageIndex + 1}`
    : `${pages.size} pages`;
  return `Tagged ${taggedCount} artifacts on ${where} as one <${RESTORE_ROLE}>.`;
}
