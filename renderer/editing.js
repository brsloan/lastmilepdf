// editing.js
//
// Every structural edit the user can make to the tag tree - undo/redo,
// moving and deleting tags, changing roles, grouping into lists and tables,
// joining, and shifting heading levels.
//
// These all follow the same shape: work out what the selection means, ask
// the worker to do it, then apply the tree it sends back.

import { applyFreshOutline } from './bookmarks.js';
import { closeDetails, refreshDetailsForSelection } from './details.js';
import { el, selectableRows } from './dom.js';
import { isListLabelLeaf } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { isDescendant } from './tree-index.js';
import { applyFreshTree, renderTree, selectNode } from './tree-view.js';

export async function performUndo() {
  if (!state.docId || !state.canUndo) return;
  try {
    const result = await window.api.undo(state.docId);
    applyFreshTree(result.tree);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    state.docInfo = result.docInfo || { title: null, author: null };
    applyUndoState(result);
    closeDetails();
    // Same reasoning as closeDetails() above, extended to the Table Editor:
    // its dialog isn't scoped to this undo (the Edit menu reaches it
    // regardless of what modal is open - see the accelerator note in
    // main.js), and a node id it's holding onto has no reliable
    // correspondence to "the same" element once the tree's been rebuilt
    // from a different snapshot. Rather than let it keep showing whatever
    // that id happens to resolve to now, close it - close() on an
    // already-closed <dialog> is a no-op per spec.
    el.tablePreviewDialog.close();
    setStatus('Undid last change.');
  } catch (err) {
    reportError('Could not undo', err);
  }
}

export async function performRedo() {
  if (!state.docId || !state.canRedo) return;
  try {
    const result = await window.api.redo(state.docId);
    applyFreshTree(result.tree);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    state.docInfo = result.docInfo || { title: null, author: null };
    applyUndoState(result);
    closeDetails();
    el.tablePreviewDialog.close(); // see the comment in performUndo() above
    setStatus('Redid change.');
  } catch (err) {
    reportError('Could not redo', err);
  }
}

