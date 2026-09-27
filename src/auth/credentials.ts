export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
export const USERNAME_RULES = '3–64 characters: letters, digits, dot, dash or underscore';

/** A username or password that doesn't meet the rules for new accounts; the message is safe to show users. */
export class InvalidCredentialsError extends Error {}

/** Validates credentials for a new account (sign-up and seeding). Login does not use this. */
export function validateNewCredentials(username: string, password: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidCredentialsError(`Username must be ${USERNAME_RULES}`);
  }
  validatePassword(password, 'Password');
}

export function validatePassword(password: string, label: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new InvalidCredentialsError(`${label} must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters`);
  }
}
