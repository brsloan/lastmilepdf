// page-content.js
//
// Reads a page's actual content through pdf.js: the text and graphics behind
// each marked-content id, and the per-page caches that keep those reads off
// the critical path. This is the layer that answers "what does this tag
// actually cover on the page?".

import { pdfjsLib } from './pdfjs.js';
import { PAGE_SCALE, state } from './state.js';
import { extractMcidFromItemId } from './util.js';

export function collectTargetMcids(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) return [];
  const targets = [];
  (function visit(node) {
    if (node.type === 'content' && node.mcid !== null && node.mcid !== undefined
        && node.page !== null && node.page !== undefined) {
      targets.push({ mcid: node.mcid, page: node.page }); // page is 0-based
    }
    for (const child of node.children || []) visit(child);
  })(entry.node);
  return targets;
}

// A tag has no marked content at all when it was created by the "Add
// Figure" draw tool over a region with no isolable image object (see
// figure_from_rect()'s "bbox" strategy in tag_worker.py) - it carries a
// /Layout /BBox attribute instead of any /K. collectTargetMcids() finds
// nothing for it, so highlightNodeOnPage() needs this parallel walk to
// still know where the tag is - mirrors collectTargetMcids' shape
// ({page, ...}, page 0-based) but keyed on a page-space rect instead of an
// mcid to look up in the text/graphics layers.
export function collectTargetBBoxes(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) return [];
  const targets = [];
  (function visit(node) {
    if (node.type === 'element' && Array.isArray(node.bbox) && node.page !== null && node.page !== undefined) {
      targets.push({ bbox: node.bbox, page: node.page });
    }
    for (const child of node.children || []) visit(child);
  })(entry.node);
  return targets;
}

// Concurrent first-time builds of the same page's cache entry, deduped.
//
// The value caches below only ever hold *settled* results, so N callers that
// all miss at the same moment each start their own build - and the Show AT
// Changes sweep does exactly that, firing every candidate's pull at once on
// purpose (see computeAtChangeFlags() in actual-text.js). A document with a
// hundred tagged elements on a handful of pages was paying for a hundred
// getTextContent()/getOperatorList() parses instead of one per page, which
// ate most of what parallelizing the sweep was supposed to buy.
//
// Keyed by kind + page number, and dropped as soon as a build settles - from
// then on the value cache answers directly. A build that throws caches
// nothing and leaves no entry behind, so the next caller retries, same as
// before.
const inFlightBuilds = new Map();

// Bumped by clearPageCaches() so a build started against the outgoing
// document can't write its result into the incoming document's cache: these
// are keyed by page *number*, with nothing in the key saying which file the
// page came from.
let cacheGeneration = 0;

function dedupePageBuild(kind, pageNumber, valueCache, build) {
  const key = `${kind}:${pageNumber}`;
  const existing = inFlightBuilds.get(key);
  if (existing) return existing;
  const generation = cacheGeneration;
  const promise = (async () => {
    try {
      const value = await build();
      if (generation === cacheGeneration) valueCache.set(pageNumber, value);
      return value;
    } finally {
      if (inFlightBuilds.get(key) === promise) inFlightBuilds.delete(key);
    }
  })();
  inFlightBuilds.set(key, promise);
  return promise;
}

// Drops every per-page cache derived from the document being released, and
// invalidates any build still in flight against it. Called wherever a
// document is swapped out or closed - see swapPdfDocument() in viewer.js and
// performClose() in doc-io.js.
export function clearPageCaches() {
  cacheGeneration += 1;
  inFlightBuilds.clear();
  state.textContentCache.clear();
  state.mcidTextCache.clear();
  state.mcidGraphicsCache.clear();
}

export async function getPageTextContent(pageNumber) {
  if (state.textContentCache.has(pageNumber)) return state.textContentCache.get(pageNumber);
  return dedupePageBuild('text', pageNumber, state.textContentCache, async () => {
    const page = await state.pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent({ includeMarkedContent: true });
    const viewport = page.getViewport({ scale: PAGE_SCALE });
    return { textContent, viewport };
  });
}

