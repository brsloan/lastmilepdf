# LastMilePDF

A standalone Electron app for viewing a PDF and editing its accessibility
structure tree (the tag tree behind PDF/UA compliance). Vanilla JavaScript,
no framework, no bundler, no TypeScript.

## Architecture

```
renderer/ (Chromium, no Node access)
  index.html    - layout: toolbar, PDF canvas pane, tag tree pane, details form
  renderer.js   - PDF.js viewer, tag tree rendering + drag/drop, wiring to window.api
  styles.css

preload.js      - contextBridge: exposes window.api.{openPdf,updateNode,updateNodes,
                  shiftHeadingLevels,reorderNode,reorderMany,flattenTags,undo,redo,
                  savePdf,saveToPath,onMenu*}
main.js         - BrowserWindow, native dialogs, owns the Python sidecar process

python/
  tag_worker.py - long-running pikepdf sidecar, speaks JSON-lines over stdio
  requirements.txt

build/           - installer icon (icon.ico/icon.png)
python-dist/      - PyInstaller output (tag_worker.exe), gitignored
dist/             - electron-builder output (installer/portable exe), gitignored
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
directions: selecting a tag highlights its marked content on the page,
and clicking marked content on the page selects its owning tag.

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

## Packaging

For distribution to users who don't have Node or Python installed, the app
ships with the tag worker compiled into a standalone exe (via PyInstaller)
rather than spawning a system Python:

```
pip install pyinstaller   # into .venv, alongside pikepdf
npm run dist:win
```

This runs two steps:

1. `build:worker` - compiles `python/tag_worker.py` (with `pikepdf` and its
   bundled `qpdf`/`msvc` DLLs) into `python-dist/tag_worker.exe`.
2. `electron-builder --win` - bundles the app plus that exe (as
   `resources/python/tag_worker.exe`) into `dist/`, producing:
   - `LastMilePDF Setup <version>.exe` - a per-user NSIS installer
     (`perMachine: false`, so it installs to the user's own AppData and
     never triggers a UAC/admin prompt).
   - `LastMilePDF-<version>-portable.exe` - a single portable exe, no
     install step at all.

`main.js` picks between the dev path (`.venv` + `tag_worker.py`) and the
packaged exe automatically via `app.isPackaged` - see `packagedWorkerPath()`.

Neither build is code-signed, so first launch on another machine will show
a SmartScreen "Windows protected your PC" warning (unrelated to admin
rights - dismiss via "More info" -> "Run anyway"). Getting rid of that
warning requires a paid code-signing certificate.

## Known limitations

Things this scaffold deliberately does not solve yet:

- **Content leaves can't move across pages.** A bare MCID leaf (unlike an
  `/MCR` or `/OBJR` dict) has no `/Pg` of its own - it inherits whatever
  page its containing StructElem resolves to - so reparenting one onto a
  tag on a different page is refused rather than silently mislabeling
  which page it points at. Same-page reordering/reparenting is supported.
- **`RoleMap` / `ClassMap` are ignored.** Custom (non-standard) role names
  round-trip as opaque strings; nothing here resolves them against a
  document's `RoleMap`.
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
