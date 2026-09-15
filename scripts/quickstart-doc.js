#!/usr/bin/env node
'use strict';

/**
 * QUICKSTART.md is the one source for the quick-start tutorial. Two things are
 * built from it, and this script is what keeps them honest:
 *
 *   node scripts/quickstart-doc.js import          # -> the Quickstart dialog in renderer/index.html
 *   node scripts/quickstart-doc.js check           # exit 1 if that dialog is out of date
 *   node scripts/quickstart-doc.js blocks <file>   # -> parsed JSON for make-quickstart-pdf.py
 *
 * The third mode exists so the PDF builder doesn't have to parse Markdown a
 * second time in Python and drift from what the dialog shows. Run the whole
 * chain with `npm run quickstart`.
 *
 * Deliberately a parser for the Markdown QUICKSTART.md actually uses, not for
 * Markdown at large: ATX headings, paragraphs, ordered/unordered lists nested
 * one level, and inline bold/italic/code. Anything else in the file is a
 * mistake worth failing on rather than silently half-rendering, so unhandled
 * shapes throw.
 *
 * Sibling of scripts/help-doc.js, which does the same job for the Help dialog
 * in the other direction (that one's source of truth is the HTML). The entity
 * table and inline handling are deliberately the same shape as that script's.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MD_FILE = path.join(ROOT, 'QUICKSTART.md');
const HTML_FILE = path.join(ROOT, 'renderer', 'index.html');

const OPEN_TAG = '<div id="quickstart-body" class="help-body" tabindex="-1">';

// Punctuation written as real characters in the Markdown, and the entity each
// becomes in the HTML. Same idea as help-doc.js's table, plus the curly quotes
// QUICKSTART.md is written with.
const ENTITIES = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&hellip;', '…'],
  ['&ldquo;', '“'],
  ['&rdquo;', '”'],
  ['&lsquo;', '‘'],
  ['&rsquo;', '’'],
  ['&times;', '×'],
];

/* ------------------------------------------------------------------ parse */

// A backslash escape (QUICKSTART.md has plenty: \!, \>, \*\*, \+) must survive
// the inline pass without being read as formatting, so each one is lifted out
// and put back as a literal afterwards.
const ESC = '';

function parseInline(md) {
  const literals = [];
  const stash = (char) => `${ESC}${literals.push(char) - 1}${ESC}`;

  const protectedMd = md.replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, (_, char) => stash(char));

  /** @type {{text: string, style: string}[]} */
  const runs = [];
  const push = (text, style) => {
    if (!text) return;
    const restored = text.replace(new RegExp(`${ESC}(\\d+)${ESC}`, 'g'), (_, i) => literals[Number(i)]);
    if (!restored) return;
    const last = runs[runs.length - 1];
    if (last && last.style === style) last.text += restored;
    else runs.push({ text: restored, style });
  };

  // One pass over the three inline markers. Nesting them isn't supported (and
  // isn't used), so the first opener wins and its run ends at its closer.
  const re = /\*\*([\s\S]+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|`([^`]+)`/g;
  let at = 0;
  let m;
  while ((m = re.exec(protectedMd)) !== null) {
    push(protectedMd.slice(at, m.index), 'plain');
    if (m[1] !== undefined) push(m[1], 'bold');
    else if (m[2] !== undefined) push(m[2], 'italic');
    else push(m[3], 'code');
    at = m.index + m[0].length;
  }
  push(protectedMd.slice(at), 'plain');
  return runs;
}

const ORDERED_RE = /^(\d+)[.)]\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;

function listMarker(line) {
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return { ordered: true, text: ordered[2] };
  const bullet = BULLET_RE.exec(line);
  if (bullet) return { ordered: false, text: bullet[1] };
  return null;
}

/**
 * Markdown -> blocks. A block is one of:
 *   { type: 'heading', level, runs }
 *   { type: 'para', runs }
 *   { type: 'list', ordered, items: [{ runs, children: <list blocks> }] }
 */
function parseBlocks(rawMd) {
  const md = rawMd.replace(/\r\n/g, '\n').replace(/^<!--[\s\S]*?-->\s*/, '');
  // A trailing double space is Markdown's hard line break; every block here is
  // reflowed anyway, so the distinction carries nothing.
  const lines = md.split('\n').map((line) => line.replace(/\s+$/, ''));

  const blocks = [];
  let i = 0;

  const indentOf = (line) => line.length - line.trimStart().length;

  // Reads one list - items at `indent`, plus any deeper list under an item -
  // and returns it. It calls itself for the deeper level, so nesting costs
  // nothing here beyond the indent bookkeeping.
  const readList = (indent) => {
    const first = listMarker(lines[i].trimStart());
    const list = { type: 'list', ordered: first.ordered, items: [] };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line ends the list unless the next non-blank line is another
        // item at this level or deeper.
        let peek = i;
        while (peek < lines.length && !lines[peek].trim()) peek += 1;
        if (peek >= lines.length) break;
        if (indentOf(lines[peek]) < indent || !listMarker(lines[peek].trimStart())) break;
        i = peek;
        continue;
      }
      const at = indentOf(line);
      if (at < indent) break;
      const marker = listMarker(line.trimStart());
      if (!marker) {
        // A continuation line of the item above, indented under it.
        if (!list.items.length) throw new Error(`Indented text with no list item above it: ${line}`);
        const item = list.items[list.items.length - 1];
        item.text = `${item.text} ${line.trim()}`;
        i += 1;
        continue;
      }
      if (at >= indent + 2) {
        if (!list.items.length) throw new Error(`Nested list with no parent item: ${line}`);
        list.items[list.items.length - 1].children.push(readList(at));
        continue;
      }
      list.items.push({ text: marker.text, children: [] });
      i += 1;
    }
    return list;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, runs: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }

    if (listMarker(line.trimStart())) {
      blocks.push(readList(indentOf(line)));
      continue;
    }

    if (/^(```|>|\||!\[|<)/.test(line.trim())) {
      throw new Error(`QUICKSTART.md uses a Markdown feature this script doesn't handle: ${line}`);
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !listMarker(lines[i].trimStart()) && !/^#{1,6}\s/.test(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'para', runs: parseInline(paragraph.join(' ')) });
  }

  // List items still hold raw Markdown at this point: their text can grow by a
  // continuation line while readList() is still running, so the inline pass
  // over them waits until the whole document has been read.
  const finishItems = (list) => {
    for (const item of list.items) {
      item.runs = parseInline(item.text);
      delete item.text;
      item.children.forEach(finishItems);
    }
  };
  blocks.filter((b) => b.type === 'list').forEach(finishItems);
  return blocks;
}

