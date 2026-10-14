// Persistence for hooks (with their actions and tokens embedded), the call log, and the
// admin side: accounts, sessions, login throttling and the audit log.
// MongoStore is used in production; MemoryStore implements the same interface for tests.

import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

export class DuplicateError extends Error {}

const newId = () => randomUUID();
const AUDIT_RETENTION_DAYS = 180;

function newAdmin(username, passwordHash) {
  const now = new Date();
  return {
    _id: newId(),
    username,
    passwordHash,
    totpSecret: null,
    totpLastStep: -1,
    createdAt: now,
    passwordChangedAt: now,
    lastLoginAt: null,
    lastLoginIp: null,
  };
}

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
    this.admins = db.collection('admins');
    this.sessions = db.collection('sessions');
    this.throttle = db.collection('login_throttle');
    this.audit = db.collection('audit');
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
    await this.admins.createIndex({ username: 1 }, { unique: true });
    await this.sessions.createIndex({ adminId: 1 });
    await this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.throttle.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.audit.createIndex({ at: 1 }, { expireAfterSeconds: AUDIT_RETENTION_DAYS * 86400, name: 'audit_ttl' });
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

  // --- admin accounts ---

  countAdmins() {
    return this.admins.countDocuments();
  }

  listAdmins() {
    return this.admins.find({}).sort({ username: 1 }).toArray();
  }

  getAdmin(id) {
    return this.admins.findOne({ _id: id });
  }

  getAdminByUsername(username) {
    return this.admins.findOne({ username });
  }

  async createAdmin({ username, passwordHash }) {
    const admin = newAdmin(username, passwordHash);
    try {
      await this.admins.insertOne(admin);
    } catch (err) {
      if (err.code === 11000) throw new DuplicateError(`An admin named "${username}" already exists`);
      throw err;
    }
    return admin;
  }

  async updateAdmin(id, fields) {
    await this.admins.updateOne({ _id: id }, { $set: fields });
  }

  async deleteAdmin(id) {
    await this.admins.deleteOne({ _id: id });
    await this.sessions.deleteMany({ adminId: id });
  }

  // --- sessions ---

  async createSession(session) {
    await this.sessions.insertOne(session);
  }

  getSession(id) {
    return this.sessions.findOne({ _id: id });
  }

  async updateSession(id, fields) {
    await this.sessions.updateOne({ _id: id }, { $set: fields });
  }

  async deleteSession(id) {
    await this.sessions.deleteOne({ _id: id });
  }

  listSessions(adminId) {
    return this.sessions.find({ adminId, stage: 'full', expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).toArray();
  }

  /** Deletes all of an admin's sessions, optionally keeping one. */
  async deleteSessions(adminId, { except } = {}) {
    await this.sessions.deleteMany({ adminId, ...(except ? { _id: { $ne: except } } : {}) });
  }

  // --- login throttling ---

  getThrottle(key) {
    return this.throttle.findOne({ _id: key });
  }

  async saveThrottle(key, entry) {
    await this.throttle.replaceOne({ _id: key }, entry, { upsert: true });
  }

  async deleteThrottle(key) {
    await this.throttle.deleteOne({ _id: key });
  }

  // --- audit log ---

  async logAudit(entry) {
    await this.audit.insertOne({ _id: newId(), at: new Date(), ...entry });
  }

  listAudit(limit = 200) {
    return this.audit.find({}).sort({ at: -1 }).limit(limit).toArray();
  }

  close() {
    return this.client.close();
  }
}

export class MemoryStore {
  constructor() {
    this.hooks = new Map();
    this.calls = [];
    this.admins = new Map();
    this.sessions = new Map();
    this.throttle = new Map();
    this.audit = [];
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

  // --- admin accounts ---

  async countAdmins() {
    return this.admins.size;
  }

  async listAdmins() {
    return [...this.admins.values()].sort((a, b) => a.username.localeCompare(b.username)).map((item) => structuredClone(item));
  }

  async getAdmin(id) {
    const admin = this.admins.get(id);
    return admin ? structuredClone(admin) : null;
  }

  async getAdminByUsername(username) {
    const admin = [...this.admins.values()].find((a) => a.username === username);
    return admin ? structuredClone(admin) : null;
  }

  async createAdmin({ username, passwordHash }) {
    if (await this.getAdminByUsername(username)) throw new DuplicateError(`An admin named "${username}" already exists`);
    const admin = newAdmin(username, passwordHash);
    this.admins.set(admin._id, admin);
    return structuredClone(admin);
  }

  async updateAdmin(id, fields) {
    const admin = this.admins.get(id);
    if (admin) Object.assign(admin, structuredClone(fields));
  }

  async deleteAdmin(id) {
    this.admins.delete(id);
    await this.deleteSessions(id);
  }

  // --- sessions ---

  async createSession(session) {
    this.sessions.set(session._id, structuredClone(session));
  }

  async getSession(id) {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async updateSession(id, fields) {
    const session = this.sessions.get(id);
    if (session) Object.assign(session, structuredClone(fields));
  }

  async deleteSession(id) {
    this.sessions.delete(id);
  }

  async listSessions(adminId) {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((s) => s.adminId === adminId && s.stage === 'full' && s.expiresAt.getTime() > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((item) => structuredClone(item));
  }

  async deleteSessions(adminId, { except } = {}) {
    for (const [id, session] of this.sessions) {
      if (session.adminId === adminId && id !== except) this.sessions.delete(id);
    }
  }

  // --- login throttling ---

  async getThrottle(key) {
    const entry = this.throttle.get(key);
    return entry ? structuredClone(entry) : null;
  }

  async saveThrottle(key, entry) {
    this.throttle.set(key, structuredClone({ _id: key, ...entry }));
  }

  async deleteThrottle(key) {
    this.throttle.delete(key);
  }

  // --- audit log ---

  async logAudit(entry) {
    this.audit.push({ _id: newId(), at: new Date(), ...structuredClone(entry) });
  }

  async listAudit(limit = 200) {
    return this.audit.slice().reverse().slice(0, limit).map((item) => structuredClone(item));
  }

  async close() {}
}
