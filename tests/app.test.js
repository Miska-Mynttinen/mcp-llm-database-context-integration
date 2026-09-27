const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, startApp, USER1, JWT_SECRET } = require('./helpers');

const { createMetrics, createMetricsApp, createTelemetry } = dist('src/observability');
const { createSilentLogger } = require('@mcp-llm/runtime');
const { createTokenService } = dist('src/auth');
const { INTERNAL_ERROR_MESSAGE } = dist('src/app');

test('health reports injected dependencies, not process env', async (t) => {
  const request = await startApp(t);
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.llmProvider, 'fake');
  assert.equal(health.body.databaseType, 'sqlite');
  assert.equal(health.body.connected, true);
});

test('validates chat input at the HTTP interface', async (t) => {
  const request = await startApp(t);
  assert.equal((await request('POST', '/api/chat', {})).status, 400);
  assert.equal((await request('POST', '/api/chat', { message: '   ' })).status, 400);
  assert.equal((await request('POST', '/api/chat', { message: 'hi', sessionId: 42 })).status, 400);
  assert.equal((await request('POST', '/api/chat', { message: 'hi', sessionId: 'x'.repeat(256) })).status, 400);
});

test('chat, history, and clear round-trip through one session', async (t) => {
  const request = await startApp(t, ['hello back']);
  const chat = await request('POST', '/api/chat', { sessionId: 'abc', message: 'hello' });
  assert.deepEqual(chat, { status: 200, body: { sessionId: 'abc', answer: 'hello back', toolSteps: [] } });

  const history = await request('GET', '/api/sessions/abc/history');
  assert.deepEqual(history.body.history.map((m) => m.content), ['hello', 'hello back']);

  assert.deepEqual((await request('POST', '/api/sessions/abc/clear')).body, { ok: true, sessionId: 'abc' });
  assert.deepEqual((await request('GET', '/api/sessions/abc/history')).body.history, []);
});

test('returns 500 with a generic message when the model fails, logging the real error', async (t) => {
  const logged = [];
  const logger = { error: (fields, message) => logged.push({ ...fields, message }), warn() {}, info() {} };
  const request = await startApp(t, [], { telemetry: createTelemetry(logger) });
  const response = await request('POST', '/api/chat', { message: 'hi' });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, INTERNAL_ERROR_MESSAGE);
  assert.doesNotMatch(response.body.error, /ran out of replies/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].message, 'Request failed');
  assert.match(logged[0].err.message, /ran out of replies/);
});

test('records metrics labelled by route template, not by id', async (t) => {
  const metrics = createMetrics();
  const request = await startApp(t, [], { telemetry: createTelemetry(createSilentLogger(), metrics) });
  await request('GET', '/api/sessions/secret-session-id/history');
  await request('POST', '/api/chat', {});

  const body = await metrics.registry.metrics();
  assert.match(body, /http_requests_total\{method="GET",route="\/api\/sessions\/:sessionId\/history",status="200"\} 1/);
  assert.match(body, /http_requests_total\{method="POST",route="\/api\/chat",status="400"\} 1/);
  assert.match(body, /process_cpu_seconds_total/);
  assert.doesNotMatch(body, /secret-session-id/);
});

test('never serves /metrics on the public app, even with metrics on', async (t) => {
  const request = await startApp(t, [], { telemetry: createTelemetry(createSilentLogger(), createMetrics()) });
  assert.equal((await request('GET', '/metrics')).status, 404);
});

test('does not expose /metrics without a metrics dependency', async (t) => {
  const request = await startApp(t);
  assert.equal((await request('GET', '/metrics')).status, 404);
});

test('the metrics app serves the registry in Prometheus format', async (t) => {
  const { once } = require('node:events');
  const metrics = createMetrics();
  metrics.chat.turns.inc({ outcome: 'success' });
  const server = createMetricsApp(metrics).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.match(await response.text(), /chat_turns_total\{outcome="success"\} 1/);
});

