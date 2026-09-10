// theme-boot.js
//
// Stamps the saved color theme onto <html> before anything is painted.
//
// This is a plain classic script, loaded from <head> without defer or
// type="module", precisely so it is NOT deferred: it executes while the
// parser is still above <body>, which is the only point early enough to set
// the attribute without the window first painting in the wrong theme. The
// app's CSP forbids inline scripts (script-src 'self' file:), so this has to
// be its own file rather than a <script> block in index.html.
//
// It is also the one place in the renderer that reads a preference
// synchronously - see getResolvedThemeSync() in preload.js for why.
//
// Kept deliberately tiny and dependency-free. It runs before renderer.js and
// before any module graph exists, so it can import nothing.
(() => {
  // The value is already validated and resolved in main.js, so 'auto' never
  // arrives here and an unknown name is impossible. Falling back to no
  // attribute at all is still the right failure mode: the bare :root block
  // is the dark theme, so the app is fully styled either way.
  try {
    const theme = window.api.getResolvedThemeSync();
    if (theme && theme !== 'dark') {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    // Nothing to report to - the UI this would talk to does not exist yet.
    // Dark is a working theme, so swallowing this is better than blocking
    // startup on a failed settings read.
  }
})();