export async function moveSelectedSibling(direction) {
  if (state.selectedNodeIds.size > 1) {
    await moveSelectedBlock(direction);
    return;
  }

  const nodeId = state.selectedNodeId;
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.node.type === 'root' || entry.parentId === null) return;
  const parentId = entry.parentId;
  const parentEntry = state.nodesById.get(parentId);
  if (!parentEntry) return;

  const siblings = parentEntry.node.children || [];
  const currentIndex = siblings.findIndex((child) => child.id === nodeId);
  if (currentIndex === -1) return;

  let newParentId = parentId;
  let newIndex = currentIndex + direction;

  // Set only for the "jump into the adjacent tag" case below - the usual
  // (parent, index) reselect trick doesn't work there (see the comment by
  // the reselect logic), so this carries what it needs instead.
  let jumpGrandParentId = null;
  let jumpAdjacentIndex = -1;

  if (newIndex < 0 || newIndex >= siblings.length) {
    // At the edge of its sibling list. Only possible to go any further if
    // the parent itself has a parent to work with (i.e. it isn't the
    // struct root).
    if (parentEntry.parentId === null) return;
    const grandParentId = parentEntry.parentId;
    const grandParentEntry = state.nodesById.get(grandParentId);
    if (!grandParentEntry) return;
    const parentSiblings = grandParentEntry.node.children || [];
    const parentIndex = parentSiblings.findIndex((child) => child.id === parentId);
    if (parentIndex === -1) return;

    // A content/object-ref leaf pushed past the end/start of its own
    // parent's children jumps into the *adjacent* tag at that same level
    // instead of merely outdenting - the next tag below when moving past
    // the last child, the previous tag above when moving past the first -
    // landing in its first/last content slot respectively. That's the
    // content-leaf equivalent of "keep moving in this direction", since
    // sitting it beside its own parent wouldn't make it content of
    // anything. Element tags always just outdent (the `else` branch).
    const isContentLeaf = entry.node.type === 'content' || entry.node.type === 'object-ref';
    const adjacentTag = isContentLeaf ? parentSiblings[parentIndex + direction] : undefined;

    if (adjacentTag && adjacentTag.type === 'element') {
      newParentId = adjacentTag.id;
      newIndex = direction < 0 ? adjacentTag.children.length : 0;
      jumpGrandParentId = grandParentId;
      jumpAdjacentIndex = parentIndex + direction;
    } else {
      // Outdent past the parent instead: moving up out of the first child
      // slot drops the tag just before its (former) parent; moving down
      // out of the last child slot drops it just after.
      newParentId = grandParentId;
      newIndex = direction < 0 ? parentIndex : parentIndex + 1;
    }
  }

  try {
    const result = await window.api.reorderNode(state.docId, nodeId, newParentId, newIndex);
    applyFreshTree(result.tree);
    applyUndoState(result);
    // Node ids are reassigned by depth-first position on every rebuild (see
    // tag_worker.py). For a plain sibling move or an outdent, newParentId
    // is always an *ancestor* of the moved node's old position, and an
    // ancestor's id is stable across the rebuild (it's assigned before its
    // own children are visited, and neither move changes its position
    // among its siblings) - so the usual (parent, index) lookup still
    // finds the right node. Jumping into an adjacent tag is different: that
    // tag is a *sibling*, and moving a leaf out of one side of it and into
    // the other shifts the depth-first counter enough that the sibling's
    // own id can change (it may even end up reused by the node we just
    // moved). Its *grandparent* and its position among *its* siblings are
    // still both stable though (neither was touched by this move), so
    // re-locate it structurally through those instead of trusting the
    // captured id.
    let movedNode;
    if (jumpGrandParentId !== null) {
      const freshAdjacentTag = state.nodesById.get(jumpGrandParentId)?.node.children?.[jumpAdjacentIndex];
      movedNode = freshAdjacentTag?.children?.[newIndex];
    } else {
      movedNode = state.nodesById.get(newParentId)?.node.children?.[newIndex];
    }
    if (movedNode) selectNode(movedNode.id);
    setStatus('Moved tag.');
  } catch (err) {
    reportError('Could not move tag', err);
  }
}

