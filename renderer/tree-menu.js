// tree-menu.js
//
// The Tag Tree's right-click menu: every tagging shortcut, spelled out with
// the key it is bound to.
//
// The keys themselves are the fast way to work and stay the primary one -
// this is for the user who has not learned them yet, and for the ones that
// are used rarely enough that nobody ever does. Each row prints its current
// key on the right (read from state.tagShortcuts, so a key remapped in
// Preferences is what the menu shows), which makes the menu teach the
// shortcut rather than replace it.
//
// The entries are built from TAG_SHORTCUT_ACTIONS and run through
// applyTagShortcutAction(), so the menu and the keydown handler in
// renderer.js are the same edit with two ways in, not two lists to keep in
// step. Adding an action to TAG_SHORTCUT_ACTIONS puts it in the menu with
// no change here.

import { el } from './dom.js';
import { applyTagShortcutAction, deleteSelection, insertParagraphAfterSelection } from './editing.js';
import { clearRectSelect } from './rect-select.js';
import { TAG_SHORTCUT_ACTIONS, state } from './state.js';
import { selectNode } from './tree-view.js';
import { formatShortcutKey } from './util.js';

// Rules between the groups TAG_SHORTCUT_ACTIONS already falls into:
// headings, then the flow roles, then the table roles, then figure/caption,
// then join. Named by the action a rule follows rather than by index, so an
// action inserted into TAG_SHORTCUT_ACTIONS simply joins the group it was
// listed in instead of shifting a divider onto the wrong row.
const SEPARATOR_AFTER = new Set(['h6', 'listItem', 'th', 'caption']);

// The two tag-tree actions that aren't configurable tagging shortcuts, and
// so aren't in TAG_SHORTCUT_ACTIONS: both act on the same selection and are
// as worth discovering as the rest, so they close the menu as their own
// group. Their keys are fixed, hence the literal labels - except that
// Delete also answers to the Extra Delete/Artifact key when one is set (see
// isDeleteShortcut() in renderer.js), which the menu doesn't try to spell
// out: someone who has gone to the trouble of binding that key is not the
// reader this menu is for.
//
// "Delete/Artifact" because the one key does both, depending on what is
// selected: a tag goes altogether, while a content/object-ref leaf is
// unlinked and its content turned into a real PDF artifact rather than
// discarded (see deleteSelection(), and _artifact_leaves() in
// tag_worker.py). The menu names the same pair the Preferences row for the
// extra key does, so nobody reads "Delete" as "this throws the content
// away".
const FIXED_ITEMS = [
  { label: 'Insert Paragraph After', key: 'Ctrl/Cmd+P', run: insertParagraphAfterSelection },
  { label: 'Delete/Artifact', key: 'Delete', run: deleteSelection },
];

// Where focus goes when the menu is dismissed without running anything -
// the row that was right-clicked, so Esc leaves the keyboard where it was.
// Held as a node id rather than as the element itself: selecting a row
// re-renders the whole tree (see renderTree()), so the original element is
// long gone by the time the menu closes.
let returnFocusNodeId = null;

/** Every enabled item currently in the menu, in display order. */
function menuItems() {
  return /** @type {HTMLButtonElement[]} */ (
    Array.from(el.tagTreeContextMenu.querySelectorAll('.context-menu-item'))
  );
}

/**
 * Opens the menu over the tag-tree row under `e`, if there is one.
 *
 * Wired to the tag-tree pane as a whole rather than to each row, so it
 * survives the tree being torn down and rebuilt on every selection change.
 * A right-click that isn't on a selectable row - the Document root row,
 * which has no role of its own to set, or the empty space below the tree -
 * opens nothing and is left to the browser, which shows no menu of its own.
 *
 * @param {MouseEvent} e
 */
