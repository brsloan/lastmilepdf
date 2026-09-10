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
// Headings are matched as plain strings rather than by regex, so a version
// never has to be escaped, and the closing bracket keeps `## [0.4.1]` from
// matching `## [0.4.10]`.

const fs = require('fs');
const path = require('path');

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

  const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);

  // "## [0.4.1] - 2026-09-10" - the date is not part of the match, so a
  // heading that is missing one still works.
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  if (start === -1) {
    fail(
      `CHANGELOG.md has no "${heading}" section. Add one (moving the entries ` +
        'out of ## [Unreleased]) before tagging this version.',
    );
  }

  // Everything up to the next section heading. A nested "### Added" is part
  // of the body; only a "## " heading ends it.
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

  if (!body) {
    fail(
      `the "${heading}" section in CHANGELOG.md is empty - a release needs ` +
        'at least one entry.',
    );
  }

  // The compare link at the foot of the changelog, kept so the release still
  // offers a diff the way GitHub's generated notes did.
  const linkPrefix = `[${version}]:`;
  const linkLine = lines.find((line) => line.startsWith(linkPrefix));
  const url = linkLine ? linkLine.slice(linkPrefix.length).trim() : '';

  process.stdout.write(url ? `${body}\n\n**Full diff:** ${url}\n` : `${body}\n`);
}

main();
