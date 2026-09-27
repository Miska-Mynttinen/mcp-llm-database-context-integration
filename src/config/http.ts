import { WHOLE_NUMBER } from './settings';

/**
 * Reads TRUST_PROXY (normally from `.env.limits`): the reverse proxies in front of the app whose
 * `X-Forwarded-For` is trusted for the client IP. 0, the default, uses the socket address; leave it
 * at 0 unless a proxy really is in front, or clients can spoof their IP. Throws on bad values.
 */
export function readTrustProxyHopsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TRUST_PROXY?.trim() || '0';
  if (!WHOLE_NUMBER.test(value)) {
    throw new Error(`TRUST_PROXY must be a whole number of proxy hops (got "${value}")`);
  }
  return Number(value);
}
