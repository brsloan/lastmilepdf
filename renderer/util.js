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

// --- word-level diff -------------------------------------------------------
//
// Classic O(n*m) LCS over whitespace-preserving tokens, so only the spans
// that actually changed get marked, not the whole field. Tag-level text is
// short enough (a sentence/caption/heading, not a whole document) that the
// DP table is cheap - see wordDiffIsAffordable() for the pathological-input
// guard both consumers apply.

function tokenizeWords(text) {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

// The DP table is O(n*m) cells - a pathological pair of texts would do
// multi-million-cell work on every selection. Callers fall back to a plain
// (unhighlighted but still correct) display when this says no.
export function wordDiffIsAffordable(oldText, newText) {
  const roughTokens = (oldText.length + newText.length) / 4;
  return roughTokens * roughTokens <= 4_000_000;
}

// The full alignment, one op per token on either side, in order:
// { type: 'common' | 'removed' | 'added', text }. 'removed' tokens exist
// only in the old text, 'added' only in the new. The tie-break (prefer
// skipping an old token over emitting a new one) is what fixes where an
// insertion lands relative to its neighbors, so both consumers below see
// the same alignment - the field's marks and the page's marks describe the
// same edit.
function alignWordTokens(oldTokens, newTokens) {
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
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) {
      ops.push({ type: 'common', text: newTokens[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'removed', text: oldTokens[i] });
      i++;
    } else {
      ops.push({ type: 'added', text: newTokens[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'removed', text: oldTokens[i++] });
  while (j < m) ops.push({ type: 'added', text: newTokens[j++] });
  return ops;
}

// The new text's tokens in order, each flagged as added or not - what the
// Actual Text field's highlight overlay renders. A token only in the old
// text is simply left out, since the field always displays the suggested
// text, never a two-sided before/after view.
export function diffWordTokens(oldText, newText) {
  return alignWordTokens(tokenizeWords(oldText), tokenizeWords(newText))
    .filter((op) => op.type !== 'removed')
    .map((op) => ({ text: op.text, added: op.type === 'added' }));
}

// The other side of the same diff: where in the OLD text each change sits,
// as character offsets into it - what the page preview needs, since the old
// text is the one that was actually painted on the page. Each maximal run of
// changed tokens becomes one region:
//   - 'removed': [start, end) covers the old tokens that were replaced or
//     dropped, with whitespace trimmed off both ends ("m34ns" in
//     "This m34ns war" -> "This means war").
//   - 'inserted': a zero-width marker (start === end) where new words were
//     added but nothing of substance was removed ("This war" -> "This means
//     war" marks the spot just before "war"). Anchored where the run begins
//     in the old text; that may be whitespace or a line break, so a
//     consumer should snap forward to the next visible character.
// A run that only changes whitespace (a line break becoming a space) yields
// nothing - there is no ink on the page to point at.
export function diffOldTextChanges(oldText, newText) {
  const ops = alignWordTokens(tokenizeWords(oldText), tokenizeWords(newText));
  const regions = [];
  let oldPos = 0;
  let hunk = null; // { start, end, addedInk } for the run of changed ops in progress
  const flush = () => {
    if (!hunk) return;
    let s = hunk.start;
    let e = hunk.end;
    while (s < e && /\s/.test(oldText[s])) s++;
    while (e > s && /\s/.test(oldText[e - 1])) e--;
    if (e > s) {
      regions.push({ start: s, end: e, kind: 'removed' });
    } else if (hunk.addedInk) {
      regions.push({ start: hunk.start, end: hunk.start, kind: 'inserted' });
    }
    hunk = null;
  };
  for (const op of ops) {
    if (op.type === 'common') {
      flush();
      oldPos += op.text.length;
      continue;
    }
    if (!hunk) hunk = { start: oldPos, end: oldPos, addedInk: false };
    if (op.type === 'removed') {
      oldPos += op.text.length;
      hunk.end = oldPos;
    } else if (op.text.trim()) {
      hunk.addedInk = true;
    }
  }
  flush();
  return regions;
}

// True when two texts say the same words in the same order and differ only
// in the white space between them - a line break pulled into a space, a
// double space collapsed, a trailing newline dropped. Callers use this to
// tell a cosmetic Actual Text change apart from one that altered the words
// themselves, so the tree can grade its badge (see appendElementChipAndFlag()
// in tree-view.js) instead of flagging both alike. White space that
// disappears entirely, joining two words into one ("foo bar" -> "foobar", or
// a de-hyphenated line break), changes the words and so is NOT
// whitespace-only: the normalized forms no longer match.
export function isWhitespaceOnlyChange(oldText, newText) {
  const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
  return normalize(oldText) === normalize(newText);
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

// Friendly label for a configurable tagging/proofread shortcut's
// KeyboardEvent.key (e.g. "PageUp" -> "Page Up", "p" -> "P"). These are
// recorded as .key rather than .code (see findTagShortcutAction() in
// renderer.js, which compares case-insensitively), so single-character keys
// are just uppercased rather than looked up in a code table - unlike the
// Extra Delete/Artifact key, whose formatKeyCode() stays in renderer.js
// beside the recorder that is its only caller.
//
// Shared by the Preferences shortcut rows and the Tag Tree context menu, so
// a key shown in the menu is spelled exactly the way Preferences spells it.
export function formatShortcutKey(key) {
  if (!key) return 'Not set';
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key.replace(/([a-z])([A-Z])/g, '$1 $2');
}