test('login returns a token and the user for valid credentials only', async (t) => {
  const request = await startApp(t);
  const ok = await request('POST', '/api/auth/login', USER1, { token: null });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.token, 'string');
  assert.deepEqual(ok.body.user, { id: request.user.id, username: 'user1', role: 'user' });
  assert.equal(ok.body.user.passwordHash, undefined);

  const wrongPassword = await request('POST', '/api/auth/login', { ...USER1, password: 'nope' }, { token: null });
  const unknownUser = await request('POST', '/api/auth/login', { ...USER1, username: 'ghost' }, { token: null });
  assert.deepEqual(wrongPassword, { status: 401, body: { error: 'Invalid username or password' } });
  assert.deepEqual(unknownUser, wrongPassword);

  assert.equal((await request('POST', '/api/auth/login', {}, { token: null })).status, 400);
  assert.equal((await request('POST', '/api/auth/login', { username: 'user1', password: 'x'.repeat(1025) }, { token: null })).status, 400);
});

test('protected routes reject missing, malformed, forged and expired tokens', async (t) => {
  const request = await startApp(t);
  const forged = createTokenService({ secret: 'another-secret-that-is-32-characters-long', expiresIn: '1h' }).sign(request.user);
  const expired = createTokenService({ secret: JWT_SECRET, expiresIn: '-10s' }).sign(request.user);
  const routes = [
    ['POST', '/api/chat', { message: 'hi' }],
    ['GET', '/api/sessions/abc/history'],
    ['POST', '/api/sessions/abc/clear'],
    ['GET', '/api/schema'],
    ['GET', '/api/auth/me'],
  ];
  for (const [method, route, body] of routes) {
    for (const token of [null, 'not-a-jwt', forged, expired]) {
      const response = await request(method, route, body, { token });
      assert.equal(response.status, 401, `${method} ${route} with token ${token}`);
      assert.equal(typeof response.body.error, 'string');
    }
  }
});

test('health stays public and /api/auth/me returns the token user', async (t) => {
  const request = await startApp(t);
  assert.equal((await request('GET', '/api/health', undefined, { token: null })).status, 200);
  assert.deepEqual((await request('GET', '/api/auth/me')).body, { user: request.user });
});

test('/api/mcp/status requires a login and reports the injected MCP status', async (t) => {
  const request = await startApp(t, [], { mcpStatus: async () => ({ configured: 1, connected: 1, tools: 4 }) });
  assert.equal((await request('GET', '/api/mcp/status', undefined, { token: null })).status, 401);
  const { status, body } = await request('GET', '/api/mcp/status');
  assert.equal(status, 200);
  assert.deepEqual({ ...body, checkedAt: undefined }, { configured: 1, connected: 1, tools: 4, ok: true, checkedAt: undefined });
});

test('/api/mcp/status is not ok when no MCP server is configured or connected', async (t) => {
  const unconfigured = await startApp(t);
  assert.equal((await unconfigured('GET', '/api/mcp/status')).body.ok, false);
  const partial = await startApp(t, [], { mcpStatus: async () => ({ configured: 2, connected: 1, tools: 4 }) });
  assert.equal((await partial('GET', '/api/mcp/status')).body.ok, false);
});

test('chat userId comes from the token, not the request body', async (t) => {
  const request = await startApp(t, ['ok']);
  await request('POST', '/api/chat', { sessionId: 's1', userId: 'spoofed', message: 'hi' });
  const session = await request.store.findOwnedSession('s1', request.user.id);
  assert.equal(session.userId, request.user.id);
});

test('/api/schema lists the database without the app\'s own tables', async (t) => {
  const request = await startApp(t);
  await request.database.query('CREATE TABLE products (id INTEGER)');
  const { status, body } = await request('GET', '/api/schema');
  assert.equal(status, 200);
  assert.deepEqual(body.schema.tables.map((table) => table.tableName), ['products']);
  assert.ok(body.schema.columns.every((column) => column.tableName === 'products'));
});

test('sign-up creates a user-role account that can log in', async (t) => {
  const request = await startApp(t);
  const created = await request('POST', '/api/auth/register', { username: 'new.user', password: 'password-123' }, { token: null });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ['token', 'user']);
  assert.equal(created.body.user.role, 'user');
  assert.deepEqual((await request('GET', '/api/auth/me', undefined, { token: created.body.token })).body.user, created.body.user);

  const login = await request('POST', '/api/auth/login', { username: 'new.user', password: 'password-123' }, { token: null });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, created.body.user.id);
});

