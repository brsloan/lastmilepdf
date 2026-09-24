# Quick Start

Go to Help > Quickstart to read this as a scrolling HTML page.

This app is all about making manual changes quick and easy with keyboard shortcuts. Click a tag and press P: it becomes a P tag. C makes it a caption, etc.

Click into the tag tree and you can move up and down it with arrows. Right expands a tag to show its children, left collapses. Hold SHIFT and move to select multiple tags. Press J to join them. (If you press J on a single tag, it will join the one above it–useful for P tags split across pages.)

CTRL+Up/Down moves the selected tag(s). DELETE artifacts the contents and deletes the tag.

Some of the shortcuts have special smart features. Highlight a bunch of Ps and press L and it will convert them into list items within a list, looking for bullets to break apart into Lbl tags. Press R on those same Ps and it will turn them into a Table Row of Table Data cells. Etc. Experiment\! You can always undo with CTRL+Z.

Right-click in the tag tree to see all the tagging shortcuts or apply them with a click. Also see a more full list under HELP.

## Toolbar

SMARTIFACT artifacts any full-page figures, because some autotaggers mistakenly include full-page scans as figures. Don’t use if you have any actual full-page figures in your document.

SCOPE TABLES applies header scopes to your tables (whether a header applies to column or row or both) with a best guess.

FLATTEN removes purely organizational tags like Span, StyleSpan, etc., while keeping the real tags and their contents.

ADD FIGURES lets you draw a rectangle over any figures your autotagger missed.

SELECT CONTENT lets you re-tag content by selecting it in the PDF preview. It has smart List detection, so if your autotagger mangled a list, instead of manually fixing it in the tag tree, try selecting the whole list with this tool and pressing L. It also has a smart Table tagger, described below.

ADD P adds a P tag.

WALK automatically walks through the document at a steady pace which can be sped/slowed with \+/- keys.

FIX ALL ACTUAL TEXT (AI) takes the entire document’s text and sends it to your designated AI service to correct OCR errors. It does not send images of the pages in order to save tokens, but it is designed to be used in conjunction with the individual “Fix With AI” feature that does. (See “Suggested AI Workflow below.)

## Actual Text Preview

For most tag types, when you select them in the tree, you’ll see an Actual Text (Preview) in the Tag Properties panel to the right. 

Remember that there is a difference between the Content within a tag–the bit of OCR text in the document, which this app does not edit–and the “Actual Text”, which is a property of a tag that provides an **alternative** to the content for screen readers.

When the Actual Text header says (Preview), that means there is no Actual Text set and it is just showing you the content text for you to check for OCR errors at a glance. If you click into it and edit that preview, it will now save that as the Actual Text property, overriding the content’s text for screen readers.

If you enable View \> Show AT Changes, it will highlight any changes here in yellow. When in proofreading mode, it will also show them on the PDF page itself (or at least do its best–data limitations may mean it is not exact with its highlighting on the PDF page).

## Artifacts Tab in Tag Tree Panel

This is where you will find any elements that have been artifacted. You can restore them to the tag tree by tagging them with the usual tag shortcuts, which will bring you back to the Tag Tree to see where they were inserted. DELETE artifacts them again.

## Table Editors

There are three ways to build/edit tables: the Select Content tool, the Table Editor, and the Tag Tree.

### Building Tables with Select Content tool

1. Click “Select Content”, then click and drag to draw a rectangle over your table, matching its exterior dimensions.  
2. It will try to build the rows/columns based off the document. If it gets it right, you can press Enter to accept. If not, you have two choices:  
   1. You can click the “Try With AI” button which will now have appeared next to the Select Content button. This will send an image of the table to your AI service to try to build the table that way, skipping manual steps below. If it gets it wrong, press Escape to cancel and restart table tagging to do it manually.  
   2. You can continue with manual tagging either by editing the auto-generated columns/rows, or pressing escape to clear them and building your own, as described below.  
3. Manual tagging:  
   1. This is done in three steps: you line up the column dividers, line up the row dividers, and then merge any cells that need merging. Once each step is done to your satisfaction, you press Enter to advance to the next.  
   2. For column dividers, you can click and drag the auto-generated vertical lines to move them, or click anywhere in the table to make a new line. ENTER progresses to…  
   3. For row dividers, it works the same way, but with horizontal lines. ENTER progress to…  
   4. Merging cells. If one column header is spared over two columns, say, shift-click each cell and press M to merge them. When you’ve merged all the cells that need it, press ENTER.  
   5. It now magically tags your table correctly\!

### Editing Tables with the Table Editor

Clicking a table in the Table Tree will show a Table Preview in the Tag Properties panel. Above it will be a “Table Editor” button. Click it.