// Ctrl/Cmd+Up/Down with multiple tags selected: steps the whole block one
// slot earlier/later, same as the single-tag case, but only when the
// selection is a single contiguous run of siblings under one parent - no
// outdent generalization for blocks, since "just before/after the parent"
// isn't well-defined once more than one tag is moving.
async function moveSelectedBlock(direction) {
  const rows = selectableRows();
  const orderedIds = rows.map((r) => r.dataset.nodeId).filter((id) => state.selectedNodeIds.has(id));
  const topLevelIds = orderedIds.filter((id) => !orderedIds.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  const parentIds = new Set(topLevelIds.map((id) => state.nodesById.get(id)?.parentId));
  if (parentIds.size !== 1) {
    setStatus("Can't move: selected tags don't share a parent.");
    return;
  }
  const parentId = Array.from(parentIds)[0];
  const parentEntry = state.nodesById.get(parentId);
  if (!parentEntry) return;

  const siblings = parentEntry.node.children || [];
  const siblingIds = siblings.map((s) => s.id);
  const blockIndices = topLevelIds.map((id) => siblingIds.indexOf(id)).sort((a, b) => a - b);
  if (blockIndices.some((i) => i === -1)) return;
  for (let i = 1; i < blockIndices.length; i++) {
    if (blockIndices[i] !== blockIndices[i - 1] + 1) {
      setStatus("Can't move: selected tags aren't contiguous.");
      return;
    }
  }

  const firstIndex = blockIndices[0];
  const newFirstIndex = firstIndex + direction;
  if (newFirstIndex < 0 || newFirstIndex + blockIndices.length > siblings.length) return;
  const orderedBlockIds = blockIndices.map((i) => siblingIds[i]);

  try {
    const result = await window.api.reorderMany(state.docId, orderedBlockIds, parentId, newFirstIndex);
    applyFreshTree(result.tree);
    applyUndoState(result);
    const newSiblings = state.nodesById.get(parentId)?.node.children || [];
    const movedIds = newSiblings.slice(newFirstIndex, newFirstIndex + orderedBlockIds.length).map((c) => c.id);
    if (movedIds.length > 0) {
      state.selectedNodeIds = new Set(movedIds);
      state.selectedNodeId = movedIds[movedIds.length - 1];
      state.selectionAnchorId = movedIds[0];
      renderTree();
      refreshDetailsForSelection();
    }
    setStatus('Moved tags.');
  } catch (err) {
    reportError('Could not move tags', err);
  }
}

export async function deleteSelection() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  // Only the top-level selected nodes need to be sent - deleting an
  // ancestor already takes its whole subtree, including any selected
  // descendants, with it.
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  let tagCount = 0;
  let contentCount = 0;
  for (const id of topLevelIds) {
    const entry = state.nodesById.get(id);
    if (entry?.node.type === 'element') tagCount += 1;
    else contentCount += 1;
  }

  // Figure out which sibling tag to land the selection on afterward: the
  // surviving sibling right after the deleted run, the one right before it
  // if the run reached the end of its parent's children, or the parent
  // itself if nothing survives under it. Always a same-level sibling, never
  // a descendant - selectNode()'s expandAncestors only opens *ancestors* of
  // the new selection, so picking a sibling (as opposed to e.g. a content
  // leaf found by walking rendered rows, which could sit inside a
  // still-collapsed neighbor) never force-expands anything. Node ids are
  // reassigned by depth-first position on every rebuild (see
  // moveSelectedSibling above), so the target is re-located structurally
  // through (parent id, sibling index) rather than a captured id.
  //
  // If the selection spans more than one parent, the reference parent is
  // whichever one holds the (visually) last deleted top-level tag.
  const rows = selectableRows();
  const orderedTopLevelIds = rows.map((row) => row.dataset.nodeId).filter((id) => topLevelIds.includes(id));
  const lastDeletedId = orderedTopLevelIds[orderedTopLevelIds.length - 1] ?? topLevelIds[0];
  const refParentId = state.nodesById.get(lastDeletedId)?.parentId ?? null;

  let refIndex = -1;
  if (refParentId !== null) {
    const parentSiblings = state.nodesById.get(refParentId)?.node.children || [];
    const deletedInParent = topLevelIds.filter((id) => state.nodesById.get(id)?.parentId === refParentId);
    const indices = deletedInParent
      .map((id) => parentSiblings.findIndex((child) => child.id === id))
      .filter((i) => i !== -1);
    if (indices.length > 0) refIndex = Math.min(...indices);
  }

  try {
    const result = await window.api.deleteNodes(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    const newParentEntry = refParentId !== null ? state.nodesById.get(refParentId) : null;
    const newSiblings = newParentEntry?.node.children || [];
    const nextTarget = refIndex !== -1 ? (newSiblings[refIndex] || newSiblings[refIndex - 1]) : null;
    if (nextTarget) {
      selectNode(nextTarget.id);
    } else if (newParentEntry && newParentEntry.node.type !== 'root') {
      selectNode(refParentId);
    } else {
      closeDetails();
    }

    const parts = [];
    if (tagCount > 0) parts.push(`deleted ${tagCount} tag${tagCount === 1 ? '' : 's'}`);
    if (contentCount > 0) parts.push(`artifacted ${contentCount} content element${contentCount === 1 ? '' : 's'}`);
    const message = parts.join(' and ');
    setStatus(message.charAt(0).toUpperCase() + message.slice(1) + '.');
  } catch (err) {
    reportError('Could not delete selection', err);
  }
}

// Backs the H1-H6, 'D', 'H', and 'C' shortcuts: relabels each already-tagged
// selected node's role in place, and wraps any selected content/object-ref
// leaf in a brand-new element with that role. A wrapped leaf's id ends up
// pointing at its new wrapper rather than the leaf itself (it lands in the
// same depth-first slot the leaf used to occupy - see set_role_or_wrap() in
// tag_worker.py), which is what we want selected afterward anyway. Not used
// for the 'I' shortcut - see convertSelectionToListItem(), which needs the
// Lbl/LBody handling convert_to_list_item() backs it with instead.
export async function applyRoleShortcut(role) {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;
  const allElements = ids.every((id) => state.nodesById.get(id)?.node.type === 'element');

  try {
    const result = await window.api.setRoleOrWrap(state.docId, ids, role);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (ids.length === 1) {
      if (state.nodesById.has(ids[0])) selectNode(ids[0]);
      else closeDetails();
    } else if (allElements) {
      // A pure batch of role relabels doesn't touch tree shape, so every id
      // is still exactly where it was - safe to keep the whole selection,
      // same as the bulk Role field edit does.
      state.selectedNodeIds = new Set(ids.filter((id) => state.nodesById.has(id)));
      state.selectedNodeId = state.selectedNodeIds.has(state.selectedNodeId)
        ? state.selectedNodeId
        : Array.from(state.selectedNodeIds).pop();
      renderTree();
      refreshDetailsForSelection();
    } else {
      // A mix of tags and content leaves: wrapping any one of the leaves
      // shifts the ids of everything after it in document order, so the
      // rest of the captured ids can no longer be trusted to point at the
      // right nodes - drop the selection rather than risk a silent
      // mis-select.
      closeDetails();
    }
    setStatus(`Set ${ids.length} tag${ids.length === 1 ? '' : 's'} to ${role}.`);
  } catch (err) {
    reportError(`Could not convert to ${role}`, err);
  }
}

// Backs the 'P' shortcut: converts each selected tag to a Paragraph, except
// a List/Span/Div, which gets flattened into paragraphs instead (see
// convert_to_paragraph() in tag_worker.py for why). Reselects on a single
// target the same way applyRoleShortcut() does - the old id still resolves
// to whatever now occupies that slot, whether that's the relabeled tag, a
// wrapped leaf, or (for a flattened container) the first of its
// replacements. A multi-target conversion can restructure arbitrarily much
// of the tree at once, so it just clears the selection instead.
export async function convertSelectionToParagraph() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  try {
    const result = await window.api.convertToParagraph(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (topLevelIds.length === 1 && state.nodesById.has(topLevelIds[0])) {
      selectNode(topLevelIds[0]);
    } else {
      closeDetails();
    }
    setStatus(`Converted ${topLevelIds.length} tag${topLevelIds.length === 1 ? '' : 's'} to paragraph.`);
  } catch (err) {
    reportError('Could not convert to paragraph', err);
  }
}

// Backs the Ctrl/Cmd+P shortcut and the "Add P" button: inserts a brand-new,
// empty Paragraph tag right after the current selection (or at the end of
// the document if nothing is selected) - unlike the bare 'P' shortcut above,
// which converts the existing selection in place, this always creates a
// fresh tag alongside it. See insert_paragraph_after() in tag_worker.py.
export async function insertParagraphAfterSelection() {
  if (!state.docId) return;

  try {
    const result = await window.api.insertParagraphAfter(state.docId, state.selectedNodeId || null);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (result.newNodeId && state.nodesById.has(result.newNodeId)) {
      selectNode(result.newNodeId);
    }
    setStatus('Inserted new paragraph tag.');
  } catch (err) {
    reportError('Could not insert paragraph', err);
  }
}

// Backs the 'F' shortcut: converts each selected tag to a Figure, collapsing
// its whole subtree down to just its content/object-ref leaves (see
// convert_to_figure() in tag_worker.py for why - a Figure holds its content
// directly rather than through nested structure). Reselects on a single
// target the same way convertSelectionToParagraph() does. A multi-target
// conversion can restructure arbitrarily much of the tree at once, so it
// just clears the selection instead.
export async function convertSelectionToFigure() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  try {
    const result = await window.api.convertToFigure(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (topLevelIds.length === 1 && state.nodesById.has(topLevelIds[0])) {
      selectNode(topLevelIds[0]);
    } else {
      closeDetails();
    }
    setStatus(`Converted ${topLevelIds.length} tag${topLevelIds.length === 1 ? '' : 's'} to figure.`);
  } catch (err) {
    reportError('Could not convert to figure', err);
  }
}

// Backs the 'I' shortcut: converts each selected tag to an LI, collapsing
// its whole subtree down to just its content/object-ref leaves the same way
// convertSelectionToFigure() does (see convert_to_list_item() in
// tag_worker.py) - except those leaves are then split into a Lbl (just a
// bare label marker, per isListLabelLeaf()) plus an LBody, or wrapped in a
// single LBody otherwise, rather than sitting directly under the LI.
// Reselects on a single target the same way convertSelectionToFigure()
// does; a multi-target conversion can restructure arbitrarily much of the
// tree at once, so it just clears the selection instead.
export async function convertSelectionToListItem() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  const labelFlags = {};
  for (const id of topLevelIds) labelFlags[id] = await isListLabelLeaf(id);

  try {
    const result = await window.api.convertToListItem(state.docId, topLevelIds, labelFlags);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (topLevelIds.length === 1 && state.nodesById.has(topLevelIds[0])) {
      selectNode(topLevelIds[0]);
    } else {
      closeDetails();
    }
    setStatus(`Converted ${topLevelIds.length} tag${topLevelIds.length === 1 ? '' : 's'} to list item.`);
  } catch (err) {
    reportError('Could not convert to list item', err);
  }
}

