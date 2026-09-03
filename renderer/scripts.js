// scripts.js
//
// Tools > Scripts…: lets the user chain the five toolbar actions below into
// a named, reorderable sequence, save/name several such scripts, and assign
// one of them to the toolbar's "Run Script" button. Scripts are persisted
// via window.api.get/setScripts() and get/setActiveScriptId() (settings.json
// in the main process, see main.js) so both the saved scripts and which one
// is assigned survive a restart.
//
// Each action here defers to the same function a toolbar button uses (see
// actions.js) - a script step and its button always do exactly the same
// thing. Find/Replace is the one action with per-step configuration (which
// tag type to find and replace with), so a script can hold several
// differently-configured Find/Replace steps.

import { runFindReplaceAll, runFixAllActualTextAi, runFlattenAll, runScopeTables, runSmartifact } from './actions.js';
import { el } from './dom.js';
import { reportError, setStatus } from './shell.js';
import { state } from './state.js';

/** @type {{ type: import('../types/domain').ScriptStep['type'], label: string, hint: string }[]} */
export const ACTION_DEFS = [
  { type: 'smartifact', label: 'Smartifact', hint: 'Artifact full-page image leaves that are the same size as their page' },
  { type: 'scope-tables', label: 'Scope Tables', hint: "Set Row/Column/Both scope on every table's TH cells based on its header shape" },
  { type: 'flatten-all', label: 'Flatten All', hint: 'Remove organizational tags (Div/Sect/Part/Span) from the whole document' },
  { type: 'find-replace', label: 'Find/Replace', hint: 'Relabel every tag of one type to another' },
  { type: 'fix-actual-text-ai', label: 'Fix All Actual Text (AI)', hint: "Send every tag's Actual Text to AI together for document-wide consistency" },
];

/** @type {import('../types/domain').Script[]} */
let scripts = [];
/** @type {string | null} */
let activeScriptId = null;
/** The script id currently open in the builder, or null while building a new, unsaved script. */
let editingScriptId = null;
/** @type {import('../types/domain').ScriptStep[]} */
let builderSteps = [];

/**
 * Loads saved scripts and the active-script assignment from settings.json.
 * Called once at renderer startup so the toolbar button's enabled state and
 * tooltip are correct before the Scripts dialog has ever been opened, and
 * again whenever the dialog opens in case another window/session changed
 * them (there is only ever one window today, but this is cheap either way).
 */
export async function loadScripts() {
  scripts = await window.api.getScripts();
  activeScriptId = await window.api.getActiveScriptId();
}

/** Reflects whether a script can currently run in the toolbar button's disabled state and tooltip. */
export function updateRunScriptButtonState() {
  const script = scripts.find((s) => s.id === activeScriptId) || null;
  el.btnRunScript.disabled = !state.docId || !state.hasStructTree || !script;
  el.btnRunScript.title = script
    ? `Run "${script.name}" (${script.steps.length} step${script.steps.length === 1 ? '' : 's'}) - assigned via Tools > Scripts…`
    : 'Run the script assigned via Tools > Scripts…';
}

// --- builder ----------------------------------------------------------

function resetBuilder() {
  editingScriptId = null;
  builderSteps = [];
  el.scriptsName.value = '';
  el.scriptsSetActive.checked = false;
  renderSteps();
}

/** @param {import('../types/domain').Script} script */
function loadScriptIntoBuilder(script) {
  editingScriptId = script.id;
  el.scriptsName.value = script.name;
  builderSteps = script.steps.map((step) => ({ ...step }));
  el.scriptsSetActive.checked = script.id === activeScriptId;
  renderSteps();
}

function refreshScriptsSelect() {
  el.scriptsSelect.innerHTML = '';
  const newOption = document.createElement('option');
  newOption.value = '';
  newOption.textContent = 'New Script…';
  el.scriptsSelect.appendChild(newOption);
  for (const script of scripts) {
    const option = document.createElement('option');
    option.value = script.id;
    option.textContent = script.name;
    el.scriptsSelect.appendChild(option);
  }
  el.scriptsSelect.value = editingScriptId || '';
}

