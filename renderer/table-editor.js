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
      if (state.tableEditorSelectedIds.has(cell.id)) cellEl.classList.add('cell-selected');
      if (cell.id === state.tableEditorAnchorId) cellEl.classList.add('cell-anchor');
      // Suppresses the native text-drag-selection a mousedown+drag across
      // cells would otherwise start - CSS `user-select: none` covers a
      // plain click but not a drag, and the whole point of the click
      // handler below is to select cells, not their text.
      cellEl.addEventListener('mousedown', (e) => e.preventDefault());
      cellEl.addEventListener('click', (e) => handleTableEditorCellClick(e, cell.id));
      trEl.appendChild(cellEl);
    }
    table.appendChild(trEl);
  }

  if (token !== state.tableEditorToken) return;
  el.tablePreviewDialogContainer.appendChild(table);
  updateTableEditorFields();
}

// A column arrow's click target: every cell whose span covers that logical
// column, however many TH/TD elements that actually is.
function selectTableEditorColumn(colIndex) {
  if (!state.tableEditorGrid) return;
  const ids = [];
  for (const [cellId, pos] of state.tableEditorGrid.positions) {
    if (colIndex >= pos.col && colIndex < pos.col + pos.colSpan) ids.push(cellId);
  }
  state.tableEditorSelectedIds = new Set(ids);
  state.tableEditorAnchorId = ids[ids.length - 1] || null;
  refreshTableEditorSelectionUI();
}

function selectTableEditorRow(trNode) {
  const ids = collectRowCells(trNode).map((cell) => cell.id);
  state.tableEditorSelectedIds = new Set(ids);
  state.tableEditorAnchorId = ids[ids.length - 1] || null;
  refreshTableEditorSelectionUI();
}

// Plain click selects just this cell; Ctrl/Cmd+click toggles it into/out of
// the selection (mirrors the tag tree's own selection gestures); Shift+click
// selects the rectangular block between the anchor cell and this one, by
// grid position rather than document order, so it behaves the way dragging
// a selection across a spreadsheet would.
function handleTableEditorCellClick(e, cellId) {
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
export async function refreshTableEditorAfterEdit() {
  const tableEntry = state.tableEditorTableId ? state.nodesById.get(state.tableEditorTableId) : null;
  if (tableEntry) await renderTableEditor(tableEntry.node);
  refreshDetailsForSelection();
}

export async function convertTableEditorSelection(role) {
  const ids = Array.from(state.tableEditorSelectedIds).filter((id) => state.nodesById.has(id));
  if (ids.length === 0) return;

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
}
