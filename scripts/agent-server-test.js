#!/usr/bin/env node
// scripts/agent-server-test.js
//
// Two modes.
//
//   node scripts/agent-server-test.js
//     Starts lib/agent-server.js under plain Node with a stand-in for the
//     renderer, and talks to it with the MCP SDK's own client - so what is
//     being checked is that a real MCP client can connect, list the tools and
//     call them, and that the door is shut to everything else (no token, a
//     browser's Origin header, a rebinding Host). Part of `npm test`.
//
//   node scripts/agent-server-test.js --live <token> [tool] [json-args]
//     Connects to the server inside a *running* app instead. With no tool it
//     lists them and prints get_app_status; with one it prints that tool's
//     result, and saves any images it returns next to the OS temp dir. This is
//     how to see what Claude would see:
//
//       set LASTMILEPDF_AGENT_TOKEN=dev-token-dev-token-dev-token-1234
//       set LASTMILEPDF_OPEN=test-complex.pdf
//       npm start
//       node scripts/agent-server-test.js --live dev-token-dev-token-dev-token-1234 get_view

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createAgentServer, MCP_PATH } = require('../lib/agent-server');

// AGENT_SERVER_PORT in main.js, or whatever LASTMILEPDF_AGENT_PORT moved a test instance to.
const LIVE_PORT = Number(process.env.LASTMILEPDF_AGENT_PORT) || 47821;
const TEST_PORT = 47899;
const TEST_TOKEN = 'test-token-0123456789abcdef0123456789';