export function openTagTreeContextMenu(e) {
  const target = /** @type {HTMLElement | null} */ (e.target);
  const row = /** @type {HTMLElement | null} */ (target?.closest('.tree-row.selectable'));
  if (!row || !row.dataset.nodeId) return;

  e.preventDefault();
  const nodeId = row.dataset.nodeId;
  // Measured before anything below can select, and so re-render, the tree -
  // the row element `anchorFor` falls back to is replaced by that rebuild,
  // and a detached element reports a rectangle at the origin.
  const anchor = anchorFor(e, row);

  // Right-clicking outside the current selection selects that one tag
  // first, the way every tree does - the menu then acts on what the user
  // can see is selected. Right-clicking inside a multi-tag selection leaves
  // it alone, so the menu can act on the whole block.
  if (!state.selectedNodeIds.has(nodeId)) selectNode(nodeId);

  // A rectangle selection waiting on the page for a role keystroke would
  // otherwise claim the keys this menu prints (see the tagging-shortcut
  // handler in renderer.js, which answers it first), leaving the menu and
  // its own key labels meaning two different things at once. Going to the
  // tree and right-clicking a tag is abandoning that selection, so it is
  // dropped here rather than left to disagree.
  if (state.rectSelectPending?.length || state.tableGrid) clearRectSelect();

  returnFocusNodeId = state.selectedNodeId;
  buildMenu();
  showMenuAt(anchor);
}

// Rebuilt on every open rather than kept around: the keys come from
// state.tagShortcuts, which File > Settings > Preferences can change (or
// clear) between one right-click and the next.
function buildMenu() {
  const menu = el.tagTreeContextMenu;
  menu.replaceChildren();

  for (const action of TAG_SHORTCUT_ACTIONS) {
    const key = state.tagShortcuts[action.id];
    // An unbound action - the user cleared its key in Preferences - still
    // belongs here. The menu is the only way left to reach it, which is
    // exactly when it is worth listing.
    menu.appendChild(buildItem(action.label, key ? formatShortcutKey(key) : '', () => applyTagShortcutAction(action.id)));
    if (SEPARATOR_AFTER.has(action.id)) menu.appendChild(buildSeparator());
  }

  menu.appendChild(buildSeparator());
  for (const item of FIXED_ITEMS) {
    menu.appendChild(buildItem(item.label, item.key, item.run));
  }
}

/** @param {string} label @param {string} key @param {() => void} run */
function buildItem(label, key, run) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-menu-item';
  button.setAttribute('role', 'menuitem');

  const text = document.createElement('span');
  text.className = 'context-menu-label';
  text.textContent = label;
  button.appendChild(text);

  const hint = document.createElement('span');
  hint.className = 'context-menu-key';
  hint.textContent = key;
  // aria-hidden because the key is a hint about another way in, not part of
  // the command's name - a screen reader announcing "Heading 1 1" reads as
  // a stutter, and the same user is not being sold on the mouse anyway.
  hint.setAttribute('aria-hidden', 'true');
  button.appendChild(hint);

  button.addEventListener('click', () => {
    // Closed before the edit runs, not after: every one of these rebuilds
    // the tree and moves the selection, and a menu still floating over the
    // result would be pointing at a row that has already been replaced.
    closeMenu();
    run();
  });
  return button;
}

function buildSeparator() {
  const rule = document.createElement('div');
  rule.className = 'context-menu-separator';
  rule.setAttribute('role', 'separator');
  return rule;
}

// Where the menu's top-left corner wants to be. A mouse right-click gives
// the pointer; the Menu key / Shift+F10 fires the same event with no
// pointer behind it (Chromium reports 0,0), which would otherwise throw the
// menu into the corner of the window - so that case anchors to the row
// instead, where the user is looking.
/** @param {MouseEvent} e @param {HTMLElement} row */
function anchorFor(e, row) {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 16, y: rect.bottom };
}

