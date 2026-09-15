<!-- Generated from the Help dialog in renderer/index.html.
     Edit this file, then run `node scripts/help-doc.js import` to write it back. -->

# Help

## Overview

LastMilePDF edits the accessibility tag tree, bookmarks, and metadata. The **Page Preview** pane shows the current page, the **Tag Tree** pane shows its structure, and the **Tag Properties** pane lets you edit whatever tag is selected.

A PDF with no tag tree can still be viewed, but there is nothing to edit until it has been tagged elsewhere. This app is not for tagging from scratch.

The Tag Tree pane and the Tag Properties pane each carry a second tab: **Artifacts** lists the content the document leaves untagged on purpose, and **Bookmarks** shows the PDF's outline.

## Selecting & navigating tags

Click a row in the Tag Tree to select it and jump the preview to it; the matching content is highlighted on the page. ←/→ collapse or expand the selected tag's children.

↑/↓ arrow keys move through the tree, and the usual shortcuts work for selection: Shift+click selects a range, Ctrl/Cmd+click adds or removes a single row from the selection, and Shift+↑/↓ extends the selection.

Drag a row onto another to reorder it or move it under a new parent; Ctrl/Cmd+↑/↓ moves the selection earlier/later among its siblings without touching the mouse.

A dotted red line marks where one page of the PDF ends and the next begins — between two rows when the break falls between tags, and straight through a row whose own content carries over onto the next page. It passes behind the tags rather than over them. Page breaks are where reading order most often goes wrong, so these are worth reading carefully.

The dropdown beside the Tag Tree tab filters the tree to **Figures**, **Headings**, **Lists**, or **Tables** tags, or back to **All**. This is a view filter only — it doesn't change the document.

Three further filters narrow the tree to tags worth a second look. **Alt Missing** shows the Figure and Formula tags with no alt text. **Flagged** shows the tags carrying a badge in the tree: an AI fix already applied to their Actual Text, or — once Tools > Show AT Changes has swept the document — Actual Text that no longer matches the content underneath. **Empty** shows tags with no page content anywhere inside them, which are usually leftovers to delete; when empty tags are nested inside one another, only the outermost is listed.

Figures, Lists and Tables keep each match's own contents browsable underneath it. The rest are flat lists, one row per match in page order, so there is nothing to expand and tags can't be dragged into a new place while one is on.

When the tree is filtered to Headings, ←/→ step the heading level.

## Tag Properties panel

Editing the selected tag(s):

Role
: The tag's structure type (P, H1–H6, Table, Figure, and so on). Type or pick from the suggestion list.

Language
: An optional language override (e.g. `en-US`) for just this tag's content. When the document root (`/Document`) is selected, this instead shows and edits the PDF's overall primary language.

Scope / Column span / Row span
: Shown for TH (table header) cells — whether the header applies to its Row, Column, or Both, and how many columns/rows the cell spans.

Title / Author
: Shown when the document root is selected — edits the PDF's document metadata, not a tag.

Alt text
: The description read aloud for a Figure or Formula tag. On either of those, **Fill with AI** sends an image of just that tag's own part of the page to the configured AI provider and writes what comes back into the field (requires an API key — see File > Settings > API Key…). A Figure gets a description of what it shows; a Formula gets the expression read out in words, the way it would be spoken aloud. The provider and model have to be able to read images, since the picture is all the AI gets. Treat the result as a first draft: read it against the page and edit it, especially where the figure or formula carries information the alt text has to get right.

