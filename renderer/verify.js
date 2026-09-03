// verify.js
//
// The accessibility report: the individual structural checks (heading order,
// list and table nesting, alt text) and the grouped results the Verify panel
// renders from them.

import { runRepairOrphanedContent } from './actions.js';
import { selectNode } from './tree-view.js';
import { setActivePanel } from './details.js';
import { el } from './dom.js';
import { reportError, setStatus } from './shell.js';
import { state } from './state.js';
import { walkTree } from './tree-index.js';
import { countLabel } from './util.js';


function parentOf(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry || entry.parentId === null) return null;
  return state.nodesById.get(entry.parentId)?.node || null;
}

const HEADING_LEVELS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

// Flags a heading whose level is more than one deeper than the deepest
// heading level seen so far in document order (e.g. an H3 with no preceding
// H2) - the same "don't skip a level" rule Acrobat's heading check applies.
function checkHeadingOrder() {
  const instances = [];
  let maxSeen = 0;
  walkTree(state.tree, (node) => {
    if (node.type !== 'element') return;
    const level = HEADING_LEVELS[node.role];
    if (!level) return;
    if (level > maxSeen + 1) {
      instances.push({
        nodeId: node.id,
        detail: `${node.role} follows a heading no deeper than H${maxSeen} – skips H${maxSeen + 1}`,
      });
    }
    if (level > maxSeen) maxSeen = level;
  });
  return instances;
}

function checkListStructure() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element') continue;
    if (node.role === 'LI') {
      const parent = parentOf(id);
      if (!parent || parent.role !== 'L') {
        instances.push({ nodeId: id, detail: `List item (LI) is not a child of a List (L) tag – parent is ${parent?.role || 'untagged content'}` });
      }
    } else if (node.role === 'Lbl' || node.role === 'LBody') {
      const parent = parentOf(id);
      if (!parent || parent.role !== 'LI') {
        instances.push({ nodeId: id, detail: `${node.role} is not a child of a List Item (LI) tag – parent is ${parent?.role || 'untagged content'}` });
      }
    }
  }
  return instances;
}

function checkTableRowStructure() {
  const validParents = new Set(['Table', 'THead', 'TBody', 'TFoot']);
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || node.role !== 'TR') continue;
    const parent = parentOf(id);
    if (!parent || !validParents.has(parent.role)) {
      instances.push({ nodeId: id, detail: `Table row (TR) is not a child of Table/THead/TBody/TFoot – parent is ${parent?.role || 'untagged content'}` });
    }
  }
  return instances;
}

function checkTableCellStructure() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || (node.role !== 'TH' && node.role !== 'TD')) continue;
    const parent = parentOf(id);
    if (!parent || parent.role !== 'TR') {
      instances.push({ nodeId: id, detail: `${node.role} is not a child of a table row (TR) – parent is ${parent?.role || 'untagged content'}` });
    }
  }
  return instances;
}

// Rows directly inside `tableNode` (through THead/TBody/TFoot, but not
// descending into a nested Table's own rows).
function getTableRows(tableNode) {
  const rows = [];
  (function walk(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TR') rows.push(child);
      else if (child.role !== 'Table') walk(child);
    }
  })(tableNode);
  return rows;
}

function getRowCells(rowNode) {
  const cells = [];
  (function walk(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'TH' || child.role === 'TD') cells.push(child);
      else walk(child);
    }
  })(rowNode);
  return cells;
}

// Heuristic: every row's cell count (ColSpan-weighted) should agree. Doesn't
// account for RowSpan carrying a cell down into a following row, so a table
// that relies heavily on RowSpan can produce a false positive here - flagged
// as a warning rather than a failure for that reason.
function checkTableRegularity() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || node.role !== 'Table') continue;
    const rows = getTableRows(node);
    if (rows.length < 2) continue;
    const widths = rows.map((r) => getRowCells(r).reduce((sum, c) => sum + (c.colSpan || 1), 0)).filter((w) => w > 0);
    const distinct = [...new Set(widths)].sort((a, b) => a - b);
    if (distinct.length > 1) {
      instances.push({ nodeId: id, detail: `Rows have inconsistent column counts (${distinct.join(', ')}) – may indicate a missing or extra cell` });
    }
  }
  return instances;
}

