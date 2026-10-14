// Persistence for hooks (with their actions and tokens embedded) and the call log.
// MongoStore is used in production; MemoryStore implements the same interface for tests.

import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

export class DuplicateError extends Error {}

const newId = () => randomUUID();

export class MongoStore {
  static async connect({ uri, dbName, callLogDays }) {
    const client = new MongoClient(uri);
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    await store.#ensureIndexes(callLogDays);
    return store;
  }

  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.hooks = db.collection('hooks');
    this.calls = db.collection('calls');
  }

  async #ensureIndexes(callLogDays) {
    await this.hooks.createIndex({ name: 1 }, { unique: true });
    await this.calls.createIndex({ hookId: 1, at: -1 });
    const ttl = { at: 1 };
    const ttlOptions = { expireAfterSeconds: callLogDays * 86400, name: 'calls_ttl' };
    try {
      await this.calls.createIndex(ttl, ttlOptions);
    } catch (err) {
      // CALL_LOG_DAYS changed since the index was created: update the TTL in place.
      if (err.codeName !== 'IndexOptionsConflict' && err.codeName !== 'IndexKeySpecsConflict') throw err;
      await this.db.command({
        collMod: 'calls',
        index: { name: 'calls_ttl', expireAfterSeconds: ttlOptions.expireAfterSeconds },
      });
    }
  }

  async ping() {
    await this.db.command({ ping: 1 });
  }

  listHooks() {
    return this.hooks.find({}).sort({ name: 1 }).toArray();
  }

  getHook(id) {
    return this.hooks.findOne({ _id: id });
  }

  getHookByName(name) {
    return this.hooks.findOne({ name });
  }

  async createHook({ name, description }) {
    const hook = { _id: newId(), name, description, enabled: true, actions: [], tokens: [], createdAt: new Date() };
    try {
      await this.hooks.insertOne(hook);
    } catch (err) {
      if (err.code === 11000) throw new DuplicateError(`A hook named "${name}" already exists`);
      throw err;
    }
    return hook;
  }

  async updateHook(id, { description, enabled }) {
    await this.hooks.updateOne({ _id: id }, { $set: { description, enabled } });
  }

  async deleteHook(id) {
    await this.hooks.deleteOne({ _id: id });
    await this.calls.deleteMany({ hookId: id });
  }

  async addAction(hookId, action) {
    const entry = { id: newId(), ...action };
    await this.hooks.updateOne({ _id: hookId }, { $push: { actions: entry } });
    return entry;
  }

  async removeAction(hookId, actionId) {
    await this.hooks.updateOne({ _id: hookId }, { $pull: { actions: { id: actionId } } });
  }

  async addToken(hookId, { label, hash, hint }) {
    const entry = { id: newId(), label, hash, hint, createdAt: new Date(), lastUsedAt: null };
    await this.hooks.updateOne({ _id: hookId }, { $push: { tokens: entry } });
    return entry;
  }

  async removeToken(hookId, tokenId) {
    await this.hooks.updateOne({ _id: hookId }, { $pull: { tokens: { id: tokenId } } });
  }

  async touchToken(hookId, tokenId) {
    await this.hooks.updateOne(
      { _id: hookId, 'tokens.id': tokenId },
      { $set: { 'tokens.$.lastUsedAt': new Date() } },
    );
  }

  async logCall(entry) {
    await this.calls.insertOne({ _id: newId(), at: new Date(), ...entry });
  }

  recentCalls(hookId, limit = 20) {
    return this.calls.find({ hookId }).sort({ at: -1 }).limit(limit).toArray();
  }

  close() {
    return this.client.close();
  }
}

export class MemoryStore {
  constructor() {
    this.hooks = new Map();
    this.calls = [];
  }

  async ping() {}

  async listHooks() {
    return [...this.hooks.values()].sort((a, b) => a.name.localeCompare(b.name)).map((item) => structuredClone(item));
  }

  async getHook(id) {
    const hook = this.hooks.get(id);
    return hook ? structuredClone(hook) : null;
  }

  async getHookByName(name) {
    const hook = [...this.hooks.values()].find((h) => h.name === name);
    return hook ? structuredClone(hook) : null;
  }

  async createHook({ name, description }) {
    if (await this.getHookByName(name)) throw new DuplicateError(`A hook named "${name}" already exists`);
    const hook = { _id: newId(), name, description, enabled: true, actions: [], tokens: [], createdAt: new Date() };
    this.hooks.set(hook._id, hook);
    return structuredClone(hook);
  }

  async updateHook(id, { description, enabled }) {
    const hook = this.hooks.get(id);
    if (hook) Object.assign(hook, { description, enabled });
  }

  async deleteHook(id) {
    this.hooks.delete(id);
    this.calls = this.calls.filter((c) => c.hookId !== id);
  }

  async addAction(hookId, action) {
    const entry = { id: newId(), ...action };
    this.hooks.get(hookId)?.actions.push(entry);
    return entry;
  }

  async removeAction(hookId, actionId) {
    const hook = this.hooks.get(hookId);
    if (hook) hook.actions = hook.actions.filter((a) => a.id !== actionId);
  }

  async addToken(hookId, { label, hash, hint }) {
    const entry = { id: newId(), label, hash, hint, createdAt: new Date(), lastUsedAt: null };
    this.hooks.get(hookId)?.tokens.push(entry);
    return entry;
  }

  async removeToken(hookId, tokenId) {
    const hook = this.hooks.get(hookId);
    if (hook) hook.tokens = hook.tokens.filter((t) => t.id !== tokenId);
  }

  async touchToken(hookId, tokenId) {
    const token = this.hooks.get(hookId)?.tokens.find((t) => t.id === tokenId);
    if (token) token.lastUsedAt = new Date();
  }

  async logCall(entry) {
    this.calls.push({ _id: newId(), at: new Date(), ...entry });
  }

  async recentCalls(hookId, limit = 20) {
    return this.calls
      .filter((c) => c.hookId === hookId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async close() {}
}
