import { auditPage } from '../../views/account.js';

export default async function auditRoutes(app, { store, render }) {
  app.get('/audit', async (request, reply) => {
    const entries = await store.listAudit(200);
    return render(request, reply, { title: 'Audit log', active: 'audit' }, auditPage({ entries }));
  });
}