// Builds a page's mcid -> text lookup once (cached) rather than re-walking
// textContent.items per leaf node - a page's content leaves all share one
// walk instead of paying O(items) per node.
export async function getPageMcidTextMap(pageNumber) {
  if (state.mcidTextCache.has(pageNumber)) return state.mcidTextCache.get(pageNumber);
  return dedupePageBuild('mcidText', pageNumber, state.mcidTextCache, async () => buildPageMcidTextMap(pageNumber));
}

async function buildPageMcidTextMap(pageNumber) {
  const { textContent } = await getPageTextContent(pageNumber);
  const map = new Map();
  const mcidStack = [];
  for (const item of textContent.items) {
    if (item.str === undefined) {
      if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
        mcidStack.push(extractMcidFromItemId(item.id));
      } else if (item.type === 'endMarkedContent') {
        mcidStack.pop();
      }
      continue;
    }
    const currentMcid = mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : null;
    if (currentMcid === null || !item.str) continue;
    const existing = map.get(currentMcid) || '';
    map.set(currentMcid, existing + item.str + (item.hasEOL ? '\n' : ''));
  }
  for (const [mcid, text] of map) map.set(mcid, text.trim());
  return map;
}

// Builds a page's mcid -> image-xobject rect(s) lookup, its mcid -> vector-
// path rect(s) lookup, and its set of mcids painted via vector path
// operators (stroke/fill), in one pass over the operator list (cached per
// page). This is the non-text-content counterpart to getPageMcidTextMap():
// image `Do` calls and path stroke/fill ops don't show up in
// getTextContent(), so a Figure's placement has to be recovered from the
// raw operator list instead. Image rects come from mapping the unit square
// [0,1]x[0,1] - where an image is painted - through the current CTM
// (accumulated the same way a PDF interpreter would, via save/restore/
// transform/form-xobject) into page space. Vector rects come from the same
// CTM applied to the bounding box pdf.js itself precomputes for each path
// (constructPath's third arg) - it doesn't track curve control points, so a
// curve-only path (no preceding moveTo/lineTo/rectangle) yields an empty
// bound and is skipped, same as this file's other "close enough" rect
// approximations.
export async function getPageMcidGraphicsInfo(pageNumber) {
  if (state.mcidGraphicsCache.has(pageNumber)) return state.mcidGraphicsCache.get(pageNumber);
  return dedupePageBuild('graphics', pageNumber, state.mcidGraphicsCache, async () => buildPageMcidGraphicsInfo(pageNumber));
}

