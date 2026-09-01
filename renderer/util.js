// util.js
//
// Small pure helpers with no knowledge of the app's state or DOM: given the
// same input they always return the same output. Kept together so the rest
// of the renderer can use them without pulling in anything else.

const ROLE_CATEGORY = {};

for (const r of ['H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Title']) ROLE_CATEGORY[r] = 'heading';

for (const r of ['Document', 'Part', 'Art', 'Sect', 'Div', 'TOC', 'TOCI', 'Index', 'NonStruct', 'Private']) ROLE_CATEGORY[r] = 'container';

for (const r of ['L', 'LI', 'Lbl', 'LBody']) ROLE_CATEGORY[r] = 'list';

for (const r of ['Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot']) ROLE_CATEGORY[r] = 'table';

for (const r of ['Figure', 'Formula']) ROLE_CATEGORY[r] = 'figure';

export function categoryForRole(role) {
  if (!role) return 'leaf';
  return ROLE_CATEGORY[role] || 'inline';
}

// Word-level diff (classic O(n*m) LCS over whitespace-preserving tokens) so
// only the spans that actually changed get marked, not the whole field.
// Tag-level text is short enough (a sentence/caption/heading, not a whole
// document) that the DP table is cheap - see the size guard in
// renderActualTextDiff() below for the pathological-input fallback.
export function diffWordTokens(oldText, newText) {
  const tokenize = (text) => text.split(/(\s+)/).filter((token) => token.length > 0);
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const n = oldTokens.length;
  const m = newTokens.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Only "common" (unchanged) and "added" tokens are emitted, in new-text
  // order - a token only in the old text is simply skipped, since the field
  // always displays the suggested text, never a two-sided before/after view.
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      parts.push({ text: newTokens[j], added: false });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      parts.push({ text: newTokens[j], added: true });
      j++;
    }
  }
  while (j < m) {
    parts.push({ text: newTokens[j], added: true });
    j++;
  }
  return parts;
}

export function extractMcidFromItemId(id) {
  // pdf.js formats this as "<pageObjId>_mc<mcid>" - the prefix is opaque
  // and irrelevant here since we already scope the lookup to one page.
  if (!id) return null;
  const match = /_mc(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

export function pointInRect(x, y, box) {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

export function unionRects(rects) {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// mm:ss - both the upfront estimate and the live elapsed timer use this, so
// the two read as directly comparable at a glance.
export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function countLabel(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
