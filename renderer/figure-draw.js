// figure-draw.js
//
// The Add Figure tool: drag a rectangle over the page preview to tag that
// region as a /Figure.

import { el } from './dom.js';
import { state } from './state.js';

export function setFigureDrawActive(active) {
  state.figureDrawActive = active;
  el.btnAddFigure.classList.toggle('btn-figure-draw-active', active);
  el.btnAddFigure.textContent = active ? 'End Adding Figures' : 'Add Figures';
  el.canvas.classList.toggle('figure-draw-mode', active);
  if (!active) {
    state.figureDrawRect = null;
    el.drawOverlay.innerHTML = '';
  }
}

export function canvasPointFromEvent(e) {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.canvas.width / rect.width),
    y: (e.clientY - rect.top) * (el.canvas.height / rect.height),
  };
}

export function renderFigureDrawRect(viewportWidth, viewportHeight) {
  el.drawOverlay.innerHTML = '';
  if (!state.figureDrawRect) return;
  const { start, current } = state.figureDrawRect;
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  const box = document.createElement('div');
  box.className = 'draw-box';
  // Same percentage-of-viewport placement as renderHighlightRects(), so the
  // box stays aligned even though the canvas is scaled down by CSS.
  box.style.left = `${(100 * x / viewportWidth).toFixed(3)}%`;
  box.style.top = `${(100 * y / viewportHeight).toFixed(3)}%`;
  box.style.width = `${(100 * width / viewportWidth).toFixed(3)}%`;
  box.style.height = `${(100 * height / viewportHeight).toFixed(3)}%`;
  el.drawOverlay.appendChild(box);
}

// A drag shorter than this (in canvas pixels) is treated as an accidental
// click/jitter rather than a deliberate rectangle.
export const MIN_FIGURE_DRAW_PX = 6;
