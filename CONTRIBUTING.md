# Contributing to LastMilePDF

Thanks for considering a contribution. This is a small, single-maintainer
project, so keeping changes focused and well-tested matters more than
process.

## Setup

Follow the [Setup section in the README](README.md#setup) to install Node
and Python dependencies. Then confirm everything works:

```
npm run typecheck
npm test
```

Both should pass cleanly before you start, and again before you open a PR.

## Before opening a PR

- **Read the [Architecture](README.md#architecture) and [Renderer module
  layout](README.md#renderer-module-layout) sections first** if your
  change touches `renderer/`. The module layering (leaves → low-level →
  features → entry) and the one deliberate `tree-view.js` ↔ `details.js`
  import cycle are load-bearing; `npm run typecheck` catches an
  accidental new cycle.
- **Run `npm run typecheck`.** It covers `main.js`, `preload.js`,
  `scripts/`, and every renderer module, and reports real mistakes (wrong
  argument counts, misspelled `state`/`window.api` fields, unexpected
  import cycles).
- **Run `npm test`.** If your change touches `python/tag_worker.py`,
  add a test case following the existing pattern in
  `scripts/smoke-test.js`: make an edit, save, reopen, assert the edit
  survived. That's the layer where PDF-correctness bugs actually live -
  see the [Tests section](README.md#tests) for why.
- **If you change a dict key `tag_worker.py` sends or expects**, update
  `types/domain.d.ts` to match - it's a hand-written contract, not
  something the type checker can verify against Python.
- **For UI changes**, run the app (`npm start`) and exercise the feature
  by hand. There's no automated UI test suite (see the README's Tests
  section for why); the smoke tests only exercise the Python worker.

## Code style

- Plain JavaScript with JSDoc types, no build step, no framework. Match
  the existing style rather than introducing new patterns.
- Comments explain *why*, not *what* - skip a comment if removing it
  wouldn't confuse a future reader.
- Keep changes scoped to what they're solving; avoid drive-by refactors
  in the same PR as a bug fix or feature.

## Opening a PR

Describe what changed and why. Link any related issue. CI runs
`npm run typecheck` and `npm test` on both Windows and Linux runners for
every PR - please make sure both are green before requesting review.

By contributing, you agree your contributions will be licensed under this
project's [MIT license](LICENSE).
