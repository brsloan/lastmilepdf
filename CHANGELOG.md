# Changelog

All notable changes to LastMilePDF are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before 0.5.0 were reconstructed from the tag history after the fact, so
they summarise each release rather than record every change as it landed.

## [Unreleased]

### Added
- **Select Content → Table.** With a rectangle selected on the page, T no
  longer just says that tables are built from the tree: it lays a grid over
  the rectangle. Click to place column dividers, Enter, click to place row
  dividers, Enter again to see the cells with the text each will receive
  outlined inside it. Drag or Shift+click to select cells, M to merge them
  into one spanning cell, H to switch header and data cells (the top row
  starts as headers), then Enter builds the Table, TR and TH/TD tags in one
  undo step, cutting every text run at the cell edges the same way the
  rectangle already cuts at its own - so a scanned table whose OCR painted
  each row as one run comes out one cell per column. Header scope is set as
  Scope Tables would set it. The grid starts with the dividers guessed
  from the text - rows from the gaps between lines (a wrapped cell's
  tighter line pitch is told apart from the space between rows), columns
  from the white space no line of text runs across, a spanning header
  excepted - and the status line says how many it guessed. Every divider is still yours to correct, and nothing is built
  until the cells have been looked at: the Table Editor can fix headers
  and spans afterwards but can't move text between cells, so a grid that's
  a few points off could only be undone, not corrected. G guesses the
  current step again, Delete clears it, Esc drops the grid and keeps the
  selection.
- A **Fill with AI** button beside the Alt text label when a Figure or a
  Formula is selected. It sends an image of just that tag's own part of the
  page to the configured AI provider and writes what comes back into the
  field: a description of what a figure shows, or a formula read out in
  words the way it would be spoken aloud. The picture is all the AI gets, so
  the provider and model have to be able to read images - there is no
  text-only fallback the way there is for Fix with AI. What it writes is a
  first draft: read it against the page before saving.
- Four more filters in the dropdown above the tag tree. **Lists** narrows to
  L tags (and any LI orphaned from one), keeping each list's items browsable
  underneath it the way Figures and Tables already do. **Flagged** lists the
  tags carrying a badge in the tree - an AI fix applied to their Actual Text,
  or, once Show AT Changes has swept the document, Actual Text that no longer
  matches the content underneath. **Alt Missing** lists the Figure and Formula
  tags with no alt text. **Empty** lists tags holding no page content at all,
  showing only the outermost one where they're nested inside each other. All
  four are view filters only, like the existing ones - they don't change the
  document.

- Eight more checks in **Verify**, covering ground Acrobat's Full Check
  looks at and this one didn't: a **PDF/UA identifier** in the XMP metadata;
  **tab order** set to document structure on every page; **link
  annotations** that sit outside any Link tag, or carry no description
  (either the annotation's own `/Contents` or `/Alt` on its Link tag counts);
  an **H1** somewhere in the document; **headings that are empty**;
  **figures that paint their own text**, which a screen reader can only
  reach if the alt text repeats it; **tags holding no content at all**,
  reported at the outermost one and using the same definition of "empty" as
  the tag tree's Empty filter; and **Lbl/LBody pairing** inside every list
  item. The two that are safely mechanical carry an inline fix button: **Set
  tab order** writes `/Tabs /S` on the pages missing it, and **Repair** is
  unchanged.
- A **Set PDF/UA flag** button on the PDF/UA identifier check, which writes
  the PDF/UA-1 identifier into the document's XMP - the last thing Acrobat
  asks for once its own report comes back clean. It appears only when every
  other check passes, because it asserts conformance rather than producing
  it; while anything is still failing, the check says how many and why the
  claim would be false. Warnings don't block it - the two that exist are
  both cases the app can't tell apart from a correct document. Like any
  other edit, it needs a save to reach the file.
- Verify now re-runs itself after every save and puts the result in the
  status bar beside the saved path ("2 checks failed, 19 passed"), so a
  document's standing is visible without opening the panel. It runs after
  the save has finished, so it never holds up closing the window, and it's
  skipped for the background auto-save.

### Changed
- Fix with AI now sends an image of the part of the page the tag's text was
  read from along with the text, so the AI corrects the OCR against the scan
  instead of guessing from the words alone. Names, numbers, dates and unusual
  spellings are left as they are unless the image clearly shows otherwise. A
  provider that can't accept images gets the text alone, as before, and the
  status bar says which happened. Fix All Actual Text (AI) is unchanged.

## [0.5.0] - 2026-09-14

### Added
- In Proofread mode, the highlighted changes in the Actual Text field are now
  mirrored on the page: while an AI fix or a Show AT Changes flag is showing
  its diff, the words the OCR read differently are marked on the preview, and
  a thin amber bar marks where words were added that the OCR missed
  entirely. Positions within a line are estimated from character counts, so
  they point at the right spot rather than outline it exactly.
- The tag tree now shows where the PDF's pages break: a dotted red line
  between the two tags a break falls between, and through the middle of a tag
  whose own content carries over onto the next page. The line is drawn behind
  the tags, so it never covers a role or a text preview.

### Changed
- In the tag properties panel, Fix with AI now comes before Pull Content,
  which also puts Pull Content - the rare start-over - last in the tab order.

### Fixed
- Pressing `P` on several content elements at once now leaves the paragraphs
  it made selected. It used to hand back a partial selection of whichever
  other tags had inherited those positions, because wrapping each element in
  a paragraph shifts everything after it along.
- Clearing the selection now redraws the tag tree, so rows can no longer be
  left looking selected when nothing is.
- Pressing `P` on tags that are already paragraphs no longer clears the
  selection, which left the tree without a focused tag until it was clicked
  back into. Any conversion that only relabels now keeps the selection put.
- Join no longer refuses tags that sit on the same page but disagree about
  where their `/Pg` is written - the case that blocked joining paragraphs
  holding `Sub` tags. Joining across a page break works too: the moved
  content now carries its own page instead of being rejected.
- The text cursor no longer vanishes while it sits inside a highlighted word
  in the Actual Text field. The highlight layer was painting over the caret;
  the layers are now the other way round.
- Pull Content and Fix with AI no longer react to the pointer outside their
  own buttons. The whole Actual Text field was acting as Pull Content's
  label, so hovering beside the field's caption highlighted the button, and
  clicking there ran it.

## [0.4.3] - 2026-09-11

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

[Unreleased]: https://github.com/brsloan/lastmilepdf/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/brsloan/lastmilepdf/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/brsloan/lastmilepdf/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/brsloan/lastmilepdf/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/brsloan/lastmilepdf/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/brsloan/lastmilepdf/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/brsloan/lastmilepdf/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brsloan/lastmilepdf/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brsloan/lastmilepdf/releases/tag/v0.1.0
