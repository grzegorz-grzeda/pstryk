// Time-based one-time passwords (RFC 6238): 6 digits, 30 s steps, HMAC-SHA1.
// This is what Google Authenticator, Aegis, 1Password, Bitwarden etc. expect.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Checks a code against the previous, current and next step (to tolerate clock drift).
 * Returns the matched step, or null. Steps at or before `lastUsedStep` are rejected so a
 * code can't be replayed.
 */
export function verifyTotp(secret, code, { lastUsedStep = -1, now = Date.now() } = {}) {
  const presented = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(presented)) return null;
  const step = currentStep(now);
  let matched = null;
  for (const candidate of [step - 1, step, step + 1]) {
    const ok = timingSafeEqual(Buffer.from(totpCode(secret, candidate)), Buffer.from(presented));
    if (ok && candidate > lastUsedStep) matched = candidate;
  }
  return matched;
}

export function otpauthUrl(secret, account, issuer = 'Pstryk') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
