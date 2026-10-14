import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import adminArea from './routes/admin/index.js';
import webhookRoutes from './routes/webhook.js';

/** Builds the HTTP app. Store and publisher are injected so tests can swap them. */
export async function buildApp({ config, store, publisher, logger }) {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimit,
  });

  await app.register(formbody);

  app.get('/', (request, reply) => reply.redirect('/admin'));

  app.get('/healthz', async (request, reply) => {
    let db = true;
    try {
      await store.ping();
    } catch {
      db = false;
    }
    const ok = db && publisher.connected;
    return reply.code(ok ? 200 : 503).send({ ok, db, mqtt: publisher.connected });
  });

  await app.register(webhookRoutes, { store, publisher, config });
  await app.register(adminArea, { prefix: '/admin', store, publisher, config });

  return app;
}
