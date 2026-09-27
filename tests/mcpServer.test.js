const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { dist, connectTempSqlite, openAppStorage } = require('./helpers');

const { createUntrustedDatabase } = require('@mcp-llm/database');
const { createLogger } = require('@mcp-llm/runtime');
const { connectMCPToolRegistry } = dist('src/tools/mcpToolRegistry');
const { createTools } = dist('src/tools/tools');

const SERVER_DIST = path.join(__dirname, '..', 'packages', 'mcp-server', 'dist');
const { createMcpHttpApp } = require(path.join(SERVER_DIST, 'httpApp'));
const { createMcpServerMetrics } = require(path.join(SERVER_DIST, 'metrics'));
const { createDatabaseContextTools } = require(path.join(SERVER_DIST, 'contextTools'));
const { readSchemaOverview, MAX_OVERVIEW_CHARS } = require(path.join(SERVER_DIST, 'schemaOverview'));

const SERVER_ENTRY = path.join(SERVER_DIST, 'index.js');
const context = { sessionId: 'mcp-test' };
const AUTH_TOKEN = 'mcp-test-token-that-is-at-least-32-chars';
const AUTHORIZED = { Authorization: `Bearer ${AUTH_TOKEN}` };
const QUIET = { info() {}, warn() {} };

/**
 * Runs the MCP HTTP app in-process on a temp SQLite database (with the app's own tables),
 * listening on a random port. Returns its port, a connected tool registry and the log lines.
 */
async function startServer(t, { sessionIdleTimeoutMs = 60_000 } = {}) {
  const { database, cleanup } = await connectTempSqlite('mcp-server');
  await openAppStorage(database);
  const logLines = [];
  const mcp = createMcpHttpApp({
    database: createUntrustedDatabase(database),
    access: { authToken: AUTH_TOKEN, allowedOrigins: [] },
    allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
    metrics: createMcpServerMetrics(),
    logger: createLogger({ service: 'mcp-server', destination: { write: (line) => logLines.push(JSON.parse(line)) } }),
    sessionIdleTimeoutMs,
  });
  const server = mcp.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const registry = await connectMCPToolRegistry(
    [{ name: 'db', url: `http://127.0.0.1:${port}/mcp`, authToken: AUTH_TOKEN }],
    undefined,
    QUIET,
  );
  t.after(async () => {
    await registry.close();
    await mcp.close();
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  });
  return { port, registry, logLines };
}

/**
 * Sends a raw POST to /mcp with node:http, which (unlike fetch) lets the test set Host and Origin.
 * Authorized with the service token unless `headers` overrides Authorization.
 */
async function postRaw(port, headers) {
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...AUTHORIZED, ...headers },
  });
  request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  const [response] = await once(request, 'response');
  response.resume();
  return response.statusCode;
}

test('serves the database context tool catalogue', async (t) => {
  const { registry } = await startServer(t);
  assert.deepEqual(
    registry.definitions.map((tool) => tool.name).sort(),
    ['mcp_db_execute_readonly_query', 'mcp_db_get_database_schema', 'mcp_db_get_table_columns', 'mcp_db_list_tables'],
  );
});

test('runs read-only queries, rejects writes, and hides the app\'s own tables', async (t) => {
  const { registry } = await startServer(t);
  const result = await registry.execute('mcp_db_execute_readonly_query', { sql: 'SELECT 1 AS one' }, context);
  assert.deepEqual(result, { rows: [{ one: 1 }], rowCount: 1, truncated: false });

  await assert.rejects(
    registry.execute('mcp_db_execute_readonly_query', { sql: 'CREATE TABLE pwned (x INTEGER)' }, context),
    /Only SELECT queries are allowed/,
  );
  await assert.rejects(registry.execute('mcp_db_execute_readonly_query', { sql: 'SELECT * FROM app_users' }, context), /internal/);
  assert.deepEqual((await registry.execute('mcp_db_list_tables', {}, context)).tables, []);
  assert.deepEqual((await registry.execute('mcp_db_get_database_schema', {}, context)).tables, []);
});

test('the schema overview lists each table with its column types, without the app\'s own tables', async (t) => {
  const { database, cleanup } = await connectTempSqlite('mcp-overview');
  t.after(cleanup);
  await openAppStorage(database);
  await database.query('CREATE TABLE shipment (id INTEGER, shipped_on TEXT)');
  const overview = await readSchemaOverview(createUntrustedDatabase(database));
  assert.equal(overview, 'Database schema (sqlite), table(column type, ...):\n- shipment(id INTEGER, shipped_on TEXT)');
});

