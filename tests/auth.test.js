const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { dist, connectTempSqlite, openAppStorage } = require('./helpers');

const {
  hashPassword,
  verifyPassword,
  createTokenService,
  readAuthConfigFromEnv,
  seedUser,
  seedFromConfig,
  readSeedConfig,
  createAuthService,
} = dist('src/auth');

const SECRET = 'test-secret-that-is-at-least-32-characters';
const USER = { id: 'u1', username: 'user1', role: 'user' };

test('password hashes verify only the original password and are salted', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('s3cret-password', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  assert.notEqual(await hashPassword('s3cret-password'), hash);
});

test('malformed or tampered hashes never verify', async () => {
  const hash = await hashPassword('pw-pw-pw-pw');
  const [scheme, salt, digest] = hash.split('$');
  const flipped = (digest[0] === '0' ? '1' : '0') + digest.slice(1);
  for (const stored of ['', 'plain', `bcrypt$${salt}$${digest}`, `${scheme}$${salt}$${flipped}`, `${scheme}$${salt}$abcd`]) {
    assert.equal(await verifyPassword('pw-pw-pw-pw', stored), false, stored);
  }
});

test('tokens round-trip and carry the user as sub/username/role', () => {
  const tokens = createTokenService({ secret: SECRET, expiresIn: '1h' });
  const token = tokens.sign(USER);
  assert.deepEqual(tokens.verify(token), USER);
  const decoded = jwt.decode(token, { complete: true });
  assert.equal(decoded.header.alg, 'HS256');
  assert.equal(decoded.payload.sub, 'u1');
  assert.equal(decoded.payload.exp - decoded.payload.iat, 3600);
});

test('tokens are rejected when expired, forged, unsigned or garbage', () => {
  const tokens = createTokenService({ secret: SECRET, expiresIn: '1h' });
  const expired = createTokenService({ secret: SECRET, expiresIn: '-1s' }).sign(USER);
  const forged = createTokenService({ secret: 'x'.repeat(40), expiresIn: '1h' }).sign(USER);
  const unsigned = jwt.sign({ username: 'user1', role: 'user' }, null, { algorithm: 'none', subject: 'u1' });
  const wrongRole = jwt.sign({ username: 'user1', role: 'admin' }, SECRET, { subject: 'u1' });
  for (const token of [expired, forged, unsigned, wrongRole, 'garbage', '']) {
    assert.equal(tokens.verify(token), null, token);
  }
});

test('auth config requires a strong secret and validates durations and password length', () => {
  const base = { JWT_SECRET: SECRET };
  assert.deepEqual(readAuthConfigFromEnv(base), {
    jwtSecret: SECRET,
    jwtExpiresIn: '8h',
    seed: { usernames: ['user1', 'user2', 'user3', 'user4', 'user5'], password: undefined },
    allowedOrigins: [],
  });
  assert.throws(() => readAuthConfigFromEnv({}), /JWT_SECRET/);
  assert.throws(() => readAuthConfigFromEnv({ JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.throws(() => readAuthConfigFromEnv({ ...base, JWT_EXPIRES_IN: 'forever' }), /JWT_EXPIRES_IN/);
  assert.throws(() => readAuthConfigFromEnv({ ...base, SEED_USER_PASSWORD: 'short' }), /SEED_USER_PASSWORD/);
  assert.equal(readAuthConfigFromEnv({ ...base, SEED_USER_PASSWORD: 'longenough' }).seed.password, 'longenough');
});

test('seeding is idempotent and only resets the password when asked', async (t) => {
  const { database, cleanup } = await connectTempSqlite('auth-seed');
  t.after(cleanup);
  const users = (await openAppStorage(database)).users;

  assert.equal(await seedUser(users, { username: 'user1', password: 'first-password' }), 'created');
  const created = await users.findByUsername('user1');
  assert.equal(created.role, 'user');
  assert.equal(await verifyPassword('first-password', created.passwordHash), true);

  assert.equal(await seedUser(users, { username: 'user1', password: 'second-password' }), 'exists');
  assert.equal((await users.findByUsername('user1')).passwordHash, created.passwordHash);

  assert.equal(await seedUser(users, { username: 'user1', password: 'second-password', resetPassword: true }), 'password-reset');
  const reset = await users.findByUsername('user1');
  assert.equal(reset.id, created.id);
  assert.equal(await verifyPassword('second-password', reset.passwordHash), true);

  const { rows } = await database.query('SELECT COUNT(*) AS n FROM app_users');
  assert.equal(Number(rows[0].n), 1);
});

test('seedFromConfig seeds user1-user5 as users, idempotently', async (t) => {
  const { database, cleanup } = await connectTempSqlite('auth-seed-all');
  t.after(cleanup);
  const users = (await openAppStorage(database)).users;
  const config = readSeedConfig({ SEED_USER_PASSWORD: 'user-password' });

  const names = ['user1', 'user2', 'user3', 'user4', 'user5'];
  assert.deepEqual(await seedFromConfig(users, config), names.map((username) => ({ username, outcome: 'created' })));
  assert.deepEqual(await seedFromConfig(users, config), names.map((username) => ({ username, outcome: 'exists' })));

  const user3 = await users.findByUsername('user3');
  assert.equal(user3.role, 'user');
  assert.equal(await verifyPassword('user-password', user3.passwordHash), true);
  const { rows } = await database.query('SELECT COUNT(*) AS n FROM app_users');
  assert.equal(Number(rows[0].n), 5);
});

test('seedFromConfig seeds nobody without SEED_USER_PASSWORD', async (t) => {
  const { database, cleanup } = await connectTempSqlite('auth-seed-none');
  t.after(cleanup);
  assert.deepEqual(await seedFromConfig((await openAppStorage(database)).users, readSeedConfig({})), []);
});

test('accounts with a role this version does not know cannot log in', async (t) => {
  const { database, cleanup } = await connectTempSqlite('auth-legacy-role');
  t.after(cleanup);
  const users = (await openAppStorage(database)).users;
  await users.create({ username: 'admin', passwordHash: await hashPassword('admin-password'), role: 'admin' });
  await seedUser(users, { username: 'user1', password: 'user-password' });
  const auth = createAuthService({ users, tokens: createTokenService({ secret: SECRET, expiresIn: '1h' }) });

  assert.equal(await auth.login('admin', 'admin-password'), null);
  assert.equal((await auth.login('user1', 'user-password')).user.role, 'user');
});
