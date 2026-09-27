const assert = require('node:assert/strict');
const test = require('node:test');
const { connectTempDatabase, DATABASE_TYPES, databaseSkip, uniqueLoginName } = require('./helpers');

/** Creates `items` with three rows, bound through `?` placeholders. */
async function createItems(database) {
  await database.query('CREATE TABLE items (id INTEGER NOT NULL, name VARCHAR(50), price DECIMAL(10,2))');
  for (const [id, name, price] of [[1, 'one', 1.5], [2, 'two?', 2.25], [3, 'three', 3]]) {
    await database.query('INSERT INTO items (id, name, price) VALUES (?, ?, ?)', [id, name, price]);
  }
}

// One contract, run against every adapter behind the DatabaseAdapter seam.
for (const type of DATABASE_TYPES) {
  const adapterTest = (title, body) => test(`${type}: ${title}`, { skip: databaseSkip(type) }, async (t) => {
    const temp = await connectTempDatabase(type, 'adapter');
    t.after(temp.cleanup);
    await createItems(temp.database);
    await body(temp.database, temp);
  });

  adapterTest('? placeholders bind in order, and stay literal inside strings and quoted names', async (database) => {
    const { rows } = await database.query(
      `SELECT id, name AS "n?", '?' AS q, 'it''s ?' AS s FROM items WHERE id >= ? AND name <> ? ORDER BY id`,
      [2, 'three'],
    );
    assert.deepEqual(rows, [{ id: 2, 'n?': 'two?', q: '?', s: "it's ?" }]);
  });

  adapterTest('LIMIT and OFFSET bind like any other value', async (database) => {
    const { rows } = await database.query('SELECT id FROM items ORDER BY id LIMIT ? OFFSET ?', [1, 1]);
    assert.deepEqual(rows, [{ id: 2 }]);
  });

  adapterTest('counts, sums and decimals come back as numbers when exact', async (database) => {
    const { rows } = await database.query('SELECT COUNT(*) AS n, SUM(id) AS total, MAX(price) AS top FROM items');
    assert.deepEqual(rows, [{ n: 3, total: 6, top: 3 }]);
    assert.deepEqual((await database.query('SELECT price FROM items WHERE id = ?', [2])).rows, [{ price: 2.25 }]);
    if (type !== 'sqlite') {
      // SQLite has no exact decimals; the others keep digits a double would lose.
      const { rows: [big] } = await database.query("SELECT CAST('12345678901234567890' AS DECIMAL(30,0)) AS big");
      assert.equal(big.big, '12345678901234567890');
    }
  });

  adapterTest('dates come back as their YYYY-MM-DD text, whatever the time zone', async (database) => {
    await database.query('CREATE TABLE events (id INTEGER, happened_on DATE)');
    await database.query('INSERT INTO events (id, happened_on) VALUES (?, ?)', [1, '2026-01-08']);
    assert.deepEqual((await database.query('SELECT happened_on FROM events')).rows, [{ happened_on: '2026-01-08' }]);
  });

  adapterTest('columns report nullability as booleans', async (database) => {
    const columns = await database.getColumns('items');
    assert.deepEqual(columns.map((c) => [c.columnName, c.isNullable, c.columnDefault]), [
      ['id', false, undefined],
      ['name', true, undefined],
      ['price', true, undefined],
    ]);
    assert.equal(columns[1].characterMaximumLength, type === 'sqlite' ? undefined : 50);
  });

  adapterTest('maxRows caps a SELECT whatever its joins, LIMITs and strings', async (database) => {
    const count = async (sql, params = []) => (await database.query(sql, params, { maxRows: 2 })).rows.length;
    assert.equal(await count('SELECT a.id, b.id FROM items a JOIN items b ON a.id = b.id'), 2);
    assert.equal(await count(
      "SELECT a.id, b.id FROM (SELECT id FROM items ORDER BY id LIMIT 3) a JOIN items b ON a.id = b.id WHERE b.name <> 'limit'",
    ), 2);
    assert.equal(await count('SELECT id FROM items ORDER BY id LIMIT 3'), 2);
    assert.equal(await count('SELECT id FROM items WHERE id > ?', [2]), 1);
    await assert.rejects(database.query('SELECT id FROM items', [], { maxRows: 0 }), /maxRows/);
    await assert.rejects(database.query('SELECT id FROM items', [], { maxRows: 1.5 }), /maxRows/);
  });

  adapterTest('writes report how many rows they matched', async (database) => {
    assert.equal((await database.query('UPDATE items SET name = ? WHERE id <= ?', ['x', 2])).rowCount, 2);
  });

  adapterTest('ensureIndex leaves an existing index alone', async (database) => {
    const index = { name: 'idx_items_name', table: 'items', columns: ['name', 'id'] };
    await database.ensureIndex(index);
    await database.ensureIndex(index);
  });

  adapterTest('errors name the dialect and keep the driver error as the cause', async (database) => {
    await assert.rejects(database.query('SELECT * FROM missing_table'), (error) => {
      assert.match(error.message, /query error/);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });

  adapterTest('a readOnly connection reads but refuses writes, while the writer keeps writing', async (database, { connectWith }) => {
    const reader = await connectWith({ readOnly: true });
    assert.deepEqual((await reader.query('SELECT COUNT(*) AS n FROM items')).rows, [{ n: 3 }]);
    await assert.rejects(reader.query('INSERT INTO items (id) VALUES (?)', [9]), /readonly|read-only|read only/i);
    await assert.rejects(reader.query('CREATE TABLE mine (id INTEGER)'), /readonly|read-only|read only/i);

    await database.query('INSERT INTO items (id) VALUES (?)', [4]);
    assert.deepEqual((await reader.query('SELECT COUNT(*) AS n FROM items')).rows, [{ n: 4 }]);
  });

  if (type === 'sqlite') {
    adapterTest('has no logins to make read-only', async (database) => {
      await assert.rejects(database.ensureReadOnlyLogin({ user: 'reader', password: 'reader-pass' }, []), /no database logins/);
    });

    adapterTest('the writer switches the file to WAL, so a reader need not block it', async (database) => {
      assert.deepEqual((await database.query('PRAGMA journal_mode')).rows, [{ journal_mode: 'wal' }]);
    });

    test('sqlite: a readOnly connection opens a file the writer has not created yet', async (t) => {
      const { connectDatabaseAdapter } = require('@mcp-llm/database');
      const file = require('node:path').join(require('node:os').tmpdir(), `mcp-chat-early-${process.pid}-${Date.now()}.db`);
      const config = { type: 'sqlite', host: '', port: 0, user: '', password: '', database: file };
      const reader = await connectDatabaseAdapter({ ...config, readOnly: true });
      const writer = await connectDatabaseAdapter(config);
      t.after(async () => {
        await Promise.all([reader.disconnect(), writer.disconnect()]);
        for (const suffix of ['', '-wal', '-shm']) require('node:fs').rmSync(file + suffix, { force: true });
      });
      await writer.query('CREATE TABLE later (id INTEGER)');
      await writer.query('INSERT INTO later (id) VALUES (?)', [1]);
      assert.deepEqual((await reader.query('SELECT id FROM later')).rows, [{ id: 1 }]);
    });
    continue;
  }

  adapterTest('statementTimeoutMs cancels a slow SELECT, and the connection stays usable', async (_database, { connectWith }) => {
    const limited = await connectWith({ statementTimeoutMs: 200 });
    const slowQuery = type === 'postgres' ? 'SELECT pg_sleep(3) FROM items' : 'SELECT SLEEP(3) FROM items';
    const started = Date.now();
    await assert.rejects(limited.query(slowQuery, [], { maxRows: 10 }), /statement timeout|maximum statement execution time/i);
    assert.ok(Date.now() - started < 2000, 'cancelled well before the query would have finished');
    assert.deepEqual((await limited.query('SELECT COUNT(*) AS n FROM items')).rows, [{ n: 3 }]);
  });

  /** `secrets`, a table the read-only login must not see, with one row. */
  const createSecrets = async (database) => {
    await database.query('CREATE TABLE secrets (id INTEGER, value VARCHAR(50))');
    await database.query('INSERT INTO secrets (id, value) VALUES (?, ?)', [1, 'hash']);
  };

  adapterTest('a read-only login reads every table but the hidden ones, and writes nothing', async (database, { connectAs }) => {
    await createSecrets(database);
    const login = { user: uniqueLoginName(), password: 'reader-pass-1' };
    await database.ensureReadOnlyLogin(login, ['SECRETS']);
    const reader = await connectAs(login);

    assert.deepEqual((await reader.query('SELECT COUNT(*) AS n FROM items')).rows, [{ n: 3 }]);
    await assert.rejects(reader.query('SELECT * FROM secrets'), /denied/i);
    await assert.rejects(reader.query('INSERT INTO items (id) VALUES (?)', [9]), /denied|read-only/i);
    await assert.rejects(reader.query('CREATE TABLE mine (id INTEGER)'), /denied|read-only/i);
  });

  adapterTest('granting again resets the password and covers tables created since', async (database, { connectAs }) => {
    const login = { user: uniqueLoginName(), password: 'reader-pass-1' };
    await database.ensureReadOnlyLogin(login, []);
    await database.query('CREATE TABLE later (id INTEGER)');
    if (type === 'postgres') {
      // Default privileges cover the owner's new tables without granting again.
      assert.deepEqual((await (await connectAs(login)).query('SELECT id FROM later')).rows, []);
    }

    const renewed = { ...login, password: 'reader-pass-2' };
    await database.ensureReadOnlyLogin(renewed, []);
    assert.deepEqual((await (await connectAs(renewed)).query('SELECT id FROM later')).rows, []);
    await assert.rejects(connectAs(login), /password|denied|auth/i);
  });

  adapterTest('a read-only login is refused for the owner, odd names and passwords that would end a literal', async (database, { owner }) => {
    const grant = (user, password) => database.ensureReadOnlyLogin({ user, password }, []);
    await assert.rejects(grant(owner, 'reader-pass'), /owner/);
    for (const user of ['bad-name', 'x; DROP TABLE items', '1reader', '']) {
      await assert.rejects(grant(user, 'reader-pass'), /plain identifier/, user);
    }
    for (const password of ["it's", 'back\\slash', 'say "hi"', 'line\nbreak', '']) {
      await assert.rejects(grant('reader', password), /password/, password);
    }
  });

  if (type === 'postgres') {
    adapterTest('an idle connection the server closes is reported, not fatal, and the pool recovers', async (database, { connectWith }) => {
      const errors = [];
      const pooled = await connectWith({ onBackgroundError: (error) => errors.push(error) });
      const { rows: [{ pid }] } = await pooled.query('SELECT pg_backend_pid() AS pid');
      await database.query('SELECT pg_terminate_backend(?)', [pid]);
      for (let attempt = 0; attempt < 50 && errors.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.equal(errors.length, 1);
      assert.deepEqual((await pooled.query('SELECT COUNT(*) AS n FROM items')).rows, [{ n: 3 }]);
    });

    adapterTest('hidden tables are left out of pg_stats, even by a computed name', async (database, { connectAs }) => {
      await createSecrets(database);
      await database.query('ANALYZE secrets');
      const login = { user: uniqueLoginName(), password: 'reader-pass-1' };
      await database.ensureReadOnlyLogin(login, ['secrets']);
      const statsQuery = "SELECT attname FROM pg_stats WHERE tablename = 'sec' || 'rets'";

      assert.ok((await database.query(statsQuery)).rows.length > 0);
      assert.deepEqual((await (await connectAs(login)).query(statsQuery)).rows, []);
    });
  }
}
