<!-- Generated from the Help dialog in renderer/index.html.
     Edit this file, then run `node scripts/help-doc.js import` to write it back. -->

# Help

## Overview

LastMilePDF edits a PDF's accessibility tag tree, bookmarks and metadata. The **Page Preview** pane shows the current page, the **Tag Tree** pane shows the document's structure, and the **Tag Properties** pane edits the selected tag.

It works on PDFs that are already tagged. A PDF with no tag tree will open, but there is nothing to edit until it has been tagged elsewhere.

Open a PDF with the toolbar's **Open** button, File > Open or File > Open Recent. While nothing is loaded you can also drop a PDF onto the **Page Preview** pane. Once a document is open, that pane is for drawing (Add Figures, Select Content), so switch documents through File > Open, which asks about unsaved changes first.

The Tag Tree pane has a second tab, **Artifacts**, listing content the document leaves untagged on purpose. The Tag Properties pane has a **Bookmarks** tab showing the PDF's outline.

## Selecting & navigating tags

Click a row to select it and jump the preview to it; its content is highlighted on the page. ↑/↓ move through the tree and ←/→ collapse or expand the selected tag. Shift+click selects a range, Ctrl/Cmd+click adds or removes one row, and Shift+↑/↓ extends the selection.

Drag a row onto another to reorder it or move it under a new parent. Ctrl/Cmd+↑/↓ moves the selection earlier or later among its siblings.

A dotted red line marks each page break: between two rows when the break falls between tags, or through a row whose content carries on to the next page. Reading order most often goes wrong at page breaks, so check these closely.

Reopening a PDF brings back the selected tag, the expanded tags, the tree's scroll position and the page the preview was on. If the file has changed since (edited elsewhere, or edited here and not saved), it opens at the structure root instead.

## Filtering the tree

The dropdown beside the Tag Tree tab narrows what the tree shows. It never changes the document.

Figures, Headings, Lists, Tables
: Only tags of that kind. With Headings, ←/→ change the selected heading's level.

Alt Missing
: Figure and Formula tags with no alt text.

Flagged
: Tags with a badge in the tree: an AI fix to their Actual Text, or (once View > Show AT Changes has run) Actual Text that no longer matches the content underneath.

Flagged \*\*
: The same, narrowed to **\*\*** badges, where the words differ. **\*** badges, where only white space changed, are left out.

Empty
: Tags with no page content inside them, usually leftovers to delete. Where empty tags are nested, only the outermost is listed.

Figures, Lists and Tables keep each match's contents browsable underneath it. The other filters are flat lists in page order, so rows can't be expanded or dragged while one is on. In Proofread Mode the filter narrows that mode's list rather than replacing it.

## Tag Properties panel

Role
: The tag's structure type (P, H1–H6, Table, Figure and so on). Type one or pick from the list.

Language
: An optional language (e.g. `en-US`) for this tag's content. With the document root (`/Document`) selected, this is the whole PDF's primary language.

Scope / Column span / Row span
: For TH (table header) cells: whether the header applies to its Row, Column or Both, and how many columns and rows the cell spans.

Title / Author
: With the document root selected, the PDF's title and author.

Alt text
: What a screen reader reads for a Figure or Formula. **Fill with AI** sends an image of the tag's area of the page to your AI provider (see "AI provider" below) and fills the field with the reply: a description for a Figure, the expression in words for a Formula. The model must accept images. Treat the result as a draft and check it against the page.

Actual text
: Text a screen reader speaks in place of the tag's content. If the tag has none, the field previews its extracted content, labelled "Actual text (preview)", so you can check it for OCR errors; click into it to edit it as Actual Text. **Fix with AI** sends the text, with an image of that part of the page, to your AI provider to correct OCR errors. Names, numbers and unusual spellings are kept unless the image shows otherwise. If the provider can't take images, it retries with the text alone and the status bar says so. On a tag with no Actual Text, the content is pulled in and fixed in one click. The fix applies straight away, with the changed words highlighted and a **Revert** button. **Pull Content** reloads the extracted content if you want to start over.

Table preview
: For Table tags: a read-only preview, with a **Table Editor** button (see "Table Editor" below).

Split Content
: Selecting a piece of page content in the tree, rather than a tag, shows its text here instead. Click where it should be cut and press **Split** or <kbd>Enter</kbd> to split it in two, so each half can be tagged separately: a list label from its item, say, or a run-in heading from its paragraph. Some content can't be split, such as text in a font with no character map, and the panel says why.

## Tagging shortcuts

Help > Shortcuts lists them all, and most can be remapped in File > Settings > Preferences. Right-click a tag for the same actions as a menu, each labelled with its key. Like the keys, the menu acts on the whole selection.

Two keys do more than set a role:

<kbd>B</kbd>
: Groups the selection into a **Block Quotation**. One paragraph becomes a quotation holding that paragraph; three become one quotation of three paragraphs. Headings, lists, tables and figures are kept as they are inside it; anything else (a Span, or untagged content) becomes a paragraph. The tags must share a parent, as with <kbd>T</kbd> and <kbd>R</kbd>.

<kbd>P</kbd>
: On a List, Table or BlockQuote, flattens it into plain paragraphs rather than relabelling it: one per list item, one per table cell in reading order, or the quotation's own blocks as they were. This is the way out of a table or list that was never one on the page. It works on a single row group, row or cell too. Nested lists, figures and tables inside a cell are kept, a Caption stays a Caption, and empty cells are dropped.

## Select Content

Select Content tags from the page instead of the tree. Click the toolbar button, drag a rectangle over the text you want, and press a tagging shortcut to turn what you covered into one new tag.

While you drag, a **solid** outline marks the text that will go into the new tag. A **dashed** outline marks text that has to come along whole, because its font lacks the character mapping needed to cut it.

Most keys work as usual. These behave differently:

<kbd>I</kbd>
: Tags a List Item, with the Lbl/LBody pair it should have. A leading bullet or number is cut off into the Lbl, even when it shares a run with the words after it.

<kbd>L</kbd>
: Builds a whole List. Select the full list, bullets included, and each entry becomes a List Item.

<kbd>Ctrl/Cmd</kbd>+<kbd>L</kbd>
: Builds a list from **hanging indents** instead of bullets or numbers. This is usually a reference list, where each entry starts at the margin and its continuation lines are indented.

<kbd>B</kbd>
: Tags a Block Quotation, with the covered text as a paragraph inside it.

<kbd>T</kbd>
: Lays a table grid over the selection. See "Tables from the page" below.

<kbd>Esc</kbd>
: Drops the selection. Press it again to leave Select Content.

## Tables from the page

Pressing <kbd>T</kbd> on a Select Content rectangle lays a table grid over it. The rectangle is the table's outer edge, and the grid starts with dividers guessed from the text: rows from the gaps between lines, columns from white space no line crosses (a header spanning several columns excepted). The status line says how many it guessed. Then work through three steps:

Columns
: Click inside the box to add a divider, click a divider to remove it, or drag it to move it. <kbd>G</kbd> guesses again from scratch and <kbd>Delete</kbd> clears them all. <kbd>Enter</kbd> moves on to rows.

Rows
: The same, for row dividers. <kbd>Enter</kbd> moves on to cells.

Cells
: Each cell's text is outlined inside it: solid where it is cut to fit, dashed where a run can't be cut and comes along whole. The top row starts as header cells. Click, drag or <kbd>Shift</kbd>+click to select cells; <kbd>M</kbd> merges them into one spanning cell (or splits a merged one) and <kbd>H</kbd> switches them between header (TH) and data (TD). <kbd>Enter</kbd> builds the table as one undo step, with header scope set as **Scope Tables** would set it.

<kbd>Backspace</kbd> goes back a step; <kbd>Esc</kbd> drops the grid and keeps the selection.

**Try with AI** (or <kbd>A</kbd>), shown while a grid is up, sends an image of the box and its words to your AI provider and replaces the whole grid (dividers, merges and header cells) with its reading of the table, landing on the cells step. If a divider cuts through a cell's text, or words land in a different cell than the AI intended, the status line says how many, so check the outlines before pressing <kbd>Enter</kbd>. Needs a model that accepts images.

## Toolbar tools

Run Script
: Runs the script assigned under Tools > Scripts…, top to bottom. See "Scripts" below.

Flatten
: Removes organizational tags (Div, Sect, Part, Span, and custom types with "Span" in the name) inside each selected tag, or in the whole document if nothing is selected, keeping their contents in place.

Scope Tables
: Sets Row, Column or Both scope on each table's TH cells from the shape of its headers.

Smartifact
: Marks images the size of their page, usually scan backgrounds that an auto-tagger tagged as figures, as artifacts.

Add Figures
: Drag a rectangle on the page to tag that area as a new Figure. It is for figures the OCR or auto-tagger left visible but untaggable. Unlike Select Content, it tags the area itself, not the content under it. <kbd>Esc</kbd> ends draw mode.

Select Content
: Drag a rectangle over text on the page, then press a tagging shortcut to tag it. See "Select Content" above.

Add P
: Inserts an empty Paragraph tag after the selected tag (or at the end of the document), ready to be given whatever role it needs.

Walk
: Steps through the tree one tag at a time so you can read along with the preview. <kbd>+</kbd>/<kbd>-</kbd> change the speed (remembered for next time); any other key stops it.

