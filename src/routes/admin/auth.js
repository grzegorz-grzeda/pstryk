import { fakeVerify, verifyPassword } from '../../auth/passwords.js';
import { verifyTotp } from '../../auth/totp.js';
import { loginPage, mfaPage } from '../../views/auth.js';
import { field, passwordField } from './util.js';

const MAX_MFA_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

const GENERIC_FAILURE = 'Invalid username or password.';
const LOCKED = 'Too many failed sign-in attempts. Try again later.';

// Messages that can be shown on the sign-in page via ?m=… (fixed text, never reflected input).
const NOTICES = {
  'signed-out': { info: 'You have been signed out.' },
  expired: { error: 'Your session has expired. Please sign in again.' },
  'mfa-failed': { error: 'Too many wrong codes. Please sign in again.' },
};

export default async function authRoutes(app, { store, sessions, throttle, audit, render, checkCsrf }) {
  async function completeSignIn(request, reply, admin, session) {
    await throttle.recordSuccess(admin.username);
    await store.updateAdmin(admin._id, {
      lastLoginAt: new Date(),
      lastLoginIp: request.ip,
      previousLoginAt: admin.lastLoginAt,
      previousLoginIp: admin.lastLoginIp,
    });
    request.admin = admin;
    request.session = session;
    await audit(request, 'login.success', admin.totpSecret ? { method: 'password + 2FA' } : { method: 'password' });
    return reply.redirect('/admin');
  }

  const showLogin = (request, reply, { status = 200, flash, username } = {}) =>
    render(request, reply, { title: 'Sign in', status, flash }, loginPage({ username }));

  app.get('/login', async (request, reply) => {
    const session = await sessions.load(request);
    if (session?.stage === 'full') return reply.redirect('/admin');
    if (session?.stage === 'mfa') return reply.redirect('/admin/login/2fa');
    return showLogin(request, reply, { flash: NOTICES[request.query.m] });
  });

  app.post('/login', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const username = field(request.body, 'username', 64).toLowerCase();
    const password = passwordField(request.body, 'password');
    if (!username || !password) return showLogin(request, reply, { status: 400, flash: { error: GENERIC_FAILURE }, username });

    if (await throttle.lockedUntil(request.ip, username)) {
      await fakeVerify(password);
      await audit(request, 'login.locked', { username }, null);
      return showLogin(request, reply, { status: 429, flash: { error: LOCKED }, username });
    }

    const admin = await store.getAdminByUsername(username);
    const ok = admin ? await verifyPassword(password, admin.passwordHash) : await fakeVerify(password);
    if (!ok) {
      const locked = await throttle.recordFailure(request.ip, username);
      await audit(request, 'login.failure', { username }, null);
      return showLogin(request, reply, { status: 401, flash: { error: locked ? LOCKED : GENERIC_FAILURE }, username });
    }

    // Never reuse a session that existed before sign-in (session fixation).
    const previous = await sessions.load(request);
    if (previous) await store.deleteSession(previous._id);

    const meta = { adminId: admin._id, ip: request.ip, userAgent: request.headers['user-agent'] };
    if (admin.totpSecret) {
      await sessions.create(reply, { ...meta, stage: 'mfa' });
      return reply.redirect('/admin/login/2fa');
    }
    const session = await sessions.create(reply, { ...meta, stage: 'full' });
    return completeSignIn(request, reply, admin, session);
  });

  app.get('/login/2fa', async (request, reply) => {
    const session = await sessions.load(request);
    if (session?.stage !== 'mfa') return reply.redirect('/admin/login');
    request.session = session;
    return render(request, reply, { title: 'Two-factor authentication' }, mfaPage({ csrf: session.csrf }));
  });

  app.post('/login/2fa', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
    const session = await sessions.load(request);
    if (session?.stage !== 'mfa') return reply.redirect('/admin/login?m=expired');
    if (!checkCsrf(request, session)) return reply.code(403).type('text/plain').send('Invalid CSRF token');
    request.session = session;

    const admin = await store.getAdmin(session.adminId);
    if (!admin?.totpSecret || (await throttle.lockedUntil(request.ip, admin.username))) {
      await sessions.destroy(reply, session);
      return showLogin(request, reply, { status: 429, flash: { error: LOCKED } });
    }

    const step = verifyTotp(admin.totpSecret, field(request.body, 'code', 10), { lastUsedStep: admin.totpLastStep ?? -1 });
    if (step === null) {
      const attempts = session.mfaAttempts + 1;
      await throttle.recordFailure(request.ip, admin.username);
      await audit(request, 'login.mfa_failure', { username: admin.username, attempt: attempts }, null);
      if (attempts >= MAX_MFA_ATTEMPTS) {
        await sessions.destroy(reply, session);
        return reply.redirect('/admin/login?m=mfa-failed');
      }
      await sessions.update(session, { mfaAttempts: attempts });
      return render(request, reply, { title: 'Two-factor authentication', status: 401, flash: { error: 'Wrong code. Try again.' } }, mfaPage({ csrf: session.csrf }));
    }

    // Remember the step so the same code can't be used twice.
    await store.updateAdmin(admin._id, { totpLastStep: step });
    const full = await sessions.promote(reply, session, { ip: request.ip, userAgent: request.headers['user-agent'] });
    return completeSignIn(request, reply, admin, full);
  });

  app.post('/logout', async (request, reply) => {
    const session = await sessions.load(request);
    if (session && !checkCsrf(request, session)) return reply.code(403).type('text/plain').send('Invalid CSRF token');
    if (session) {
      if (session.stage === 'full') {
        const admin = await store.getAdmin(session.adminId);
        await audit(request, 'logout', {}, admin?.username ?? null);
      }
      await sessions.destroy(reply, session);
    }
    return reply.redirect('/admin/login?m=signed-out');
  });
}
