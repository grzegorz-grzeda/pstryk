// End-to-end tests of the admin area: sign-in, lockouts, sessions, CSRF, 2FA, account and user management.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { currentStep, totpCode } from '../src/auth/totp.js';
import { MemoryStore } from '../src/store.js';
import { ADMIN_PASSWORD, addAdmin, Browser, createApp, fakePublisher } from './helpers.js';

let store, publisher, app, browser;

beforeEach(async () => {
  store = new MemoryStore();
  publisher = fakePublisher();
  app = await createApp({ store, publisher });
  await addAdmin(store);
  browser = new Browser(app);
});

const auditActions = async () => (await store.listAudit()).map((e) => e.action);

describe('sign-in', () => {
  test('admin pages redirect to the sign-in page', async () => {
    for (const url of ['/admin', '/admin/users', '/admin/account', '/admin/audit']) {
      const res = await browser.get(url);
      assert.equal(res.statusCode, 302, url);
      assert.equal(res.headers.location, '/admin/login');
    }
    const post = await browser.post('/admin/hooks', { name: 'x' });
    assert.equal(post.statusCode, 401);
  });

  test('valid credentials create a hardened session cookie', async () => {
    const res = await browser.login();
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/admin');
    const cookie = res.cookies.find((c) => c.name === 'pstryk_session');
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.path, '/');
    assert.ok(cookie.value.length >= 43);

    const page = await browser.get('/admin');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Sign out/);
    assert.deepEqual(await auditActions(), ['login.success']);
    assert.ok((await store.getAdminByUsername('admin')).lastLoginAt);
  });

  test('session ID is stored only as a hash', async () => {
    await browser.login();
    const sid = browser.cookies.get('pstryk_session');
    assert.equal(store.sessions.has(sid), false);
    assert.equal(store.sessions.size, 1);
  });

  test('secure deployments use a __Host- cookie with Secure', async () => {
    const secureApp = await createApp({ store, config: { cookieSecure: true } });
    const res = await new Browser(secureApp).login();
    const cookie = res.cookies.find((c) => c.name === '__Host-pstryk_session');
    assert.ok(cookie?.secure);
  });

  test('wrong password and unknown user give the same answer', async () => {
    const wrong = await browser.login('admin', 'not-the-password');
    const unknown = await new Browser(app).login('nobody', 'not-the-password');
    for (const res of [wrong, unknown]) {
      assert.equal(res.statusCode, 401);
      assert.match(res.body, /Invalid username or password/);
      assert.equal(res.cookies.length, 0);
    }
    assert.deepEqual(await auditActions(), ['login.failure', 'login.failure']);
  });

  test('username is case-insensitive', async () => {
    const res = await browser.login('ADMIN', ADMIN_PASSWORD);
    assert.equal(res.headers.location, '/admin');
  });

  test('account locks after 5 failures, even with the right password', async () => {
    for (let i = 0; i < 4; i++) assert.equal((await browser.login('admin', `wrong-${i}`)).statusCode, 401);
    const fifth = await browser.login('admin', 'wrong-5');
    assert.match(fifth.body, /Too many failed sign-in attempts/);

    const other = new Browser(app, { ip: '10.9.9.9' });
    const correct = await other.login();
    assert.equal(correct.statusCode, 429);
    assert.equal(correct.cookies.length, 0);
    assert.ok((await auditActions()).includes('login.locked'));
  });

  test('sign-in form is rate-limited per IP', async () => {
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await browser.post('/admin/login', { username: `u${i}`, password: 'x'.repeat(12) })).statusCode);
    }
    assert.equal(codes.at(-1), 429);
  });

  test('sign-out ends the session server-side', async () => {
    await browser.login();
    await browser.get('/admin');
    const sid = browser.cookies.get('pstryk_session');
    const res = await browser.post('/admin/logout');
    assert.equal(res.headers.location, '/admin/login?m=signed-out');
    assert.equal(store.sessions.size, 0);

    // Replaying the old cookie doesn't work.
    browser.cookies.set('pstryk_session', sid);
    assert.equal((await browser.get('/admin')).statusCode, 302);
  });

  test('sign-out requires the CSRF token', async () => {
    await browser.login();
    await browser.get('/admin');
    const res = await browser.post('/admin/logout', { _csrf: 'nope' });
    assert.equal(res.statusCode, 403);
    assert.equal(store.sessions.size, 1);
  });

  test('idle and absolute timeouts end the session', async () => {
    await browser.login();
    const [session] = store.sessions.values();
    session.expiresAt = new Date(Date.now() - 1000);
    const res = await browser.get('/admin');
    assert.equal(res.headers.location, '/admin/login?m=expired');
    assert.equal(store.sessions.size, 0);
  });

  test('sign-in page messages are fixed text, not reflected input', async () => {
    const res = await browser.get('/admin/login?m=<script>alert(1)</script>');
    assert.doesNotMatch(res.body, /<script>alert/);
    const ok = await browser.get('/admin/login?m=signed-out');
    assert.match(ok.body, /You have been signed out/);
  });
});

