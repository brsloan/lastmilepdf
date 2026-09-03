// table-editor.js
//
// The Expand dialog's interactive table grid: cell selection, header/scope
// edits, and applying those back through the worker.

import { applyFreshTree } from './tree-view.js';
import { refreshDetailsForSelection } from './details.js';
import { el } from './dom.js';
import { pullCellText } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { buildTableGrid, collectRowCells, collectTableRows, createTableCellElement } from './table-preview.js';

// Guards every operation below that mutates the table through the worker
// (committing a cell edit, Add Row/Column, Delete, Convert to TH/TD) against
// running concurrently with another one. Without this, starting a second
// one (e.g. double-clicking another cell) while the first is still awaiting
// its IPC round-trip left both racing to rebuild
// el.tablePreviewDialogContainer out from under each other - clearing it
// mid-edit forces an implicit blur on whatever textarea was still open,
// re-entrantly firing *that* cell's own commit while the first one's is
// still in flight. See runTableEditorMutation() below.
let tableEditorMutationInFlight = false;

// Runs `fn` (an async mutation) unless one is already in flight, in which
// case the new attempt is dropped - see tableEditorMutationInFlight above.
async function runTableEditorMutation(fn) {
  if (tableEditorMutationInFlight) return;
  tableEditorMutationInFlight = true;
  try {
    await fn();
  } finally {
    tableEditorMutationInFlight = false;
  }
}

export async function renderTableEditor(tableNode) {
  const token = ++state.tableEditorToken;
  el.tablePreviewDialogContainer.innerHTML = '';
  state.tableEditorGrid = null;

  const rows = collectTableRows(tableNode);
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'table-preview-empty';
    p.textContent = 'No rows found in this table.';
    el.tablePreviewDialogContainer.appendChild(p);
    updateTableEditorFields();
    return;
  }

  const { positions, colCount } = buildTableGrid(rows);
  state.tableEditorGrid = { positions, colCount };

  const table = document.createElement('table');
  table.className = 'editor-table';

  const headerRow = document.createElement('tr');
  headerRow.appendChild(document.createElement('th')).className = 'editor-corner';
  for (let c = 0; c < colCount; c++) {
    const arrow = document.createElement('th');
    arrow.className = 'editor-col-arrow';
    arrow.textContent = '▾';
    arrow.title = 'Select column';
    arrow.addEventListener('click', () => selectTableEditorColumn(c));
    headerRow.appendChild(arrow);
  }
  table.appendChild(headerRow);

  for (let r = 0; r < rows.length; r++) {
    const trEl = document.createElement('tr');
    const rowArrow = document.createElement('th');
    rowArrow.className = 'editor-row-arrow';
    rowArrow.textContent = '▸';
    rowArrow.title = 'Select row';
    rowArrow.addEventListener('click', () => selectTableEditorRow(rows[r]));
    trEl.appendChild(rowArrow);

    for (const cell of collectRowCells(rows[r])) {
      const text = await pullCellText(cell);
      if (token !== state.tableEditorToken) return; // dialog closed/reopened mid-flight

      const cellEl = createTableCellElement(cell, text);
      cellEl.classList.add('editor-cell');
      cellEl.dataset.cellId = cell.id;
      cellEl.dataset.previewText = text;
      if (state.tableEditorSelectedIds.has(cell.id)) cellEl.classList.add('cell-selected');
      if (cell.id === state.tableEditorAnchorId) cellEl.classList.add('cell-anchor');
      // Suppresses the native text-drag-selection a mousedown+drag across
      // cells would otherwise start - CSS `user-select: none` covers a
      // plain click but not a drag, and the whole point of the click
      // handler below is to select cells, not their text.
      cellEl.addEventListener('mousedown', (e) => e.preventDefault());
      cellEl.addEventListener('click', (e) => handleTableEditorCellClick(e, cell.id));
      cellEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEditingTableEditorCell(cell.id);
      });
      trEl.appendChild(cellEl);
    }
    table.appendChild(trEl);
  }

  if (token !== state.tableEditorToken) return;
  el.tablePreviewDialogContainer.appendChild(table);
  updateTableEditorFields();
}

