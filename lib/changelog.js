'use strict';
// lib/changelog.js
//
// Reads CHANGELOG.md. Two callers share this one parser on purpose:
//
//   scripts/changelog-section.js  - the GitHub Release body (release.yml)
//   main.js                       - the app's What's New dialog
//
// so what a release says on GitHub and what the app tells you after updating
// to it can't drift into two different accounts of the same version. The app
// reads the copy of CHANGELOG.md shipped inside its own build (see
// package.json's "files"), so the summary is whatever was true when that
// version was packaged - no network call, and nothing left to fetch at the
// moment the release notes are the point.
//
// The shape expected here is the one CHANGELOG.md already keeps (Keep a
// Changelog): one "## [1.2.3] - 2026-09-14" heading per version, newest
// first, "### Added"/"Changed"/"Fixed" groups inside it, and one "- " bullet
// per entry with continuation lines indented. Two consequences of matching
// that literally:
//
//   - A bullet or a group heading is only recognised at column 0, so a
//     wrapped line that happens to begin with "- " stays part of the entry
//     above it rather than starting a new one.
//   - entriesSince() walks the file downwards from the running version
//     instead of sorting versions itself, which makes newest-first ordering
//     a requirement rather than a convention.

/**
 * @typedef {{ text: string, style: 'plain' | 'strong' | 'em' | 'code' }} ChangelogSpan
 * @typedef {{ heading: string, items: ChangelogSpan[][] }} ChangelogGroup
 * @typedef {{ version: string, date: string, groups: ChangelogGroup[] }} ChangelogEntry
 * @typedef {{ version: string, date: string, body: string }} ChangelogSection
 */

/** "## [0.4.1] - 2026-09-10", with the date optional. */
const SECTION_HEADING = /^##\s+\[([^\]]+)\]\s*(?:[-–]\s*(.*))?$/;

/** A link definition at the foot of the file: "[0.4.1]: https://…". */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;

/** Bold, italic and code spans - no escaping, which the file doesn't use. */
const INLINE_MARKUP = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|`([^`]+)`/g;

/**
 * Every version section, in the order the file lists them (newest first).
 * The trailing block of link definitions belongs to no version, so it is
 * dropped rather than swept into the oldest section's body.
 * @param {string} text
 * @returns {ChangelogSection[]}
 */
function parseSections(text) {
  /** @type {{ version: string, date: string, lines: string[] }[]} */
  const sections = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const match = SECTION_HEADING.exec(line.trim());
      current = match ? { version: match[1].trim(), date: (match[2] || '').trim(), lines: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current) continue;
    if (LINK_DEFINITION.test(line)) {
      current = null;
      continue;
    }
    current.lines.push(line);
  }
  return sections.map((section) => ({
    version: section.version,
    date: section.date,
    body: section.lines.join('\n').trim(),
  }));
}

/**
 * One version's section body, as Markdown, or null if the file has no
 * heading for it. "Unreleased" is a version name like any other here.
 * @param {string} text
 * @param {string} version
 * @returns {string | null}
 */
function sectionBody(text, version) {
  const section = parseSections(text).find((s) => s.version === version);
  return section && section.body ? section.body : null;
}

/**
 * The compare URL the foot of the changelog keeps for a version, or ''.
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
function compareLink(text, version) {
  const prefix = `[${version}]:`;
  const line = String(text).split(/\r?\n/).find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

/**
 * Splits one entry into spans, so a caller can show bold as bold without
 * handing Markdown to anything that builds HTML out of a string.
 * @param {string} text
 * @returns {ChangelogSpan[]}
 */
function parseInline(text) {
  /** @type {ChangelogSpan[]} */
  const spans = [];
  let last = 0;
  let match;
  INLINE_MARKUP.lastIndex = 0;
  while ((match = INLINE_MARKUP.exec(text))) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), style: 'plain' });
    if (match[1] !== undefined) spans.push({ text: match[1], style: 'strong' });
    else if (match[2] !== undefined) spans.push({ text: match[2], style: 'em' });
    else spans.push({ text: match[3], style: 'code' });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: 'plain' });
  return spans;
}

/**
 * A section body as groups of entries. Bullets that come before any "###"
 * heading - which the older, reconstructed sections at the foot of the file
 * have - land in a group with an empty heading.
 * @param {string} body
 * @returns {ChangelogGroup[]}
 */
function parseGroups(body) {
  /** @type {{ heading: string, items: string[] }[]} */
  const groups = [];
  let group = null;
  for (const line of String(body).split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      group = { heading: line.slice(4).trim(), items: [] };
      groups.push(group);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (line.startsWith('- ')) {
      if (!group) {
        group = { heading: '', items: [] };
        groups.push(group);
      }
      group.items.push(trimmed.slice(2).trim());
      continue;
    }
    // A soft-wrapped continuation of the bullet above: one paragraph in
    // Markdown, so one entry here too.
    if (group && group.items.length) {
      group.items[group.items.length - 1] += ` ${trimmed}`;
    }
  }
  return groups
    .filter((g) => g.items.length)
    .map((g) => ({ heading: g.heading, items: g.items.map(parseInline) }));
}

/**
 * One version, ready to render: version, date and grouped entries. Null
 * when the file has no section for it, or has one with nothing in it.
 * @param {string} text
 * @param {string} version
 * @returns {ChangelogEntry | null}
 */
function entryFor(text, version) {
  const section = parseSections(text).find((s) => s.version === version);
  if (!section) return null;
  const groups = parseGroups(section.body);
  return groups.length ? { version: section.version, date: section.date, groups } : null;
}

/**
 * Compares two dotted versions. A pre-release sorts before the release it
 * leads to (1.0.0-rc.1 < 1.0.0); two pre-releases of the same version sort
 * by plain string order, which is enough to answer "is this newer than what
 * ran last time?".
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions(a, b) {
  const numbers = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const left = numbers(a);
  const right = numbers(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  const preRelease = (v) => String(v).split('-').slice(1).join('-');
  const leftPre = preRelease(a);
  const rightPre = preRelease(b);
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre < rightPre ? -1 : 1;
}

/**
 * Everything that changed between two versions: the section for
 * `currentVersion` plus every section below it in the file, stopping just
 * before `previousVersion` - so an update that skipped a release still
 * accounts for the releases it skipped.
 *
 * Empty when the file has no section for the running version, which is what
 * keeps a dev build - or a version released without an entry - from showing
 * an empty dialog. `max` caps how far back it goes when `previousVersion`
 * isn't in the file at all: an install old enough that its own section has
 * since been trimmed away.
 *
 * @param {string} text
 * @param {string} currentVersion
 * @param {string | null} previousVersion
 * @param {{ max?: number }} [options]
 * @returns {ChangelogEntry[]}
 */
function entriesSince(text, currentVersion, previousVersion, options = {}) {
  const max = options.max || 5;
  const sections = parseSections(text).filter((s) => s.version !== 'Unreleased');
  const start = sections.findIndex((s) => s.version === currentVersion);
  if (start === -1) return [];

  /** @type {ChangelogEntry[]} */
  const entries = [];
  for (const section of sections.slice(start)) {
    if (previousVersion && section.version === previousVersion) break;
    const groups = parseGroups(section.body);
    if (groups.length) entries.push({ version: section.version, date: section.date, groups });
    if (entries.length >= max) break;
  }
  return entries;
}

module.exports = {
  parseSections,
  sectionBody,
  compareLink,
  parseInline,
  parseGroups,
  entryFor,
  entriesSince,
  compareVersions,
};
