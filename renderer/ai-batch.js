// ai-batch.js
//
// Progress reporting for long-running AI batch operations - the elapsed
// timer, the estimated range from main.js, and the desktop notification and
// chime that fire when a batch finishes.

import { el } from './dom.js';
import { state } from './state.js';
import { formatDuration } from './util.js';

let aiBatchProgressTimerHandle = null;

export function showAiBatchProgress() {
  clearInterval(aiBatchProgressTimerHandle); // a second show without a hide would otherwise strand the first ticker
  el.aiBatchProgressEstimate.textContent = '(This may take a few minutes…)';
  const startedAt = Date.now();
  el.aiBatchProgressTimer.textContent = formatDuration(0);
  aiBatchProgressTimerHandle = setInterval(() => {
    el.aiBatchProgressTimer.textContent = formatDuration(Date.now() - startedAt);
  }, 1000);
  el.aiBatchProgressDialog.showModal();
  document.body.classList.add('busy-cursor');
}

export function hideAiBatchProgress() {
  clearInterval(aiBatchProgressTimerHandle);
  aiBatchProgressTimerHandle = null;
  el.aiBatchProgressDialog.close();
  document.body.classList.remove('busy-cursor');
}

// The dialog opens before the request payload is known (content still needs
// pulling for tags with no Actual Text yet - see the click handler below),
// so the estimate is filled in separately once it is, rather than blocking
// the dialog's appearance on that. `range` is {lowMs, highMs} from
// window.api.estimateAiBatchTime() (see estimateAiBatchRange() in main.js) -
// shown as a span rather than a single number since it's built from how much
// past runs of a similar size actually varied, not a guaranteed duration.
// null until enough history has built up, in which case the dialog keeps its
// generic hint.
export function updateAiBatchProgressEstimate(range) {
  if (range == null) {
    el.aiBatchProgressEstimate.textContent = '(This may take a few minutes…)';
    return;
  }
  const low = formatDuration(range.lowMs);
  const high = formatDuration(range.highMs);
  el.aiBatchProgressEstimate.textContent = low === high
    ? `Estimated time: ~${low}`
    : `Estimated time: ~${low}–${high}`;
}

// A short two-note chime, synthesized with the Web Audio API rather than
// shipped as an asset file - one less thing to package/license. Reuses a
// single AudioContext across calls since browsers cap how many can be live
// at once.
let chimeAudioCtx = null;

function playChime() {
  try {
    chimeAudioCtx = chimeAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = chimeAudioCtx;
    const now = ctx.currentTime;
    [880, 1318.51].forEach((freq, i) => { // A5 then E6 - a simple pleasant "ding-dong"
      const start = now + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  } catch (err) {
    console.error('Could not play chime', err);
  }
}

// File > Settings > Preferences - called once an AI batch operation (e.g.
// "Fix All Actual Text") finishes, success or failure alike, so the user
// can tell it's done without having to watch the window.
export function notifyAiBatchComplete(message) {
  if (state.notifyChime) playChime();
  if (state.notifyDesktop && typeof Notification !== 'undefined') {
    try {
      if (Notification.permission === 'granted') {
        new Notification('LastMilePDF', { body: message });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') new Notification('LastMilePDF', { body: message });
        });
      }
    } catch (err) {
      console.error('Could not show desktop notification', err);
    }
  }
}