// A column arrow's click target: every cell whose span covers that logical
// column, however many TH/TD elements that actually is. Recorded as a
// *column* selection (state.tableEditorSelectionKind), distinct from a
// cell-by-cell selection that just happens to cover the same cells, so the
// Delete key (see deleteTableEditorSelection()) knows to delete a whole
// column's cells rather than nothing.
function selectTableEditorColumn(colIndex) {
  if (!state.tableEditorGrid) return;
  const ids = [];
  for (const [cellId, pos] of state.tableEditorGrid.positions) {
    if (colIndex >= pos.col && colIndex < pos.col + pos.colSpan) ids.push(cellId);
  }
  state.tableEditorSelectedIds = new Set(ids);
  state.tableEditorAnchorId = ids[ids.length - 1] || null;
  state.tableEditorSelectionKind = 'column';
  state.tableEditorSelectedRowId = null;
  state.tableEditorSelectedColIndex = colIndex;
  refreshTableEditorSelectionUI();
}

// Same idea for a row arrow - see selectTableEditorColumn() above.
function selectTableEditorRow(trNode) {
  const ids = collectRowCells(trNode).map((cell) => cell.id);
  state.tableEditorSelectedIds = new Set(ids);
  state.tableEditorAnchorId = ids[ids.length - 1] || null;
  state.tableEditorSelectionKind = 'row';
  state.tableEditorSelectedRowId = trNode.id;
  state.tableEditorSelectedColIndex = null;
  refreshTableEditorSelectionUI();
}

// Plain click selects just this cell; Ctrl/Cmd+click toggles it into/out of
// the selection (mirrors the tag tree's own selection gestures); Shift+click
// selects the rectangular block between the anchor cell and this one, by
// grid position rather than document order, so it behaves the way dragging
// a selection across a spreadsheet would.
function handleTableEditorCellClick(e, cellId) {
  // A direct cell click/ctrl-click/shift-click never counts as "a row" or
  // "a column" for the Delete key, even if it happens to end up covering
  // exactly one - only the row/column arrows (see selectTableEditorRow()/
  // selectTableEditorColumn() above) set those.
  state.tableEditorSelectionKind = 'cell';
  state.tableEditorSelectedRowId = null;
  state.tableEditorSelectedColIndex = null;
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.tableEditorSelectedIds);
    if (next.has(cellId)) next.delete(cellId);
    else next.add(cellId);
    state.tableEditorSelectedIds = next;
    state.tableEditorAnchorId = cellId;
  } else if (e.shiftKey && state.tableEditorAnchorId && state.tableEditorGrid) {
    const { positions } = state.tableEditorGrid;
    const anchorPos = positions.get(state.tableEditorAnchorId);
    const clickedPos = positions.get(cellId);
    if (anchorPos && clickedPos) {
      const rowMin = Math.min(anchorPos.row, clickedPos.row);
      const rowMax = Math.max(anchorPos.row + anchorPos.rowSpan - 1, clickedPos.row + clickedPos.rowSpan - 1);
      const colMin = Math.min(anchorPos.col, clickedPos.col);
      const colMax = Math.max(anchorPos.col + anchorPos.colSpan - 1, clickedPos.col + clickedPos.colSpan - 1);
      const ids = [];
      for (const [id, pos] of positions) {
        const posRowMax = pos.row + pos.rowSpan - 1;
        const posColMax = pos.col + pos.colSpan - 1;
        if (pos.row <= rowMax && posRowMax >= rowMin && pos.col <= colMax && posColMax >= colMin) ids.push(id);
      }
      state.tableEditorSelectedIds = new Set(ids);
    } else {
      state.tableEditorSelectedIds = new Set([cellId]);
      state.tableEditorAnchorId = cellId;
    }
  } else {
    state.tableEditorSelectedIds = new Set([cellId]);
    state.tableEditorAnchorId = cellId;
  }
  refreshTableEditorSelectionUI();
}