Fix All Actual Text (AI)
: Sends every tag's Actual Text to your AI provider in one batch, for consistency across the document, and applies its fixes. Each fixed tag is flagged in the tree; select one to see its changes highlighted, with **Revert** to discard that fix.

Verify
: Runs common accessibility checks (tagging, title, language, tab order, PDF/UA identifier, headings, empty tags, lists, tables, links, alt text, bookmarks, orphaned content) and opens the results in their own window. Click an issue to jump to its tag. Three checks have a fix button: **Repair** for orphaned content, **Set tab order**, and **Set PDF/UA flag**. The last appears only once everything else passes, since it claims conformance rather than fixing anything. Verify re-runs after each fix and after every save, putting the fail/pass count in the status bar.

## Tools menu

Find/Replace…
: Changes tags of one type to another, one at a time or all at once. For example, P to Span.

Repair Orphaned Content
: Artifacts invisible content that is neither tagged nor artifacted: formatting leftovers such as hyphenation or kerning glue, invisible joiners and background bands, often found around wrapped URLs in a reference list.

Scripts…
: Opens the script builder. See "Scripts" below.

## Scripts

Tools > Scripts… builds named sequences of actions. Add actions from the palette on the left and reorder them with each step's ↑/↓ buttons. A script can include several Find/Replace steps, each with its own pair of tag types.

Check **Assign to Run Script button** when saving to make it the toolbar's script. A running script reports progress in the status bar and stops at the first step that fails, such as Fix All Actual Text (AI) with no AI provider set up.

## Table Editor

Open it from a Table tag's preview in Tag Properties. It shows the table as a grid. Select cells to set their header Scope, Column span and Row span together, or to convert them between header (TH) and data (TD); add rows and columns with the buttons below the grid. Double-click a cell to edit its Actual Text.

## Bookmarks

The Bookmarks tab shows the PDF's outline. Click a bookmark to go to its page, double-click to rename it, or press Delete to remove it. **+** adds a bookmark for the page in the preview, placed in page order. **Generate** replaces the outline with one built from the document's headings.

## Artifacts

The Artifacts tab lists everything the PDF marks as an *artifact*: content left out of the tag tree so assistive technology skips it, such as running heads, page numbers, rules and scan backgrounds. Deleting a tag artifacts its content, and so do **Smartifact** and **Repair Orphaned Content**.

Each row shows what the artifact is made of (text, image, drawing or a mix), the PDF's name for it where there is one (Header, Footer, Watermark…), any text it paints, and its page. Click a row to jump to it and outline it on the page. Rows select like tag tree rows (↑/↓, Shift+click, Ctrl/Cmd+click, Shift+↑/↓), and every selected artifact on the current page is outlined.

The role shortcuts tag the selection back into the tree: <kbd>1</kbd>–<kbd>6</kbd>, <kbd>P</kbd>, <kbd>F</kbd>, <kbd>C</kbd>, <kbd>D</kbd> and <kbd>H</kbd>. The new tag gets that role and is selected in the Tag Tree. Use this to recover a heading deleted by mistake, or a figure Smartifact took for a scan background. Undo reverses it like any other edit.

Several artifacts selected together become *one* tag, in reading order, even across pages. That is what a running head split into three spans, or a heading broken up line by line, needs.

<kbd>L</kbd>, <kbd>I</kbd>, <kbd>B</kbd>, <kbd>T</kbd>, <kbd>R</kbd> and <kbd>J</kbd> don't work here: they regroup existing tags, and an artifact has no tag yet. Tag it first, then use them in the Tag Tree.

The list is read from the page content, which takes a moment on a long document, and is refreshed when you next open the tab after an edit. Artifacts drawn with a shading, or in a font without usable metrics, can't be outlined on the page but can still be listed and tagged; hovering one says so.

## Proofread Mode

View > Proofread Mode is a layout for reading the Actual Text one tag at a time. The tree becomes a flat list of tags, and Tag Properties shows only the Actual Text field.

<kbd>Page Up</kbd>/<kbd>Page Down</kbd> move to the previous or next tag, even while you are typing in the field. <kbd>↑</kbd>/<kbd>↓</kbd> on the first or last line do the same.

The filter dropdown narrows the flat list. Set it to **Flagged \*\*** to read only the tags whose words were changed by an AI fix or found by **Show AT Changes**, still in document order. The Artifacts tab is hidden, since artifacts have no Actual Text.

Proofread Mode keeps its own filter and **Show AT Changes** settings. Turning it on restores them from your last proofread (the first time: Show AT Changes on, filter on **All**); turning it off puts back what you had before.

A document closed while proofreading reopens in Proofread Mode at the tag you had reached, with the caret at the start of its text. Opening a document never turns the mode off.

