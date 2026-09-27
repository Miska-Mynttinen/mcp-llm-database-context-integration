const assert = require('node:assert/strict');
const test = require('node:test');
const { dist } = require('./helpers');

const { createTools } = dist('src/tools/tools');
const { connectMCPToolRegistry, readMCPServerConfig, urlForLogs } = dist('src/tools/mcpToolRegistry');
const { createHistoryToolRegistry } = dist('src/tools/historyTools');
const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');

const context = { sessionId: 's1', userId: 'u1' };
const QUIET = { info() {}, warn() {} };

function staticRegistry(names, tag) {
  return {
    definitions: names.map((name) => ({ name, description: name, inputSchema: {} })),
    execute: async (name, args, ctx) => ({ tag, name, args, ctx }),
  };
}

const request = (name, args = {}) => ({ name, arguments: args });

test('tools route each call to the registry that defined the tool', async () => {
  const tools = createTools([staticRegistry(['a'], 'first'), staticRegistry(['b'], 'second')]);
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ['a', 'b']);
  assert.equal((await tools.call(request('b'), context)).result.tag, 'second');
  assert.deepEqual((await tools.call(request('a', { x: 1 }), context)).result.ctx, context);
});

test('tools reject duplicate tool names', () => {
  assert.throws(() => createTools([staticRegistry(['a'], 1), staticRegistry(['a'], 2)]), /Duplicate tool name/);
});

test('every failure is an outcome, never a rejection', async () => {
  const failing = { definitions: [{ name: 'boom', description: '', inputSchema: {} }], execute: async () => { throw new Error('kaput'); } };
  const tools = createTools([failing, staticRegistry(['a'], 'first')]);
  assert.deepEqual(await tools.call(request('boom'), context), { ok: false, name: 'boom', error: 'kaput' });
  assert.deepEqual(await tools.call(request('missing'), context), { ok: false, name: 'missing', error: 'Unknown tool: missing' });
  assert.deepEqual(
    await tools.call({ ...request('a'), argumentsError: 'Tool arguments are not valid JSON: {' }, context),
    { ok: false, name: 'a', error: 'Tool arguments are not valid JSON: {' },
  );
});

/** `resources` maps a URI to its text, or to an Error its read throws; the default serves none. */
function fakeMCPClient(tools, results = {}, { pingError, resources = {} } = {}) {
  const calls = [];
  const resourceReads = [];
  return {
    calls,
    resourceReads,
    closed: false,
    async listTools() { return { tools }; },
    async listResources() {
      return { resources: Object.keys(resources).map((uri) => ({ uri, name: uri, mimeType: 'text/plain' })) };
    },
    async readResource(uri) {
      resourceReads.push(uri);
      const text = resources[uri];
      if (text instanceof Error) throw text;
      return { contents: [{ uri, text }] };
    },
    async ping() { if (pingError) throw pingError; return {}; },
    async callTool(name, args) { calls.push({ name, args }); return results[name]; },
    async close() { this.closed = true; },
  };
}

test('MCP registry namespaces tools, forwards schemas, and unwraps results', async () => {
  const client = fakeMCPClient(
    [{ name: 'execute-sql-query', description: 'run sql', inputSchema: { type: 'object', properties: { query: {} } } }],
    { 'execute-sql-query': { content: [{ type: 'text', text: '{"rows":[{"n":1}]}' }] } },
  );
  const registry = await connectMCPToolRegistry([{ name: 'Server 1', url: 'http://x/mcp' }], () => client);

  assert.deepEqual(registry.definitions, [{
    name: 'mcp_server_1_execute_sql_query',
    description: 'Server 1: run sql',
    inputSchema: { type: 'object', properties: { query: {} } },
  }]);
  assert.deepEqual(await registry.execute('mcp_server_1_execute_sql_query', { query: 'SELECT 1' }, context), { rows: [{ n: 1 }] });
  assert.deepEqual(client.calls, [{ name: 'execute-sql-query', args: { query: 'SELECT 1' } }]);

  await registry.close();
  assert.equal(client.closed, true);
});

test('MCP registry turns isError results into thrown errors', async () => {
  const client = fakeMCPClient([{ name: 'q' }], { q: { isError: true, content: [{ type: 'text', text: 'Error: nope' }] } });
  const registry = await connectMCPToolRegistry([{ name: 's', url: 'http://x' }], () => client);
  await assert.rejects(registry.execute('mcp_s_q', {}, context), /nope/);
});

test('MCP registry skips servers that fail to connect', async () => {
  const broken = { async listTools() { throw new Error('refused'); }, async close() {}, async callTool() {} };
  const working = fakeMCPClient([{ name: 't' }]);
  const clients = [broken, working];
  const registry = await connectMCPToolRegistry(
    [{ name: 'a', url: 'http://a' }, { name: 'b', url: 'http://b' }],
    () => clients.shift(),
  );
  assert.deepEqual(registry.definitions.map((tool) => tool.name), ['mcp_b_t']);
});

test('MCP registry status counts servers that answer a ping', async () => {
  const broken = { async listTools() { throw new Error('refused'); }, async close() {}, async callTool() {}, async ping() {} };
  const clients = [broken, fakeMCPClient([{ name: 't' }, { name: 'u' }]), fakeMCPClient([{ name: 'v' }], {}, { pingError: new Error('gone') })];
  const registry = await connectMCPToolRegistry(
    [{ name: 'a', url: 'http://a' }, { name: 'b', url: 'http://b' }, { name: 'c', url: 'http://c' }],
    () => clients.shift(),
    { info() {}, warn() {} },
  );
  assert.deepEqual(await registry.status(), { configured: 3, connected: 1, tools: 3 });
});