/* ---------------------------------------------------------- blocks -> html */

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeEntities(html) {
  let out = html;
  for (const [entity, char] of ENTITIES) {
    if (char === '&' || char === '<' || char === '>') continue; // escapeText did these
    out = out.split(char).join(entity);
  }
  return out;
}

function runsToHtml(runs) {
  return runs
    .map(({ text, style }) => {
      const escaped = encodeEntities(escapeText(text));
      if (style === 'bold') return `<strong>${escaped}</strong>`;
      if (style === 'italic') return `<em>${escaped}</em>`;
      if (style === 'code') return `<code>${escaped}</code>`;
      return escaped;
    })
    .join('');
}

// Takes the file's own line ending rather than assuming one: index.html is
// CRLF, and a nested list joined with bare newlines would leave it mixed.
function listToHtml(list, indent, eol) {
  const pad = ' '.repeat(indent);
  const tag = list.ordered ? 'ol' : 'ul';
  const lines = [`${pad}<${tag} class="quickstart-list">`];
  for (const item of list.items) {
    const inner = item.children.map((child) => listToHtml(child, indent + 4, eol));
    if (inner.length) {
      lines.push(`${pad}  <li>${runsToHtml(item.runs)}`, ...inner, `${pad}  </li>`);
    } else {
      lines.push(`${pad}  <li>${runsToHtml(item.runs)}</li>`);
    }
  }
  lines.push(`${pad}</${tag}>`);
  return lines.join(eol);
}

/**
 * The dialog's own heading already says "Quick Start", so the document's h1 is
 * dropped; h2 opens a section (matching the Help dialog's .help-section/h3),
 * and h3 becomes a sub-heading inside one.
 */
function blocksToHtml(blocks, eol) {
  const sections = [];
  let current = null;

  const open = (headingHtml) => {
    current = headingHtml ? [`        ${headingHtml}`] : [];
    sections.push(current);
  };

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1) continue;
    if (block.type === 'heading' && block.level === 2) {
      open(`<h3>${runsToHtml(block.runs)}</h3>`);
      continue;
    }
    if (!current) open(null); // the lead paragraphs, before the first "##"
    if (block.type === 'heading') {
      current.push(`        <h4 class="quickstart-subhead">${runsToHtml(block.runs)}</h4>`);
    } else if (block.type === 'para') {
      current.push(`        <p>${runsToHtml(block.runs)}</p>`);
    } else {
      current.push(listToHtml(block, 8, eol));
    }
  }

  const rendered = sections
    .map((lines) => ['      <section class="help-section">', ...lines, '      </section>'].join(eol))
    .join(eol + eol);
  return `${eol}${rendered}${eol}    `;
}

/* ------------------------------------------------------------------- main */

function readDialogBlock(html) {
  const start = html.indexOf(OPEN_TAG);
  if (start === -1) throw new Error(`Could not find ${OPEN_TAG} in ${HTML_FILE}`);
  const innerStart = start + OPEN_TAG.length;
  const dialogEnd = html.indexOf('</dialog>', innerStart);
  if (dialogEnd === -1) throw new Error('Could not find the </dialog> closing the quickstart dialog');
  const innerEnd = html.lastIndexOf('</div>', dialogEnd);
  if (innerEnd === -1 || innerEnd < innerStart) throw new Error('Could not find the </div> closing #quickstart-body');
  return { innerStart, innerEnd, inner: html.slice(innerStart, innerEnd) };
}

const mode = process.argv[2];
const blocks = parseBlocks(fs.readFileSync(MD_FILE, 'utf8'));

if (mode === 'blocks') {
  const out = process.argv[3];
  if (!out) {
    console.error('Usage: node scripts/quickstart-doc.js blocks <output.json>');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(blocks, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, path.resolve(out))} (${blocks.length} blocks)`);
} else if (mode === 'import' || mode === 'check') {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const block = readDialogBlock(html);
  const inner = blocksToHtml(blocks, eol);
  if (mode === 'check') {
    if (inner !== block.inner) {
      console.error('The Quickstart dialog is out of date - run: npm run quickstart');
      process.exit(1);
    }
    console.log('The Quickstart dialog matches QUICKSTART.md.');
  } else if (inner === block.inner) {
    console.log('Quickstart dialog already matches QUICKSTART.md - nothing to do.');
  } else {
    fs.writeFileSync(HTML_FILE, html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd));
    console.log(`Updated the Quickstart dialog in ${path.relative(ROOT, HTML_FILE)}`);
  }
} else {
  console.error('Usage: node scripts/quickstart-doc.js <import|check|blocks>');
  process.exit(2);
}
