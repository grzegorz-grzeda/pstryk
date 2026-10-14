import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { loadDashboard, rangeWindow } from '../src/dashboard.js';
import { MemoryStore } from '../src/store.js';
import { addAdmin, Browser, createApp } from './helpers.js';

const HOUR = 3_600_000;
// 2026-10-14 15:20 UTC
const NOW = Date.UTC(2026, 9, 14, 15, 20);

async function seed(store) {
  const lights = await store.createHook({ name: 'lights', description: '' });
  const garage = await store.createHook({ name: 'garage', description: '' });
  await store.createHook({ name: 'unused', description: '' });
  const call = (hook, hoursAgo, status) =>
    store.calls.push({ _id: `${hook.name}-${hoursAgo}-${status}-${Math.random()}`, at: new Date(NOW - hoursAgo * HOUR), hookId: hook._id, hookName: hook.name, source: 'phone', ip: '1.1.1.1', status, detail: '' });
  for (let i = 0; i < 5; i++) call(lights, 0, 200); // current hour
  call(lights, 0, 400);
  call(garage, 3, 200);
  call(garage, 3, 503);
  call(garage, 30, 200); // previous 24 h
  call(garage, 24 * 40, 200); // outside everything
  await store.logAudit({ action: 'login.failure', actor: null, ip: '6.6.6.6', detail: { username: 'root' } });
  return { lights, garage };
}

describe('dashboard data', () => {
  test('windows are aligned to whole buckets and include now', () => {
    const w = rangeWindow('24h', NOW);
    assert.equal(w.until.toISOString(), '2026-10-14T16:00:00.000Z');
    assert.equal(w.since.toISOString(), '2026-10-13T16:00:00.000Z');
    const d = rangeWindow('30d', NOW);
    assert.equal(d.until.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(rangeWindow('bogus', NOW).range, '24h');
  });

  test('aggregates calls per bucket and per hook', async () => {
    const store = new MemoryStore();
    const { lights, garage } = await seed(store);
    const data = await loadDashboard(store, { range: '24h', now: NOW });

    assert.equal(data.series.length, 24);
    assert.deepEqual(data.totals, { total: 8, failed: 2, ok: 6, successRate: 0.75 });
    assert.deepEqual(data.previous, { total: 1, failed: 0 });
    const last = data.series.at(-1);
    assert.deepEqual([last.ok, last.failed], [5, 1]);
    const threeHoursAgo = data.series.at(-4);
    assert.deepEqual([threeHoursAgo.ok, threeHoursAgo.failed], [1, 1]);

    assert.deepEqual(data.hooks.perHook.map((h) => [h.hook.name, h.total, h.failed]), [['lights', 6, 1], ['garage', 2, 1], ['unused', 0, 0]]);
    assert.equal(data.hooks.perHook[0].hook._id, lights._id);
    assert.equal(data.hooks.perHook[1].hook._id, garage._id);
    assert.equal(data.hooks.perHook[1].lastStatus, 200, 'latest call wins (both in the same hour, inserted in order)');
    assert.equal(data.security.failedSignIns, 1);
  });

  test('30-day range uses daily buckets', async () => {
    const store = new MemoryStore();
    await seed(store);
    const data = await loadDashboard(store, { range: '30d', now: NOW });
    assert.equal(data.series.length, 30);
    assert.equal(data.totals.total, 9);
  });
});

describe('dashboard page', () => {
  let store, browser;
  beforeEach(async () => {
    store = new MemoryStore();
    await seed(store);
    await addAdmin(store);
    browser = new Browser(await createApp({ store, config: { callLogDays: 30 } }));
    await browser.login();
  });

  test('is the admin home page and renders tiles, chart and tables', async () => {
    const res = await browser.get('/admin?range=30d');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<h3>Webhook calls<\/h3>/);
    assert.match(res.body, /<svg class="chart"/);
    assert.match(res.body, /class="bar-ok"/);
    assert.match(res.body, /class="bar-failed"/);
    assert.match(res.body, /Show data as a table/);
    assert.match(res.body, /Failed sign-in<\/td><td>root/);
    assert.match(res.body, /href="\/admin\?range=30d" aria-current="page"/);
  });

  test('tooltip data is escaped JSON', async () => {
    const res = await browser.get('/admin');
    const tip = /data-tip="([^"]+)"/.exec(res.body)[1].replaceAll('&quot;', '"');
    const parsed = JSON.parse(tip);
    assert.deepEqual(parsed.rows.map((r) => r.label), ['Delivered', 'Failed']);
  });

  test('works with no data at all', async () => {
    const empty = new MemoryStore();
    await addAdmin(empty);
    const b = new Browser(await createApp({ store: empty }));
    await b.login();
    const res = await b.get('/admin');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /No calls in this period/);
    assert.match(res.body, /No hooks yet/);
  });
});
