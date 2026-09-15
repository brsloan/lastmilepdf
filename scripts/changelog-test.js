#!/usr/bin/env node
// scripts/changelog-test.js
//
// Exercises lib/changelog.js - the parser behind both the release notes
// (scripts/changelog-section.js) and the app's What's New dialog.
//
// Most fixtures are a small changelog written out here, so the checks say
// what the parser should do rather than what this project's history happens
// to contain. The last few run against the real CHANGELOG.md, which is the
// part that would actually break a release: a heading style that stopped
// matching, or a version section that silently produces nothing.
//
//   npm test

const fs = require('fs');
const path = require('path');

const changelog = require('../lib/changelog');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n      ${err.message}`);
  }
}

/** The shape CHANGELOG.md keeps, small enough to reason about by hand. */
const FIXTURE = [
  '# Changelog',
  '',
  'Preamble prose that belongs to no version.',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '- Something still in progress.',
  '',
  '## [0.3.0] - 2026-09-10',
  '',
  '### Added',
  '- **A headline feature.** Its description wraps onto',
  '  a second line, and mentions `code` and *one* italic word.',
  '- A second entry.',
  '',
  '### Fixed',
  '- A fix.',
  '',
  '## [0.2.0] - 2026-09-03',
  '',
  '### Changed',
  '- Something changed.',
  '',
  '## [0.1.0] - 2026-09-01',
  '',
  '- An entry under no group heading at all.',
  '',
  '[Unreleased]: https://example.invalid/compare/v0.3.0...HEAD',
  '[0.3.0]: https://example.invalid/compare/v0.2.0...v0.3.0',
].join('\n');

function main() {
  console.log('\nlib/changelog.js\n');

  test('sections come out newest first, with their dates', () => {
    const sections = changelog.parseSections(FIXTURE);
    assertEqual(sections.map((s) => s.version), ['Unreleased', '0.3.0', '0.2.0', '0.1.0'], 'versions');
    assertEqual(sections[1].date, '2026-09-10', 'date');
  });

  test('the trailing link definitions are not swept into the oldest section', () => {
    const sections = changelog.parseSections(FIXTURE);
    const oldest = sections[sections.length - 1];
    assert(!oldest.body.includes('example.invalid'), `link definitions leaked into ${oldest.version}:\n${oldest.body}`);
  });

  test('a compare link is found for a version that has one, and not invented', () => {
    assertEqual(changelog.compareLink(FIXTURE, '0.3.0'), 'https://example.invalid/compare/v0.2.0...v0.3.0', '0.3.0');
    assertEqual(changelog.compareLink(FIXTURE, '0.2.0'), '', '0.2.0 has no link');
  });

  test('a wrapped entry is one entry, joined into one paragraph', () => {
    const [added] = changelog.parseGroups(changelog.sectionBody(FIXTURE, '0.3.0'));
    assertEqual(added.heading, 'Added', 'heading');
    assertEqual(added.items.length, 2, 'entry count');
    const text = added.items[0].map((span) => span.text).join('');
    assert(text.includes('wraps onto a second line'), `continuation not joined: ${text}`);
  });

  test('bold, italic and code come back as marked spans, not as asterisks', () => {
    const [added] = changelog.parseGroups(changelog.sectionBody(FIXTURE, '0.3.0'));
    const styled = added.items[0].filter((span) => span.style !== 'plain');
    assertEqual(styled, [
      { text: 'A headline feature.', style: 'strong' },
      { text: 'code', style: 'code' },
      { text: 'one', style: 'em' },
    ], 'styled spans');
    assert(!added.items[0].some((span) => span.text.includes('*')), 'markup left in the text');
  });

  test('entries written before any group heading still come through', () => {
    const groups = changelog.parseGroups(changelog.sectionBody(FIXTURE, '0.1.0'));
    assertEqual(groups.length, 1, 'group count');
    assertEqual(groups[0].heading, '', 'no heading');
    assertEqual(groups[0].items.length, 1, 'entry count');
  });

  test('an update reports the releases it skipped, newest first', () => {
    const entries = changelog.entriesSince(FIXTURE, '0.3.0', '0.1.0');
    assertEqual(entries.map((e) => e.version), ['0.3.0', '0.2.0'], 'versions');
    assert(!entries.some((e) => e.version === 'Unreleased'), 'Unreleased must never be shown');
  });

  test('a version with no section reports nothing rather than guessing', () => {
    assertEqual(changelog.entriesSince(FIXTURE, '9.9.9', '0.2.0'), [], 'unknown running version');
    assertEqual(changelog.entryFor(FIXTURE, '9.9.9'), null, 'entryFor');
  });

  test('an unknown previous version stops at the cap instead of running to the foot', () => {
    const entries = changelog.entriesSince(FIXTURE, '0.3.0', '0.0.1', { max: 2 });
    assertEqual(entries.map((e) => e.version), ['0.3.0', '0.2.0'], 'capped');
  });

  test('versions compare numerically, with a pre-release below its release', () => {
    assertEqual(changelog.compareVersions('0.5.0', '0.4.3'), 1, '0.5.0 > 0.4.3');
    assertEqual(changelog.compareVersions('0.4.10', '0.4.9'), 1, '0.4.10 > 0.4.9');
    assertEqual(changelog.compareVersions('0.5.0', '0.5.0'), 0, 'equal');
    assertEqual(changelog.compareVersions('0.4.3', '0.5.0'), -1, 'downgrade');
    assertEqual(changelog.compareVersions('1.0.0-rc.1', '1.0.0'), -1, 'pre-release');
  });

  // --- against the real file ---------------------------------------------

  const real = fs.readFileSync(CHANGELOG, 'utf8');

  test('every released version in CHANGELOG.md parses into entries', () => {
    const sections = changelog.parseSections(real).filter((s) => s.version !== 'Unreleased');
    assert(sections.length > 0, 'no version sections found at all - has the heading style changed?');
    for (const section of sections) {
      assert(/^\d+\.\d+\.\d+/.test(section.version), `"${section.version}" is not a version number`);
      const entry = changelog.entryFor(real, section.version);
      assert(entry && entry.groups.length, `${section.version} parsed into nothing`);
    }
  });

  test('the version in package.json has a section, or is still unreleased', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const entry = changelog.entryFor(real, version);
    const unreleased = changelog.sectionBody(real, 'Unreleased');
    assert(
      entry || unreleased,
      `CHANGELOG.md has neither a "## [${version}]" section nor anything under Unreleased - ` +
        "a build of this version would have nothing to show in What's New.",
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
