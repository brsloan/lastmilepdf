// main.js
//
// Electron main process. Responsibilities:
//   1. Create the app window (renderer has no Node/fs access - see preload.js).
//   2. Own the lifetime of a single long-running Python sidecar process that
//      wraps pikepdf. We talk to it over stdin/stdout using newline-delimited
//      JSON ("JSON lines"). Keeping it alive between calls avoids paying
//      Python startup cost (and re-parsing the PDF) on every tag edit.
//   3. Expose a small set of IPC handlers that the preload script forwards
//      to the renderer as `window.api.*`.

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

// --- Python sidecar -------------------------------------------------------

// In a packaged build there's no Python interpreter on the user's machine,
// so the worker ships as a PyInstaller-compiled exe (see python/tag_worker.py
// and the "build:worker" script) under extraResources. In dev, fall back to
// a project-local .venv (see README setup) - self-contained and side-steps
// system/user-site-packages resolution being unreliable on some machines -
// then PYTHON_BIN, then "python"/"python3" on PATH.
function packagedWorkerPath() {
  const exeName = process.platform === 'win32' ? 'tag_worker.exe' : 'tag_worker';
  return path.join(process.resourcesPath, 'python', exeName);
}

function defaultPythonBin() {
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// When packaged, the worker is a standalone exe invoked directly (no script
// argument); in dev it's PYTHON_BIN running tag_worker.py.
const WORKER_COMMAND = app.isPackaged
  ? { bin: packagedWorkerPath(), args: [] }
  : { bin: process.env.PYTHON_BIN || defaultPythonBin(), args: [path.join(__dirname, 'python', 'tag_worker.py')] };

let workerProcess = null;
let requestCounter = 0;
const pendingRequests = new Map(); // id -> { resolve, reject }

// Set when the worker reports an error with no id to match against a
// pending request (e.g. it fails at startup, before any request was
// sent - see tag_worker.py's pikepdf import check), or when the process
// can't be spawned at all. Surfaced as the rejection reason instead of the
// generic "exited unexpectedly" message. Module-scoped rather than local to
// startWorker() so callWorker() can still report it once the process is
// gone and there's nothing left to attach a handler to.
let lastWorkerError = null;

function failPendingRequests(reason) {
  const error = new Error(reason);
  for (const { reject } of pendingRequests.values()) reject(error);
  pendingRequests.clear();
}

function startWorker() {
  lastWorkerError = null;

  const child = spawn(WORKER_COMMAND.bin, WORKER_COMMAND.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  workerProcess = child;

  // spawn() reports a failure to *launch* asynchronously via 'error' rather
  // than by throwing, and Node turns an 'error' event with no listener into
  // an uncaught exception - which would take the whole main process down.
  // startWorker() runs from app.whenReady() before createWindow(), so that
  // means no window and no message at all: exactly the packaged-build case
  // where tag_worker.exe didn't ship or got quarantined by antivirus.
  // Handle it and let the renderer surface it through the normal error path
  // instead. 'exit' may or may not follow an 'error', so settle whatever is
  // in flight here rather than relying on the exit handler to do it.
  child.on('error', (err) => {
    console.error('[tag_worker] failed to start:', err);
    lastWorkerError = `Could not start the PDF worker process (${err.code || err.message}). ` + (
      app.isPackaged
        ? 'The bundled tag_worker executable is missing or was blocked from running.'
        : 'Check that the .venv exists and has pikepdf installed - see the README setup steps.'
    );
    if (workerProcess === child) workerProcess = null;
    failPendingRequests(lastWorkerError);
  });

  // Writing to a worker that has already died surfaces as an EPIPE 'error'
  // on the stream as well as through write()'s callback - and an unlistened
  // 'error' on a stream is another uncaught exception. The write callback
  // and the exit handler below already reject whatever was in flight, so
  // this only needs to keep the process alive.
  child.stdin.on('error', (err) => {
    console.error('[tag_worker:stdin]', err);
  });

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      console.error('[tag_worker] sent non-JSON line:', line);
      return;
    }
    const pending = pendingRequests.get(message.id);
    if (!pending) {
      if (message.error) {
        lastWorkerError = message.error;
        console.error('[tag_worker] error with no matching request:', message.error);
      }
      return; // stray/duplicate response, ignore
    }
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  });

  // Surface Python tracebacks in the main-process console during development.
  child.stderr.on('data', (chunk) => {
    console.error('[tag_worker:stderr]', chunk.toString());
  });

  child.on('exit', (code) => {
    console.error(`[tag_worker] exited with code ${code}`);
    failPendingRequests(lastWorkerError || 'PDF worker process exited unexpectedly.');
    // Only if this is still the live worker - a restart may already have
    // put a newer process in place by the time an old one's exit lands.
    if (workerProcess === child) workerProcess = null;
  });
}

/**
 * Send a command to the Python sidecar and resolve with its "result" field.
 * Rejects if the worker responds with an "error" field, or dies mid-request.
 */