// Approximates Acrobat's "Headers" check (data cells must be identifiable
// via Scope or a /Headers reference): this app manages Scope, not raw
// /Headers ids, so a table needs at least one TH, and every TH needs Scope
// set, to pass.
function checkTableHeaders() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || node.role !== 'Table') continue;
    const cells = getTableRows(node).flatMap(getRowCells);
    const thCells = cells.filter((c) => c.role === 'TH');
    if (thCells.length === 0) {
      instances.push({ nodeId: id, detail: 'Table has no header (TH) cells' });
      continue;
    }
    for (const cell of thCells) {
      if (!cell.scope) instances.push({ nodeId: cell.id, detail: 'Header cell (TH) has no Scope set (Row/Column/Both)' });
    }
  }
  return instances;
}

function checkFigureAltText() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || (node.role !== 'Figure' && node.role !== 'Formula')) continue;
    if (!node.alt || !node.alt.trim()) {
      instances.push({ nodeId: id, detail: `${node.role} tag has no alternate text` });
    }
  }
  return instances;
}

function buildDocumentGroup() {
  const checks = [];
  const tagged = !!state.hasStructTree && !!state.docInfo.markedTagged;
  checks.push({
    title: 'Tagged PDF',
    status: tagged ? 'pass' : 'fail',
    detail: !state.hasStructTree
      ? 'Document has no accessibility structure tree.'
      : state.docInfo.markedTagged
        ? 'Document has a structure tree and is marked as tagged.'
        : 'Document has a structure tree, but is not marked as tagged (MarkInfo/Marked is not set).',
    instances: [],
  });

  const title = (state.docInfo.title || '').trim();
  checks.push({
    title: 'Document title',
    status: title ? 'pass' : 'fail',
    detail: title ? `Title is set to “${title}”.` : 'No document title is set.',
    instances: [],
  });

  const lang = (state.docInfo.lang || '').trim();
  checks.push({
    title: 'Primary language',
    status: lang ? 'pass' : 'fail',
    detail: lang ? `Document language is set to “${lang}”.` : 'No primary document language is set.',
    instances: [],
  });

  const accessible = state.docInfo.accessibilityPermission !== false;
  checks.push({
    title: 'Accessibility permission flag',
    status: accessible ? 'pass' : 'fail',
    detail: accessible ? 'Content extraction for accessibility is allowed.' : 'The document’s security settings block content extraction for accessibility.',
    instances: [],
  });

  return { name: 'Document', checks };
}

function buildBookmarksGroup() {
  const hasBookmarks = !!(state.outline && state.outline.length > 0);
  const longDoc = state.pageCount >= 20;
  let status, detail;
  if (hasBookmarks) {
    status = 'pass';
    detail = 'Document has bookmarks.';
  } else if (longDoc) {
    status = 'warn';
    detail = `Document has ${state.pageCount} pages and no bookmarks – consider adding them for easier navigation.`;
  } else {
    status = 'na';
    detail = 'Document has no bookmarks (not required for a document this short).';
  }
  return { name: 'Bookmarks', checks: [{ title: 'Bookmarks present for long documents', status, detail, instances: [] }] };
}

function buildHeadingsGroup() {
  const instances = checkHeadingOrder();
  return {
    name: 'Headings',
    checks: [{
      title: 'Heading levels are not skipped',
      status: instances.length ? 'fail' : 'pass',
      detail: instances.length ? `${countLabel(instances.length, 'heading')} skip a level.` : 'No skipped heading levels found.',
      instances,
    }],
  };
}

function buildListsGroup() {
  const instances = checkListStructure();
  return {
    name: 'Lists',
    checks: [{
      title: 'List items are correctly nested',
      status: instances.length ? 'fail' : 'pass',
      detail: instances.length ? `${countLabel(instances.length, 'tag')} incorrectly nested.` : 'List items and labels are correctly nested.',
      instances,
    }],
  };
}

