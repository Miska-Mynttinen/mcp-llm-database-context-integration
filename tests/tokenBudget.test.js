const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, startApp, connectTempDatabase, DATABASE_TYPES, databaseSkip, openAppStorage, USER1 } = require('./helpers');

const {
  readTokenBudgetsFromEnv,
  createTokenBudget,
  InMemoryTokenUsageStore,
  utcDay,
} = dist('src/tokenBudget');
const { createMetrics, createTelemetry } = dist('src/observability');
const { LLMRateLimitError } = dist('src/llm');
const { createSilentLogger } = require('@mcp-llm/runtime');

/** A scripted LLM reply that reports `tokens` total tokens. */
const replyUsing = (tokens) => ({
  content: `used ${tokens}`,
  usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
});

/** The app with its chat turn on a daily token budget; rejections are reported to `extraDeps.telemetry`. */
async function startWithBudgets(t, replies, tokens, extraDeps = {}) {
  const budget = createTokenBudget(tokens, new InMemoryTokenUsageStore(), { telemetry: extraDeps.telemetry });
  return startApp(t, replies, extraDeps, { budget });
}

async function loginToken(request) {
  const response = await request('POST', '/api/auth/login', USER1, { token: null });
  return response.body.token;
}

test('the per-user token budget blocks that user once used up, with Retry-After until midnight UTC', async (t) => {
  const metrics = createMetrics();
  const telemetry = createTelemetry(createSilentLogger(), metrics);
  const request = await startWithBudgets(t, [replyUsing(60), replyUsing(60), replyUsing(10)], { user: 100 }, { telemetry });

  const first = await request('POST', '/api/chat', { message: 'a' });
  assert.equal(first.status, 200);
  assert.equal(first.body.usage, undefined, 'usage is not part of the chat response');
  // 60 < 100, so the second turn runs and overshoots to 120.
  assert.equal((await request('POST', '/api/chat', { message: 'b' })).status, 200);

  const response = await fetch(`${request.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await loginToken(request)}` },
    body: JSON.stringify({ message: 'c' }),
  });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /your daily AI token limit/i);
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 86_400);

  const otherToken = await request.signUp('bobby');
  assert.equal((await request('POST', '/api/chat', { message: 'd' }, { token: otherToken })).status, 200);
  const exposition = await metrics.registry.metrics();
  assert.match(exposition, /token_budget_rejections_total\{budget="user"\} 1/);
  assert.doesNotMatch(exposition, /rate_limit_rejections_total\{/);
});

test('the per-IP token budget blocks other accounts from the same IP', async (t) => {
  const request = await startWithBudgets(t, [replyUsing(100)], { user: 1000, ip: 100 });
  assert.equal((await request('POST', '/api/chat', { message: 'a' })).status, 200);

  const otherToken = await request.signUp('bobby');
  const blocked = await request('POST', '/api/chat', { message: 'b' }, { token: otherToken });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /your network/i);
});

