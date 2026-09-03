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

const { contextBridge, ipcRenderer } = require('electron');

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
 * @typedef {import('./types/domain').AiBatchEstimate} AiBatchEstimate
 * @typedef {import('./types/domain').DiscardChoice} DiscardChoice
 * @typedef {import('./types/domain').LeafTextResult} LeafTextResult
 * @typedef {import('./types/domain').SplitLeafResult} SplitLeafResult
 * @typedef {import('./types/domain').Script} Script
 */

const api = {
  /**
   * Shows the Open dialog and, if a file is picked, opens it in the worker.
   * @returns {Promise<OpenResult | null>} null if the user cancelled.
   */
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),

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
   * @param {string} docId
   * @returns {Promise<import('./types/domain').ScopeTablesResult>}
   */
  scopeTables: (docId) => ipcRenderer.invoke('tags:scope-tables', { docId }),
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
   * @param {string} docId
   * @param {string} nodeId
   * @param {number} splitIndex
   * @returns {Promise<SplitLeafResult>}
   */
  splitLeaf: (docId, nodeId, splitIndex) =>
    ipcRenderer.invoke('tags:split-leaf', { docId, nodeId, splitIndex }),
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
   * @returns {Promise<MutationResult>}
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
   * @returns {Promise<MutationResult>}
   */
  makeList: (docId, nodeIds, labelFlags) =>
    ipcRenderer.invoke('tags:make-list', { docId, nodeIds, labelFlags }),
  /**
   * @param {string} docId
   * @param {string[]} nodeIds
   * @param {Record<string, boolean>} labelFlags
   * @returns {Promise<MutationResult>}
   */
  convertToListItem: (docId, nodeIds, labelFlags) =>
    ipcRenderer.invoke('tags:convert-to-list-item', { docId, nodeIds, labelFlags }),
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
  onMenuOpen: (callback) => ipcRenderer.on('menu:open', callback),
  /** @param {() => void} callback */
  onMenuUndo: (callback) => ipcRenderer.on('menu:undo', callback),
  /** @param {() => void} callback */
  onMenuRedo: (callback) => ipcRenderer.on('menu:redo', callback),
  /** @param {() => void} callback */
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  /** @param {() => void} callback */
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),
  /** @param {() => void} callback */
  onMenuClose: (callback) => ipcRenderer.on('menu:close', callback),
  /** @param {() => void} callback */
  onMenuFindReplace: (callback) => ipcRenderer.on('menu:find-replace', callback),
  /** @param {(event: unknown, checked: boolean) => void} callback */
  onMenuShowAtChanges: (callback) => ipcRenderer.on('menu:show-at-changes', callback),
  /** @param {(event: unknown, checked: boolean) => void} callback */
  onMenuProofread: (callback) => ipcRenderer.on('menu:proofread', callback),
  /** @param {() => void} callback */
  onMenuShortcuts: (callback) => ipcRenderer.on('menu:shortcuts', callback),
  /** @param {() => void} callback */
  onMenuHelpDoc: (callback) => ipcRenderer.on('menu:help-doc', callback),
  /** @param {(event: unknown, data: { version: string }) => void} callback */
  onMenuAbout: (callback) => ipcRenderer.on('menu:about', callback),

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
  onMenuSettings: (callback) => ipcRenderer.on('menu:settings', callback),

  /** @param {() => void} callback */
  onMenuPreferences: (callback) => ipcRenderer.on('menu:preferences', callback),

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

  // File > Settings > Preferences - periodically save the open document to
  // disk automatically, in addition to an explicit Save. Persisted the same
  // way as the settings above.
  /** @returns {Promise<boolean>} */
  getAutoSaveEnabled: () => ipcRenderer.invoke('settings:get-auto-save-enabled'),
  /** @param {boolean} value @returns {Promise<void>} */
  setAutoSaveEnabled: (value) => ipcRenderer.invoke('settings:set-auto-save-enabled', { value }),

  /** @param {() => void} callback */
  onMenuScripts: (callback) => ipcRenderer.on('menu:scripts', callback),

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
   * @returns {Promise<string>} The corrected text.
   */
  fixActualText: (text) => ipcRenderer.invoke('ai:fix-actual-text', { text }),
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
  onMenuSaveAndClose: (callback) => ipcRenderer.on('menu:save-and-close', callback),
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
