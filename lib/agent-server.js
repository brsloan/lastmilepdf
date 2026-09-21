// lib/agent-server.js
//
// A local MCP (Model Context Protocol) server, so a Claude session running
// beside the app can look at the document the user has open, and edit its
// tags, while the user watches the same window.
//
// What it deliberately is not: a second writer. Every tool that needs the
// document goes through `requestRenderer`, which main.js answers by asking
// the window itself (see the 'agent:request' channel there and
// renderer/agent.js). The renderer already owns the docId, the tree mirror,
// the selection and the page caches, so asking it keeps one source of truth
// for "what the user is looking at" instead of a parallel one in here that
// could disagree with the screen.
//
// Kept free of Electron so scripts/agent-server-test.js can drive it under
// plain Node with a stand-in for the renderer.
//
// Security: bound to 127.0.0.1 only, every request must carry the bearer
// token, and anything a browser sent is refused outright - a web page can
// reach localhost, and its requests are recognisable by the Origin header a
// browser always attaches and an MCP client never does. The Host check closes
// the DNS-rebinding variant of the same attack.

const http = require('http');
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const MCP_PATH = '/mcp';

// A tools/call body is a few hundred bytes; nothing legitimate comes near
// this. Bounded so a stray client can't make the main process buffer without
// limit.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @typedef {object} AgentServerDeps
 * @property {(method: string, params?: object) => Promise<any>} requestRenderer
 *   Asks the app window to answer; rejects with a readable message when there
 *   is no window, no document, or the user is mid-edit.
 * @property {() => Promise<{ mediaType: string, data: string }>} captureWindow
 *   A screenshot of the app window, base64.
 * @property {string} version
 */

/** Tool result: a JSON payload, as text - what every non-image tool returns. */
function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

/**
 * Tool result for a failure the model can act on ("no document is open") -
 * reported in-band, as MCP expects, rather than as a protocol error.
 */
function errorResult(err) {
  return { content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true };
}