test('MCP registry reads every server\'s text resources as context and caches them', async () => {
  const clients = [
    fakeMCPClient([{ name: 't' }], {}, { resources: { 'db://a': 'schema of a' } }),
    fakeMCPClient([{ name: 'u' }]),
    fakeMCPClient([{ name: 'v' }], {}, { resources: { 'db://c': 'schema of c' } }),
  ];
  const [first] = clients;
  const registry = await connectMCPToolRegistry(
    ['a', 'b', 'c'].map((name) => ({ name, url: `http://${name}` })),
    () => clients.shift(),
    QUIET,
  );
  assert.equal(await registry.readContext(), 'schema of a\n\nschema of c');
  assert.equal(await registry.readContext(), 'schema of a\n\nschema of c');
  assert.deepEqual(first.resourceReads, ['db://a']);
});

test('MCP registry context leaves out, logs and retries resources that fail to read', async () => {
  const warnings = [];
  const client = fakeMCPClient([{ name: 't' }], {}, { resources: { 'db://a': new Error('db down') } });
  const registry = await connectMCPToolRegistry([{ name: 'a', url: 'http://a' }], () => client, {
    info() {},
    warn: (message) => warnings.push(message),
  });
  assert.equal(await registry.readContext(), '');
  assert.equal(await registry.readContext(), '');
  assert.equal(client.resourceReads.length, 2);
  assert.match(warnings[0], /db:\/\/a.*db down/);
});

test('MCP registry treats a server that cannot list resources as having no context', async () => {
  const client = { ...fakeMCPClient([{ name: 't' }]), async listResources() { throw new Error('Server does not support resources'); } };
  const registry = await connectMCPToolRegistry([{ name: 'a', url: 'http://a' }], () => client, QUIET);
  assert.deepEqual(registry.definitions.map((tool) => tool.name), ['mcp_a_t']);
  assert.equal(await registry.readContext(), '');
});

test('readMCPServerConfig parses a comma-separated URL list and gives each server the auth token', () => {
  const authToken = 'x'.repeat(32);
  assert.deepEqual(readMCPServerConfig({ MCP_SERVER_URLS: ' http://a/mcp, ,http://b/mcp', MCP_AUTH_TOKEN: authToken }), [
    { name: 'server_1', url: 'http://a/mcp', authToken },
    { name: 'server_2', url: 'http://b/mcp', authToken },
  ]);
  assert.deepEqual(readMCPServerConfig({}), []);
});

test('readMCPServerConfig requires a token of at least 32 characters when servers are configured', () => {
  assert.throws(() => readMCPServerConfig({ MCP_SERVER_URLS: 'http://a/mcp' }), /MCP_AUTH_TOKEN/);
  assert.throws(() => readMCPServerConfig({ MCP_SERVER_URLS: 'http://a/mcp', MCP_AUTH_TOKEN: 'short' }), /MCP_AUTH_TOKEN/);
});

test('MCP registry passes the auth token to the client', async () => {
  const seen = [];
  await connectMCPToolRegistry([{ name: 's', url: 'http://x', authToken: 'secret' }], (url, options) => {
    seen.push({ url, options });
    return fakeMCPClient([]);
  });
  assert.deepEqual(seen, [{ url: 'http://x', options: { authToken: 'secret' } }]);
});

test('the history tool reads the user\'s other conversations by default, or the current one, never another user\'s', async () => {
  const store = new InMemoryConversationStore();
  const mine = await store.openSession('mine', 'alice');
  const earlier = await store.openSession('earlier', 'alice');
  const theirs = await store.openSession('theirs', 'bob');
  await earlier.append('user', 'earlier question');
  await earlier.append('tool', 'tool record');
  await earlier.append('assistant', 'earlier answer');
  await theirs.append('user', 'secret');
  await mine.append('user', 'my message');
  const tools = createHistoryToolRegistry(store);
  const aliceContext = { sessionId: 'mine', userId: 'alice' };

  const previous = await tools.execute('get_conversation_history', { sessionId: 'theirs', userId: 'bob' }, aliceContext);
  assert.equal(previous.scope, 'previous');
  assert.deepEqual(previous.messages.map((message) => message.content), ['earlier question', 'earlier answer']);
  assert.deepEqual(Object.keys(previous.messages[0]).sort(), ['content', 'createdAt', 'role']);

  const session = await tools.execute('get_conversation_history', { scope: 'session', userId: 'bob' }, aliceContext);
  assert.equal(session.scope, 'session');
  assert.deepEqual(session.messages.map((message) => message.content), ['my message']);

  await assert.rejects(tools.execute('get_conversation_history', { scope: 'user' }, aliceContext), /scope/);
  // The tool checks ownership itself rather than trusting its caller to have done so.
  await assert.rejects(
    tools.execute('get_conversation_history', { scope: 'session' }, { sessionId: 'theirs', userId: 'alice' }),
    /Session not found/,
  );

  for (const limit of ['abc', -1, Number.NaN]) {
    const result = await tools.execute('get_conversation_history', { scope: 'session', limit }, aliceContext);
    assert.deepEqual(result.messages.map((message) => message.content), ['my message'], `limit ${limit}`);
  }
  await assert.rejects(tools.execute('list_tables', {}, aliceContext), /Unknown tool/);
});

test('urlForLogs drops credentials from MCP server URLs', () => {
  assert.equal(urlForLogs('https://user:pass@mcp.example.com:8443/mcp?token=abc#x'), 'https://mcp.example.com:8443/mcp');
  assert.equal(urlForLogs('not a url'), '<invalid URL>');
});
