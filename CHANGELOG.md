# Changelog

All notable changes to LastMilePDF are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before 0.5.0 were reconstructed from the tag history after the fact, so
they summarise each release rather than record every change as it landed.

## [Unreleased]

### Added
- **Drag a PDF onto the Page Preview pane to open it.** While nothing is
  loaded, the empty pane is a drop target: drag a PDF in from the file
  manager and it opens the same way File > Open would, joining Open Recent
  afterwards. The pane outlines itself while a file is over it, and the
  placeholder says so. It only takes a drop while it is empty - with a
  document open that pane belongs to Add Figures and Select Content, and a
  stray drop there would be a document swap nobody asked for. Dropping a
  file anywhere else in the window now does nothing at all, where before it
  would have replaced the whole app with Chromium's view of that file.
- **B groups the selection into a Block Quotation.** A new tagging shortcut,
  configurable like the rest, for the quoted passages a scan is full of and
  which until now had to be typed into the Role field by hand. It groups
  rather than relabels, because a BlockQuote is a block of *paragraphs*
  attributed to someone other than the surrounding author: one selected
  paragraph comes out as a quotation holding that paragraph, and three come
  out as one quotation of three paragraphs, rather than three quotations that
  have each stopped being a paragraph. A selected tag that already names a
  block of its own - a heading, list, table or figure - is kept as it is
  inside the quotation; a Span, or page content with no tag of its own,
  becomes the paragraph the quotation holds. B answers a Select Content
  rectangle too, putting the text it covered in a paragraph inside the new
  quotation. Pressing P on a quotation dissolves it again and hands back the
  blocks it was holding, so there is a way out as well as a way in.
- **A quick start, in the app and as a PDF.** Help > Quickstart is a short
  tutorial on the keyboard-first way of working - the tag shortcuts, what the
  toolbar buttons do, the three ways to build a table, and a suggested AI
  workflow - written for someone opening the app for the first time, where the
  existing Help doc is a reference for someone already in it. Help > Open
  Quickstart PDF opens the same text as a tagged PDF, which a first run opens
  by itself so the app starts with something on screen rather than an empty
  window. It is a document to practise on as much as one to read: correctly
  tagged headings, paragraphs and nested lists to re-level, join, split and
  artifact, and a list item carried across a page break. It opens from a copy
  in the user data folder, so it saves like any other document; a later
  version's tutorial replaces that copy only while it is still untouched.
- **What changed, after an update.** The first launch on a new version opens
  a What's New dialog saying what came with it, taken from that version's
  section of the changelog - the same text the release notes on GitHub are
  made of, now shipped inside the build and shown at the one moment it is
  worth reading. Until now an update announced itself as "Update 0.5.0
  downloaded" and never said what was in it. An update that skipped releases
  lists those too (up to five), since from here they all arrived at once.
  Help > What's New reopens the running version's entry any time. Nothing
  appears on a fresh install, after a downgrade, or for a version the
  changelog has no section for, which keeps a build run from source quiet.
- **Documents reopen where you left them.** A PDF opened again comes back to
  the tag that was selected, the tags that were expanded, how far down the tag
  tree was scrolled and the page the preview was on, instead of the structure
  root with everything collapsed - which on a long document meant re-expanding
  the same dozen levels at the start of every session. Remembered per file, for
  the twenty most recently opened. A document closed while proofreading reopens
  proofreading, resuming from the tag that had been reached, with the caret at
  the start of its Actual Text rather than selecting the whole field - a resumed
  read is not the place to leave a tag's text one keystroke from being wiped.
  Opening a document never turns that mode off, whatever the file was last read
  in. A file that has been edited since - elsewhere, or here with the changes
  never saved - opens the old way: what was recorded is checked against the
  document's structure before any of it is trusted, since a tag's id only means
  anything against the exact tree it came from.
