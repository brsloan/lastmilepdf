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

  reorderNode: (docId, nodeId, newParentId, newIndex) =>
    ipcRenderer.invoke('tags:reorder-node', { docId, nodeId, newParentId, newIndex }),

  killDivs: (docId) => ipcRenderer.invoke('tags:kill-divs', { docId }),

  undo: (docId) => ipcRenderer.invoke('tags:undo', { docId }),
  redo: (docId) => ipcRenderer.invoke('tags:redo', { docId }),

  // Fired when the user picks Open/Undo/Redo/Save/Save As from the app menu - see main.js.
  onMenuOpen: (callback) => ipcRenderer.on('menu:open', callback),
  onMenuUndo: (callback) => ipcRenderer.on('menu:undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu:redo', callback),
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),

  savePdf: (docId, suggestedName) =>
    ipcRenderer.invoke('dialog:save-pdf', { docId, suggestedName }),
  saveToPath: (docId, path) =>
    ipcRenderer.invoke('tags:save-to-path', { docId, path }),
});
