// verify.js
//
// The accessibility report: the individual structural checks (heading order,
// list and table nesting, alt text) and the grouped results the Verify panel
// renders from them.
//
// Two sources feed it. Most checks are a synchronous read of the tag tree
// already in memory. The rest ask the worker about parts of the document the
// tree doesn't contain at all - the XMP packet, page dictionaries, /Annots
// and the raw content streams - through two read-only calls made once per
// run: verifyDocumentFacts() (see the "PDF/UA document-level verification"
// section of tag_worker.py) and countOrphanedContent().

import {
  runRepairOrphanedContent,
  runSetPdfUaIdentifier,
  runSetStructureTabOrder,
} from './actions.js';
import { computeEmptyNodeIds, selectNode } from './tree-view.js';
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

// The two checks below both ask which tags hold nothing that puts ink on the
// page, and both get the answer from the one definition of that the app has:
// computeEmptyNodeIds(), which is what the tag tree's "Empty" filter lists
// (bbox-only draw-tool figures and Link-with-only-an-/OBJR handled exactly as
// they are there). They split that one answer by role rather than each
// deciding emptiness for itself.

// A heading tag with nothing in it. Acrobat reports these under its "Tagged
// content" rule rather than as a heading problem, but they read as a heading
// problem - a screen reader announces a heading level and then has nothing
// to say - so they're reported next to the heading-order check instead.
// checkEmptyTags() below deliberately skips headings so each one is only
// reported once.
function checkEmptyHeadings(emptyIds) {
  const instances = [];
  walkTree(state.tree, (node) => {
    if (node.type !== 'element' || !HEADING_LEVELS[node.role]) return;
    if (emptyIds.has(node.id)) {
      instances.push({ nodeId: node.id, detail: `${node.role} is empty – there is nothing under it to read` });
    }
  });
  return instances;
}

// A blank data cell is a normal thing for a table to contain: the cell has to
// exist for the row to line up with its neighbours, which is exactly what the
// Regularity check counts. So an empty TD/TH is structure doing its job, and
// this is the one place the report is deliberately narrower than the tree's
// Empty filter, which lists them (harmlessly - it only shows you a tag,
// where this one fails the document and blocks the PDF/UA flag).
const MAY_BE_EMPTY = new Set(['TD', 'TH']);