describe('protection', () => {
  beforeEach(async () => {
    await browser.login();
    await browser.get('/admin');
  });

  test('POST without a valid CSRF token is refused', async () => {
    assert.equal((await browser.post('/admin/hooks', { name: 'x', _csrf: '' })).statusCode, 403);
    assert.equal((await browser.post('/admin/hooks', { name: 'x', _csrf: 'forged' })).statusCode, 403);
    assert.equal((await store.listHooks()).length, 0);
    assert.equal((await browser.post('/admin/hooks', { name: 'x' })).statusCode, 302);
  });

  test('cross-site POST is refused before anything else', async () => {
    const res = await browser.post('/admin/hooks', { name: 'x' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(res.statusCode, 403);
  });

  test('same-origin browser posts are accepted, whatever Origin looks like', async () => {
    const sameOrigin = [
      { origin: 'http://localhost:80', 'sec-fetch-site': 'same-origin' },
      { origin: 'null', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'same-origin' },
      {},
    ];
    for (const [i, headers] of sameOrigin.entries()) {
      const res = await browser.post('/admin/hooks', { name: `ok-${i}` }, headers);
      assert.equal(res.statusCode, 302, JSON.stringify(headers));
    }
    const crossSite = [
      { origin: 'null' },
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'not a url' },
    ];
    for (const headers of crossSite) {
      const res = await browser.post('/admin/hooks', { name: 'blocked' }, headers);
      assert.equal(res.statusCode, 403, JSON.stringify(headers));
    }
  });

  test('security headers on every admin response', async () => {
    for (const url of ['/admin', '/admin/login', '/admin/static/admin.css']) {
      const res = await browser.get(url);
      assert.match(res.headers['content-security-policy'], /default-src 'none'.*frame-ancestors 'none'/, url);
      assert.equal(res.headers['cache-control'], 'no-store', url);
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.equal(res.headers['referrer-policy'], 'same-origin', url);
    }
  });

  test('pages contain no inline scripts or styles (CSP compatible)', async () => {
    await browser.post('/admin/hooks', { name: 'lights' });
    const hook = await store.getHookByName('lights');
    for (const url of ['/admin', `/admin/hooks/${hook._id}`, '/admin/account', '/admin/users', '/admin/audit', '/admin/login']) {
      const { body } = await browser.get(url);
      assert.doesNotMatch(body, /<script>|<style>|style="|onsubmit=|onclick=/, url);
    }
  });

  test('static assets are whitelisted', async () => {
    assert.equal((await browser.get('/admin/static/admin.js')).statusCode, 200);
    assert.equal((await browser.get('/admin/static/..%2fserver.js')).statusCode, 404);
    assert.equal((await browser.get('/admin/static/nope.css')).statusCode, 404);
  });
});

describe('hooks UI', () => {
  test('full flow is audited', async () => {
    await browser.login();
    await browser.get('/admin');
    await browser.post('/admin/hooks', { name: 'garage', description: 'Door' });
    const hook = await store.getHookByName('garage');
    await browser.get(`/admin/hooks/${hook._id}`);
    await browser.post(`/admin/hooks/${hook._id}/actions`, { topic: 'garage/cmd', payload: 'open', qos: '1' });
    const tokenPage = await browser.post(`/admin/hooks/${hook._id}/tokens`, { label: 'phone' });
    assert.match(tokenPage.body, /pstk_[A-Za-z0-9_-]{43}/);
    const tokenId = (await store.getHook(hook._id)).tokens[0].id;
    const test = await browser.post(`/admin/hooks/${hook._id}/test`, { body: '{}' });
    assert.match(test.body, /Published 1 message/);
    assert.deepEqual(publisher.published, [{ topic: 'garage/cmd', payload: 'open', qos: 1, retain: false }]);
    await browser.post(`/admin/hooks/${hook._id}/tokens/${tokenId}/delete`);
    await browser.post(`/admin/hooks/${hook._id}/delete`);

    assert.deepEqual((await auditActions()).reverse(), [
      'login.success', 'hook.create', 'action.add', 'token.create', 'hook.test', 'token.revoke', 'hook.delete',
    ]);
    const audit = await browser.get('/admin/audit');
    assert.match(audit.body, /Created token/);
  });

  test('flash messages show once', async () => {
    await browser.login();
    await browser.get('/admin');
    await browser.post('/admin/hooks', { name: 'Bad Name!' });
    assert.match((await browser.get('/admin')).body, /Invalid name/);
    assert.doesNotMatch((await browser.get('/admin')).body, /Invalid name/);
  });
});

describe('account', () => {
  beforeEach(async () => {
    await browser.login();
    await browser.get('/admin/account');
  });

  test('password change needs the current password and signs out other sessions', async () => {
    const other = new Browser(app, { ip: '10.2.2.2' });
    await other.login();
    assert.equal(store.sessions.size, 2);

    await browser.post('/admin/account/password', { currentPassword: 'wrong-password', newPassword: 'another-good-pass', confirmPassword: 'another-good-pass' });
    assert.match((await browser.get('/admin/account')).body, /Current password is incorrect/);

    await browser.post('/admin/account/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'another-good-pass', confirmPassword: 'different-pass-x' });
    assert.match((await browser.get('/admin/account')).body, /do not match/);

    await browser.post('/admin/account/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'another-good-pass', confirmPassword: 'another-good-pass' });
    assert.match((await browser.get('/admin/account')).body, /Password changed/);
    assert.equal(store.sessions.size, 1);
    assert.equal((await other.get('/admin')).statusCode, 302, 'other session ended');

    assert.equal((await new Browser(app).login('admin', ADMIN_PASSWORD)).statusCode, 401);
    assert.equal((await new Browser(app).login('admin', 'another-good-pass')).statusCode, 302);
  });

  test('re-authentication failures count towards the lockout', async () => {
    for (let i = 0; i < 5; i++) {
      await browser.post('/admin/account/password', { currentPassword: `wrong-${i}`, newPassword: 'another-good-pass', confirmPassword: 'another-good-pass' });
    }
    await browser.post('/admin/account/password', { currentPassword: ADMIN_PASSWORD, newPassword: 'another-good-pass', confirmPassword: 'another-good-pass' });
    assert.match((await browser.get('/admin/account')).body, /Too many failed attempts/);
  });

  test('sessions can be listed and revoked', async () => {
    const other = new Browser(app, { ip: '10.3.3.3' });
    await other.login();
    const page = await browser.get('/admin/account');
    assert.match(page.body, /10\.3\.3\.3/);
    const ref = /sessions\/([A-Za-z0-9_-]+)\/revoke/.exec(page.body)[1];
    await browser.post(`/admin/account/sessions/${ref}/revoke`);
    assert.equal((await other.get('/admin')).statusCode, 302);
    assert.equal((await browser.get('/admin')).statusCode, 200);
  });
});

describe('two-factor authentication', () => {
  async function enable2fa() {
    await browser.login();
    await browser.get('/admin/account');
    await browser.post('/admin/account/2fa/start');
    const page = await browser.get('/admin/account');
    assert.match(page.body, /<img class="qr" src="data:image\/png;base64,/);
    const secret = /id="totp-secret">([A-Z2-7]+)</.exec(page.body)[1];
    const res = await browser.post('/admin/account/2fa/confirm', { password: ADMIN_PASSWORD, code: totpCode(secret, currentStep()) });
    assert.equal(res.statusCode, 302);
    assert.match((await browser.get('/admin/account')).body, /Two-factor authentication is on/);
    return secret;
  }

  test('enrolment needs a valid code', async () => {
    await browser.login();
    await browser.get('/admin/account');
    await browser.post('/admin/account/2fa/start');
    await browser.get('/admin/account');
    await browser.post('/admin/account/2fa/confirm', { password: ADMIN_PASSWORD, code: '000000' });
    assert.match((await browser.get('/admin/account')).body, /not valid/);
    assert.equal((await store.getAdminByUsername('admin')).totpSecret, null);
  });

  test('sign-in then asks for a code; the half-signed-in session has no access', async () => {
    const secret = await enable2fa();
    const b = new Browser(app, { ip: '10.4.4.4' });
    const res = await b.login();
    assert.equal(res.headers.location, '/admin/login/2fa');
    assert.equal((await b.get('/admin')).statusCode, 302, 'no access before the code');

    await b.get('/admin/login/2fa');
    const wrong = await b.post('/admin/login/2fa', { code: '123456' });
    assert.equal(wrong.statusCode, 401);

    // The code used during enrolment can't be replayed; use the next one.
    const ok = await b.post('/admin/login/2fa', { code: totpCode(secret, currentStep() + 1) });
    assert.equal(ok.headers.location, '/admin');
    assert.equal((await b.get('/admin')).statusCode, 200);
    assert.ok((await auditActions()).includes('login.mfa_failure'));
  });

  test('a code cannot be used twice', async () => {
    const secret = await enable2fa();
    const code = totpCode(secret, currentStep() + 1);
    const first = new Browser(app, { ip: '10.5.5.5' });
    await first.login();
    await first.get('/admin/login/2fa');
    assert.equal((await first.post('/admin/login/2fa', { code })).headers.location, '/admin');

    const second = new Browser(app, { ip: '10.5.5.6' });
    await second.login();
    await second.get('/admin/login/2fa');
    assert.equal((await second.post('/admin/login/2fa', { code })).statusCode, 401);
  });

  test('five wrong codes end the attempt', async () => {
    await enable2fa();
    const b = new Browser(app, { ip: '10.6.6.6' });
    await b.login();
    await b.get('/admin/login/2fa');
    let res;
    for (let i = 0; i < 5; i++) res = await b.post('/admin/login/2fa', { code: '000000' });
    assert.equal(res.headers.location, '/admin/login?m=mfa-failed');
    assert.equal((await b.get('/admin/login/2fa')).headers.location, '/admin/login');
  });

  test('turning 2FA off needs password and code', async () => {
    const secret = await enable2fa();
    await browser.post('/admin/account/2fa/disable', { password: ADMIN_PASSWORD, code: '000000' });
    assert.ok((await store.getAdminByUsername('admin')).totpSecret);
    await browser.get('/admin/account');
    await browser.post('/admin/account/2fa/disable', { password: ADMIN_PASSWORD, code: totpCode(secret, currentStep() + 1) });
    assert.equal((await store.getAdminByUsername('admin')).totpSecret, null);
  });
});

describe('user management', () => {
  beforeEach(async () => {
    await browser.login();
    await browser.get('/admin/users');
  });

  test('add an admin (needs your password and a good password)', async () => {
    await browser.post('/admin/users', { username: 'ola', newPassword: 'kot-w-butach-42', currentPassword: 'wrong-password' });
    assert.equal(await store.getAdminByUsername('ola'), null);

    await browser.post('/admin/users', { username: 'ola', newPassword: 'short', currentPassword: ADMIN_PASSWORD });
    assert.equal(await store.getAdminByUsername('ola'), null);

    await browser.post('/admin/users', { username: 'Ola', newPassword: 'kot-w-butach-42', currentPassword: ADMIN_PASSWORD });
    assert.ok(await store.getAdminByUsername('ola'));
    assert.equal((await new Browser(app, { ip: '10.7.7.7' }).login('ola', 'kot-w-butach-42')).headers.location, '/admin');
  });

  test('deleting an admin ends their sessions; you cannot delete yourself', async () => {
    const ola = await addAdmin(store, 'ola', 'kot-w-butach-42');
    const olaBrowser = new Browser(app, { ip: '10.8.8.8' });
    await olaBrowser.login('ola', 'kot-w-butach-42');

    const me = await store.getAdminByUsername('admin');
    await browser.post(`/admin/users/${me._id}/delete`);
    assert.ok(await store.getAdmin(me._id));

    await browser.get('/admin/users');
    await browser.post(`/admin/users/${ola._id}/delete`);
    assert.equal(await store.getAdmin(ola._id), null);
    assert.equal((await olaBrowser.get('/admin')).statusCode, 302);
  });
});
