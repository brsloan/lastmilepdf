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

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { Anthropic } = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');
const { autoUpdater } = require('electron-updater');
const changelog = require('./lib/changelog');

// --- Diagnostic log ---------------------------------------------------------
//
// A packaged build has no terminal a user can see, so the console.error
// calls scattered through this file (worker stderr, spawn failures, decrypt
// failures...) go nowhere useful outside a dev shell - see the
// Troubleshooting section in the README. Mirroring them to a plain-text file
// in userData gives a packaged user something to open (Help > Open Log
// Folder) or attach to a bug report. Truncated fresh on every launch - this
// is "what happened this session", not a persistent history, so it can't
// grow unbounded over months of use.
const LOG_PATH = path.join(app.getPath('userData'), 'main.log');
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, `LastMilePDF ${app.getVersion()} started ${new Date().toISOString()}\n`);
} catch {
  // Logging must never be the thing that crashes the app.
}

function formatLogArg(value) {
  if (value instanceof Error) return value.stack || String(value);
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Wrapping console.error once here (rather than editing every call site)
// mirrors every existing and future console.error call into the log file
// for free.
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.map(formatLogArg).join(' ')}\n`);
  } catch {
    // best-effort
  }
};

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

// --- Recent files ------------------------------------------------------
//
// File > Open Recent. Stored in the same settings.json as everything else
// here, capped so it can't grow without bound. Newest first; re-opening an
// already-listed path just moves it back to the top rather than
// duplicating it.
const RECENT_FILES_MAX = 10;

function getRecentFiles() {
  const list = readSettingsFile().recentFiles;
  return Array.isArray(list) ? list : [];
}

function addRecentFile(filePath) {
  const settings = readSettingsFile();
  const existing = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
  settings.recentFiles = [filePath, ...existing.filter((p) => p !== filePath)].slice(0, RECENT_FILES_MAX);
  writeSettingsFile(settings);
}

// Drops one path without touching the rest - used when File > Open Recent
// points at a file that's since been moved or deleted, so it stops showing
// up (and failing) on every future launch.
function removeRecentFile(filePath) {
  const settings = readSettingsFile();
  const existing = Array.isArray(settings.recentFiles) ? settings.recentFiles : [];
  settings.recentFiles = existing.filter((p) => p !== filePath);
  writeSettingsFile(settings);
}

function clearRecentFiles() {
  const settings = readSettingsFile();
  settings.recentFiles = [];
  writeSettingsFile(settings);
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

// The exact dropdown selection from the Settings dialog - 'anthropic', or
// any provider id the renderer defines (a named preset like 'openai' or
// 'purdue-genai', or 'custom' for a manually-entered endpoint). main.js
// treats every value other than 'anthropic' identically (the generic
// OpenAI-compatible path - see customChatCompletion() below) and never
// needs to know the actual list of presets, so a provider the renderer adds
// or removes later just works without a main.js change. Defaults to
// 'anthropic' only when nothing has been saved yet; an unrecognized string
// is preserved as-is rather than silently reset, so a provider the user
// picked with this build still round-trips correctly even if a future
// version's renderer no longer offers it as a preset (it still behaves as a
// custom OpenAI-compatible endpoint - it just won't match a named preset's
// autofill in the dialog).
function getAiProvider() {
  const provider = readSettingsFile().aiProvider;
  return typeof provider === 'string' && provider ? provider : 'anthropic';
}

function setAiProvider(provider) {
  const settings = readSettingsFile();
  settings.aiProvider = provider;
  writeSettingsFile(settings);
}

// Per-provider BYOK storage - keyed by the same provider id as
// getAiProvider() above, so switching between e.g. OpenAI and a
// university-hosted "Custom" endpoint remembers each one's own key and
// config instead of the two overwriting a single shared slot (the original,
// buggy design: only one custom-provider key/config existed, so saving a
// key for one provider silently clobbered whatever was saved for another).
// Keys are encrypted individually via safeStorage, same as the Anthropic
// key above; baseUrl/model aren't secret, so they're stored in plain text.

function getProviderConfigs() {
  const configs = readSettingsFile().providerConfigs;
  return configs && typeof configs === 'object' ? configs : {};
}

function getCustomProviderConfig(providerId) {
  const config = getProviderConfigs()[providerId];
  return {
    baseUrl: config && typeof config.baseUrl === 'string' ? config.baseUrl : '',
    model: config && typeof config.model === 'string' ? config.model : '',
  };
}

function setCustomProviderConfig(providerId, baseUrl, model) {
  const settings = readSettingsFile();
  const configs = getProviderConfigs();
  configs[providerId] = { baseUrl, model };
  settings.providerConfigs = configs;
  writeSettingsFile(settings);
}

function getProviderApiKeys() {
  const keys = readSettingsFile().providerApiKeys;
  return keys && typeof keys === 'object' ? keys : {};
}

function hasStoredCustomApiKey(providerId) {
  return typeof getProviderApiKeys()[providerId] === 'string';
}

function getStoredCustomApiKey(providerId) {
  const encrypted = getProviderApiKeys()[providerId];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (err) {
    console.error(`[settings] failed to decrypt stored API key for provider "${providerId}":`, err);
    return null;
  }
}

function setStoredCustomApiKey(providerId, key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system has no OS-level credential store available to encrypt the key.');
  }
  const settings = readSettingsFile();
  const keys = getProviderApiKeys();
  keys[providerId] = safeStorage.encryptString(key).toString('base64');
  settings.providerApiKeys = keys;
  writeSettingsFile(settings);
}

function clearStoredCustomApiKey(providerId) {
  const settings = readSettingsFile();
  const keys = getProviderApiKeys();
  delete keys[providerId];
  settings.providerApiKeys = keys;
  writeSettingsFile(settings);
}

// --- Color theme -------------------------------------------------------
//
// File > Settings > Preferences > Appearance. Three choices are offered but
// only two exist as palettes (see the header comment in styles.css): 'auto'
// is resolved here, never in CSS, so the renderer only ever deals with a
// real theme name and the stylesheet needs no media queries.
//
// Defaults to 'auto', so a first run matches whatever the machine is already
// set to rather than imposing dark on someone running a light desktop. The
// cost is that the default is no longer a fixed answer: getResolvedTheme()
// consults nativeTheme, which is only correct once applyNativeThemeSource()
// has put themeSource back to 'system'. That call is the first thing in
// app.whenReady(), before the window exists - keep it there.

const THEMES = ['auto', 'dark', 'light'];

/** The ground each theme paints, mirroring --bg in styles.css. Used for the
 *  window's own backgroundColor, which is what shows for the few frames
 *  before the renderer paints - the wrong value here is a visible flash. */
const THEME_BACKGROUNDS = {
  dark: '#1b1c21',
  light: '#ffffff',
};

function getThemePreference() {
  const stored = readSettingsFile().theme;
  // 'accessible' was this palette's name while there were two light themes.
  // The weaker one is gone and this is simply 'light' now, so anyone who had
  // picked it keeps the theme they chose instead of being silently reset to
  // dark by the validation below. Mapped on read rather than rewritten on
  // disk: idempotent, and it costs nothing to leave in place.
  if (stored === 'accessible') return 'light';
  // Validated rather than trusted: a hand-edited settings.json holding a
  // theme name that no longer exists would otherwise stamp an attribute no
  // block matches, and every palette token would fall back to dark's.
  // Anything unrecognised - including a fresh install with no theme key at
  // all - lands on 'auto' and follows the OS.
  return THEMES.includes(stored) ? stored : 'auto';
}

/** The stored preference with 'auto' collapsed to whatever the OS is asking
 *  for. Always 'dark' or 'light' - never 'auto'. */
function getResolvedTheme() {
  const pref = getThemePreference();
  if (pref !== 'auto') return pref;
  // Safe to read as the OS's answer only because themeSource is held at
  // 'system' whenever the preference is 'auto' - see the warning in
  // applyNativeThemeSource() below.
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// The parts of the window Electron and Windows draw rather than the
// stylesheet - the menu bar, the title bar, context menus, DevTools - do not
// see our CSS at all. themeSource is the only lever on them.
//
// Two limits worth knowing, neither of them ours to fix:
//   * It is a three-way switch (system/light/dark), with no way to express
//     "light, but at 7:1". So the frame gets plain light for our light
//     theme: the right half of the pair, since its ground is white, but the
//     window chrome will not carry the theme's stronger contrast.
//   * On Windows the title bar reliably picks this up when it is set before
//     the window is created; changing it on a window that already exists is
//     long-standing flaky in Electron (electron#23479, electron#27100). The
//     menu bar and context menus do update live. So a theme switch may leave
//     the title bar behind until the next launch.
//
// WARNING: while themeSource is overridden, nativeTheme.shouldUseDarkColors
// returns the override instead of the OS setting. Pinning it to 'dark' for an
// explicit dark choice would therefore freeze the answer getResolvedTheme()
// gives for 'auto', and Auto would stop tracking the OS for good. Hence
// 'system' for 'auto' - that is load-bearing, not tidiness.
function applyNativeThemeSource(pref) {
  nativeTheme.themeSource = pref === 'auto' ? 'system' : pref;
}

function setThemePreference(value) {
  if (!THEMES.includes(value)) return;
  const settings = readSettingsFile();
  settings.theme = value;
  writeSettingsFile(settings);
  // After the write, so the 'updated' event this fires sees the new
  // preference and takes the early return in the nativeTheme handler.
  applyNativeThemeSource(value);
}

// Whether the selected tag's role is drawn as a label on its highlight
// box (File > Settings > Preferences). Persisted in the same settings.json
// as the API key so it's remembered between sessions.
function getShowTagTypeLabel() {
  return readSettingsFile().showTagTypeLabel !== false; // default on
}

function setShowTagTypeLabel(value) {
  const settings = readSettingsFile();
  settings.showTagTypeLabel = value;
  writeSettingsFile(settings);
}

// Whether finishing an AI batch operation (e.g. "Fix All Actual Text") pops
// a desktop notification / plays a chime (File > Settings > Preferences).
// Persisted the same way as showTagTypeLabel above.
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

// The physical key (KeyboardEvent.code, e.g. "CapsLock") the user has
// designated as an extra shortcut for the Tag Tree/Bookmarks Delete action
// (File > Settings > Preferences), so it can be pressed with the opposite
// hand from the arrow keys used to step through the tree. null when unset.
// Persisted the same way as showTagTypeLabel above.
function getExtraDeleteKeyCode() {
  const value = readSettingsFile().extraDeleteKeyCode;
  return typeof value === 'string' ? value : null;
}

function setExtraDeleteKeyCode(value) {
  const settings = readSettingsFile();
  settings.extraDeleteKeyCode = value;
  writeSettingsFile(settings);
}

// Per-action keyboard shortcuts for the Tag Tree's role-conversion shortcuts
// (1-6/P/L/I/T/R/D/H/F/C/J) and for Proofread Mode's previous/next-tag step
// (Page Up/Page Down), each a plain { actionId: KeyboardEvent.key } map
// (File > Settings > Preferences). main.js stores whatever object it's
// given as-is - it doesn't know the current set of action ids or their
// default keys, since that list lives with the renderer code that actually
// dispatches on it (see TAG_SHORTCUT_ACTIONS/PROOFREAD_SHORTCUT_ACTIONS in
// state.js) - the renderer merges this over its own defaults after loading.
function getTagShortcuts() {
  const value = readSettingsFile().tagShortcuts;
  return value && typeof value === 'object' ? value : {};
}

function setTagShortcuts(value) {
  const settings = readSettingsFile();
  settings.tagShortcuts = value;
  writeSettingsFile(settings);
}

function getProofreadShortcuts() {
  const value = readSettingsFile().proofreadShortcuts;
  return value && typeof value === 'object' ? value : {};
}

function setProofreadShortcuts(value) {
  const settings = readSettingsFile();
  settings.proofreadShortcuts = value;
  writeSettingsFile(settings);
}

// The two view settings Proofread Mode carries over from one reading
// session to the next: whether Show AT Changes is on, and what the tree
// filter is set to (see applyProofreadViewPrefs() in proofread.js). Stored
// as one { showAtChanges, filter } object, and null until the user has
// actually changed one of them while proofreading - "no preference logged
// yet" is a distinct answer from "logged as off/All", since it's what
// selects the mode's own defaults rather than the user's.
//
// Not a Preferences item: it's written by using the mode, not by a dialog.
// main.js doesn't validate the shape beyond "an object" - the renderer owns
// the set of valid filter values (see state.filter in state.js) and
// re-checks on the way back out, the same arrangement as the shortcut maps
// above.
function getProofreadViewPrefs() {
  const value = readSettingsFile().proofreadViewPrefs;
  return value && typeof value === 'object' ? value : null;
}

function setProofreadViewPrefs(value) {
  const settings = readSettingsFile();
  settings.proofreadViewPrefs = value;
  writeSettingsFile(settings);
}

// --- Per-file view state ------------------------------------------------
//
// Where the user was in a document the last time they had it open: which
// tag was selected, which tags they had expanded, how far down the tag tree
// was scrolled, and which page the preview was on. Reopening a PDF then
// picks up the reading position rather than dropping the user back at the
// structure root with everything collapsed - which on a long document meant
// re-expanding the same dozen levels every session.
//
// One record per file path, newest first and capped the same way
// recentFiles is: a file the user hasn't touched in twenty documents' time
// has almost certainly moved on, and the records are the only thing here
// that grows with the size of the document rather than being a fixed handful
// of values.
//
// main.js stores whatever object it's handed, the same arrangement as the
// shortcut maps and proofreadViewPrefs above: what a valid record looks like
// depends on the renderer's node ids and tree rendering, so the renderer is
// what validates one on the way back out (see view-memory.js). What main.js
// does own is the keying and the cap.
const FILE_VIEW_STATES_MAX = 20;

/** @param {Record<string, any>} [settings] An already-read settings object, to save reading the file again. */
function readFileViewStates(settings = readSettingsFile()) {
  const list = settings.fileViewStates;
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.path === 'string') : [];
}

function getFileViewState(filePath) {
  const entry = readFileViewStates().find((item) => item.path === filePath);
  return entry && entry.view && typeof entry.view === 'object' ? entry.view : null;
}

// A null/undefined `view` drops the record instead of storing an empty one -
// that's how the renderer says "this document has nothing worth remembering"
// (no tree, or nothing selected yet), and leaving the previous record in
// place would restore a position the user has since navigated away from.
function setFileViewState(filePath, view) {
  const settings = readSettingsFile();
  const existing = readFileViewStates(settings).filter((item) => item.path !== filePath);
  settings.fileViewStates = (view && typeof view === 'object'
    ? [{ path: filePath, view }, ...existing]
    : existing
  ).slice(0, FILE_VIEW_STATES_MAX);
  writeSettingsFile(settings);
}

// Whether the renderer periodically saves the open document to disk on its
// own, in addition to an explicit Save (File > Settings > Preferences).
// Persisted the same way as showTagTypeLabel above, but defaults off - unlike
// the other Preferences here, this one writes to the user's file without an
// explicit Save, so it should be opted into rather than assumed.
function getAutoSaveEnabled() {
  return readSettingsFile().autoSaveEnabled === true; // default off
}

function setAutoSaveEnabled(value) {
  const settings = readSettingsFile();
  settings.autoSaveEnabled = value;
  writeSettingsFile(settings);
}

// Whether to silently check GitHub for a newer release on launch (File >
// Settings > Preferences). Persisted the same way as showTagTypeLabel
// above, but defaults ON, unlike autoSaveEnabled - this only ever reads a
// public release feed and reports back through Help > About; it never
// writes anything or changes behavior on its own, so there's nothing here
// that needs opting into. See the Auto-update section below.
function getAutoCheckForUpdates() {
  return readSettingsFile().autoCheckForUpdates !== false; // default on
}

function setAutoCheckForUpdates(value) {
  const settings = readSettingsFile();
  settings.autoCheckForUpdates = value;
  writeSettingsFile(settings);
}

// The version that ran last time, which is how the What's New dialog below
// notices that an update has landed since. Written on every launch, so a
// crash between installing and reading it costs at most one summary.
function getLastRunVersion() {
  const value = readSettingsFile().lastRunVersion;
  return typeof value === 'string' ? value : null;
}

function setLastRunVersion(version) {
  const settings = readSettingsFile();
  settings.lastRunVersion = version;
  writeSettingsFile(settings);
}

// Tools > Scripts… - user-defined sequences of the existing toolbar actions
// (Smartifact, Repair Orphaned Content, Scope Tables, Flatten All,
// Find/Replace, Fix All Actual Text (AI)), built and reordered in the
// renderer's Scripts dialog and run in order by the toolbar's "Run Script"
// button. Persisted the same way as the
// settings above; the shape of a script/step is the renderer's concern (see
// types/domain.d.ts's Script/ScriptStep), main.js just stores whatever it's
// handed. `activeScriptId` is which saved script (by id) the Run Script
// button currently triggers, or null if none has been assigned yet.
function getScripts() {
  const scripts = readSettingsFile().scripts;
  return Array.isArray(scripts) ? scripts : [];
}

function setScripts(scripts) {
  const settings = readSettingsFile();
  settings.scripts = scripts;
  writeSettingsFile(settings);
}

function getActiveScriptId() {
  const value = readSettingsFile().activeScriptId;
  return typeof value === 'string' ? value : null;
}

function setActiveScriptId(id) {
  const settings = readSettingsFile();
  settings.activeScriptId = id;
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
    // 940, not 900: .workbench's three columns have minimums of 360 + 280 +
    // 300 = 940px, and body sets overflow: hidden, so at 900 the details
    // pane was clipped by 40px with no way to scroll to it - at 100% zoom,
    // before any text resizing came into it.
    minWidth: 940,
    minHeight: 600,
    // The ground shown for the frames between the window appearing and the
    // renderer's first paint. Read from the saved theme rather than fixed,
    // otherwise a light-theme user gets a dark flash on every launch.
    backgroundColor: THEME_BACKGROUNDS[getResolvedTheme()],
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

// Truncates a long path to its trailing MAX characters (keeping the file
// name, the most identifying part, intact) rather than showing the whole
// thing - a menu item's label has no room for a full path once it's a few
// directories deep.
function labelForRecentFile(filePath) {
  const MAX = 60;
  return filePath.length > MAX ? `…${filePath.slice(-(MAX - 1))}` : filePath;
}

// File > Open Recent's contents. Rebuilt (via a full buildAppMenu() call -
// there's no API to patch a single live submenu's items) every time the
// list changes: after a successful open/save-as (see openPdfAtPath() and
// the dialog:save-pdf handler below) and after Clear Recent Files here.
/** @returns {import('electron').MenuItemConstructorOptions[]} */
function buildRecentFilesSubmenu() {
  const recent = getRecentFiles();
  if (recent.length === 0) {
    return [{ label: 'No Recent Files', enabled: false }];
  }
  return [
    ...recent.map((filePath) => ({
      label: labelForRecentFile(filePath),
      click: (_item, win) => sendToWindow(win, 'menu:open-recent', filePath),
    })),
    { type: 'separator' },
    {
      label: 'Clear Recent Files',
      click: () => {
        clearRecentFiles();
        Menu.setApplicationMenu(buildAppMenu());
      },
    },
  ];
}

// --- Live menu state ----------------------------------------------------
//
// buildAppMenu() throws away every MenuItem and builds new ones from the
// template below, so anything toggled *after* startup has to be read back
// out of here rather than hardcoded into that template. This used not to
// matter - the menu was built exactly once - but File > Open Recent made
// rebuilding routine (every open, every Save As, every Clear Recent Files,
// see the Menu.setApplicationMenu calls elsewhere in this file), and a
// template with `enabled: false`/`checked: false` baked in reset all four
// of these on each one: Undo/Redo greyed out despite a live undo stack
// (nothing re-sends menu:undo-state-changed after a Save As), and the two
// View checkboxes cleared while the renderer stayed in that mode - which
// also cost a click to get back out of it, since the next click on a
// wrongly-unchecked item sends `true` and just re-enters the mode.
let menuUndoEnabled = false;
let menuRedoEnabled = false;
let menuProofreadChecked = false;
let menuShowAtChangesChecked = false;

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
        { label: 'Open Recent', submenu: buildRecentFilesSubmenu() },
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
            { label: 'Preferences…', click: (_item, win) => sendToWindow(win, 'menu:preferences') },
          ],
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { id: 'menu-undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, enabled: menuUndoEnabled, click: (_item, win) => sendToWindow(win, 'menu:undo') },
        { id: 'menu-redo', label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, enabled: menuRedoEnabled, click: (_item, win) => sendToWindow(win, 'menu:redo') },
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
        { type: 'separator' },
        {
          id: 'menu-proofread',
          label: 'Proofread Mode',
          type: 'checkbox',
          checked: menuProofreadChecked,
          click: (item, win) => {
            menuProofreadChecked = item.checked;
            sendToWindow(win, 'menu:proofread', item.checked);
          },
        },
        {
          id: 'menu-show-at-changes',
          label: 'Show AT Changes',
          type: 'checkbox',
          checked: menuShowAtChangesChecked,
          click: (item, win) => {
            menuShowAtChangesChecked = item.checked;
            sendToWindow(win, 'menu:show-at-changes', item.checked);
          },
        },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Find/Replace…', accelerator: 'CmdOrCtrl+F', click: (_item, win) => sendToWindow(win, 'menu:find-replace') },
        { type: 'separator' },
        { label: 'Repair Orphaned Content', click: (_item, win) => sendToWindow(win, 'menu:repair-orphaned-content') },
        { type: 'separator' },
        { label: 'Scripts…', click: (_item, win) => sendToWindow(win, 'menu:scripts') },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Quickstart', click: (_item, win) => sendToWindow(win, 'menu:quickstart') },
        { label: 'Open Quickstart PDF', click: (_item, win) => sendToWindow(win, 'menu:open-quickstart-pdf') },
        { type: 'separator' },
        { label: 'Shortcuts', accelerator: 'CmdOrCtrl+/', click: (_item, win) => sendToWindow(win, 'menu:shortcuts') },
        { label: 'Help Doc', accelerator: 'F1', click: (_item, win) => sendToWindow(win, 'menu:help-doc') },
        { label: "What's New", click: (_item, win) => sendToWindow(win, 'menu:whats-new') },
        { type: 'separator' },
        { label: 'Open Log Folder', click: () => shell.showItemInFolder(LOG_PATH) },
        { type: 'separator' },
        { label: 'About LastMilePDF', click: (_item, win) => sendToWindow(win, 'menu:about', { version: app.getVersion() }) },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// --- Auto-update -------------------------------------------------------
//
// Checks GitHub Releases (see the "publish" block in package.json's build
// config and .github/workflows/release.yml, which uploads the latest.yml
// electron-updater reads) for a newer tagged version. Deliberately two-step
// and never automatic past checking: autoDownload stays false, so finding
// an update never starts a download by itself, and even a finished
// download still needs an explicit "Restart & Install" click from the
// About dialog (see updates:download/updates:install below and their
// renderer.js handlers). The portable build can't replace itself in place
// the way the NSIS installer can, so it skips downloading/installing
// entirely and just opens the Releases page instead - see isPortableBuild.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// Set by electron-builder's portable launcher (only) when running the
// portable .exe - a reliable way to tell it apart from an NSIS install
// without hardcoding a path.
const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_FILE;

// Whether the check currently in flight is the automatic launch-time one,
// which pops a one-time native alert if it finds something - a manual
// check from Help > About > Check for Updates doesn't, since the dialog
// the user is already looking at *is* the result.
let isAutomaticUpdateCheck = false;

/**
 * @typedef {{
 *   status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error',
 *   version?: string,
 *   percent?: number,
 *   message?: string,
 * }} UpdateState
 */
/** @type {UpdateState} */
let updateState = { status: 'idle' };

function pushUpdateState() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:state', updateState);
  }
}

autoUpdater.on('checking-for-update', () => {
  updateState = { status: 'checking' };
  pushUpdateState();
});

autoUpdater.on('update-available', (info) => {
  updateState = { status: 'available', version: info.version };
  pushUpdateState();
  if (!isAutomaticUpdateCheck) return;
  const win = BrowserWindow.getAllWindows()[0];
  dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Show Details', 'Not Now'],
    defaultId: 0,
    title: 'Update available',
    message: `LastMilePDF ${info.version} is available (you're on ${app.getVersion()}).`,
    detail: 'See Help > About to download and install it.',
  }).then(({ response }) => {
    if (response === 0) sendToWindow(win, 'menu:about', { version: app.getVersion() });
  });
});

