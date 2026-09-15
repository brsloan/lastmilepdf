#!/usr/bin/env node
// scripts/changelog-section.js
//
// Prints one version's section of CHANGELOG.md, so the release workflow can
// use it as the GitHub Release body instead of GitHub's auto-generated commit
// list (.github/workflows/release.yml).
//
//   node scripts/changelog-section.js 0.4.1
//   node scripts/changelog-section.js v0.4.1   # leading v is stripped
//
// It exits non-zero when the section is missing or empty, which fails the
// release job rather than publishing a release with no notes. That is the
// deliberate trade: every version tag now needs a matching, non-empty
// `## [x.y.z]` heading in CHANGELOG.md before it can be released.
//
// The parsing itself lives in lib/changelog.js, shared with main.js so that
// the release notes on GitHub and the app's own What's New dialog are the
// same text read the same way. Versions are matched as whole strings, so
// `0.4.1` never matches `0.4.10` and nothing has to be escaped.

const fs = require('fs');
const path = require('path');

const changelog = require('../lib/changelog');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

function fail(message) {
  process.stderr.write(`changelog-section: ${message}\n`);
  process.exit(1);
}

function main() {
  const raw = process.argv[2];
  if (!raw) fail('usage: node scripts/changelog-section.js <version>');

  const version = raw.replace(/^v/, '');
  if (!fs.existsSync(CHANGELOG)) fail(`no CHANGELOG.md at ${CHANGELOG}`);

  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const sections = changelog.parseSections(text);
  const section = sections.find((s) => s.version === version);
  if (!section) {
    fail(
      `CHANGELOG.md has no "## [${version}]" section. Add one (moving the ` +
        'entries out of ## [Unreleased]) before tagging this version.',
    );
  }
  if (!section.body) {
    fail(
      `the "## [${version}]" section in CHANGELOG.md is empty - a release ` +
        'needs at least one entry.',
    );
  }

  // The compare link at the foot of the changelog, kept so the release still
  // offers a diff the way GitHub's generated notes did.
  const url = changelog.compareLink(text, version);

  process.stdout.write(url ? `${section.body}\n\n**Full diff:** ${url}\n` : `${section.body}\n`);
}

main();
