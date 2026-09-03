// types/domain.d.ts
//
// Shared shapes for the data that crosses the JS <-> Python boundary.
//
// This is the ONE file in the project written in TypeScript syntax, and it
// contains no runtime code at all - `.d.ts` files are type declarations only
// and are never loaded by Electron. Everything that actually executes stays
// plain JavaScript; it just refers to the names declared here from JSDoc
// comments, like:
//
//     /** @type {import('./types/domain').TagNode | null} */
//
// These shapes mirror what python/tag_worker.py sends back. TypeScript cannot
// verify that for you - the worker is a separate process handing over JSON -
// so if you change a dict key in tag_worker.py, change it here too. Treat
// this file as a written-down contract, not a proof.

/**
 * One node in the PDF structure (tag) tree, as built by `_walk()` in
 * tag_worker.py.
 *
 * Three kinds of node share this shape:
 *   - the tree root and struct elements  (`type: 'root' | 'element'`)
 *   - marked-content leaves              (`type: 'content'`)
 *   - object references, e.g. annotations (`type: 'object-ref'`)
 *
 * The element-only and leaf-only fields are marked optional rather than split
 * into a strict union, so existing code that reads `node.mcid` without first
 * checking `node.type` keeps checking clean. That is a deliberate looseness:
 * it buys typo-catching now without forcing a rewrite of every call site.
 */
export interface TagNode {
  /** Worker-assigned id, unique within the open document. The root is `"root"`. */
  id: string;
  type: 'root' | 'element' | 'content' | 'object-ref';
  /** Structure type, e.g. `"P"`, `"H1"`, `"Figure"`. Always null on leaves. */
  role: string | null;
  children: TagNode[];
  /** 0-based page index the node resolved to; null when it could not be resolved. */
  page: number | null;

  // --- struct elements only ---------------------------------------------
  /** /Alt - alternate text. */
  alt?: string | null;
  /** /ActualText - the text this tag stands in for. */
  actualText?: string | null;
  /** /Lang - BCP 47 language tag. */
  lang?: string | null;
  /** Table cell scope from the /Table attribute dict. */
  scope?: string | null;
  colSpan?: number | null;
  rowSpan?: number | null;
  /** Layout /BBox as [x1, y1, x2, y2] in PDF user space. */
  bbox?: number[] | null;

  // --- content / object-ref leaves only ---------------------------------
  /** Marked-content id. Null on an /OBJR or an /MCR with no readable /MCID. */
  mcid?: number | null;
  /** For `type: 'object-ref'`, the referenced object's subtype (e.g. "/Link"). */
  objType?: string | null;
}

/** One bookmark in the document outline, from `_walk_outline()`. */
export interface BookmarkNode {
  /** Worker-assigned id of the form `"b1"`, `"b2"`, ... */
  id: string;
  title: string;
  /** 1-based page number the bookmark points at, or null if unresolved. */
  page: number | null;
  /** Vertical position on that page, in PDF user space, or null. */
  top: number | null;
  children: BookmarkNode[];
}

/** Document-level metadata, from `_get_doc_info()`. */
export interface DocInfo {
  /** Trailer /Info /Title. Editable. */
  title: string | null;
  /** Trailer /Info /Author. Editable. */
  author: string | null;
  /** Catalog /Lang. Editable. */
  lang: string | null;
  /** Catalog /MarkInfo /Marked - what Acrobat's "Tagged PDF" check reads. Read-only. */
  markedTagged: boolean;
  /** The "extract for accessibility" permission bit. Read-only. */
  accessibilityPermission: boolean;
}

/** Whether undo/redo are currently available, from `_undo_state()`. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * What every tree-mutating worker command returns: the rebuilt tree plus the
 * undo state that mutation produced.
 */
export interface MutationResult extends UndoState {
  tree: TagNode;
}

/**
 * `flatten_tags()`'s result: how many tags it actually removed. Zero when
 * the selection had nothing to flatten.
 */
export interface FlattenResult extends MutationResult {
  removed: number;
}

/** `scope_tables()`'s result: how many tables it gave cell scopes to. */
export interface ScopeTablesResult extends MutationResult {
  tablesScoped: number;
}

/** `insert_paragraph_after()`'s result: the tag it just created. */
export interface InsertResult extends MutationResult {
  newNodeId: string;
}

/**
 * `figure_from_rect()`'s result. `method` records which of the two tagging
 * strategies the worker picked for the drawn rectangle - see the section
 * comment above figure_from_rect() in tag_worker.py.
 */
export interface FigureFromRectResult extends InsertResult {
  method: 'object' | 'bbox';
}

/** What `open_document()` returns, plus the file bytes main.js attaches. */
export interface OpenResult extends UndoState {
  /** Absolute path the user picked. */
  filePath: string;
  /** Opaque handle the worker uses to find this document; needed by every later call. */
  docId: string;
  /** False for an untagged PDF, in which case `tree` is null. */
  hasStructTree: boolean;
  tree: TagNode | null;
  outline: BookmarkNode[];
  docInfo: DocInfo;
  /** The whole file, base64-encoded to survive Electron's IPC clone boundary. */
  pdfBase64: string;
}