async function buildPageMcidGraphicsInfo(pageNumber) {
  const page = await state.pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: PAGE_SCALE });
  const { fnArray, argsArray } = await page.getOperatorList();
  const { OPS, Util } = pdfjsLib;

  const imageRects = new Map(); // mcid -> rect[]
  const vectorRects = new Map(); // mcid -> rect[]
  const vectorMcids = new Set();
  const mcidStack = [];
  const ctmStack = [];
  const clipStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  // The active clip region, as [minX, minY, maxX, maxY] in viewport pixel
  // space (already fixed by the CTM in effect when it was set - PDF clip
  // regions don't move with later `cm`s), or null when nothing restricts
  // painting. Needed because a placed image/path can be declared far larger
  // than what's actually visible - e.g. one shared full-page background
  // image reused by several Figures, each clipped down to just its own
  // small on-page region - and painting there is a poor proxy for a Figure's
  // real footprint unless that clip is accounted for.
  let activeClip = null;
  let currentPathMinMax = null; // [minX, minY, maxX, maxY] in user space, or null once painted

  const currentMcid = () => (mcidStack.length > 0 ? mcidStack[mcidStack.length - 1] : null);

  const boundsFromCorners = (corners) => {
    const transformed = corners
      .map((p) => Util.applyTransform(p, ctm))
      .map((p) => Util.applyTransform(p, viewport.transform));
    const xs = transformed.map((c) => c[0]);
    const ys = transformed.map((c) => c[1]);
    return {
      minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys),
    };
  };

  const boundsToRect = (b) => ({
    x: b.minX, y: b.minY, width: Math.max(0, b.maxX - b.minX), height: Math.max(0, b.maxY - b.minY),
  });

  const rectFromCorners = (corners) => {
    let bounds = boundsFromCorners(corners);
    if (activeClip) {
      bounds = {
        minX: Math.max(bounds.minX, activeClip[0]), minY: Math.max(bounds.minY, activeClip[1]),
        maxX: Math.min(bounds.maxX, activeClip[2]), maxY: Math.min(bounds.maxY, activeClip[3]),
      };
    }
    return boundsToRect(bounds);
  };

  const unitSquareRectForCurrentMcid = () => {
    const mcid = currentMcid();
    if (mcid === null) return;
    const rect = rectFromCorners([[0, 0], [1, 0], [0, 1], [1, 1]]);
    const existing = imageRects.get(mcid);
    if (existing) existing.push(rect); else imageRects.set(mcid, [rect]);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        ctmStack.push(ctm);
        clipStack.push(activeClip);
        break;
      case OPS.restore:
        ctm = ctmStack.length > 0 ? ctmStack.pop() : ctm;
        activeClip = clipStack.length > 0 ? clipStack.pop() : activeClip;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        ctmStack.push(ctm);
        clipStack.push(activeClip);
        if (args && args[0]) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = ctmStack.length > 0 ? ctmStack.pop() : ctm;
        activeClip = clipStack.length > 0 ? clipStack.pop() : activeClip;
        break;
      case OPS.beginMarkedContentProps:
        mcidStack.push(typeof args[1] === 'number' ? args[1] : null);
        break;
      case OPS.beginMarkedContent:
        mcidStack.push(null);
        break;
      case OPS.endMarkedContent:
        mcidStack.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        unitSquareRectForCurrentMcid();
        break;
      case OPS.constructPath:
        currentPathMinMax = args[2];
        break;
      // A clip path restricts everything painted afterward (until the next
      // restore) to its bounds - intersect it into activeClip rather than
      // replacing it outright, since clips nest (a q...Q inside an already-
      // clipped region only ever shrinks further).
      case OPS.clip:
      case OPS.eoClip:
        if (currentPathMinMax && Number.isFinite(currentPathMinMax[0])) {
          const [minX, minY, maxX, maxY] = currentPathMinMax;
          const b = boundsFromCorners([[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]);
          activeClip = activeClip
            ? [Math.max(activeClip[0], b.minX), Math.max(activeClip[1], b.minY),
              Math.min(activeClip[2], b.maxX), Math.min(activeClip[3], b.maxY)]
            : [b.minX, b.minY, b.maxX, b.maxY];
        }
        break;
      // A path is built by constructPath and only actually painted by one
      // of these - a clip-only path (W n with no stroke/fill) shouldn't
      // count as visible vector content, so we key off the paint ops
      // rather than constructPath itself.
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke: {
        const mcid = currentMcid();
        if (mcid !== null) {
          vectorMcids.add(mcid);
          if (currentPathMinMax && Number.isFinite(currentPathMinMax[0])) {
            const [minX, minY, maxX, maxY] = currentPathMinMax;
            const rect = rectFromCorners([[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]);
            const existing = vectorRects.get(mcid);
            if (existing) existing.push(rect); else vectorRects.set(mcid, [rect]);
          }
        }
        // A painted path's current path is cleared per spec - don't let it
        // leak into some later paint op that (invalidly) skips its own
        // constructPath.
        currentPathMinMax = null;
        break;
      }
      default:
        break;
    }
  }

  return { imageRects, vectorRects, vectorMcids };
}

// Merges image and vector-path rects into one mcid -> rect[] lookup, for
// consumers (highlighting, click hit-testing) that don't care which kind of
// graphic a Figure/Formula's content actually is.
export async function getPageGraphicRects(pageNumber) {
  const { imageRects, vectorRects } = await getPageMcidGraphicsInfo(pageNumber);
  const merged = new Map();
  for (const [mcid, rects] of imageRects) merged.set(mcid, [...rects]);
  for (const [mcid, rects] of vectorRects) {
    const existing = merged.get(mcid);
    if (existing) existing.push(...rects); else merged.set(mcid, [...rects]);
  }
  return merged;
}

