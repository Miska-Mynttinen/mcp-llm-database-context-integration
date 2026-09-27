const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, startApp, USER1 } = require('./helpers');

const { readRequestLimitsFromEnv } = dist('src/rateLimit');
const { readTrustProxyHopsFromEnv } = dist('src/config/http');
const { createMetrics, createTelemetry } = dist('src/observability');
const { createSilentLogger } = require('@mcp-llm/runtime');

const HOUR_MS = 3_600_000;
const GENEROUS = { windowMs: HOUR_MS, limit: 1000 };

/** Every request limit generous, except the overrides. */
function limits(overrides = {}) {
  return {
    register: GENEROUS,
    registerGlobal: GENEROUS,
    login: GENEROUS,
    chat: GENEROUS,
    chatIp: GENEROUS,
    api: GENEROUS,
    ...overrides,
  };
}

const perHour = (limit) => ({ windowMs: HOUR_MS, limit });

const signUp = (request, username) =>
  request('POST', '/api/auth/register', { username, password: 'password-123' }, { token: null });

// --- Request limits ---

test('sign-up is limited per client, with a JSON error and rate limit headers', async (t) => {
  const request = await startApp(t, [], { requestLimits: limits({ register: perHour(2) }) });
  assert.equal((await signUp(request, 'alice')).status, 201);
  assert.equal((await signUp(request, 'bobby')).status, 201);

  const response = await fetch(`${request.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'carol', password: 'password-123' }),
  });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /too many sign-up attempts/i);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok(response.headers.get('ratelimit'));
});

test('failed sign-ups count toward the limit too', async (t) => {
  const request = await startApp(t, [], { requestLimits: limits({ register: perHour(2) }) });
  assert.equal((await signUp(request, 'x')).status, 400);
  assert.equal((await signUp(request, USER1.username)).status, 409);
  assert.equal((await signUp(request, 'alice')).status, 429);
});

test('the global sign-up cap applies across clients', async (t) => {
  const request = await startApp(t, [], { requestLimits: limits({ registerGlobal: perHour(1) }) });
  assert.equal((await signUp(request, 'alice')).status, 201);
  assert.equal((await signUp(request, 'bobby')).status, 429);
});

test('only failed logins count toward the login limit', async (t) => {
  const request = await startApp(t, [], { requestLimits: limits({ login: perHour(2) }) });
  const login = (password) => request('POST', '/api/auth/login', { ...USER1, password }, { token: null });
  for (let i = 0; i < 3; i++) {
    assert.equal((await login(USER1.password)).status, 200);
  }
  assert.equal((await login('wrong-password')).status, 401);
  assert.equal((await login('wrong-password')).status, 401);
  const blocked = await login(USER1.password);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /too many failed login attempts/i);
});

test('chat is limited per user', async (t) => {
  const request = await startApp(t, ['one', 'two', 'three'], {
    requestLimits: limits({ chat: perHour(2) }),
  });
  assert.equal((await request('POST', '/api/chat', { message: 'a' })).status, 200);
  assert.equal((await request('POST', '/api/chat', { message: 'b' })).status, 200);
  assert.equal((await request('POST', '/api/chat', { message: 'c' })).status, 429);

  const otherToken = await request.signUp('bobby');
  assert.equal((await request('POST', '/api/chat', { message: 'd' }, { token: otherToken })).status, 200);
});

test('chat is also limited per IP, across accounts', async (t) => {
  const request = await startApp(t, ['one', 'two'], {
    requestLimits: limits({ chatIp: perHour(2) }),
  });
  const otherToken = await request.signUp('bobby');
  assert.equal((await request('POST', '/api/chat', { message: 'a' })).status, 200);
  assert.equal((await request('POST', '/api/chat', { message: 'b' }, { token: otherToken })).status, 200);
  assert.equal((await request('POST', '/api/chat', { message: 'c' }, { token: otherToken })).status, 429);
});

test('the general /api limit covers every API route and counts rejections', async (t) => {
  // startApp's own login uses one request.
  const metrics = createMetrics();
  const telemetry = createTelemetry(createSilentLogger(), metrics);
  const request = await startApp(t, [], { telemetry, requestLimits: limits({ api: perHour(2) }) });
  assert.equal((await request('GET', '/api/health')).status, 200);
  assert.equal((await request('GET', '/api/health')).status, 429);
  assert.match(await metrics.registry.metrics(), /rate_limit_rejections_total\{limiter="api"\} 1/);
});

test('a limit that is off does not apply', async (t) => {
  const request = await startApp(t, [], { requestLimits: limits({ register: undefined }) });
  for (let i = 0; i < 6; i++) {
    assert.equal((await signUp(request, `user-${i}`)).status, 201);
  }
});

test('without requestLimits the app is not limited', async (t) => {
  const request = await startApp(t);
  for (let i = 0; i < 6; i++) {
    assert.equal((await signUp(request, `user-${i}`)).status, 201);
  }
});

// --- Configuration ---

test('reads request limits as <count>/<window> from the environment', () => {
  const defaults = readRequestLimitsFromEnv({});
  assert.deepEqual(defaults.register, { windowMs: HOUR_MS, limit: 5 });
  assert.deepEqual(defaults.login, { windowMs: 15 * 60_000, limit: 10 });

  const custom = readRequestLimitsFromEnv({ RATE_LIMIT_REGISTER_IP: '3 / 1d', RATE_LIMIT_CHAT_IP: 'off' });
  assert.deepEqual(custom.register, { windowMs: 86_400_000, limit: 3 });
  assert.equal(custom.chatIp, undefined);

  assert.equal(readRequestLimitsFromEnv({ RATE_LIMIT_ENABLED: 'false' }), undefined);
});

test('rejects malformed limit settings, naming the variable', () => {
  for (const [name, value] of [
    ['RATE_LIMIT_CHAT_USER', '20'],
    ['RATE_LIMIT_CHAT_USER', '0/1m'],
    ['RATE_LIMIT_API_IP', '300/1 week'],
    ['RATE_LIMIT_LOGIN_FAILED_IP', 'lots/1h'],
  ]) {
    assert.throws(() => readRequestLimitsFromEnv({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test('reads TRUST_PROXY as a whole number of hops, 0 by default', () => {
  assert.equal(readTrustProxyHopsFromEnv({}), 0);
  assert.equal(readTrustProxyHopsFromEnv({ TRUST_PROXY: '1' }), 1);
  assert.throws(() => readTrustProxyHopsFromEnv({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
});