autoUpdater.on('update-not-available', () => {
  updateState = { status: 'not-available' };
  pushUpdateState();
});

autoUpdater.on('error', (err) => {
  console.error('[autoUpdater]', err);
  updateState = { status: 'error', message: err.message };
  pushUpdateState();
});

autoUpdater.on('download-progress', (progress) => {
  updateState = { status: 'downloading', percent: Math.round(progress.percent) };
  pushUpdateState();
});

autoUpdater.on('update-downloaded', (info) => {
  updateState = { status: 'downloaded', version: info.version };
  pushUpdateState();
});

// --- What's new --------------------------------------------------------
//
// The first launch after an update says what changed, taken from the same
// CHANGELOG.md section the GitHub release notes are built from (see
// lib/changelog.js). Installing an update is the one moment those notes are
// worth reading, and until now they only existed on a page nobody was sent
// to - the About dialog said "Update 0.5.0 downloaded" and never what was in
// it.
//
// Keyed on the version changing between launches rather than on the updater
// itself, so the portable build - which updates by downloading a new .exe
// rather than through electron-updater - gets the same summary. Nothing is
// shown on a fresh install (there's no "before" to report against), on a
// downgrade, or when the running version has no section in the changelog,
// which is what keeps a build run from source quiet. An update that skipped
// releases reports the skipped ones too, up to WHATS_NEW_MAX_VERSIONS of
// them, since from the user's side they all arrived at once.
const CHANGELOG_PATH = path.join(__dirname, 'CHANGELOG.md');
const WHATS_NEW_MAX_VERSIONS = 5;

