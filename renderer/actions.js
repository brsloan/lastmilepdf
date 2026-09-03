// actions.js
//
// The operations shared between a toolbar button and a Tools > Scripts…
// script step (see scripts.js's runActiveScript()): Smartifact, Scope
// Tables, Flatten All, Find/Replace, and Fix All Actual Text (AI). Kept in
// one place so a script step and its matching toolbar button always do
// exactly the same thing - each function here applies the mutation, updates
// `state`/the tree view/undo state, and returns a status message; the
// caller decides where that message goes (setStatus(), a dialog's own
// status line, or a script's step-by-step log).

import { hideAiBatchProgress, showAiBatchProgress, updateAiBatchProgressEstimate } from './ai-batch.js';
import { closeDetails, refreshDetailsForSelection } from './details.js';
import { findReplaceMatches } from './find-replace.js';
import { findFullPageImageLeafIds, hasDirectContentLeaf, pullDirectContentText } from './page-content.js';
import { applyUndoState } from './shell.js';
import { state } from './state.js';
import { isDescendant, walkTree } from './tree-index.js';
import { applyFreshTree } from './tree-view.js';

/**
 * Flattens organizational tags within the current tag-tree selection, or
 * the whole document (root) when nothing is selected - the toolbar Flatten
 * button's behavior.
 * @returns {Promise<string>}
 */
export async function runFlattenSelectionOrAll() {
  const ids = Array.from(state.selectedNodeIds);
  const targetIds = ids.length > 0
    ? ids.filter((id) => !ids.some((other) => other !== id && isDescendant(other, id)))
    : ['root'];
  return flattenTargets(targetIds);
}

/**
 * Flattens organizational tags across the whole document regardless of any
 * current tag-tree selection - what a script's "Flatten All" step means.
 * @returns {Promise<string>}
 */
export async function runFlattenAll() {
  return flattenTargets(['root']);
}

async function flattenTargets(targetIds) {
  const result = await window.api.flattenTags(state.docId, targetIds);
  applyFreshTree(result.tree);
  applyUndoState(result);
  return result.removed > 0
    ? `Flattened ${result.removed} tag${result.removed === 1 ? '' : 's'}.`
    : 'No organizational tags found.';
}

/** @returns {Promise<string>} */
export async function runScopeTables() {
  const result = await window.api.scopeTables(state.docId);
  applyFreshTree(result.tree);
  applyUndoState(result);
  return result.tablesScoped > 0
    ? `Scoped ${result.tablesScoped} table${result.tablesScoped === 1 ? '' : 's'}.`
    : 'No tables matched a recognized header shape.';
}

/** @returns {Promise<string>} */
export async function runSmartifact() {
  const ids = await findFullPageImageLeafIds(); // resolves to [] with no PDF preview loaded, see page-content.js
  if (ids.length === 0) return 'No full-page image leaves found.';
  const result = await window.api.deleteNodes(state.docId, ids);
  applyFreshTree(result.tree);
  applyUndoState(result);
  closeDetails();
  return `Artifacted ${ids.length} full-page image${ids.length === 1 ? '' : 's'}.`;
}

/**
 * Relabels every tag of role `findRole` to `replaceRole` - the Find/Replace
 * dialog's "Replace All", and what a script's 'find-replace' step runs.
 * @param {string} findRole
 * @param {string} replaceRole
 * @returns {Promise<{ count: number, message: string }>}
 */
export async function runFindReplaceAll(findRole, replaceRole) {
  if (!findRole || !replaceRole) {
    throw new Error('Enter both a tag type to find and one to replace it with.');
  }
  const matches = findReplaceMatches(findRole);
  if (matches.length === 0) {
    return { count: 0, message: `No /${findRole} tags found.` };
  }
  const result = await window.api.updateNodes(state.docId, matches, { role: replaceRole });
  applyFreshTree(result.tree);
  applyUndoState(result);
  state.findReplaceLastMatchId = null;
  const count = matches.length;
  return { count, message: `Replaced ${count} /${findRole} tag${count === 1 ? '' : 's'} with /${replaceRole}.` };
}

/**
 * Sends every tag's Actual Text to AI in one request for document-wide
 * consistency, applying every changed tag as one undo step - the toolbar's
 * "Fix All Actual Text (AI)" button, and what a script's 'fix-actual-text-ai'
 * step runs. Shows/hides the AI batch progress dialog itself, since that's
 * needed whether this runs standalone or as one step of a script; the
 * caller is still responsible for disabling its own trigger button and any
 * finish notification/chime.
 * @returns {Promise<string>}
 */
export async function runFixAllActualTextAi() {
  if (!state.tree) return 'No document loaded.';
  showAiBatchProgress();
  try {
    const candidates = [];
    walkTree(state.tree, (node) => {
      if (node.type !== 'element' || node.role === 'Table' || node.role === 'Document') return;
      if (node.actualText && node.actualText.trim()) {
        candidates.push({ id: node.id, text: node.actualText });
      } else if (state.pdfDoc && hasDirectContentLeaf(node)) {
        candidates.push({ id: node.id, text: null }); // text pulled below
      }
    });

    const toPull = candidates.filter((candidate) => candidate.text === null);
    for (const candidate of toPull) {
      candidate.text = (await pullDirectContentText(candidate.id)) || '';
    }

    const items = candidates.filter((candidate) => candidate.text && candidate.text.trim());
    if (items.length === 0) return 'No tags have Actual Text (or pullable content) to fix.';

    const requestItems = items.map(({ id, text }) => ({ id, text }));
    updateAiBatchProgressEstimate(await window.api.estimateAiBatchTime(JSON.stringify(requestItems).length));
    const results = await window.api.fixActualTextBatch(requestItems);
    const byId = new Map(items.map((item) => [item.id, item]));
    /** @type {Record<string, string>} */
    const updates = {};
    const proposals = new Map();
    for (const result of results) {
      const candidate = byId.get(result.id);
      if (!candidate || result.text === candidate.text) continue;
      updates[result.id] = result.text;
      proposals.set(result.id, { original: candidate.text, suggested: result.text });
    }

    if (Object.keys(updates).length === 0) return 'AI found no changes to make.';

    const result = await window.api.updateActualTexts(state.docId, updates);
    state.aiProposals = proposals; // set before applyFreshTree() so pruneStaleAiProposals() sees the fixes it just wrote
    applyFreshTree(result.tree);
    applyUndoState(result);
    refreshDetailsForSelection();
    const pulledCount = toPull.filter((candidate) => candidate.text && candidate.text.trim()).length;
    return `AI fixed ${proposals.size} of ${items.length} tags (${pulledCount} pulled from content with no prior Actual Text).`;
  } finally {
    hideAiBatchProgress();
  }
}
