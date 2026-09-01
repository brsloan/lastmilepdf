// bookmarks.js
//
// The bookmarks panel: rendering the PDF outline, selecting and renaming
// bookmarks, and generating a fresh outline from the document's headings.

import { el } from './dom.js';
import { collectTargetMcids, getPageTextContent, pullContentText } from './page-content.js';
import { applyUndoState, reportError, setStatus } from './shell.js';
import { PAGE_SCALE, state } from './state.js';
import { unionRects } from './util.js';
import { computeHighlightRects, highlightNodeOnPage, renderCurrentPage, syncHighlightLayerBounds, updatePageNavUI } from './viewer.js';

function indexOutline(outline) {
  const map = new Map();
  (function visit(nodes, parentId) {
    for (const node of nodes) {
      map.set(node.id, { node, parentId });
      visit(node.children || [], node.id);
    }
  })(outline || [], null);
  return map;
}

export function applyFreshOutline(outline) {
  state.outline = outline || [];
  state.bookmarksById = indexOutline(state.outline);
  if (state.selectedBookmarkId && !state.bookmarksById.has(state.selectedBookmarkId)) {
    state.selectedBookmarkId = null;
  }
  renderBookmarkTree();
}

function renderBookmarkTree() {
  el.bookmarkTree.innerHTML = '';
  const hasBookmarks = state.outline && state.outline.length > 0;
  el.bookmarksEmpty.hidden = hasBookmarks;
  el.bookmarkTree.hidden = !hasBookmarks;
  if (!hasBookmarks) return;

  const ul = document.createElement('ul');
  ul.className = 'tree-node';
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const node of state.outline) ul.appendChild(renderBookmarkNode(node));
  el.bookmarkTree.appendChild(ul);
}

function renderBookmarkNode(node) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row selectable';
  row.dataset.bookmarkId = node.id;
  if (node.id === state.selectedBookmarkId) row.classList.add('selected');

  const spacer = document.createElement('span');
  spacer.className = 'tree-toggle-spacer';
  row.appendChild(spacer);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'bookmark-title';
  titleSpan.textContent = node.title || '(untitled)';
  row.appendChild(titleSpan);

  if (node.page !== null && node.page !== undefined) {
    const pageSpan = document.createElement('span');
    pageSpan.className = 'tree-node-meta';
    pageSpan.textContent = `p. ${node.page + 1}`;
    row.appendChild(pageSpan);
  }

  row.addEventListener('click', () => selectBookmark(node.id));
  row.addEventListener('dblclick', () => startRenamingBookmark(node.id));

  li.appendChild(row);

  if (node.children && node.children.length > 0) {
    const childUl = document.createElement('ul');
    childUl.className = 'tree-children';
    for (const child of node.children) childUl.appendChild(renderBookmarkNode(child));
    li.appendChild(childUl);
  }

  return li;
}

function selectBookmark(bookmarkId) {
  state.selectedBookmarkId = bookmarkId;
  renderBookmarkTree();
  const node = state.bookmarksById.get(bookmarkId)?.node;
  if (node && node.page !== null && node.page !== undefined) {
    jumpToPage(node.page + 1, node.top);
  }
}

// `top`, when given, is a page-space y-coordinate (see computeHeadingTop())
// to scroll to within the target page - used by bookmarks that carry a
// specific position rather than just a page. Applied even when the page
// itself doesn't change (e.g. two bookmarks on the same page), unlike the
// page-render/highlight-resync above it, which only a real page change
// needs.
async function jumpToPage(pageNumber, top) {
  if (!state.pdfDoc) return;
  if (pageNumber < 1 || pageNumber > state.pageCount) return;
  if (pageNumber !== state.currentPage) {
    state.currentPage = pageNumber;
    await renderCurrentPage();
    updatePageNavUI();
    await highlightNodeOnPage(state.selectedNodeId, { allowPageJump: false });
  }
  await scrollToHeadingTop(top);
}

// Swaps a bookmark row's title for a text input on double-click, committing
// on Enter/blur (skipped if unchanged or emptied) and discarding on Escape -
// there's no dedicated rename dialog elsewhere in the app, so this mirrors
// the lightest-touch inline-edit pattern that fits a tree row.
function startRenamingBookmark(bookmarkId) {
  const entry = state.bookmarksById.get(bookmarkId);
  if (!entry) return;
  const row = el.bookmarkTree.querySelector(`[data-bookmark-id="${bookmarkId}"]`);
  const titleSpan = row?.querySelector('.bookmark-title');
  if (!row || !titleSpan) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bookmark-title-input';
  input.value = entry.node.title || '';
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;

  const commit = async () => {
    if (settled) return;
    settled = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === entry.node.title) {
      renderBookmarkTree();
      return;
    }
    try {
      const result = await window.api.renameBookmark(state.docId, bookmarkId, newTitle);
      state.selectedBookmarkId = bookmarkId;
      applyFreshOutline(result.outline);
      applyUndoState(result);
      setStatus('Renamed bookmark.');
    } catch (err) {
      reportError('Could not rename bookmark', err);
      renderBookmarkTree();
    }
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    renderBookmarkTree();
  };

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

