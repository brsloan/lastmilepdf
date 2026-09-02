// actual-text.js
//
// The Actual Text review overlay: the word-level diff shown against a tag
// whose Actual Text was changed by "Fix All Actual Text (AI)", and the Show
// AT Changes sweep that finds tags whose Actual Text no longer matches the
// content underneath them.

import { walkTree } from './tree-index.js';
import { el } from './dom.js';
import { pullContentText } from './page-content.js';
import { state } from './state.js';
import { diffWordTokens } from './util.js';

// Node ids are a fresh depth-first counter reassigned on every tree rebuild
// (see indexTree() above and _rebuild_registry() in tag_worker.py) - a pure
// attribute edit rebuilds to the same ids (same tree shape), but any OTHER
// edit (delete, reorder, Kill Divs...) can shift them, which would silently
// attach a stale highlight to whatever tag now happens to hold that id. A
// tag's Actual Text no longer matching what the AI wrote also covers Revert
// and Undo, and a manual edit (see the 'input' listener below, which clears
// its own entry immediately rather than waiting for a rebuild). Either way,
// once node.actualText has moved on from `suggested`, the diff no longer
// describes anything real, so drop it. state.atChangeFlags (see
// computeAtChangeFlags()) shares the same { original, suggested } shape and
// the same staleness risk, so it's pruned the same way here.
export function pruneStaleAiProposals() {
  for (const [id, proposal] of state.aiProposals) {
    const node = state.nodesById.get(id)?.node;
    if (!node || (node.actualText || '') !== proposal.suggested) {
      state.aiProposals.delete(id);
    }
  }
  for (const [id, proposal] of state.atChangeFlags) {
    const node = state.nodesById.get(id)?.node;
    if (!node || (node.actualText || '') !== proposal.suggested) {
      state.atChangeFlags.delete(id);
    }
  }
}

function renderActualTextDiff(originalText, suggestedText) {
  el.actualTextHighlight.innerHTML = '';
  // The DP table above is O(n*m) cells - guard against a pathological pair
  // of texts doing multi-million-cell work on every selection by falling
  // back to a plain (unhighlighted but still correct) display.
  const roughTokens = (originalText.length + suggestedText.length) / 4;
  if (roughTokens * roughTokens > 4_000_000) {
    el.actualTextHighlight.textContent = suggestedText;
    return;
  }
  for (const part of diffWordTokens(originalText, suggestedText)) {
    if (part.added) {
      const mark = document.createElement('mark');
      mark.textContent = part.text;
      el.actualTextHighlight.appendChild(mark);
    } else {
      el.actualTextHighlight.appendChild(document.createTextNode(part.text));
    }
  }
}

// Shows/hides the review UI for `nodeId`'s applied AI fix (or, in Tools >
// Show AT Changes mode, its flagged Actual-Text-vs-content difference), if
// any. Called from refreshDetailsForSelection()/closeDetails() on every
// selection change, and directly with `null` to force-hide it. The field's
// value is already correct by the time this runs - refreshDetailsForSelection()
// sets it from node.actualText - so this only toggles the highlight overlay
// on top of it, diffing the proposal's recorded `original` against the
// field's current (== node.actualText) value. aiProposals wins when a tag
// has both, since it reflects this session's own fix more precisely than a
// re-derived sweep result.
export function updateActualTextReviewUI(nodeId) {
  const aiProposal = nodeId ? state.aiProposals.get(nodeId) : null;
  const proposal = aiProposal || (nodeId && state.showAtChanges ? state.atChangeFlags.get(nodeId) : null);
  if (!proposal) {
    el.fieldActualText.classList.remove('actual-text-reviewing');
    el.actualTextHighlight.classList.remove('visible');
    el.actualTextHighlight.innerHTML = '';
    el.actualTextReviewBar.hidden = true;
    return;
  }
  el.fieldActualText.classList.add('actual-text-reviewing');
  renderActualTextDiff(proposal.original, el.fieldActualText.value);
  el.actualTextHighlight.classList.add('visible');
  el.actualTextReviewBar.hidden = false;
  el.actualTextReviewLabel.textContent = aiProposal
    ? 'AI fix applied – changes highlighted'
    : 'Actual Text differs from pulled content – changes highlighted';
  el.actualTextHighlight.scrollTop = el.fieldActualText.scrollTop;
}

