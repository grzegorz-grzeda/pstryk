// End-to-end tests: real Fastify app, real MQTT client against an in-process broker,
// in-memory store in place of MongoDB.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { buildApp } from '../src/app.js';
import { createPublisher } from '../src/mqtt.js';
import { MemoryStore } from '../src/store.js';
import { generateToken } from '../src/tokens.js';

const ADMIN = 'Basic ' + Buffer.from('admin:correct-horse-battery').toString('base64');
const silent = { info() {}, warn() {}, error() {} };

let broker, brokerServer, publisher, subscriber, received;
let store, app, hook, token;

before(async () => {
  broker = await Aedes.createBroker();
  brokerServer = createServer(broker.handle);
  brokerServer.listen(0);
  await once(brokerServer, 'listening');
  const url = `mqtt://127.0.0.1:${brokerServer.address().port}`;

  publisher = createPublisher({ mqttUrl: url }, silent);
  subscriber = await mqtt.connectAsync(url);
  await subscriber.subscribeAsync('#');
  subscriber.on('message', (topic, payload, packet) => received.push({ topic, payload: payload.toString(), retain: packet.retain }));
  while (!publisher.connected) await new Promise((r) => setTimeout(r, 10));
});

after(async () => {
  await subscriber.endAsync();
  await publisher.close();
  await new Promise((r) => broker.close(r));
  brokerServer.close();
});

async function makeApp(overrides = {}) {
  const config = {
    trustProxy: false, bodyLimit: 1024, rateLimitMax: 1000, allowQueryToken: false, publicUrl: '',
    adminUser: 'admin', adminPassword: 'correct-horse-battery', ...overrides,
  };
  return buildApp({ config, store, publisher, logger: false });
}

async function waitForMessages(n) {
  for (let i = 0; i < 100 && received.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return received;
}

beforeEach(async () => {
  // Let deliveries from the previous test land before resetting.
  await new Promise((r) => setTimeout(r, 50));
  received = [];
  store = new MemoryStore();
  app = await makeApp();
  hook = await store.createHook({ name: 'lights', description: 'Lights' });
  await store.addAction(hook._id, { topic: 'home/{{body.room}}/light', payload: '{"on": {{body.on}}, "by": {{hook.name|json}}}', qos: 1, retain: false });
  const t = generateToken();
  token = t.token;
  await store.addToken(hook._id, { label: 'phone', hash: t.hash, hint: t.hint });
});

describe('webhook', () => {
  test('valid token publishes rendered message', async () => {
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'kitchen', on: true } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, published: 1 });
    const [msg] = await waitForMessages(1);
    assert.equal(msg.topic, 'home/kitchen/light');
    assert.deepEqual(JSON.parse(msg.payload), { on: true, by: 'lights' });

    const [call] = await store.recentCalls(hook._id);
    assert.equal(call.status, 200);
    assert.equal(call.source, 'phone');
    assert.ok((await store.getHook(hook._id)).tokens[0].lastUsedAt);
  });

  test('X-Pstryk-Token header works too', async () => {
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { 'x-pstryk-token': token }, payload: { room: 'hall', on: false } });
    assert.equal(res.statusCode, 200);
  });

  test('wrong token, missing token and unknown hook all look the same', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: 'Bearer pstk_nope' }, payload: {} });
    const missing = await app.inject({ method: 'POST', url: '/h/lights', payload: {} });
    const unknown = await app.inject({ method: 'POST', url: '/h/nothing', headers: { authorization: `Bearer ${token}` }, payload: {} });
    for (const res of [wrong, missing, unknown]) {
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { ok: false, error: 'unauthorized' });
    }
    assert.equal(received.length, 0);
  });

  test('query token is ignored unless enabled', async () => {
    const url = `/h/lights?token=${token}&room=x`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);

    const open = await makeApp({ allowQueryToken: true });
    await store.addAction(hook._id, { topic: 'q/{{query.room}}', payload: '{{query}}', qos: 0, retain: false });
    await store.removeAction(hook._id, (await store.getHook(hook._id)).actions[0].id);
    const res = await open.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200);
    const [msg] = await waitForMessages(1);
    assert.equal(msg.topic, 'q/x');
    assert.deepEqual(JSON.parse(msg.payload), { room: 'x' }, 'token is not exposed to templates');
  });

  test('topic injection is rejected and nothing is published', async () => {
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'a/#', on: true } });
    assert.equal(res.statusCode, 400);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 0);
  });

  test('missing template value is a 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'x' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /body\.on/);
  });

  test('disabled hook is refused after auth', async () => {
    await store.updateHook(hook._id, { description: '', enabled: false });
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'x', on: 1 } });
    assert.equal(res.statusCode, 409);
  });

  test('oversized body is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'x'.repeat(2000), on: 1 } });
    assert.equal(res.statusCode, 413);
  });

  test('revoked token stops working', async () => {
    await store.removeToken(hook._id, (await store.getHook(hook._id)).tokens[0].id);
    const res = await app.inject({ method: 'POST', url: '/h/lights', headers: { authorization: `Bearer ${token}` }, payload: { room: 'x', on: 1 } });
    assert.equal(res.statusCode, 401);
  });

  test('rate limit applies', async () => {
    const limited = await makeApp({ rateLimitMax: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await limited.inject({ method: 'POST', url: '/h/lights', payload: {} })).statusCode);
    assert.deepEqual(codes, [401, 401, 429]);
  });
});

