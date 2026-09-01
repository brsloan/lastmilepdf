// pdfjs.js
//
// The one place pdf.js is loaded and configured.
//
// It is imported by relative path out of node_modules rather than by package
// name because index.html loads this code as a plain ES module with no
// bundler and no import map - the browser needs a real path it can fetch.
//
// Configuring the worker here, at module scope, rather than in whichever
// module happens to use pdf.js first, means GlobalWorkerOptions is set before
// any importer's code can run: ES modules evaluate a dependency fully before
// the module that imported it.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

export { pdfjsLib };
