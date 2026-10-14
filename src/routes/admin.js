import { timingSafeEqual } from 'node:crypto';
import basicAuth from '@fastify/basic-auth';
import { buildContext, fireHook } from '../fire.js';
import { PublishError } from '../mqtt.js';
import { DuplicateError } from '../store.js';
import { checkTemplate, TemplateError } from '../template.js';
import { generateToken } from '../tokens.js';
import { hookPage, hooksPage, layout } from '../views.js';
import { HOOK_NAME } from './webhook.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const field = (body, name) => (typeof body?.[name] === 'string' ? body[name].trim() : '');

export default async function adminRoutes(app, { store, publisher, config }) {
  await app.register(basicAuth, {
    authenticate: { realm: 'Pstryk' },
    validate: async (username, password) => {
      // Evaluate both comparisons so timing does not reveal which one failed.
      const okUser = safeEqual(username, config.adminUser);
      const okPass = safeEqual(password, config.adminPassword);
      if (!(okUser && okPass)) throw new Error('Invalid credentials');
    },
  });
  app.addHook('onRequest', app.basicAuth);

  // Basic auth credentials are sent automatically by the browser, so block cross-site form posts (CSRF).
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const site = request.headers['sec-fetch-site'];
    const origin = request.headers.origin;
    const crossSite = (site && site !== 'same-origin' && site !== 'none') || (origin && new URL(origin).host !== request.host);
    if (crossSite) return reply.code(403).send('Cross-site request blocked');
  });

  const page = (reply, opts, body) =>
    reply.type('text/html; charset=utf-8').send(String(layout({ ...opts, mqttConnected: publisher.connected }, body)));

  const loadHook = async (request, reply) => {
    const hook = await store.getHook(request.params.id);
    if (!hook) reply.code(404).send('Hook not found');
    return hook;
  };

  const renderHook = async (reply, hook, extra = {}) => {
    const calls = await store.recentCalls(hook._id, 25);
    const { error, flash, ...rest } = extra;
    return page(
      reply,
      { title: hook.name, error, flash },
      hookPage({ hook, calls, publicUrl: config.publicUrl, allowQueryToken: config.allowQueryToken, ...rest }),
    );
  };

  app.get('/', async (request, reply) => {
    const hooks = await store.listHooks();
    return page(reply, { error: request.query.error }, hooksPage({ hooks }));
  });

  app.post('/hooks', async (request, reply) => {
    const name = field(request.body, 'name').toLowerCase();
    const description = field(request.body, 'description');
    if (!HOOK_NAME.test(name)) {
      return reply.redirect(`/admin?error=${encodeURIComponent('Invalid name: use a-z, 0-9, - and _ (max 64 chars)')}`);
    }
    try {
      const hook = await store.createHook({ name, description });
      return reply.redirect(`/admin/hooks/${hook._id}`);
    } catch (err) {
      if (err instanceof DuplicateError) return reply.redirect(`/admin?error=${encodeURIComponent(err.message)}`);
      throw err;
    }
  });

  app.get('/hooks/:id', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (hook) return renderHook(reply, hook);
  });

  app.post('/hooks/:id/update', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    await store.updateHook(hook._id, {
      description: field(request.body, 'description'),
      enabled: request.body?.enabled === 'on',
    });
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    await store.deleteHook(hook._id);
    return reply.redirect('/admin');
  });

  app.post('/hooks/:id/actions', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const topic = field(request.body, 'topic');
    const payload = typeof request.body?.payload === 'string' ? request.body.payload : '';
    const qos = Number.parseInt(request.body?.qos, 10);
    const problems = [
      ...checkTemplate(topic, { topic: true }),
      ...checkTemplate(payload),
      ...([0, 1, 2].includes(qos) ? [] : ['QoS must be 0, 1 or 2']),
    ];
    if (problems.length) return renderHook(reply.code(400), hook, { error: problems.join('. ') });
    await store.addAction(hook._id, { topic, payload, qos, retain: request.body?.retain === 'on' });
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/actions/:actionId/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    await store.removeAction(hook._id, request.params.actionId);
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/tokens', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const label = field(request.body, 'label').slice(0, 64);
    if (!label) return renderHook(reply.code(400), hook, { error: 'Token label is required' });
    const { token, hash, hint } = generateToken();
    await store.addToken(hook._id, { label, hash, hint });
    // Render directly instead of redirecting: the plain token must never land in a URL or be stored.
    reply.header('cache-control', 'no-store');
    return renderHook(reply, await store.getHook(hook._id), { newToken: { label, token } });
  });

  app.post('/hooks/:id/tokens/:tokenId/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    await store.removeToken(hook._id, request.params.tokenId);
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/test', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const testBody = typeof request.body?.body === 'string' ? request.body.body : '{}';
    let body;
    try {
      body = testBody.trim() ? JSON.parse(testBody) : {};
    } catch (err) {
      return renderHook(reply.code(400), hook, { testBody, testResult: { ok: false, message: `Invalid JSON: ${err.message}` } });
    }

    let testResult;
    try {
      const published = await fireHook(hook, buildContext(hook, { body, query: {} }), publisher);
      testResult = { ok: true, message: `Published ${published.length} message(s)`, published };
      await store.logCall({ hookId: hook._id, hookName: hook.name, source: 'admin test', ip: request.ip, status: 200, detail: testResult.message, published });
    } catch (err) {
      if (!(err instanceof TemplateError || err instanceof PublishError)) throw err;
      testResult = { ok: false, message: err.message };
      await store.logCall({ hookId: hook._id, hookName: hook.name, source: 'admin test', ip: request.ip, status: err instanceof TemplateError ? 400 : 503, detail: err.message, published: [] });
    }
    return renderHook(reply, await store.getHook(hook._id), { testBody, testResult });
  });
}
