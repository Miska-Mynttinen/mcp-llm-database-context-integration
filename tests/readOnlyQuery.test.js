const assert = require('node:assert/strict');
const test = require('node:test');
const { connectTempSqlite } = require('./helpers');

const { createUntrustedDatabase, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT } = require('@mcp-llm/database');

/** An untrusted view of a temp SQLite database with an `items` table of `rows` rows. */
async function untrustedWithItems(t, rows = 0) {
  const { database, cleanup } = await connectTempSqlite('untrusted');
  t.after(cleanup);
  await database.query('CREATE TABLE items (id INTEGER, name TEXT)');
  if (rows > 0) {
    await database.query(
      `INSERT INTO items (id, name) WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ${rows})
       SELECT id, 'item ' || id FROM n`,
    );
  }
  return { database, untrusted: createUntrustedDatabase(database) };
}

test('accepts single SELECT and WITH statements, with or without a trailing semicolon', async (t) => {
  const { untrusted } = await untrustedWithItems(t);
  assert.deepEqual((await untrusted.readOnlyQuery('  SELECT 1 AS n;  ')).rows, [{ n: 1 }]);
  assert.deepEqual((await untrusted.readOnlyQuery('WITH t AS (SELECT 1 AS n) SELECT n FROM t')).rows, [{ n: 1 }]);
  assert.deepEqual((await untrusted.readOnlyQuery("SELECT REPLACE('banana', 'a', 'o') AS s")).rows, [{ s: 'bonono' }]);
  assert.deepEqual((await untrusted.readOnlyQuery("SELECT 'a  b' AS s")).rows, [{ s: 'a  b' }]);
});

for (const [label, sql] of [
  ['empty', '   '],
  ['multiple statements', 'SELECT 1; DROP TABLE items'],
  ['line comment', 'SELECT 1 -- hi'],
  ['block comment', 'SELECT /* hi */ 1'],
  ['non-select', 'DELETE FROM items'],
  ['writable CTE', 'WITH d AS (DELETE FROM items RETURNING *) SELECT * FROM d'],
  ['SELECT INTO', 'SELECT * INTO backup FROM items'],
  ['INTO OUTFILE', "SELECT * FROM items INTO OUTFILE '/tmp/x'"],
  ['internal users table', 'SELECT * FROM app_users'],
  ['chat messages table', 'SELECT content FROM chat_messages'],
  ['chat sessions table', 'SELECT user_id FROM Chat_Sessions'],
  ['token usage table', 'SELECT client_ip FROM llm_token_usage'],
  ['quoted, upper-case internal table', 'SELECT password_hash FROM "APP_USERS"'],
  ['internal table in a subquery', 'SELECT (SELECT password_hash FROM public.app_users LIMIT 1)'],
  ['unicode-escaped identifier', 'SELECT * FROM U&"\\0061pp_users"'],
  ['dynamic query function', "SELECT query_to_xml('select * from app_' || 'us' || 'ers', true, false, '')"],
  ['table_to_xml', "SELECT table_to_xml('app_' || 'users', true, false, '')"],
  ['text search over a query given as text', "SELECT * FROM ts_stat('SELECT to_tsvector(content) FROM chat_' || 'messages')"],
  ['PostgreSQL column statistics by computed name', "SELECT attname, most_common_vals FROM pg_stats WHERE tablename = 'app_' || 'users'"],
  ['PostgreSQL statistics table', 'SELECT * FROM pg_catalog.pg_statistic'],
  ['other sessions\' SQL', 'SELECT query FROM pg_stat_activity'],
  ['information_schema', "SELECT * FROM information_schema.column_statistics WHERE table_name = CONCAT('app_', 'users')"],
  ['MySQL system schema', 'SELECT * FROM mysql.user'],
  ['SQLite schema table', 'SELECT sql FROM sqlite_master'],
  ['SQLite pragma function', "SELECT * FROM pragma_table_info('app_' || 'users')"],
]) {
  test(`rejects ${label}`, async (t) => {
    const { database, untrusted } = await untrustedWithItems(t, 1);
    await assert.rejects(untrusted.readOnlyQuery(sql));
    assert.equal((await database.query('SELECT COUNT(*) AS n FROM items')).rows[0].n, 1);
  });
}

test('limits rows in SQL and reports truncation', async (t) => {
  const { untrusted } = await untrustedWithItems(t, 5);
  const limited = await untrusted.readOnlyQuery('SELECT id FROM items ORDER BY id', [], 3);
  assert.deepEqual(limited, { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3, truncated: true });

  const all = await untrusted.readOnlyQuery('SELECT id FROM items WHERE id > ?', [3]);
  assert.deepEqual(all, { rows: [{ id: 4 }, { id: 5 }], rowCount: 2, truncated: false });

  const cte = await untrusted.readOnlyQuery('WITH big AS (SELECT id FROM items WHERE id >= 4) SELECT COUNT(*) AS n FROM big');
  assert.deepEqual(cte.rows, [{ n: 2 }]);
});

test('clamps row limits: unusable values mean the default, large ones the maximum', async (t) => {
  const { untrusted } = await untrustedWithItems(t, MAX_ROW_LIMIT + 5);
  const count = async (limit) => (await untrusted.readOnlyQuery('SELECT id FROM items', [], limit)).rowCount;
  for (const limit of [undefined, -5, 0, 'abc']) {
    assert.equal(await count(limit), DEFAULT_ROW_LIMIT, `limit ${limit}`);
  }
  assert.equal(await count(7.9), 7);
  assert.equal(await count(10_000_000), MAX_ROW_LIMIT);
});