test('sign-up rejects taken usernames and weak credentials', async (t) => {
  const request = await startApp(t);
  const signUp = (body) => request('POST', '/api/auth/register', body, { token: null });
  assert.deepEqual(await signUp({ username: 'user1', password: 'password-123' }), { status: 409, body: { error: 'Username is already taken' } });
  for (const body of [
    {},
    { username: 'ab', password: 'password-123' },
    { username: 'has space', password: 'password-123' },
    { username: 'x'.repeat(65), password: 'password-123' },
    { username: 'shortpw', password: 'short' },
  ]) {
    const response = await signUp(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof response.body.error, 'string');
  }
});

test('users cannot read, clear or post to each other\'s sessions', async (t) => {
  const request = await startApp(t, ['user1 answer', 'bob answer']);
  const bob = await request.signUp('bob');
  assert.equal((await request('POST', '/api/chat', { sessionId: 'user1-session', message: 'private' })).status, 200);

  const asBob = (method, route, body) => request(method, route, body, { token: bob });
  assert.deepEqual(await asBob('GET', '/api/sessions/user1-session/history'), { status: 404, body: { error: 'Session not found' } });
  assert.equal((await asBob('POST', '/api/sessions/user1-session/clear')).status, 404);
  assert.equal((await asBob('POST', '/api/chat', { sessionId: 'user1-session', message: 'let me in' })).status, 404);
  assert.equal((await request('GET', '/api/sessions/user1-session/history')).body.history.length, 2, 'user1 history intact');

  assert.equal((await asBob('POST', '/api/chat', { sessionId: 'bob-session', message: 'mine' })).status, 200);
  assert.deepEqual((await asBob('GET', '/api/sessions/bob-session/history')).body.history.map((m) => m.content), ['mine', 'bob answer']);
  assert.equal((await request('GET', '/api/sessions/bob-session/history')).status, 404);
});

/** POSTs /api/auth/login as user1 with extra headers; node:http lets the test set Host, Origin and Sec-Fetch-Site. */
async function loginWithHeaders(base, headers) {
  const http = require('node:http');
  const { once } = require('node:events');
  const url = new URL(base);
  const request = http.request({
    host: url.hostname,
    port: url.port,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  request.end(JSON.stringify(USER1));
  const [response] = await once(request, 'response');
  response.resume();
  return response.statusCode;
}

test('the API accepts requests from its own origin and from none', async (t) => {
  const request = await startApp(t);
  const host = new URL(request.base).host;
  assert.equal(await loginWithHeaders(request.base, {}), 200);
  assert.equal(await loginWithHeaders(request.base, { Origin: `http://${host}` }), 200);
  assert.equal(await loginWithHeaders(request.base, { Host: 'localhost:5173', Origin: 'http://localhost:5173' }), 200);
});

test('the API rejects other origins and cross-site requests with 403', async (t) => {
  const request = await startApp(t);
  assert.equal(await loginWithHeaders(request.base, { Origin: 'https://attacker.example' }), 403);
  assert.equal(await loginWithHeaders(request.base, { Origin: 'null' }), 403);
  assert.equal(await loginWithHeaders(request.base, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  const health = await fetch(`${request.base}/api/health`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(health.status, 403);
  assert.deepEqual(await health.json(), { error: 'Origin not allowed' });
});

test('ALLOWED_ORIGINS admits listed origins', async (t) => {
  const request = await startApp(t, [], { allowedOrigins: ['https://chat.example.com'] });
  assert.equal(await loginWithHeaders(request.base, { Origin: 'https://chat.example.com' }), 200);
  assert.equal(await loginWithHeaders(request.base, { Origin: 'https://other.example.com' }), 403);
});

test('readAllowedOrigins accepts bare origins only', () => {
  const { readAllowedOrigins } = dist('src/auth');
  assert.deepEqual(readAllowedOrigins({ ALLOWED_ORIGINS: 'https://a.example, http://localhost:5173' }), [
    'https://a.example',
    'http://localhost:5173',
  ]);
  assert.deepEqual(readAllowedOrigins({}), []);
  assert.throws(() => readAllowedOrigins({ ALLOWED_ORIGINS: 'https://a.example/app' }), /ALLOWED_ORIGINS/);
  assert.throws(() => readAllowedOrigins({ ALLOWED_ORIGINS: 'a.example' }), /ALLOWED_ORIGINS/);
});