function buildTablesGroup() {
  const rowInstances = checkTableRowStructure();
  const cellInstances = checkTableCellStructure();
  const regularityInstances = checkTableRegularity();
  const headerInstances = checkTableHeaders();
  return {
    name: 'Tables',
    checks: [
      {
        title: 'Rows',
        status: rowInstances.length ? 'fail' : 'pass',
        detail: rowInstances.length ? `${countLabel(rowInstances.length, 'row')} not contained in Table/THead/TBody/TFoot.` : 'Every row is correctly contained.',
        instances: rowInstances,
      },
      {
        title: 'TH and TD',
        status: cellInstances.length ? 'fail' : 'pass',
        detail: cellInstances.length ? `${countLabel(cellInstances.length, 'cell')} not contained in a row.` : 'Every header/data cell is correctly contained in a row.',
        instances: cellInstances,
      },
      {
        title: 'Regularity',
        status: regularityInstances.length ? 'warn' : 'pass',
        detail: regularityInstances.length ? `${countLabel(regularityInstances.length, 'table')} with inconsistent row widths.` : 'Table rows have consistent column counts.',
        instances: regularityInstances,
      },
      {
        title: 'Headers',
        status: headerInstances.length ? 'fail' : 'pass',
        detail: headerInstances.length ? `${countLabel(headerInstances.length, 'issue')} with table headers.` : 'Every table has identified header cells.',
        instances: headerInstances,
      },
    ],
  };
}

function buildAltTextGroup() {
  const instances = checkFigureAltText();
  return {
    name: 'Alternate Text',
    checks: [{
      title: 'Figures and formulas',
      status: instances.length ? 'fail' : 'pass',
      detail: instances.length ? `${countLabel(instances.length, 'tag')} missing alternate text.` : 'Every figure/formula has alternate text.',
      instances,
    }],
  };
}

// Unlike every other check here, this one can't be computed from data
// already loaded into the renderer - it needs tag_worker.py to parse the raw
// page content streams (see count_orphaned_marked_content() there and
// repair_orphaned_marked_content()'s doc comment for the three shapes of
// orphan it looks for), so it's the one async check in the report. A check
// that fails gets `repair` set to the same runRepairOrphanedContent() Tools >
// Repair Orphaned Content and a script's 'repair-orphaned-content' step use
// - renderVerifyResults() renders that as an inline "Repair" button that
// re-runs this whole report on success.
async function buildOrphanedContentGroup() {
  const name = 'Content Stream';
  try {
    const { totalCount, pageCount } = await window.api.countOrphanedContent(state.docId);
    return {
      name,
      checks: [{
        title: 'Orphaned marked content',
        status: totalCount ? 'fail' : 'pass',
        detail: totalCount
          ? `${countLabel(totalCount, 'marked-content region')} across ${countLabel(pageCount, 'page')} ${totalCount === 1 ? 'is' : 'are'} neither tagged nor a real PDF artifact - Acrobat's accessibility checker will flag ${totalCount === 1 ? 'it' : 'them'} as untagged content.`
          : 'Every marked-content region in the page content streams is either tagged or a real artifact.',
        instances: [],
        repair: totalCount > 0 ? runRepairOrphanedContent : null,
      }],
    };
  } catch (err) {
    return {
      name,
      checks: [{
        title: 'Orphaned marked content',
        status: 'na',
        detail: `Could not check the content stream: ${err.message || err}`,
        instances: [],
      }],
    };
  }
}

async function computeAccessibilityChecks() {
  const groups = [buildDocumentGroup(), buildBookmarksGroup()];
  if (state.hasStructTree) {
    groups.push(buildHeadingsGroup(), buildListsGroup(), buildTablesGroup(), buildAltTextGroup());
    groups.push(await buildOrphanedContentGroup());
  } else {
    groups.push({
      name: 'Structure',
      checks: [{
        title: 'Tag-tree checks',
        status: 'na',
        detail: 'This document has no tag tree, so heading/list/table/alternate-text checks do not apply.',
        instances: [],
      }],
    });
  }
  return groups;
}