// Backs the 'L' shortcut: groups the whole selection into a newly created
// List (see make_list() in tag_worker.py) - every selected node becomes an
// LI, and the List lands where the first one (in document order) used to
// sit. Each item's own content is rebuilt from its first leaf's text: a
// bare label marker (bullet/letter+period/digits+period - see
// isListLabelLeaf()) splits it into a Lbl holding just that leaf plus an
// LBody holding the rest, otherwise everything goes into one LBody. That
// new List always ends up occupying the depth-first slot the first
// selected item's old id pointed to, so reselecting via that id shows the
// new List itself once the tree refreshes.
export async function groupSelectionIntoList() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;

  const rows = selectableRows();
  const orderedIds = rows.map((row) => row.dataset.nodeId).filter((id) => ids.includes(id));
  const firstId = orderedIds[0] ?? ids[0];

  const labelFlags = {};
  for (const id of ids) labelFlags[id] = await isListLabelLeaf(id);

  try {
    const result = await window.api.makeList(state.docId, ids, labelFlags);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (state.nodesById.has(firstId)) selectNode(firstId);
    else closeDetails();
    setStatus(`Grouped ${ids.length} tag${ids.length === 1 ? '' : 's'} into a new list.`);
  } catch (err) {
    reportError('Could not create list', err);
  }
}