// Backs the Bookmarks panel's + button: adds a new bookmark pointing at
// whatever page is currently open in the preview, inserted wherever it
// belongs by page order (see _find_bookmark_insert_slot() in
// tag_worker.py) rather than relative to the current selection. Immediately
// starts renaming it, since a fresh bookmark's default title is a
// placeholder the user will almost always want to replace.
export async function addBookmark() {
  if (!state.docId || !state.pdfDoc) return;
  try {
    const result = await window.api.addBookmark(state.docId, state.currentPage - 1, 'New Bookmark');
    applyFreshOutline(result.outline);
    applyUndoState(result);
    if (result.newBookmarkId && state.bookmarksById.has(result.newBookmarkId)) {
      selectBookmark(result.newBookmarkId);
      startRenamingBookmark(result.newBookmarkId);
    }
    setStatus('Added bookmark.');
  } catch (err) {
    reportError('Could not add bookmark', err);
  }
}

export async function deleteSelectedBookmark() {
  const bookmarkId = state.selectedBookmarkId;
  if (!bookmarkId) return;
  try {
    const result = await window.api.deleteBookmark(state.docId, bookmarkId);
    state.selectedBookmarkId = null;
    applyFreshOutline(result.outline);
    applyUndoState(result);
    setStatus('Deleted bookmark.');
  } catch (err) {
    reportError('Could not delete bookmark', err);
  }
}

// Walks the tag tree for every H1-H6 node, in document order, collecting
// what generate_bookmarks() (tag_worker.py) needs to rebuild a nested
// outline matching the heading hierarchy: level (for nesting), page (from
// the tag tree's own resolved /Pg, already 0-based), title text - the
// heading's own Actual Text when it has one (that's the author's intended
// reading, so it wins over the raw content), otherwise pulled via
// pullContentText(), the same content-extraction path the "Pull Content"
// button uses, since pikepdf has no equivalent way to recover a heading's
// visible text from its marked content - and top (the heading's
// vertical position on the page, so the generated bookmark scrolls straight
// to it instead of just the page's top edge; see computeHeadingTop()).
// Headings with no numbered level (a bare "H" or "Title" role) are skipped -
// there'd be no level to nest them by.
export async function collectHeadingsForBookmarks() {
  const headingNodes = [];
  (function visit(node) {
    if (node.type === 'element') {
      const match = /^H([1-6])$/.exec(node.role || '');
      if (match) headingNodes.push({ id: node.id, level: Number(match[1]) });
    }
    for (const child of node.children || []) visit(child);
  })(state.tree);

  const headings = [];
  for (const { id, level } of headingNodes) {
    const node = state.nodesById.get(id)?.node;
    if (!node || node.page === null || node.page === undefined) continue;
    const actualText = (node.actualText || '').trim();
    const rawTitle = actualText || (await pullContentText(id)).trim() || `Untitled ${node.role}`;
    const title = rawTitle.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    const top = await computeHeadingTop(id, node.page);
    headings.push({ title, level, page: node.page, top });
  }
  return headings;
}

// A heading's y-coordinate on its page, in the same default-page-space
// units (unscaled, PAGE_SCALE === 1) that a PDF destination's /FitH "top"
// expects - measured from the page's own bottom-left origin, increasing
// upward. Pulled from the same mcid text-run rects tag highlighting uses
// (see computeHighlightRects), just against a scale-1 viewport instead of
// PAGE_SCALE, and flipped from pdf.js's top-down pixel space back to PDF
// space. null if the heading's marked content isn't findable (e.g. an empty
// heading with no runs on this page).
async function computeHeadingTop(nodeId, pageIndex) {
  const mcidSet = new Set(
    collectTargetMcids(nodeId).filter((t) => t.page === pageIndex).map((t) => t.mcid)
  );
  if (mcidSet.size === 0) return null;
  const page = await state.pdfDoc.getPage(pageIndex + 1);
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  const viewport = page.getViewport({ scale: 1 });
  const rect = unionRects(computeHighlightRects(textContent, viewport, mcidSet));
  return rect ? viewport.height - rect.y : null;
}

// Scrolls the canvas-wrap pane so page-space y-coordinate `top` (see
// computeHeadingTop()) sits at the top edge of the visible area - the
// on-page counterpart to jumpToPage()'s page-level navigation, used when a
// bookmark carries a specific position rather than just a page. Positions a
// throwaway 1px marker at that coordinate (reusing the highlight layer's
// existing percentage-of-viewport placement, which already accounts for the
// canvas's CSS scaling) and scrolls it into view, since there's no other
// element guaranteed to already sit exactly there.
async function scrollToHeadingTop(top) {
  if (top === null || top === undefined || !state.pdfDoc) return;
  const { viewport } = await getPageTextContent(state.currentPage);
  const pixelY = viewport.height - top * PAGE_SCALE;
  syncHighlightLayerBounds();
  const marker = document.createElement('div');
  marker.style.position = 'absolute';
  marker.style.left = '0';
  marker.style.width = '1px';
  marker.style.height = '1px';
  marker.style.top = `${(100 * pixelY / viewport.height).toFixed(3)}%`;
  el.highlightLayer.appendChild(marker);
  marker.scrollIntoView({ block: 'start', inline: 'nearest' });
  marker.remove();
}
