// preload.js
//
// Runs in an isolated context with access to Node/Electron APIs, but the
// renderer (index.html/renderer.js) does not get nodeIntegration - it only
// sees whatever we explicitly attach to `window.api` here. Keep this surface
// small and specific to what the UI actually needs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),

  updateNode: (docId, nodeId, changes) =>
    ipcRenderer.invoke('tags:update-node', { docId, nodeId, changes }),
  updateNodes: (docId, nodeIds, changes) =>
    ipcRenderer.invoke('tags:update-nodes', { docId, nodeIds, changes }),
  updateDocInfo: (docId, changes) =>
    ipcRenderer.invoke('doc:update-info', { docId, changes }),
  shiftHeadingLevels: (docId, nodeIds, direction) =>
    ipcRenderer.invoke('tags:shift-heading-levels', { docId, nodeIds, direction }),

  reorderNode: (docId, nodeId, newParentId, newIndex) =>
    ipcRenderer.invoke('tags:reorder-node', { docId, nodeId, newParentId, newIndex }),
  reorderMany: (docId, nodeIds, newParentId, newIndex) =>
    ipcRenderer.invoke('tags:reorder-many', { docId, nodeIds, newParentId, newIndex }),

  killDivs: (docId) => ipcRenderer.invoke('tags:kill-divs', { docId }),
  scopeTables: (docId) => ipcRenderer.invoke('tags:scope-tables', { docId }),
  deleteNodes: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:delete-nodes', { docId, nodeIds }),
  figureFromRect: (docId, pageIndex, rect) =>
    ipcRenderer.invoke('tags:figure-from-rect', { docId, pageIndex, rect }),
  insertParagraphAfter: (docId, nodeId) =>
    ipcRenderer.invoke('tags:insert-paragraph-after', { docId, nodeId }),
  setRoleOrWrap: (docId, nodeIds, role) =>
    ipcRenderer.invoke('tags:set-role-or-wrap', { docId, nodeIds, role }),
  convertToParagraph: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:convert-to-paragraph', { docId, nodeIds }),
  convertToFigure: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:convert-to-figure', { docId, nodeIds }),
  makeList: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-list', { docId, nodeIds }),
  makeTable: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-table', { docId, nodeIds }),
  makeTr: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:make-tr', { docId, nodeIds }),

  undo: (docId) => ipcRenderer.invoke('tags:undo', { docId }),
  redo: (docId) => ipcRenderer.invoke('tags:redo', { docId }),

  renameBookmark: (docId, bookmarkId, title) =>
    ipcRenderer.invoke('outline:rename-bookmark', { docId, bookmarkId, title }),
  deleteBookmark: (docId, bookmarkId) =>
    ipcRenderer.invoke('outline:delete-bookmark', { docId, bookmarkId }),
  generateBookmarks: (docId, headings) =>
    ipcRenderer.invoke('outline:generate-bookmarks', { docId, headings }),

  // Fired when the user picks Open/Undo/Redo/Save/Save As/Shortcuts/Help Doc/About from the app menu - see main.js.
  onMenuOpen: (callback) => ipcRenderer.on('menu:open', callback),
  onMenuUndo: (callback) => ipcRenderer.on('menu:undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu:redo', callback),
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),
  onMenuShortcuts: (callback) => ipcRenderer.on('menu:shortcuts', callback),
  onMenuHelpDoc: (callback) => ipcRenderer.on('menu:help-doc', callback),
  onMenuAbout: (callback) => ipcRenderer.on('menu:about', callback),

  savePdf: (docId, suggestedName) =>
    ipcRenderer.invoke('dialog:save-pdf', { docId, suggestedName }),
  saveToPath: (docId, path) =>
    ipcRenderer.invoke('tags:save-to-path', { docId, path }),

  // Releases a document the renderer has finished with, so the worker can
  // drop its pikepdf.Pdf and undo snapshots - see close_document in
  // tag_worker.py.
  closeDoc: (docId) => ipcRenderer.invoke('doc:close', { docId }),

  // Unsaved-changes plumbing (see the window-close guard in main.js):
  // the renderer pushes its dirty state up, asks for the discard prompt
  // when File > Open would replace an edited document, and reports back
  // when a save triggered by the close prompt has finished.
  setDirty: (dirty) => ipcRenderer.send('doc:dirty-changed', dirty),
  confirmDiscard: (detail) => ipcRenderer.invoke('dialog:confirm-discard', { detail }),
  onMenuSaveAndClose: (callback) => ipcRenderer.on('menu:save-and-close', callback),
  reportSaveComplete: (saved) => ipcRenderer.send('doc:save-complete', saved),
});
