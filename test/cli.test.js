import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ensureFirstAdmin } from '../src/auth/bootstrap.js';
import { verifyPassword } from '../src/auth/passwords.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { runCli } from '../src/cli.js';
import { MemoryStore } from '../src/store.js';
import { addAdmin } from './helpers.js';

function fakeIo(answers = []) {
  const output = [];
  return { output, out: (line) => output.push(line), prompt: async () => answers.shift() ?? '' };
}

const silentLog = { info() {}, warn() {} };

describe('first admin bootstrap', () => {
  test('creates the first admin from the environment', async () => {
    const store = new MemoryStore();
    await ensureFirstAdmin(store, { adminUser: 'greg', adminPassword: 'a-long-first-pass' }, silentLog);
    const admin = await store.getAdminByUsername('greg');
    assert.ok(await verifyPassword('a-long-first-pass', admin.passwordHash));
  });

  test('does nothing once an admin exists', async () => {
    const store = new MemoryStore();
    await addAdmin(store, 'admin');
    await ensureFirstAdmin(store, { adminUser: 'other', adminPassword: 'a-long-first-pass' }, silentLog);
    assert.equal(await store.countAdmins(), 1);
  });

  test('refuses to start without an admin or with a weak password', async () => {
    await assert.rejects(ensureFirstAdmin(new MemoryStore(), { adminUser: 'admin' }, silentLog), /No admin account exists/);
    await assert.rejects(ensureFirstAdmin(new MemoryStore(), { adminUser: 'admin', adminPassword: 'short' }, silentLog), /not acceptable/);
  });
});

describe('cli', () => {
  test('create-admin and list-admins', async () => {
    const store = new MemoryStore();
    const io = fakeIo(['kot-w-butach-42', 'kot-w-butach-42']);
    assert.equal(await runCli(['create-admin', 'Greg'], { store, io }), 0);
    assert.ok(await store.getAdminByUsername('greg'));
    await runCli(['list-admins'], { store, io });
    assert.match(io.output.at(-1), /^greg\t2FA off/);
  });

  test('create-admin rejects mismatched or weak passwords', async () => {
    const store = new MemoryStore();
    await assert.rejects(runCli(['create-admin', 'greg'], { store, io: fakeIo(['kot-w-butach-42', 'other-password']) }), /do not match/);
    await assert.rejects(runCli(['create-admin', 'greg'], { store, io: fakeIo(['short', 'short']) }), /at least 12/);
    await assert.rejects(runCli(['create-admin', 'bad name'], { store, io: fakeIo() }), /Invalid username/);
  });

  test('reset-password signs out sessions and clears the lockout', async () => {
    const store = new MemoryStore();
    const admin = await addAdmin(store, 'admin');
    await store.createSession({ _id: 's1', adminId: admin._id, stage: 'full', expiresAt: new Date(Date.now() + 60_000) });
    const throttle = new LoginThrottle(store);
    for (let i = 0; i < 5; i++) await throttle.recordFailure('1.1.1.1', 'admin');

    await runCli(['reset-password', 'admin'], { store, io: fakeIo(['brand-new-pass-1', 'brand-new-pass-1']) });
    assert.ok(await verifyPassword('brand-new-pass-1', (await store.getAdmin(admin._id)).passwordHash));
    assert.equal(store.sessions.size, 0);
    assert.equal(await throttle.lockedUntil('2.2.2.2', 'admin'), null);
  });

  test('disable-2fa and unknown users', async () => {
    const store = new MemoryStore();
    const admin = await addAdmin(store, 'admin');
    await store.updateAdmin(admin._id, { totpSecret: 'JBSWY3DPEHPK3PXP' });
    await runCli(['disable-2fa', 'admin'], { store, io: fakeIo() });
    assert.equal((await store.getAdmin(admin._id)).totpSecret, null);
    await assert.rejects(runCli(['disable-2fa', 'ghost'], { store, io: fakeIo() }), /No admin named "ghost"/);
  });

  test('unknown command prints usage and fails', async () => {
    const io = fakeIo();
    assert.equal(await runCli(['frobnicate'], { store: new MemoryStore(), io }), 2);
    assert.match(io.output[0], /^Usage/);
  });
});