async function getPageVectorMcids(pageNumber) {
  return (await getPageMcidGraphicsInfo(pageNumber)).vectorMcids;
}

// A content leaf's image rect must cover at least this fraction of the
// page's own width/height (independently, not just by area) to count as
// "the same size as the page" - auto-tagged full-page scans are typically
// placed with a few points of margin rather than flush to the MediaBox
// edges (e.g. one real sample: a 499x645 scan on a 514x657 page, ~97%
// coverage per side), while an intentionally-sized figure sharing the page
// with other content falls well short of this on at least one axis.
const FULL_PAGE_LEAF_COVERAGE = 0.9;

// Finds content leaves (bare-MCID leaves whose content is an image `Do`
// call - see getPageMcidGraphicsInfo()) whose painted rect is essentially
// the full page. These are almost always a full-page scan background that
// auto-tagging wrapped in a Figure alongside the real (searchable) text
// layer - the image itself carries no accessible information a screen
// reader can use, so it belongs artifacted, not left in a Figure tag. Does
// not cover /OBJR image leaves (annotation-style object references): they
// aren't wrapped in marked content, so recovering their placement would
// mean matching pdf.js's parsed resources back to the specific pikepdf
// object identity behind /Obj, which isn't currently feasible from here -
// and in practice this full-page-background pattern shows up as bare MCID
// leaves, not OBJR ones.
export async function findFullPageImageLeafIds() {
  if (!state.pdfDoc) return [];

  const leavesByPage = new Map(); // page (0-based) -> [{nodeId, mcid}]
  for (const [nodeId, entry] of state.nodesById) {
    const node = entry.node;
    if (node.type !== 'content' || node.mcid === null || node.mcid === undefined) continue;
    if (node.page === null || node.page === undefined) continue;
    const list = leavesByPage.get(node.page);
    if (list) list.push({ nodeId, mcid: node.mcid });
    else leavesByPage.set(node.page, [{ nodeId, mcid: node.mcid }]);
  }

  const matches = [];
  for (const [page0, leaves] of leavesByPage) {
    const pageNumber = page0 + 1;
    if (pageNumber < 1 || pageNumber > state.pageCount) continue;
    const page = await state.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PAGE_SCALE });
    const { imageRects } = await getPageMcidGraphicsInfo(pageNumber);
    const minWidth = viewport.width * FULL_PAGE_LEAF_COVERAGE;
    const minHeight = viewport.height * FULL_PAGE_LEAF_COVERAGE;
    for (const { nodeId, mcid } of leaves) {
      const rects = imageRects.get(mcid);
      if (!rects) continue;
      if (rects.some((r) => r.width >= minWidth && r.height >= minHeight)) {
        matches.push(nodeId);
      }
    }
  }
  return matches;
}

// Resolves a single content leaf's display text: its own text run if it has
// one, else a bracketed type label for an image `Do` call or a stroked/
// filled vector path (see getPageMcidGraphicsInfo()) - the same fallback
// loadContentText() uses for a content leaf's tree-row preview. Null when
// the mcid is out of page range or matches nothing (silently dropped by
// callers, same as before this was factored out of pullContentText()).
async function resolveMcidText(page0, mcid) {
  const pageNumber = page0 + 1;
  if (pageNumber < 1 || pageNumber > state.pageCount) return null;
  const map = await getPageMcidTextMap(pageNumber);
  const text = map.get(mcid);
  if (text) return text;
  const { imageRects, vectorMcids } = await getPageMcidGraphicsInfo(pageNumber);
  if (imageRects.has(mcid)) return '[Image]';
  if (vectorMcids.has(mcid)) return '[Graphic]';
  return null;
}

