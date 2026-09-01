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

const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const { Anthropic } = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');

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
  child.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
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

// --- Settings (AI provider + API keys) --------------------------------------
//
// BYOK (bring your own key): "Fix with AI" (see the ai:fix-actual-text
// handler below) calls an AI provider directly with a key the user supplies
// and pays for themselves - this app never holds or proxies a shared key.
// Two provider slots exist side by side: the built-in Anthropic one, and a
// single "custom" slot for any OpenAI chat-completions-compatible endpoint
// (e.g. a university-hosted service) - a base URL, an API key, and a model
// name the user supplies. `aiProvider` in settings.json picks which slot the
// AI handlers below read from at request time; switching the selector
// doesn't discard the other slot's saved values. Every key is encrypted at
// rest via Electron's safeStorage (OS keychain/DPAPI-backed) and stored
// alongside a small settings.json in the user's data dir; only main.js ever
// touches a decrypted value, since the renderer has no Node access and
// shouldn't need to.

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettingsFile(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function hasStoredApiKey() {
  return typeof readSettingsFile().anthropicApiKey === 'string';
}

function getStoredApiKey() {
  const encrypted = readSettingsFile().anthropicApiKey;
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (err) {
    console.error('[settings] failed to decrypt stored API key:', err);
    return null;
  }
}

function setStoredApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system has no OS-level credential store available to encrypt the key.');
  }
  const settings = readSettingsFile();
  settings.anthropicApiKey = safeStorage.encryptString(key).toString('base64');
  writeSettingsFile(settings);
}

function clearStoredApiKey() {
  const settings = readSettingsFile();
  delete settings.anthropicApiKey;
  writeSettingsFile(settings);
}

function getAiProvider() {
  return readSettingsFile().aiProvider === 'custom' ? 'custom' : 'anthropic';
}

function setAiProvider(provider) {
  const settings = readSettingsFile();
  settings.aiProvider = provider === 'custom' ? 'custom' : 'anthropic';
  writeSettingsFile(settings);
}

function hasStoredCustomApiKey() {
  return typeof readSettingsFile().customApiKey === 'string';
}

function getStoredCustomApiKey() {
  const encrypted = readSettingsFile().customApiKey;
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (err) {
    console.error('[settings] failed to decrypt stored custom API key:', err);
    return null;
  }
}

function setStoredCustomApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system has no OS-level credential store available to encrypt the key.');
  }
  const settings = readSettingsFile();
  settings.customApiKey = safeStorage.encryptString(key).toString('base64');
  writeSettingsFile(settings);
}

function clearStoredCustomApiKey() {
  const settings = readSettingsFile();
  delete settings.customApiKey;
  writeSettingsFile(settings);
}

// Base URL + model for the custom provider - not secret, so stored in plain
// text in settings.json alongside (but separate from) its encrypted API key.
function getCustomProviderConfig() {
  const settings = readSettingsFile();
  return {
    baseUrl: typeof settings.customBaseUrl === 'string' ? settings.customBaseUrl : '',
    model: typeof settings.customModel === 'string' ? settings.customModel : '',
  };
}

function setCustomProviderConfig(baseUrl, model) {
  const settings = readSettingsFile();
  settings.customBaseUrl = baseUrl;
  settings.customModel = model;
  writeSettingsFile(settings);
}

// Whether the PDF preview labels a selected tag's role above its highlight
// box (File > Settings > Appearance). Persisted in the same settings.json as
// the API key so the checkbox's initial `checked` state (set when the menu
// is built, before the renderer has loaded) is already correct.
function getShowTagTypeLabel() {
  return readSettingsFile().showTagTypeLabel !== false; // default on
}

function setShowTagTypeLabel(value) {
  const settings = readSettingsFile();
  settings.showTagTypeLabel = value;
  writeSettingsFile(settings);
}

// Whether finishing an AI batch operation (e.g. "Fix All Actual Text") pops
// a desktop notification / plays a chime (File > Settings > Notifications).
// Persisted the same way as showTagTypeLabel above, for the same reason -
// the menu checkboxes need their initial `checked` state before the
// renderer has loaded.
function getNotifyDesktop() {
  return readSettingsFile().notifyDesktop !== false; // default on
}