// How many of a check's failing tags get their own clickable row. A document
// that fails a check tends to fail it in bulk (every Figure missing alt
// text), and past this many rows the list stops being something you read and
// starts being something you scroll - the count in the check's detail line is
// the useful number by then. Anything beyond the cap is summarized in one
// trailing row rather than dropped silently.
const MAX_LISTED_INSTANCES = 100;

export async function renderVerifyResults() {
  const groups = await computeAccessibilityChecks();
  const allChecks = groups.flatMap((g) => g.checks);
  const failCount = allChecks.filter((c) => c.status === 'fail').length;
  const warnCount = allChecks.filter((c) => c.status === 'warn').length;

  el.verifyBody.innerHTML = '';

  const summary = document.createElement('p');
  summary.className = 'verify-summary';
  if (failCount === 0 && warnCount === 0) {
    summary.innerHTML = '<strong>No issues found.</strong>';
  } else {
    const parts = [];
    if (failCount) parts.push(`<strong>${countLabel(failCount, 'failed check')}</strong>`);
    if (warnCount) parts.push(`<strong>${countLabel(warnCount, 'warning')}</strong>`);
    summary.innerHTML = parts.join(', ') + '.';
  }
  el.verifyBody.appendChild(summary);

  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'verify-group';
    const h3 = document.createElement('h3');
    h3.textContent = group.name;
    section.appendChild(h3);

    for (const check of group.checks) {
      const row = document.createElement('div');
      row.className = 'verify-check';

      const header = document.createElement('div');
      header.className = 'verify-check-header';
      const dot = document.createElement('span');
      dot.className = `verify-status verify-status-${check.status}`;
      const title = document.createElement('span');
      title.className = 'verify-check-title';
      title.textContent = check.title;
      const detail = document.createElement('span');
      detail.className = 'verify-check-detail';
      detail.textContent = check.detail;
      header.append(dot, title, detail);

      if (check.repair && check.status === 'fail') {
        header.appendChild(buildRepairButton(check.repair));
      }

      row.appendChild(header);

      if (check.instances.length > 0) {
        const list = document.createElement('ul');
        list.className = 'verify-instances';
        for (const instance of check.instances.slice(0, MAX_LISTED_INSTANCES)) {
          const li = document.createElement('li');
          li.className = 'verify-instance';
          li.textContent = instance.detail;
          li.addEventListener('click', () => jumpToVerifyInstance(instance.nodeId));
          list.appendChild(li);
        }
        // The check's own detail line above still counts every instance, so
        // without this the list just stops at the cap and the two silently
        // disagree - "142 tags missing alternate text" over a list of 100.
        // Not clickable (there's no single tag to jump to) and styled as
        // such - see .verify-instance-more in styles.css.
        const undisplayed = check.instances.length - MAX_LISTED_INSTANCES;
        if (undisplayed > 0) {
          const li = document.createElement('li');
          li.className = 'verify-instance verify-instance-more';
          li.textContent = `…and ${countLabel(undisplayed, 'more issue')} not listed.`;
          list.appendChild(li);
        }
        row.appendChild(list);
      }

      section.appendChild(row);
    }

    el.verifyBody.appendChild(section);
  }
}

// A failing check can offer a one-click fix (so far, only "Orphaned marked
// content" via `repair`, but any future check could set it) - runs the same
// actions.js function its other trigger(s) use, then re-renders the whole
// report in place so the dialog shows the fix having actually taken effect
// rather than leaving a stale "fail" row up next to a status message the
// user has to go read separately.
function buildRepairButton(repairAction) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost verify-check-fix-btn';
  button.textContent = 'Repair';
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    button.disabled = true;
    button.textContent = 'Repairing…';
    try {
      const message = await repairAction();
      setStatus(message);
      await renderVerifyResults();
    } catch (err) {
      reportError('Could not repair', err);
      button.disabled = false;
      button.textContent = 'Repair';
    }
  });
  return button;
}

function jumpToVerifyInstance(nodeId) {
  if (!state.nodesById.has(nodeId)) return;
  el.verifyDialog.close();
  setActivePanel('properties');
  selectNode(nodeId);
}
