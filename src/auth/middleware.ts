import { type NextFunction, type Request, type Response } from 'express';
import { type AuthService } from './authService';
import { type AuthUser } from './types';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

/** Rejects requests without a valid `Authorization: Bearer <jwt>` header with 401; sets `res.locals.user` otherwise. */
export function requireAuth(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = BEARER_PREFIX.exec(req.get('authorization') ?? '');
    if (!match) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const user = auth.verify(match[1].trim());
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    res.locals.user = user;
    next();
  };
}

/** The user set by `requireAuth`; only call on routes behind it. */
export function authenticatedUser(res: Response): AuthUser {
  return res.locals.user as AuthUser;
}