function setNotifyDesktop(value) {
  const settings = readSettingsFile();
  settings.notifyDesktop = value;
  writeSettingsFile(settings);
}

function getNotifyChime() {
  return readSettingsFile().notifyChime !== false; // default on
}

function setNotifyChime(value) {
  const settings = readSettingsFile();
  settings.notifyChime = value;
  writeSettingsFile(settings);
}

// --- AI batch timing log ----------------------------------------------------
//
// Lets the "Fix All Actual Text" progress dialog (see showAiBatchProgress()
// in renderer.js) show an upfront time estimate instead of just a generic
// "this may take a few minutes". Kept in its own file rather than
// settings.json since it's an operational log, not a user preference. Each
// entry is just {chars, ms, provider} for one completed batch request - no
// filenames, document content, or other identifying info - so the log can't
// leak anything about what a user has been editing. `provider` keys entries
// by which AI provider produced them (see getAiProvider() above) so a custom
// endpoint's speed - which can be wildly different from Anthropic's, e.g. a
// smaller self-hosted model - doesn't skew estimates for the other provider.
// Entries logged before the provider field existed have no `provider`, and
// are treated as 'anthropic' (see estimateAiBatchRange() below), since that
// was the only provider at the time.

const AI_BATCH_LOG_PATH = path.join(app.getPath('userData'), 'ai-batch-log.json');
const AI_BATCH_LOG_MAX_ENTRIES = 50; // recent-history average, not a lifetime total

