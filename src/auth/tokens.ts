import jwt, { type SignOptions } from 'jsonwebtoken';
import { type AuthUser, isUserRole } from './types';

const ALGORITHM = 'HS256';

export interface TokenServiceConfig {
  secret: string;
  /** A `jsonwebtoken` duration such as `8h` or `30m`. */
  expiresIn: string;
}

export interface TokenService {
  sign(user: AuthUser): string;
  /** Returns the token's user, or `null` when it is malformed, forged, or expired. */
  verify(token: string): AuthUser | null;
}

export function createTokenService({ secret, expiresIn }: TokenServiceConfig): TokenService {
  return {
    sign(user) {
      return jwt.sign({ username: user.username, role: user.role }, secret, {
        algorithm: ALGORITHM,
        subject: user.id,
        expiresIn: expiresIn as SignOptions['expiresIn'],
      });
    },
    verify(token) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
        return toAuthUser(payload);
      } catch {
        return null;
      }
    },
  };
}

function toAuthUser(payload: string | jwt.JwtPayload): AuthUser | null {
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.username !== 'string') {
    return null;
  }
  if (!isUserRole(payload.role)) {
    return null;
  }
  return { id: payload.sub, username: payload.username, role: payload.role };
}
