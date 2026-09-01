// walk.js
//
// Walk mode - auto-advances the tag selection down the tree at a
// user-settable rate, for reviewing a document tag by tag.

import { selectNode } from './tree-view.js';
import { el, selectableRows } from './dom.js';
import { setStatus } from './shell.js';
import { WALK_SPEED_MAX, WALK_SPEED_MIN, WALK_SPEED_STEP, saveWalkSpeed, state } from './state.js';

function getWalkRows() {
  return selectableRows();
}

function updateWalkButtonUI() {
  el.btnWalk.textContent = state.walking ? 'Stop Walk' : 'Walk';
  el.btnWalk.classList.toggle('btn-walk-active', state.walking);
}

export function startWalking() {
  if (state.walking) return;
  const rows = getWalkRows();
  if (rows.length === 0) return;

  if (!state.selectedNodeId || !rows.some((r) => r.dataset.nodeId === state.selectedNodeId)) {
    selectNode(rows[0].dataset.nodeId);
  }

  state.walking = true;
  updateWalkButtonUI();
  setStatus(`Walking at ${state.walkSpeed}/sec…`);
  scheduleWalkTick();
}

export function stopWalking() {
  if (!state.walking) return;
  state.walking = false;
  if (state.walkTimerId !== null) {
    clearTimeout(state.walkTimerId);
    state.walkTimerId = null;
  }
  updateWalkButtonUI();
}

function scheduleWalkTick() {
  if (state.walkTimerId !== null) clearTimeout(state.walkTimerId);
  state.walkTimerId = setTimeout(walkTick, 1000 / state.walkSpeed);
}

function walkTick() {
  if (!state.walking) return;
  const rows = getWalkRows();
  const currentIndex = rows.findIndex((r) => r.dataset.nodeId === state.selectedNodeId);
  const nextIndex = currentIndex + 1;
  if (currentIndex === -1 || nextIndex >= rows.length) {
    stopWalking();
    setStatus(currentIndex === -1 ? 'Walk stopped.' : 'Walk finished.');
    return;
  }
  selectNode(rows[nextIndex].dataset.nodeId);
  scheduleWalkTick();
}

export function adjustWalkSpeed(direction) {
  const next = Math.min(WALK_SPEED_MAX, Math.max(WALK_SPEED_MIN, state.walkSpeed + direction * WALK_SPEED_STEP));
  if (next === state.walkSpeed) return;
  state.walkSpeed = next;
  saveWalkSpeed(next);
  setStatus(`Walk speed: ${next}/sec`);
  if (state.walking) scheduleWalkTick(); // apply the new rate starting from the next tick
}