function callWorker(cmd, params = {}) {
  if (!workerProcess) startWorker();
  // A failed spawn clears workerProcess again from its own 'error' handler,
  // but that fires on a later tick - so a just-restarted worker can still be
  // a doomed process with a dead stdin right now. Reject with whatever
  // reason we have rather than writing into it.
  if (!workerProcess || !workerProcess.stdin || !workerProcess.stdin.writable) {
    return Promise.reject(new Error(lastWorkerError || 'The PDF worker process is not running.'));
  }
  const id = ++requestCounter;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    const payload = JSON.stringify({ id, cmd, ...params }) + '\n';
    workerProcess.stdin.write(payload, (err) => {
      if (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });
  });
}

// --- Window -----------------------------------------------------------------

// Whether the renderer currently holds tag edits that aren't on disk. The
// renderer owns this - it's the side that knows whether an edit has landed
// since the last save - and pushes every change here via 'doc:dirty-changed'
// so the window-close guard below can read it synchronously.
let hasUnsavedChanges = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f24',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Closing the window is the one exit that can't be intercepted from the
  // renderer, so the unsaved-changes prompt has to live here. 'close' isn't
  // an async-friendly event - returning from the handler lets the window go
  // - so this uses showMessageBoxSync rather than awaiting a promise that
  // would resolve too late to matter. "Save" can't be answered
  // synchronously either (the renderer owns the docId and the save path),
  // so it hands off to the renderer and waits for 'doc:save-complete' to
  // come back before actually destroying the window.
  win.on('close', (e) => {
    if (!hasUnsavedChanges) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'This PDF has unsaved tag changes.',
      detail: 'Save them before closing?',
    });
    if (choice === 2) return; // Cancel - stay open, keep the changes
    if (choice === 1) {
      hasUnsavedChanges = false; // Don't Save - drop them and go
      win.destroy();
      return;
    }
    win.webContents.send('menu:save-and-close');
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- Application menu ---------------------------------------------------
//
// Undo/Redo are app-level (they revert tag edits, not text-field input) and
// live in the renderer's own state, so the Edit menu can't run them
// directly - it just forwards the command as an IPC event and lets the
// renderer's existing performUndo()/performRedo() (see renderer.js) do the
// actual work, same as the toolbar buttons and Ctrl+Z/Ctrl+Y do. The
// accelerators below use registerAccelerator: false - they're shown in the
// menu for reference only and don't register as OS-level shortcuts, since
// the renderer already binds Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z itself and steps
// aside when a text field is focused so native field-undo still works
// there - a real menu accelerator would fire regardless of focus and
// bypass that.
// Open/Save/Save As are driven the same way as Undo/Redo above: forwarded
// as IPC events to the renderer, which owns the docId and does the actual
// work (performOpen()/performSave()/performSaveAs() in renderer.js) -
// Save picks between writing straight to the last-used path or falling
// back to a Save As dialog.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: (_item, win) => win?.webContents.send('menu:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (_item, win) => win?.webContents.send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: (_item, win) => win?.webContents.send('menu:save-as') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: (_item, win) => win?.webContents.send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: (_item, win) => win?.webContents.send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Shortcuts', accelerator: 'CmdOrCtrl+/', click: (_item, win) => win?.webContents.send('menu:shortcuts') },
        { label: 'Help Doc', accelerator: 'F1', click: (_item, win) => win?.webContents.send('menu:help-doc') },
        { type: 'separator' },
        { label: 'About LastMilePDF', click: (_item, win) => win?.webContents.send('menu:about', { version: app.getVersion() }) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildAppMenu());
  startWorker();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (workerProcess) workerProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC handlers -------------------------------------------------------

// Opens a native file picker, reads the chosen PDF off disk, and asks the
// Python sidecar to parse its structure tree. Returns everything the
// renderer needs to render page 1 and the tag tree in one round trip.
ipcMain.handle('dialog:open-pdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (canceled || filePaths.length === 0) return null;

  const filePath = filePaths[0];
  const fileBuffer = fs.readFileSync(filePath);

  // pikepdf needs to open the file itself (it works against the file/object
  // graph, not raw bytes we already have), so we pass the path, not the buffer.
  const openResult = await callWorker('open', { path: filePath });

  return {
    filePath,
    docId: openResult.docId,
    hasStructTree: openResult.hasStructTree,
    tree: openResult.tree, // null if hasStructTree is false
    outline: openResult.outline,
    docInfo: openResult.docInfo,
    // Base64 so it survives Electron's IPC structured-clone boundary cleanly;
    // for very large PDFs you'd want to stream this instead.
    pdfBase64: fileBuffer.toString('base64'),
  };
});

// --- unsaved-changes tracking ---------------------------------------
//
// The renderer reports its dirty state as it changes; the window-close
// guard in createWindow() reads it. 'dialog:confirm-discard' backs the
// other exit the renderer *can* intercept - File > Open replacing the
// current document - so both paths ask the same question with the same
// three answers.

ipcMain.on('doc:dirty-changed', (_event, dirty) => {
  hasUnsavedChanges = !!dirty;
});

