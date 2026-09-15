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
 *
 * An asterisk the help text means literally - the tree filters are named "Flagged **"
 * and "Flagged *" after the badges they list - is written escaped, as \*, so it can't
 * be read back as an emphasis marker. Without that, <strong>Flagged **</strong> exports
 * as **Flagged **** and imports as whatever pairing the parser happens to land on, which
 * silently rewrites a paragraph nobody was editing. Backslashes are escaped for the same
 * reason, so the escape itself can be written. `check` verifies the whole round trip
 * rather than just the export, so a passage the Markdown can't carry is reported instead
 * of being quietly mangled the next time someone runs `import`.
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

function decodeEntities(text) {
  let out = text;
  for (const [entity, char] of ENTITIES) out = out.split(entity).join(char);
  return out;
}

function inlineToMarkdown(html) {
  // Code spans come out first and are held aside: their content is verbatim
  // in Markdown, so the escaping below must not reach inside them (and
  // doesn't need to - a backtick span carries an asterisk as it stands).
  const stash = [];
  const keep = (text) => `@@${stash.push(text) - 1}@@`;

  let out = html.replace(/<code>([\s\S]*?)<\/code>/g, (_, code) => keep(`\`${decodeEntities(code)}\``));

  // Every asterisk still here is one the help text means literally - the
  // "Flagged **" filters - since the emphasis markers aren't inserted until
  // the next step. Escaping them is what keeps the import from reading them
  // back as delimiters. Tags and entities hold none of these characters, so
  // running over the raw HTML is safe.
  out = out.replace(/[\\*]/g, (char) => `\\${char}`);

  out = out
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  out = decodeEntities(out);
  return out.replace(/@@(\d+)@@/g, (_, i) => stash[Number(i)]).trim();
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
    .replace(/`([^`]*)`/g, (_, code) => keep(`<code>${escapeText(code)}</code>`))
    // A \* the export wrote is a literal asterisk, not a delimiter. Held
    // aside like the code spans so the emphasis pass below can't see it;
    // after the code spans, so an asterisk inside a backtick span - where
    // Markdown takes everything verbatim and the export escapes nothing -
    // stays the character it already was.
    .replace(/\\([\\*])/g, (_, char) => keep(escapeText(char)));

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

/* ------------------------------------------------------------- self-check */

// Inline shapes the round trip has to survive, kept here rather than left to
// whatever the help text happens to say this month: the filter names that
// broke it are one edit away from being reworded, and the escaping would then
// go untested until the next passage needed it. Each must come back out of
// inlineToHtml(inlineToMarkdown(x)) exactly as it went in.
const INLINE_CASES = [
  '<strong>Flagged **</strong> is narrowed to the <strong>**</strong> and <strong>*</strong> badges',
  'One asterisk (<code>*</code>) means white space, two (<code>**</code>) means the words',
  'a lone * in running text, and 2 * 3',
  '<em>emphasis</em> beside <strong>bold</strong> beside <code>code</code>',
  '<kbd>Ctrl</kbd>+<kbd>P</kbd> &mdash; entities &amp; arrows &darr;',
];

function checkInlineRoundTrip() {
  for (const original of INLINE_CASES) {
    const md = inlineToMarkdown(original);
    const back = inlineToHtml(md);
    if (back !== original) {
      throw new Error(`The inline round trip is broken - Markdown cannot carry this:\n`
        + `  in:   ${original}\n  as:   ${md}\n  back: ${back}`);
    }
  }
}

/* ------------------------------------------------------------------ main */

/** Where two versions of the help block first diverge, with a little either side. */
function firstDifference(expected, actual) {
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at += 1;
  const from = Math.max(0, at - 60);
  const show = (text) => JSON.stringify(text.slice(from, at + 60));
  return `  in the dialog: ${show(expected)}\n  from the doc:  ${show(actual)}`;
}

const mode = process.argv[2];

// Before any mode, including import: if the conversion itself can't carry a
// passage, writing with it is how a paragraph nobody was editing gets
// rewritten.
try {
  checkInlineRoundTrip();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

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
    // Matching isn't enough on its own: the Markdown also has to mean the
    // same thing on the way back. A passage that exports cleanly but imports
    // as something else would corrupt the dialog the next time anyone edited
    // the doc - and corrupt a paragraph they weren't touching, which is how
    // this goes unnoticed. Report it here instead.
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    const reimported = markdownToHtml(md, eol);
    if (reimported !== block.inner) {
      console.error('docs/help.md does not import back to the same Help dialog - `import` would corrupt it.');
      console.error(firstDifference(block.inner, reimported));
      process.exit(1);
    }
    console.log('docs/help.md matches the Help dialog, and imports back unchanged.');
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
