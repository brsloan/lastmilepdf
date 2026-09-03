// types/app-state.d.ts
//
// The shape of the renderer's single `state` object (see the top of
// renderer/renderer.js).
//
// Worth having as a declared type rather than letting TypeScript infer it
// from the object literal: an inferred JS object literal stays "open", so
// `state.slectedNodeId = x` would silently create a new property instead of
// being flagged. Declared here, a misspelling is an error - which matters
// for the object nearly every function in renderer.js touches.
//
// Fields that come from pdf.js are typed `any` on purpose: pdf.js is only
// reachable here through a relative import of its bundle, and modelling its
// API is a separate job from modelling ours.

import type { TagNode, BookmarkNode, DocInfo, IndexedNode, UpdateInfo, UpdateState } from './domain';

/** A point in canvas-pixel space. */
export interface Point {
  x: number;
  y: number;
}

/** An entry in `state.bookmarksById` - mirrors IndexedNode, for the outline. */
export interface IndexedBookmark {
  node: BookmarkNode;
  parentId: string | null;
}

/**
 * A before/after pair for a tag's Actual Text, used for the inline diff
 * highlight. Shared by `aiProposals` (a fix already applied by "Fix All
 * Actual Text") and `atChangeFlags` (recomputed from the file by the Show AT
 * Changes sweep), which is what lets them share renderActualTextDiff().
 */
export interface TextProposal {
  original: string;
  suggested: string;
}

/** Where one cell sits in the Table Editor's grid. */
export interface TableCellPosition {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** The most recent Table Editor grid build, from buildTableGrid(). */
export interface TableGrid {
  /** cellId -> its position in the grid. */
  positions: Map<string, TableCellPosition>;
  colCount: number;
}

/** A cached pdf.js text layer for one page. */
export interface PageTextEntry {
  /** pdf.js TextContent. */
  textContent: any;
  /** pdf.js PageViewport, at PAGE_SCALE. */
  viewport: any;
}

/** Cached per-page graphics info, from getPageMcidGraphicsInfo(). */
export interface PageGraphicsInfo {
  /** mcid -> the image rects drawn under it. */
  imageRects: Map<number, number[][]>;
  /** mcid -> the vector rects drawn under it. */
  vectorRects: Map<number, number[][]>;
  /** Every mcid that drew vector content. */
  vectorMcids: Set<number>;
}

/** The rubber-band rectangle being drawn by the Add Figure tool. */
export interface FigureDrawRect {
  start: Point;
  current: Point;
}

export interface AppState {
  // --- the open document ------------------------------------------------
  /** Worker handle for the open document; null when nothing is open. */
  docId: string | null;
  fileName: string | null;
  /** Path last used to save this doc - Save As sets it, Save reuses it. */
  savedFilePath: string | null;
  /** Current full tag tree, as returned by the worker. */
  tree: TagNode | null;
  /** id -> node, rebuilt every time `tree` is replaced. */
  nodesById: Map<string, IndexedNode>;
  /** id of the sole top-level /Document wrapper, or null - see findHiddenDocumentWrapperId(). */
  hiddenDocumentId: string | null;
  /** page (0-based) -> Map(mcid -> owning element node id). */
  mcidIndex: Map<number, Map<number, string>>;
  /** Whether the document has a /StructTreeRoot at all. */
  hasStructTree: boolean;
  /**
   * Document Title/Author/Lang. Partial because the reset path substitutes a
   * bare `{ title, author }` when the worker sends nothing back.
   */
  docInfo: Partial<DocInfo>;

  // --- selection --------------------------------------------------------
  /** The "active" tag - drives the details panel, highlight and scroll. */
  selectedNodeId: string | null;
  /** Full multi-selection; always a superset containing selectedNodeId. */
  selectedNodeIds: Set<string>;
  /** Fixed point shift+click range-selects from. */
  selectionAnchorId: string | null;
  draggedNodeId: string | null;
  /** The whole block being dragged, when a multi-selection is dragged. */
  draggedNodeIds: Set<string> | null;

  // --- bookmarks --------------------------------------------------------
  /** Current bookmark tree; null before a document is opened. */
  outline: BookmarkNode[] | null;
  /** id -> { node, parentId }, rebuilt whenever `outline` is replaced. */
  bookmarksById: Map<string, IndexedBookmark>;
  selectedBookmarkId: string | null;