test('the schema overview falls back to table names when the full one is too long', async (t) => {
  const { database, cleanup } = await connectTempSqlite('mcp-overview-long');
  t.after(cleanup);
  const columns = Array.from({ length: 200 }, (_, index) => `a_rather_long_column_name_${index} TEXT`).join(', ');
  await database.query(`CREATE TABLE wide (${columns})`);
  const overview = await readSchemaOverview(createUntrustedDatabase(database));
  assert.ok(overview.length <= MAX_OVERVIEW_CHARS);
  assert.equal(overview, 'Database tables (sqlite): wide\nCall get_table_columns for a table\'s columns before querying it.');
});

test('the registry reads the schema overview over MCP for the system prompt', async (t) => {
  const { registry } = await startServer(t);
  assert.equal(await registry.readContext(), 'Database schema (sqlite): no tables.');
});

test('a failing tool reaches the model as the catalogue\'s bare error message', async (t) => {
  const { registry } = await startServer(t);
  const outcome = await createTools([registry]).call({ name: 'mcp_db_get_table_columns', arguments: {} }, context);
  assert.deepEqual(outcome, { ok: false, name: 'mcp_db_get_table_columns', error: 'tableName must be a non-empty string' });
});

// --- The database context tool catalogue ---

test('the catalogue routes SQL through the read-only guard', async (t) => {
  const { database, cleanup } = await connectTempSqlite('tools-sql');
  t.after(cleanup);
  const tools = createDatabaseContextTools(createUntrustedDatabase(database));
  await assert.rejects(tools.execute('execute_readonly_query', { sql: 'DROP TABLE x' }), /SELECT/);
  const result = await tools.execute('execute_readonly_query', { sql: 'SELECT 1 AS one' });
  assert.deepEqual(result, { rows: [{ one: 1 }], rowCount: 1, truncated: false });
  await assert.rejects(tools.execute('execute_readonly_query', { sql: 'SELECT 1', params: 'x' }), /params must be an array/);
  await assert.rejects(tools.execute('get_table_columns', {}), /tableName must be a non-empty string/);
});

test('failed queries name the real columns or tables, without the app\'s own tables', async (t) => {
  const { database, cleanup } = await connectTempSqlite('tools-hints');
  t.after(cleanup);
  await openAppStorage(database);
  await database.query('CREATE TABLE shipment (id INTEGER, shipped_on TEXT)');
  const tools = createDatabaseContextTools(createUntrustedDatabase(database));

  const columnError = await tools.execute('execute_readonly_query', { sql: 'SELECT shipment_date FROM shipment' })
    .then(() => assert.fail('expected the query to fail'), (error) => error.message);
  assert.match(columnError, /no such column/);
  assert.match(columnError, /Columns of shipment: id, shipped_on/);
  assert.match(columnError, /call get_table_columns/);

  const tableError = await tools.execute('execute_readonly_query', { sql: 'SELECT * FROM nope' })
    .then(() => assert.fail('expected the query to fail'), (error) => error.message);
  assert.match(tableError, /Available tables: shipment$/m);
  assert.doesNotMatch(tableError, /app_/);

  await assert.rejects(tools.execute('execute_readonly_query', { sql: 'DROP TABLE x' }), (error) => {
    assert.match(error.message, /SELECT/);
    assert.doesNotMatch(error.message, /get_table_columns/);
    return true;
  });
});

test('the catalogue never reveals the app\'s own tables', async (t) => {
  const { database, cleanup } = await connectTempSqlite('tools-hidden');
  t.after(cleanup);
  await openAppStorage(database);
  await database.query('CREATE TABLE products (id INTEGER)');
  const tools = createDatabaseContextTools(createUntrustedDatabase(database));

  const schema = await tools.execute('get_database_schema', {});
  assert.deepEqual(schema.tables.map((table) => table.name), ['products']);
  assert.deepEqual((await tools.execute('list_tables', {})).tables.map((table) => table.tableName), ['products']);
  await assert.rejects(tools.execute('get_table_columns', { tableName: 'app_users' }), (error) => {
    assert.equal(error.message, 'Table "app_users" not found. Available tables: products');
    return true;
  });
  await assert.rejects(tools.execute('execute_readonly_query', { sql: 'SELECT * FROM app_users' }), /internal/);
});

test('column lookups for a table that does not exist name the real tables', async (t) => {
  const { database, cleanup } = await connectTempSqlite('tools-missing-table');
  t.after(cleanup);
  await database.query('CREATE TABLE shipment (id INTEGER, shipped_on TEXT)');
  const tools = createDatabaseContextTools(createUntrustedDatabase(database));

  await assert.rejects(tools.execute('get_table_columns', { tableName: 'shipments' }), /^Error: Table "shipments" not found\. Available tables: shipment$/);
  await assert.rejects(tools.execute('get_database_schema', { tableName: 'shipments' }), /Available tables: shipment$/);
  const { columns } = await tools.execute('get_table_columns', { tableName: 'shipment' });
  assert.deepEqual(columns.map((column) => column.columnName), ['id', 'shipped_on']);
});