function readChangelogFile() {
  try {
    return fs.readFileSync(CHANGELOG_PATH, 'utf8');
  } catch (err) {
    console.error('[whats-new] could not read CHANGELOG.md:', err);
    return '';
  }
}

/**
 * What the first window to ask gets handed, then cleared - one summary per
 * update, not one per window.
 * @type {{ current: string, previous: string, entries: import('./lib/changelog').ChangelogEntry[] } | null}
 */
let pendingWhatsNew = null;

/**
 * Called once at startup, before any window exists. Records the running
 * version either way, so the summary is offered exactly once however the
 * launch goes on.
 */
function prepareWhatsNew() {
  const current = app.getVersion();
  const previous = getLastRunVersion();
  setLastRunVersion(current);
  if (!previous || changelog.compareVersions(current, previous) <= 0) return;
  const entries = changelog.entriesSince(readChangelogFile(), current, previous, {
    max: WHATS_NEW_MAX_VERSIONS,
  });
  if (!entries.length) return;
  pendingWhatsNew = { current, previous, entries };
}

app.whenReady().then(() => {
  // Before the menu is built and before the window exists: Windows only
  // takes the title bar's light/dark cue at window-creation time.
  applyNativeThemeSource(getThemePreference());
  Menu.setApplicationMenu(buildAppMenu());
  // Before the window: the renderer asks for this as it boots, so the
  // answer has to be ready by the time it does.
  prepareWhatsNew();
  startWorker();
  createWindow();

  // Packaged builds only - there's no published feed to check against
  // when running from source, and electron-updater logs a noisy warning
  // if asked to try. Delayed so it doesn't compete with the app's own
  // startup work (worker spawn, first PDF load if one was passed in).
  if (app.isPackaged && getAutoCheckForUpdates()) {
    setTimeout(() => {
      isAutomaticUpdateCheck = true;
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[autoUpdater] startup check failed:', err);
      });
    }, 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (workerProcess) workerProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC handlers -------------------------------------------------------

// Reads `filePath` off disk and asks the Python sidecar to parse its
// structure tree, returning everything the renderer needs to render page 1
// and the tag tree in one round trip. Shared by the Open dialog and File >
// Open Recent below - they differ only in how filePath was chosen.
async function openPdfAtPath(filePath) {
  const fileBuffer = fs.readFileSync(filePath);

  // pikepdf needs to open the file itself (it works against the file/object
  // graph, not raw bytes we already have), so we pass the path, not the buffer.
  const openResult = await callWorker('open', { path: filePath });

  addRecentFile(filePath);
  Menu.setApplicationMenu(buildAppMenu());

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
}

// Opens a native file picker, then hands off to openPdfAtPath().
ipcMain.handle('dialog:open-pdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (canceled || filePaths.length === 0) return null;
  return openPdfAtPath(filePaths[0]);
});

// File > Open Recent - same as the dialog above, minus the picker. A
// thrown error (most commonly ENOENT: the file was moved or deleted since
// it was last opened) surfaces through the renderer's normal reportError()
// path; the entry is also dropped from the recent list here so it doesn't
// keep failing on every future launch.
ipcMain.handle('doc:open-path', async (_event, filePath) => {
  try {
    return await openPdfAtPath(filePath);
  } catch (err) {
    removeRecentFile(filePath);
    Menu.setApplicationMenu(buildAppMenu());
    throw err;
  }
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
// Recorded as well as applied, so a later buildAppMenu() (File > Open, Save
// As, Clear Recent Files) rebuilds these items enabled the same way rather
// than back to the template's startup default - see the live menu state
// above buildAppMenu().
ipcMain.on('menu:undo-state-changed', (_event, { canUndo, canRedo }) => {
  menuUndoEnabled = !!canUndo;
  menuRedoEnabled = !!canRedo;
  const menu = Menu.getApplicationMenu();
  const undoItem = menu?.getMenuItemById('menu-undo');
  const redoItem = menu?.getMenuItemById('menu-redo');
  if (undoItem) undoItem.enabled = menuUndoEnabled;
  if (redoItem) redoItem.enabled = menuRedoEnabled;
});

// Keeps the View menu's Show AT Changes checkbox in sync when the renderer
// turns that mode on or off by itself rather than from a click on the item -
// which Proofread Mode does at both ends, applying the remembered setting on
// the way in and restoring the previous one on the way out (see
// setProofreadMode() in proofread.js). Without this the checkbox would say
// the opposite of what the renderer is actually doing, and the next click on
// it would send the state the renderer is already in.
//
// Recorded as well as applied, for the same reason as the undo state above:
// a later buildAppMenu() rebuilds the item from menuShowAtChangesChecked.
ipcMain.on('menu:show-at-changes-state-changed', (_event, { checked }) => {
  menuShowAtChangesChecked = !!checked;
  const item = Menu.getApplicationMenu()?.getMenuItemById('menu-show-at-changes');
  if (item) item.checked = menuShowAtChangesChecked;
});

// The same, for the View menu's Proofread Mode checkbox. The renderer turns
// that mode on by itself when a document is reopened that was left in it
// (see view-memory.js), and the item would otherwise sit unchecked over a
// window that is plainly proofreading - with the next click on it sending
// `true` and re-entering the mode the app is already in.
ipcMain.on('menu:proofread-state-changed', (_event, { checked }) => {
  menuProofreadChecked = !!checked;
  const item = Menu.getApplicationMenu()?.getMenuItemById('menu-proofread');
  if (item) item.checked = menuProofreadChecked;
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

ipcMain.handle('tags:wrap-leaves', async (_event, { docId, nodeIds, role }) => {
  return callWorker('wrap_leaves', { docId, nodeIds, role });
});

ipcMain.handle('tags:tag-rect-content', async (_event, { docId, pageIndex, selections, role, useLabel }) => {
  return callWorker('tag_rect_content', { docId, pageIndex, selections, role, useLabel });
});

ipcMain.handle('tags:tag-rect-table', async (_event, { docId, pageIndex, rows }) => {
  return callWorker('tag_rect_table', { docId, pageIndex, rows });
});

ipcMain.handle('tags:scope-tables', async (_event, { docId }) => {
  return callWorker('scope_tables', { docId });
});

ipcMain.handle('tags:repair-orphaned-content', async (_event, { docId }) => {
  return callWorker('repair_orphaned_artifacts', { docId });
});

ipcMain.handle('tags:count-orphaned-content', async (_event, { docId }) => {
  return callWorker('count_orphaned_artifacts', { docId });
});

ipcMain.handle('tags:list-artifacts', async (_event, { docId }) => {
  return callWorker('list_artifacts', { docId });
});

ipcMain.handle('tags:restore-artifacts', async (_event, { docId, targets, role }) => {
  return callWorker('restore_artifacts', { docId, targets, role });
});

ipcMain.handle('tags:verify-facts', async (_event, { docId }) => {
  return callWorker('verify_document_facts', { docId });
});

ipcMain.handle('tags:set-tab-order', async (_event, { docId }) => {
  return callWorker('set_structure_tab_order', { docId });
});

ipcMain.handle('tags:set-pdfua-flag', async (_event, { docId }) => {
  return callWorker('set_pdf_ua_identifier', { docId });
});

ipcMain.handle('tags:delete-nodes', async (_event, { docId, nodeIds }) => {
  return callWorker('delete_nodes', { docId, nodeIds });
});

ipcMain.handle('tags:join-tags', async (_event, { docId, nodeIds }) => {
  return callWorker('join_tags', { docId, nodeIds });
});

ipcMain.handle('tags:get-leaf-text', async (_event, { docId, nodeId }) => {
  return callWorker('get_leaf_text', { docId, nodeId });
});

ipcMain.handle('tags:get-page-code-boxes', async (_event, { docId, pageIndex }) => {
  return callWorker('get_page_code_boxes', { docId, pageIndex });
});

ipcMain.handle('tags:split-leaf', async (_event, { docId, nodeId, splitIndex }) => {
  return callWorker('split_leaf', { docId, nodeId, splitIndex });
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

ipcMain.handle('tags:add-table-row', async (_event, { docId, tableId }) => {
  return callWorker('add_table_row', { docId, tableId });
});

ipcMain.handle('tags:add-table-column', async (_event, { docId, tableId }) => {
  return callWorker('add_table_column', { docId, tableId });
});

ipcMain.handle('tags:convert-to-paragraph', async (_event, { docId, nodeIds }) => {
  return callWorker('convert_to_paragraph', { docId, nodeIds });
});

ipcMain.handle('tags:convert-to-figure', async (_event, { docId, nodeIds }) => {
  return callWorker('convert_to_figure', { docId, nodeIds });
});

ipcMain.handle('tags:make-list', async (_event, { docId, nodeIds, labelFlags, labelSplits }) => {
  return callWorker('make_list', { docId, nodeIds, labelFlags, labelSplits });
});

ipcMain.handle('tags:convert-to-list-item', async (_event, { docId, nodeIds, labelFlags, labelSplits }) => {
  return callWorker('convert_to_list_item', { docId, nodeIds, labelFlags, labelSplits });
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
  addRecentFile(filePath);
  Menu.setApplicationMenu(buildAppMenu());
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

ipcMain.handle('settings:has-custom-api-key', async (_event, { providerId }) => hasStoredCustomApiKey(providerId));

ipcMain.handle('settings:set-custom-api-key', async (_event, { providerId, key }) => {
  setStoredCustomApiKey(providerId, key);
  return true;
});

ipcMain.handle('settings:clear-custom-api-key', async (_event, { providerId }) => {
  clearStoredCustomApiKey(providerId);
  return true;
});

ipcMain.handle('settings:get-custom-provider-config', async (_event, { providerId }) => getCustomProviderConfig(providerId));

ipcMain.handle('settings:set-custom-provider-config', async (_event, { providerId, baseUrl, model }) => {
  setCustomProviderConfig(providerId, baseUrl, model);
  return true;
});

// The one synchronous channel in the app. Every other preference is read
// with invoke(), which resolves after the first paint - harmless for a
// checkbox, but for the theme it would mean the window paints dark and then
// switches, on every single launch. theme-boot.js blocks on this before the
// body is parsed, so the correct attribute is on <html> from the start.
ipcMain.on('settings:get-resolved-theme-sync', (event) => {
  event.returnValue = getResolvedTheme();
});

ipcMain.handle('settings:get-theme', async () => getThemePreference());
ipcMain.handle('settings:set-theme', async (event, { value }) => {
  setThemePreference(value);
  const resolved = getResolvedTheme();
  // Keep the window's own ground in step, so a later restore/resize does
  // not briefly expose the previous theme's color behind the renderer.
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setBackgroundColor(THEME_BACKGROUNDS[resolved]);
  return resolved;
});

// Only fires while the preference is 'auto' in practice: the OS flipping
// between light and dark changes nothing if the user picked a theme
// outright, and getResolvedTheme() already encodes that.
nativeTheme.on('updated', () => {
  if (getThemePreference() !== 'auto') return;
  const resolved = getResolvedTheme();
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(THEME_BACKGROUNDS[resolved]);
    sendToWindow(win, 'theme:changed', resolved);
  }
});

ipcMain.handle('settings:get-show-tag-type-label', async () => getShowTagTypeLabel());
ipcMain.handle('settings:set-show-tag-type-label', async (_event, { value }) => {
  setShowTagTypeLabel(value);
  return true;
});

ipcMain.handle('settings:get-notify-desktop', async () => getNotifyDesktop());
ipcMain.handle('settings:set-notify-desktop', async (_event, { value }) => {
  setNotifyDesktop(value);
  return true;
});
ipcMain.handle('settings:get-notify-chime', async () => getNotifyChime());
ipcMain.handle('settings:set-notify-chime', async (_event, { value }) => {
  setNotifyChime(value);
  return true;
});

ipcMain.handle('settings:get-extra-delete-key-code', async () => getExtraDeleteKeyCode());
ipcMain.handle('settings:set-extra-delete-key-code', async (_event, { value }) => {
  setExtraDeleteKeyCode(value);
  return true;
});

ipcMain.handle('settings:get-tag-shortcuts', async () => getTagShortcuts());
ipcMain.handle('settings:set-tag-shortcuts', async (_event, { value }) => {
  setTagShortcuts(value);
  return true;
});

ipcMain.handle('settings:get-proofread-shortcuts', async () => getProofreadShortcuts());
ipcMain.handle('settings:set-proofread-shortcuts', async (_event, { value }) => {
  setProofreadShortcuts(value);
  return true;
});

ipcMain.handle('settings:get-proofread-view-prefs', async () => getProofreadViewPrefs());
ipcMain.handle('settings:set-proofread-view-prefs', async (_event, { value }) => {
  setProofreadViewPrefs(value);
  return true;
});

ipcMain.handle('settings:get-file-view-state', async (_event, { filePath }) => getFileViewState(filePath));
ipcMain.handle('settings:set-file-view-state', async (_event, { filePath, view }) => {
  setFileViewState(filePath, view);
  return true;
});

ipcMain.handle('settings:get-auto-save-enabled', async () => getAutoSaveEnabled());
ipcMain.handle('settings:set-auto-save-enabled', async (_event, { value }) => {
  setAutoSaveEnabled(value);
  return true;
});

ipcMain.handle('settings:get-auto-check-updates', async () => getAutoCheckForUpdates());
ipcMain.handle('settings:set-auto-check-updates', async (_event, { value }) => {
  setAutoCheckForUpdates(value);
  return true;
});

// --- Updates (Help > About) --------------------------------------------
//
// See the "Auto-update" section above for the autoUpdater event wiring
// that keeps `updateState` current and pushes it to every window.

// What the About dialog needs to draw its initial state without having to
// trigger a check itself - whether checking is even possible here (a dev
// build has no published feed), whether this is the portable build (which
// can't download-and-install itself), the running version, and whatever
// the most recent check (automatic or manual) already found.
ipcMain.handle('updates:get-info', async () => ({
  supported: app.isPackaged,
  isPortable: isPortableBuild,
  currentVersion: app.getVersion(),
  state: updateState,
}));

// Help > About > Check for Updates. Result arrives via the update:state
// push events above, not this call's return value - checkForUpdates()
// resolves once the request is sent, not once the answer is known.
ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return;
  isAutomaticUpdateCheck = false;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[autoUpdater] manual check failed:', err);
  }
});

// "Update Now" in the About dialog, once an update has been found.
ipcMain.handle('updates:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('[autoUpdater] download failed:', err);
  }
});

// "Restart & Install" in the About dialog, once the download has finished.
ipcMain.handle('updates:install', () => {
  autoUpdater.quitAndInstall();
});

// The portable build's stand-in for Update Now/Restart & Install - it
// can't replace its own running .exe the way the NSIS installer can, so
// finding an update just opens the release in a browser instead.
ipcMain.handle('updates:open-release-page', async () => {
  await shell.openExternal('https://github.com/brsloan/lastmilepdf/releases/latest');
});

// --- What's new (see the section of that name above) --------------------

// Asked once by each window as it boots; only the first one gets anything
// back, and only when this launch is the first on a newer version.
ipcMain.handle('whats-new:take', async () => {
  const pending = pendingWhatsNew;
  pendingWhatsNew = null;
  return pending;
});

// Help > What's New - the running version's entry on demand, whether or not
// this launch happens to be the first after an update. `entries` is empty
// when the changelog has nothing for this version (a build run from source
// between releases), which the dialog says rather than opening blank.
ipcMain.handle('whats-new:get', async () => {
  const current = app.getVersion();
  const entry = changelog.entryFor(readChangelogFile(), current);
  return { current, previous: null, entries: entry ? [entry] : [] };
});

// --- Quickstart --------------------------------------------------------
//
// QUICKSTART.md ships twice: as the Help > Quickstart dialog (built into
// renderer/index.html by scripts/quickstart-doc.js) and as
// assets/quickstart.pdf, a tagged PDF of the same text. The PDF is the
// tutorial to read *and* a document to practise the tools on, so it has to
// be editable - and the bundled copy is not: in an installed build it sits
// in a read-only program directory, inside an asar archive at that, where
// Save would have nowhere to write. So every open goes through a copy in the
// user data folder, which behaves like any other file the user opened: it
// saves, it remembers where it was left (see view-memory.js), and it lands
// in Open Recent.

const QUICKSTART_PDF_SOURCE = path.join(__dirname, 'assets', 'quickstart.pdf');
const QUICKSTART_PDF_COPY = path.join(app.getPath('userData'), 'Quick Start.pdf');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The path to open, copying the bundled PDF out on the way if it needs to be.
 *
 * A later version may ship a revised tutorial, so the copy is refreshed when
 * the bundled one changes - but only while the copy is still byte-for-byte
 * what was put there, which is what the recorded hash is for. Once the user
 * has saved anything into it, it is their document and an update leaves it
 * alone rather than overwriting work with a fresh tutorial.
 */
function quickstartPdfPath() {
  const source = fs.readFileSync(QUICKSTART_PDF_SOURCE);
  const settings = readSettingsFile();
  const copied = typeof settings.quickstartPdfHash === 'string' ? settings.quickstartPdfHash : null;
  let existing = null;
  try {
    existing = fs.readFileSync(QUICKSTART_PDF_COPY);
  } catch {
    existing = null; // never copied out, or the user deleted it
  }
  const untouched = existing && copied && sha256(existing) === copied;
  if (!existing || (untouched && sha256(existing) !== sha256(source))) {
    fs.mkdirSync(path.dirname(QUICKSTART_PDF_COPY), { recursive: true });
    fs.writeFileSync(QUICKSTART_PDF_COPY, source);
    settings.quickstartPdfHash = sha256(source);
    writeSettingsFile(settings);
  }
  return QUICKSTART_PDF_COPY;
}

// Help > Open Quickstart PDF. Always answers.
ipcMain.handle('quickstart:get-pdf', async () => quickstartPdfPath());

// Asked once as the renderer boots, and answered with a path only on a first
// run - so the tutorial opens itself the first time the app is used and then
// never again on its own. The flag is written before the copy is made, so a
// failure to copy still counts as the one offer rather than retrying every
// launch. Someone updating from a version that predates this gets the offer
// once too, which is the point: the tutorial is new to them as well.
ipcMain.handle('quickstart:take-pdf', async () => {
  const settings = readSettingsFile();
  if (settings.quickstartOffered) return null;
  settings.quickstartOffered = true;
  writeSettingsFile(settings);
  try {
    return quickstartPdfPath();
  } catch (err) {
    console.error('[quickstart] could not copy out the bundled PDF:', err);
    return null;
  }
});

// --- Tools > Scripts… --------------------------------------------------------

ipcMain.handle('scripts:get', async () => getScripts());
ipcMain.handle('scripts:set', async (_event, { scripts }) => {
  setScripts(scripts);
  return true;
});
ipcMain.handle('scripts:get-active', async () => getActiveScriptId());
ipcMain.handle('scripts:set-active', async (_event, { id }) => {
  setActiveScriptId(id);
  return true;
});

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

// Anthropic's Base URL and Model fields (see settings-anthropic-fields in
// index.html) live in the same generic per-provider config store as every
// other provider's (getCustomProviderConfig/setCustomProviderConfig, keyed
// 'anthropic'), but unlike a custom endpoint - where an empty Base
// URL/Model means "not configured yet, refuse the request" - Anthropic has
// sane defaults, so an empty field here just means "use them," same as
// before these fields existed.
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';

function getAnthropicClientConfig() {
  const apiKey = requireAnthropicKey();
  const { baseUrl, model } = getCustomProviderConfig('anthropic');
  return {
    apiKey,
    baseUrl: baseUrl || ANTHROPIC_DEFAULT_BASE_URL,
    model: model || ANTHROPIC_DEFAULT_MODEL,
  };
}

function requireCustomProviderConfig(providerId) {
  const apiKey = getStoredCustomApiKey(providerId);
  const { baseUrl, model } = getCustomProviderConfig(providerId);
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
 * `maxTokens`, when given, is sent as max_tokens - some gateways otherwise
 * fall back to a small default completion budget and silently truncate a
 * long reply mid-JSON rather than erroring, which is a likelier cause of a
 * "could not be parsed as JSON" failure than the model just getting the
 * format wrong.
 */
async function customChatCompletion({ apiKey, baseUrl, model, system, prompt, jsonMode, maxTokens, images = [] }) {
  // With images the user turn takes the content-parts form (text part plus
  // one image_url part per crop, as a data: URL) that vision-capable
  // OpenAI-compatible endpoints accept; without them it stays the plain
  // string every endpoint accepts, so text-only callers see no change.
  const userContent = images.length === 0
    ? prompt
    : [
      { type: 'text', text: prompt },
      ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
    ];
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
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
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
    const err = new Error(`Custom AI endpoint error (${response.status}): ${bodyText.slice(0, 500) || response.statusText}`);
    // A 4xx on a request that carried images is most often the endpoint (or
    // a text-only model behind it) refusing the content-parts form - see
    // imageRejected() below. Rate-limit and auth failures were handled
    // above, so they can't be mistaken for this.
    if (images.length > 0 && response.status >= 400 && response.status < 500) {
      Object.assign(err, { imageRejected: true });
    }
    throw err;
  }

  /** @type {any} */
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

// Scans for the first balanced {...} object in `text`, respecting string
// literals so a brace inside a quoted value (e.g. in corrected text itself)
// doesn't miscount. Returns null if none is found - including an unbalanced
// one, e.g. a reply truncated mid-object by hitting a token limit, which no
// amount of scanning can recover.
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Parses a model's reply as JSON, tolerating the ways a less-instructable
// model tends to miss the "reply with only JSON" instruction: wrapping it in
// a ```/```json fence, or prefacing/following it with a sentence or two of
// prose. Tries the whole reply (after stripping a fence, if present) first,
// then falls back to pulling out just the first balanced JSON object
// wherever it appears in the raw or fenced-stripped text.
function parseJsonReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to the more lenient extraction below.
  }
  const extracted = extractFirstJsonObject(candidate) || extractFirstJsonObject(text);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // Fall through to the throw below.
    }
  }
  throw new Error("The custom AI endpoint's reply could not be parsed as JSON.");
}

