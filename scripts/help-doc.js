#!/usr/bin/env node
'use strict';

/**
 * Round-trips the in-app Help dialog between renderer/index.html and docs/help.md.
 *
 *   node scripts/help-doc.js export   # index.html -> docs/help.md
 *   node scripts/help-doc.js import   # docs/help.md -> index.html
 *   node scripts/help-doc.js check    # exit 1 if docs/help.md is out of date
 *
 * The Markdown shape mirrors the HTML one-for-one:
 *   ## Heading            ->  <section class="help-section"><h3>
 *   plain paragraph       ->  <p>
 *   Term                  ->  <div class="help-item"><dt>Term</dt>
 *   : Definition          ->  <dd>Definition</dd></div>   (runs of these become one <dl>)
 * Inline **bold**, *italic* and `code` map to strong/em/code; <kbd> stays literal HTML
 * because Markdown has no equivalent. Punctuation is written as real characters in the
 * Markdown and re-encoded as HTML entities on the way back in.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'renderer', 'index.html');
const MD_FILE = path.join(ROOT, 'docs', 'help.md');

const OPEN_TAG = '<div id="help-body" class="help-body" tabindex="-1">';

// Entities used in the help block, and the characters they stand for.
const ENTITIES = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&hellip;', '…'],
  ['&uarr;', '↑'],
  ['&darr;', '↓'],
  ['&larr;', '←'],
  ['&rarr;', '→'],
  ['&times;', '×'],
  ['&nbsp;', ' '],
];

/* ---------------------------------------------------------------- extract */

function readHelpBlock(html) {
  const start = html.indexOf(OPEN_TAG);
  if (start === -1) throw new Error(`Could not find ${OPEN_TAG} in ${HTML_FILE}`);
  const innerStart = start + OPEN_TAG.length;
  const dialogEnd = html.indexOf('</dialog>', innerStart);
  if (dialogEnd === -1) throw new Error('Could not find the </dialog> closing the help dialog');
  const innerEnd = html.lastIndexOf('</div>', dialogEnd);
  if (innerEnd === -1 || innerEnd < innerStart) throw new Error('Could not find the </div> closing #help-body');
  return { innerStart, innerEnd, inner: html.slice(innerStart, innerEnd) };
}

/* ------------------------------------------------------------ html -> md */

function inlineToMarkdown(html) {
  let out = html
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  for (const [entity, char] of ENTITIES) out = out.split(entity).join(char);
  return out.trim();
}

function sectionToMarkdown(inner) {
  const lines = [];
  const re = /<h3>([\s\S]*?)<\/h3>|<p>([\s\S]*?)<\/p>|<dl class="help-list">([\s\S]*?)<\/dl>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] !== undefined) {
      lines.push(`## ${inlineToMarkdown(m[1])}`, '');
    } else if (m[2] !== undefined) {
      lines.push(inlineToMarkdown(m[2]), '');
    } else {
      const itemRe = /<div class="help-item"><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g;
      let item;
      while ((item = itemRe.exec(m[3])) !== null) {
        lines.push(inlineToMarkdown(item[1]));
        lines.push(`: ${inlineToMarkdown(item[2])}`, '');
      }
    }
  }
  return lines;
}

function htmlToMarkdown(rawInner) {
  const inner = rawInner.replace(/\r\n/g, '\n');
  const out = [
    '<!-- Generated from the Help dialog in renderer/index.html.',
    '     Edit this file, then run `node scripts/help-doc.js import` to write it back. -->',
    '',
    '# Help',
    '',
  ];
  const sectionRe = /<section class="help-section">([\s\S]*?)<\/section>/g;
  let m;
  while ((m = sectionRe.exec(inner)) !== null) out.push(...sectionToMarkdown(m[1]));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------ md -> html */

function inlineToHtml(md) {
  const stash = [];
  const keep = (html) => `@@${stash.push(html) - 1}@@`;

  let out = md
    .replace(/<\/?kbd>/g, (tag) => keep(tag))
    .replace(/`([^`]*)`/g, (_, code) => keep(`<code>${escapeText(code)}</code>`));

  out = escapeText(out)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');

  for (const [entity, char] of ENTITIES) {
    if (char === '&' || char === '<' || char === '>') continue; // already handled by escapeText
    out = out.split(char).join(entity);
  }
  return out.replace(/@@(\d+)@@/g, (_, i) => stash[Number(i)]);
}

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(rawMd, eol) {
  const md = rawMd.replace(/\r\n/g, '\n');
  const body = md.replace(/^<!--[\s\S]*?-->\s*/, '').replace(/^#\s+[^\n]*\n/, '');
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const sections = [];
  let current = null;
  let dl = null;

  const closeDl = () => {
    if (dl) {
      current.push('        </dl>');
      dl = null;
    }
  };

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines[0].startsWith('## ')) {
      closeDl();
      current = [`        <h3>${inlineToHtml(lines[0].slice(3).trim())}</h3>`];
      sections.push(current);
      continue;
    }
    if (!current) throw new Error(`Content before the first "## " heading:\n${block}`);

    const defAt = lines.findIndex((l) => l.startsWith(': '));
    if (defAt === 1) {
      const term = lines[0].trim();
      const def = [lines[1].slice(2), ...lines.slice(2)].join(' ').replace(/\s+/g, ' ').trim();
      if (!dl) {
        current.push('        <dl class="help-list">');
        dl = true;
      }
      current.push(
        `          <div class="help-item"><dt>${inlineToHtml(term)}</dt><dd>${inlineToHtml(def)}</dd></div>`
      );
      continue;
    }
    if (defAt !== -1) throw new Error(`A ": " definition line must follow its term directly:\n${block}`);

    closeDl();
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    current.push(`        <p>${inlineToHtml(text)}</p>`);
  }
  closeDl();

  const rendered = sections
    .map((lines) => ['      <section class="help-section">', ...lines, '      </section>'].join(eol))
    .join(eol + eol);
  return `${eol}${rendered}${eol}    `;
}

/* ------------------------------------------------------------------ main */

const mode = process.argv[2];
const html = fs.readFileSync(HTML_FILE, 'utf8');
const block = readHelpBlock(html);

if (mode === 'export' || mode === 'check') {
  const md = htmlToMarkdown(block.inner);
  if (mode === 'export') {
    fs.mkdirSync(path.dirname(MD_FILE), { recursive: true });
    fs.writeFileSync(MD_FILE, md);
    console.log(`Wrote ${path.relative(ROOT, MD_FILE)} (${md.split('\n').length} lines)`);
  } else {
    const existing = fs.existsSync(MD_FILE) ? fs.readFileSync(MD_FILE, 'utf8') : '';
    if (existing.replace(/\r\n/g, '\n') !== md) {
      console.error('docs/help.md is out of date - run: node scripts/help-doc.js export');
      process.exit(1);
    }
    console.log('docs/help.md matches the Help dialog.');
  }
} else if (mode === 'import') {
  const md = fs.readFileSync(MD_FILE, 'utf8');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const inner = markdownToHtml(md, eol);
  if (inner === block.inner) {
    console.log('Help dialog already matches docs/help.md - nothing to do.');
  } else {
    fs.writeFileSync(HTML_FILE, html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd));
    console.log(`Updated the Help dialog in ${path.relative(ROOT, HTML_FILE)}`);
  }
} else {
  console.error('Usage: node scripts/help-doc.js <export|import|check>');
  process.exit(2);
}
