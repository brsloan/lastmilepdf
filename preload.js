// preload.js
//
// Runs in an isolated context with access to Node/Electron APIs, but the
// renderer (index.html/renderer.js) does not get nodeIntegration - it only
// sees whatever we explicitly attach to `window.api` here. Keep this surface
// small and specific to what the UI actually needs.
//
// The JSDoc types below are the source of truth for `window.api` in the
// renderer: types/renderer-globals.d.ts derives that global's type from this
// object, so annotating a method here is what makes the renderer's calls to
// it checked. Run `npm run typecheck` to see the result.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * @typedef {import('./types/domain').TagNode} TagNode
 * @typedef {import('./types/domain').BookmarkNode} BookmarkNode
 * @typedef {import('./types/domain').DocInfo} DocInfo
 * @typedef {import('./types/domain').TagNodeChanges} TagNodeChanges
 * @typedef {import('./types/domain').DocInfoChanges} DocInfoChanges
 * @typedef {import('./types/domain').MutationResult} MutationResult
 * @typedef {import('./types/domain').UndoRedoResult} UndoRedoResult
 * @typedef {import('./types/domain').UndoState} UndoState
 * @typedef {import('./types/domain').OutlineResult} OutlineResult
 * @typedef {import('./types/domain').AddBookmarkResult} AddBookmarkResult
 * @typedef {import('./types/domain').OpenResult} OpenResult
 * @typedef {import('./types/domain').HeadingRef} HeadingRef
 * @typedef {import('./types/domain').AiBatchEntry} AiBatchEntry
 * @typedef {import('./types/domain').PageCrop} PageCrop
 * @typedef {import('./types/domain').FixActualTextResult} FixActualTextResult
 * @typedef {import('./types/domain').AiBatchEstimate} AiBatchEstimate
 * @typedef {import('./types/domain').DiscardChoice} DiscardChoice
 * @typedef {import('./types/domain').LeafTextResult} LeafTextResult
 * @typedef {import('./types/domain').SplitLeafResult} SplitLeafResult
 * @typedef {import('./types/domain').Script} Script
 * @typedef {import('./types/domain').UpdateState} UpdateState
 * @typedef {import('./types/domain').UpdateInfo} UpdateInfo
 * @typedef {import('./types/domain').WhatsNew} WhatsNew
 * @typedef {import('./types/domain').AgentConfig} AgentConfig
 */

// Every menu event reaches the renderer through onMenu() rather than
// ipcRenderer.on() directly, so that one switch can hold them all back while
// Claude has an editing session open (see setMenuLocked() below and
// renderer/agent.js). The window itself is locked by a modal dialog, but the
// application menu lives outside the page and would walk straight past that:
// Edit > Undo in the middle of a batch would renumber the tags Claude is
// about to name. Save is let through - writing the file never changes the
// tree, and the window-close "Save" answer has to be able to finish.
let menuLocked = false;
/** @type {(() => void) | null} */
let menuBlockedCallback = null;
const MENU_ALLOWED_WHILE_LOCKED = new Set(['menu:save', 'menu:save-and-close']);

/**
 * @param {string} channel
 * @param {(...args: any[]) => void} callback
 */
function onMenu(channel, callback) {
  ipcRenderer.on(channel, (...args) => {
    if (menuLocked && !MENU_ALLOWED_WHILE_LOCKED.has(channel)) {
      if (menuBlockedCallback) menuBlockedCallback();
      return;
    }
    callback(...args);
  });
}