/** @param {{x: number, y: number}} anchor */
function showMenuAt(anchor) {
  const menu = el.tagTreeContextMenu;
  // Shown before measuring - a hidden element has no size to clamp
  // against - but parked off-screen for that one frame so it can't be seen
  // in the wrong place first.
  menu.style.left = '-9999px';
  menu.style.top = '0';
  menu.hidden = false;

  const { width, height } = menu.getBoundingClientRect();
  const margin = 4;
  // Flipped to the other side of the pointer when it won't fit, then
  // clamped - the flip is what keeps the menu from covering the row it was
  // opened on, and the clamp is the backstop for a window too small for
  // either side. The height is already capped by max-height in the
  // stylesheet, so this only ever has to move the menu, never shrink it.
  let left = anchor.x;
  if (left + width + margin > window.innerWidth) left = anchor.x - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = anchor.y;
  if (top + height + margin > window.innerHeight) top = anchor.y - height;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Focus goes to the first item, so the menu is immediately steerable by
  // keyboard - and, more to the point, so its own keydown handler is in the
  // bubble path of everything typed while it is open. Without that, a bare
  // letter would reach the window-level tagging shortcuts and edit the tag
  // behind the menu (a focused <button> is not one of the INPUT/TEXTAREA/
  // SELECT tags those handlers step aside for).
  menuItems()[0]?.focus();

  // Registered only while the menu is up, and in the capture phase for the
  // pointer so a click that dismisses the menu doesn't also land on
  // whatever it was over.
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('blur', onDismiss);
  // The menu is position: fixed against a pointer that was over the tree,
  // so scrolling the tree slides the row out from under it.
  el.tagTree.addEventListener('scroll', onDismiss);
}

/**
 * Hides the menu and drops its listeners. Safe to call when it is already
 * closed, which is what lets every dismissal path just call it.
 *
 * @param {{restoreFocus?: boolean}} [opts] restoreFocus puts the keyboard
 * back on the selected tag - for a cancel (Esc, a click away), not for a
 * command, which moves the selection itself.
 */
export function closeMenu({ restoreFocus = false } = {}) {
  const menu = el.tagTreeContextMenu;
  if (menu.hidden) return;

  menu.hidden = true;
  menu.replaceChildren();
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('resize', onDismiss);
  window.removeEventListener('blur', onDismiss);
  el.tagTree.removeEventListener('scroll', onDismiss);

  if (restoreFocus && returnFocusNodeId) {
    const row = /** @type {HTMLElement | null} */ (
      el.tagTree.querySelector(`.tree-row.selectable[data-node-id="${CSS.escape(returnFocusNodeId)}"]`)
    );
    row?.focus({ preventScroll: true });
  }
  returnFocusNodeId = null;
}

function onDismiss() {
  closeMenu();
}

/** @param {PointerEvent} e */
function onPointerDown(e) {
  if (el.tagTreeContextMenu.contains(/** @type {Node} */ (e.target))) return;
  closeMenu();
}

// Every key pressed while the menu is open stops here, whether or not the
// menu has a use for it: the app's window-level handlers are listening for
// bare letters and arrows, and they would otherwise act on the tag behind
// the menu. Registered on the menu itself, so it sits in the bubble path
// between the focused item and the window.
//
// Attached once at module load rather than per-open - the menu element is
// static and empty while closed, so nothing can be focused inside it to
// fire this when it isn't showing.
el.tagTreeContextMenu.addEventListener('keydown', (e) => {
  e.stopPropagation();

  const items = menuItems();
  const index = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));

  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeMenu({ restoreFocus: true });
      break;
    case 'ArrowDown':
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
      break;
    case 'ArrowUp':
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
      break;
    case 'Home':
      e.preventDefault();
      items[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      items[items.length - 1]?.focus();
      break;
    case 'Tab':
      // A menu is a modal little thing: tabbing out of it and leaving it
      // floating over the tree is not a state worth having.
      e.preventDefault();
      closeMenu({ restoreFocus: true });
      break;
  }
});

// Right-clicking the menu itself would otherwise fall through to the tag
// tree underneath it and reopen the menu somewhere else.
el.tagTreeContextMenu.addEventListener('contextmenu', (e) => e.preventDefault());