// Recognizes an OpenAI/litellm-style "your input is bigger than this
// model's context window" error message. Unlike Anthropic's models (all
// large-context, sized into BATCH_FIX_CHAR_LIMIT below), a custom endpoint's
// context window isn't knowable up front - it might be a small self-hosted
// model with a fraction of the capacity that limit assumes - so rather than
// guess a chunk size, the batch handler below tries the whole document first
// and only splits in response to the endpoint actually saying it's too big.
function isContextLengthError(message) {
  return /context.{0,20}(window|length)|too many tokens|reduce the (length|number)/i.test(message);
}

const FIX_ACTUAL_TEXT_SYSTEM_PROMPT = `You clean up text pulled from a PDF's content stream for use as the PDF's /ActualText - the text a screen reader speaks instead of the visible content.

Fix OCR/transcription errors, garbled characters, broken ligatures, and stray hyphenation, while preserving the original wording, meaning, and language exactly. Do not summarize, translate, rephrase, or add commentary. Reply with only the corrected text and nothing else - no preamble, no explanation, no quotation marks.

When an image of the page region the text was read from is included, it is the authority on what the page says. Use it to correct the text wherever the OCR misread the page, and leave names, numbers, dates, citations and unusual spellings exactly as given unless the image clearly shows otherwise. Transcribe only the text you were given, not anything else visible in the image, and where the image is illegible keep the text as it is.`;

