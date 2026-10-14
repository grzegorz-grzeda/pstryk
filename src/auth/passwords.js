// Password hashing with scrypt (memory-hard, built into Node).
// Stored format: scrypt$N$r$p$<salt base64>$<key base64>

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const maxmem = (N, r) => 256 * N * r;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const normalize = (password) => String(password).normalize('NFKC');

export async function hashPassword(password) {
  const { N, r, p } = PARAMS;
  const salt = randomBytes(16);
  const key = await scrypt(normalize(password), salt, KEY_LENGTH, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Used when the username doesn't exist, so the response takes as long as a real check.
let dummyHash;
async function getDummyHash() {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await verifyPassword(password, await getDummyHash());
    return false;
  }
  const [, n, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const actual = await scrypt(normalize(password), Buffer.from(salt, 'base64'), expected.length, {
    ...params,
    maxmem: maxmem(params.N, params.r),
  });
  return timingSafeEqual(actual, expected);
}

/** Burns the same time as a real verification. */
export async function fakeVerify(password) {
  await verifyPassword(password, await getDummyHash());
  return false;
}

export function checkPasswordPolicy(password, username) {
  const problems = [];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  } else {
    if (password.length > MAX_PASSWORD_LENGTH) problems.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push('Password must not contain the username');
    if (new Set(password).size < 5) problems.push('Password is too repetitive');
  }
  return problems;
}