// A 1x1 transparent PNG - enough to prove image content survives the trip.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function connect(port, token) {
  const client = new Client({ name: 'agent-server-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** A bare POST, for the cases the SDK client would never send. */
function rawPost(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: MCP_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

// --- live mode --------------------------------------------------------------

/** @param {string[]} argv */
async function runLive(argv) {
  let [token, tool, jsonArgs] = argv;
  if (!token) {
    console.error('usage: agent-server-test.js --live <token> [tool] [json-args]');
    process.exit(2);
  }
  const client = await connect(LIVE_PORT, token);
  if (!tool) {
    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);
    tool = 'get_app_status';
  }
  const result = await client.callTool({ name: tool, arguments: jsonArgs ? JSON.parse(jsonArgs) : {} });
  let imageIndex = 0;
  for (const part of /** @type {any[]} */ (result.content)) {
    if (part.type === 'text') console.log(part.text);
    if (part.type === 'image') {
      imageIndex += 1;
      const out = path.join(os.tmpdir(), `lastmilepdf-${tool}-${imageIndex}.png`);
      fs.writeFileSync(out, Buffer.from(part.data, 'base64'));
      console.log(`[image saved to ${out}]`);
    }
  }
  if (result.isError) process.exitCode = 1;
  await client.close();
}

// --- test mode --------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

async function runTests() {
  console.log('agent server');

  /** @type {{ method: string, params: any }[]} */
  const seen = [];
  const server = createAgentServer({
    version: '0.0.0-test',
    requestRenderer: async (method, params) => {
      seen.push({ method, params });
      if (method === 'getStatus') return { documentOpen: true, fileName: 'fake.pdf', pageCount: 3 };
      if (method === 'getPageImage') return { images: [{ mediaType: 'image/png', data: TINY_PNG, page: 1 }], note: 'Page 1 of 3.' };
      if (method === 'goToPage') throw new Error("Can't turn the page right now: the Table Editor dialog is open in the user's window.");
      return { ok: true };
    },
    captureWindow: async () => ({ mediaType: 'image/png', data: TINY_PNG }),
  });
  await server.start({ port: TEST_PORT, token: TEST_TOKEN });

  try {
    await test('an MCP client can connect and list the tools', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      const expected = ['apply_tag_action', 'begin_editing', 'delete_nodes', 'end_editing', 'find_nodes', 'flatten_all',
        'get_app_status', 'get_nodes', 'get_page_image', 'get_tree_summary', 'get_view', 'go_to_page', 'move_nodes',
        'scope_tables', 'screenshot_window', 'select_nodes', 'undo_session_edits', 'update_nodes', 'verify_document'];
      assertEqual(names.join(), expected.join(), 'the tool list has changed - update this test if that was meant');
      for (const tool of tools) assert(tool.description, `${tool.name} has no description`);
      await client.close();
    });

    await test('a tool call reaches the renderer and its answer comes back', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const result = await client.callTool({ name: 'get_app_status', arguments: {} });
      const payload = JSON.parse(/** @type {any} */ (result.content)[0].text);
      assertEqual(payload.fileName, 'fake.pdf', 'the renderer\'s answer did not come back');
      await client.close();
    });

    await test('arguments are passed through to the renderer', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      await client.callTool({ name: 'find_nodes', arguments: { roles: ['Table'], pageFrom: 2 } });
      const call = seen.filter((s) => s.method === 'findNodes').pop();
      assert(call, 'findNodes never reached the renderer');
      assertEqual(call.params.roles.join(), 'Table', 'roles did not arrive');
      assertEqual(call.params.pageFrom, 2, 'pageFrom did not arrive');
      await client.close();
    });

    await test('arguments of the wrong type are refused before the renderer sees them', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const before = seen.length;
      let refused = false;
      try {
        const result = await client.callTool({ name: 'go_to_page', arguments: { page: 'seven' } });
        refused = result.isError === true;
      } catch {
        refused = true;
      }
      assert(refused, 'a string page number was accepted');
      assertEqual(seen.length, before, 'the bad call still reached the renderer');
      await client.close();
    });

    await test('an edit with a misspelt attribute is refused before the renderer sees it', async () => {
      // update_nodes' changes object is strict: "altText" for "alt" would
      // otherwise be dropped silently and the edit reported as a success.
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const before = seen.length;
      let refused = false;
      try {
        const result = await client.callTool({
          name: 'update_nodes',
          arguments: { revision: 1, updates: [{ nodeIds: ['n1'], changes: { altText: 'a chart' } }] },
        });
        refused = result.isError === true;
      } catch {
        refused = true;
      }
      assert(refused, 'an unknown attribute name was accepted');
      assertEqual(seen.length, before, 'the bad edit still reached the renderer');
      await client.close();
    });

    await test('an edit that does not say which revision its ids came from is refused', async () => {
      // The revision is what lets the renderer refuse a renumbered id; an
      // edit allowed through without one would skip that check entirely.
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const before = seen.length;
      let refused = false;
      try {
        const result = await client.callTool({ name: 'delete_nodes', arguments: { nodeIds: ['n1'] } });
        refused = result.isError === true;
      } catch {
        refused = true;
      }
      assert(refused, 'delete_nodes was accepted with no revision');
      assertEqual(seen.length, before, 'it still reached the renderer');
      await client.close();
    });

    await test('images come back as image content', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      for (const name of ['get_page_image', 'screenshot_window']) {
        const result = await client.callTool({ name, arguments: {} });
        const image = /** @type {any[]} */ (result.content).find((p) => p.type === 'image');
        assert(image, `${name} returned no image`);
        assertEqual(image.mimeType, 'image/png', `${name} mislabelled its image`);
        assertEqual(image.data, TINY_PNG, `${name}'s image bytes changed in transit`);
      }
      await client.close();
    });

    await test('a renderer refusal is an in-band tool error carrying its message', async () => {
      const client = await connect(TEST_PORT, TEST_TOKEN);
      const result = await client.callTool({ name: 'go_to_page', arguments: { page: 2 } });
      assertEqual(result.isError, true, 'the refusal was not flagged as an error');
      assert(/** @type {any} */ (result.content)[0].text.includes('Table Editor'), 'the reason was lost');
      await client.close();
    });

    await test('no token, or the wrong one, is refused', async () => {
      assertEqual(await rawPost(TEST_PORT, {}), 401, 'a request with no token got in');
      assertEqual(await rawPost(TEST_PORT, { Authorization: 'Bearer nope' }), 401, 'a wrong token got in');
      assertEqual(await rawPost(TEST_PORT, { Authorization: `Bearer ${TEST_TOKEN}` }), 200, 'the right token was refused');
    });

    await test('a browser request is refused even with the token', async () => {
      const status = await rawPost(TEST_PORT, { Authorization: `Bearer ${TEST_TOKEN}`, Origin: 'https://example.com' });
      assertEqual(status, 403, 'a request carrying an Origin header got in');
    });

    await test('a rebinding Host header is refused even with the token', async () => {
      const status = await rawPost(TEST_PORT, { Authorization: `Bearer ${TEST_TOKEN}`, Host: 'evil.example:47899' });
      assertEqual(status, 403, 'a foreign Host header got in');
    });

    await test('stop() closes the port', async () => {
      await server.stop();
      assert(!server.isRunning(), 'still reports running');
      let refused = false;
      try {
        await rawPost(TEST_PORT, { Authorization: `Bearer ${TEST_TOKEN}` });
      } catch {
        refused = true;
      }
      assert(refused, 'the port still answers after stop()');
    });
  } finally {
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

const args = process.argv.slice(2);
const run = args[0] === '--live' ? runLive(args.slice(1)) : runTests();
run.catch((err) => {
  console.error(err);
  process.exit(1);
});