Actual text
: Replacement text a screen reader speaks instead of the tag's real content. When the tag has no Actual Text of its own, the field shows that tag's extracted content as a preview and the label reads "Actual text (preview)" — it's just shown so you can check it for OCR/transcription errors. Clicking into the field allows editing it as Actual Text. **Fix with AI** sends this tag's text to the configured AI provider to correct OCR/transcription errors, together with an image of the part of the page it was read from, so the AI checks the text against the scan rather than guessing from the words alone — names, numbers and unusual spellings stay as they are unless the image shows otherwise (requires an API key — see File > Settings > API Key…). If the provider can't take images, the fix is retried with the text alone and the status bar says so. If the tag has no Actual Text of its own yet, its extracted content text is pulled and fixed in its place, so a scanned tag can be corrected in a single click. The fixed text is applied straight away, with the changed words highlighted in the field and a Revert button beside it — the same review as **Fix All Actual Text (AI)** gives. **Pull Content** re-imports the extracted content into the Actual Text field if you need to start over.

Table preview
: Shown for Table tags — a quick read-only preview, with a **Table Editor** button that opens the full editor (see below).

## Tagging shortcuts

See the Help > Shortcuts menu. Most shortcuts can be customized in settings.

## Select Content

Tagging usually starts from a tag that already exists. **Select Content** starts from the page instead: click the toolbar button, drag a rectangle over the text you want, and press a tagging shortcut to turn whatever you covered into one new tag.

While you drag, the overlay previews the result: a **solid** outline around the text that will end up in the new tag, and a **dashed** outline around anything that will be dragged along uninvited. Dashed text appears when a text run can't be cut — its font doesn't carry the character mapping needed to name a cut point, so it has to be taken whole.

Most of the tagging keys work this way, but a few have special roles in Select Content Mode:

<kbd>I</kbd>
: Tag it as a List Item, built as the Lbl/LBody pair a list item is supposed to have. If the text starts with a bullet or number, that marker is cut off into the Lbl even when it shares a leaf with the words after it.

<kbd>L</kbd>
: Build a whole List. Select all the text of a bulleted/numbered list (with bullets included) and press L to automatically tag the individual List Items within a List parent.

<kbd>Ctrl/Cmd</kbd>+<kbd>L</kbd>
: Build a list from text with a **hanging indent** instead of a bullet/number/etc. — an academic reference list, most often, where each entry starts at the margin and its continuation lines are pushed in.

<kbd>T</kbd>
: Lay a table grid over the selection instead of tagging it outright. The rectangle becomes the table's outer edge, and the grid starts with the dividers guessed from the text — rows from the gaps between lines, columns from the white space no line of text runs across (a header spanning several columns excepted) — with the status line saying how many it guessed. First, correct the **column** dividers: click inside the box to add one, click a divider to remove it, drag one to move it; <kbd>G</kbd> guesses them again from scratch and <kbd>Delete</kbd> clears them all. Then press <kbd>Enter</kbd> and do the **row** dividers the same way. <kbd>Enter</kbd> again shows the cells with the text each will receive outlined inside it — solid where the text is cut to fit, dashed where a run can't be cut and comes along whole. The top row starts as header cells. Click, drag or <kbd>Shift</kbd>+click to select cells; <kbd>M</kbd> merges the selection into one spanning cell (or splits a merged cell back up); <kbd>H</kbd> switches the selection between header (TH) and data (TD). <kbd>Enter</kbd> builds the table in one undo step, with header scope set the way **Scope Tables** would set it. <kbd>Backspace</kbd> goes back a step; <kbd>Esc</kbd> drops the grid and keeps the selection. At any step, <kbd>A</kbd> or the **Try with AI** button (shown while a grid is up) sends an image of the box and the words in it to the configured AI provider and replaces the whole grid — dividers, merged cells and header cells — with its reading of the table, landing on the cells step. The dividers are placed halfway between the words of neighbouring cells, and where the AI's reading disagrees with where the words actually sit the status line says how many dividers cut through a cell's text or how many words land in a different cell; look at the outlines before pressing <kbd>Enter</kbd>. Needs a provider and model that can read images.

<kbd>Esc</kbd>
: Drops the pending selection without tagging it; pressing it again leaves rectangle-select mode.

## Toolbar tools

Run Script
: Runs whatever script is currently assigned via Tools > Scripts…, in order, top to bottom. See "Scripts" below.