const api = {
  /**
   * Shows the Open dialog and, if a file is picked, opens it in the worker.
   * @returns {Promise<OpenResult | null>} null if the user cancelled.
   */
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),
  /**
   * Opens a known path directly (File > Open Recent) - no picker. Rejects
   * (most commonly ENOENT) if the file has since been moved or deleted.
   * @param {string} filePath
   * @returns {Promise<OpenResult>}
   */
  openPdfPath: (filePath) => ipcRenderer.invoke('doc:open-path', filePath),
  /**
   * The on-disk path behind a dropped File. The renderer only ever sees a
   * File object (dataTransfer hands it nothing else), and everything that
   * opens a document here works from a path - openPdfPath() above, and the
   * worker behind it, which needs pikepdf to open the file itself. Electron
   * used to bolt a `path` property onto File for this; webUtils is its
   * replacement, and it has to be called from a context with Electron APIs,
   * which is here rather than the renderer.
   * @param {File} file
   * @returns {string} Empty for a File that isn't backed by a file on disk.
   */
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),

  /**
   * @param {string} docId
   * @param {string} nodeId
   * @param {TagNodeChanges} changes
   * @returns {Promise<MutationResult>}
   */
  updateNode: (docId, nodeId, changes) =>
    ipcRenderer.invoke('tags:update-node', { docId, nodeId, changes }),
  /**
   * Applies the same `changes` to every listed node, as one undo step.
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {TagNodeChanges} changes
   * @returns {Promise<MutationResult>}
   */
  updateNodes: (docId, nodeIds, changes) =>
    ipcRenderer.invoke('tags:update-nodes', { docId, nodeIds, changes }),
  /**
   * Sets a *different* Actual Text per node, as one undo step.
   * @param {string} docId
   * @param {Record<string, string>} updates nodeId -> new Actual Text.
   * @returns {Promise<MutationResult>}
   */
  updateActualTexts: (docId, updates) =>
    ipcRenderer.invoke('tags:update-actual-texts', { docId, updates }),
  /**
   * @param {string} docId
   * @param {DocInfoChanges} changes
   * @returns {Promise<{ docInfo: DocInfo } & UndoState>}
   */
  updateDocInfo: (docId, changes) =>
    ipcRenderer.invoke('doc:update-info', { docId, changes }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {number} direction -1 to promote (H2 -> H1), +1 to demote.
   * @returns {Promise<MutationResult>}
   */
  shiftHeadingLevels: (docId, nodeIds, direction) =>
    ipcRenderer.invoke('tags:shift-heading-levels', { docId, nodeIds, direction }),

  /**
   * @param {string} docId
   * @param {string} nodeId
   * @param {string} newParentId
   * @param {number} newIndex Position among the new parent's children.
   * @returns {Promise<MutationResult>}
   */
  reorderNode: (docId, nodeId, newParentId, newIndex) =>
    ipcRenderer.invoke('tags:reorder-node', { docId, nodeId, newParentId, newIndex }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {string} newParentId
   * @param {number} newIndex
   * @returns {Promise<MutationResult>}
   */
  reorderMany: (docId, nodeIds, newParentId, newIndex) =>
    ipcRenderer.invoke('tags:reorder-many', { docId, nodeIds, newParentId, newIndex }),

  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<import('./types/domain').FlattenResult>}
   */
  flattenTags: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:flatten-tags', { docId, nodeIds }),
  /**
   * Groups content leaves selected by a rectangle on the page preview into
   * one new tag, discarding any source tag the move leaves empty. Unlike
   * setRoleOrWrap(), the leaves may come from several different parents.
   * @param {string} docId
   * @param {string[]} nodeIds content-leaf ids, any order
   * @param {string} role
   * @returns {Promise<import('./types/domain').WrapLeavesResult>}
   */
  wrapLeaves: (docId, nodeIds, role) =>
    ipcRenderer.invoke('tags:wrap-leaves', { docId, nodeIds, role }),
  /**
   * Like wrapLeaves(), but first divides each partially covered leaf at the
   * rectangle's edges so only the covered run is tagged. One undo step.
   * @param {string} docId
   * @param {number} pageIndex 0-based
   * @param {import('./types/domain').RectSelection[]} selections
   * @param {string} role
   * @param {boolean} [useLabel] For an LI whose marker is already a piece of its own.
   * @returns {Promise<import('./types/domain').TagRectContentResult>}
   */
  tagRectContent: (docId, pageIndex, selections, role, useLabel = false) =>
    ipcRenderer.invoke('tags:tag-rect-content', { docId, pageIndex, selections, role, useLabel }),
  /**
   * Builds a Table from the grid drawn over a rectangle selection: one row
   * per entry of `rows`, holding the cells that start in it in column
   * order, each cut to the runs it covers. One undo step.
   * @param {string} docId
   * @param {number} pageIndex 0-based
   * @param {import('./types/domain').TableCellSpec[][]} rows
   * @returns {Promise<import('./types/domain').TagRectTableResult>}
   */
  tagRectTable: (docId, pageIndex, rows) =>
    ipcRenderer.invoke('tags:tag-rect-table', { docId, pageIndex, rows }),
  /**
   * @param {string} docId
   * @returns {Promise<import('./types/domain').ScopeTablesResult>}
   */
  scopeTables: (docId) => ipcRenderer.invoke('tags:scope-tables', { docId }),
  /**
   * @param {string} docId
   * @returns {Promise<import('./types/domain').RepairOrphanedContentResult>}
   */
  repairOrphanedContent: (docId) =>
    ipcRenderer.invoke('tags:repair-orphaned-content', { docId }),
  /**
   * @param {string} docId
   * @returns {Promise<import('./types/domain').OrphanedContentCount>}
   */
  countOrphanedContent: (docId) =>
    ipcRenderer.invoke('tags:count-orphaned-content', { docId }),
  /**
   * The Verify panel's document-level facts - XMP, page dictionaries,
   * annotations and content streams - that the tag tree can't answer.
   * Read-only: never dirties the document.
   * @param {string} docId
   * @returns {Promise<import('./types/domain').VerifyFacts>}
   */
  verifyDocumentFacts: (docId) =>
    ipcRenderer.invoke('tags:verify-facts', { docId }),
  /**
   * Sets /Tabs /S on every page that lacks it - the Verify panel's inline
   * fix for the tab-order check.
   * @param {string} docId
   * @returns {Promise<import('./types/domain').TabOrderResult>}
   */
  setStructureTabOrder: (docId) =>
    ipcRenderer.invoke('tags:set-tab-order', { docId }),
  /**
   * Writes the PDF/UA-1 identifier into XMP - the Verify panel's final
   * action, offered only once every other check passes.
   * @param {string} docId
   * @returns {Promise<import('./types/domain').PdfUaIdentifierResult>}
   */
  setPdfUaIdentifier: (docId) =>
    ipcRenderer.invoke('tags:set-pdfua-flag', { docId }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  deleteNodes: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:delete-nodes', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  joinTags: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:join-tags', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string} nodeId
   * @returns {Promise<LeafTextResult>}
   */
  getLeafText: (docId, nodeId) =>
    ipcRenderer.invoke('tags:get-leaf-text', { docId, nodeId }),
  /**
   * Every `/Artifact` marked-content span in the document, for the Tag Tree
   * pane's Artifacts tab. Read-only, and a whole-document content-stream
   * walk, so the panel asks for it lazily rather than after every edit.
   * @param {string} docId
   * @returns {Promise<import('./types/domain').ArtifactListResult>}
   */
  listArtifacts: (docId) =>
    ipcRenderer.invoke('tags:list-artifacts', { docId }),
  /**
   * Turns artifacts back into tagged content - the reverse of what deleting
   * a tag does to its content. Every target lands under one new tag, in
   * document order.
   * @param {string} docId
   * @param {import('./types/domain').ArtifactTarget[]} targets From listArtifacts().
   * @param {string} role Role for the new tag.
   * @returns {Promise<import('./types/domain').RestoreArtifactsResult>}
   */
  restoreArtifacts: (docId, targets, role) =>
    ipcRenderer.invoke('tags:restore-artifacts', { docId, targets, role }),
  /**
   * Per-character geometry for one page, in PDF page space - what the
   * rectangle selection needs to name a split point. Read-only.
   * @param {string} docId
   * @param {number} pageIndex 0-based
   * @returns {Promise<import('./types/domain').PageCodeBoxes>}
   */
  getPageCodeBoxes: (docId, pageIndex) =>
    ipcRenderer.invoke('tags:get-page-code-boxes', { docId, pageIndex }),
  /**
   * @param {string} docId
   * @param {string} nodeId
   * @param {number} splitIndex
   * @returns {Promise<SplitLeafResult>}
   */
  splitLeaf: (docId, nodeId, splitIndex) =>
    ipcRenderer.invoke('tags:split-leaf', { docId, nodeId, splitIndex }),
  /**
   * Claude's split_content: several leaves, each cut before the texts named.
   * @param {string} docId
   * @param {{ nodeId: string, cutBefore: string[] }[]} splits
   * @returns {Promise<import('./types/domain').SplitLeavesResult>}
   */
  splitLeaves: (docId, splits) =>
    ipcRenderer.invoke('tags:split-leaves', { docId, splits }),
  /**
   * Tags a user-drawn rectangle as a new /Figure.
   * @param {string} docId
   * @param {number} pageIndex 0-based.
   * @param {number[]} rect [x0, y0, x1, y1] in PDF default user space.
   * @returns {Promise<import('./types/domain').FigureFromRectResult>}
   */
  figureFromRect: (docId, pageIndex, rect) =>
    ipcRenderer.invoke('tags:figure-from-rect', { docId, pageIndex, rect }),
  /**
   * @param {string} docId
   * @param {string} nodeId
   * @returns {Promise<import('./types/domain').InsertResult>}
   */
  insertParagraphAfter: (docId, nodeId) =>
    ipcRenderer.invoke('tags:insert-paragraph-after', { docId, nodeId }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {string} role
   * @returns {Promise<MutationResult>}
   */
  setRoleOrWrap: (docId, nodeIds, role) =>
    ipcRenderer.invoke('tags:set-role-or-wrap', { docId, nodeIds, role }),
  /**
   * Appends a new, empty row to the end of the Table tag `tableId`.
   * @param {string} docId
   * @param {string} tableId
   * @returns {Promise<import('./types/domain').InsertResult>}
   */
  addTableRow: (docId, tableId) =>
    ipcRenderer.invoke('tags:add-table-row', { docId, tableId }),
  /**
   * Appends a new, empty column (one TD per existing row) to the Table tag `tableId`.
   * @param {string} docId
   * @param {string} tableId
   * @returns {Promise<MutationResult>}
   */
  addTableColumn: (docId, tableId) =>
    ipcRenderer.invoke('tags:add-table-column', { docId, tableId }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<import('./types/domain').ParagraphResult>}
   */
  convertToParagraph: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:convert-to-paragraph', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  convertToFigure: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:convert-to-figure', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {Record<string, boolean>} labelFlags nodeId -> whether its first leaf is a list label (Lbl).
   * @returns {Promise<import('./types/domain').ListResult>}
   */
  makeList: (docId, nodeIds, labelFlags, labelSplits = {}) =>
    ipcRenderer.invoke('tags:make-list', { docId, nodeIds, labelFlags, labelSplits }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {Record<string, boolean>} labelFlags
   * @returns {Promise<import('./types/domain').ListResult>}
   */
  convertToListItem: (docId, nodeIds, labelFlags, labelSplits = {}) =>
    ipcRenderer.invoke('tags:convert-to-list-item', { docId, nodeIds, labelFlags, labelSplits }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  makeTable: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-table', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  makeTr: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-tr', { docId, nodeIds }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @returns {Promise<MutationResult>}
   */
  makeBlockQuote: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-block-quote', { docId, nodeIds }),

  /**
   * The undo-group token the next Undo would take back, or null if that step
   * is an ordinary edit (or there is none) - see undo_owner() in
   * tag_worker.py. How Claude's "undo my session" makes sure the step on top
   * really is its own before touching it.
   * @param {string} docId
   * @returns {Promise<{ undoGroup: string | null }>}
   */
  getUndoOwner: (docId) => ipcRenderer.invoke('tags:undo-owner', { docId }),
  /**
   * @param {string} docId
   * @returns {Promise<UndoRedoResult>}
   */
  undo: (docId) => ipcRenderer.invoke('tags:undo', { docId }),
  /**
   * @param {string} docId
   * @returns {Promise<UndoRedoResult>}
   */
  redo: (docId) => ipcRenderer.invoke('tags:redo', { docId }),
  // Tells main.js whether to grey out the Edit menu's Undo/Redo items -
  // there's no toolbar button reflecting this, so the menu is it.
  /**
   * @param {UndoState} undoState
   * @returns {void}
   */
  setUndoState: (undoState) => ipcRenderer.send('menu:undo-state-changed', undoState),

  /**
   * @param {string} docId
   * @param {number} page 0-based page index.
   * @param {string} title
   * @returns {Promise<AddBookmarkResult>}
   */
  addBookmark: (docId, page, title) =>
    ipcRenderer.invoke('outline:add-bookmark', { docId, page, title }),
  /**
   * @param {string} docId
   * @param {string} bookmarkId
   * @param {string} title
   * @returns {Promise<OutlineResult>}
   */
  renameBookmark: (docId, bookmarkId, title) =>
    ipcRenderer.invoke('outline:rename-bookmark', { docId, bookmarkId, title }),
  /**
   * @param {string} docId
   * @param {string} bookmarkId
   * @returns {Promise<OutlineResult>}
   */
  deleteBookmark: (docId, bookmarkId) =>
    ipcRenderer.invoke('outline:delete-bookmark', { docId, bookmarkId }),
  /**
   * Replaces the whole outline with one built from the document's headings.
   * @param {string} docId
   * @param {HeadingRef[]} headings In document order.
   * @returns {Promise<OutlineResult>}
   */
  generateBookmarks: (docId, headings) =>
    ipcRenderer.invoke('outline:generate-bookmarks', { docId, headings }),

  // Fired when the user picks Open/Undo/Redo/Save/Save As/Close/Find-Replace/Shortcuts/Help Doc/About from the app menu - see main.js.
  /** @param {() => void} callback */
  onMenuOpen: (callback) => onMenu('menu:open', callback),
  /** Fired when a File > Open Recent entry is clicked, with its path.
   * @param {(event: unknown, filePath: string) => void} callback */
  onMenuOpenRecent: (callback) => onMenu('menu:open-recent', callback),
  /** @param {() => void} callback */
  onMenuUndo: (callback) => onMenu('menu:undo', callback),
  /** @param {() => void} callback */
  onMenuRedo: (callback) => onMenu('menu:redo', callback),
  /** @param {() => void} callback */
  onMenuSave: (callback) => onMenu('menu:save', callback),
  /** @param {() => void} callback */
  onMenuSaveAs: (callback) => onMenu('menu:save-as', callback),
  /** @param {() => void} callback */
  onMenuClose: (callback) => onMenu('menu:close', callback),
  /** @param {() => void} callback */
  onMenuFindReplace: (callback) => onMenu('menu:find-replace', callback),
  /** @param {() => void} callback */
  onMenuRepairOrphanedContent: (callback) => onMenu('menu:repair-orphaned-content', callback),
  /** @param {(event: unknown, checked: boolean) => void} callback */
  onMenuShowAtChanges: (callback) => onMenu('menu:show-at-changes', callback),
  /**
   * Tells the main process the renderer has turned Show AT Changes on or off
   * by itself, so the View menu's checkbox follows - Proofread Mode does this
   * at both ends (see setProofreadMode() in proofread.js). One-way, like
   * setUndoState() above.
   * @param {boolean} checked
   * @returns {void}
   */
  setMenuShowAtChangesChecked: (checked) => ipcRenderer.send('menu:show-at-changes-state-changed', { checked }),

  /**
   * The same, for the View menu's Proofread Mode checkbox - sent whenever the
   * renderer enters or leaves that mode on its own rather than from a click on
   * the item, which reopening a document left in the mode does.
   * @param {boolean} checked
   */
  setMenuProofreadChecked: (checked) => ipcRenderer.send('menu:proofread-state-changed', { checked }),
  /** @param {(event: unknown, checked: boolean) => void} callback */
  onMenuProofread: (callback) => onMenu('menu:proofread', callback),
  /** @param {() => void} callback */
  onMenuQuickstart: (callback) => onMenu('menu:quickstart', callback),
  /** @param {() => void} callback */
  onMenuOpenQuickstartPdf: (callback) => onMenu('menu:open-quickstart-pdf', callback),

  // The bundled quick-start PDF. It ships read-only inside the app, so main.js
  // hands back a copy in the user data folder instead - a document that can be
  // edited and saved like any other, which is half its point.
  // takeQuickstartPdf() is asked once as the renderer boots and answers with a
  // path only on a first run, so the tutorial opens itself once and never
  // again; getQuickstartPdf() is the Help > Open Quickstart PDF path and
  // always answers.
  /** @returns {Promise<string | null>} */
  takeQuickstartPdf: () => ipcRenderer.invoke('quickstart:take-pdf'),
  /** @returns {Promise<string>} */
  getQuickstartPdf: () => ipcRenderer.invoke('quickstart:get-pdf'),
  /** @param {() => void} callback */
  onMenuShortcuts: (callback) => onMenu('menu:shortcuts', callback),
  /** @param {() => void} callback */
  onMenuHelpDoc: (callback) => onMenu('menu:help-doc', callback),
  /** @param {(event: unknown, data: { version: string }) => void} callback */
  onMenuAbout: (callback) => onMenu('menu:about', callback),

  /**
   * Shows the Save As dialog and writes the document there.
   * @param {string} docId
   * @param {string} [suggestedName]
   * @returns {Promise<string | null>} The path written, or null if cancelled.
   */
  savePdf: (docId, suggestedName) =>
    ipcRenderer.invoke('dialog:save-pdf', { docId, suggestedName }),
  /**
   * @param {string} docId
   * @param {string} path
   * @returns {Promise<string>} The path written.
   */
  saveToPath: (docId, path) =>
    ipcRenderer.invoke('tags:save-to-path', { docId, path }),

  // BYOK Anthropic API key for "Fix with AI" - stored encrypted in main.js
  // (see the settings:* handlers); the renderer never holds the raw key.
  /** @returns {Promise<boolean>} */
  hasApiKey: () => ipcRenderer.invoke('settings:has-api-key'),
  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  setApiKey: (key) => ipcRenderer.invoke('settings:set-api-key', { key }),
  /** @returns {Promise<void>} */
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),

  // Which provider "Fix with AI" currently calls - 'anthropic' (default), or
  // any other provider id the renderer's Settings dialog defines (a named
  // preset like 'openai'/'purdue-genai', or 'custom' for a manually-entered
  // endpoint) - main.js treats every non-'anthropic' value the same way (a
  // generic OpenAI-compatible call) and doesn't need to know the specific
  // id. See the settings:*-provider* handlers and getAiProvider() in main.js.
  /** @returns {Promise<string>} */
  getAiProvider: () => ipcRenderer.invoke('settings:get-ai-provider'),
  /**
   * @param {string} provider
   * @returns {Promise<void>}
   */
  setAiProvider: (provider) => ipcRenderer.invoke('settings:set-ai-provider', { provider }),

  // Per-provider BYOK key + endpoint config - keyed by the same provider id
  // as getAiProvider() above, so e.g. OpenAI and a "Custom" endpoint each
  // remember their own key/config instead of sharing one slot. Same
  // encrypted-key handling as the Anthropic key above; baseUrl/model are
  // stored in plain text since they aren't secret.
  /** @param {string} providerId @returns {Promise<boolean>} */
  hasCustomApiKey: (providerId) => ipcRenderer.invoke('settings:has-custom-api-key', { providerId }),
  /**
   * @param {string} providerId
   * @param {string} key
   * @returns {Promise<void>}
   */
  setCustomApiKey: (providerId, key) => ipcRenderer.invoke('settings:set-custom-api-key', { providerId, key }),
  /** @param {string} providerId @returns {Promise<void>} */
  clearCustomApiKey: (providerId) => ipcRenderer.invoke('settings:clear-custom-api-key', { providerId }),
  /** @param {string} providerId @returns {Promise<{ baseUrl: string, model: string }>} */
  getCustomProviderConfig: (providerId) => ipcRenderer.invoke('settings:get-custom-provider-config', { providerId }),
  /**
   * @param {string} providerId
   * @param {string} baseUrl
   * @param {string} model
   * @returns {Promise<void>}
   */
  setCustomProviderConfig: (providerId, baseUrl, model) =>
    ipcRenderer.invoke('settings:set-custom-provider-config', { providerId, baseUrl, model }),

  /** @param {() => void} callback */
  onMenuSettings: (callback) => onMenu('menu:settings', callback),

  /** @param {() => void} callback */
  onMenuPreferences: (callback) => onMenu('menu:preferences', callback),

  /** @param {() => void} callback */
  onMenuDesktopAgents: (callback) => onMenu('menu:desktop-agents', callback),

  // File > Settings > Preferences > Appearance - the color theme. The stored
  // preference is 'auto' | 'dark' | 'light'; the *resolved* theme is one of
  // the last two, with 'auto' collapsed against the OS setting in main.js.
  // A settings.json still holding the retired 'accessible' is mapped onto
  // 'light' there too, so it never reaches this bridge.
  //
  // sendSync is deliberate and used nowhere else: theme-boot.js needs the
  // answer before the body is parsed, and invoke() cannot deliver it that
  // early - a promise resolves after the first paint, which is exactly the
  // dark flash this avoids. It blocks the renderer for one settings.json
  // read, once per launch.
  /** @returns {'dark' | 'light'} */
  getResolvedThemeSync: () => ipcRenderer.sendSync('settings:get-resolved-theme-sync'),
  /** @returns {Promise<'auto' | 'dark' | 'light'>} */
  getTheme: () => ipcRenderer.invoke('settings:get-theme'),
  /** Returns the resolved theme to stamp on <html>.
   *  @param {'auto' | 'dark' | 'light'} value
   *  @returns {Promise<'dark' | 'light'>} */
  setTheme: (value) => ipcRenderer.invoke('settings:set-theme', { value }),
  /** Fires when the OS light/dark setting changes while the preference is
   *  'auto'. @param {(event: unknown, resolved: string) => void} callback */
  onThemeChanged: (callback) => ipcRenderer.on('theme:changed', callback),

  // File > Settings > Preferences > Show Tag Type Label - persisted in
  // settings.json (see main.js) so it's remembered between sessions.
  /** @returns {Promise<boolean>} */
  getShowTagTypeLabel: () => ipcRenderer.invoke('settings:get-show-tag-type-label'),
  /** @param {boolean} value @returns {Promise<void>} */
  setShowTagTypeLabel: (value) => ipcRenderer.invoke('settings:set-show-tag-type-label', { value }),

  // File > Settings > Preferences - desktop notification / chime when an
  // AI batch operation (e.g. "Fix All Actual Text") finishes. Persisted in
  // settings.json the same way as Show Tag Type Label above.
  /** @returns {Promise<boolean>} */
  getNotifyDesktop: () => ipcRenderer.invoke('settings:get-notify-desktop'),
  /** @param {boolean} value @returns {Promise<void>} */
  setNotifyDesktop: (value) => ipcRenderer.invoke('settings:set-notify-desktop', { value }),
  /** @returns {Promise<boolean>} */
  getNotifyChime: () => ipcRenderer.invoke('settings:get-notify-chime'),
  /** @param {boolean} value @returns {Promise<void>} */
  setNotifyChime: (value) => ipcRenderer.invoke('settings:set-notify-chime', { value }),

  // File > Settings > Preferences - an extra physical key (KeyboardEvent.code,
  // e.g. "CapsLock") that also triggers the Tag Tree/Bookmarks Delete
  // shortcut, so it can be pressed with the opposite hand from the arrow
  // keys used to step through the tree. Persisted the same way as the
  // settings above.
  /** @returns {Promise<string | null>} */
  getExtraDeleteKeyCode: () => ipcRenderer.invoke('settings:get-extra-delete-key-code'),
  /** @param {string | null} value @returns {Promise<void>} */
  setExtraDeleteKeyCode: (value) => ipcRenderer.invoke('settings:set-extra-delete-key-code', { value }),

  // File > Settings > Preferences - per-action keyboard shortcuts for the Tag
  // Tree's role-conversion shortcuts (1-6/P/L/I/T/R/D/H/F/C/J) and for
  // Proofread Mode's previous/next-tag step (Page Up/Page Down). Each is a
  // plain { actionId: KeyboardEvent.key | null } map, keyed by the action ids
  // in TAG_SHORTCUT_ACTIONS/PROOFREAD_SHORTCUT_ACTIONS (state.js). Persisted
  // the same way as the settings above.
  /** @returns {Promise<Record<string, string>>} */
  getTagShortcuts: () => ipcRenderer.invoke('settings:get-tag-shortcuts'),
  /** @param {Record<string, string | null>} value @returns {Promise<void>} */
  setTagShortcuts: (value) => ipcRenderer.invoke('settings:set-tag-shortcuts', { value }),
  /** @returns {Promise<Record<string, string>>} */
  getProofreadShortcuts: () => ipcRenderer.invoke('settings:get-proofread-shortcuts'),
  /** @param {Record<string, string | null>} value @returns {Promise<void>} */
  setProofreadShortcuts: (value) => ipcRenderer.invoke('settings:set-proofread-shortcuts', { value }),

  // The view settings Proofread Mode remembers between reading sessions -
  // Show AT Changes and the tree filter, as one { showAtChanges, filter }
  // object. null means nothing has been logged yet, which is what puts the
  // mode on its own defaults instead. Written by using the mode rather than
  // by a Preferences control; persisted the same way as the settings above.
  /** @returns {Promise<{ showAtChanges?: unknown, filter?: unknown } | null>} */
  getProofreadViewPrefs: () => ipcRenderer.invoke('settings:get-proofread-view-prefs'),
  /** @param {{ showAtChanges: boolean, filter: string }} value @returns {Promise<void>} */
  setProofreadViewPrefs: (value) => ipcRenderer.invoke('settings:set-proofread-view-prefs', { value }),

  // Where the user was in a given PDF the last time they had it open - the
  // selected tag, which tags were expanded, the tag tree's scroll position
  // and the preview's page - keyed by file path, so reopening a document
  // picks up where the last session left it. Written by using the app rather
  // than by a Preferences control; persisted the same way as the settings
  // above, and validated on the way back in by the renderer (view-memory.js),
  // since what makes a record still valid is whether the document's tag ids
  // still mean the same tags. Passing null as `view` forgets the file.
  /** @param {string} filePath @returns {Promise<Record<string, unknown> | null>} */
  getFileViewState: (filePath) => ipcRenderer.invoke('settings:get-file-view-state', { filePath }),
  /** @param {string} filePath @param {Record<string, unknown> | null} view @returns {Promise<void>} */
  setFileViewState: (filePath, view) => ipcRenderer.invoke('settings:set-file-view-state', { filePath, view }),

  // File > Settings > Preferences - periodically save the open document to
  // disk automatically, in addition to an explicit Save. Persisted the same
  // way as the settings above.
  /** @returns {Promise<boolean>} */
  getAutoSaveEnabled: () => ipcRenderer.invoke('settings:get-auto-save-enabled'),
  /** @param {boolean} value @returns {Promise<void>} */
  setAutoSaveEnabled: (value) => ipcRenderer.invoke('settings:set-auto-save-enabled', { value }),

  // File > Settings > Preferences - whether to silently check GitHub for a
  // newer release on launch. Persisted the same way as the settings above.
  // Doesn't affect Help > About's own "Check for Updates" button, which
  // always works regardless of this setting.
  /** @returns {Promise<boolean>} */
  getAutoCheckUpdates: () => ipcRenderer.invoke('settings:get-auto-check-updates'),
  /** @param {boolean} value @returns {Promise<void>} */
  setAutoCheckUpdates: (value) => ipcRenderer.invoke('settings:set-auto-check-updates', { value }),

  // File > Settings > Desktop Agents - the local MCP server
  // in lib/agent-server.js. Both calls answer with the server's whole state,
  // so the panel redraws from one shape whether it asked or changed it.
  /** @returns {Promise<AgentConfig>} */
  getAgentConfig: () => ipcRenderer.invoke('agent:get-config'),
  /** @param {boolean} value @returns {Promise<AgentConfig>} */
  setAgentEnabled: (value) => ipcRenderer.invoke('agent:set-enabled', { value }),
  /** The "Fix this PDF" instructions; null resets them to the default. @param {string | null} value @returns {Promise<AgentConfig>} */
  setAgentFixPrompt: (value) => ipcRenderer.invoke('agent:set-fix-prompt', { value }),
  /**
   * A tool call from Claude that needs the window to answer it - see
   * renderer/agent.js. Every request must be answered with agentReply()
   * carrying the same id, or main.js times it out.
   * @param {(event: unknown, request: { id: number, method: string, params: object }) => void} callback
   */
  onAgentRequest: (callback) => ipcRenderer.on('agent:request', callback),
  /** @param {{ id: number, result?: unknown, error?: string }} reply */
  agentReply: (reply) => ipcRenderer.send('agent:reply', reply),
  /**
   * Holds back every menu command except Save while Claude is editing - see
   * onMenu() above.
   * @param {boolean} locked
   */
  setMenuLocked: (locked) => { menuLocked = locked === true; },
  /**
   * Makes every edit from now until it is cleared one undo step - Claude's
   * editing session. Sent on the same ordered channel as the edits
   * themselves, so an edit issued before this call is never grouped and one
   * issued after it always is.
   * @param {string | null} token null ends the group.
   */
  setUndoGroup: (token) => ipcRenderer.send('agent:set-undo-group', token),
  /** Called when a menu command was held back, so the renderer can say why nothing happened.
   * @param {() => void} callback */
  onMenuBlocked: (callback) => { menuBlockedCallback = callback; },

  // Help > About's update UI. getUpdateInfo() is what the dialog reads on
  // open (whether checking is even possible, portable vs. installed build,
  // and whatever the most recent check already found); the four calls
  // below drive the actual flow, whose results arrive via onUpdateState
  // rather than these calls' own return values - see main.js's Auto-update
  // section for why (checkForUpdates() resolves once the request is sent,
  // not once the answer is known).
  /** @returns {Promise<UpdateInfo>} */
  getUpdateInfo: () => ipcRenderer.invoke('updates:get-info'),
  /** @returns {Promise<void>} */
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  /** @returns {Promise<void>} */
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  /** Quits and installs the already-downloaded update. @returns {Promise<void>} */
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  /** Portable build only - opens the release page instead of downloading in place. @returns {Promise<void>} */
  openReleasePage: () => ipcRenderer.invoke('updates:open-release-page'),
  /** @param {(event: unknown, state: UpdateState) => void} callback */
  onUpdateState: (callback) => ipcRenderer.on('update:state', callback),

  // What's New - the changelog entries for the version now running. The
  // renderer calls takeWhatsNew() once as it boots: main.js hands back a
  // summary only on the first launch after an update, and only to whichever
  // window asks first, so the dialog appears once rather than every launch
  // or once per window. getWhatsNew() is the Help > What's New path, which
  // answers any time and always describes the running version.
  /** @returns {Promise<WhatsNew | null>} */
  takeWhatsNew: () => ipcRenderer.invoke('whats-new:take'),
  /** @returns {Promise<WhatsNew>} */
  getWhatsNew: () => ipcRenderer.invoke('whats-new:get'),
  /** @param {() => void} callback */
  onMenuWhatsNew: (callback) => onMenu('menu:whats-new', callback),

  /** @param {() => void} callback */
  onMenuScripts: (callback) => onMenu('menu:scripts', callback),

  // Tools > Scripts… - saved scripts and which one (if any) the toolbar's
  // "Run Script" button currently triggers. Persisted in settings.json the
  // same way as the settings above.
  /** @returns {Promise<Script[]>} */
  getScripts: () => ipcRenderer.invoke('scripts:get'),
  /** @param {Script[]} scripts @returns {Promise<void>} */
  setScripts: (scripts) => ipcRenderer.invoke('scripts:set', { scripts }),
  /** @returns {Promise<string | null>} */
  getActiveScriptId: () => ipcRenderer.invoke('scripts:get-active'),
  /** @param {string | null} id @returns {Promise<void>} */
  setActiveScriptId: (id) => ipcRenderer.invoke('scripts:set-active', { id }),

  /**
   * @param {string} text
   * @param {PageCrop[]} [images] Crops of the page region(s) the text was
   *   read from (see renderer/page-crop.js), for the model to check the OCR
   *   against. Empty or omitted sends the text alone.
   * @returns {Promise<FixActualTextResult>}
   */
  fixActualText: (text, images = []) => ipcRenderer.invoke('ai:fix-actual-text', { text, images }),
  /**
   * Writes alt text for a Figure or Formula from crop(s) of the page region
   * it covers (see renderer/page-crop.js). The image is the whole input
   * here, so unlike fixActualText() there is no text-only fallback - an
   * empty `images` is rejected, as is a provider that won't take images.
   * @param {PageCrop[]} images
   * @param {string} role The tag's role - picks between describing a figure
   *   and reading a formula aloud.
   * @returns {Promise<string>} The suggested alt text.
   */
  describeForAltText: (images, role) => ipcRenderer.invoke('ai:describe-for-alt-text', { images, role }),
  /**
   * Asks the AI to lay out the table under a Select Content grid from an
   * image of the box and the words in it (see tryTableGridWithAi() in
   * renderer/table-grid.js). Like describeForAltText() the image is
   * essential - a provider that won't take one is an error, not a fallback.
   * @param {PageCrop} image
   * @param {import('./types/domain').TableLayoutWord[]} words
   * @returns {Promise<import('./types/domain').TableLayoutProposal>}
   */
  layoutTableWithAi: (image, words) => ipcRenderer.invoke('ai:layout-table', { image, words }),
  /**
   * @param {AiBatchEntry[]} items
   * @returns {Promise<AiBatchEntry[]>} One entry per input id, same ids.
   */
  fixActualTextBatch: (items) => ipcRenderer.invoke('ai:fix-actual-text-batch', { items }),
  /**
   * @param {number} chars Size of the JSON payload the batch will send.
   * @returns {Promise<AiBatchEstimate | null>} null when there is no timing history yet.
   */
  estimateAiBatchTime: (chars) => ipcRenderer.invoke('ai:estimate-batch-time', { chars }),

  // Releases a document the renderer has finished with, so the worker can
  // drop its pikepdf.Pdf and undo snapshots - see close_document in
  // tag_worker.py.
  /**
   * @param {string} docId
   * @returns {Promise<void>}
   */
  closeDoc: (docId) => ipcRenderer.invoke('doc:close', { docId }),

  // Unsaved-changes plumbing (see the window-close guard in main.js):
  // the renderer pushes its dirty state up, asks for the discard prompt
  // when File > Open would replace an edited document, and reports back
  // when a save triggered by the close prompt has finished.
  /**
   * @param {boolean} dirty
   * @returns {void}
   */
  setDirty: (dirty) => ipcRenderer.send('doc:dirty-changed', dirty),
  /**
   * @param {string} detail Shown under the prompt's main message.
   * @returns {Promise<DiscardChoice>}
   */
  confirmDiscard: (detail) => ipcRenderer.invoke('dialog:confirm-discard', { detail }),
  /** @param {() => void} callback */
  onMenuSaveAndClose: (callback) => onMenu('menu:save-and-close', callback),
  /**
   * @param {boolean} saved Whether the save actually completed.
   * @returns {void}
   */
  reportSaveComplete: (saved) => ipcRenderer.send('doc:save-complete', saved),
};

contextBridge.exposeInMainWorld('api', api);

// Type-only export. Nothing requires() this at runtime - the renderer reaches
// the object above through contextBridge, not through Node's module system -
// but it lets types/renderer-globals.d.ts derive the type of `window.api`
// straight from this object, so the two can't drift apart. Adding or renaming
// a method here updates what the renderer is checked against automatically.
module.exports = { api };