// --- "Show AT Changes" review sweep ---------------------------------------
//
// Unlike aiProposals (only ever populated by clicking "Fix All Actual Text
// (AI)" this session, and gone the moment the app restarts), this recomputes
// straight from the file: any tag whose Actual Text no longer matches what
// "Pull Content" would produce right now gets flagged, so past AI edits (or
// any other hand edit that diverged from the raw content) stay reviewable
// even after the file was saved, closed, and reopened. Mirrors the
// candidate scan in el.btnFixAllActualText below, minus the AI call - note
// hasDirectContentLeaf() is NOT required here the way it is there: that
// check only gates *seeding* a pull for a tag with no Actual Text yet, but
// every candidate here already has Actual Text, so it's always worth
// pulling and comparing regardless of whether its content leaf sits
// directly inside it or deeper in the subtree (pullContentText() walks the
// whole subtree either way).
//
// Candidates are pulled in parallel (Promise.all), not one at a time - each
// pull is an independent read, and a real document can easily have its
// existing Actual Text spread across a dozen+ pages, each needing its own
// first-time (uncached) pdf.js getTextContent() call; doing that
// sequentially made a freshly opened document's sweep visibly slow (tens of
// seconds), which read as "Show AT Changes doesn't work for a new file"
// when it was really still running.
export async function computeAtChangeFlags() {
  const token = ++state.atChangeSweepToken;
  const flags = new Map();
  if (state.tree && state.pdfDoc) {
    const candidates = [];
    walkTree(state.tree, (node) => {
      if (node.type !== 'element' || node.role === 'Table' || node.role === 'Document') return;
      if (!node.actualText || !node.actualText.trim()) return;
      candidates.push(node);
    });
    const pulledTexts = await Promise.all(candidates.map((node) => pullContentText(node.id)));
    if (token !== state.atChangeSweepToken) return; // superseded by a newer sweep
    candidates.forEach((node, i) => {
      const pulled = pulledTexts[i] || '';
      if (pulled !== node.actualText) {
        flags.set(node.id, { original: pulled, suggested: node.actualText });
      }
    });
  }
  if (token !== state.atChangeSweepToken) return;
  state.atChangeFlags = flags;
}

// Keeps a single tag's Show AT Changes flag in sync with a just-applied
// edit, without re-sweeping the whole tree - called from
// applyDetailsChange() whenever showAtChanges is on, so a tag edited (typed
// into directly, Pull Content + commit, Fix with AI, Revert...) while the
// mode is already active gets flagged/unflagged live, instead of only
// reappearing after the user toggles the menu item off and back on. Mirrors
// computeAtChangeFlags()'s own per-candidate logic for one node.
export async function updateAtChangeFlagForNode(nodeId) {
  const node = state.nodesById.get(nodeId)?.node;
  if (!node || node.type !== 'element' || node.role === 'Table' || node.role === 'Document'
      || !node.actualText || !node.actualText.trim()) {
    state.atChangeFlags.delete(nodeId);
    return;
  }
  // Same invalidation computeAtChangeFlags() uses: a full sweep replaces
  // state.atChangeFlags wholesale, and opening/closing a document bumps the
  // token too (see doc-io.js), so a pull that outlives either of those must
  // not write its now-meaningless verdict into the fresh map.
  const token = state.atChangeSweepToken;
  const pulled = (await pullContentText(nodeId)) || '';
  if (token !== state.atChangeSweepToken) return;
  if (pulled !== node.actualText) {
    state.atChangeFlags.set(nodeId, { original: pulled, suggested: node.actualText });
  } else {
    state.atChangeFlags.delete(nodeId);
  }
}
