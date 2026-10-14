import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { base32Decode, base32Encode, totpCode, verifyTotp } from '../src/auth/totp.js';
import { MemoryStore } from '../src/store.js';

describe('passwords', () => {
  test('hash and verify', async () => {
    const hash = await hashPassword('correct-horse-battery');
    assert.match(hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('correct-horse-battery', hash), true);
    assert.equal(await verifyPassword('correct-horse-batterY', hash), false);
    assert.notEqual(hash, await hashPassword('correct-horse-battery'), 'salted');
  });

  test('garbage stored hash never verifies', async () => {
    assert.equal(await verifyPassword('x', null), false);
    assert.equal(await verifyPassword('x', 'plain-text'), false);
  });

  test('policy', () => {
    assert.deepEqual(checkPasswordPolicy('correct-horse-battery', 'admin'), []);
    assert.ok(checkPasswordPolicy('short', 'admin').length);
    assert.ok(checkPasswordPolicy('aaaaaaaaaaaaaaaa', 'admin').length);
    assert.ok(checkPasswordPolicy('my-admin-password', 'admin').length);
    assert.ok(checkPasswordPolicy('x'.repeat(300), 'admin').length);
  });
});

describe('totp', () => {
  // RFC 6238 test vectors (SHA-1 secret "12345678901234567890"), last 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  test('matches RFC 6238 vectors', () => {
    for (const [seconds, code] of vectors) assert.equal(totpCode(secret, Math.floor(seconds / 30)), code);
  });

  test('base32 round trip', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 7, 9]);
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  });

  test('accepts ±1 step, rejects others and replays', () => {
    const now = 1234567890 * 1000;
    const step = Math.floor(now / 30000);
    assert.equal(verifyTotp(secret, totpCode(secret, step), { now }), step);
    assert.equal(verifyTotp(secret, totpCode(secret, step - 1), { now }), step - 1);
    assert.equal(verifyTotp(secret, totpCode(secret, step + 1), { now }), step + 1);
    assert.equal(verifyTotp(secret, totpCode(secret, step - 2), { now }), null);
    assert.equal(verifyTotp(secret, totpCode(secret, step), { now, lastUsedStep: step }), null, 'replay');
    assert.equal(verifyTotp(secret, 'abcdef', { now }), null);
    assert.equal(verifyTotp(secret, '', { now }), null);
  });
});

describe('login throttle', () => {
  test('locks a username after 5 failures, across IPs', async () => {
    let now = Date.now();
    const throttle = new LoginThrottle(new MemoryStore(), { now: () => now });
    for (let i = 0; i < 4; i++) assert.equal(await throttle.recordFailure(`10.0.0.${i}`, 'Admin'), false);
    assert.equal(await throttle.lockedUntil('10.0.0.9', 'admin'), null);
    assert.equal(await throttle.recordFailure('10.0.0.5', 'admin'), true);
    assert.ok(await throttle.lockedUntil('10.0.0.9', 'ADMIN'), 'case-insensitive, any IP');
    assert.equal(await throttle.lockedUntil('10.0.0.9', 'someone-else'), null);

    now += 16 * 60_000;
    assert.equal(await throttle.lockedUntil('10.0.0.9', 'admin'), null, 'lock expires');
  });

  test('locks an IP after 20 failures, whatever the usernames', async () => {
    const throttle = new LoginThrottle(new MemoryStore());
    for (let i = 0; i < 20; i++) await throttle.recordFailure('10.1.1.1', `user${i}`);
    assert.ok(await throttle.lockedUntil('10.1.1.1', 'fresh-name'));
    assert.equal(await throttle.lockedUntil('10.1.1.2', 'fresh-name'), null);
  });

  test('failures outside the window start a new count', async () => {
    let now = Date.now();
    const throttle = new LoginThrottle(new MemoryStore(), { now: () => now });
    for (let i = 0; i < 4; i++) await throttle.recordFailure('1.1.1.1', 'admin');
    now += 16 * 60_000;
    assert.equal(await throttle.recordFailure('1.1.1.1', 'admin'), false);
  });

  test('success clears the username counter', async () => {
    const throttle = new LoginThrottle(new MemoryStore());
    for (let i = 0; i < 4; i++) await throttle.recordFailure('1.1.1.1', 'admin');
    await throttle.recordSuccess('admin');
    assert.equal(await throttle.recordFailure('1.1.1.1', 'admin'), false);
  });
});
