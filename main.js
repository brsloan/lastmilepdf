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

// Prefer a project-local .venv (see README setup) if one exists - it's
// self-contained and side-steps system/user-site-packages resolution being
// unreliable on some machines. Falls back to PYTHON_BIN, then to "python"/
// "python3" on PATH.
function defaultPythonBin() {
  const venvPython = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_BIN = process.env.PYTHON_BIN || defaultPythonBin();
const WORKER_SCRIPT = path.join(__dirname, 'python', 'tag_worker.py');

let workerProcess = null;
let requestCounter = 0;
const pendingRequests = new Map(); // id -> { resolve, reject }

function startWorker() {
  // Set when the worker reports an error with no id to match against a
  // pending request (e.g. it fails at startup, before any request was
  // sent - see tag_worker.py's pikepdf import check). Surfaced as the
  // rejection reason if the process then exits, instead of the generic
  // "exited unexpectedly" message.
  let lastUnmatchedError = null;

  workerProcess = spawn(PYTHON_BIN, [WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutLines = readline.createInterface({ input: workerProcess.stdout });
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
        lastUnmatchedError = message.error;
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
  workerProcess.stderr.on('data', (chunk) => {
    console.error('[tag_worker:stderr]', chunk.toString());
  });

  workerProcess.on('exit', (code) => {
    console.error(`[tag_worker] exited with code ${code}`);
    const reason = lastUnmatchedError || 'PDF worker process exited unexpectedly.';
    for (const { reject } of pendingRequests.values()) {
      reject(new Error(reason));
    }
    pendingRequests.clear();
    workerProcess = null;
  });
}

/**
 * Send a command to the Python sidecar and resolve with its "result" field.
 * Rejects if the worker responds with an "error" field, or dies mid-request.
 */
function callWorker(cmd, params = {}) {
  if (!workerProcess) startWorker();
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- Application menu ---------------------------------------------------
//
// Undo/Redo are app-level (they revert tag edits, not text-field input) and
// live in the renderer's own state, so the Edit menu can't run them
// directly - it just forwards the command as an IPC event and lets the
// renderer's existing performUndo()/performRedo() (see renderer.js) do the
// actual work, same as the toolbar buttons and Ctrl+Z/Ctrl+Y do. No
// accelerator is set here deliberately: the renderer already binds
// Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z itself and steps aside when a text field is
// focused so native field-undo still works there - a menu accelerator
// would fire regardless of focus and bypass that.
// Save/Save As are driven the same way as Undo/Redo above: forwarded as IPC
// events to the renderer, which owns the docId and decides (via
// performSave()/performSaveAs() in renderer.js) whether Save can write
// straight to the last-used path or needs to fall back to a Save As dialog.
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (_item, win) => win?.webContents.send('menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: (_item, win) => win?.webContents.send('menu:save-as') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', click: (_item, win) => win?.webContents.send('menu:undo') },
        { label: 'Redo', click: (_item, win) => win?.webContents.send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
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
    // Base64 so it survives Electron's IPC structured-clone boundary cleanly;
    // for very large PDFs you'd want to stream this instead.
    pdfBase64: fileBuffer.toString('base64'),
  };
});

ipcMain.handle('tags:update-node', async (_event, { docId, nodeId, changes }) => {
  return callWorker('update_node', { docId, nodeId, changes });
});

ipcMain.handle('tags:reorder-node', async (_event, { docId, nodeId, newParentId, newIndex }) => {
  return callWorker('reorder', { docId, nodeId, newParentId, newIndex });
});

ipcMain.handle('tags:kill-divs', async (_event, { docId }) => {
  return callWorker('kill_divs', { docId });
});

ipcMain.handle('tags:undo', async (_event, { docId }) => {
  return callWorker('undo', { docId });
});

ipcMain.handle('tags:redo', async (_event, { docId }) => {
  return callWorker('redo', { docId });
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