When a tag shows a highlighted diff, the page marks the same changes: words the OCR read differently are marked where they sit, and a thin amber bar marks where missing words were added. Positions within a line are estimated from character counts, so they point at the spot rather than outline it exactly.

## Show AT Changes

View > Show AT Changes flags every tag whose Actual Text differs from its OCR content, so hand edits and earlier AI fixes can still be found after saving and reopening. (The flag from **Fix with AI** or **Fix All Actual Text (AI)** lasts only the session.) Select a flagged tag to see the diff and a **Revert** button.

The badge says how much changed:

`*`
: Only white space changed, such as a line break turned into a space.

`**`
: The words differ. These are the ones to read.

`AI` prefix
: Changed by an AI fix this session, rather than found by the sweep.

`↓` suffix
: The flagged tag is inside this one, in a collapsed branch. `AI**↓` is an AI fix that changed the words of a tag somewhere below.

## AI provider

Fill with AI, Fix with AI, Fix All Actual Text (AI) and Try with AI all use the AI provider set up under File > Settings > API Key…. Pick a known provider to fill in its Base URL and model, then paste in your key. Pick **Custom** for any OpenAI-compatible chat-completions service, such as one your university hosts; its Base URL can be the API root or the full `/chat/completions` URL. Usage bills to whoever owns the key. Keys are stored encrypted, on this computer only.

Working with Claude (below) doesn't use this setting. Claude runs in your own Claude app or Claude Code.

## Working with Claude

A Claude session running on the same computer can work on the PDF you have open. Keep the app and the chat side by side and ask things like "what's wrong with the table I have selected?" or "fix this table and the others like it". Claude sees the same document you do, turns the page and selects tags to show you what it means, and edits with the same actions you use.

Turning it on
: File > Settings > **Desktop Agents** > *Allow Claude to connect to this app*. It is off until you turn it on. The dialog then shows how to connect: the contents of a `.mcp.json` file to save in the folder you start Claude in (for the Claude desktop app), or a command to run once (for Claude Code in a terminal). Start a new Claude session afterwards. A client that can only launch local MCP servers can connect through a bridge such as `mcp-remote`, using the address and code from the same dialog.

What Claude can see
: The current page and selection, a summary of the tag tree or any part of it in detail, a search by tag type, page or text, the Verify report, and a picture of any page or of the area a tag covers.

What Claude can change
: Tag type, alt text, Actual Text, language and table-cell attributes; every tagging shortcut; moving and deleting tags; splitting content, as **Split Content** does; wrapping loose content in a new tag; Flatten and Scope Tables; generating bookmarks from the headings (which replaces any already there); the document's title, author and language; and your saved scripts, except any containing Fix All Actual Text (AI), which spends your AI credit and is left for you to run.

Fixing a whole document
: Ask Claude to "fix this PDF" and it works through the document from a standing set of instructions: survey every page, remove organizational wrappers, set one consistent heading outline, join lists and tables split across pages, place captions, write alt text for every figure, mark likely artifacts as **Artifact?** for you to review, set the title and author, generate bookmarks, and report what it did and what still needs you. In Claude Code the same instructions are also a command, `/mcp__lastmilepdf__fix_document`, which takes an optional note about the document ("this is one chapter of a book"). Rewrite the instructions to suit your own house rules under File > Settings > **Desktop Agents** > *Instructions for "Fix this PDF"*; **Reset to default** brings the original back. Changes apply the next time you ask. OCR errors across whole paragraphs are still a job for Fix All Actual Text (AI), which Claude will suggest.

What Claude can't do
: Open, save or close a file. Nothing it changes reaches disk until you save. It also can't draw on the page, so rectangle tagging stays with **Select Content**.

While Claude is editing
: A **Claude is editing** bar says what it is doing, and your own input is locked so an edit of yours can't land in the middle of its batch. **Stop** or <kbd>Esc</kbd> takes control back at once, and a session that goes quiet for two minutes ends by itself. Claude can't start editing while you are in the middle of something, such as a dialog or a Select Content rectangle.

Undoing and reviewing
: A whole editing session is one undo step: one <kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it all back, and your own edits before and after stay separate. When a session ends, the status bar offers **Show the tags Claude changed**, which selects them in the Tag Tree so you can check them.

Keeping it private
: Only programs on this computer can connect, and only with the code shown in the Desktop Agents dialog. Treat that code like a password, and keep `.mcp.json` out of anything you share (a project's `.gitignore` is the usual place to list it).

## Saving

Saves are atomic: the new file is fully written before it replaces the old one, so a crash or power cut mid-save can't corrupt your PDF. The previous version is first copied to a backup in your system's temp folder, and backups older than 7 days are deleted automatically.

## Color theme

File > Settings > Preferences > Appearance offers **Dark**, **Light** and **Auto**. Auto, the default, follows your operating system and switches with it.
