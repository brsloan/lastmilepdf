# LastMilePDF

A standalone Electron app for viewing a PDF and editing its accessibility
structure tree (the tag tree behind PDF/UA compliance). Vanilla JavaScript,
no framework, no bundler, no TypeScript.

## Architecture

```
renderer/ (Chromium, no Node access)
  index.html    - layout: toolbar, PDF canvas pane, tag tree pane, details form
  renderer.js   - entry point: event wiring, menu handlers
  styles.css

  state.js dom.js util.js pdfjs.js        - leaves: shared state, elements, helpers
  shell.js tree-index.js page-content.js  - title/status, tree lookups, page reads
  viewer.js       - PDF.js page rendering + the tag highlight overlay
  tree-view.js    - the tag tree: rows, filtering, drag/drop, selection
  details.js      - the tag properties pane
  editing.js      - structural edits: move, delete, role changes, grouping, undo
  doc-io.js       - open / save / close
  bookmarks.js verify.js table-preview.js table-editor.js
  actual-text.js find-replace.js walk.js figure-draw.js ai-batch.js
  actions.js scripts.js
                  - one feature each; see "Renderer module layout" below

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

## Renderer module layout

The renderer is split into small ES modules, loaded natively by the browser -
still no bundler and no build step. `renderer.js` is the entry point: it holds
the event wiring (which button does what, which menu message goes where) and
imports everything else.

Modules are layered, and the layering is what keeps the graph from tangling:

| Layer | Modules | Depends on |
| --- | --- | --- |
| Leaves | `state`, `dom`, `util`, `pdfjs` | nothing |
| Low-level | `shell`, `tree-index`, `page-content` | leaves |
| Features | `viewer`, `tree-view`, `details`, `bookmarks`, `table-preview`, `table-editor`, `actual-text`, `editing`, `doc-io`, `verify`, `find-replace`, `walk`, `figure-draw`, `ai-batch`, `actions`, `scripts` | the above |
| Entry | `renderer.js` | everything |

Two things are worth knowing before moving code between them:

- **`state.js` and `dom.js` must stay leaves.** Everything imports them, so
  the moment one of them imports a feature module, most of the renderer
  becomes one cycle. `npm run typecheck` fails if that happens.
- **There is exactly one deliberate import cycle**, `tree-view` <->
  `details`: selecting a row refreshes the properties pane, and editing in
  that pane rewrites the tree. It is safe only because every function
  crossing it is a hoisted `function` declaration. The reasoning is written
  out at the top of `renderer/tree-view.js`, and `npm run typecheck` reports
  any *other* cycle that appears.
- **`actions.js` holds the one copy of each action a script can run**
  (Smartifact, Scope Tables, Flatten All, Find/Replace, Fix All Actual Text
  (AI)). Both the matching toolbar button and `scripts.js`'s Tools >
  Scripts… runner call the same function, so a step behaves identically
  whether it's clicked directly or run as part of a saved script.

## Type checking

The code is plain JavaScript with no build step - `npm start` runs the
source directly. Types are supplied by JSDoc comments and the declarations
in `types/`, and checked without compiling anything:

```
npm run typecheck
```

It covers `main.js`, `preload.js`, `scripts/` and every module in
`renderer/`, and reports mistakes TypeScript can see statically: a misspelled
`window.api` method or `state` field, a call with the wrong number of
arguments, a string where a number belongs, a property that doesn't exist on
an element, a name used in a module that doesn't import it. It also reports
unexpected import cycles (see above). It emits nothing and changes nothing.

Two projects are checked, because the two halves of the app run in different
places and need opposite settings:

| Config | Covers | Environment |
| --- | --- | --- |
| `jsconfig.json` | `main.js`, `preload.js`, `scripts/` | CommonJS, Node globals |
| `renderer/jsconfig.json` | every module in `renderer/` | ES modules, DOM globals |

Shared shapes live in `types/domain.d.ts` (what crosses the JS/Python
boundary) and `types/app-state.d.ts` (the renderer's `state` object). The
type of `window.api` isn't written out by hand - it's derived from the
object `preload.js` exposes, so the bridge and the renderer can't drift
apart.

Two caveats worth knowing:

- The Python worker is a separate process handing over JSON. TypeScript
  can't check it, so `types/domain.d.ts` is a written-down contract, not a
  proof - **if you change a dict key in `tag_worker.py`, change it there
  too.**
- Settings are deliberately loose (`strict` and `noImplicitAny` off), so an
  unannotated parameter is simply untyped rather than an error. Tighten them
  as more of the code gains annotations.

## Tests

```
npm test
```

Runs `scripts/smoke-test.js`, which drives `python/tag_worker.py` directly
over the same JSON-lines protocol `main.js` uses - no Electron and no UI
involved. It takes about 8 seconds.

This covers the layer where the bugs actually happen. The worker is where PDF
semantics live, and a wrong edit there produces a file that looks correct in
this app but is broken in Acrobat; neither the type checker nor the renderer
can see that. Nearly every test therefore has the same shape:

> make an edit -> save -> reopen the saved file -> check the edit is really
> there and the document still parses

An edit that only holds until you close the file is exactly the failure mode
worth catching, and it is invisible from inside the running app.

The suite runs against the three checked-in fixture PDFs (`test-figure.pdf`,
`test-complex-short.pdf`, `test-complex.pdf`), covering alt text and Actual
Text, document title/author/language, role changes, delete, insert, reorder,
undo/redo, flatten, figure-from-rectangle, list grouping, table scoping and
structure, bookmarks, and rejection of bad input. Fixtures are opened
read-only; every save goes to a temp directory that is removed afterwards.

Tests **skip** rather than fail when a fixture lacks suitable input - the
minimal `test-figure.pdf` has no tables or spans, for example. Every test
runs against at least one fixture, and `test-complex.pdf` exercises all of
them. Skips are reported so a fixture change that silently stops exercising
something is visible.

Adding a check is worthwhile whenever a bug turns out to have been in
`tag_worker.py`: reproduce it as an edit/save/reopen assertion, and it can't
come back quietly.

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
