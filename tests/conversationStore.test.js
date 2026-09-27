const assert = require('node:assert/strict');
const test = require('node:test');
const { dist, connectTempDatabase, DATABASE_TYPES, databaseSkip, openAppStorage } = require('./helpers');

const { InMemoryConversationStore } = dist('src/chat/stores/inMemoryConversationStore');
const { SessionNotFoundError, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } = dist('src/chat/conversationStore');

const adapters = {
  'in-memory': { create: async () => ({ store: new InMemoryConversationStore(), cleanup: async () => {} }), skip: false },
  ...Object.fromEntries(DATABASE_TYPES.map((type) => [`sql (${type})`, {
    create: async () => {
      const { database, cleanup } = await connectTempDatabase(type, 'store');
      return { store: (await openAppStorage(database)).conversations, cleanup };
    },
    skip: databaseSkip(type),
  }])),
};

/** Opens `sessionId` for `userId`, appends each content as a user message, and returns the session. */
async function seed(store, sessionId, userId, contents) {
  const session = await store.openSession(sessionId, userId);
  for (const content of contents) {
    await session.append('user', content);
  }
  return session;
}

// One contract, run against every adapter behind the ConversationStore seam.
for (const [name, { create, skip }] of Object.entries(adapters)) {
  const storeTest = (title, body) => test(`${name}: ${title}`, { skip }, async (t) => {
    const { store, cleanup } = await create();
    t.after(cleanup);
    await body(store);
  });

  storeTest('openSession creates the session for its user and reopens it for the same user', async (store) => {
    const first = await store.openSession('s1', 'alice');
    assert.equal(first.id, 's1');
    assert.equal(first.userId, 'alice');
    assert.equal((await store.openSession('s1', 'alice')).userId, 'alice');
  });

  storeTest('another user can neither open nor find the session', async (store) => {
    await store.openSession('s1', 'alice');
    await assert.rejects(store.openSession('s1', 'bob'), SessionNotFoundError);
    await assert.rejects(store.findOwnedSession('s1', 'bob'), SessionNotFoundError);
    assert.equal((await store.findOwnedSession('s1', 'alice')).userId, 'alice');
    assert.equal(await store.findOwnedSession('missing', 'alice'), undefined);
  });

  storeTest('concurrent first opens of one session both succeed', async (store) => {
    const sessions = await Promise.all([store.openSession('s1', 'alice'), store.openSession('s1', 'alice')]);
    assert.deepEqual(sessions.map((session) => session.userId), ['alice', 'alice']);
  });

  storeTest('a session handle kept past a clear can neither write nor read, even once another user reopens the id', async (store) => {
    const stale = await seed(store, 's1', 'alice', ['hello']);
    await stale.clear();
    await assert.rejects(stale.append('user', 'hi'), /does not exist/);
    assert.deepEqual(await stale.recent(), []);

    const bobs = await seed(store, 's1', 'bob', ['bob only']);
    await assert.rejects(stale.append('user', 'into bob'), /does not exist/);
    assert.deepEqual(await stale.recent(), []);
    await stale.clear();
    assert.deepEqual((await bobs.recent()).map((m) => m.content), ['bob only']);
  });

  storeTest('recent returns the newest N, oldest first', async (store) => {
    const s1 = await seed(store, 's1', 'alice', ['one', 'two', 'three', 'four']);
    await seed(store, 'other', 'alice', ['elsewhere']);

    const recent = await s1.recent(2);
    assert.deepEqual(recent.map((message) => message.content), ['three', 'four']);
    assert.ok(recent.every((message) => message.sessionId === 's1' && message.role === 'user'));
  });

  storeTest('unusable limits fall back to the default and large ones are capped', async (store) => {
    const contents = Array.from({ length: MAX_HISTORY_LIMIT + 5 }, (_, index) => `m${index}`);
    const s1 = await seed(store, 's1', 'alice', contents);
    for (const limit of [Number.NaN, -1, 0, undefined]) {
      assert.equal((await s1.recent(limit)).length, DEFAULT_HISTORY_LIMIT, `limit ${limit}`);
      assert.equal((await store.getRecentMessagesForUser('alice', { limit })).length, DEFAULT_HISTORY_LIMIT, `limit ${limit}`);
    }
    assert.equal((await s1.recent(2.7)).length, 2);
    assert.equal((await s1.recent(1e9)).length, MAX_HISTORY_LIMIT);
    assert.equal((await store.getRecentMessagesForUser('alice', { limit: 1e9 })).length, MAX_HISTORY_LIMIT);
  });

  storeTest("getRecentMessagesForUser spans that user's sessions only, newest N, oldest first", async (store) => {
    const sessions = {
      a1: await store.openSession('a1', 'alice'),
      a2: await store.openSession('a2', 'alice'),
      b1: await store.openSession('b1', 'bob'),
    };
    for (const [sessionId, content] of [['a1', 'one'], ['b1', 'bob'], ['a2', 'two'], ['a1', 'three'], ['a2', 'four']]) {
      await sessions[sessionId].append('user', content);
    }

    assert.deepEqual((await store.getRecentMessagesForUser('alice', { limit: 10 })).map((m) => m.content), ['one', 'two', 'three', 'four']);
    assert.deepEqual((await store.getRecentMessagesForUser('alice', { limit: 2 })).map((m) => [m.sessionId, m.content]), [['a1', 'three'], ['a2', 'four']]);
    assert.deepEqual((await store.getRecentMessagesForUser('bob')).map((m) => m.content), ['bob']);
    assert.deepEqual(await store.getRecentMessagesForUser('nobody'), []);
  });

  storeTest('role filters count only matching messages, and one session can be left out', async (store) => {
    const a1 = await store.openSession('a1', 'alice');
    const a2 = await store.openSession('a2', 'alice');
    for (const [session, role, content] of [
      [a1, 'user', 'q1'], [a1, 'tool', 'record'], [a1, 'assistant', 'a1'], [a2, 'user', 'q2'], [a2, 'tool', 'record 2'],
    ]) {
      await session.append(role, content);
    }
    const visible = ['user', 'assistant'];

    assert.deepEqual((await a1.recent(2, visible)).map((m) => m.content), ['q1', 'a1']);
    assert.deepEqual((await a1.recent(10, [])), []);
    assert.deepEqual((await a1.recent()).map((m) => m.role), ['user', 'tool', 'assistant']);
    const others = await store.getRecentMessagesForUser('alice', { roles: visible, excludeSessionId: 'a2' });
    assert.deepEqual(others.map((m) => m.content), ['q1', 'a1']);
    const all = await store.getRecentMessagesForUser('alice', { limit: 2, roles: visible });
    assert.deepEqual(all.map((m) => m.content), ['a1', 'q2']);
  });

  storeTest('clear removes only that session, which can then be opened afresh', async (store) => {
    const s1 = await seed(store, 's1', 'alice', ['hello']);
    const s2 = await seed(store, 's2', 'alice', ['hi']);
    await s1.clear();
    assert.equal(await store.findOwnedSession('s1', 'alice'), undefined);
    assert.equal((await s2.recent()).length, 1);
    assert.equal((await store.openSession('s1', 'bob')).userId, 'bob');
  });
}

