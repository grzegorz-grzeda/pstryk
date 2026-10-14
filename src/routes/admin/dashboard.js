import { loadDashboard } from '../../dashboard.js';
import { dashboardPage } from '../../views/dashboard.js';

export default async function dashboardRoutes(app, { store, publisher, config, render }) {
  app.get('/', async (request, reply) => {
    const now = Date.now();
    const data = await loadDashboard(store, { range: request.query.range, now });
    const mqtt = publisher.status ?? { connected: publisher.connected };
    return render(request, reply, { title: 'Dashboard', active: 'dashboard' }, dashboardPage({ data, mqtt, callLogDays: config.callLogDays, now }));
  });
}