test('the global token budget blocks everyone', async (t) => {
  const request = await startWithBudgets(t, [replyUsing(50)], { global: 50 });
  assert.equal((await request('POST', '/api/chat', { message: 'a' })).status, 200);
  const blocked = await request('POST', '/api/chat', { message: 'b' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /the service/i);
});

test('with no token budgets set, chat is never blocked on tokens', async (t) => {
  const request = await startWithBudgets(t, [replyUsing(1e9), replyUsing(1e9)], {});
  assert.equal((await request('POST', '/api/chat', { message: 'a' })).status, 200);
  assert.equal((await request('POST', '/api/chat', { message: 'b' })).status, 200);
});

test('TRUST_PROXY applies without request limits, so per-IP budgets see the forwarded client IP', async (t) => {
  const request = await startWithBudgets(t, [replyUsing(50), replyUsing(5)], { ip: 50 }, { trustProxyHops: 1 });
  const otherToken = await request.signUp('bobby');
  const chatFrom = async (ip, token) => (await fetch(`${request.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip },
    body: JSON.stringify({ message: 'hi' }),
  })).status;

  assert.equal(await chatFrom('203.0.113.1', await loginToken(request)), 200);
  assert.equal(await chatFrom('203.0.113.2', otherToken), 200);
  assert.equal(await chatFrom('203.0.113.1', otherToken), 429);
});

test("the LLM provider's own rate limit is a 429 with its message and Retry-After, not a 500", async (t) => {
  const request = await startApp(t, [new LLMRateLimitError('Rate limit reached for requests per day', 3600)]);
  const response = await fetch(`${request.base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await loginToken(request)}` },
    body: JSON.stringify({ message: 'a' }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3600');
  const { error } = await response.json();
  assert.match(error, /AI service has reached its usage limit/);
  assert.doesNotMatch(error, /requests per day/, "the provider's wording stays in the logs");
});

test('token budgets reset each UTC day', async () => {
  let now = new Date('2026-01-01T23:59:00Z');
  const store = new InMemoryTokenUsageStore();
  const budget = createTokenBudget({ user: 10 }, store, { now: () => now });
  const client = { userId: 'u1', clientIp: '1.2.3.4' };
  const key = { userId: 'u1', ip: '1.2.3.4' };

  await (await budget.openTurn(client)).charge(replyUsing(10));
  assert.deepEqual(await store.usedOn('2026-01-01', key), { user: 10, ip: 10, global: 10 });
  await assert.rejects(budget.openTurn(client), /daily AI token limit/);

  now = new Date('2026-01-02T00:00:01Z');
  await (await budget.openTurn(client)).charge(replyUsing(3));
  assert.deepEqual(await store.usedOn(utcDay(now), key), { user: 3, ip: 3, global: 3 });
});

test('a failed charge is logged, not thrown; a failed usage read fails opening the turn', async () => {
  const errors = [];
  const logger = { error: (fields, message) => errors.push(message), warn: () => {} };
  let usageReadable = true;
  const broken = {
    record: async () => { throw new Error('disk full'); },
    usedOn: async () => {
      if (!usageReadable) throw new Error('db down');
      return { user: 0, ip: 0, global: 0 };
    },
  };
  const budget = createTokenBudget({ user: 10 }, broken, { telemetry: createTelemetry(logger) });
  const client = { userId: 'u1', clientIp: '1.2.3.4' };

  await (await budget.openTurn(client)).charge(replyUsing(5));
  assert.deepEqual(errors, ['Recording token usage failed']);
  usageReadable = false;
  await assert.rejects(budget.openTurn(client), /db down/);
});

for (const type of DATABASE_TYPES) {
  test(`SqlTokenUsageStore (${type}) sums per user, per IP and overall for one day, as numbers`, { skip: databaseSkip(type) }, async (t) => {
    const { database, cleanup } = await connectTempDatabase(type, 'tokens');
    t.after(cleanup);
    const store = (await openAppStorage(database)).tokenUsage;
    const day = '2026-03-04';
    assert.deepEqual(await store.usedOn(day, { userId: 'a', ip: '1.1.1.1' }), { user: 0, ip: 0, global: 0 });

    await store.record(day, { userId: 'a', ip: '1.1.1.1' }, 100);
    await store.record(day, { userId: 'a', ip: '2.2.2.2' }, 20);
    await store.record(day, { userId: 'b', ip: '1.1.1.1' }, 3);
    await store.record('2026-03-03', { userId: 'a', ip: '1.1.1.1' }, 5000);

    assert.deepEqual(await store.usedOn(day, { userId: 'a', ip: '1.1.1.1' }), { user: 120, ip: 103, global: 123 });
  });
}

// --- Configuration ---

test('reads daily token budgets from the environment, independently of RATE_LIMIT_ENABLED', () => {
  assert.deepEqual(readTokenBudgetsFromEnv({}), { user: 100000, ip: 300000, global: undefined });
  assert.deepEqual(
    readTokenBudgetsFromEnv({ CHAT_TOKENS_DAILY_USER: 'OFF', CHAT_TOKENS_DAILY_GLOBAL: '5000000' }),
    { user: undefined, ip: 300000, global: 5_000_000 },
  );
  assert.deepEqual(readTokenBudgetsFromEnv({ RATE_LIMIT_ENABLED: 'false' }), readTokenBudgetsFromEnv({}));
});

test('rejects malformed token budgets, naming the variable', () => {
  for (const [name, value] of [['CHAT_TOKENS_DAILY_IP', '0'], ['CHAT_TOKENS_DAILY_IP', '1e6']]) {
    assert.throws(() => readTokenBudgetsFromEnv({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});