// The single-tag fix, and Fill with AI for a Figure's alt text, both send
// crops of the page region a tag covers (see renderer/page-crop.js). Each
// crop is a base64 PNG straight from a canvas, so the only checks worth
// making are on shape and count - the renderer already caps how many it
// makes, and a hand-built payload through the bridge can't do worse than
// waste the user's own API quota.
const MAX_PAGE_CROPS = 3;

/** @returns {import('./types/domain').PageCrop[]} */
function sanitizePageCrops(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img) => img && img.mediaType === 'image/png' && typeof img.data === 'string' && img.data.length > 0)
    .slice(0, MAX_PAGE_CROPS)
    .map((img) => ({ mediaType: /** @type {const} */ ('image/png'), data: img.data, page: Number(img.page) || 0 }));
}

// Whether an error from a request that carried images means "this endpoint
// or model doesn't take images" rather than anything else - the case where
// retrying with the text alone is the right move, since that is exactly what
// Fix with AI did before crops existed and the user configured this
// provider expecting it to work. An OpenAI-compatible endpoint answers with
// a 4xx (flagged in customChatCompletion()); a non-vision model behind an
// Anthropic-style proxy answers with a 400.
function imageRejected(err) {
  return err?.imageRejected === true || err instanceof Anthropic.BadRequestError;
}