function readAiBatchLog() {
  try {
    const log = JSON.parse(fs.readFileSync(AI_BATCH_LOG_PATH, 'utf8'));
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

function recordAiBatchTiming(chars, ms, provider) {
  try {
    const log = readAiBatchLog();
    log.push({ chars, ms, provider });
    while (log.length > AI_BATCH_LOG_MAX_ENTRIES) log.shift();
    fs.mkdirSync(path.dirname(AI_BATCH_LOG_PATH), { recursive: true });
    fs.writeFileSync(AI_BATCH_LOG_PATH, JSON.stringify(log));
  } catch (err) {
    console.error('[ai-batch-log] failed to record timing:', err);
  }
}

// Interpolated quantile (q in [0, 1]) over an already-sorted array.
function quantile(sortedValues, q) {
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sortedValues[base + 1] === undefined
    ? sortedValues[base]
    : sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
}

// A {lowMs, highMs} range scaled to the requested size, or null with no
// history yet, so the caller can fall back to a generic hint instead of
// showing a made-up number. Uses the median ms/char rather than the mean -
// one unusually slow or fast run (API load, a network hiccup) shouldn't skew
// every estimate after it - and returns a spread rather than a single number
// since even same-sized requests vary run to run (how much correction the
// text actually needed, API load, etc). With too few runs to measure that
// spread directly, a flat +/-30% around the median stands in for it.
function estimateAiBatchRange(chars, provider) {
  const log = readAiBatchLog().filter((entry) => (entry.provider || 'anthropic') === provider);
  if (log.length === 0) return null;
  const ratios = log.map((entry) => entry.ms / entry.chars).sort((a, b) => a - b);
  const median = quantile(ratios, 0.5);
  if (log.length < 4) {
    return { lowMs: Math.round(median * chars * 0.7), highMs: Math.round(median * chars * 1.3) };
  }
  return {
    lowMs: Math.round(quantile(ratios, 0.25) * chars),
    highMs: Math.round(quantile(ratios, 0.75) * chars),
  };
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
// actual work, same as Ctrl+Z/Ctrl+Y do (there is no toolbar button for
// either - the menu is the only visible entry point). The accelerators
// below use registerAccelerator: false - they're shown in the menu for
// reference only and don't register as OS-level shortcuts, since the
// renderer already binds Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z itself and steps aside
// when a text field is focused so native field-undo still works there - a
// real menu accelerator would fire regardless of focus and bypass that.
// The two items carry ids so the 'menu:undo-state-changed' handler below
// can grey them out when there's nothing to undo/redo, since without a
// toolbar button that's the only place this state is now shown.
// Open/Save/Save As/Close are driven the same way as Undo/Redo above: forwarded
// as IPC events to the renderer, which owns the docId and does the actual
// work (performOpen()/performSave()/performSaveAs()/performClose() in
// renderer.js) - Save picks between writing straight to the last-used path
// or falling back to a Save As dialog; Close just releases the current
// document without exiting the app.
/**
 * Sends a menu event to the window whose menu was clicked.
 *
 * Electron types a menu click's window argument as BaseWindow, which has no
 * `webContents`. The app menu here is only ever attached to a BrowserWindow,
 * which does - so this records that assumption once, with a name, instead of
 * repeating an inline cast at all fifteen call sites.
 *
 * @param {import('electron').BaseWindow | undefined} win
 * @param {string} channel
 * @param {...unknown} args
 */
function sendToWindow(win, channel, ...args) {
  const browserWin = /** @type {import('electron').BrowserWindow | undefined} */ (win);
  browserWin?.webContents.send(channel, ...args);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [/** @type {import('electron').MenuItemConstructorOptions} */ ({ role: 'appMenu' })]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: (_item, win) => sendToWindow(win, 'menu:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (_item, win) => sendToWindow(win, 'menu:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: (_item, win) => sendToWindow(win, 'menu:save-as') },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: (_item, win) => sendToWindow(win, 'menu:close') },
        { type: 'separator' },
        {
          label: 'Settings',
          submenu: [
            { label: 'API Key…', click: (_item, win) => sendToWindow(win, 'menu:settings') },
            { type: 'separator' },
            {
              label: 'Appearance',
              submenu: [
                {
                  label: 'Show Tag Type Label on Highlight',
                  type: 'checkbox',
                  checked: getShowTagTypeLabel(),
                  click: (item, win) => {
                    setShowTagTypeLabel(item.checked);
                    sendToWindow(win, 'menu:show-tag-type-label', item.checked);
                  },
                },
              ],
            },
            {
              label: 'Notifications',
              submenu: [
                {
                  label: 'Desktop Notification When AI Batch Finishes',
                  type: 'checkbox',
                  checked: getNotifyDesktop(),
                  click: (item, win) => {
                    setNotifyDesktop(item.checked);
                    sendToWindow(win, 'menu:notify-desktop', item.checked);
                  },
                },
                {
                  label: 'Play Chime When AI Batch Finishes',
                  type: 'checkbox',
                  checked: getNotifyChime(),
                  click: (item, win) => {
                    setNotifyChime(item.checked);
                    sendToWindow(win, 'menu:notify-chime', item.checked);
                  },
                },
              ],
            },
          ],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { id: 'menu-undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, enabled: false, click: (_item, win) => sendToWindow(win, 'menu:undo') },
        { id: 'menu-redo', label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, enabled: false, click: (_item, win) => sendToWindow(win, 'menu:redo') },
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
      label: 'Tools',
      submenu: [
        { label: 'Find/Replace…', accelerator: 'CmdOrCtrl+F', click: (_item, win) => sendToWindow(win, 'menu:find-replace') },
        { type: 'separator' },
        {
          label: 'Show AT Changes',
          type: 'checkbox',
          checked: false,
          click: (item, win) => sendToWindow(win, 'menu:show-at-changes', item.checked),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Shortcuts', accelerator: 'CmdOrCtrl+/', click: (_item, win) => sendToWindow(win, 'menu:shortcuts') },
        { label: 'Help Doc', accelerator: 'F1', click: (_item, win) => sendToWindow(win, 'menu:help-doc') },
        { type: 'separator' },
        { label: 'About LastMilePDF', click: (_item, win) => sendToWindow(win, 'menu:about', { version: app.getVersion() }) },
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

// Keeps the Edit menu's Undo/Redo items in sync with the renderer's undo
// stack - see the comment above buildAppMenu() for why there's no toolbar
// button doing this instead.
ipcMain.on('menu:undo-state-changed', (_event, { canUndo, canRedo }) => {
  const menu = Menu.getApplicationMenu();
  const undoItem = menu?.getMenuItemById('menu-undo');
  const redoItem = menu?.getMenuItemById('menu-redo');
  if (undoItem) undoItem.enabled = !!canUndo;
  if (redoItem) redoItem.enabled = !!canRedo;
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

// Bulk-sets /ActualText to a different value per node as one undo step -
// used by "Fix All Actual Text (AI)" to apply every AI-corrected tag in a
// single action, so one Undo reverts the whole batch. `updates` is
// { [nodeId]: text }.
ipcMain.handle('tags:update-actual-texts', async (_event, { docId, updates }) => {
  return callWorker('update_actual_texts', { docId, updates });
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

ipcMain.handle('tags:flatten-tags', async (_event, { docId, nodeIds }) => {
  return callWorker('flatten_tags', { docId, nodeIds });
});

ipcMain.handle('tags:scope-tables', async (_event, { docId }) => {
  return callWorker('scope_tables', { docId });
});

ipcMain.handle('tags:delete-nodes', async (_event, { docId, nodeIds }) => {
  return callWorker('delete_nodes', { docId, nodeIds });
});

ipcMain.handle('tags:join-tags', async (_event, { docId, nodeIds }) => {
  return callWorker('join_tags', { docId, nodeIds });
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

ipcMain.handle('outline:add-bookmark', async (_event, { docId, page, title }) => {
  return callWorker('add_bookmark', { docId, page, title });
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

// --- Settings (API key) --------------------------------------------------

ipcMain.handle('settings:has-api-key', async () => hasStoredApiKey());

ipcMain.handle('settings:set-api-key', async (_event, { key }) => {
  setStoredApiKey(key);
  return true;
});

ipcMain.handle('settings:clear-api-key', async () => {
  clearStoredApiKey();
  return true;
});

ipcMain.handle('settings:get-ai-provider', async () => getAiProvider());

ipcMain.handle('settings:set-ai-provider', async (_event, { provider }) => {
  setAiProvider(provider);
  return true;
});

ipcMain.handle('settings:has-custom-api-key', async () => hasStoredCustomApiKey());

ipcMain.handle('settings:set-custom-api-key', async (_event, { key }) => {
  setStoredCustomApiKey(key);
  return true;
});

ipcMain.handle('settings:clear-custom-api-key', async () => {
  clearStoredCustomApiKey();
  return true;
});

ipcMain.handle('settings:get-custom-provider-config', async () => getCustomProviderConfig());

ipcMain.handle('settings:set-custom-provider-config', async (_event, { baseUrl, model }) => {
  setCustomProviderConfig(baseUrl, model);
  return true;
});

ipcMain.handle('settings:get-show-tag-type-label', async () => getShowTagTypeLabel());

ipcMain.handle('settings:get-notify-desktop', async () => getNotifyDesktop());
ipcMain.handle('settings:get-notify-chime', async () => getNotifyChime());

// --- AI (Fix with AI) ------------------------------------------------------
//
// Both handlers below run against whichever provider is currently selected
// (see getAiProvider() above): the built-in Anthropic client, or a plain
// fetch() against a custom OpenAI chat-completions-compatible endpoint. The
// custom path can't rely on Anthropic's structured-output support (an
// arbitrary endpoint may not offer an equivalent), so it instead instructs
// the model to reply with bare JSON and parses that leniently - stripping a
// markdown code fence if the model wrapped its reply in one, which smaller
// or less-instruction-tuned models tend to do even when told not to.

function requireAnthropicKey() {
  const apiKey = getStoredApiKey();
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Add one via File > Settings > API Key…');
  }
  return apiKey;
}

function requireCustomProviderConfig() {
  const apiKey = getStoredCustomApiKey();
  const { baseUrl, model } = getCustomProviderConfig();
  if (!apiKey || !baseUrl || !model) {
    throw new Error('The custom AI provider is not fully configured. Set the base URL, model, and API key via File > Settings > API Key…');
  }
  return { apiKey, baseUrl, model };
}

/**
 * POSTs one OpenAI chat-completions-style request to a custom endpoint and
 * returns the reply text. `jsonMode` sets response_format: json_object as a
 * best-effort hint - endpoints that ignore unknown fields still work, since
 * the system prompt itself also spells out the required JSON shape.
 */
async function customChatCompletion({ apiKey, baseUrl, model, system, prompt, jsonMode }) {
  let response;
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach the custom AI endpoint (${baseUrl}): ${err.message}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('That custom AI API key was rejected. Check it via File > Settings > API Key…');
    }
    if (response.status === 429) {
      throw new Error('Rate limited by the custom AI endpoint - try again in a moment.');
    }
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Custom AI endpoint error (${response.status}): ${bodyText.slice(0, 500) || response.statusText}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The custom AI endpoint did not return valid JSON.');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('The custom AI endpoint did not return any text.');
  }
  return content.trim();
}

// Strips a ```/```json fence around a model's reply, if present, before
// parsing - see the comment above customChatCompletion() for why.
function parseJsonReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("The custom AI endpoint's reply could not be parsed as JSON.");
  }
}

const FIX_ACTUAL_TEXT_SYSTEM_PROMPT = `You clean up text pulled from a PDF's content stream for use as the PDF's /ActualText - the text a screen reader speaks instead of the visible content.

Fix OCR/transcription errors, garbled characters, broken ligatures, and stray hyphenation, while preserving the original wording, meaning, and language exactly. Do not summarize, translate, rephrase, or add commentary. Reply with only the corrected text and nothing else - no preamble, no explanation, no quotation marks.`;

ipcMain.handle('ai:fix-actual-text', async (_event, { text }) => {
  if (!text || !text.trim()) {
    throw new Error('There is no text to fix.');
  }

  if (getAiProvider() === 'custom') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig();
    const content = await customChatCompletion({
      apiKey,
      baseUrl,
      model,
      system: FIX_ACTUAL_TEXT_SYSTEM_PROMPT,
      prompt: text,
      jsonMode: false,
    });
    return content;
  }

  const apiKey = requireAnthropicKey();
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      output_config: { effort: 'low' },
      system: FIX_ACTUAL_TEXT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || !textBlock.text.trim()) {
      throw new Error('The AI did not return any text.');
    }
    return textBlock.text.trim();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('That Anthropic API key was rejected. Check it via File > Settings > API Key…');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Rate limited by the Anthropic API - try again in a moment.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error: ${err.message}`);
    }
    throw err;
  }
});

// Fixes every tag's Actual Text in one request instead of one at a time, so
// the model can cross-reference the whole document - the same proper noun,
// abbreviation, or technical term gets fixed the same way everywhere it
// appears, which it can't do looking at one tag's text in isolation. `items`
// covers both tags that already had Actual Text AND tags whose content-leaf
// text the renderer pulled just for this request (see the "Fix All Actual
// Text" handler in renderer.js) - so the model sees the whole document's
// text, not just the fields someone already filled in. Each entry is keyed
// by its (renderer-assigned-at-request-time) tag id; the renderer holds the
// results as pending proposals and only writes a tag's Actual Text once the
// user reviews and accepts it (see aiProposals / updateActualTextReviewUI()
// in renderer.js) - this handler never touches the PDF itself.
const BatchFixResultSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});

const FIX_ACTUAL_TEXT_BATCH_SYSTEM_PROMPT = `You clean up text for use as each tag's /ActualText in a PDF - the text a screen reader speaks instead of the visible content. Some of it is already-set Actual Text; some is raw text pulled from a tag's own content that has no Actual Text override yet.

You will receive a JSON array of entries, each with an id and the current text for one tag from the same document. Fix OCR/transcription errors, garbled characters, broken ligatures, and stray hyphenation in each entry, while preserving the original wording, meaning, and language exactly - use the full set of entries to stay consistent, since the same proper noun, abbreviation, or technical term should be fixed the same way everywhere it appears in the document. Do not summarize, translate, rephrase, reorder, merge, or drop entries. Return exactly one output entry per input id, using the same ids, with only the corrected text - no commentary. An entry that already reads correctly should be returned unchanged.`;

// Appended only for the custom-provider path, which can't rely on
// Anthropic-style structured-output enforcement (see the comment above
// customChatCompletion() above) and so needs the required shape spelled out
// in-prompt instead.
const FIX_ACTUAL_TEXT_BATCH_JSON_INSTRUCTION = `Respond with only a single JSON object of the exact form {"items":[{"id":"...","text":"..."}]} - no markdown code fences, no explanation, no other text before or after the JSON.`;

// Rough guard against a request too large for a single response - output is
// close to input size (corrected text, not expanded) plus per-entry JSON
// overhead, but without a cap a huge document would silently truncate
// mid-response instead of failing clearly. Generous since this can now cover
// a whole document's text, not just tags someone already filled in.
const BATCH_FIX_CHAR_LIMIT = 150000;

// Lets the progress dialog (see el.aiBatchProgressDialog in renderer.js) show
// an upfront estimate before kicking off the actual request - the renderer
// passes the same char count it's about to send so the estimate matches what
// estimateAiBatchRange()/recordAiBatchTiming() below key their averages on.
// Scoped to the currently selected provider (see estimateAiBatchRange()).
ipcMain.handle('ai:estimate-batch-time', async (_event, { chars }) => estimateAiBatchRange(chars, getAiProvider()));

ipcMain.handle('ai:fix-actual-text-batch', async (_event, { items }) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No tags with Actual Text to fix.');
  }
  const payload = JSON.stringify(items);
  if (payload.length > BATCH_FIX_CHAR_LIMIT) {
    throw new Error(
      `This document has too much text to fix in one batch (${payload.length.toLocaleString()} characters, limit ${BATCH_FIX_CHAR_LIMIT.toLocaleString()}). Fix tags individually with "Fix with AI" instead.`,
    );
  }

  const provider = getAiProvider();
  const startedAt = Date.now();
  let resultItems;

  if (provider === 'custom') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig();
    const content = await customChatCompletion({
      apiKey,
      baseUrl,
      model,
      system: `${FIX_ACTUAL_TEXT_BATCH_SYSTEM_PROMPT}\n\n${FIX_ACTUAL_TEXT_BATCH_JSON_INSTRUCTION}`,
      prompt: payload,
      jsonMode: true,
    });
    const parsed = parseJsonReply(content);
    const validation = BatchFixResultSchema.safeParse(parsed);
    if (!validation.success) {
      throw new Error("The custom AI endpoint's reply did not match the expected {items: [{id, text}]} shape.");
    }
    resultItems = validation.data.items;
  } else {
    const apiKey = requireAnthropicKey();
    const client = new Anthropic({ apiKey });
    try {
      // Streamed rather than a plain .parse() call - a full-document batch
      // can need well beyond the ~16K non-streaming ceiling, and large
      // max_tokens requires streaming to avoid an HTTP timeout.
      const stream = client.messages.stream({
        model: 'claude-opus-5',
        max_tokens: 64000,
        output_config: { effort: 'medium', format: zodOutputFormat(BatchFixResultSchema) },
        system: FIX_ACTUAL_TEXT_BATCH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
      });
      const response = await stream.finalMessage();
      if (!response.parsed_output) {
        throw new Error('The AI did not return a valid response.');
      }
      resultItems = response.parsed_output.items;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error('That Anthropic API key was rejected. Check it via File > Settings > API Key…');
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error('Rate limited by the Anthropic API - try again in a moment.');
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error: ${err.message}`);
      }
      throw err;
    }
  }

  // Only successful runs go into the log - a run that errored out (e.g. rate
  // limited partway through) doesn't reflect how long a normal request of
  // this size actually takes, and would skew future estimates.
  recordAiBatchTiming(payload.length, Date.now() - startedAt, provider);
  return resultItems;
});
