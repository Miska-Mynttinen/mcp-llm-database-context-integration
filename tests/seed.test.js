const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dist, connectTempDatabase, DATABASE_TYPES, databaseSkip, openAppStorage, uniqueLoginName } = require('./helpers');

const { seedFromConfig, DEFAULT_SEED_USERNAMES } = dist('src/auth');
const { seedSampleData } = dist('src/seed/seedSampleData');

const SAMPLE_COUNTS = { product: 8, shipment: 10, unit: 23, complaints: 10 };
const seedConfig = { usernames: DEFAULT_SEED_USERNAMES, password: 'seed-password' };

for (const type of DATABASE_TYPES) {
  const seedTest = (title, body) => test(`${type}: ${title}`, { skip: databaseSkip(type) }, async (t) => {
    const temp = await connectTempDatabase(type, 'seed');
    t.after(temp.cleanup);
    await body(temp.database, temp);
  });

  seedTest('seeds user1-user5 and the sample tables, and a second run changes nothing', async (database) => {
    await seedSampleData(database);
    const { users } = await openAppStorage(database);
    const created = await seedFromConfig(users, seedConfig);
    assert.deepEqual(created.map((result) => result.outcome), Array(5).fill('created'));

    const again = await seedSampleData(database);
    assert.deepEqual(again, Object.keys(SAMPLE_COUNTS).map((table) => ({ table, inserted: 0 })));
    assert.deepEqual((await seedFromConfig(users, seedConfig)).map((result) => result.outcome), Array(5).fill('exists'));
    for (const [table, count] of Object.entries(SAMPLE_COUNTS)) {
      assert.deepEqual((await database.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows, [{ n: count }], table);
    }
    for (const username of DEFAULT_SEED_USERNAMES) {
      assert.ok(await users.findByUsername(username), username);
    }
  });

  seedTest('fills in rows missing from an earlier run, leaving existing rows alone', async (database) => {
    await seedSampleData(database);
    await database.query('DELETE FROM complaints WHERE id > ?', [5]);
    await database.query('UPDATE product SET name = ? WHERE id = ?', ['Renamed bracket', 1]);

    const results = await seedSampleData(database);
    assert.equal(results.find((result) => result.table === 'complaints').inserted, 5);
    assert.deepEqual((await database.query('SELECT name FROM product WHERE id = ?', [1])).rows, [{ name: 'Renamed bracket' }]);
  });

  seedTest('the sample data answers questions across all four tables', async (database) => {
    await seedSampleData(database);
    const { rows } = await database.query(`
      SELECT p.name AS product, COUNT(c.id) AS complaints, SUM(c.quantity_affected) AS affected
      FROM complaints c
      JOIN unit u ON u.id = c.unit_id AND u.shipment_id = c.shipment_id
      JOIN product p ON p.id = u.product_id
      GROUP BY p.name
      ORDER BY complaints DESC, p.name
      LIMIT 1`);
    assert.deepEqual(rows, [{ product: 'LED panel 60x60', complaints: 3, affected: 71 }]);
    const { rows: open } = await database.query(
      "SELECT s.reference, c.reported_on FROM complaints c JOIN shipment s ON s.id = c.shipment_id WHERE c.status IN ('open', 'investigating') ORDER BY c.id",
    );
    assert.deepEqual(open, [
      { reference: 'SHP-2026-008', reported_on: '2026-09-03' },
      { reference: 'SHP-2026-008', reported_on: '2026-09-04' },
    ]);
  });

  if (type === 'sqlite') {
    continue; // SQLite only enforces foreign keys with PRAGMA foreign_keys = ON, and has no logins.
  }

  seedTest('a complaint cannot name a unit from another shipment', async (database) => {
    await seedSampleData(database);
    // Unit 1 belongs to shipment 1.
    await assert.rejects(
      database.query(
        "INSERT INTO complaints (id, shipment_id, unit_id, reported_on, category, description, quantity_affected, status) VALUES (?, ?, ?, ?, 'damaged', 'x', 1, 'open')",
        [99, 2, 1, '2026-09-27'],
      ),
      /foreign key/i,
    );
  });

  seedTest('the read-only login can read the sample tables, seeded before it is granted', async (database, { connectAs }) => {
    await seedSampleData(database);
    const login = { user: uniqueLoginName(), password: 'reader-pass-1' };
    await openAppStorage(database, { readOnlyLogin: login });
    const reader = await connectAs(login);
    for (const [table, count] of Object.entries(SAMPLE_COUNTS)) {
      assert.deepEqual((await reader.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows, [{ n: count }], table);
    }
    await assert.rejects(reader.query('SELECT * FROM app_users'), /denied/i);
  });
}

/** Runs `npm run seed`'s entry point in an empty directory, so no local .env file applies. */
function runSeedCli(args, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-chat-seed-cli-'));
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'src', 'seed', 'cli.js'), ...args], {
    cwd,
    env: { PATH: process.env.PATH, DB_TYPE: 'sqlite', DB_NAME: path.join(cwd, 'seed.db'), ...env },
    encoding: 'utf8',
  });
  return { ...result, cwd };
}

test('the seed CLI seeds users and, with --sample-data, the sample tables', (t) => {
  const run = runSeedCli(['--sample-data'], { SEED_USER_PASSWORD: 'seed-password' });
  t.after(() => fs.rmSync(run.cwd, { recursive: true, force: true }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /complaints: 10 rows inserted/);
  assert.match(run.stdout, /user5: created/);
  assert.match(run.stdout, /Seeded 5 users into sqlite/);
});

test('the seed CLI seeds only the sample data without SEED_USER_PASSWORD, and refuses to do nothing', (t) => {
  const samplesOnly = runSeedCli(['--sample-data'], {});
  const nothing = runSeedCli([], {});
  t.after(() => [samplesOnly, nothing].forEach((run) => fs.rmSync(run.cwd, { recursive: true, force: true })));
  assert.equal(samplesOnly.status, 0, samplesOnly.stderr);
  assert.match(samplesOnly.stdout, /no users seeded/);
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /Set SEED_USER_PASSWORD to seed users, or pass --sample-data/);
});