// Shared by the 'T' and 'R' shortcuts: both group the whole selection into
// a newly created container (Table/TR) the same way 'L' does for List, via
// `apiCall` - each selected node becomes a child of the new container,
// converted to TD unless it's already one of `preservedRoles`. See
// make_table()/make_tr() in tag_worker.py for the per-role conversion rule.
async function groupSelectionIntoContainer(apiCall, label) {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  if (ids.length === 0) return;

  const rows = selectableRows();
  const orderedIds = rows.map((row) => row.dataset.nodeId).filter((id) => ids.includes(id));
  const firstId = orderedIds[0] ?? ids[0];

  try {
    const result = await apiCall(state.docId, ids);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (state.nodesById.has(firstId)) selectNode(firstId);
    else closeDetails();
    setStatus(`Grouped ${ids.length} tag${ids.length === 1 ? '' : 's'} into a new ${label}.`);
  } catch (err) {
    reportError(`Could not create ${label}`, err);
  }
}

export function groupSelectionIntoTable() {
  return groupSelectionIntoContainer(window.api.makeTable, 'table');
}

export function groupSelectionIntoTr() {
  return groupSelectionIntoContainer(window.api.makeTr, 'table row');
}

// Backs the 'J' shortcut: merges tag(s) together via join_tags() in
// tag_worker.py. With one tag selected, it's merged into its own previous
// sibling; with several, all but the earliest-selected (in document order)
// are merged into that one. Either way the target keeps its id across the
// rebuild (see join_tags()'s docstring for why), so it's computed here
// up front purely to know what to reselect on success - the backend is the
// one source of truth for whether the join is actually valid (shared
// parent, previous-sibling existence, same-page marked content), and a
// rejected join just surfaces via reportError like any other op here.
export async function joinSelection() {
  const ids = Array.from(state.selectedNodeIds).filter((id) => id !== 'root');
  const topLevelIds = ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)));
  if (topLevelIds.length === 0) return;

  let targetId;
  if (topLevelIds.length === 1) {
    const entry = state.nodesById.get(topLevelIds[0]);
    const parentEntry = entry ? state.nodesById.get(entry.parentId) : null;
    const siblings = parentEntry?.node.children || [];
    const idx = siblings.findIndex((child) => child.id === topLevelIds[0]);
    if (idx > 0) targetId = siblings[idx - 1].id;
  } else {
    const rows = selectableRows();
    const orderedIds = rows.map((row) => row.dataset.nodeId).filter((id) => topLevelIds.includes(id));
    targetId = orderedIds[0] ?? topLevelIds[0];
  }

  try {
    const result = await window.api.joinTags(state.docId, topLevelIds);
    applyFreshTree(result.tree);
    applyUndoState(result);

    if (targetId && state.nodesById.has(targetId)) selectNode(targetId);
    else closeDetails();
    setStatus(`Joined ${topLevelIds.length + 1} tags into one.`);
  } catch (err) {
    reportError('Could not join tags', err);
  }
}