// Double-clicking a cell lets you edit that cell tag's own Actual Text in
// place, without opening the main Details panel (whose selection is
// separate from the table editor's - see state.tableEditorSelectedIds vs
// state.selectedNodeIds). Mirrors startRenamingBookmark()'s inline-input
// pattern in bookmarks.js. The input starts pre-filled with whatever text
// the cell is currently showing (cellEl.dataset.previewText, stashed by
// renderTableEditor() from the same pullCellText() call that produced it) -
// that's the cell's own Actual Text when it already has one, or the
// composited pulled content when it doesn't - rather than the raw
// node.actualText, which would start the input blank for the common case
// of a cell that has never had its own Actual Text set.
function startEditingTableEditorCell(cellId) {
  if (!state.nodesById.has(cellId)) return;
  // Don't open a second cell for editing while another one's commit (or any
  // other table-editor mutation) is still in flight - see
  // tableEditorMutationInFlight above.
  if (tableEditorMutationInFlight) return;
  const cellEl = /** @type {HTMLElement} */ (
    el.tablePreviewDialogContainer.querySelector(`[data-cell-id="${cellId}"]`)
  );
  if (!cellEl || cellEl.querySelector('.editor-cell-input')) return;

  // Capture the cell's current inner size (content + padding) before
  // touching its content or padding below. Clearing the preview text (and,
  // if this happens to be the row's tallest or the column's widest cell,
  // leaving the row/column's size driven only by its *other* cells) would
  // otherwise shrink or grow the whole row/column - a table's auto column
  // widths are recomputed from live cell content same as row heights are -
  // the instant editing starts, then snap back on commit/cancel.
  // Re-imposing these same amounts, now entirely as `height`/`width` since
  // padding drops to 0 below, keeps entering edit mode from reflowing the
  // table at all.
  const originalHeight = cellEl.clientHeight;
  const originalWidth = cellEl.clientWidth;

  const previewText = cellEl.dataset.previewText || '';
  const input = document.createElement('textarea');
  input.className = 'editor-cell-input';
  input.value = previewText;
  input.rows = 1;
  cellEl.textContent = '';
  cellEl.classList.add('cell-editing');
  cellEl.style.height = `${originalHeight}px`;
  cellEl.style.width = `${originalWidth}px`;
  cellEl.appendChild(input);
  // A CSS height:100% wouldn't fill this - a table cell's height is auto
  // (driven by its row's content), and Chromium doesn't resolve a
  // percentage height against an auto-height ancestor even for a table
  // cell, so a taller row (from a longer sibling cell) would otherwise
  // leave this textarea only as tall as its own single line. Measuring the
  // now-laid-out cell (locked to its original height just above) and
  // setting the height explicitly fills it exactly.
  input.style.height = `${cellEl.clientHeight}px`;
  input.focus();
  input.select();

  // Keeps clicks/drags inside the input from reaching the cell's own
  // mousedown (preventDefault, to suppress drag-select) and click (cell
  // selection) listeners above - both would otherwise fire on every
  // interaction with the input itself, including the mousedown that's
  // supposed to just place the cursor.
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());

  let settled = false;

  const commit = () => runTableEditorMutation(async () => {
    if (settled) return;
    settled = true;
    const newText = input.value.trim();
    if (newText === previewText) {
      await refreshTableEditorAfterEdit();
      return;
    }
    try {
      const result = await window.api.updateNode(state.docId, cellId, { actualText: newText });
      applyFreshTree(result.tree);
      applyUndoState(result);
      await refreshTableEditorAfterEdit();
      setStatus('Updated cell Actual Text.');
    } catch (err) {
      reportError('Could not update cell Actual Text', err);
      await refreshTableEditorAfterEdit();
    }
  });

  const cancel = () => runTableEditorMutation(async () => {
    if (settled) return;
    settled = true;
    await refreshTableEditorAfterEdit();
  });

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