describe('admin', () => {
  test('requires basic auth', async () => {
    assert.equal((await app.inject({ url: '/admin' })).statusCode, 401);
    const bad = 'Basic ' + Buffer.from('admin:wrong').toString('base64');
    assert.equal((await app.inject({ url: '/admin', headers: { authorization: bad } })).statusCode, 401);
    const res = await app.inject({ url: '/admin', headers: { authorization: ADMIN } });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /lights/);
  });

  test('blocks cross-site posts', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/hooks', headers: { authorization: ADMIN, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload: 'name=evil',
    });
    assert.equal(res.statusCode, 403);
  });

  test('creates a hook, action and token through forms', async () => {
    const form = { authorization: ADMIN, 'content-type': 'application/x-www-form-urlencoded' };
    const created = await app.inject({ method: 'POST', url: '/admin/hooks', headers: form, payload: 'name=garage&description=Door' });
    assert.equal(created.statusCode, 302);
    const id = created.headers.location.split('/').pop();

    const bad = await app.inject({ method: 'POST', url: `/admin/hooks/${id}/actions`, headers: form, payload: 'topic=garage/%23&payload=x&qos=1' });
    assert.equal(bad.statusCode, 400);

    const ok = await app.inject({ method: 'POST', url: `/admin/hooks/${id}/actions`, headers: form, payload: 'topic=garage/cmd&payload=open&qos=1&retain=on' });
    assert.equal(ok.statusCode, 302);

    const tokenPage = await app.inject({ method: 'POST', url: `/admin/hooks/${id}/tokens`, headers: form, payload: 'label=tasker' });
    assert.equal(tokenPage.statusCode, 200);
    assert.equal(tokenPage.headers['cache-control'], 'no-store');
    const newToken = tokenPage.body.match(/pstk_[A-Za-z0-9_-]{43}/)[0];

    const call = await app.inject({ method: 'POST', url: '/h/garage', headers: { authorization: `Bearer ${newToken}` } });
    assert.equal(call.statusCode, 200);
    const [msg] = await waitForMessages(1);
    assert.deepEqual([msg.topic, msg.payload], ['garage/cmd', 'open']);

    // A client subscribing later still gets the retained message.
    const late = await mqtt.connectAsync(`mqtt://127.0.0.1:${brokerServer.address().port}`);
    const retained = new Promise((resolve) => late.on('message', (topic, payload, packet) => resolve({ topic, payload: payload.toString(), retain: packet.retain })));
    await late.subscribeAsync('garage/cmd');
    assert.deepEqual(await retained, { topic: 'garage/cmd', payload: 'open', retain: true });
    await late.endAsync();
  });

  test('duplicate and invalid hook names are rejected', async () => {
    const form = { authorization: ADMIN, 'content-type': 'application/x-www-form-urlencoded' };
    const dup = await app.inject({ method: 'POST', url: '/admin/hooks', headers: form, payload: 'name=lights' });
    assert.match(dup.headers.location, /error=/);
    const bad = await app.inject({ method: 'POST', url: '/admin/hooks', headers: form, payload: 'name=Bad Name!' });
    assert.match(bad.headers.location, /error=/);
  });

  test('test fire publishes and escapes output', async () => {
    const form = { authorization: ADMIN, 'content-type': 'application/x-www-form-urlencoded' };
    const body = encodeURIComponent(JSON.stringify({ room: 'office', on: '<script>' }));
    const res = await app.inject({ method: 'POST', url: `/admin/hooks/${hook._id}/test`, headers: form, payload: `body=${body}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Published 1 message/);
    assert.doesNotMatch(res.body, /<script>/);
    const [msg] = await waitForMessages(1);
    assert.equal(msg.topic, 'home/office/light');
  });
});

test('healthz reports db and mqtt', async () => {
  const res = await app.inject({ url: '/healthz' });
  assert.deepEqual(res.json(), { ok: true, db: true, mqtt: true });
});
