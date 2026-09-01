// types/renderer-globals.d.ts
//
// Tells the type checker what `window.api` is in the renderer.
//
// The type is derived from the object preload.js actually exposes, rather
// than written out again by hand - so the ~60 methods on that bridge can
// never drift out of sync with what the renderer thinks it can call. Add a
// method in preload.js and the renderer can use it immediately; rename one
// and every stale call site in renderer.js turns into an error.

declare global {
  interface Window {
    api: { [K in keyof PreloadApi]: PreloadApi[K] };

    /**
     * Legacy prefixed alias for AudioContext, used as a fallback by
     * playChime(). Optional because it does not exist in a current Chromium
     * (which is all Electron ever runs), so the `||` fallback in that
     * function is belt-and-braces rather than something reachable here.
     */
    webkitAudioContext?: typeof AudioContext;
  }
}

type PreloadApi = typeof import('../preload').api;

export {};