// Every other empty tag, reported at the *topmost* one: an empty Sect
// wrapping an empty Div wrapping an empty P is one thing to go look at, not
// three, and deleting the outer one takes the others with it. Same reasoning
// as STOP_AT_MATCH_FILTERS in tree-view.js, and the hidden /Document wrapper
// is passed over here for the same reason it is there.
function checkEmptyTags(emptyIds) {
  const instances = [];
  (function visit(node) {
    if (node.type === 'element'
        && !MAY_BE_EMPTY.has(node.role)
        && !HEADING_LEVELS[node.role]
        && node.id !== state.hiddenDocumentId
        && emptyIds.has(node.id)) {
      instances.push({ nodeId: node.id, detail: `${node.role || 'Tag'} holds no content` });
      return; // its descendants are empty too, by definition - don't list them as well
    }
    for (const child of node.children || []) visit(child);
  })(state.tree);
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

// What a list item is allowed to be made of, per PDF/UA: an optional label
// and the body it labels, and nothing else. checkListStructure() above
// catches a Lbl/LBody that has escaped its LI; this catches the mirror
// image - an LI that doesn't hold the pair, whether because its body is
// missing (a bare Lbl with the text beside it rather than under it), because
// its content sits directly in the LI with no LBody around it, or because
// some other tag has been dropped in alongside them.
function checkListItemContents() {
  const instances = [];
  for (const [id, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'element' || node.role !== 'LI') continue;

    const children = node.children || [];
    const bodies = children.filter((c) => c.type === 'element' && c.role === 'LBody');
    const labels = children.filter((c) => c.type === 'element' && c.role === 'Lbl');
    const strays = children.filter((c) => c.type === 'element' && c.role !== 'LBody' && c.role !== 'Lbl');
    const directContent = children.filter((c) => c.type === 'content' || c.type === 'object-ref');

    if (bodies.length === 0) {
      instances.push({
        nodeId: id,
        detail: labels.length
          ? 'List item (LI) has a label (Lbl) but no body (LBody)'
          : 'List item (LI) has no body (LBody)',
      });
    }
    if (directContent.length > 0) {
      instances.push({
        nodeId: id,
        detail: `List item (LI) holds ${countLabel(directContent.length, 'piece')} of content directly, rather than inside Lbl or LBody`,
      });
    }
    for (const stray of strays) {
      instances.push({
        nodeId: stray.id,
        detail: `${stray.role} sits directly inside a list item (LI) – it belongs inside that item's Lbl or LBody`,
      });
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

// --- groups ----------------------------------------------------------------

/**
 * One specific place a check failed. `nodeId` is null when the issue names
 * something the tag tree doesn't contain (a link annotation no tag claims),
 * in which case the row is listed but isn't clickable.
 *
 * @typedef {object} VerifyInstance
 * @property {string|null} nodeId
 * @property {string} detail
 */

/**
 * @typedef {object} VerifyCheck
 * @property {string} title
 * @property {'pass'|'fail'|'warn'|'na'} status
 * @property {string} detail
 * @property {VerifyInstance[]} instances
 * @property {string} [id] Only where something else needs to name this one
 *   check - currently just the PDF/UA identifier, whose action is gated on
 *   every *other* check passing.
 * @property {{ label: string, run: () => Promise<string> }|null} [fix]
 *   A one-click action, rendered as an inline button that runs it and
 *   re-renders the whole report.
 */

/**
 * @typedef {object} VerifyGroup
 * @property {string} name
 * @property {VerifyCheck[]} checks
 */

function buildDocumentGroup(facts) {
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

  checks.push(buildTabOrderCheck(facts));
  checks.push(buildPdfUaCheck(facts));
  return { name: 'Document', checks };
}

// /Tabs must be /S on every page, so tabbing between a page's annotations
// follows the structure tree rather than raw geometry. Acrobat's Full Check
// reports this per page and offers a one-click fix; so does this, for the
// same reason - there is exactly one conformant value and nothing about the
// page's content to weigh up (see set_structure_tab_order() in
// tag_worker.py).
function buildTabOrderCheck(facts) {
  if (!facts) {
    return {
      title: 'Tab order',
      status: 'na',
      detail: 'Could not read the page dictionaries.',
      instances: [],
    };
  }
  const pages = facts.pagesWithoutStructureTabOrder;
  const listed = pages.length > 12 ? `${pages.slice(0, 12).join(', ')}…` : pages.join(', ');
  return {
    title: 'Tab order',
    status: pages.length ? 'fail' : 'pass',
    detail: pages.length
      ? `${countLabel(pages.length, 'page')} of ${facts.pageCount} ${pages.length === 1 ? 'does' : 'do'} not set tab order to document structure (${listed}).`
      : 'Every page sets tab order to follow the document structure.',
    instances: [],
    fix: pages.length ? { label: 'Set tab order', run: runSetStructureTabOrder } : null,
  };
}

// The PDF/UA identifier in XMP (pdfuaid:part) - the claim that the file
// conforms to PDF/UA-1, and the last thing Acrobat asks for once its own
// checks come back clean. Its fix is attached later, in attachPdfUaFix(),
// rather than here: whether to offer it depends on how every *other* check
// in the report turned out, which isn't known until they've all run.
const PDFUA_CHECK_ID = 'pdfua-identifier';

function buildPdfUaCheck(facts) {
  if (!facts) {
    return {
      id: PDFUA_CHECK_ID,
      title: 'PDF/UA identifier',
      status: 'na',
      detail: 'Could not read the document’s XMP metadata.',
      instances: [],
    };
  }
  return {
    id: PDFUA_CHECK_ID,
    title: 'PDF/UA identifier',
    status: facts.pdfUaPart ? 'pass' : 'fail',
    detail: facts.pdfUaPart
      ? `XMP metadata declares this document as PDF/UA-${facts.pdfUaPart}.`
      : 'XMP metadata carries no PDF/UA identifier, so nothing tells a consumer this document claims PDF/UA conformance.',
    instances: [],
  };
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

function buildHeadingsGroup(emptyIds) {
  const orderInstances = checkHeadingOrder();
  const emptyInstances = checkEmptyHeadings(emptyIds);
  const headings = [];
  walkTree(state.tree, (node) => {
    if (node.type === 'element' && HEADING_LEVELS[node.role]) headings.push(node.role);
  });
  const hasH1 = headings.includes('H1');

  return {
    name: 'Headings',
    checks: [
      {
        title: 'Heading levels are not skipped',
        status: orderInstances.length ? 'fail' : 'pass',
        detail: orderInstances.length
          ? `${countLabel(orderInstances.length, 'heading')} ${orderInstances.length === 1 ? 'skips' : 'skip'} a level.`
          : 'No skipped heading levels found.',
        instances: orderInstances,
      },
      {
        title: 'Top-level heading',
        status: hasH1 ? 'pass' : 'fail',
        detail: hasH1
          ? 'Document has an H1.'
          : headings.length
            ? `Document has ${countLabel(headings.length, 'heading')} but no H1 – the outline has no top level to hang off.`
            : 'Document has no headings at all, so there is no H1 to start the outline from.',
        instances: [],
      },
      {
        title: 'Headings have content',
        status: emptyInstances.length ? 'fail' : 'pass',
        detail: emptyInstances.length
          ? `${countLabel(emptyInstances.length, 'heading')} ${emptyInstances.length === 1 ? 'is' : 'are'} empty – a screen reader announces the level and then has nothing to read.`
          : 'Every heading has something to read.',
        instances: emptyInstances,
      },
    ],
  };
}

function buildTagsGroup(emptyIds) {
  const instances = checkEmptyTags(emptyIds);
  return {
    name: 'Tags',
    checks: [{
      title: 'Tags hold content',
      status: instances.length ? 'fail' : 'pass',
      detail: instances.length
        ? `${countLabel(instances.length, 'tag')} ${instances.length === 1 ? 'holds' : 'hold'} nothing that puts ink on the page.`
        : 'Every tag holds content.',
      instances,
    }],
  };
}

function buildListsGroup() {
  const nestingInstances = checkListStructure();
  const contentsInstances = checkListItemContents();
  return {
    name: 'Lists',
    checks: [
      {
        title: 'List items are correctly nested',
        status: nestingInstances.length ? 'fail' : 'pass',
        detail: nestingInstances.length ? `${countLabel(nestingInstances.length, 'tag')} incorrectly nested.` : 'List items and labels are correctly nested.',
        instances: nestingInstances,
      },
      {
        title: 'List items hold Lbl and LBody',
        status: contentsInstances.length ? 'fail' : 'pass',
        detail: contentsInstances.length
          ? `${countLabel(contentsInstances.length, 'issue')} with what list items contain.`
          : 'Every list item’s content sits in an LBody, with any label in a Lbl beside it.',
        instances: contentsInstances,
      },
    ],
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

// A link annotation has to be reachable two ways: through the structure tree
// (an /OBJR under a Link tag, so it appears in reading order at all) and
// with a description a screen reader can announce instead of the raw URL.
// They're independent failures, so a link missing both is listed under each.
//
// An untagged link has no tag to jump to, so its row names the page instead
// of being clickable - see the null nodeId handling in renderVerifyResults().
function buildLinksGroup(facts) {
  if (!facts) {
    return {
      name: 'Links',
      checks: [{
        title: 'Link annotations',
        status: 'na',
        detail: 'Could not read the document’s annotations.',
        instances: [],
      }],
    };
  }

  const links = facts.linkAnnotations;
  if (links.length === 0) {
    return {
      name: 'Links',
      checks: [{
        title: 'Link annotations',
        status: 'na',
        detail: 'Document has no link annotations.',
        instances: [],
      }],
    };
  }

  const untagged = links.filter((link) => link.nodeId === null);
  const undescribed = links.filter((link) => !link.described);
  return {
    name: 'Links',
    checks: [
      {
        title: 'Links are tagged',
        status: untagged.length ? 'fail' : 'pass',
        detail: untagged.length
          ? `${countLabel(untagged.length, 'link')} of ${links.length} ${untagged.length === 1 ? 'is' : 'are'} not inside a Link tag, so ${untagged.length === 1 ? 'it never reaches' : 'they never reach'} the reading order.`
          : `All ${countLabel(links.length, 'link')} sit inside a Link tag.`,
        instances: untagged.map((link) => ({
          nodeId: null,
          detail: `Link annotation on page ${link.page} has no Link tag`,
        })),
      },
      {
        title: 'Links have a description',
        status: undescribed.length ? 'fail' : 'pass',
        detail: undescribed.length
          ? `${countLabel(undescribed.length, 'link')} of ${links.length} ${undescribed.length === 1 ? 'has' : 'have'} no alternate description – a screen reader can only read out the destination.`
          : 'Every link carries an alternate description.',
        instances: undescribed.map((link) => ({
          nodeId: link.nodeId,
          detail: link.nodeId
            ? `Link tag on page ${link.page} has no alternate text, and its annotation has no /Contents`
            : `Link annotation on page ${link.page} has no description (and no Link tag to put one on)`,
        })),
      },
    ],
  };
}

function buildAltTextGroup(facts) {
  const missingInstances = checkFigureAltText();
  const checks = [{
    title: 'Figures and formulas',
    status: missingInstances.length ? 'fail' : 'pass',
    detail: missingInstances.length ? `${countLabel(missingInstances.length, 'tag')} missing alternate text.` : 'Every figure/formula has alternate text.',
    instances: missingInstances,
  }];

  if (facts) {
    // A warning, not a failure: a chart whose axis labels are covered by a
    // good Alt is fine, while a heading mistagged as a Figure is not, and
    // the content stream can't tell the two apart. See
    // _figures_containing_text() in tag_worker.py.
    const withText = facts.figuresWithText.filter((nodeId) => state.nodesById.has(nodeId));
    checks.push({
      title: 'Figures containing text',
      status: withText.length ? 'warn' : 'pass',
      detail: withText.length
        ? `${countLabel(withText.length, 'figure')} ${withText.length === 1 ? 'paints' : 'paint'} real text, which is unreachable unless the alternate text repeats it.`
        : 'No figure paints text of its own.',
      instances: withText.map((nodeId) => ({
        nodeId,
        detail: `${state.nodesById.get(nodeId).node.role} contains text drawn on the page – check its alternate text covers it, or tag the text separately`,
      })),
    });
  }

  return { name: 'Alternate Text', checks };
}

// The report's second worker round-trip, kept apart from the facts bundle
// above because it costs so much more: it parses the raw content stream of
// every page (see count_orphaned_marked_content() in tag_worker.py, and
// repair_orphaned_marked_content()'s doc comment for the three shapes of
// orphan it looks for). A check that fails gets `fix` set to the same
// runRepairOrphanedContent()
// Tools > Repair Orphaned Content and a script's 'repair-orphaned-content'
// step use - renderVerifyResults() renders that as an inline "Repair" button
// that re-runs this whole report on success.
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
        fix: totalCount > 0 ? { label: 'Repair', run: runRepairOrphanedContent } : null,
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

// "Set PDF/UA flag" is the one action in this report that doesn't fix
// anything - it writes a claim of conformance (see set_pdf_ua_identifier()
// in tag_worker.py). So it's only offered when the report has nothing else
// to say: every other check has to be passing, warnings included only where
// they're advisory. Warnings don't block it - the two that exist (table
// regularity, figures containing text) are both documented as things this
// app can't tell apart from a correct document - but any failure anywhere
// does, and the check says which.
function attachPdfUaFix(groups) {
  const allChecks = groups.flatMap((group) => group.checks);
  const check = allChecks.find((c) => c.id === PDFUA_CHECK_ID);
  if (!check || check.status !== 'fail') return;

  const blockers = allChecks.filter((c) => c.status === 'fail' && c.id !== PDFUA_CHECK_ID);
  if (blockers.length === 0) {
    check.fix = { label: 'Set PDF/UA flag', run: runSetPdfUaIdentifier };
  } else {
    check.detail += ` ${countLabel(blockers.length, 'other check')} still ${blockers.length === 1 ? 'fails' : 'fail'}, so claiming conformance would be false.`;
  }
}

async function computeAccessibilityChecks() {
  // One read-only round trip for everything the tag tree can't answer. A
  // worker that can't answer it (an odd file, a crashed sidecar) leaves
  // `facts` null, and each check built from it reports 'na' with a reason
  // rather than taking the whole report down.
  let facts = null;
  try {
    facts = await window.api.verifyDocumentFacts(state.docId);
  } catch (err) {
    console.error('Could not read document-level verification facts', err);
  }

  const groups = [buildDocumentGroup(facts), buildBookmarksGroup()];
  if (state.hasStructTree) {
    // Answered once for the whole run: it is a full post-order walk of the
    // tree, and the two checks that need it would otherwise each pay for it.
    const emptyIds = computeEmptyNodeIds();
    groups.push(
      buildHeadingsGroup(emptyIds),
      buildTagsGroup(emptyIds),
      buildListsGroup(),
      buildTablesGroup(),
      buildLinksGroup(facts),
      buildAltTextGroup(facts),
    );
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
  attachPdfUaFix(groups);
  return groups;
}

/**
 * Runs every check and returns the groups along with the counts the status
 * bar and the panel's summary line both render from. The one entry point -
 * renderVerifyResults() below draws these groups, and verifyAfterSave()
 * reports the counts without opening anything.
 *
 * @returns {Promise<{ groups: VerifyGroup[], failCount: number, warnCount: number, passCount: number }>}
 */
export async function runAccessibilityChecks() {
  const groups = await computeAccessibilityChecks();
  const allChecks = groups.flatMap((g) => g.checks);
  return {
    groups,
    failCount: allChecks.filter((c) => c.status === 'fail').length,
    warnCount: allChecks.filter((c) => c.status === 'warn').length,
    passCount: allChecks.filter((c) => c.status === 'pass').length,
  };
}

// How many of a check's failing tags get their own clickable row. A document
// that fails a check tends to fail it in bulk (every Figure missing alt
// text), and past this many rows the list stops being something you read and
// starts being something you scroll - the count in the check's detail line is
// the useful number by then. Anything beyond the cap is summarized in one
// trailing row rather than dropped silently.
const MAX_LISTED_INSTANCES = 100;

/**
 * Runs the checks and draws the panel. Returns the same counts
 * runAccessibilityChecks() does, so a caller that needs both the redraw and
 * the numbers (verifyAfterSave(), with the panel open) gets them off one run
 * rather than paying for the content-stream scan twice.
 *
 * @returns {Promise<{ failCount: number, warnCount: number, passCount: number }>}
 */
export async function renderVerifyResults() {
  const { groups, failCount, warnCount, passCount } = await runAccessibilityChecks();

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
      header.append(buildStatusMarker(check.status));
      const title = document.createElement('span');
      title.className = 'verify-check-title';
      title.textContent = check.title;
      const detail = document.createElement('span');
      detail.className = 'verify-check-detail';
      detail.textContent = check.detail;
      header.append(title, detail);

      if (check.fix && check.status === 'fail') {
        header.appendChild(buildFixButton(check.fix));
      }

      row.appendChild(header);

      if (check.instances.length > 0) {
        const list = document.createElement('ul');
        list.className = 'verify-instances';
        for (const instance of check.instances.slice(0, MAX_LISTED_INSTANCES)) {
          const li = document.createElement('li');
          li.className = 'verify-instance';
          li.textContent = instance.detail;
          // An instance with no node id names something the tag tree doesn't
          // contain - a link annotation nothing claims - so there's nothing
          // to select. Drop the clickable affordance rather than leave a row
          // that looks interactive and does nothing.
          if (instance.nodeId) {
            li.addEventListener('click', () => jumpToVerifyInstance(instance.nodeId));
          } else {
            li.classList.add('verify-instance-plain');
          }
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

  return { failCount, warnCount, passCount };
}

/**
 * Re-runs the report after a save and returns a one-line summary for the
 * status bar, or null if it couldn't run. A save is the moment the file on
 * disk is what a checker would see, which makes it the natural point to say
 * whether that file would pass - and it catches the case where a session of
 * editing has quietly fixed (or broken) something since Verify was last
 * opened.
 *
 * If the Verify panel happens to be open, it's redrawn too, so the report on
 * screen never outlives the document it describes.
 *
 * @returns {Promise<string|null>}
 */
export async function verifyAfterSave() {
  if (!state.docId) return null;
  try {
    const { failCount, warnCount, passCount } = el.verifyDialog.open
      ? await renderVerifyResults()
      : await runAccessibilityChecks();
    const parts = [`${countLabel(failCount, 'check')} failed`, `${passCount} passed`];
    if (warnCount) parts.push(countLabel(warnCount, 'warning'));
    return parts.join(', ') + '.';
  } catch (err) {
    // A save that worked must not report as a failure because the report
    // afterwards didn't - the file is on disk either way.
    console.error('Could not re-run the accessibility check after saving', err);
    return null;
  }
}

// A glyph and a spoken name per check status. This used to be a bare
// colored dot, which meant the result of every check was carried by hue
// alone: invisible to a screen reader, and indistinguishable to anyone who
// cannot separate the four hues - the exact 1.4.1 failure this app exists to
// find in other people's documents.
//
// The glyph is aria-hidden and the name is visually hidden, so each channel
// reaches exactly one audience and neither reads the state twice.
// '×' and '–' are plain Latin-1/General-Punctuation characters present in
// Consolas and every other font in --font-mono. '✓' is the one that may not
// be, in which case Chromium substitutes a font for that glyph alone - which
// is why .verify-status sets a fixed width and centers its content, so a
// substituted checkmark still lines up with the other three rows.
const VERIFY_STATUS = {
  pass: { glyph: '✓', label: 'Passed' },
  fail: { glyph: '×', label: 'Failed' },
  warn: { glyph: '!', label: 'Warning' },
  na: { glyph: '–', label: 'Not applicable' },
};

function buildStatusMarker(status) {
  const marker = document.createElement('span');
  marker.className = `verify-status verify-status-${status}`;
  // Falls back to the 'na' presentation rather than rendering an empty
  // marker if a new status is ever added without being listed above.
  const { glyph, label } = VERIFY_STATUS[status] || VERIFY_STATUS.na;

  const shape = document.createElement('span');
  shape.setAttribute('aria-hidden', 'true');
  shape.textContent = glyph;

  const name = document.createElement('span');
  name.className = 'visually-hidden';
  // Trailing colon so a screen reader reads "Failed: Document is tagged"
  // rather than running the state straight into the check's title.
  name.textContent = `${label}: `;

  marker.append(shape, name);
  return marker;
}

// A failing check can offer a one-click action (`fix`): repairing orphaned
// marked content, setting tab order, or - once nothing else is failing -
// writing the PDF/UA identifier. Each runs the same actions.js function its
// other trigger(s) use, then re-renders the whole report in place so the
// dialog shows the action having actually taken effect rather than leaving a
// stale "fail" row up next to a status message the user has to go read
// separately.
function buildFixButton(fix) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost verify-check-fix-btn';
  button.textContent = fix.label;
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      const message = await fix.run();
      setStatus(message);
      await renderVerifyResults();
    } catch (err) {
      reportError(`Could not ${fix.label.toLowerCase()}`, err);
      button.disabled = false;
      button.textContent = fix.label;
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
