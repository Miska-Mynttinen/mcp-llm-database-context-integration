import { validateNewCredentials } from './credentials';
import { hashPassword, verifyPassword } from './passwordHash';
import { type TokenService } from './tokens';
import { type AuthUser, isUserRole, type User, type UserStore } from './types';

export interface LoginResult {
  token: string;
  user: AuthUser;
}

export class UsernameTakenError extends Error {
  constructor() {
    super('Username is already taken');
  }
}

export interface AuthService {
  /** Returns a signed token for valid credentials, or `null` for any wrong username or password. */
  login(username: string, password: string): Promise<LoginResult | null>;
  /**
   * Creates a regular (`user` role) account and logs it in. Throws `InvalidCredentialsError`
   * for a bad username or password and `UsernameTakenError` when the name exists.
   */
  register(username: string, password: string): Promise<LoginResult>;
  verify(token: string): AuthUser | null;
}

export interface AuthServiceDeps {
  users: UserStore;
  tokens: TokenService;
}

export function createAuthService({ users, tokens }: AuthServiceDeps): AuthService {
  // Checked against when the username is unknown, so both failure paths cost one scrypt.
  const dummyHash = hashPassword('dummy-password-for-timing');
  const issue = (user: User): LoginResult => {
    const authUser: AuthUser = { id: user.id, username: user.username, role: user.role };
    return { token: tokens.sign(authUser), user: authUser };
  };

  return {
    async login(username, password) {
      const user = await users.findByUsername(username);
      if (!user) {
        await verifyPassword(password, await dummyHash);
        return null;
      }
      // Rows with a role this version doesn't know (such as a former `admin`) can't log in.
      const valid = (await verifyPassword(password, user.passwordHash)) && isUserRole(user.role);
      return valid ? issue(user) : null;
    },

    async register(username, password) {
      validateNewCredentials(username, password);
      if (await users.findByUsername(username)) {
        throw new UsernameTakenError();
      }
      const passwordHash = await hashPassword(password);
      try {
        return issue(await users.create({ username, passwordHash, role: 'user' }));
      } catch (error) {
        // A concurrent sign-up won the unique constraint; report it like the check above.
        if (await users.findByUsername(username)) {
          throw new UsernameTakenError();
        }
        throw error;
      }
    },

    verify: (token) => tokens.verify(token),
  };
}
