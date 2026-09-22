// lib/fix-prompt.js
//
// The default instructions behind "Fix this PDF": what a Claude session
// follows when the user asks it to remediate a whole document. The text lives
// in fix-document-prompt.txt beside this file, so it can be revised as plain
// prose; the user can replace it with their own in File > Settings >
// Preferences > Claude connection, and main.js hands whichever is current to
// lib/agent-server.js, which serves it as the fix_document prompt and the
// get_remediation_instructions tool.

const fs = require('fs');
const path = require('path');

const DEFAULT_FIX_PROMPT = fs.readFileSync(path.join(__dirname, 'fix-document-prompt.txt'), 'utf8')
  .replace(/\r\n?/g, '\n')
  .trim();

// Several times the default's length. Bounded because the text goes out in
// every tool result that carries it, and a runaway paste would cost the user
// tokens on each one.
const MAX_FIX_PROMPT_CHARS = 20000;

/**
 * The form a prompt is stored and compared in: Unix line endings, no
 * surrounding whitespace, at most MAX_FIX_PROMPT_CHARS long.
 * @param {string} text
 */
function normaliseFixPrompt(text) {
  return String(text).replace(/\r\n?/g, '\n').trim().slice(0, MAX_FIX_PROMPT_CHARS);
}

module.exports = { DEFAULT_FIX_PROMPT, MAX_FIX_PROMPT_CHARS, normaliseFixPrompt };