// Restyles the already-built cells in place rather than a full rebuild -
// selection alone never changes the table's shape or content.
function refreshTableEditorSelectionUI() {
  el.tablePreviewDialogContainer.querySelectorAll('.editor-cell')
    .forEach((/** @type {HTMLElement} */ cellEl) => {
    const id = cellEl.dataset.cellId;
    cellEl.classList.toggle('cell-selected', state.tableEditorSelectedIds.has(id));
    cellEl.classList.toggle('cell-anchor', id === state.tableEditorAnchorId);
  });
  updateTableEditorFields();
}

// Mirrors refreshDetailsForSelection()'s TH-attributes gating: Scope only
// applies (and is shown) when every selected cell is a TH, while Column
// span/Row span apply to TH and TD alike. The displayed values come from
// the anchor cell (the most recently/explicitly selected one) when it's
// part of the selection, else an arbitrary member - same "one representative
// node" approach the main details panel uses for a multi-select.
function updateTableEditorFields() {
  const ids = Array.from(state.tableEditorSelectedIds).filter((id) => state.nodesById.has(id));
  if (ids.length === 0) {
    el.tableEditorHint.hidden = false;
    el.tableEditorFieldRow.hidden = true;
    return;
  }
  el.tableEditorHint.hidden = true;
  el.tableEditorFieldRow.hidden = false;

  const allTH = ids.every((id) => state.nodesById.get(id)?.node.role === 'TH');
  el.tableEditorScopeWrap.hidden = !allTH;

  const repId = state.tableEditorAnchorId && ids.includes(state.tableEditorAnchorId)
    ? state.tableEditorAnchorId
    : ids[ids.length - 1];
  const repNode = state.nodesById.get(repId)?.node;
  el.tableEditorScope.value = allTH ? (repNode?.scope || '') : '';
  el.tableEditorColSpan.value = repNode?.colSpan != null ? String(repNode.colSpan) : '';
  el.tableEditorRowSpan.value = repNode?.rowSpan != null ? String(repNode.rowSpan) : '';
}

// Re-reads the Table tag from the just-refreshed tree and rebuilds the
// editor table from it, then re-syncs the main details panel too (a no-op
// unless this same table - or one of its cells - happens to be the active
// tree selection, e.g. its inline preview needs the same update).
//
// state.tableEditorTableId is a node id, and node ids are a fresh
// depth-first counter reassigned on every tree rebuild (see the module
// docstring in tag_worker.py) - normally stable across a table-editor
// mutation (nothing here ever inserts/removes anything *before* the table
// in document order), but Undo/Redo isn't scoped to this dialog: it's
// wired to the Edit menu (see renderer.js), which an HTML <dialog>'s
// modality does nothing to block, and can revert the tree to a shape where
// this id now points at something else entirely - or nothing. Rendering
// whatever that id happens to resolve to as if it were still the table
// (previously: collectTableRows() on a non-Table node just silently found
// no rows) is what produced the confusing "No rows found in this table" -
// checking the role here catches that and closes the dialog instead of
// showing a plausible-looking lie.
export async function refreshTableEditorAfterEdit() {
  const tableEntry = state.tableEditorTableId ? state.nodesById.get(state.tableEditorTableId) : null;
  if (state.tableEditorTableId && (!tableEntry || tableEntry.node.role !== 'Table')) {
    setStatus('This table is no longer open - Undo/Redo may have changed it.');
    el.tablePreviewDialog.close();
  } else if (tableEntry) {
    await renderTableEditor(tableEntry.node);
  }
  refreshDetailsForSelection();
}

// Clears the Table Editor's selection state entirely - used after an add/
// delete, since the ids it referred to (a deleted row/column's cells, or
// just-shifted siblings) are no longer meaningful, and renderTableEditor()
// would otherwise carry stale ids into the rebuilt grid's selection classes.
function resetTableEditorSelection() {
  state.tableEditorSelectedIds = new Set();
  state.tableEditorAnchorId = null;
  state.tableEditorSelectionKind = null;
  state.tableEditorSelectedRowId = null;
  state.tableEditorSelectedColIndex = null;
}