// Whether a list item's would-be first leaf reads as a label marker (a
// bullet glyph, a single letter followed by a period, or digits followed by
// a period) rather than ordinary body text - used by the 'L' and 'I'
// shortcuts to decide whether a new/relabeled LI splits into Lbl+LBody or
// just a single LBody. Matches the whole (trimmed) text exactly, not a
// substring, since the point is to isolate a marker standing on its own.
const LIST_LABEL_RE = /^(?:[•‣◦▪●○*]|[A-Za-z]\.|\d+\.)$/;

// The first leaf (content or object-ref) under `nodeId` in document order,
// or `nodeId`'s own node if it's already a leaf - mirrors
// _collect_leaf_ids() in tag_worker.py but stops at the first hit instead
// of collecting them all, since only the very first leaf's text matters for
// the label test below.
function firstLeafNode(nodeId) {
  const entry = state.nodesById.get(nodeId);
  if (!entry) return null;
  let found = null;
  (function visit(node) {
    if (found) return;
    if (node.type !== 'element') { found = node; return; }
    for (const child of node.children || []) { visit(child); if (found) return; }
  })(entry.node);
  return found;
}

// True when `nodeId` - about to become a new/relabeled LI's whole content -
// should split into a Lbl (just the marker) plus an LBody (everything
// else), because its first leaf is a bare label marker on its own. An
// object-ref leaf (an image has no text to test) or a node with no leaves
// at all both simply fail the test. Backs the 'L' and 'I' shortcuts -
// tag_worker.py has no text extraction of its own, so this decision has to
// be made here and passed down as a plain boolean per node id.
export async function isListLabelLeaf(nodeId) {
  const leaf = firstLeafNode(nodeId);
  if (!leaf || leaf.type !== 'content' || leaf.mcid === null || leaf.mcid === undefined
      || leaf.page === null || leaf.page === undefined) {
    return false;
  }
  const text = await resolveMcidText(leaf.page, leaf.mcid);
  return LIST_LABEL_RE.test((text || '').trim());
}

// Collects a tag's own content text (its content-leaf descendants' text,
// per collectTargetMcids), joined with a single space between blocks - used
// by the "Pull Content" button to seed Actual Text. See pullCellText() for
// the table preview's variant, which special-cases nested Figure tags.
export async function pullContentText(nodeId) {
  const targets = collectTargetMcids(nodeId);
  const parts = [];
  for (const target of targets) {
    const text = await resolveMcidText(target.page, target.mcid);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

// Like pullContentText(), but for a table preview cell (see
// renderTablePreview()): any tag in the cell's subtree - the cell itself or
// a nested element, checked top-down - contributes its own Actual Text
// as-is, the way a screen reader would announce it, instead of being
// descended into for raw content. Only a tag with no Actual Text falls back
// to that: a nested Figure contributes a single "[Figure]" marker, and
// anything else recurses into its children's content leaves. That keeps a
// cell mixing a Figure with ordinary text (e.g. a caption alongside an
// image) readable - the real text is pulled as usual and only the figure's
// portion collapses to "[Figure]", instead of one Figure anywhere in the
// cell blanking out all of it.
export async function pullCellText(cellNode) {
  const parts = [];
  async function visit(node) {
    if (node.type === 'content') {
      if (node.mcid !== null && node.mcid !== undefined && node.page !== null && node.page !== undefined) {
        const text = await resolveMcidText(node.page, node.mcid);
        if (text) parts.push(text);
      }
      return;
    }
    const actualText = (node.actualText || '').trim();
    if (actualText) {
      parts.push(actualText);
      return;
    }
    if (node.role === 'Figure') {
      parts.push('[Figure]');
      return;
    }
    for (const child of node.children || []) await visit(child);
  }
  await visit(cellNode);
  return parts.join(' ');
}

// True when a tag has a content leaf (bare MCID, node.type === 'content')
// directly among its children - a strong hint that Actual Text exists to
// replace that content, whether by an automatic placeholder pull (see
// updateActualTextPlaceholder()) or by focusing the empty field (see the
// fieldActualText 'focus' listener below). A content leaf buried under
// nested elements doesn't count - same "immediately inside" scope both
// call sites want.
export function hasDirectContentLeaf(node) {
  return (node.children || []).some((child) => child.type === 'content');
}
