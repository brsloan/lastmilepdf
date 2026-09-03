# LastMilePDF

![screenshot](images/screenshot.png)

LastMilePDF is for cleaning up auto-tagged PDFs, especially those made from scanned images. Its purpose is to have the best possible user-interface for manual tag changes, with optional built-in AI assistance for proofreading OCR errors.

For small organizations that can only afford Adobe Acrobat for tagging PDFs, this tool is a companion, since its strengths are in Acrobat's weakness (their terrible UI with no keyboard shortcuts, etc.).

Features:
- Quick, easy tag editing, reordering, conversion, etc. with convenient shortcuts
- Table editor with auto-scope options
- Find/Replace for tag types
- Visual script builder for sequencing/automating repeated actions
- Flatten button for removing extraneous span/div tags
- Use AI to clean up OCR errors in Actual Text fields, highlighting changes for approval (configurable to use any AI provider)
- Tag figures on scanned pages that were missed by auto-tagger
- Easily filter to just figures for quick alt-text adding, tables for reviewing, etc.
- Walk feature walks the tree automatically at the pace you set so you don't have to keep pressing the down key to walk the whole tree
- Proofread mode allows quick comparison between OCR text and original image with AI fixes highlighted in yellow
- Show AT Changes lets you highlight any differences between Actual Text and the OCR text so review your own edits
- Smartifact automatically artifacts full-page figures at a click (for when auto-taggers generate figures for every page of a scanned document, a common nuisance)

What it is not for and currently can't do:
- It can't run OCR
- It can't auto-tag
- It does not currently support full manual tagging

These are all things we may add for the future, but as said above the idea for now is to compliment the technologies people are most likely to already have: Adobe Acrobat, etc.

## Info For Developers

This is pretty much entirely vibe-coded using Claude. The rest of the readme is info written by Claude.

A standalone Electron app for viewing a PDF and editing its accessibility
structure tree (the tag tree behind PDF/UA compliance). 

Vanilla JavaScript, no framework, no bundler, no TypeScript.

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

The suite runs against one checked-in fixture PDF (`test-complex-generated.pdf`),
covering alt text and Actual Text, document title/author/language, role
changes, delete, insert, reorder, undo/redo, flatten, figure-from-rectangle,
list grouping, table scoping and structure, bookmarks, and rejection of bad
input. The fixture is opened read-only; every save goes to a temp directory
that is removed afterwards.

Tests **skip** rather than fail when the fixture lacks suitable input for a
given check. Skips are reported so a fixture change that silently stops
exercising something is visible.

Adding a check is worthwhile whenever a bug turns out to have been in
`tag_worker.py`: reproduce it as an edit/save/reopen assertion, and it can't
come back quietly.

## Packaging

For distribution to users who don't have Node or Python installed, the app
ships with the tag worker compiled into a standalone executable (via
PyInstaller) rather than spawning a system Python. Windows and Linux are
both built and CI-tested (`.github/workflows/release.yml` builds both on
every version tag); see "Platform support" below for macOS.

**Windows:**

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

Neither build is code-signed, so first launch on another machine will show
a SmartScreen "Windows protected your PC" warning (unrelated to admin
rights - dismiss via "More info" -> "Run anyway"). Getting rid of that
warning requires a paid code-signing certificate.

**Linux:**

```
pip install pyinstaller   # into .venv, alongside pikepdf
npm run dist:linux
```

Same two steps as Windows, using the venv's own `bin/python` instead of
`Scripts\python.exe`, producing a single `LastMilePDF-<version>.AppImage` -
no install step, just `chmod +x` and run. Running it needs `libfuse2` on
distros that dropped it by default (Ubuntu 22.04+, for one) - see
[AppImage's FUSE requirement](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
if it won't launch.

`main.js` picks between the dev path (`.venv` + `tag_worker.py`) and the
packaged executable automatically via `app.isPackaged`, and between the
`.exe`/no-extension executable name via `process.platform` - see
`packagedWorkerPath()`.

### Platform support

Windows and Linux are both packaged, CI-built on every release tag, and
covered by `npm test`/`npm run typecheck` in CI (see
`.github/workflows/ci.yml`, which runs on `windows-latest` and
`ubuntu-latest`). **macOS is not currently packaged.** `main.js` already
resolves a `.venv`/Python path for `darwin` the same way it does for
Windows and Linux, so running from source (`npm start`) should work, but
nobody builds, signs, or tests an actual `.app`/`.dmg` - treat that path as
unverified. Unsigned macOS builds are also blocked hard by Gatekeeper
(worse than Windows SmartScreen) without a paid Apple Developer account to
sign and notarize, which is the main reason this isn't done yet. A
`mac` block in package.json's `build` config plus a
`build-macos`/`macos-latest` job in the release workflow (mirroring the
Linux one added here) is what adding it would take, PRs welcome.

### Auto-update

The installed Windows build (NSIS) and the Linux AppImage both check
GitHub Releases for a newer version on launch via
[electron-updater](https://www.electron.build/auto-update), unless turned
off in Preferences - electron-updater supports both formats' self-replace
natively. Finding one only ever shows a native alert - actually
downloading and installing always needs an explicit click, from Help >
About. The Windows *portable* exe can't replace its own running file in
place, so it skips downloading/installing and just opens the release page
instead (see `isPortableBuild` in main.js).

This relies on `.github/workflows/release.yml` uploading each platform's
`latest.yml`/`latest-linux.yml` and `.blockmap` files alongside the
installers - `dist:win`/`dist:linux` build with `--publish never` (see
`build.publish` in package.json), so electron-builder writes those locally
without trying to upload anywhere itself; the workflow's own GitHub
Release step does the actual upload.

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

## Contributing

Bug reports and PRs are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to get set up and what to check before opening a PR. This project
follows a [Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue?
See [SECURITY.md](SECURITY.md) rather than opening a public issue.

## Troubleshooting

- **"pikepdf is not installed"** - the interpreter `main.js` spawned
  doesn't have pikepdf. Confirm which interpreter that is (see
  `PYTHON_BIN` above) and `pip install -r python/requirements.txt` into it.
- **Worker seems to hang, or something else goes wrong** - check the log
  file (Help > Open Log Folder), which mirrors every diagnostic message
  main.js logs for the current session, including the Python worker's
  stderr/tracebacks. Running from source, the same output also goes to the
  terminal running `npm start`. The log is truncated fresh on every
  launch, so reproduce the problem before checking it.

## License

MIT - see [LICENSE](LICENSE).

This app bundles two open-source dependencies with their own licenses:
[pikepdf](https://github.com/pikepdf/pikepdf) (MPL-2.0), compiled into the
packaged `tag_worker.exe`, and [pdf.js](https://github.com/mozilla/pdf.js)
(Apache-2.0), which renders the page preview.
