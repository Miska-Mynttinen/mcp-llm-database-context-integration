const assert = require('node:assert/strict');
const test = require('node:test');
const { connectTempDatabase, connectTempSqlite, databaseSkip, openAppStorage, uniqueLoginName } = require('./helpers');

const { createUntrustedDatabase, INTERNAL_TABLES } = require('@mcp-llm/database');

test('openAppStorage creates every app table and index, and is idempotent', async (t) => {
  const { database, cleanup } = await connectTempSqlite('app-storage');
  t.after(cleanup);
  await openAppStorage(database);
  await openAppStorage(database);

  const tables = (await database.getTables()).map((table) => table.tableName).sort();
  assert.deepEqual(tables, [...INTERNAL_TABLES].sort());
  const { rows } = await database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'");
  assert.deepEqual(rows.map((row) => row.name).sort(), [
    'idx_chat_messages_session_created',
    'idx_chat_sessions_user',
    'idx_llm_token_usage_day',
  ]);
});

// The guard against adding an app table without naming it in APP_TABLES.
test('every table the app creates is hidden from untrusted readers', async (t) => {
  const { database, cleanup } = await connectTempSqlite('app-storage-hidden');
  t.after(cleanup);
  await openAppStorage(database);
  const untrusted = createUntrustedDatabase(database);

  assert.deepEqual(await untrusted.getTables(), []);
  assert.deepEqual((await untrusted.getSchema()).columns, []);
  for (const table of (await database.getTables()).map((entry) => entry.tableName)) {
    await assert.rejects(untrusted.readOnlyQuery(`SELECT * FROM ${table}`), /internal application table/);
  }
});

for (const type of ['postgres', 'mysql']) {
  test(`${type}: the read-only login can read the data but no app table`, { skip: databaseSkip(type) }, async (t) => {
    const { database, connectAs, cleanup } = await connectTempDatabase(type, 'app-storage-reader');
    t.after(cleanup);
    const readOnlyLogin = { user: uniqueLoginName(), password: 'reader-pass-1' };
    const assertNoAppTables = async (reader) => {
      for (const table of INTERNAL_TABLES) {
        await assert.rejects(reader.query(`SELECT * FROM ${table}`), /denied/i, table);
      }
    };

    // A fresh install: only the app tables exist, and the login can still connect.
    await openAppStorage(database, { readOnlyLogin });
    await assertNoAppTables(await connectAs(readOnlyLogin));

    // Data added later, then the next startup grants again with the same password.
    await database.query('CREATE TABLE products (id INTEGER)');
    await openAppStorage(database, { readOnlyLogin });
    const reader = await connectAs(readOnlyLogin);
    assert.deepEqual((await reader.query('SELECT id FROM products')).rows, []);
    await assertNoAppTables(reader);
  });
}
