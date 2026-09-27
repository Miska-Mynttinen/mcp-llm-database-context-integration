const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// The frontend's login module, loaded straight from its TypeScript source (Node strips the types).
const loadLoginModule = () => import(path.join(__dirname, '..', 'frontend', 'src', 'login.ts'));

function mapStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };
}

const brokenStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

const ALICE = { token: 'alice-token', username: 'alice' };

test('logged out until a login begins; the login survives a new store on the same storage', async () => {
  const { createLoginStore } = await loadLoginModule();
  const storage = mapStorage();
  const logins = createLoginStore(storage);

  assert.equal(logins.current(), null);
  assert.deepEqual(logins.begin(ALICE), ALICE);
  assert.deepEqual(createLoginStore(storage).current(), ALICE);
});

test('the chat session id is stable until a new conversation starts', async () => {
  const { createLoginStore } = await loadLoginModule();
  const logins = createLoginStore(mapStorage());

  const first = logins.sessionId();
  assert.equal(logins.sessionId(), first);
  const next = logins.newConversation();
  assert.notEqual(next, first);
  assert.equal(logins.sessionId(), next);
});

test('every login change starts a new chat session', async () => {
  const { createLoginStore } = await loadLoginModule();
  const logins = createLoginStore(mapStorage());

  const beforeLogin = logins.sessionId();
  logins.begin(ALICE);
  const alices = logins.sessionId();
  assert.notEqual(alices, beforeLogin);

  logins.end();
  assert.equal(logins.current(), null);
  assert.notEqual(logins.sessionId(), alices);
});

test('works in memory when storage is missing or throws', async () => {
  const { createLoginStore } = await loadLoginModule();
  for (const storage of [undefined, brokenStorage]) {
    const logins = createLoginStore(storage);
    logins.begin(ALICE);
    assert.deepEqual(logins.current(), ALICE);
    assert.equal(logins.sessionId(), logins.sessionId());
    logins.end();
    assert.equal(logins.current(), null);
  }
});

test('importing the module outside a browser does not throw', async () => {
  const { loginStore } = await loadLoginModule();
  assert.equal(loginStore.current(), null);
});