/**
 * A heading gathered for "Generate Bookmarks", from
 * `collectHeadingsForBookmarks()` in renderer.js.
 */
export interface HeadingRef {
  /** Text for the bookmark: the heading's Actual Text, or its pulled content text. */
  title: string;
  /** 1-6, parsed from the H1..H6 role. */
  level: number;
  /** 0-based page index, taken straight from the tag's `page`. */
  page: number;
  /** y-coordinate in unscaled PDF page space, or null if it could not be measured. */
  top: number | null;
}

/**
 * One entry in an AI "fix Actual Text" batch. The same shape goes up as the
 * request and comes back as the result - `id` is the tag id, `text` is the
 * current text on the way in and the corrected text on the way back.
 */
export interface AiBatchEntry {
  id: string;
  text: string;
}

/**
 * A predicted duration range for an AI batch, from `estimateAiBatchRange()`
 * in main.js. Null instead of a range when there is no timing history yet.
 */
export interface AiBatchEstimate {
  /** Low end of the estimate, in milliseconds. */
  lowMs: number;
  /** High end of the estimate, in milliseconds. */
  highMs: number;
}

/**
 * An entry in `state.nodesById`: the node itself plus the id of its parent
 * (null for the root), so callers can walk back up a tree whose nodes carry
 * no parent pointer of their own.
 */
export interface IndexedNode {
  node: TagNode;
  parentId: string | null;
}

// --- Command payloads and results ----------------------------------------

/**
 * The editable attributes of a struct element, as accepted by
 * `update_node()` / `update_nodes()`. Every field is optional - only the keys
 * present are applied. A null or empty-string value clears that entry.
 *
 * Note the asymmetry with `role`: the worker tests `changes.get("role")` for
 * truthiness, so a role can be changed but never cleared this way.
 */
export interface TagNodeChanges {
  role?: string;
  alt?: string | null;
  actualText?: string | null;
  lang?: string | null;

  // The three /Table attributes arrive as already-trimmed strings, not
  // numbers - the tag properties panel sends its text inputs' values
  // straight through, and the worker treats '' as "clear this attribute".
  // See _apply_table_attr_changes() in tag_worker.py.
  scope?: string;
  colSpan?: string;
  rowSpan?: string;
}

/** The editable subset of DocInfo, as accepted by `update_doc_info()`. */
export interface DocInfoChanges {
  title?: string | null;
  author?: string | null;
  lang?: string | null;
}

/**
 * What undo/redo return. Unlike a normal mutation these rebuild the whole
 * document from a snapshot, so the outline and doc info come back too - they
 * may have changed as much as the tree did.
 */
export interface UndoRedoResult extends UndoState {
  tree: TagNode | null;
  outline: BookmarkNode[];
  docInfo: DocInfo;
}

/** What the outline-mutating commands return. */
export interface OutlineResult extends UndoState {
  outline: BookmarkNode[];
}

/** `add_bookmark()`'s result: the new outline plus the id of what it just added. */
export interface AddBookmarkResult extends OutlineResult {
  newBookmarkId: string;
}

/** The three answers to the unsaved-changes prompt. */
export type DiscardChoice = 'save' | 'discard' | 'cancel';

/**
 * `get_leaf_text()`'s result: the content leaf's text, decoded straight
 * from the content stream the same way `split_leaf()` itself reads it (not
 * pdf.js's own extraction, which the tag tree's preview elsewhere uses).
 * `text` is null with a human-readable `reason` when this leaf can't be
 * safely decoded (no /ToUnicode, nested marked content, an object
 * reference, ...) - the Tag Properties panel's "Split Content" section
 * shows that reason in place of the split field.
 */
export interface LeafTextResult {
  text: string | null;
  reason?: string;
}

/**
 * `split_leaf()`'s result: the rebuilt tree plus the two new leaves' ids
 * (`[before, after]`), so the caller can select/highlight them. Also - unlike
 * every other `MutationResult` - a fresh `pdfBase64` snapshot of the whole
 * (still unsaved) document: split_leaf() is the one command that rewrites a
 * page's content stream, so the renderer has to re-feed pdf.js those bytes
 * to keep the PDF preview's page text/highlighting in sync (see the
 * docstring on split_leaf() in tag_worker.py).
 */
export interface SplitLeafResult extends MutationResult {
  newNodeIds: [string | null, string | null];
  pdfBase64: string;
}

/**
 * One step in a Tools > Scripts… script (see renderer/scripts.js). `type`
 * picks which of the five toolbar actions this step runs; `findRole`/
 * `replaceRole` are only meaningful (and only shown in the builder) for a
 * `'find-replace'` step, since it's the only action with per-step
 * configuration - a script can hold several, each configured differently.
 */
export interface ScriptStep {
  id: string;
  type: 'smartifact' | 'scope-tables' | 'flatten-all' | 'find-replace' | 'fix-actual-text-ai';
  findRole?: string;
  replaceRole?: string;
}

/**
 * A user-defined, named sequence of ScriptSteps, built in the Scripts
 * dialog and persisted via window.api.getScripts()/setScripts(). Run in
 * order by the toolbar's "Run Script" button when its id matches
 * window.api.getActiveScriptId().
 */
export interface Script {
  id: string;
  name: string;
  steps: ScriptStep[];
}
