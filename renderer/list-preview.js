// list-preview.js
//
// Renders a List (L) tag as an HTML list in the details pane - read-only,
// the same idea as table-preview.js but for List/LI/Lbl/LBody structure.

import { el } from './dom.js';
import { pullListBodyParts } from './page-content.js';
import { state } from './state.js';

// Walks a List tag's subtree for its LI descendants, in document order.
// Recurses through wrapper roles (auto-tagging's stray Divs) the same way
// collectTableRows() does for TR, but never descends into a nested List -
// that inner list's items belong to it, not this one (it surfaces instead
// as a nested <ul> inside whichever LI contains it - see buildListElement()
// below).
function collectListItems(listNode) {
  const items = [];
  (function visit(node) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (child.role === 'LI') items.push(child);
      else if (child.role === 'L') continue;
      else visit(child);
    }
  })(listNode);
  return items;
}

// Renders a body's parts (see pullListBodyParts()) into `containerEl`:
// consecutive text parts are joined with a space into one text node, and a
// {list} part flushes that text and appends a nested <ul> in its place.
// Returns false if the selection changed mid-render (stale token).
async function appendListBodyParts(containerEl, parts, token) {
  let textBuf = [];
  const flushText = () => {
    if (textBuf.length) {
      containerEl.appendChild(document.createTextNode(textBuf.join(' ')));
      textBuf = [];
    }
  };
  for (const part of parts) {
    if (part.text) {
      textBuf.push(part.text);
    } else if (part.list) {
      flushText();
      const subUl = await buildListElement(part.list, token);
      if (token !== state.listPreviewToken) return false;
      if (subUl) containerEl.appendChild(subUl);
    }
  }
  flushText();
  return true;
}

async function buildListElement(listNode, token) {
  const ul = document.createElement('ul');
  ul.className = 'generated-list';

  for (const li of collectListItems(listNode)) {
    const liEl = document.createElement('li');
    const lbl = (li.children || []).find((c) => c.type === 'element' && c.role === 'Lbl');

    if (lbl) {
      const labelParts = await pullListBodyParts(lbl);
      if (token !== state.listPreviewToken) return null;
      const labelText = labelParts.filter((p) => p.text).map((p) => p.text).join(' ');
      if (labelText) {
        const labelEl = document.createElement('span');
        labelEl.className = 'generated-list-label';
        labelEl.textContent = labelText;
        liEl.appendChild(labelEl);
      }
    }

    // Everything else under the LI besides its own Lbl - normally just an
    // LBody, but pulled per-child (rather than assuming an LBody wrapper
    // exists) so bare content or a stray nested List directly under the LI
    // still shows up.
    const bodyParts = [];
    for (const child of li.children || []) {
      if (child === lbl) continue;
      bodyParts.push(...(await pullListBodyParts(child)));
      if (token !== state.listPreviewToken) return null;
    }
    const ok = await appendListBodyParts(liEl, bodyParts, token);
    if (!ok) return null;

    ul.appendChild(liEl);
  }
  return ul;
}

export async function renderListPreview(listNode) {
  const token = ++state.listPreviewToken;

  if (collectListItems(listNode).length === 0) {
    el.listPreviewContainer.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'list-preview-empty';
    p.textContent = 'No list items found in this list.';
    el.listPreviewContainer.appendChild(p);
    return;
  }

  const ul = await buildListElement(listNode, token);
  if (token !== state.listPreviewToken) return; // selection changed mid-flight
  el.listPreviewContainer.innerHTML = '';
  if (ul) el.listPreviewContainer.appendChild(ul);
}