// Changes the selected node's heading level by `direction` (+1/-1) if it's
// currently H1-H6, clamped to that range. Returns true if the tag is a
// heading at all (regardless of whether it was already at the clamp), so
// callers know to treat the key as handled either way. Only acts on a
// single selected tag - unlike Role, heading level isn't specified as a
// block operation, so applying it to just the active tag out of several
// selected would be a silent partial edit. When multiple tags are selected
// in the Headings filter, callers use shiftSelectedHeadingLevels() instead,
// which steps every selection independently.
export function attemptHeadingLevelChange(direction) {
  if (state.selectedNodeIds.size > 1) return false;
  const entry = state.nodesById.get(state.selectedNodeId);
  if (!entry || entry.node.type !== 'element') return false;
  const match = /^H([1-6])$/.exec(entry.node.role || '');
  if (!match) return false;

  const level = Number(match[1]);
  const newLevel = level + direction;
  if (newLevel >= 1 && newLevel <= 6) changeHeadingLevel(state.selectedNodeId, newLevel);
  return true;
}

async function changeHeadingLevel(nodeId, newLevel) {
  try {
    const result = await window.api.updateNode(state.docId, nodeId, { role: `H${newLevel}` });
    applyFreshTree(result.tree);
    applyUndoState(result);
    // A role-only change doesn't touch the tree's structure, so the
    // depth-first id assignment (see tag_worker.py) reproduces the same id.
    selectNode(nodeId);
    setStatus(`Changed to H${newLevel}.`);
  } catch (err) {
    reportError('Could not change heading level', err);
  }
}

// Steps every selected heading's level by `direction` independently (an H1
// and H3 both selected become H2 and H4), clamped to H1-H6, as one undo
// step. Used when Left/Right is pressed in the Headings filter with more
// than one tag selected.
export async function shiftSelectedHeadingLevels(direction) {
  const selectedIds = Array.from(state.selectedNodeIds);
  try {
    const result = await window.api.shiftHeadingLevels(state.docId, selectedIds, direction);
    applyFreshTree(result.tree);
    applyUndoState(result);
    // Role-only changes don't touch the tree's structure, so ids survive.
    refreshDetailsForSelection();
    setStatus(`Changed heading level for ${selectedIds.length} tags.`);
  } catch (err) {
    reportError('Could not change heading levels', err);
  }
}
