// tree-index.js
//
// Walking and looking things up in the tag tree the worker sends back. No
// rendering - just the index `state.nodesById` is built from and the
// ancestor/descendant questions the rest of the app asks about a node.

import { state } from './state.js';

// `tree` is null for an untagged PDF (no /StructTreeRoot - see
// _rebuild_registry in tag_worker.py), which is a state the app supports
// rather than an error: the tag tree just stays empty behind the
// no-structure banner while the preview, bookmarks and document properties
// all still work. Bail out to an empty index instead of walking it.
export function indexTree(tree) {
  const map = new Map();
  if (!tree) return map;
  (function visit(node, parentId) {
    map.set(node.id, { node, parentId });
    for (const child of node.children || []) visit(child, node.id);
  })(tree, null);
  return map;
}

export function buildMcidIndex(tree) {
  const index = new Map();
  (function visit(node, parentElementId) {
    if (node.type === 'content' && node.mcid !== null && node.mcid !== undefined
        && node.page !== null && node.page !== undefined && parentElementId) {
      if (!index.has(node.page)) index.set(node.page, new Map());
      index.get(node.page).set(node.mcid, parentElementId);
    }
    const nextParent = node.type === 'element' ? node.id : parentElementId;
    for (const child of node.children || []) visit(child, nextParent);
  })(tree, null);
  return index;
}

export function isDescendant(candidateAncestorId, nodeId) {
  // true if `nodeId` is candidateAncestorId itself, or lies anywhere under it
  const entry = state.nodesById.get(nodeId);
  if (!entry) return false;
  if (nodeId === candidateAncestorId) return true;
  if (entry.parentId === null) return false;
  return isDescendant(candidateAncestorId, entry.parentId);
}

// A node's id can't be trusted across a rebuild once the move that triggers
// it changes the tree's shape (see the "Node ids are a fresh depth-first
// counter..." comment above pruneStaleAiProposals) - but its *structural*
// path from the root (the sequence of child-indices to follow at each
// level) is unaffected by a move happening elsewhere in the tree, since
// that only changes the children array of the moved node's old and new
// parents, never the position of any other array along the way. Capture
// the path with nodePathFromRoot() against the pre-move tree, then use
// resolveNodeByPath() after applyFreshTree() to find the same node again
// under whatever id it was just reassigned.
export function nodePathFromRoot(nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur !== 'root') {
    const entry = state.nodesById.get(cur);
    if (!entry || entry.parentId === null) return null;
    const siblings = state.nodesById.get(entry.parentId)?.node.children || [];
    const idx = siblings.findIndex((c) => c.id === cur);
    if (idx === -1) return null;
    path.unshift(idx);
    cur = entry.parentId;
  }
  return path;
}

export function resolveNodeByPath(path) {
  let node = state.tree;
  for (const idx of path) {
    node = node?.children?.[idx];
    if (!node) return null;
  }
  return node;
}

/**
 * Depth-first walk over a tag subtree, calling `visit` on every node
 * including the one passed in. Generic - used by the verify checks, the
 * Actual Text sweep and anything else that needs to see every tag.
 */
export function walkTree(node, visit) {
  visit(node);
  for (const child of node.children || []) walkTree(child, visit);
}

// The id of the sole top-level /Document wrapper, when the whole structure
// tree is conventionally shaped that way - null when there's no structure
// tree, or when the root has anything other than exactly one /Document
// child (multiple top-level tags, or a top-level tag of some other role,
// are left alone: there's no single obvious wrapper to hide then).
//
// A PDF's real hierarchy is root -> /Document -> the actual content tags,
// but that wrapper carries no accessibility content or attributes worth
// exposing of its own (see showRootDetails() in details.js, which is where
// its would-be Title/Author/Language now live instead) - Acrobat's Tags
// panel doesn't show it either. Everywhere that walks the tree for the
// user to see or act on (rendering, Find/Replace, Proofread Mode) skips
// this id; everything that walks it for real structural work (drag/drop
// reparenting, isDescendant, nodePathFromRoot) still sees it, since the
// PDF's actual /K hierarchy hasn't changed - only what's shown has.
export function findHiddenDocumentWrapperId(tree) {
  if (!tree || !tree.children || tree.children.length !== 1) return null;
  const onlyChild = tree.children[0];
  return onlyChild.type === 'element' && onlyChild.role === 'Document' ? onlyChild.id : null;
}
