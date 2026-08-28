# PDF Tag Editor (scaffold)

A standalone Electron app for viewing a PDF and editing its accessibility
structure tree (the tag tree behind PDF/UA compliance). Vanilla JavaScript,
no framework, no bundler, no TypeScript.

This is a **starting scaffold**, not a finished tool - it demonstrates the
architecture end-to-end (open a tagged PDF, see the tree, edit roles/alt
text/language, drag-reorder, save) but leaves several things for you to
harden. See **Known limitations** below before relying on it.

## Architecture

```
renderer/ (Chromium, no Node access)
  index.html    - layout: toolbar, PDF canvas pane, tag tree pane, details form
  renderer.js   - PDF.js viewer, tag tree rendering + drag/drop, wiring to window.api
  styles.css

preload.js      - contextBridge: exposes window.api.{openPdf,updateNode,updateNodes,
                  shiftHeadingLevels,reorderNode,reorderMany,killDivs,undo,redo,
                  savePdf,saveToPath,onMenu*}
main.js         - BrowserWindow, native dialogs, owns the Python sidecar process

python/
  tag_worker.py - long-running pikepdf sidecar, speaks JSON-lines over stdio
  requirements.txt
```

`main.js` spawns `python/tag_worker.py` once at startup and keeps it alive
for the life of the app, rather than shelling out per edit - that avoids
re-parsing the PDF on every tag change. Communication is newline-delimited
JSON on stdin/stdout:

```
-> {"id": 1, "cmd": "open", "path": "/path/to/file.pdf"}
<- {"id": 1, "result": {"docId": "...", "hasStructTree": true, "tree": {...}}}
```

Every mutating command (`update_node`, `reorder`) returns the **entire**
rebuilt tree rather than a patch. Node ids are just a depth-first counter
reassigned on every rebuild, so the renderer always throws away its old
tree and re-renders from the fresh one - there's no way for the UI to hold
a stale id that silently points at the wrong node after an edit.

PDF.js renders the page preview and is linked to the tag tree in both
directions: selecting a tag highlights its marked content on the page
(text only - see limitations), and clicking marked content on the page
selects its owning tag.

## Setup

**1. Install Node dependencies**

```
npm install
```

**2. Install the Python sidecar's dependency**

The worker needs `pikepdf` on whatever Python interpreter `main.js` will
spawn (`python3` on macOS/Linux, `python` on Windows, or override with the
`PYTHON_BIN` environment variable - see below). A virtual environment is
recommended:

```
python3 -m venv .venv
source .venv/bin/activate        # .venv\Scripts\activate on Windows
pip install -r python/requirements.txt
```

If you use a venv, run the app with `PYTHON_BIN` pointing at its
interpreter, e.g. `PYTHON_BIN=$(pwd)/.venv/bin/python npm start`.

**3. Run it**

```
npm start
```

## Known limitations

Things this scaffold deliberately does not solve yet:

- **Content leaves can't move across pages.** A bare MCID leaf (unlike an
  `/MCR` or `/OBJR` dict) has no `/Pg` of its own - it inherits whatever
  page its containing StructElem resolves to - so reparenting one onto a
  tag on a different page is refused rather than silently mislabeling
  which page it points at. Same-page reordering/reparenting is supported.
- **Drop = append as last child.** There's no drop-position indicator for
  inserting a node between two specific siblings; dropping onto a node
  always appends to the end of its children. Worth adding before this is
  a real editing tool.
- **Page highlight/click-to-select is text-only.** Both directions of the
  PDF.js <-> tag tree link work off `getTextContent()`, so a Figure/Formula
  tag's marked content (normally an image `Do` call) won't highlight, and
  clicking on an image in the preview won't select its tag.
- **`RoleMap` / `ParentTree` / `ClassMap` are ignored.** Custom
  (non-standard) role names round-trip as opaque strings; nothing here
  resolves them against a document's `RoleMap`.
- **No accessibility validation.** This was intentionally left out (no
  veraPDF integration). Check output against PDF/UA with an external tool
  (e.g. veraPDF or PAC) until/unless you wire in a validator.
- **Whole-file IPC transfer.** The opened PDF is read into memory and
  passed to the renderer as base64 in one shot. Fine for typical
  documents; a very large PDF would benefit from streaming instead.
- **Single document at a time.** No tabs/multi-document support.

## Troubleshooting

- **"pikepdf is not installed"** - the interpreter `main.js` spawned
  doesn't have pikepdf. Confirm which interpreter that is (see
  `PYTHON_BIN` above) and `pip install -r python/requirements.txt` into it.
- **Worker seems to hang** - check the terminal running `npm start`;
  `main.js` forwards the Python process's stderr there, including
  tracebacks.
