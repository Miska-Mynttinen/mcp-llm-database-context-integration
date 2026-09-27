// Dependency-free, and erasable TypeScript only, so `node --test` can import it directly.

const TOKEN_KEY = 'auth-token'
const USERNAME_KEY = 'auth-username'
const SESSION_KEY = 'chat-session-id'

export type Login = {
  token: string
  username: string
}

/** Where the login is kept: `sessionStorage` in the browser, a fake in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * This tab's login and the chat session it is in. A session belongs to one user, so every
 * login change starts a new one: a session id left over from another user would be rejected.
 */
export interface LoginStore {
  /** The stored login, or null when logged out. */
  current(): Login | null
  /** Stores the login and starts a new chat session. */
  begin(login: Login): Login
  /** Forgets the login and starts a new chat session. */
  end(): void
  /** This tab's chat session id, created on first use. */
  sessionId(): string
  /** Starts a new chat session and returns its id. */
  newConversation(): string
}

/**
 * `storage` may be missing or throw (blocked storage, some private modes); the login and
 * session then live in memory until the page is reloaded.
 */
export function createLoginStore(storage?: KeyValueStorage): LoginStore {
  const kept = fallingBackToMemory(storage)

  const newConversation = (): string => {
    const sessionId = createSessionId()
    kept.setItem(SESSION_KEY, sessionId)
    return sessionId
  }

  return {
    current() {
      const token = kept.getItem(TOKEN_KEY)
      return token ? { token, username: kept.getItem(USERNAME_KEY) ?? '' } : null
    },
    begin(login) {
      newConversation()
      kept.setItem(TOKEN_KEY, login.token)
      kept.setItem(USERNAME_KEY, login.username)
      return { ...login }
    },
    end() {
      kept.removeItem(TOKEN_KEY)
      kept.removeItem(USERNAME_KEY)
      newConversation()
    },
    sessionId() {
      return kept.getItem(SESSION_KEY) ?? newConversation()
    },
    newConversation,
  }
}

function fallingBackToMemory(storage: KeyValueStorage | undefined): KeyValueStorage {
  const memory = new Map<string, string>()
  const attempt = (operation: (store: KeyValueStorage) => void) => {
    try {
      if (storage) operation(storage)
    } catch {
      // Kept in memory instead: see createLoginStore.
    }
  }
  return {
    getItem(key) {
      let stored: string | null = null
      attempt(store => { stored = store.getItem(key) })
      // Memory covers writes the storage refused, such as when over quota.
      return stored ?? memory.get(key) ?? null
    },
    setItem(key, value) {
      memory.set(key, value)
      attempt(store => store.setItem(key, value))
    },
    removeItem(key) {
      memory.delete(key)
      attempt(store => store.removeItem(key))
    },
  }
}

// crypto.randomUUID only exists in secure contexts (HTTPS or localhost), so the
// UI would crash when opened over plain HTTP on a LAN address without this fallback.
function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function browserStorage(): KeyValueStorage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/** The app's login store, on `sessionStorage`. */
export const loginStore: LoginStore = createLoginStore(browserStorage())