  // --- the pdf.js viewer ------------------------------------------------
  /** pdf.js PDFDocumentProxy. */
  pdfDoc: any;
  currentPage: number;
  pageCount: number;
  /** In-flight pdf.js RenderTask, so a new page render can cancel it. */
  renderTask: any;
  /** Invalidates a render whose getPage() await was overtaken. */
  renderToken: number;
  /** page number -> cached text layer, reset per document. */
  textContentCache: Map<number, PageTextEntry>;
  /** page number -> Map(mcid -> text), reset per document. */
  mcidTextCache: Map<number, Map<number, string>>;
  /** page number -> cached graphics info, reset per document. */
  mcidGraphicsCache: Map<number, PageGraphicsInfo>;

  // --- editing state ----------------------------------------------------
  /** Tag edits made since the last save. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // --- panels, filtering, display --------------------------------------
  /** Which details-pane tab is showing. */
  activePanel: 'properties' | 'bookmarks';
  /** Which tags the tree shows - see renderFilteredTree(). */
  filter: 'all' | 'headings' | 'figures' | 'table';
  /** nodeId -> explicit user toggle; absence means the role-based default. */
  collapseOverrides: Map<string, boolean>;
  showTagTypeLabel: boolean;

  // --- the Table Editor dialog -----------------------------------------
  /** id of the Table tag currently open in the Table Editor. */
  tableEditorTableId: string | null;
  /** Selected TH/TD cell ids within the Table Editor. */
  tableEditorSelectedIds: Set<string>;
  /** Last explicitly selected cell, for shift-click ranges. */
  tableEditorAnchorId: string | null;
  tableEditorGrid: TableGrid | null;
  /** What the row/column arrows last selected, so Delete knows what to remove. */
  tableEditorSelectionKind: 'row' | 'column' | 'cell' | null;
  /** TR node id, set only when tableEditorSelectionKind === 'row'. */
  tableEditorSelectedRowId: string | null;
  /** Logical column index, set only when tableEditorSelectionKind === 'column'. */
  tableEditorSelectedColIndex: number | null;

  // --- Walk mode --------------------------------------------------------
  walking: boolean;
  /**
   * setTimeout handle for the auto-advance tick.
   *
   * `ReturnType<typeof setTimeout>` rather than `number`: the browser's
   * setTimeout returns a number, but Node's type declarations reach this
   * program transitively (electron.d.ts, via preload.js) and their overload
   * returns a `Timeout` object. This is right either way.
   */
  walkTimerId: ReturnType<typeof setTimeout> | null;
  /** Tags per second; persisted across sessions. */
  walkSpeed: number;

  // --- the Add Figure tool ---------------------------------------------
  figureDrawActive: boolean;
  figureDrawRect: FigureDrawRect | null;

  // --- Actual Text review ----------------------------------------------
  /** nodeId -> an AI fix already applied, kept to render the inline diff. */
  aiProposals: Map<string, TextProposal>;
  /** nodeId -> a tag whose Actual Text no longer matches its content text. */
  atChangeFlags: Map<string, TextProposal>;
  /** Tools > Show AT Changes toggle. */
  showAtChanges: boolean;
  /** View > Proofread toggle - see proofread.js. */
  proofreadMode: boolean;
  /** nodeId whose Actual Text field shows an unconfirmed Proofread Mode content-pull, not yet applied - see updateActualTextPlaceholder() in details.js. */
  pendingPulledActualTextNodeId: string | null;
  /** Invalidates a superseded computeAtChangeFlags() sweep. */
  atChangeSweepToken: number;

  // --- Find/Replace -----------------------------------------------------
  /** id most recently found/replaced - see doFindNext(). */
  findReplaceLastMatchId: string | null;

  // --- notification settings -------------------------------------------
  notifyDesktop: boolean;
  notifyChime: boolean;

  /** KeyboardEvent.code (e.g. "CapsLock") that also triggers the Tag Tree/Bookmarks Delete shortcut, or null when unset. */
  extraDeleteKeyCode: string | null;

  // --- Auto-Save ----------------------------------------------------------
  /** File > Settings > Preferences > Auto-Save - periodically save to disk. */
  autoSaveEnabled: boolean;

  // --- Auto-update (Help > About) ------------------------------------------
  /** File > Settings > Preferences > Automatically check for updates - only gates the launch-time check; Help > About's own check always works. */
  autoCheckUpdates: boolean;
  /** Static snapshot from window.api.getUpdateInfo(), refetched each time About opens. */
  updateInfo: UpdateInfo;
  /** Live status kept current by window.api.onUpdateState(), regardless of whether About is open. */
  updateState: UpdateState;

  // --- Split Content (see split-content.js) ------------------------------
  /** The content leaf the Split Content panel currently shows, or null. */
  splitContentNodeId: string | null;

  // --- invalidation tokens for in-flight async work ---------------------
  highlightToken: number;
  tablePreviewToken: number;
  listPreviewToken: number;
  actualTextPlaceholderToken: number;
  tableEditorToken: number;
  splitContentToken: number;
}