/** Wraps a handler so a rejection becomes an in-band tool error. */
function guarded(handler) {
  return async (args) => {
    try {
      return await handler(args || {});
    } catch (err) {
      return errorResult(err);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

// Changes what the user's window shows, but nothing in the document.
const VIEW_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Changes the document (in memory - nothing here ever writes the file).
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const NODE_ID_NOTE = 'Tag ids are renumbered by edits that reshape the tree. Every result carries treeRevision: pass the treeRevision you read an id at to any edit that uses it, and the edit is refused if that id has been renumbered since.';

const REVISION = z.number().int().min(0).describe('The treeRevision from the result you read these ids in. The edit is refused - nothing changed - if any of the ids has been renumbered since then.');

/**
 * Builds one McpServer with every tool registered. Called per request: the
 * server runs stateless (see handleMcpRequest), and an McpServer can only be
 * connected to one transport at a time.
 * @param {AgentServerDeps} deps
 */
function buildMcpServer(deps) {
  const server = new McpServer(
    { name: 'lastmilepdf', version: deps.version },
    {
      instructions:
        'Tools for the PDF the user currently has open in LastMilePDF, a PDF accessibility (tag tree) editor. '
        + 'The user is looking at the same window: use get_view to see what they have selected when they say "this", '
        + 'and go_to_page / select_nodes to show them what you mean. Pages are 1-based. '
        + 'To change tags: read and decide first, then begin_editing, make the edits, end_editing - their input is locked while a session is open. '
        + 'You cannot open or save files; the user does that, and can undo your edits with Ctrl+Z. '
        + NODE_ID_NOTE,
    },
  );

  const viaRenderer = (method) => guarded(async (args) => jsonResult(await deps.requestRenderer(method, args)));

  server.registerTool('get_app_status', {
    title: 'App status',
    description: 'Whether a PDF is open in the app, and if so its file name, page count, whether it is tagged, and whether it has unsaved changes.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, viaRenderer('getStatus'));

  server.registerTool('get_view', {
    title: 'What the user is looking at',
    description: 'The page showing in the Page Preview and the tags selected in the Tag Tree (with role, page and a text snippet each). Call this first when the user refers to "this table", "the selected tag", "this page".',
    inputSchema: {},
    annotations: READ_ONLY,
  }, viaRenderer('getView'));

  server.registerTool('get_tree_summary', {
    title: 'Tag tree summary',
    description: 'An overview of the whole tag tree without listing it: tag counts by role, tree depth, tags per page, the heading outline, and counts of common problems (figures without alt text, tables, empty tags). Start here on a new document.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, viaRenderer('getTreeSummary'));

  server.registerTool('get_nodes', {
    title: 'Read part of the tag tree',
    description: `A subtree of the tag tree as nested nodes: id, role, page, attributes (alt, actualText, lang, scope, colSpan, rowSpan) and, for tags that hold content directly, the text. Bounded by depth and maxNodes; a tag cut off by either reports childCount and truncated instead of children. ${NODE_ID_NOTE}`,
    inputSchema: {
      nodeId: z.string().optional().describe('Root of the subtree. Omit for the whole tree from the top.'),
      depth: z.number().int().min(0).max(50).optional().describe('Levels below nodeId to include. Default 3.'),
      maxNodes: z.number().int().min(1).max(2000).optional().describe('Most nodes to return. Default 300.'),
      includeText: z.boolean().optional().describe('Include each tag\'s content text. Default true; false is faster on a large subtree.'),
    },
    annotations: READ_ONLY,
  }, viaRenderer('getNodes'));

  server.registerTool('find_nodes', {
    title: 'Search the tag tree',
    description: `Finds tags by role, page range, text, or a missing attribute, returning compact rows (id, role, page, path, text snippet). Text matches a tag's Actual Text, alt text, or the page content it holds. ${NODE_ID_NOTE}`,
    inputSchema: {
      roles: z.array(z.string()).optional().describe('Structure types to match exactly, e.g. ["Table"] or ["H1","H2"].'),
      text: z.string().optional().describe('Case-insensitive substring to look for.'),
      pageFrom: z.number().int().min(1).optional(),
      pageTo: z.number().int().min(1).optional(),
      missingAlt: z.boolean().optional().describe('Only Figure/Formula tags with no alt text.'),
      limit: z.number().int().min(1).max(500).optional().describe('Most rows to return. Default 50.'),
    },
    annotations: READ_ONLY,
  }, viaRenderer('findNodes'));

  server.registerTool('verify_document', {
    title: 'Run the accessibility checks',
    description: 'Runs the app\'s Verify report (the same checks the user sees) and returns each check\'s status - pass, fail, warn or na - with its detail and the tags it failed on.',
    inputSchema: {
      maxInstances: z.number().int().min(0).max(200).optional().describe('Most failing tags to list per check. Default 20; the full count is always reported.'),
    },
    annotations: READ_ONLY,
  }, viaRenderer('verify'));

  server.registerTool('get_page_image', {
    title: 'See a page or a tag',
    description: 'A PNG of a whole page, or - with nodeId - of just the region(s) that tag\'s content occupies (one image per page it spans, up to three). Use it to check what a table, figure or heading actually looks like before judging its tags.',
    inputSchema: {
      page: z.number().int().min(1).optional().describe('1-based page to render whole. Defaults to the page the user is on.'),
      nodeId: z.string().optional().describe('Crop to this tag\'s content instead of a whole page.'),
    },
    annotations: READ_ONLY,
  }, guarded(async (args) => {
    const { images, note } = await deps.requestRenderer('getPageImage', args);
    return {
      content: [
        { type: 'text', text: note },
        ...images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mediaType })),
      ],
    };
  }));

  server.registerTool('screenshot_window', {
    title: 'Screenshot the app',
    description: 'A PNG of the app window exactly as the user sees it - tag tree, page preview with its highlight, and properties pane.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, guarded(async () => {
    const shot = await deps.captureWindow();
    return { content: [{ type: 'image', data: shot.data, mimeType: shot.mediaType }] };
  }));

  server.registerTool('go_to_page', {
    title: 'Show a page',
    description: 'Turns the user\'s Page Preview to a page. Refused while the user is in the middle of something a page turn would disrupt (a dialog, a drawn selection).',
    inputSchema: { page: z.number().int().min(1).describe('1-based page number.') },
    annotations: VIEW_ONLY,
  }, viaRenderer('goToPage'));

  server.registerTool('select_nodes', {
    title: 'Select tags',
    description: 'Selects tags in the user\'s Tag Tree, which expands to show them, highlights their content on the page and turns to that page. The way to point at something. Refused while the user is mid-edit.',
    inputSchema: { nodeIds: z.array(z.string()).min(1).max(200) },
    annotations: VIEW_ONLY,
  }, viaRenderer('selectNodes'));

  // --- editing ---------------------------------------------------------------
  //
  // Every edit tool is refused outside an editing session. The session is
  // what locks the user's input (see renderer/agent.js), so the rule for
  // Claude is the one in begin_editing's description: decide first, then
  // open, edit, close.

  server.registerTool('begin_editing', {
    title: 'Start an editing session',
    description:
      'Required before any edit. Locks the user\'s input in the app and shows them a "Claude is editing" bar with a Stop button, so that your edits and theirs can\'t collide. '
      + 'Do your reading and deciding BEFORE calling this, then make the edits and call end_editing promptly - the user can do nothing in the app while a session is open. '
      + 'Refused while the user is in the middle of something (a dialog, a drawn selection). Nothing is ever saved to disk by these tools: the user saves, and can undo every edit with Ctrl+Z.',
    inputSchema: {
      description: z.string().min(1).max(200).describe('Shown to the user in the bar - say what you are about to do, e.g. "Marking header cells in 3 tables".'),
    },
    annotations: EDIT,
  }, viaRenderer('beginEditing'));

  server.registerTool('end_editing', {
    title: 'End the editing session',
    description: 'Unlocks the user\'s input. Always call this when the edits are done, or as soon as one fails and you need to think or ask.',
    inputSchema: {
      summary: z.string().max(200).optional().describe('One line for the app\'s status bar saying what was done.'),
    },
    annotations: EDIT,
  }, viaRenderer('endEditing'));

  server.registerTool('update_nodes', {
    title: 'Change tag attributes',
    description:
      'Sets attributes on tags: role (structure type), alt, actualText, lang, and for table cells scope ("Row", "Column", "Both"), colSpan, rowSpan. '
      + 'Each entry applies one set of changes to all of its nodeIds as one undo step; use several entries to give different tags different values (e.g. alt text per figure). '
      + 'An empty string clears an attribute (role can\'t be cleared). Never changes tag ids. To change what a tag *contains* or where it sits, use apply_tag_action or move_nodes instead.',
    inputSchema: {
      revision: REVISION,
      updates: z.array(z.object({
        nodeIds: z.array(z.string()).min(1).max(500),
        changes: z.object({
          role: z.string().min(1).optional(),
          alt: z.string().optional(),
          actualText: z.string().optional(),
          lang: z.string().optional(),
          scope: z.enum(['', 'Row', 'Column', 'Both']).optional(),
          colSpan: z.string().regex(/^\d*$/).optional().describe('Digits as a string, or "" to clear.'),
          rowSpan: z.string().regex(/^\d*$/).optional().describe('Digits as a string, or "" to clear.'),
        }).strict(),
      })).min(1).max(200),
    },
    annotations: EDIT,
  }, viaRenderer('updateNodes'));

  server.registerTool('apply_tag_action', {
    title: 'Apply a tagging action',
    description:
      'Selects the given tags and applies one of the app\'s own tagging actions to them, exactly as the user\'s keyboard shortcut would. Actions: '
      + 'h1-h6, td, th, caption (set that role; a bare content leaf is wrapped in a new tag); paragraph (convert to P - a list or other container becomes one P per item); '
      + 'figure (convert to Figure); list (group into an L of LI/Lbl/LBody, detecting bullet or number labels); listItem (convert each to an LI); '
      + 'blockQuote, table, tr (group the selected sibling tags into one new BlockQuote / Table / TR); join (merge the tags into the earliest of them, or a single tag into its previous sibling). '
      + 'Grouping and join need tags that share a parent. Most of these reshape the tree and so renumber tag ids - the result says from which id. '
      + 'When making many structural edits, work from the END of the document backwards: an edit never changes the ids of tags before it.',
    inputSchema: {
      revision: REVISION,
      nodeIds: z.array(z.string()).min(1).max(500),
      action: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'paragraph', 'list', 'listItem', 'blockQuote', 'table', 'tr', 'td', 'th', 'figure', 'caption', 'join']),
    },
    annotations: EDIT,
  }, viaRenderer('applyTagAction'));

  server.registerTool('move_nodes', {
    title: 'Move tags',
    description: 'Moves tags (with everything inside them) to consecutive positions under newParentId, starting at index among its children (0 = first; its current child count = last). Use it to fix reading order or to put a tag inside the right container. One undo step.',
    inputSchema: {
      revision: REVISION,
      nodeIds: z.array(z.string()).min(1).max(500),
      newParentId: z.string().describe('The tag to move them into; "root" for the top level.'),
      index: z.number().int().min(0),
    },
    annotations: EDIT,
  }, viaRenderer('moveNodes'));

  server.registerTool('delete_nodes', {
    title: 'Delete tags',
    description:
      'Deletes tags (not bare content leaves) AND HIDES THEIR CONTENT from assistive technology: everything inside a deleted tag is turned into an artifact, which a screen reader skips. '
      + 'Right for decoration, repeated headers and footers, and empty tags; wrong for getting rid of a wrapper while keeping what is in it - for that use move_nodes to lift the children out first, or flatten_all for Div/Span/Sect wrappers. One undo step.',
    inputSchema: { revision: REVISION, nodeIds: z.array(z.string()).min(1).max(500) },
    annotations: { ...EDIT, destructiveHint: true },
  }, viaRenderer('deleteNodes'));

  server.registerTool('flatten_all', {
    title: 'Flatten organizational tags',
    description: 'The app\'s Flatten All: removes every purely organizational wrapper in the document (Div, Sect, Part, Span, Sub and Span-like custom types), keeping all content and every meaningful tag in place. Renumbers ids throughout. One undo step.',
    inputSchema: {},
    annotations: EDIT,
  }, viaRenderer('flattenAll'));

  server.registerTool('scope_tables', {
    title: 'Scope table headers',
    description: 'The app\'s Scope Tables: for every table whose TH cells form a header row, a header column, or both, sets those cells\' Scope to Column / Row / Both. Tables whose TH cells don\'t fit one of those shapes are left alone - mark the right cells TH first (apply_tag_action "th"), then run this. One undo step.',
    inputSchema: {},
    annotations: EDIT,
  }, viaRenderer('scopeTables'));

  server.registerTool('undo_last', {
    title: 'Undo the last edit',
    description: 'Takes back the most recent edit you made in this session (refused if you have made none, so it can never undo what the user did). Call it again to step further back. Every tag id may change.',
    inputSchema: {},
    annotations: EDIT,
  }, viaRenderer('undoLast'));

  return server;
}

/** Reads and parses a JSON request body, bounded by MAX_BODY_BYTES. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(message) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}

/**
 * @param {AgentServerDeps} deps
 */
function createAgentServer(deps) {
  /** @type {import('http').Server | null} */
  let httpServer = null;
  let activeToken = null;
  let activePort = null;

  function tokenMatches(header) {
    const expected = Buffer.from(`Bearer ${activeToken}`);
    const given = Buffer.from(String(header || ''));
    // timingSafeEqual throws on a length mismatch, which is itself an answer.
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function handleMcpRequest(req, res) {
    if (req.headers.origin) {
      sendJson(res, 403, rpcError('Requests from a browser are not accepted.'));
      return;
    }
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${activePort}` && host !== `localhost:${activePort}`) {
      sendJson(res, 403, rpcError('Unexpected Host header.'));
      return;
    }
    if (!tokenMatches(req.headers.authorization)) {
      sendJson(res, 401, rpcError('Missing or wrong bearer token.'), { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const url = new URL(req.url || '/', `http://${host}`);
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, rpcError('Not found.'));
      return;
    }
    // Stateless: no session to resume with GET and none to end with DELETE.
    // Each POST gets a server and transport of its own, so nothing here has
    // to survive an app restart or notice a client that went away.
    if (req.method !== 'POST') {
      sendJson(res, 405, rpcError('Method not allowed.'), { Allow: 'POST' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, rpcError(err.message));
      return;
    }

    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * @param {{ port: number, token: string }} options
   * @returns {Promise<void>} Rejects if the port can't be bound (most often
   *   EADDRINUSE - a second copy of the app, or something else on the port).
   */
  function start({ port, token }) {
    if (httpServer) return Promise.resolve();
    activeToken = token;
    activePort = port;
    const created = http.createServer((req, res) => {
      handleMcpRequest(req, res).catch((err) => {
        console.error('[agent-server] request failed:', err);
        if (!res.headersSent) sendJson(res, 500, rpcError('Internal error.'));
        else res.end();
      });
    });
    return new Promise((resolve, reject) => {
      created.once('error', reject);
      created.listen(port, '127.0.0.1', () => {
        created.off('error', reject);
        created.on('error', (err) => console.error('[agent-server]', err));
        httpServer = created;
        resolve();
      });
    });
  }

  function stop() {
    const closing = httpServer;
    httpServer = null;
    if (!closing) return Promise.resolve();
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      closing.close(() => resolve());
      // close() waits for keep-alive connections to drain on their own,
      // which an idle MCP client never does.
      closing.closeAllConnections();
    }));
  }

  return {
    start,
    stop,
    isRunning: () => httpServer !== null,
  };
}

module.exports = { createAgentServer, MCP_PATH };