- **Artifacts tab.** The Tag Tree pane now has a second tab listing everything
  the document marks `/Artifact` - the content deliberately left out of the
  tag tree, which assistive technology skips: running heads, footers, page
  numbers, rules, the background image of a scanned page, and anything this
  app artifacted itself (deleting a tag does, and so do Smartifact and Repair
  Orphaned Content). Each row says what the artifact is made of, the PDF's own
  name for it where it has one, any text it paints and its page; clicking one
  jumps to that page and outlines it, the same way clicking a tag does.
  The tagging shortcuts turn the selection back into tagged content, with the
  role the shortcut names: the same keys as in the tag tree, configured in the
  same place - 1-6, P, F, C, D, H - so an artifact is tagged as what it should
  have been rather than as a placeholder to correct afterwards. The new tag
  lands selected in the tree. L, I, T, R and J are answered with a hint
  instead: each regroups tags that already exist, and an artifact has no tag
  yet. Rows select like tag tree rows do (Shift+click, Ctrl/Cmd+click,
  Shift+arrows), and several selected together become *one* tag holding all of
  them in reading order, rather than one each - which is what a running head
  the file artifacted as three separate spans actually needs. Artifacting was
  a one-way door until now; this is the way back from a heading deleted by
  accident, or a figure Smartifact took for a scan background.
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
  selection. A, or the **Try with AI** button shown while a grid is up,
  sends an image of the box and the words in it to the configured AI
  provider and replaces the whole grid with its reading of the table -
  dividers, merged cells and header cells - landing on the cells step. The
  AI names which words belong in which cell; the dividers are then drawn
  halfway between neighbouring cells' words, so where its reading
  contradicts where the text actually sits the status line says how many
  dividers cut through a cell's text or how many words land in a different
  cell from the one it named. Needs a provider and model that can read
  images.
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
- **P** on a table now flattens it into plain paragraphs - one per TH or TD
  cell, in reading order - instead of relabelling the Table tag and leaving
  the rows and cells hanging underneath it. This is the way back out of a
  table that was never a table on the page: a run of text an OCR pass, or a
  table-detecting AI, boxed into a grid. A row group, a row, or a single cell
  can be flattened the same way, and a cell holding several paragraphs becomes
  one, so nothing comes out of the flatten still nested. Cells holding more
  than text - a nested list, figure or table - keep that content as it was,
  a Caption stays a Caption, and an empty cell simply contributes nothing.
- Fix with AI now sends an image of the part of the page the tag's text was
  read from along with the text, so the AI corrects the OCR against the scan
  instead of guessing from the words alone. Names, numbers, dates and unusual
  spellings are left as they are unless the image clearly shows otherwise. A
  provider that can't accept images gets the text alone, as before, and the
  status bar says which happened. Fix All Actual Text (AI) is unchanged.
- The tag tree's flags now say how much changed, not just that something did.
  A Show AT Changes flag wears one asterisk when only the white space moved -
  a line break pulled into a space - and two when the words themselves differ,
  so the changes worth reading stand out from the cosmetic ones. An applied AI
  fix is graded the same way and marked `AI` rather than "AI fix", and the
  arrow for a flag below a collapsed subtree now follows the asterisks instead
  of leading: `AI**↓` is an AI fix that rewrote the words of a tag inside.
- Proofread Mode keeps the tag tree's filter dropdown, moved under the Tag
  Tree tab where the pane is narrow, and the filter now stacks on the mode's
  own list rather than being replaced by it: the rows stay the flat sequence
  of tags with text to read, in document order, narrowed to the ones the
  filter also matches. Set it to **Flagged \*\*** to read through only the
  tags whose words an AI fix or a Show AT Changes sweep actually changed.
  Narrowing the currently selected tag off the list lands on the first row
  that survived, so Page Up/Down carries on reading. The Artifacts tab is
  hidden while proofreading - an artifact has no Actual Text to read.

### Fixed
- Selecting the Document root no longer outlines everything on the page. The
  root stands for the whole file, so highlighting it boxed every tagged thing
  in the preview at once - which said nothing about where anything was, and
  was the first thing a newly opened document showed, since that is the tag it
  lands on.

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