function renderPalette() {
  el.scriptsPaletteList.innerHTML = '';
  for (const def of ACTION_DEFS) {
    const li = document.createElement('li');
    li.className = 'scripts-palette-item';
    const label = document.createElement('span');
    label.textContent = def.label;
    label.title = def.hint;
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost';
    addBtn.textContent = 'Add →';
    addBtn.addEventListener('click', () => addStep(def.type));
    li.append(label, addBtn);
    el.scriptsPaletteList.appendChild(li);
  }
}

function renderSteps() {
  el.scriptsStepList.innerHTML = '';
  el.scriptsStepsEmpty.hidden = builderSteps.length > 0;
  builderSteps.forEach((step, index) => {
    const def = ACTION_DEFS.find((d) => d.type === step.type);
    const li = document.createElement('li');
    li.className = 'scripts-step';

    const main = document.createElement('div');
    main.className = 'scripts-step-main';
    const indexSpan = document.createElement('span');
    indexSpan.className = 'scripts-step-index';
    indexSpan.textContent = `${index + 1}.`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'scripts-step-name';
    nameSpan.textContent = def ? def.label : step.type;
    main.append(indexSpan, nameSpan);

    if (step.type === 'find-replace') {
      main.appendChild(buildFindReplaceStepConfig(step));
    }

    const controls = document.createElement('div');
    controls.className = 'scripts-step-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn btn-ghost';
    upBtn.textContent = '↑';
    upBtn.title = 'Move up';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveStep(step.id, -1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn btn-ghost';
    downBtn.textContent = '↓';
    downBtn.title = 'Move down';
    downBtn.disabled = index === builderSteps.length - 1;
    downBtn.addEventListener('click', () => moveStep(step.id, 1));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove step';
    removeBtn.addEventListener('click', () => removeStep(step.id));

    controls.append(upBtn, downBtn, removeBtn);
    li.append(main, controls);
    el.scriptsStepList.appendChild(li);
  });
}

/** @param {import('../types/domain').ScriptStep} step */
function buildFindReplaceStepConfig(step) {
  const config = document.createElement('div');
  config.className = 'scripts-step-config';

  const findInput = document.createElement('input');
  findInput.setAttribute('list', 'role-options');
  findInput.placeholder = 'Find e.g. P';
  findInput.autocomplete = 'off';
  findInput.spellcheck = false;
  findInput.value = step.findRole || '';
  findInput.addEventListener('input', () => { step.findRole = findInput.value; });

  const arrow = document.createElement('span');
  arrow.textContent = '→';

  const replaceInput = document.createElement('input');
  replaceInput.setAttribute('list', 'role-options');
  replaceInput.placeholder = 'Replace e.g. Span';
  replaceInput.autocomplete = 'off';
  replaceInput.spellcheck = false;
  replaceInput.value = step.replaceRole || '';
  replaceInput.addEventListener('input', () => { step.replaceRole = replaceInput.value; });

  config.append(findInput, arrow, replaceInput);
  return config;
}

/** @param {import('../types/domain').ScriptStep['type']} type */
function addStep(type) {
  builderSteps.push({ id: crypto.randomUUID(), type, findRole: '', replaceRole: '' });
  renderSteps();
}

/**
 * @param {string} id
 * @param {number} direction -1 to move up, 1 to move down
 */
function moveStep(id, direction) {
  const index = builderSteps.findIndex((s) => s.id === id);
  if (index === -1) return;
  const swapWith = index + direction;
  if (swapWith < 0 || swapWith >= builderSteps.length) return;
  [builderSteps[index], builderSteps[swapWith]] = [builderSteps[swapWith], builderSteps[index]];
  renderSteps();
}

/** @param {string} id */
function removeStep(id) {
  builderSteps = builderSteps.filter((s) => s.id !== id);
  renderSteps();
}

// --- dialog lifecycle / persistence ------------------------------------

/**
 * Opens the Scripts dialog, loading whatever's currently assigned to the
 * Run Script button into the builder (or the first saved script, or a
 * blank new one) so there's usually something useful on screen right away.
 */
export async function openScriptsDialog() {
  await loadScripts();
  renderPalette();
  const initial = scripts.find((s) => s.id === activeScriptId) || scripts[0] || null;
  if (initial) loadScriptIntoBuilder(initial);
  else resetBuilder();
  refreshScriptsSelect();
  el.scriptsStatus.textContent = ' ';
  el.scriptsDialog.showModal();
}

/** @param {string} id */
export function selectScriptForEditing(id) {
  const script = scripts.find((s) => s.id === id);
  if (script) loadScriptIntoBuilder(script);
  else resetBuilder();
  el.scriptsStatus.textContent = ' ';
}

export function newScript() {
  resetBuilder();
  refreshScriptsSelect();
  el.scriptsStatus.textContent = ' ';
  el.scriptsName.focus();
}

export async function saveCurrentScript() {
  const name = el.scriptsName.value.trim();
  if (!name) {
    el.scriptsStatus.textContent = 'Enter a name for this script.';
    return;
  }
  if (builderSteps.length === 0) {
    el.scriptsStatus.textContent = 'Add at least one step.';
    return;
  }
  for (const step of builderSteps) {
    if (step.type === 'find-replace' && (!step.findRole?.trim() || !step.replaceRole?.trim())) {
      el.scriptsStatus.textContent = 'Fill in both tag types for every Find/Replace step.';
      return;
    }
  }

  const id = editingScriptId || crypto.randomUUID();
  /** @type {import('../types/domain').Script} */
  const script = { id, name, steps: builderSteps.map((step) => ({ ...step })) };
  const index = scripts.findIndex((s) => s.id === id);
  if (index !== -1) scripts[index] = script;
  else scripts.push(script);

  if (el.scriptsSetActive.checked) activeScriptId = id;
  else if (activeScriptId === id) activeScriptId = null;

  await window.api.setScripts(scripts);
  await window.api.setActiveScriptId(activeScriptId);
  editingScriptId = id;
  refreshScriptsSelect();
  updateRunScriptButtonState();
  el.scriptsStatus.textContent = `Saved "${name}".`;
}

export async function deleteCurrentScript() {
  if (!editingScriptId) {
    resetBuilder();
    refreshScriptsSelect();
    return;
  }
  const name = scripts.find((s) => s.id === editingScriptId)?.name || 'Script';
  scripts = scripts.filter((s) => s.id !== editingScriptId);
  if (activeScriptId === editingScriptId) activeScriptId = null;
  await window.api.setScripts(scripts);
  await window.api.setActiveScriptId(activeScriptId);
  resetBuilder();
  refreshScriptsSelect();
  updateRunScriptButtonState();
  el.scriptsStatus.textContent = `Deleted "${name}".`;
}

// --- running ------------------------------------------------------------

/** @param {import('../types/domain').ScriptStep} step @returns {Promise<string>} */
async function runScriptStep(step) {
  switch (step.type) {
    case 'smartifact':
      return runSmartifact();
    case 'scope-tables':
      return runScopeTables();
    case 'flatten-all':
      return runFlattenAll();
    case 'find-replace': {
      const { message } = await runFindReplaceAll(step.findRole, step.replaceRole);
      return message;
    }
    case 'fix-actual-text-ai':
      return runFixAllActualTextAi();
    default:
      throw new Error(`Unknown script step type "${step.type}"`);
  }
}

/**
 * Runs every step of the script assigned to the Run Script button, in
 * order, stopping at the first step that throws (a script step reuses the
 * exact same worker calls a toolbar button does, so a failure here - e.g.
 * no AI provider configured for a Fix All Actual Text (AI) step - is the
 * same failure that button would report on its own).
 */
export async function runActiveScript() {
  if (!state.docId) return;
  const script = scripts.find((s) => s.id === activeScriptId);
  if (!script) {
    setStatus('No script assigned - open Tools > Scripts… to build one.');
    return;
  }
  if (script.steps.length === 0) {
    setStatus(`Script "${script.name}" has no steps.`);
    return;
  }

  el.btnRunScript.disabled = true;
  document.body.classList.add('busy');
  try {
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i];
      const def = ACTION_DEFS.find((d) => d.type === step.type);
      setStatus(`Running "${script.name}" - step ${i + 1}/${script.steps.length}: ${def ? def.label : step.type}…`);
      await runScriptStep(step);
    }
    setStatus(`Script "${script.name}" finished (${script.steps.length} step${script.steps.length === 1 ? '' : 's'}).`);
  } catch (err) {
    reportError(`Script "${script.name}" stopped`, err);
  } finally {
    document.body.classList.remove('busy');
    updateRunScriptButtonState();
  }
}