test('the SQL tool names its dialect and the ? placeholders every dialect takes', async (t) => {
  const { database, cleanup } = await connectTempSqlite('tools-dialect');
  t.after(cleanup);
  const tools = createDatabaseContextTools(createUntrustedDatabase(database));
  const sqlTool = tools.definitions.find((tool) => tool.name === 'execute_readonly_query');
  assert.match(sqlTool.description, /sqlite/);
  assert.match(sqlTool.description, /\? placeholders/);
});

test('validates tool arguments instead of reporting an unknown tool', async (t) => {
  const { registry } = await startServer(t);
  await assert.rejects(
    registry.execute('mcp_db_get_table_columns', {}, context),
    (error) => /tableName/.test(error.message) && !/Unknown tool/.test(error.message),
  );
  await assert.rejects(registry.execute('mcp_db_execute_readonly_query', {}, context), /sql/);
});

test('exposes session and tool metrics, without client-chosen tool names as labels', async (t) => {
  const { port, registry } = await startServer(t);
  await registry.execute('mcp_db_execute_readonly_query', { sql: 'SELECT 1' }, context);
  await assert.rejects(registry.execute('mcp_db_execute_readonly_query', { sql: 'DROP TABLE x' }, context));

  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /mcp_active_sessions [1-9]/);
  assert.match(text, /mcp_tool_calls_total\{tool="execute_readonly_query",outcome="success"\} 1/);
  assert.match(text, /mcp_tool_calls_total\{tool="execute_readonly_query",outcome="error"\} 1/);
});

test('rejects requests with an unknown Host header', async (t) => {
  const { port } = await startServer(t);
  assert.equal(await postRaw(port, { Host: 'attacker.example' }), 403);
});

test('rejects requests without the service token', async (t) => {
  const { port } = await startServer(t);
  assert.equal(await postRaw(port, { Authorization: '' }), 401);
  assert.equal(await postRaw(port, { Authorization: 'Bearer wrong-token-of-a-similar-length-123456' }), 401);
  assert.equal(await postRaw(port, { Authorization: AUTH_TOKEN }), 401, 'the Bearer scheme is required');
});

test('rejects browser requests from any origin by default', async (t) => {
  const { port } = await startServer(t);
  assert.equal(await postRaw(port, { Origin: 'http://localhost:3000' }), 403);
  assert.equal(await postRaw(port, { Origin: 'https://attacker.example' }), 403);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(metrics.status, 403);
});

test('answers an unknown session id with 404', async (t) => {
  const { port } = await startServer(t);
  assert.equal(await postRaw(port, { 'mcp-session-id': 'no-such-session' }), 404);
});

test('expires idle sessions and the client starts a new one', async (t) => {
  const { registry, logLines } = await startServer(t, { sessionIdleTimeoutMs: 200 });
  const query = { sql: 'SELECT 1 AS one' };
  const expected = { rows: [{ one: 1 }], rowCount: 1, truncated: false };

  assert.deepEqual(await registry.execute('mcp_db_execute_readonly_query', query, context), expected);
  for (let attempt = 0; attempt < 50 && !logLines.some((line) => line.msg === 'Closing idle MCP session'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(logLines.some((line) => line.msg === 'Closing idle MCP session'), 'the idle session was closed');
  assert.deepEqual(await registry.execute('mcp_db_execute_readonly_query', query, context), expected);
});

/** Runs the real entry point with a temp SQLite database; resolves with its exit code and output. */
function runEntry(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: '0', DB_TYPE: 'sqlite', DB_NAME: ':memory:', DB_READONLY_USER: '', MCP_AUTH_TOKEN: AUTH_TOKEN, ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

test('the entry point starts and shuts down cleanly', async () => {
  const { child, output } = runEntry({});
  for (let attempt = 0; attempt < 50 && !output().includes('running on Streamable HTTP'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(output(), /running on Streamable HTTP/);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('the entry point refuses to start without MCP_AUTH_TOKEN', async () => {
  const { child, output } = runEntry({ MCP_AUTH_TOKEN: '' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output(), /MCP_AUTH_TOKEN/);
});

test('in production the entry point refuses the development token', async () => {
  const { child, output } = runEntry({ NODE_ENV: 'production', MCP_AUTH_TOKEN: 'dev-mcp-token-dev-mcp-token-dev-mcp-token' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output(), /NODE_ENV=production but MCP_AUTH_TOKEN/);
});