test('listings omit internal tables, which are still there for the app', async (t) => {
  const { database, cleanup } = await connectTempSqlite('internal-tables');
  t.after(cleanup);
  await database.query('CREATE TABLE app_users (id TEXT, password_hash TEXT)');
  await database.query('CREATE TABLE products (id TEXT)');
  const untrusted = createUntrustedDatabase(database);

  assert.deepEqual((await untrusted.getTables()).map((table) => table.tableName), ['products']);
  const schema = await untrusted.getSchema();
  assert.deepEqual(schema.tables.map((table) => table.tableName), ['products']);
  assert.ok(schema.columns.every((column) => column.tableName === 'products'));
  assert.deepEqual(await untrusted.getColumns('app_users'), []);
  assert.deepEqual(await untrusted.getColumns('APP_USERS'), []);
  assert.ok((await database.getTables()).some((table) => table.tableName === 'app_users'));
});

test('the untrusted view has no raw query', async (t) => {
  const { untrusted } = await untrustedWithItems(t);
  assert.equal(untrusted.query, undefined);
});

test('SQLite adapter lists columns for one table and for the whole schema', async (t) => {
  const { database, cleanup } = await connectTempSqlite('columns');
  t.after(cleanup);
  await database.query('CREATE TABLE a (id INTEGER NOT NULL, name TEXT DEFAULT \'x\')');
  await database.query('CREATE TABLE b (ref INTEGER)');

  const columns = await database.getColumns('a');
  assert.deepEqual(columns.map((c) => [c.columnName, c.dataType, c.isNullable, c.columnDefault]), [
    ['id', 'INTEGER', false, undefined],
    ['name', 'TEXT', true, "'x'"],
  ]);
  const schema = await database.getSchema();
  assert.deepEqual(schema.columns.map((c) => `${c.tableName}.${c.columnName}`), ['a.id', 'a.name', 'b.ref']);
});


test('reads the read-only login from DB_READONLY_USER and DB_READONLY_PASSWORD', () => {
  const { readReadOnlyLoginFromEnv } = require('@mcp-llm/database');
  const postgres = { DB_TYPE: 'postgres' };
  assert.equal(readReadOnlyLoginFromEnv(postgres), undefined);
  assert.deepEqual(
    readReadOnlyLoginFromEnv({ ...postgres, DB_READONLY_USER: ' mcp_reader ', DB_READONLY_PASSWORD: 'secret' }),
    { user: 'mcp_reader', password: 'secret' },
  );
  assert.throws(() => readReadOnlyLoginFromEnv({ ...postgres, DB_READONLY_USER: 'mcp_reader' }), /DB_READONLY_PASSWORD must be set/);
  assert.throws(
    () => readReadOnlyLoginFromEnv({ DB_TYPE: 'sqlite', DB_READONLY_USER: 'mcp_reader', DB_READONLY_PASSWORD: 'secret' }),
    /SQLite has no database logins/,
  );
});

test('DB_TYPE must name a supported database', () => {
  const { readDatabaseConfigFromEnv } = require('@mcp-llm/database');
  assert.equal(readDatabaseConfigFromEnv({}).type, 'sqlite');
  assert.throws(() => readDatabaseConfigFromEnv({ DB_TYPE: 'oracle' }), /DB_TYPE must be one of postgres, mysql, sqlite/);
});

test('DB_* defaults suit each server, with no default password', () => {
  const { readDatabaseConfigFromEnv } = require('@mcp-llm/database');
  const mysql = readDatabaseConfigFromEnv({ DB_TYPE: 'mysql' });
  assert.deepEqual([mysql.user, mysql.port, mysql.password], ['root', 3306, '']);
  const postgres = readDatabaseConfigFromEnv({ DB_TYPE: 'postgres' });
  assert.deepEqual([postgres.user, postgres.port, postgres.password], ['postgres', 5432, '']);
  assert.deepEqual([postgres.ssl, postgres.statementTimeoutMs], ['off', 30000]);
});

test('DB_PORT, DB_SSL and DB_STATEMENT_TIMEOUT_MS are validated', () => {
  const { readDatabaseConfigFromEnv } = require('@mcp-llm/database');
  const postgres = (env) => readDatabaseConfigFromEnv({ DB_TYPE: 'postgres', ...env });
  assert.equal(postgres({ DB_PORT: '6543' }).port, 6543);
  for (const port of ['abc', '0', '70000', '54.3']) {
    assert.throws(() => postgres({ DB_PORT: port }), /DB_PORT must be a port number/, port);
  }
  assert.equal(postgres({ DB_SSL: ' Verify ' }).ssl, 'verify');
  assert.throws(() => postgres({ DB_SSL: 'true' }), /DB_SSL must be one of off, require, verify/);
  assert.equal(postgres({ DB_STATEMENT_TIMEOUT_MS: '0' }).statementTimeoutMs, 0);
  for (const timeout of ['-1', '1.5', 'soon']) {
    assert.throws(() => postgres({ DB_STATEMENT_TIMEOUT_MS: timeout }), /DB_STATEMENT_TIMEOUT_MS/, timeout);
  }
  // SQLite has no port, so a leftover DB_PORT does not matter.
  assert.equal(readDatabaseConfigFromEnv({ DB_TYPE: 'sqlite', DB_PORT: 'abc' }).port, 0);
});
