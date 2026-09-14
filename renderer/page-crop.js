// page-crop.js
//
// Renders the region of the page a tag's content sits on to a PNG, for
// "Fix with AI" (see el.btnFixActualText in renderer.js). The OCR text alone
// lets the model fix what a language model can predict - "tbe" for "the" -
// but leaves it guessing at exactly the parts no prior can supply: names,
// numbers, dates, citations, unusual spellings. A text-only fix "corrects"
// those toward whatever is most plausible, and the result reads fluently,
// so a reviewer has nothing to catch. The crop gives the model the ground
// truth for those parts: the text stays the prior, the image is the
// evidence (see the system prompt in main.js).
//
// The crop is cut from the same geometry the highlight overlay draws from
// (getPageLeafRects() / collectTargetBBoxes() in page-content.js), so it
// covers what the user sees outlined when the tag is selected, plus a small
// margin. It is rendered fresh at its own scale rather than lifted from the
// preview canvas: the preview's PAGE_SCALE is chosen for fitting the pane,
// not for reading small print, and a crop of a few lines can afford far more
// pixels per point than a whole page can.

import { bboxRectInViewport, collectTargetBBoxes, collectTargetMcids, getPageLeafRects, getPageTextContent } from './page-content.js';
import { PAGE_SCALE, state } from './state.js';
import { unionRects } from './util.js';

// Margin around the content, in PDF points - enough for the ascenders,
// descenders and a hyphen at a line end to come through whole, not enough to
// drag a neighbouring paragraph in and invite the model to "fix" the text
// by adding it.
const CROP_PADDING_PT = 6;

// Longest edge of a crop, in pixels. Anthropic's vision guidance puts the
// sweet spot at 1568px on the long edge - larger is downscaled server-side
// anyway, so the extra bytes buy nothing.
const CROP_MAX_EDGE_PX = 1568;

// Pixels per point, capped: 3 is about 216 dpi, which is above what the
// scan itself carries in most cases, so rendering higher only enlarges the
// scan's own pixels.
const CROP_MAX_SCALE = 3;

// A tag whose content runs across pages gets one crop per page, up to this
// many. Past that the images start to dominate the request, and a tag that
// long is a candidate for Fix All Actual Text rather than a single fix.
const CROP_MAX_PAGES = 3;

/**
 * @typedef {import('../types/domain').PageCrop} PageCrop
 */

/**
 * Groups a tag's content targets by 0-based page. Marked content is
 * preferred; a tag with no marked content at all (see collectTargetBBoxes'
 * comment) falls back to its own /Layout /BBox.
 * @returns {Map<number, { mcids: number[], bboxes: number[][] }>}
 */
function targetsByPage(nodeId) {
  const pages = new Map();
  const entryFor = (page) => {
    if (!pages.has(page)) pages.set(page, { mcids: [], bboxes: [] });
    return pages.get(page);
  };
  const mcidTargets = collectTargetMcids(nodeId);
  if (mcidTargets.length > 0) {
    for (const t of mcidTargets) entryFor(t.page).mcids.push(t.mcid);
  } else {
    for (const t of collectTargetBBoxes(nodeId)) entryFor(t.page).bboxes.push(t.bbox);
  }
  return pages;
}

/**
 * The region, in the PAGE_SCALE viewport's pixel space, that a tag's content
 * occupies on one page - the union of every run and graphic it paints there,
 * padded and clamped to the page. Null when nothing measurable is on it.
 */
async function contentRegionOnPage(pageNumber, { mcids, bboxes }) {
  const { viewport } = await getPageTextContent(pageNumber);
  const rects = [];
  if (mcids.length > 0) {
    const leafRects = await getPageLeafRects(pageNumber);
    for (const mcid of mcids) rects.push(...(leafRects.get(mcid) || []));
  }
  for (const bbox of bboxes) rects.push(bboxRectInViewport(bbox, viewport));
  const union = unionRects(rects);
  if (!union || union.width <= 0 || union.height <= 0) return null;

  const pad = CROP_PADDING_PT * PAGE_SCALE;
  const x0 = Math.max(0, union.x - pad);
  const y0 = Math.max(0, union.y - pad);
  const x1 = Math.min(viewport.width, union.x + union.width + pad);
  const y1 = Math.min(viewport.height, union.y + union.height + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Renders one page region to a PNG. `region` is in PAGE_SCALE viewport
 * pixels; pdf.js viewports scale linearly, so the same region at another
 * scale is just a multiple. The offset viewport makes pdf.js paint the page
 * shifted so that the region lands at the canvas origin, and the canvas is
 * only as big as the region - so a few lines of a large scan never allocate
 * a whole-page bitmap at crop resolution.
 * @returns {Promise<PageCrop>}
 */
async function renderRegionToPng(pageNumber, region) {
  const page = await state.pdfDoc.getPage(pageNumber);
  const longestEdgePt = Math.max(region.width, region.height) / PAGE_SCALE;
  const scale = Math.min(CROP_MAX_SCALE, CROP_MAX_EDGE_PX / longestEdgePt);
  const k = scale / PAGE_SCALE;
  const width = Math.max(1, Math.round(region.width * k));
  const height = Math.max(1, Math.round(region.height * k));
  const viewport = page.getViewport({ scale, offsetX: -region.x * k, offsetY: -region.y * k });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  // Release the bitmap now rather than when the GC gets round to it - a
  // 1568px crop is a few megabytes of backing store.
  canvas.width = 0;
  canvas.height = 0;
  return {
    mediaType: 'image/png',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    page: pageNumber,
  };
}

/**
 * Crops of the page region(s) a tag's content occupies, one per page in
 * page order, ready to send alongside the tag's text. Empty when the tag has
 * no locatable content (nothing on any page, or no document open) - the
 * caller then falls back to a text-only fix, which is what it always did.
 * @param {string} nodeId
 * @returns {Promise<PageCrop[]>}
 */
export async function cropNodeImages(nodeId) {
  if (!state.pdfDoc || !nodeId) return [];
  const pages = Array.from(targetsByPage(nodeId).entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, CROP_MAX_PAGES);
  const crops = [];
  for (const [page0, targets] of pages) {
    const pageNumber = page0 + 1;
    if (pageNumber < 1 || pageNumber > state.pageCount) continue;
    const region = await contentRegionOnPage(pageNumber, targets);
    if (!region) continue;
    crops.push(await renderRegionToPng(pageNumber, region));
  }
  return crops;
}