Flatten
: Removes organizational tags — Div, Sect, Part, Span, and any custom tag type with "Span" in its name — found within each selected tag (or the whole document if nothing is selected), keeping all their contents in place. Useful for flattening structure that's more nested than it needs to be.

Scope Tables
: Looks at each table's header shape and sets Row/Column/Both scope on its TH cells automatically.

Smartifact
: Finds image leaves that are the same size as their page — typically full-page scan backgrounds — and marks them as artifacts. (Some auto-taggers litter these throughout documents.)

Add Figures
: Toggles draw mode: drag a rectangle on the page preview to tag an area as a new Figure. Press Esc to end draw mode. This differs from Select Content in that you're not selecting recognized content. It's for when OCR/auto-taggers do not properly mark figures so they are visible but not taggable.

Select Content
: Toggles rectangle-select mode: drag a rectangle over the page preview to select the content under it, then press a tagging shortcut to tag it. Unlike Add Figures, which tags the region you drew without looking at what's beneath, this selects existing text and cuts it at the rectangle's edges. See "Select Content" above. Press Esc to drop the selection, again to end the mode.

Add P
: Inserts a new, empty Paragraph tag into the tree immediately after the selected tag (or at the end of the document if nothing is selected). This can then be converted into any other tag type needed.

Walk
: Steps through the tag tree automatically, one tag at a time, so you can read along with the preview. While walking, <kbd>+</kbd>/<kbd>-</kbd> adjust the speed (remembered for next time) and any other key stops it.

Fix All Actual Text (AI)
: Sends every tag's Actual Text to the configured AI provider together, in one batch (for document-wide consistency), and applies its suggested fixes. Afterward, step through the flagged rows in the tag tree to review each change — selecting one highlights the diff in the Actual Text field, with a **Revert** button to discard just that fix. Requires an AI provider API key (File > Settings > API Key…).

Verify
: Runs a set of common PDF accessibility checks (tagging, title, language, tab order, PDF/UA identifier, headings, empty tags, lists, tables, links, alternate text, bookmarks, orphaned marked content) and opens the results in their own window. Click a listed issue to jump straight to the offending tag. Three checks offer an inline fix button: **Repair** on orphaned marked content (the same fix as Tools > Repair Orphaned Content), **Set tab order** on the tab-order check, and **Set PDF/UA flag** on the PDF/UA identifier — that last one appears only once every other check passes, since it writes a claim of conformance rather than fixing anything. Each re-checks everything afterward. The report also re-runs itself after every save, putting the fail/pass count in the status bar.

## Tools menu

Repair Orphaned Content
: Scans for invisible content that's neither tagged nor a real PDF artifact — a formatting hint (hyphenation/kerning glue, invisible joiners, a decorative background band) auto-taggers often leave behind, often around wrapped URLs/DOIs in a reference list.

## Scripts

Tools > Scripts… opens a builder for chaining actions into a named, ordered sequence. Add actions from the palette on the left, and reorder them with the ↑/↓ buttons on each step — a script can include several Find/Replace steps, each configured with its own pair of tag types.

Save a script and check "Assign to Run Script button" to make it the one the toolbar's **Run Script** button runs.

Running a script executes its steps in order, reporting progress in the status bar, and stops if a step fails — for example, a Fix All Actual Text (AI) step with no AI provider configured.

## Table Editor

Open it from a selected Table tag's Table Preview. It lays the table out as a grid; select one or more cells to edit their header Scope, Column span, and Row span together, or convert the selection between Header (TH) and Data (TD) cells. Double-clicking allows you to edit the Actual Text for a cell.

## Bookmarks

The Bookmarks tab shows the PDF's outline. Click a bookmark to jump to its page, double-click to rename it, or press Delete to remove the selected one. **+** adds a new bookmark pointing at whatever page is currently open in the preview, inserted into the tree wherever that page falls in the existing order. **Generate** clears the existing outline and builds a fresh one from the document's headings.

## Artifacts

