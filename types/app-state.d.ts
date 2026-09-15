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

import type { ArtifactEntry, TagNode, BookmarkNode, DocInfo, IndexedNode, UpdateInfo, UpdateState } from './domain';

/** A point in canvas-pixel space. */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned box in pdf.js viewport space, as the overlays use. */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One character's box in viewport space, from the worker's glyph engine. */
export interface GlyphBox extends ViewportRect {
  /** Index within its own marked-content span, counting from 0. */
  seq: number;
  /** What it decodes to - usually one character, but a ligature can be more. */
  text: string;
  /** Painted in text render mode 3, as an OCR layer over a scan is. */
  invisible: boolean;
}

/** One page's per-character geometry, plus the spans that couldn't be measured. */
export interface PageGlyphs {
  /** mcid -> its glyphs, in painting order. */
  byMcid: Map<number, GlyphBox[]>;
  /** mcid -> why that span was refused; such a span is selectable but not splittable. */
  refusals: Map<number, string>;
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

/**
 * One content leaf a Select Content rectangle picked up, and how much of it
 * the rectangle actually covered - see hitsForRect() in rect-select.js.
 */
export interface RectSelectHit {
  /** The content leaf's node id, as wrap_leaves() expects it. */
  nodeId: string;
  /** The leaf's painted runs in viewport space, one rect per text run. */
  rects: ViewportRect[];
  /** Share (0-1) of those runs' combined area inside the rectangle. */
  coverage: number;
  /** True when the leaf sits entirely inside, so it has no overhang to flag. */
  full: boolean;
  /** True when the rectangle's edges can divide this leaf exactly. */
  splittable: boolean;
  /** Per-character geometry, when the worker could measure this leaf's font. */
  glyphs: GlyphBox[] | null;
  /** The text the rectangle covers, where it can be known. */
  runText: string | null;
  /** The covered run, as offsets into the leaf's decoded text; null when there's nothing to cut by. */
  run: { startIndex: number; endIndex: number } | null;
}

/** One cell of the Select Content table grid - see table-grid.js. */
export interface TableGridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  role: 'TH' | 'TD';
}

/** What one grid cell will receive: the worker's selections, plus what the overlay draws. */
export interface TableGridCellContent {
  /** Runs to cut and place in this cell, as tag_rect_table() takes them. */
  selections: { nodeId: string; startIndex: number; endIndex: number | null }[];
  /** The text cut to fit this cell, merged per line, drawn solid. */
  outlines: ViewportRect[];
  /** Leaves taken whole whose painted extent reaches outside this cell, drawn dashed. */
  overhangs: ViewportRect[];
}

/** The Select Content table grid in progress - see table-grid.js. */
export interface TableGridState {
  phase: 'columns' | 'rows' | 'cells';
  /** The dragged rectangle: the table's outer boundary, in viewport space. */
  box: ViewportRect;
  /** Interior column dividers (x), ascending. */
  columns: number[];
  /** Interior row dividers (y), ascending. */
  rows: number[];
  /** Where the divider following the cursor would go; null when the cursor is outside the box. */
  hover: number | null;
  drag:
    | { kind: 'line'; index: number; origin: number; moved: boolean; fresh: boolean }
    | { kind: 'select'; current: number }
    | null;
  /** The cells, once the dividers are settled; null in the divider phases. */
  cells: TableGridCell[] | null;
  /** Indices into `cells`. */
  selected: Set<number>;
  /** The cell a Shift+click extends from, as an index into `cells`. */
  anchor: number | null;
  /** cell index -> what it will hold; null in the divider phases. */
  contents: Map<number, TableGridCellContent> | null;
  /** The dividers guessed from the text when the grid started - see seedGrid() in table-seed.js. */
  seed: TableGridSeed;
  /**
   * Serial of the "Try with AI" request in flight for this grid, 0 when
   * none is - a reply is applied only if the grid is still the same object
   * and the serial still matches (see tryTableGridWithAi() in table-grid.js).
   */
  aiRequest: number;
}

/** What seedGrid() in table-seed.js guesses from the text under a grid. */
export interface TableGridSeed {
  /** Guessed interior column dividers (x), ascending. */
  columns: number[];
  /** Guessed interior row dividers (y), ascending. */
  rows: number[];
  /** How many lines of text the guess came from; under 2 and nothing was guessed. */
  lineCount: number;
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
  /** page number -> Map(mcid -> painted rects), reset per document. */
  leafRectsCache: Map<number, Map<number, ViewportRect[]>>;
  /** page number -> per-character geometry from the worker, reset per document. */
  codeBoxCache: Map<number, PageGlyphs>;

  // --- editing state ----------------------------------------------------
  /** Tag edits made since the last save. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // --- panels, filtering, display --------------------------------------
  /** Which details-pane tab is showing. */
  activePanel: 'properties' | 'bookmarks';
  /** Which tag-tree-pane tab is showing. */
  treePanel: 'tree' | 'artifacts';
  /** The Artifacts tab's list, as the worker last returned it. */
  artifacts: ArtifactEntry[];
  /** The document has more artifacts than one list reports. */
  artifactsTruncated: boolean;
  /** The list needs re-reading before it can be shown again. */
  artifactsStale: boolean;
  /** Invalidates an in-flight list read superseded by a newer one. */
  artifactsToken: number;
  /** The "active" artifact; always a member of selectedArtifactIds. */
  selectedArtifactId: string | null;
  /** Full multi-selection - Tag puts all of these under one tag. */
  selectedArtifactIds: Set<string>;
  /** Fixed point shift+click range-selects from. */
  artifactAnchorId: string | null;
  /** Which tags the tree shows - see renderFilteredTree(). */
  filter: 'all' | 'headings' | 'figures' | 'lists' | 'table' | 'alt-missing' | 'empty' | 'flagged';
  /** nodeId -> explicit user toggle; absence means the role-based default. */
  collapseOverrides: Map<string, boolean>;
  /** The stored Appearance preference, which is why 'auto' is in here. The
   *  theme actually in force is the data-theme attribute on <html>; this is
   *  what the Preferences radio group reflects. */
  theme: 'auto' | 'dark' | 'light';
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

  // --- Select Content (rect-select.js) ----------------------------------
  /** True while the rubber-band content-selection tool is armed. */
  rectSelectActive: boolean;
  /** The in-progress drag, in canvas-pixel space; null when not dragging. */
  rectSelectRect: FigureDrawRect | null;
  /** What the current (or just-finished) drag covers. */
  rectSelectHits: RectSelectHit[] | null;
  /** How many leaves that drag touched but covered too little of to take. */
  rectSelectSkipped: number;
  /** Leaf ids from a finished drag, waiting on a role keystroke. */
  rectSelectPending: string[] | null;
  /** mcid -> leaf node id for the page being dragged on; built once per drag. */
  rectSelectIndex: Map<number, string> | null;
  /** 1-based page the selection belongs to; rendering any other page discards it. */
  rectSelectPage: number | null;
  /** The finished drag, in viewport space - the table grid's outer boundary. */
  rectSelectBox: ViewportRect | null;
  /** The table grid in progress over that box, or null - see table-grid.js. */
  tableGrid: TableGridState | null;

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

  /** { actionId: KeyboardEvent.key | null }, one entry per TAG_SHORTCUT_ACTIONS in state.js. */
  tagShortcuts: Record<string, string | null>;
  /** { actionId: KeyboardEvent.key | null }, one entry per PROOFREAD_SHORTCUT_ACTIONS in state.js. */
  proofreadShortcuts: Record<string, string | null>;

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