/**
 * One attempt at the fix, with or without crops. Provider errors come out
 * raw; the handler below translates them.
 * @param {string} text
 * @param {import('./types/domain').PageCrop[]} images
 * @returns {Promise<string>}
 */
async function fixActualTextOnce(text, images) {
  const providerId = getAiProvider();
  if (providerId !== 'anthropic') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig(providerId);
    return customChatCompletion({
      apiKey,
      baseUrl,
      model,
      system: FIX_ACTUAL_TEXT_SYSTEM_PROMPT,
      prompt: text,
      jsonMode: false,
      maxTokens: 4096,
      images,
    });
  }

  const { apiKey, baseUrl, model } = getAnthropicClientConfig();
  const client = new Anthropic({ apiKey, baseURL: baseUrl });
  // Images go ahead of the text, which is the ordering Anthropic's vision
  // guidance recommends for "here is a document, now do this with it".
  /** @type {import('@anthropic-ai/sdk').Anthropic.MessageParam['content']} */
  const content = images.length === 0
    ? text
    : [
      ...images.map((img) => ({
        type: /** @type {const} */ ('image'),
        source: { type: /** @type {const} */ ('base64'), media_type: img.mediaType, data: img.data },
      })),
      { type: /** @type {const} */ ('text'), text },
    ];
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system: FIX_ACTUAL_TEXT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text.trim()) {
    throw new Error('The AI did not return any text.');
  }
  return textBlock.text.trim();
}

