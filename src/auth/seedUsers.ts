import { type SeedConfig } from './config';
import { hashPassword } from './passwordHash';
import { type UserStore } from './types';

export type SeedOutcome = 'created' | 'exists' | 'password-reset';

export interface SeedUserOptions {
  username: string;
  password: string;
  /** Replace the password of an existing user instead of leaving it untouched. */
  resetPassword?: boolean;
}

/** Idempotently ensures a user exists. Never changes an existing user unless `resetPassword` is set. */
export async function seedUser(users: UserStore, options: SeedUserOptions): Promise<SeedOutcome> {
  const existing = await users.findByUsername(options.username);
  if (!existing) {
    const passwordHash = await hashPassword(options.password);
    await users.create({ username: options.username, passwordHash, role: 'user' });
    return 'created';
  }
  if (!options.resetPassword) {
    return 'exists';
  }
  await users.updatePasswordHash(options.username, await hashPassword(options.password));
  return 'password-reset';
}

export interface SeedResult {
  username: string;
  outcome: SeedOutcome;
}

/** Seeds the default users with their shared password; seeds nobody when it is unset. */
export async function seedFromConfig(
  users: UserStore,
  { usernames, password }: SeedConfig,
  { resetPassword = false } = {},
): Promise<SeedResult[]> {
  if (!password) {
    return [];
  }
  const results: SeedResult[] = [];
  for (const username of usernames) {
    results.push({ username, outcome: await seedUser(users, { username, password, resetPassword }) });
  }
  return results;
}
