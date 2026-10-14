import { buildContext, fireHook } from '../../fire.js';
import { PublishError } from '../../mqtt.js';
import { DuplicateError } from '../../store.js';
import { checkTemplate, TemplateError } from '../../template.js';
import { generateToken } from '../../tokens.js';
import { hookPage, hooksPage } from '../../views/hooks.js';
import { HOOK_NAME } from '../webhook.js';
import { field } from './util.js';

export default async function hookRoutes(app, { store, publisher, config, audit, render, redirectWith }) {
  const loadHook = async (request, reply) => {
    const hook = await store.getHook(request.params.id);
    if (!hook) reply.code(404).type('text/plain').send('Hook not found');
    return hook;
  };

  const renderHook = async (request, reply, hook, { status, flash, ...extra } = {}) => {
    const calls = await store.recentCalls(hook._id, 25);
    return render(
      request,
      reply,
      { title: hook.name, active: 'hooks', status, flash },
      hookPage({ hook, calls, csrf: request.session.csrf, publicUrl: config.publicUrl, allowQueryToken: config.allowQueryToken, ...extra }),
    );
  };

  app.get('/hooks', async (request, reply) => {
    const hooks = await store.listHooks();
    return render(request, reply, { active: 'hooks' }, hooksPage({ hooks, csrf: request.session.csrf }));
  });

  app.post('/hooks', async (request, reply) => {
    const name = field(request.body, 'name', 100).toLowerCase();
    const description = field(request.body, 'description', 200);
    if (!HOOK_NAME.test(name)) {
      return redirectWith(request, reply, '/admin/hooks', { error: 'Invalid name: use a-z, 0-9, - and _ (max 64 characters)' });
    }
    try {
      const hook = await store.createHook({ name, description });
      await audit(request, 'hook.create', { hook: name });
      return reply.redirect(`/admin/hooks/${hook._id}`);
    } catch (err) {
      if (err instanceof DuplicateError) return redirectWith(request, reply, '/admin/hooks', { error: err.message });
      throw err;
    }
  });

  app.get('/hooks/:id', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (hook) return renderHook(request, reply, hook);
  });

  app.post('/hooks/:id/update', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const enabled = request.body?.enabled === 'on';
    await store.updateHook(hook._id, { description: field(request.body, 'description', 200), enabled });
    await audit(request, 'hook.update', { hook: hook.name, enabled });
    return redirectWith(request, reply, `/admin/hooks/${hook._id}`, { info: 'Saved.' });
  });

  app.post('/hooks/:id/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    await store.deleteHook(hook._id);
    await audit(request, 'hook.delete', { hook: hook.name });
    return redirectWith(request, reply, '/admin/hooks', { info: `Deleted hook ${hook.name}.` });
  });

  app.post('/hooks/:id/actions', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const topic = field(request.body, 'topic', 2000);
    const payload = typeof request.body?.payload === 'string' ? request.body.payload : '';
    const qos = Number.parseInt(request.body?.qos, 10);
    const problems = [
      ...checkTemplate(topic, { topic: true }),
      ...checkTemplate(payload),
      ...([0, 1, 2].includes(qos) ? [] : ['QoS must be 0, 1 or 2']),
    ];
    if (problems.length) return renderHook(request, reply, hook, { status: 400, flash: { error: problems.join('. ') } });
    await store.addAction(hook._id, { topic, payload, qos, retain: request.body?.retain === 'on' });
    await audit(request, 'action.add', { hook: hook.name, topic });
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/actions/:actionId/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const action = hook.actions.find((a) => a.id === request.params.actionId);
    await store.removeAction(hook._id, request.params.actionId);
    if (action) await audit(request, 'action.remove', { hook: hook.name, topic: action.topic });
    return reply.redirect(`/admin/hooks/${hook._id}`);
  });

  app.post('/hooks/:id/tokens', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const label = field(request.body, 'label', 64);
    if (!label) return renderHook(request, reply, hook, { status: 400, flash: { error: 'Token label is required' } });
    const { token, hash, hint } = generateToken();
    await store.addToken(hook._id, { label, hash, hint });
    await audit(request, 'token.create', { hook: hook.name, label });
    // Render directly instead of redirecting: the plain token must never land in a URL or be stored.
    return renderHook(request, reply, await store.getHook(hook._id), { newToken: { label, token } });
  });

  app.post('/hooks/:id/tokens/:tokenId/delete', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const token = hook.tokens.find((t) => t.id === request.params.tokenId);
    await store.removeToken(hook._id, request.params.tokenId);
    if (token) await audit(request, 'token.revoke', { hook: hook.name, label: token.label });
    return redirectWith(request, reply, `/admin/hooks/${hook._id}`, token ? { info: `Revoked token “${token.label}”.` } : null);
  });

  app.post('/hooks/:id/test', async (request, reply) => {
    const hook = await loadHook(request, reply);
    if (!hook) return;
    const testBody = typeof request.body?.body === 'string' ? request.body.body : '{}';
    let body;
    try {
      body = testBody.trim() ? JSON.parse(testBody) : {};
    } catch (err) {
      return renderHook(request, reply, hook, { status: 400, testBody, testResult: { ok: false, message: `Invalid JSON: ${err.message}` } });
    }

    const source = `admin test (${request.admin.username})`;
    let testResult;
    try {
      const published = await fireHook(hook, buildContext(hook, { body, query: {} }), publisher);
      testResult = { ok: true, message: `Published ${published.length} message(s)`, published };
      await store.logCall({ hookId: hook._id, hookName: hook.name, source, ip: request.ip, status: 200, detail: testResult.message, published });
    } catch (err) {
      if (!(err instanceof TemplateError || err instanceof PublishError)) throw err;
      testResult = { ok: false, message: err.message };
      await store.logCall({ hookId: hook._id, hookName: hook.name, source, ip: request.ip, status: err instanceof TemplateError ? 400 : 503, detail: err.message, published: [] });
    }
    await audit(request, 'hook.test', { hook: hook.name, result: testResult.message });
    return renderHook(request, reply, await store.getHook(hook._id), { testBody, testResult });
  });
}
