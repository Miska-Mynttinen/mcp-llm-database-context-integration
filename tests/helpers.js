const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dist = (modulePath) => require(path.join(__dirname, '..', 'dist', modulePath));

/** The app's stores on `database`, with their tables (and `options.readOnlyLogin`, if given) created. */
function openAppStorage(database, options) {
  return dist('src/storage/appStorage').openAppStorage(database, options);
}

/** Connects a SQLite adapter on a fresh temp file; returns it with a cleanup function. */
async function connectTempSqlite(label) {
  const { connectDatabaseAdapter } = require('@mcp-llm/database');
  const file = path.join(os.tmpdir(), `mcp-chat-${label}-${process.pid}-${Date.now()}.db`);
  const config = { type: 'sqlite', host: '', port: 0, user: '', password: '', database: file };
  const database = await connectDatabaseAdapter(config);
  const others = [];
  const connectWith = async (options) => {
    const other = await connectDatabaseAdapter({ ...config, ...options });
    others.push(other);
    return other;
  };
  const cleanup = async () => {
    await Promise.all([database, ...others].map((adapter) => adapter.disconnect()));
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(file + suffix, { force: true });
    }
  };
  return { database, connectWith, cleanup };
}

// PostgreSQL and MySQL servers the SQL contract tests may also run against, as URLs such as
// postgres://postgres:secret@localhost:5432/postgres. Each test gets a fresh database on the server.
const DATABASE_URL_ENV = { postgres: 'TEST_POSTGRES_URL', mysql: 'TEST_MYSQL_URL' };

/** Every database type the SQL contract runs against; SQLite always, the others when configured. */
const DATABASE_TYPES = ['sqlite', 'postgres', 'mysql'];

/** A `node:test` skip reason when `type` has no configured server, otherwise false. */
function databaseSkip(type) {
  const variable = DATABASE_URL_ENV[type];
  return variable && !process.env[variable] ? `set ${variable} to run against ${type}` : false;
}

let loginCount = 0;

/** A login name no other test (or parallel test file) uses; logins are server-wide. */
function uniqueLoginName() {
  loginCount += 1;
  return `test_reader_${process.pid}_${loginCount}`;
}

// How to drop a login once its test is done, after its database is gone.
const DROP_LOGIN = { postgres: (user) => `DROP ROLE IF EXISTS "${user}"`, mysql: (user) => `DROP USER IF EXISTS '${user}'@'%'` };

/**
 * Connects an adapter of `type` to a fresh, empty database (a temp SQLite file, or a new database
 * on the configured server). Returns it with `connectAs(login)`, which connects to the same
 * database as another login, `connectWith(options)`, which connects to it as the owner with extra
 * adapter options, and a cleanup function that drops the database and those logins.
 */
async function connectTempDatabase(type, label) {
  if (type === 'sqlite') {
    return connectTempSqlite(label);
  }
  const { connectDatabaseAdapter } = require('@mcp-llm/database');
  const url = new URL(process.env[DATABASE_URL_ENV[type]]);
  const server = {
    type,
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const admin = await connectDatabaseAdapter({ ...server, database: url.pathname.slice(1) });
  const name = `test_${label.replace(/\W/g, '_')}_${process.pid}_${Date.now()}`.toLowerCase();
  await admin.query(`CREATE DATABASE ${name}`);
  const database = await connectDatabaseAdapter({ ...server, database: name });
  const others = [];
  const connectAs = async (login) => {
    const other = await connectDatabaseAdapter({ ...server, ...login, database: name });
    others.push({ other, user: login.user });
    return other;
  };
  const ownerConnections = [];
  const connectWith = async (options) => {
    const other = await connectDatabaseAdapter({ ...server, database: name, ...options });
    ownerConnections.push(other);
    return other;
  };
  const cleanup = async () => {
    const adapters = [database, ...ownerConnections, ...others.map(({ other }) => other)];
    await Promise.all(adapters.map((adapter) => adapter.disconnect()));
    await admin.query(`DROP DATABASE ${name}`);
    for (const user of new Set(others.map(({ user }) => user))) {
      await admin.query(DROP_LOGIN[type](user));
    }
    await admin.disconnect();
  };
  return { database, owner: server.user, connectAs, connectWith, cleanup };
}

/**
 * LLM fake that returns scripted replies in order and records every request.
 * A string reply is plain text; an Error reply is thrown; an object reply is returned as the ChatReply.
 */
function scriptedLLM(replies) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async chat(messages, tools = []) {
      requests.push({ messages, tools });
      if (index >= replies.length) {
        throw new Error('scripted LLM ran out of replies');
      }
      const reply = replies[index++];
      if (reply instanceof Error) {
        throw reply;
      }
      return typeof reply === 'string' ? { content: reply, toolCalls: [] } : { content: '', toolCalls: [], ...reply };
    },
    async close() {},
  };
}

/**
 * Local HTTP server standing in for a provider API; records each request's path, headers, and JSON body.
 * `respond` returns `{ body, status?, headers? }`.
 */
async function startStubServer(respond) {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const reply = await respond(request, requests.length);
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const USER1 = { username: 'user1', password: 'correct horse battery' };
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters';

/**
 * Starts the app on a temp SQLite database with a scripted LLM and user1 seeded, logged in as user1.
 * `extraDeps` go to `createApp`, `chatDeps` (such as `budget`) to `createChatTurn`.
 * Returns `request(method, route, body, { token })`; `request.base` is the server URL.
 */
async function startApp(t, replies = [], extraDeps = {}, chatDeps = {}) {
  const { once } = require('node:events');
  const { createApp } = dist('src/app');
  const { createChatTurn } = dist('src/chat/chatTurn');
  const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');
  const { createUntrustedDatabase } = require('@mcp-llm/database');
  const { createAuthService, createTokenService, seedUser } = dist('src/auth');
  const { createTelemetry } = dist('src/observability');
  const { createSilentLogger } = require('@mcp-llm/runtime');
  const { database, cleanup } = await connectTempSqlite('app');
  const llm = scriptedLLM(replies);
  const store = new InMemoryConversationStore();
  const chat = createChatTurn({
    llm,
    store,
    tools: dist('src/tools/tools').createTools([]),
    ...chatDeps,
  });
  const { users } = await openAppStorage(database);
  await seedUser(users, USER1);
  const auth = createAuthService({ users, tokens: createTokenService({ secret: JWT_SECRET, expiresIn: '1h' }) });
  const server = createApp({
    chat,
    database: createUntrustedDatabase(database),
    auth,
    llmProviderName: 'fake',
    telemetry: createTelemetry(createSilentLogger()),
    ...extraDeps,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await cleanup();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method, route, body, token) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    return { status: response.status, body: isJson ? await response.json() : await response.text() };
  };
  const login = await send('POST', '/api/auth/login', USER1);
  assert.equal(login.status, 200);
  const userToken = login.body.token;
  /** Sends as the seeded user1; pass `{ token: null }` (or another token) to override. */
  const request = (method, route, body, { token = userToken } = {}) => send(method, route, body, token);
  request.user = login.body.user;
  request.store = store;
  request.database = database;
  request.base = base;
  /** Signs up a new user and returns its token. */
  request.signUp = async (username, password = 'password-123') => {
    const response = await send('POST', '/api/auth/register', { username, password });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.token;
  };
  return request;
}

module.exports = {
  dist,
  connectTempSqlite,
  connectTempDatabase,
  uniqueLoginName,
  DATABASE_TYPES,
  databaseSkip,
  openAppStorage,
  scriptedLLM,
  startStubServer,
  startApp,
  USER1,
  JWT_SECRET,
};
