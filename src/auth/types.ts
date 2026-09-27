// Kept as a column and token claim so roles can be added later; today every account is a `user`.
export const USER_ROLES = ['user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(value as UserRole);
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

/** The identity carried in a verified token; never includes the password hash. */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface UserStore {
  findByUsername(username: string): Promise<User | undefined>;
  create(user: Omit<User, 'id' | 'createdAt'>): Promise<User>;
  updatePasswordHash(username: string, passwordHash: string): Promise<void>;
}