The Table Editor expands so you can see the full table. Here you can select rows and columns to designate them as headers, give them spans/scopes, add rows and columns, etc. Double-clicking a cell lets you edit that cell’s Actual Text directly for easy OCR correction.

### Tagging Tables in the Tag Tree

The table tag shortcuts are designed to make this as painless as possible.

Select 9 P tags and press T. It makes them all TD tags and puts them into a Table tag.

Expand the table tag, select the first three TD tags and press H to make them Headers, then R to combine them into a Table Row. 

Select the next three TDs and press R to put them in a row. Do that one more time.

You now have a 3x3 table. Congrats\! 

## Suggested AI Workflow

Set up API access with your chosen AI service in File \> Settings.

1. Correct the tag structure of the document  
2. If OCR seems consistently spotty, click Fix All Actual Text (AI)   
3. Turn on Proofread Mode to review AI changes, which will be highlighted in yellow both in the Actual Text editor and the PDF preview. (If you set the tree filter to “Flagged \*\*” it will only show you the tags with AI edits that need review.)  
4. For any tag with incorrect changes, you can either fix them manually or click “Fix With AI” in that tag’s Properties panel to send a more powerful AI request that includes a snapshot of the page for the AI’s machine vision to assist in correcting  
5. Final manual correction/verification.

If it’s a clean scan with good OCR, you can skip the Fix All step and just use the individual AI button for problem tags.


## Suggested Workflow With Desktop AI Agents

If you use Claude, you can let it work on the PDF you have open while you watch. Think of it as an assistant sitting beside you: it sees the same page and tags you do, points things out by selecting them, and makes tag changes when you ask. It can’t open, save, or close files, so nothing is permanent until you click Save.

This is separate from the AI service in File \> Settings. It uses your own Claude account, through the Claude desktop app or Claude Code.

### Setting It Up (Once)

1. Go to File \> Settings \> Desktop Agents and tick “Allow Claude to connect to this app.”  
2. Make a folder to use for your PDF work with Claude. Any folder will do.  
3. In the Desktop Agents window, click “Copy file contents.” Paste it into a new file in Notepad (or any plain-text editor) and save it in that folder, named exactly .mcp.json – a dot at the start, and no .txt at the end.  
4. In the Claude desktop app, start a new session in that folder. (If you use Claude Code in a terminal, run the command shown in the same window instead.)  
5. Ask Claude “Can you see the PDF I have open?” to check that it’s connected.

The code in that file works like a password to the app, so don’t email or share the .mcp.json file.

### Working With Claude

Claude is best at the first step of the Suggested AI Workflow above: correcting the tag structure. A good routine:

1. Open the PDF in LastMilePDF and ask Claude to “fix this PDF.” It looks at every page first, then works through headings, lists and tables that break across pages, captions, alt text, bookmarks, and the title and author. Long documents take a while, and you can watch the changes appear as it goes.  
2. While it’s editing, a “Claude is editing” bar appears and the app ignores your own clicks and keys, so the two of you don’t trip over each other. Press Stop or Escape at any time to take back control.  
3. Read its report. It says what it did and what still needs a person – often something only Select Content can fix, since Claude can’t draw on the page.  
4. Check its work. When it finishes, the status bar offers “Show the tags Claude changed”; click it to select them all in the Tag Tree. Pay most attention to alt text and headings.  
5. Handle the “Artifact?” tags. Claude doesn’t decide on its own what’s decoration; it tags anything it suspects as “Artifact?” for you. Use Tools \> Find/Replace, type Artifact? as the tag type, and click Find to step through them. Press DELETE on the ones that really are decoration, and give the rest their proper tag.  
6. Carry on with steps 2–5 of the Suggested AI Workflow: Fix All Actual Text (AI) for OCR errors, then proofread. Claude leaves big OCR fixes to that tool.  
7. Run Verify, then Save.

Don’t like what it did? Claude works in batches, and CTRL+Z takes back a whole batch at once rather than one change at a time. Your own edits stay separate steps.

### Tips

- Talk to it the way you would to a colleague: “the list on page 4 should be one list, not two,” or “make every ‘Figure 3.1…’ line a Caption.”  
- Select a tag and say “this one” – Claude can see what you have selected.  
- Ask it to show you things: “select the tables you weren’t sure about.”  
- It can run your saved scripts: “run my cleanup script.”  
- Have house rules? Add them under File \> Settings \> Desktop Agents \> Instructions for “Fix this PDF” (for example, “chapter titles are always H1”). Reset to default brings back the original.  
- Start small if you’re new to it: ask about one table or one page before handing over a whole document.
