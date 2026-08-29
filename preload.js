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
  setRoleOrWrap: (docId, nodeIds, role) =>
    ipcRenderer.invoke('tags:set-role-or-wrap', { docId, nodeIds, role }),
  convertToParagraph: (docId, nodeIds) =>
    ipcRenderer.invoke('tags:convert-to-paragraph', { docId, nodeIds }),
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

  // Fired when the user picks Open/Undo/Redo/Save/Save As/Shortcuts from the app menu - see main.js.
  onMenuOpen: (callback) => ipcRenderer.on('menu:open', callback),
  onMenuUndo: (callback) => ipcRenderer.on('menu:undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu:redo', callback),
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),
  onMenuShortcuts: (callback) => ipcRenderer.on('menu:shortcuts', callback),

  savePdf: (docId, suggestedName) =>
    ipcRenderer.invoke('dialog:save-pdf', { docId, suggestedName }),
  saveToPath: (docId, path) =>
    ipcRenderer.invoke('tags:save-to-path', { docId, path }),
});
