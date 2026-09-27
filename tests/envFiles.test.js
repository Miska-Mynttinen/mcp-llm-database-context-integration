const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dist } = require('./helpers');

const { loadConfigEnvFiles } = dist('src/config/envFiles');
const {
  assertNoDevelopmentSecrets, isProduction, loadEnvFiles, parseList, requireMcpAuthToken,
} = require('@mcp-llm/runtime');

const KEYS = ['ENVTEST_LLM', 'ENVTEST_DB', 'ENVTEST_LIMITS', 'ENVTEST_MCP', 'ENVTEST_APP', 'ENVTEST_SHARED', 'ENVTEST_SHELL'];

function tempDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function clearKeys() {
  for (const key of KEYS) {
    delete process.env[key];
  }
}

test.beforeEach(clearKeys);
test.afterEach(clearKeys);

test('loads .env.llm, .env.database, .env.mcp, .env.limits and .env; specific files win over .env, shell wins over all', () => {
  const dir = tempDirWith({
    '.env.llm': 'ENVTEST_LLM=llm\nENVTEST_SHARED=from-llm\nENVTEST_SHELL=from-file\n',
    '.env.database': 'ENVTEST_DB=db\n',
    '.env.mcp': 'ENVTEST_MCP=mcp\n',
    '.env.limits': 'ENVTEST_LIMITS=limits\n',
    '.env': 'ENVTEST_APP=app\nENVTEST_SHARED=from-app\n',
  });
  process.env.ENVTEST_SHELL = 'from-shell';

  const loaded = loadConfigEnvFiles(dir);

  assert.deepEqual(loaded.map((file) => path.basename(file)), ['.env.llm', '.env.database', '.env.mcp', '.env.limits', '.env']);
  assert.equal(process.env.ENVTEST_LLM, 'llm');
  assert.equal(process.env.ENVTEST_DB, 'db');
  assert.equal(process.env.ENVTEST_LIMITS, 'limits');
  assert.equal(process.env.ENVTEST_MCP, 'mcp');
  assert.equal(process.env.ENVTEST_APP, 'app');
  assert.equal(process.env.ENVTEST_SHARED, 'from-llm');
  assert.equal(process.env.ENVTEST_SHELL, 'from-shell');
  fs.rmSync(dir, { recursive: true });
});

test('missing env files are skipped', () => {
  const dir = tempDirWith({ '.env.database': 'ENVTEST_DB=db\n' });

  assert.deepEqual(loadConfigEnvFiles(dir).map((file) => path.basename(file)), ['.env.database']);
  assert.deepEqual(loadEnvFiles(path.join(dir, 'missing'), ['.env.database']), []);
  assert.equal(process.env.ENVTEST_DB, 'db');
  fs.rmSync(dir, { recursive: true });
});

test('production refuses the public development secrets, naming each one', () => {
  assert.equal(isProduction({ NODE_ENV: 'production' }), true);
  assert.equal(isProduction({}), false);

  const development = {
    NODE_ENV: 'production',
    JWT_SECRET: 'saltsecret-saltsecret-saltsecret-00',
    SEED_USER_PASSWORD: 'password',
    MCP_AUTH_TOKEN: 'dev-mcp-token-dev-mcp-token-dev-mcp-token',
    DB_PASSWORD: 'password',
  };
  assert.throws(
    () => assertNoDevelopmentSecrets(development),
    /JWT_SECRET, SEED_USER_PASSWORD, MCP_AUTH_TOKEN, DB_PASSWORD/,
  );
  assert.throws(() => assertNoDevelopmentSecrets({ NODE_ENV: 'production', JWT_SECRET: development.JWT_SECRET }), /JWT_SECRET/);
  assert.doesNotThrow(() => assertNoDevelopmentSecrets({
    NODE_ENV: 'production', JWT_SECRET: 'a-real-secret-of-sufficient-length-000', DB_PASSWORD: 'x7',
  }));
  assert.doesNotThrow(() => assertNoDevelopmentSecrets({ NODE_ENV: 'production' }));
});

test('development secrets are fine outside production', () => {
  assert.doesNotThrow(() => assertNoDevelopmentSecrets({ JWT_SECRET: 'saltsecret-saltsecret-saltsecret-00', DB_PASSWORD: 'password' }));
});

test('the MCP token must be at least 32 characters, and says why it is needed', () => {
  assert.equal(requireMcpAuthToken({ MCP_AUTH_TOKEN: ` ${'x'.repeat(32)} ` }, 'here'), 'x'.repeat(32));
  assert.throws(() => requireMcpAuthToken({ MCP_AUTH_TOKEN: 'short' }, 'for the test'), /at least 32 characters for the test/);
  assert.throws(() => requireMcpAuthToken({}, 'for the test'), /MCP_AUTH_TOKEN/);
});

test('parseList splits, trims and drops empty entries', () => {
  assert.deepEqual(parseList(' a, ,b ,'), ['a', 'b']);
  assert.deepEqual(parseList(undefined), []);
});