ipcMain.handle('dialog:confirm-discard', async (event, { detail }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved changes',
    message: 'This PDF has unsaved tag changes.',
    detail,
  });
  return ['save', 'discard', 'cancel'][response];
});

// Sent by the renderer once the save triggered by the close prompt's
// "Save" button has finished, so the window can finally go. `saved` is
// false if that save failed or the user backed out of the Save As dialog -
// in which case the window stays open rather than closing over an error.
ipcMain.on('doc:save-complete', (event, saved) => {
  if (!saved) return;
  hasUnsavedChanges = false;
  BrowserWindow.fromWebContents(event.sender)?.destroy();
});

// Releases a document the renderer is done with - the worker holds a live
// pikepdf.Pdf plus its undo snapshots until told otherwise (see
// close_document in tag_worker.py).
ipcMain.handle('doc:close', async (_event, { docId }) => {
  return callWorker('close', { docId });
});

ipcMain.handle('tags:update-node', async (_event, { docId, nodeId, changes }) => {
  return callWorker('update_node', { docId, nodeId, changes });
});

ipcMain.handle('tags:update-nodes', async (_event, { docId, nodeIds, changes }) => {
  return callWorker('update_nodes', { docId, nodeIds, changes });
});

ipcMain.handle('doc:update-info', async (_event, { docId, changes }) => {
  return callWorker('update_doc_info', { docId, changes });
});

ipcMain.handle('tags:shift-heading-levels', async (_event, { docId, nodeIds, direction }) => {
  return callWorker('shift_heading_levels', { docId, nodeIds, direction });
});

ipcMain.handle('tags:reorder-node', async (_event, { docId, nodeId, newParentId, newIndex }) => {
  return callWorker('reorder', { docId, nodeId, newParentId, newIndex });
});

ipcMain.handle('tags:reorder-many', async (_event, { docId, nodeIds, newParentId, newIndex }) => {
  return callWorker('reorder_many', { docId, nodeIds, newParentId, newIndex });
});

ipcMain.handle('tags:kill-divs', async (_event, { docId }) => {
  return callWorker('kill_divs', { docId });
});

ipcMain.handle('tags:scope-tables', async (_event, { docId }) => {
  return callWorker('scope_tables', { docId });
});

ipcMain.handle('tags:delete-nodes', async (_event, { docId, nodeIds }) => {
  return callWorker('delete_nodes', { docId, nodeIds });
});

ipcMain.handle('tags:figure-from-rect', async (_event, { docId, pageIndex, rect }) => {
  return callWorker('figure_from_rect', { docId, pageIndex, rect });
});

ipcMain.handle('tags:insert-paragraph-after', async (_event, { docId, nodeId }) => {
  return callWorker('insert_paragraph_after', { docId, nodeId });
});

ipcMain.handle('tags:set-role-or-wrap', async (_event, { docId, nodeIds, role }) => {
  return callWorker('set_role_or_wrap', { docId, nodeIds, role });
});

ipcMain.handle('tags:convert-to-paragraph', async (_event, { docId, nodeIds }) => {
  return callWorker('convert_to_paragraph', { docId, nodeIds });
});

ipcMain.handle('tags:convert-to-figure', async (_event, { docId, nodeIds }) => {
  return callWorker('convert_to_figure', { docId, nodeIds });
});

ipcMain.handle('tags:make-list', async (_event, { docId, nodeIds, labelFlags }) => {
  return callWorker('make_list', { docId, nodeIds, labelFlags });
});

ipcMain.handle('tags:convert-to-list-item', async (_event, { docId, nodeIds, labelFlags }) => {
  return callWorker('convert_to_list_item', { docId, nodeIds, labelFlags });
});

ipcMain.handle('tags:make-table', async (_event, { docId, nodeIds }) => {
  return callWorker('make_table', { docId, nodeIds });
});

ipcMain.handle('tags:make-tr', async (_event, { docId, nodeIds }) => {
  return callWorker('make_tr', { docId, nodeIds });
});

ipcMain.handle('tags:undo', async (_event, { docId }) => {
  return callWorker('undo', { docId });
});

ipcMain.handle('tags:redo', async (_event, { docId }) => {
  return callWorker('redo', { docId });
});

ipcMain.handle('outline:rename-bookmark', async (_event, { docId, bookmarkId, title }) => {
  return callWorker('rename_bookmark', { docId, bookmarkId, title });
});

ipcMain.handle('outline:delete-bookmark', async (_event, { docId, bookmarkId }) => {
  return callWorker('delete_bookmark', { docId, bookmarkId });
});

ipcMain.handle('outline:generate-bookmarks', async (_event, { docId, headings }) => {
  return callWorker('generate_bookmarks', { docId, headings });
});

ipcMain.handle('dialog:save-pdf', async (_event, { docId, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save PDF As',
    defaultPath: suggestedName || 'tagged.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;

  await callWorker('save', { docId, path: filePath });
  return filePath;
});

// Re-saves to an already-known path (no dialog) - used for File > Save once
// the document has been saved at least once via Save As.
ipcMain.handle('tags:save-to-path', async (_event, { docId, path }) => {
  await callWorker('save', { docId, path });
  return path;
});
