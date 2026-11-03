import { createHash, randomBytes } from 'node:crypto';

// Throws an error whose status the HTTP layer returns to the caller.
export const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
// 32 random bytes as base64url: the shape of every credential, ticket and session the gateway issues.
export const randomSecret = () => randomBytes(32).toString('base64url');
export const isToken43 = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const DAY = 86400000;
// Retry delay in milliseconds for the given attempt number (from 1): a minute, doubling, capped at an hour.
export const backoff = attempts => Math.min(3600000, 60000 * 2 ** (attempts - 1));
export const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
