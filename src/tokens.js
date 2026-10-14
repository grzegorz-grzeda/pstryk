import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'pstk_';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a new random token. The plain token is shown once; only the hash is stored. */
export function generateToken() {
  const token = PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), hint: token.slice(0, PREFIX.length + 4) };
}

/** Finds the stored token matching the presented one. Compares against every entry in constant time. */
export function matchToken(storedTokens, presented) {
  if (typeof presented !== 'string' || !presented) return null;
  const candidate = Buffer.from(hashToken(presented), 'hex');
  let match = null;
  for (const entry of storedTokens ?? []) {
    const stored = Buffer.from(entry.hash, 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = entry;
  }
  return match;
}
