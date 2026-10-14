// The /admin area: security headers, static assets, rate limiting, CSRF protection and
// the session gate in front of every page except the sign-in pages.

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Sessions } from '../../auth/sessions.js';
import { LoginThrottle } from '../../auth/throttle.js';
import { layout } from '../../views/layout.js';
import accountRoutes from './account.js';
import auditRoutes from './audit.js';
import authRoutes from './auth.js';
import dashboardRoutes from './dashboard.js';
import hookRoutes from './hooks.js';
import userRoutes from './users.js';

const STATIC = {
  'admin.css': { type: 'text/css; charset=utf-8', body: readFileSync(new URL('../../static/admin.css', import.meta.url)) },
  'admin.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('../../static/admin.js', import.meta.url)) },
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  // same-origin, not no-referrer: no-referrer makes browsers send `Origin: null` on our own form posts.
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async function adminArea(app, { store, publisher, config }) {
  await app.register(cookie);
  // A generous ceiling for the whole admin area; sign-in routes set much lower limits.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  const sessions = new Sessions(store, {
    idleMs: config.sessionIdleMinutes * 60_000,
    maxMs: config.sessionMaxHours * 3_600_000,
    secure: config.cookieSecure,
  });
  const throttle = new LoginThrottle(store);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });

  // Reject cross-site POSTs outright, before any session or CSRF token is looked at.
  // Browsers send Sec-Fetch-Site and/or Origin; either one saying "not us" is enough to refuse.
  // `Origin: null` (privacy modes, some redirects) only passes if Sec-Fetch-Site vouches for it.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const site = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    let allowed = !site || site === 'same-origin' || site === 'none';
    if (allowed && origin) {
      if (origin === 'null') {
        allowed = site === 'same-origin';
      } else {
        try {
          // Compare via URL so default ports (":80", ":443") normalise the same way on both sides.
          allowed = new URL(origin).host === new URL(`${request.protocol}://${request.host}`).host;
        } catch {
          allowed = false;
        }
      }
    }
    if (!allowed) return reply.code(403).type('text/plain').send('Cross-site request blocked');
  });

  app.get('/static/:file', async (request, reply) => {
    const asset = STATIC[request.params.file];
    if (!asset) return reply.code(404).send('Not found');
    return reply.type(asset.type).send(asset.body);
  });

  const audit = (request, action, detail = {}, actor = request.admin?.username ?? null) =>
    store.logAudit({ action, actor, ip: request.ip, detail });

  /** Renders a page, consuming any flash message stored in the session. */
  async function render(request, reply, { title, active, flash, status = 200 }, body) {
    let message = flash;
    if (!message && request.session?.flash) {
      message = request.session.flash;
      await sessions.update(request.session, { flash: null });
    }
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(String(layout({ title, active, flash: message, admin: request.admin, csrf: request.session?.csrf, mqttConnected: publisher.connected }, body)));
  }

  /** Stores a one-time message in the session and redirects (post/redirect/get). */
  async function redirectWith(request, reply, url, flash) {
    await sessions.update(request.session, { flash });
    return reply.redirect(url);
  }

  const checkCsrf = (request, session) => sameToken(request.body?._csrf, session.csrf);

  const ctx = { store, publisher, config, sessions, throttle, audit, render, redirectWith, checkCsrf };

  await app.register(authRoutes, ctx);

  await app.register(async (secured) => {
    secured.addHook('preHandler', async (request, reply) => {
      const session = await sessions.load(request);
      // Half signed in (password OK, 2FA code pending): back to the code prompt.
      if (session?.stage === 'mfa') {
        return request.method === 'GET' ? reply.redirect('/admin/login/2fa') : reply.code(401).type('text/plain').send('Not signed in');
      }
      const admin = session ? await store.getAdmin(session.adminId) : null;
      if (!admin) {
        // No session, an expired one, or one whose admin was deleted.
        if (session || request.sessionExpired) await sessions.destroy(reply, session);
        if (request.method === 'GET') return reply.redirect(`/admin/login${session || request.sessionExpired ? '?m=expired' : ''}`);
        return reply.code(401).type('text/plain').send('Not signed in');
      }
      if (request.method === 'POST' && !checkCsrf(request, session)) {
        return reply.code(403).type('text/plain').send('Invalid or missing CSRF token. Reload the page and try again.');
      }
      request.session = session;
      request.admin = admin;
    });

    await secured.register(dashboardRoutes, ctx);
    await secured.register(hookRoutes, ctx);
    await secured.register(accountRoutes, ctx);
    await secured.register(userRoutes, ctx);
    await secured.register(auditRoutes, ctx);
  });
}
