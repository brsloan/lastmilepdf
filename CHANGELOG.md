# Changelog

All notable changes to LastMilePDF are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before 0.5.0 were reconstructed from the tag history after the fact, so
they summarise each release rather than record every change as it landed.

## [Unreleased]

### Changed
- Tightened the in-app Help text throughout, and moved the shortcut list out of
  Help in favour of pointing at Help > Shortcuts.
- The Help text now round-trips to `docs/help.md` for editing: `npm run
  help:export` writes the Markdown, `npm run help:import` writes it back into
  the dialog, and `npm run help:check` reports drift between the two.

## [0.4.2] - 2026-09-10

### Fixed
- Flatten now removes `Sub` tags along with `Div`, `Sect`, `Part` and `Span`.
- The tag properties panel refreshes after Scope Tables, instead of showing the
  scopes the table had before the command ran.

## [0.4.1] - 2026-09-10

### Fixed
- Proofread mode no longer skips over text that only a Span-like tag holds.
- Flattened content stays on the page it came from.

## [0.4.0] - 2026-09-10

### Added
- A light theme alongside the original dark workbench, selectable from
  File > Settings > Preferences > Appearance. "Auto" follows the OS light/dark
  setting and is the default; switching the app's own UI is instant, with no
  restart. Both themes meet WCAG 2.1 AA for contrast, and the light theme goes
  to 7:1 for text.
- A contrast check (`scripts/contrast-check.js`, run by `npm test`) that fails
  the build if either theme drops below those ratios.
- Current screenshots of both themes on the project site.

## [0.3.0] - 2026-09-10

### Added
- Select Content: drag a rectangle over the page preview to select the text
  under it and tag it with a single keystroke. The rectangle cuts leaves at its
  own edges, so half a paragraph can become a heading without touching the tag
  tree. Every tagging shortcut, list item included, can be answered from a
  rectangle selection.
- A glyph-advance engine behind rectangle selection, with AFM metrics supplied
  for the standard 14 fonts, so the app can tell which glyphs fall inside the
  rectangle.
- Building a real list from a rectangle selection, with a `Lbl`/`LBody` per
  item and the list marker split off the text it shares a leaf with.
- Ctrl+L detects hanging-indent lists, for reference lists whose entries are
  marked out by indentation rather than by any character in the text.

### Fixed
- A pending rectangle selection is dropped whenever the tree is rebuilt, and a
  selection is tied to the page it was drawn on.
- The coverage bar no longer blocks cuts.
- pdf.js is re-fed when undo steps across a content-stream rewrite.

## [0.2.0] - 2026-09-03

### Added
- Repair Orphaned Content: finds marked content that is neither tagged nor a
  real PDF artifact - left over from a deleted tag, or inserted by other
  software - and converts it to a real artifact, so Acrobat's accessibility
  checker stops flagging it as untagged content.
- Tagging and Proofread Mode shortcuts are configurable in Preferences.
- A GitHub Pages site for the project.

### Changed
- Save backups go to the OS temp folder instead of sitting alongside the PDF.
- The NSIS installer's artifact name no longer contains spaces.

## [0.1.0] - 2026-09-03

Initial release: a standalone Electron app for viewing a PDF and editing its
accessibility structure tree.

### Added
- Tag tree editing - reordering, conversion, deletion - with keyboard
  shortcuts throughout, and filters for narrowing to figures, tables and the
  like.
- Tag properties panel with role, language and alt text, plus a live list
  preview for `L` tags.
- Table editor with auto-scope options, row and column insertion and deletion,
  and inline editing of a cell's Actual Text.
- Find/Replace for tag types.
- A visual script builder (Tools > Scripts…) and a Run Script button, for
  sequencing repeated actions.
- Flatten, for removing extraneous span and div tags.
- Smartifact, which artifacts full-page figures at a click.
- AI-assisted cleanup of OCR errors in Actual Text, with changes highlighted
  for approval and batch progress estimates. Any provider can be configured,
  including editable base URL and model fields for Anthropic.
- Proofread mode, comparing OCR text against the original image with AI fixes
  highlighted, and scrolling that keeps the selected element level with the
  editor.
- Show AT Changes, which flags differences between Actual Text and the OCR
  text so your own edits can be reviewed.
- Walk, which moves through the tree automatically at a pace you set.
- Splitting content leaves.
- Atomic saves that keep a `.bak` of the previous file, plus an auto-save
  option in Preferences.
- File > Open Recent and a diagnostic log file.
- Opt-out auto-update, a Linux AppImage build, CI and release automation.
- MIT license and community files.

[Unreleased]: https://github.com/brsloan/lastmilepdf/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/brsloan/lastmilepdf/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/brsloan/lastmilepdf/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/brsloan/lastmilepdf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/brsloan/lastmilepdf/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brsloan/lastmilepdf/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brsloan/lastmilepdf/releases/tag/v0.1.0