/** @returns {Promise<import('./types/domain').FixActualTextResult>} */
async function fixActualTextWithCrops(text, crops) {
  try {
    const fixed = await fixActualTextOnce(text, crops);
    return { text: fixed, imageUsed: crops.length > 0 };
  } catch (err) {
    if (crops.length === 0 || !imageRejected(err)) throw err;
    console.error('[ai] provider rejected the page image; retrying Fix with AI with the text alone:', err.message);
    const fixed = await fixActualTextOnce(text, []);
    return { text: fixed, imageUsed: false };
  }
}

// Turns a provider SDK failure into the sentence the renderer should put in
// front of the user - which for an auth failure has to name where the key is
// set, since nothing else in the app will. Anything that isn't an Anthropic
// API error (including the custom-provider path's own already-worded errors)
// comes back untouched, so callers can `throw friendlyProviderError(err)`
// unconditionally.
/** @returns {Error} */
function friendlyProviderError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('That Anthropic API key was rejected. Check it via File > Settings > API Key…');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Rate limited by the Anthropic API - try again in a moment.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error: ${err.message}`);
  }
  return err;
}

ipcMain.handle('ai:fix-actual-text', async (_event, { text, images }) => {
  if (!text || !text.trim()) {
    throw new Error('There is no text to fix.');
  }
  try {
    return await fixActualTextWithCrops(text, sanitizePageCrops(images));
  } catch (err) {
    throw friendlyProviderError(err);
  }
});

// The two tags whose Alt text a picture of the tag itself can actually
// answer for, and what to ask the model for in each case. A Figure wants a
// description of what is depicted; a Formula wants the expression read
// aloud, which is a different job with different failure modes - a model
// told to "describe" an equation tends to say what kind of equation it is
// instead of reading it, which is no use to someone who needs to hear the
// maths. Any other role never gets the button (see
// refreshDetailsForSelection() in renderer/details.js) and falls back to the
// Figure wording here.
const ALT_TEXT_PROMPTS = {
  Figure: {
    system: `You write the alternate text (/Alt) for a figure in a tagged PDF - the description a screen reader speaks in place of a figure its reader cannot see.

You will be given an image of the figure, cropped from the page it sits on. Describe what it shows, leading with the content itself rather than with "image of", "figure showing" or the like - the screen reader already announces that it is a figure. Where the figure carries information - a chart, a diagram, a map, a screenshot - give that information rather than describing the appearance, and transcribe any text in the figure that carries meaning exactly as it is written. Write in the language of the text in the figure, or English if it has none.

Keep it to one or two sentences unless the figure genuinely needs more. Describe only what the image shows: do not guess at the identity of people, places or works unless the figure itself names them, do not infer what the surrounding document says about it, and do not comment on the quality of the image. Reply with only the description and nothing else - no preamble, no explanation, no quotation marks.`,
    // The user turn carried alongside the crop(s). The instructions all live
    // in the system prompt, but both provider paths still want a text part -
    // an image with no text at all reads as an incomplete turn to some
    // OpenAI-compatible endpoints.
    user: 'Write the alternate text for this figure.',
  },
  Formula: {
    system: `You write the alternate text (/Alt) for a formula in a tagged PDF - what a screen reader speaks in place of an equation its reader cannot see.

You will be given an image of the formula, cropped from the page it sits on. Read the expression out in words, the way someone would say it aloud to a listener who has to reconstruct it: words for the operators and for the structure ("the square root of x squared plus y squared", "the integral from zero to infinity of"), and variables, subscripts, superscripts and symbol names exactly as they are written. Make the grouping unambiguous - say where a fraction, a root or a bracketed group begins and ends, rather than leaving a listener to guess what a run of terms belongs to.

Read only what the image shows. Do not name the formula, say what field it comes from, explain what it means, define its variables, or solve it. Where part of the image is illegible, say so in place of that part rather than guessing at it. Reply with only the reading and nothing else - no preamble, no explanation, no quotation marks.`,
    user: 'Write the alternate text for this formula.',
  },
};

/**
 * Writes alt text for a tag from crop(s) of the page region it occupies.
 * Unlike Fix with AI there is no text-only fallback: the image is the entire
 * input, so a provider that won't take one has nothing to answer from.
 * @param {import('./types/domain').PageCrop[]} images
 * @param {string} role The selected tag's role - picks the prompt.
 * @returns {Promise<string>}
 */
async function describeForAltText(images, role) {
  const { system, user } = ALT_TEXT_PROMPTS[role] || ALT_TEXT_PROMPTS.Figure;
  const providerId = getAiProvider();
  if (providerId !== 'anthropic') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig(providerId);
    return customChatCompletion({
      apiKey,
      baseUrl,
      model,
      system,
      prompt: user,
      jsonMode: false,
      maxTokens: 1024,
      images,
    });
  }

  const { apiKey, baseUrl, model } = getAnthropicClientConfig();
  const client = new Anthropic({ apiKey, baseURL: baseUrl });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system,
    // Images ahead of the text, the ordering Anthropic's vision guidance
    // recommends for "here is a document, now do this with it".
    messages: [{
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: /** @type {const} */ ('image'),
          source: { type: /** @type {const} */ ('base64'), media_type: img.mediaType, data: img.data },
        })),
        { type: /** @type {const} */ ('text'), text: user },
      ],
    }],
  });
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text.trim()) {
    throw new Error('The AI did not return any text.');
  }
  return textBlock.text.trim();
}

ipcMain.handle('ai:describe-for-alt-text', async (_event, { images, role }) => {
  const crops = sanitizePageCrops(images);
  if (crops.length === 0) {
    throw new Error("There is no image of this tag's content to send.");
  }
  try {
    return await describeForAltText(crops, role);
  } catch (err) {
    if (imageRejected(err)) {
      throw new Error('The AI provider did not accept the image. Filling Alt text needs a provider and model that can read images - check File > Settings.');
    }
    throw friendlyProviderError(err);
  }
});

// Lays out the table under a Select Content grid: the renderer sends one
// image of the box and the words the text layer places in it, each with an
// id and its position in the image, and gets back the table as rows of
// cells naming those words (see tryTableGridWithAi() in
// renderer/table-grid.js). The model is asked for a reading of the table -
// which words belong together, what spans, what is a header - and not for
// divider positions: it reads a picture far better than it measures one,
// and the renderer derives the dividers from the words' own boxes
// (gridFromProposal() in renderer/table-seed.js), which it can check and
// the user can see. Like alt text, the image is the whole point, so a
// provider that won't take one is an error rather than a text-only retry.
const TableLayoutSchema = z.object({
  rows: z.array(z.object({
    cells: z.array(z.object({
      text: z.string(),
      words: z.array(z.string()),
      colSpan: z.number(),
      rowSpan: z.number(),
      header: z.boolean(),
    })),
  })),
});

// Deliberately generous: a dense scanned table of a few hundred words is the
// normal case, and the renderer refuses a selection past this before asking.
const TABLE_LAYOUT_MAX_WORDS = 2500;

const TABLE_LAYOUT_SYSTEM_PROMPT = `You read the layout of a table from a scanned page, for a tool that tags PDFs for screen readers.

You will be given an image of the table, cropped from the page, and a JSON list of the words the page's text layer places in that region. Each word has an id and its position in the image as x, y, w, h in pixels from the top-left corner. The words are in reading order and their text may carry OCR errors; the image is the truth about where the cells are.

Return the table as rows of cells in reading order, top row first, left to right within a row. Each cell has:
- "text": the cell's text as it reads in the image ("" for an empty cell);
- "words": the ids of the words that belong to the cell, in reading order ([] for an empty cell, or for a cell whose words are missing from the list);
- "colSpan" and "rowSpan": how many columns and rows the cell covers (1 for an ordinary cell);
- "header": true for a header cell - a column heading or a row heading - and false for a data cell.

Rules:
- Every row must add up to the same width, counting the columns that cells spanning down from earlier rows occupy.
- A cell that spans several rows appears only in the first row it covers; a cell that spans several columns appears once, with its colSpan.
- Include empty cells, so that every row has the full width.
- A cell whose text wraps onto several lines is one cell, not one per line.
- Use each word id at most once. Leave out words that are not part of the table, such as a caption or a footnote.
- Do not invent text that is not in the image, and do not correct the words' text - the ids are what matter.`;

// Appended only on the custom-provider path, which has no structured-output
// enforcement (see customChatCompletion()) and needs the shape spelled out.
const TABLE_LAYOUT_JSON_INSTRUCTION = `Respond with only a single JSON object of the exact form {"rows":[{"cells":[{"text":"...","words":["w1","w2"],"colSpan":1,"rowSpan":1,"header":true}]}]} - no markdown code fences, no explanation, no other text before or after the JSON.`;

/**
 * @param {import('./types/domain').PageCrop} image
 * @param {import('./types/domain').TableLayoutWord[]} words
 * @returns {Promise<import('./types/domain').TableLayoutProposal>}
 */
