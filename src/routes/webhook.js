import { buildContext, fireHook } from '../fire.js';
import { PublishError } from '../mqtt.js';
import { TemplateError } from '../template.js';
import { matchToken } from '../tokens.js';

export const HOOK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function presentedToken(request, allowQueryToken) {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  if (request.headers['x-pstryk-token']) return String(request.headers['x-pstryk-token']);
  if (allowQueryToken && typeof request.query.token === 'string') return request.query.token;
  return null;
}

export default async function webhookRoutes(app, { store, publisher, config }) {
  app.route({
    method: ['GET', 'POST'],
    url: '/h/:name',
    config: { rateLimit: { max: config.rateLimitMax, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const { name } = request.params;
      // Unknown hooks and bad tokens get the same answer, so hook names can't be probed.
      const unauthorized = () => reply.code(401).send({ ok: false, error: 'unauthorized' });

      if (!HOOK_NAME.test(name)) return unauthorized();
      const hook = await store.getHookByName(name);
      const token = hook && matchToken(hook.tokens, presentedToken(request, config.allowQueryToken));
      if (!token) {
        request.log.warn({ hook: name, ip: request.ip }, 'Rejected webhook call');
        return unauthorized();
      }

      const log = (status, detail, published = []) =>
        store.logCall({ hookId: hook._id, hookName: hook.name, source: token.label, ip: request.ip, status, detail, published });

      await store.touchToken(hook._id, token.id);
      if (!hook.enabled) {
        await log(409, 'Hook is disabled');
        return reply.code(409).send({ ok: false, error: 'hook disabled' });
      }

      const { token: _ignored, ...query } = request.query;
      const ctx = buildContext(hook, { body: request.body, query });
      try {
        const published = await fireHook(hook, ctx, publisher);
        await log(200, `Published ${published.length} message(s)`, published);
        return { ok: true, published: published.length };
      } catch (err) {
        if (err instanceof TemplateError) {
          await log(400, err.message);
          return reply.code(400).send({ ok: false, error: err.message });
        }
        if (err instanceof PublishError) {
          await log(503, err.message);
          return reply.code(503).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  });
}
