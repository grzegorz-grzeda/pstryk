import QRCode from 'qrcode';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../../auth/passwords.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../auth/totp.js';
import { accountPage } from '../../views/account.js';
import { confirmPassword, field, passwordField } from './util.js';

export default async function accountRoutes(app, ctx) {
  const { store, sessions, audit, render, redirectWith } = ctx;
  const back = (request, reply, flash) => redirectWith(request, reply, '/admin/account', flash);

  app.get('/account', async (request, reply) => {
    const { admin, session } = request;
    const pending = !admin.totpSecret && session.pendingTotpSecret;
    const enrollment = pending
      ? { secret: pending, qr: await QRCode.toDataURL(otpauthUrl(pending, admin.username), { margin: 1, width: 200 }) }
      : null;
    const list = await store.listSessions(admin._id);
    return render(
      request,
      reply,
      { title: 'Account', active: 'account' },
      accountPage({ admin, csrf: session.csrf, sessions: list, currentSessionId: session._id, enrollment }),
    );
  });

  app.post('/account/password', async (request, reply) => {
    const { admin, session } = request;
    const error = await confirmPassword(ctx, request, passwordField(request.body, 'currentPassword'));
    if (error) return back(request, reply, { error });

    const next = passwordField(request.body, 'newPassword');
    if (next !== passwordField(request.body, 'confirmPassword')) return back(request, reply, { error: 'The new passwords do not match' });
    const problems = checkPasswordPolicy(next, admin.username);
    if (problems.length) return back(request, reply, { error: problems.join('. ') });
    if (await verifyPassword(next, admin.passwordHash)) return back(request, reply, { error: 'The new password must be different' });

    await store.updateAdmin(admin._id, { passwordHash: await hashPassword(next), passwordChangedAt: new Date() });
    await store.deleteSessions(admin._id, { except: session._id });
    await audit(request, 'password.change');
    return back(request, reply, { info: 'Password changed. Your other sessions have been signed out.' });
  });

  app.post('/account/2fa/start', async (request, reply) => {
    if (request.admin.totpSecret) return back(request, reply, { error: '2FA is already on' });
    // The secret lives only in this session until it is confirmed with a valid code.
    await sessions.update(request.session, { pendingTotpSecret: generateTotpSecret() });
    return reply.redirect('/admin/account');
  });

  app.post('/account/2fa/confirm', async (request, reply) => {
    const { admin, session } = request;
    const secret = session.pendingTotpSecret;
    if (admin.totpSecret || !secret) return back(request, reply, { error: 'Start 2FA setup first' });

    const error = await confirmPassword(ctx, request, passwordField(request.body, 'password'));
    if (error) return back(request, reply, { error });
    const step = verifyTotp(secret, field(request.body, 'code', 10));
    if (step === null) return back(request, reply, { error: 'That code is not valid. Check the time on your phone and try again.' });

    await store.updateAdmin(admin._id, { totpSecret: secret, totpLastStep: step });
    await sessions.update(session, { pendingTotpSecret: null });
    await store.deleteSessions(admin._id, { except: session._id });
    await audit(request, '2fa.enable');
    return back(request, reply, { info: 'Two-factor authentication is on. Your other sessions have been signed out.' });
  });

  app.post('/account/2fa/disable', async (request, reply) => {
    const { admin } = request;
    if (!admin.totpSecret) return back(request, reply, { error: '2FA is not on' });

    const error = await confirmPassword(ctx, request, passwordField(request.body, 'password'));
    if (error) return back(request, reply, { error });
    const step = verifyTotp(admin.totpSecret, field(request.body, 'code', 10), { lastUsedStep: admin.totpLastStep ?? -1 });
    if (step === null) return back(request, reply, { error: 'That code is not valid' });

    await store.updateAdmin(admin._id, { totpSecret: null, totpLastStep: -1 });
    await audit(request, '2fa.disable');
    return back(request, reply, { info: 'Two-factor authentication is off.' });
  });

  app.post('/account/sessions/:ref/revoke', async (request, reply) => {
    const { admin, session } = request;
    const target = (await store.listSessions(admin._id)).find((s) => s.ref === request.params.ref);
    if (target && target._id !== session._id) {
      await store.deleteSession(target._id);
      await audit(request, 'session.revoke', { ip: target.ip });
    }
    return back(request, reply, { info: 'Session signed out.' });
  });

  app.post('/account/sessions/revoke-others', async (request, reply) => {
    await store.deleteSessions(request.admin._id, { except: request.session._id });
    await audit(request, 'session.revoke_others');
    return back(request, reply, { info: 'All other sessions have been signed out.' });
  });
}