async function layoutTableWithAi(image, words) {
  const payload = `Words in the image:\n${JSON.stringify(words)}`;
  const providerId = getAiProvider();
  if (providerId !== 'anthropic') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig(providerId);
    const content = await customChatCompletion({
      apiKey,
      baseUrl,
      model,
      system: `${TABLE_LAYOUT_SYSTEM_PROMPT}\n\n${TABLE_LAYOUT_JSON_INSTRUCTION}`,
      prompt: payload,
      jsonMode: true,
      maxTokens: 16000,
      images: [image],
    });
    let parsed;
    try {
      parsed = parseJsonReply(content);
    } catch (err) {
      throw new Error(`The custom AI endpoint's reply could not be read as a table: ${err.message}`);
    }
    const validation = TableLayoutSchema.safeParse(parsed);
    if (!validation.success) {
      throw new Error("The custom AI endpoint's reply did not match the expected {rows: [{cells: [...]}]} shape.");
    }
    return validation.data;
  }

  const { apiKey, baseUrl, model } = getAnthropicClientConfig();
  const client = new Anthropic({ apiKey, baseURL: baseUrl });
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(TableLayoutSchema) },
    system: TABLE_LAYOUT_SYSTEM_PROMPT,
    // The image ahead of the text, as the other vision handlers order it.
    messages: [{
      role: 'user',
      content: [
        {
          type: /** @type {const} */ ('image'),
          source: { type: /** @type {const} */ ('base64'), media_type: image.mediaType, data: image.data },
        },
        { type: /** @type {const} */ ('text'), text: payload },
      ],
    }],
  });
  if (!response.parsed_output) {
    throw new Error('The AI did not return a table layout.');
  }
  return response.parsed_output;
}

ipcMain.handle('ai:layout-table', async (_event, { image, words }) => {
  const [crop] = sanitizePageCrops([image]);
  if (!crop) {
    throw new Error('There is no image of the table to send.');
  }
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('There are no words in the grid to send.');
  }
  if (words.length > TABLE_LAYOUT_MAX_WORDS) {
    throw new Error('This selection has too many words to send - draw the table in parts.');
  }
  const cleanWords = words.map((w) => ({
    id: String(w.id), text: String(w.text),
    x: Number(w.x) || 0, y: Number(w.y) || 0, w: Number(w.w) || 0, h: Number(w.h) || 0,
  }));
  try {
    return await layoutTableWithAi(crop, cleanWords);
  } catch (err) {
    if (imageRejected(err)) {
      throw new Error('The AI provider did not accept the image. Try with AI needs a provider and model that can read images - check File > Settings.');
    }
    throw friendlyProviderError(err);
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

// A reply that failed to parse as JSON, or parsed but didn't match the
// expected shape, is marked splittable the same as an explicit
// context-length error (see isSplittableBatchError() below) - on a large
// chunk it's more often the model running out of its output budget
// mid-generation (truncating the JSON) or losing the format across many
// items in one go than the model being fundamentally unable to produce it,
// and a smaller chunk tends to fix both.
/** @param {string} message @returns {Error & { batchSplitRetryable: true }} */
function malformedReplyError(message) {
  return Object.assign(new Error(message), { batchSplitRetryable: /** @type {true} */ (true) });
}

// Guards against a reply that's individually well-formed JSON, matching the
// {items: [{id, text}]} shape, but wrong in a way the shape check alone
// can't catch: the model dropping, duplicating, or fabricating a tag id -
// e.g. merging two entries' text under one id and silently shifting every
// id after it to the wrong tag, which is otherwise invisible until someone
// reviews the saved PDF by hand. Neither provider's guarantees rule this
// out (Anthropic's structured-output support constrains shape, not
// content), so both check every result id against the request's before the
// reply is trusted enough to write into the PDF - see the two call sites in
// ai:fix-actual-text-batch below.
function validateBatchResultIds(requestedItems, resultItems) {
  const requestedIds = new Set(requestedItems.map((item) => item.id));
  const seen = new Set();
  let duplicateCount = 0;
  let unknownCount = 0;
  for (const result of resultItems) {
    if (!requestedIds.has(result.id)) unknownCount++;
    else if (seen.has(result.id)) duplicateCount++;
    seen.add(result.id);
  }
  const missingCount = [...requestedIds].filter((id) => !seen.has(id)).length;
  if (missingCount > 0 || duplicateCount > 0 || unknownCount > 0) {
    throw malformedReplyError(
      `The AI's reply didn't account for every tag one-to-one (${missingCount} missing, ${duplicateCount} duplicated, ${unknownCount} unrecognized) - discarding it rather than risk writing mismatched Actual Text.`,
    );
  }
}

// One batch-fix request to the custom endpoint for exactly this set of
// items - no splitting. Factored out of customBatchFixWithSplit() below so
// each half of a split goes through the same request/parse/validate path as
// the initial whole-document attempt. max_tokens is sized to the chunk
// itself (not a fixed constant) so a split into smaller chunks also asks for
// less output - see the comment on customChatCompletion() for why that
// matters.
async function customBatchFixChunk(apiKey, baseUrl, model, items) {
  const payload = JSON.stringify(items);
  // Corrected text runs close to the same length as the input, plus JSON
  // overhead - /2 (rather than the ~4 chars/token a token roughly costs)
  // leaves a generous safety margin against undercounting.
  const maxTokens = Math.min(16000, Math.max(1024, Math.ceil(payload.length / 2)));
  const content = await customChatCompletion({
    apiKey,
    baseUrl,
    model,
    system: `${FIX_ACTUAL_TEXT_BATCH_SYSTEM_PROMPT}\n\n${FIX_ACTUAL_TEXT_BATCH_JSON_INSTRUCTION}`,
    prompt: payload,
    jsonMode: true,
    maxTokens,
  });
  let parsed;
  try {
    parsed = parseJsonReply(content);
  } catch (err) {
    throw malformedReplyError(err.message);
  }
  const validation = BatchFixResultSchema.safeParse(parsed);
  if (!validation.success) {
    throw malformedReplyError("The custom AI endpoint's reply did not match the expected {items: [{id, text}]} shape.");
  }
  validateBatchResultIds(items, validation.data.items);
  return validation.data.items;
}

function isSplittableBatchError(err) {
  return err.batchSplitRetryable === true || isContextLengthError(err.message);
}

// Tries the whole batch as one request; on a context-length-exceeded error,
// or a reply that didn't parse/match the expected shape (see
// isSplittableBatchError() above), halves `items` and retries each half the
// same way, recursively, until it succeeds. Sequential rather than parallel
// halves - kinder to a shared endpoint (e.g. a university's rate-limited
// gateway) than fanning out concurrent requests. Bottoms out at a single
// item so one entry that genuinely can't be handled (too large, or the
// model just can't produce valid JSON for it) surfaces its own clear error
// instead of splitting forever. This does mean a split document loses some
// of the cross-entry consistency the whole-document batch is meant to give
// (see the comment above BatchFixResultSchema) - an unavoidable tradeoff
// once a chunk that small still doesn't succeed in one request.
async function customBatchFixWithSplit(apiKey, baseUrl, model, items) {
  try {
    return await customBatchFixChunk(apiKey, baseUrl, model, items);
  } catch (err) {
    if (items.length <= 1 || !isSplittableBatchError(err)) throw err;
    const mid = Math.ceil(items.length / 2);
    const first = await customBatchFixWithSplit(apiKey, baseUrl, model, items.slice(0, mid));
    const second = await customBatchFixWithSplit(apiKey, baseUrl, model, items.slice(mid));
    return [...first, ...second];
  }
}

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

  if (provider !== 'anthropic') {
    const { apiKey, baseUrl, model } = requireCustomProviderConfig(provider);
    resultItems = await customBatchFixWithSplit(apiKey, baseUrl, model, items);
  } else {
    const { apiKey, baseUrl, model } = getAnthropicClientConfig();
    const client = new Anthropic({ apiKey, baseURL: baseUrl });
    try {
      // Streamed rather than a plain .parse() call - a full-document batch
      // can need well beyond the ~16K non-streaming ceiling, and large
      // max_tokens requires streaming to avoid an HTTP timeout.
      const stream = client.messages.stream({
        model,
        max_tokens: 64000,
        output_config: { effort: 'medium', format: zodOutputFormat(BatchFixResultSchema) },
        system: FIX_ACTUAL_TEXT_BATCH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: payload }],
      });
      const response = await stream.finalMessage();
      if (!response.parsed_output) {
        throw new Error('The AI did not return a valid response.');
      }
      validateBatchResultIds(items, response.parsed_output.items);
      resultItems = response.parsed_output.items;
    } catch (err) {
      throw friendlyProviderError(err);
    }
  }

  // Only successful runs go into the log - a run that errored out (e.g. rate
  // limited partway through) doesn't reflect how long a normal request of
  // this size actually takes, and would skew future estimates.
  recordAiBatchTiming(payload.length, Date.now() - startedAt, provider);
  return resultItems;
});