// Backs the Table Editor's "Add Row" button: appends a new TR (with one
// empty TD per existing column) to the end of the table - see
// add_table_row() in tag_worker.py for exactly how it picks the row count
// and where the new row attaches.
export async function addTableEditorRow() {
  if (!state.tableEditorTableId) return;
  await runTableEditorMutation(async () => {
    try {
      const result = await window.api.addTableRow(state.docId, state.tableEditorTableId);
      applyFreshTree(result.tree);
      applyUndoState(result);
      resetTableEditorSelection();
      await refreshTableEditorAfterEdit();
      setStatus('Added row.');
    } catch (err) {
      reportError('Could not add row', err);
    }
  });
}

// Backs the Table Editor's "Add Column" button: appends one new empty TD to
// every existing row - see add_table_column() in tag_worker.py.
export async function addTableEditorColumn() {
  if (!state.tableEditorTableId) return;
  await runTableEditorMutation(async () => {
    try {
      const result = await window.api.addTableColumn(state.docId, state.tableEditorTableId);
      applyFreshTree(result.tree);
      applyUndoState(result);
      resetTableEditorSelection();
      await refreshTableEditorAfterEdit();
      setStatus('Added column.');
    } catch (err) {
      reportError('Could not add column', err);
    }
  });
}

// Backs the Table Editor dialog's Delete key: removes the row or column the
// row/column arrows last selected (state.tableEditorSelectionKind, set by
// selectTableEditorRow()/selectTableEditorColumn() above - a plain cell
// selection is deliberately not handled here, see handleTableEditorCellClick()).
// A row is deleted as a single TR subtree (taking its cells with it,
// exactly like deleting any other tag - see delete_nodes() in
// tag_worker.py); a column has no tag of its own to delete, so it's each of
// that column's cells, deleted together as one undo step.
export async function deleteTableEditorSelection() {
  if (state.tableEditorSelectionKind === 'row' && state.tableEditorSelectedRowId) {
    const rowId = state.tableEditorSelectedRowId;
    if (!state.nodesById.has(rowId)) return;
    await runTableEditorMutation(async () => {
      try {
        const result = await window.api.deleteNodes(state.docId, [rowId]);
        applyFreshTree(result.tree);
        applyUndoState(result);
        resetTableEditorSelection();
        await refreshTableEditorAfterEdit();
        setStatus('Deleted row.');
      } catch (err) {
        reportError('Could not delete row', err);
      }
    });
  } else if (state.tableEditorSelectionKind === 'column' && state.tableEditorSelectedColIndex !== null) {
    const ids = Array.from(state.tableEditorSelectedIds).filter((id) => state.nodesById.has(id));
    if (ids.length === 0) return;
    await runTableEditorMutation(async () => {
      try {
        const result = await window.api.deleteNodes(state.docId, ids);
        applyFreshTree(result.tree);
        applyUndoState(result);
        resetTableEditorSelection();
        await refreshTableEditorAfterEdit();
        setStatus(`Deleted column (${ids.length} cell${ids.length === 1 ? '' : 's'}).`);
      } catch (err) {
        reportError('Could not delete column', err);
      }
    });
  }
}

export async function convertTableEditorSelection(role) {
  const ids = Array.from(state.tableEditorSelectedIds).filter((id) => state.nodesById.has(id));
  if (ids.length === 0) return;

  await runTableEditorMutation(async () => {
    try {
      const result = await window.api.setRoleOrWrap(state.docId, ids, role);
      applyFreshTree(result.tree);
      applyUndoState(result);
      state.tableEditorSelectedIds = new Set(ids.filter((id) => state.nodesById.has(id)));
      if (!state.tableEditorSelectedIds.has(state.tableEditorAnchorId)) {
        state.tableEditorAnchorId = state.tableEditorSelectedIds.size > 0
          ? Array.from(state.tableEditorSelectedIds).pop()
          : null;
      }
      await refreshTableEditorAfterEdit();
      setStatus(`Set ${ids.length} cell${ids.length === 1 ? '' : 's'} to ${role}.`);
    } catch (err) {
      reportError(`Could not convert to ${role}`, err);
    }
  });
}
