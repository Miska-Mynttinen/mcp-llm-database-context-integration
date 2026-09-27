import { DURATION_PATTERN } from '../config/duration';
import { validatePassword } from './credentials';
import { readAllowedOrigins } from './origin';

export const MIN_JWT_SECRET_LENGTH = 32;
export const DEFAULT_SEED_USERNAMES: readonly string[] = ['user1', 'user2', 'user3', 'user4', 'user5'];
const DEFAULT_JWT_EXPIRES_IN = '8h';

/** Users sharing one password; no password means nobody is seeded. */
export interface SeedConfig {
  usernames: readonly string[];
  password?: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  seed: SeedConfig;
  /** ALLOWED_ORIGINS: browser origins besides the app's own that may call the API. */
  allowedOrigins: string[];
}

/** Reads and validates JWT_SECRET, JWT_EXPIRES_IN and the seed settings; throws on bad values. */
export function readAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set to at least ${MIN_JWT_SECRET_LENGTH} characters (e.g. openssl rand -hex 32)`,
    );
  }

  const jwtExpiresIn = env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN;
  if (!DURATION_PATTERN.test(jwtExpiresIn)) {
    throw new Error(`JWT_EXPIRES_IN must be a duration such as 8h, 30m or 3600 (got "${jwtExpiresIn}")`);
  }

  return { jwtSecret, jwtExpiresIn, seed: readSeedConfig(env), allowedOrigins: readAllowedOrigins(env) };
}

/** Reads SEED_USER_PASSWORD, the shared password of the default users. */
export function readSeedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  return {
    usernames: DEFAULT_SEED_USERNAMES,
    password: optionalPassword(env.SEED_USER_PASSWORD, 'SEED_USER_PASSWORD'),
  };
}

function optionalPassword(value: string | undefined, name: string): string | undefined {
  if (!value) {
    return undefined;
  }
  validatePassword(value, name);
  return value;
}