The Artifacts tab, beside Tag Tree, lists everything the PDF marks as an *artifact* — content deliberately left out of the tag tree, so assistive technology skips it. Running heads, footers, page numbers, rules and the background image of a scanned page are all normally artifacts, and so is anything this app has artifacted itself: deleting a tag turns its content into one, and so do **Smartifact** and **Repair Orphaned Content**.

Each row says what the artifact is made of (text, image, drawing, or a mix), the PDF's own name for it where it has one (Header, Footer, Watermark…), any text it paints, and its page. Click a row to jump to that page and outline the artifact on it, the same way clicking a tag outlines its content. ↑/↓ move through the list, and the usual selection shortcuts work: Shift+click selects a range, Ctrl/Cmd+click adds or removes one row, and Shift+↑/↓ extends the selection. Every selected artifact on the current page is outlined at once.

The tagging shortcuts turn the selection back into tagged content, and they are the same keys, configured in the same place, as the ones that set a role in the Tag Tree: <kbd>1</kbd>–<kbd>6</kbd> for a heading, <kbd>P</kbd> for a paragraph, <kbd>F</kbd> for a figure, <kbd>C</kbd> for a caption, <kbd>D</kbd> and <kbd>H</kbd> for table cells. The artifact becomes a new tag with that role — the role it should have had, not a placeholder to correct afterwards — and lands selected in the Tag Tree. This is the way back from an artifacting you didn't mean: a heading deleted by accident, or a figure Smartifact took to be a scan background. Undo reverses it like any other edit.

<kbd>L</kbd>, <kbd>I</kbd>, <kbd>T</kbd>, <kbd>R</kbd> and <kbd>J</kbd> are not available here. Each of them regroups tags that already exist — a list is built from list items, a row from cells, a join needs a tag to join to — and an artifact is content that has no tag yet. Tag it first, then press them in the Tag Tree.

Several artifacts selected together become *one* tag holding all of them, in page then reading order — not one tag each. That is what to do with a running head the file artifacted as three separate spans, or a heading it broke up line by line: they are one piece of content, and tagging them one at a time would only move the problem into the tree. They can come from different pages; each keeps the page it was actually on.

The list is read from the page content streams, which takes a moment on a long document, and is re-read the next time the tab is opened after an edit. A few things can't be outlined on the page: an artifact drawn with a shading, or one whose font carries no usable metrics, has no box this app is willing to state — those rows still list and can still be tagged, and hovering one says so.

## Proofread Mode

View > Proofread Mode switches to a focused layout for reading through the document's Actual Text one tag at a time: the tree collapses to a flat list of tags and the Tag Properties panel strips down to just the Actual Text field.

<kbd>Page Up</kbd>/<kbd>Page Down</kbd> jump to the previous/next tag's Actual Text from anywhere, including while that field is focused. Pressing <kbd>↑</kbd>/<kbd>↓</kbd> on the first/last line of Actual Text will also jump to adjacent tags.

While a tag is showing a highlighted diff (an AI fix, or a **Show AT Changes** flag), Proofread Mode also marks the same changes on the page: the words the OCR read differently are marked where they sit on the page, and a thin amber bar marks where words were added that the OCR missed. Positions within a line are estimated from character counts, so they point at the right spot rather than outline it exactly.

## Show AT Changes

View > Show AT Changes flags every tag whose Actual Text no longer matches the real OCR content so you can find hand edits or old AI fixes even after saving, closing, and reopening the file (unlike an AI fix's own flag from **Fix All Actual Text (AI)** or **Fix with AI**, which only lasts the session). Selecting a flagged tag shows the same highlighted diff and Revert button as an AI fix.

## Saving

Every save is atomic — the new file is fully written before it replaces the old one, so a crash or power loss mid-save can't corrupt your PDF. Before that replacement, the previous version is copied to a backup in your system's temp folder. Backups older than 7 days are cleaned up automatically.

## Color theme

File > Settings > Preferences > Appearance allows you to choose a **Dark** or **Light** theme. **Auto**, the default, follows whatever your operating system is set to and switches with it.
