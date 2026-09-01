// table-preview.js
//
// Renders a Table tag as an HTML table in the details pane - read-only. The
// editable version of the same grid lives in table-editor.js.

import { el } from './dom.js';
import { pullCellText } from './page-content.js';
import { state } from './state.js';

// Walks a Table tag's subtree for its TR descendants, in document order.
// Recurses through wrapper roles (THead/TBody/TFoot, or auto-tagging's
// stray Divs) to find rows nested under them, but never descends into a
// nested Table - that inner table's rows belong to it, not this one.
export function collectTableRows(tableNode) {
  const rows = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TR') rows.push(child);
      else if (child.role === 'Table') continue;
      else visit(child);
    }
  })(tableNode);
  return rows;
}

// Same idea for a TR's TH/TD descendants: recurse through wrappers, but stop
// at a nested TR or Table so a cell's own nested structure never leaks in as
// extra columns of the outer row.
export function collectRowCells(trNode) {
  const cells = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TH' || child.role === 'TD') cells.push(child);
      else if (child.role === 'TR' || child.role === 'Table') continue;
      else visit(child);
    }
  })(trNode);
  return cells;
}

// scope -> { glyph, class } for the little direction indicator drawn in a TH
// preview cell: pointing down for a column header, right for a row header,
// both ways for scope="Both", or a red X when scope isn't set at all.
const SCOPE_ICONS = {
  Column: { glyph: '↓', cls: 'scope-col' },
  Row: { glyph: '→', cls: 'scope-row' },
  Both: { glyph: '↓→', cls: 'scope-both' },
};

// Builds a single TH/TD's preview DOM: colSpan/rowSpan attributes, the
// scope direction indicator for a header cell, and the cell's own pulled
// text - shared by the read-only inline preview and the interactive Table
// Editor dialog (see renderTablePreview() and renderTableEditor()).
export function createTableCellElement(cell, text) {
  const isHeader = cell.role === 'TH';
  const cellEl = document.createElement(isHeader ? 'th' : 'td');
  const colSpan = Number(cell.colSpan) || 1;
  const rowSpan = Number(cell.rowSpan) || 1;
  if (colSpan > 1) cellEl.colSpan = colSpan;
  if (rowSpan > 1) cellEl.rowSpan = rowSpan;

  if (isHeader) {
    const icon = SCOPE_ICONS[cell.scope];
    const iconEl = document.createElement('span');
    iconEl.className = `scope-icon ${icon ? icon.cls : 'scope-none'}`;
    iconEl.textContent = icon ? icon.glyph : '✕';
    cellEl.appendChild(iconEl);
  }
  cellEl.appendChild(document.createTextNode(text));
  return cellEl;
}

// Resolves every TH/TD's position on the table's logical row/column grid,
// accounting for colSpan/rowSpan - e.g. a rowSpan=2 cell in row 0 occupies
// the same column in row 1 too, so row 1's own first cell lands one column
// over from where its position in the row's child list would suggest.
// Backs the Table Editor's column-select arrows (one per logical column,
// not per TR's literal cell count) and its shift-click rectangular range
// selection (see renderTableEditor()/handleTableEditorCellClick()).
export function buildTableGrid(rows) {
  const occupied = []; // occupied[r] = Set of column indices already claimed by a span from above
  const positions = new Map(); // cellId -> { row, col, rowSpan, colSpan }
  let colCount = 0;
  rows.forEach((tr, r) => {
    occupied[r] = occupied[r] || new Set();
    let c = 0;
    for (const cell of collectRowCells(tr)) {
      while (occupied[r].has(c)) c += 1;
      const colSpan = Number(cell.colSpan) || 1;
      const rowSpan = Number(cell.rowSpan) || 1;
      positions.set(cell.id, { row: r, col: c, rowSpan, colSpan });
      for (let dr = 0; dr < rowSpan; dr++) {
        occupied[r + dr] = occupied[r + dr] || new Set();
        for (let dc = 0; dc < colSpan; dc++) occupied[r + dr].add(c + dc);
      }
      c += colSpan;
      colCount = Math.max(colCount, c);
    }
  });
  return { positions, colCount };
}

export async function renderTablePreview(tableNode) {
  const token = ++state.tablePreviewToken;
  el.btnExpandTablePreview.disabled = true;

  if (!state.pdfDoc) {
    el.tablePreviewContainer.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'table-preview-empty';
    p.textContent = 'Open the PDF preview to generate a table preview.';
    el.tablePreviewContainer.appendChild(p);
    return;
  }

  const rows = collectTableRows(tableNode);

  if (rows.length === 0) {
    el.tablePreviewContainer.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'table-preview-empty';
    p.textContent = 'No rows found in this table.';
    el.tablePreviewContainer.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'generated-table';

  for (const tr of rows) {
    const trEl = document.createElement('tr');
    for (const cell of collectRowCells(tr)) {
      const text = await pullCellText(cell);
      if (token !== state.tablePreviewToken) return; // selection changed mid-flight
      trEl.appendChild(createTableCellElement(cell, text));
    }
    table.appendChild(trEl);
  }

  if (token !== state.tablePreviewToken) return;
  el.tablePreviewContainer.innerHTML = '';
  el.tablePreviewContainer.appendChild(table);
  el.btnExpandTablePreview.disabled = false;
}
