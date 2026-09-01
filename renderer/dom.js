// dom.js
//
// Every element renderer/index.html is expected to contain, looked up once
// and typed by kind.
//
// A leaf module like state.js - it imports nothing from the app, so anything
// may import it. See the note above the lookup helpers for what the casts do
// and don't guarantee.

/** @param {string} id @returns {HTMLElement} */
const asElement = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLButtonElement} */
const asButton = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLInputElement} */
const asInput = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLSelectElement} */
const asSelect = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLTextAreaElement} */
const asTextarea = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLDialogElement} */
const asDialog = (id) => /** @type {HTMLDialogElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLCanvasElement} */
const asCanvas = (id) => /** @type {HTMLCanvasElement} */ (document.getElementById(id));

/** @param {string} id @returns {HTMLFormElement} */
const asForm = (id) => /** @type {HTMLFormElement} */ (document.getElementById(id));

export const el = {
  btnOpen: asButton('btn-open'),
  btnFlatten: asButton('btn-flatten'),
  btnScopeTables: asButton('btn-scope-tables'),
  btnSmartifact: asButton('btn-smartifact'),
  btnAddFigure: asButton('btn-add-figure'),
  btnAddP: asButton('btn-add-p'),
  btnWalk: asButton('btn-walk'),
  btnVerify: asButton('btn-verify'),
  tagFilter: asSelect('tag-filter'),
  statusBar: asElement('status-bar'),
  noStructBanner: asElement('no-struct-banner'),
  canvas: asCanvas('pdf-canvas'),
  viewerPlaceholder: asElement('viewer-placeholder'),
  btnPrevPage: asButton('btn-prev-page'),
  btnNextPage: asButton('btn-next-page'),
  pageIndicatorInput: asInput('page-indicator-input'),
  pageIndicatorTotal: asElement('page-indicator-total'),
  tagTree: asElement('tag-tree'),
  highlightLayer: asElement('highlight-layer'),
  drawOverlay: asElement('draw-overlay'),
  detailsEmpty: asElement('details-empty'),
  detailsForm: asForm('details-form'),
  fieldNodeId: asInput('field-node-id'),
  fieldRole: asInput('field-role'),
  fieldAlt: asTextarea('field-alt'),
  fieldAltWrap: asElement('field-alt-wrap'),
  fieldActualText: asTextarea('field-actual-text'),
  fieldActualTextWrap: asElement('field-actual-text-wrap'),
  fieldDocInfoSection: asElement('field-docinfo-section'),
  fieldDocTitle: asInput('field-doc-title'),
  fieldDocAuthor: asInput('field-doc-author'),
  tablePreviewWrap: asElement('field-table-preview'),
  tablePreviewContainer: asElement('table-preview-container'),
  btnExpandTablePreview: asButton('btn-expand-table-preview'),
  tablePreviewDialog: asDialog('table-preview-dialog'),
  tablePreviewDialogContainer: asElement('table-preview-dialog-container'),
  btnCloseTablePreview: asButton('btn-close-table-preview'),
  tableEditorForm: asForm('table-editor-fields'),
  tableEditorHint: asElement('table-editor-hint'),
  tableEditorFieldRow: asElement('table-editor-field-row'),
  tableEditorScopeWrap: asElement('table-editor-scope-wrap'),
  tableEditorScope: asSelect('table-editor-scope'),
  tableEditorColSpan: asInput('table-editor-col-span'),
  tableEditorRowSpan: asInput('table-editor-row-span'),
  btnTableEditorToTh: asButton('btn-table-editor-to-th'),
  btnTableEditorToTd: asButton('btn-table-editor-to-td'),
  fieldLang: asInput('field-lang'),
  fieldLangLabel: asElement('field-lang-label'),
  thSection: asElement('field-th-section'),
  fieldScopeWrap: asElement('field-scope-wrap'),
  fieldScope: asSelect('field-scope'),
  fieldColSpan: asInput('field-col-span'),
  fieldRowSpan: asInput('field-row-span'),
  btnPullContent: asButton('btn-pull-content'),
  btnFixActualText: asButton('btn-fix-actual-text'),
  btnFixAllActualText: asButton('btn-fix-all-actual-text'),
  aiBatchProgressDialog: asDialog('ai-batch-progress-dialog'),
  aiBatchProgressEstimate: asElement('ai-batch-progress-estimate'),
  aiBatchProgressTimer: asElement('ai-batch-progress-timer'),
  actualTextHighlight: asElement('field-actual-text-highlight'),
  actualTextReviewBar: asElement('actual-text-review-bar'),
  actualTextReviewLabel: asElement('actual-text-review-label'),
  btnRevertAiFix: asButton('btn-revert-ai-fix'),
  settingsDialog: asDialog('settings-dialog'),
  settingsForm: asForm('settings-form'),
  btnCloseSettings: asButton('btn-close-settings'),
  settingsApiKey: asInput('settings-api-key'),
  settingsApiKeyStatus: asElement('settings-api-key-status'),
  btnSaveApiKey: asButton('btn-save-api-key'),
  btnClearApiKey: asButton('btn-clear-api-key'),
  shortcutsDialog: asDialog('shortcuts-dialog'),
  btnCloseShortcuts: asButton('btn-close-shortcuts'),
  helpDialog: asDialog('help-dialog'),
  btnCloseHelp: asButton('btn-close-help'),
  aboutDialog: asDialog('about-dialog'),
  btnCloseAbout: asButton('btn-close-about'),
  aboutVersion: asElement('about-version'),
  verifyDialog: asDialog('verify-dialog'),
  btnCloseVerify: asButton('btn-close-verify'),
  verifyBody: asElement('verify-body'),
  detailsPane: asElement('details-pane'),
  findReplaceDialog: asDialog('find-replace-dialog'),
  btnCloseFindReplace: asButton('btn-close-find-replace'),
  findReplaceFind: asInput('find-replace-find'),
  findReplaceReplace: asInput('find-replace-replace'),
  findReplaceStatus: asElement('find-replace-status'),
  btnFindNext: asButton('btn-find-next'),
  btnFindReplaceOne: asButton('btn-find-replace-one'),
  btnFindReplaceAll: asButton('btn-find-replace-all'),
  tabProperties: asButton('tab-properties'),
  tabBookmarks: asButton('tab-bookmarks'),
  panelProperties: asElement('panel-properties'),
  panelBookmarks: asElement('panel-bookmarks'),
  btnAddBookmark: asButton('btn-add-bookmark'),
  btnGenerateBookmarks: asButton('btn-generate-bookmarks'),
  bookmarksEmpty: asElement('bookmarks-empty'),
  bookmarkTree: asElement('bookmark-tree'),
};

/**
 * Every selectable row currently in the tag tree, in display order.
 *
 * querySelectorAll is typed as returning plain `Element`, which has no
 * `dataset` - but these rows are the divs renderTreeNode() builds, each
 * carrying a data-node-id. Naming the query once narrows it for all its
 * call sites and keeps the selector in a single place.
 *
 * @returns {HTMLElement[]}
 */
export function selectableRows() {
  return /** @type {HTMLElement[]} */ (
    Array.from(el.tagTree.querySelectorAll('.tree-row.selectable'))
  );
}
