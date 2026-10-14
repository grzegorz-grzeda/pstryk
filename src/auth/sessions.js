// Server-side admin sessions.
//
// The cookie holds a random 256-bit session ID. The database stores only its SHA-256 hash, so a
// database leak doesn't hand out live sessions. Sessions end after a period of inactivity
// (idle timeout) and after a fixed lifetime (absolute timeout), whichever comes first.
//
// A session has a stage:
//   'mfa'  – password checked, waiting for the 2FA code (short-lived, can't access anything)
//   'full' – signed in

import { createHash, randomBytes } from 'node:crypto';

const TOUCH_INTERVAL_MS = 60_000;
export const MFA_STAGE_MS = 5 * 60_000;

const hashId = (sid) => createHash('sha256').update(sid).digest('hex');
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export class Sessions {
  constructor(store, { idleMs, maxMs, secure, now = () => Date.now() }) {
    this.store = store;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.secure = secure;
    this.now = now;
    // The __Host- prefix makes browsers insist on Secure, Path=/ and no Domain attribute.
    this.cookieName = secure ? '__Host-pstryk_session' : 'pstryk_session';
  }

  #expiry(createdAt, lastSeenAt, stage) {
    const absolute = createdAt + (stage === 'mfa' ? MFA_STAGE_MS : this.maxMs);
    return new Date(Math.min(absolute, lastSeenAt + this.idleMs));
  }

  async create(reply, { adminId, stage, ip, userAgent }) {
    const sid = randomToken();
    const now = this.now();
    const session = {
      _id: hashId(sid),
      ref: randomToken(9),
      adminId,
      stage,
      csrf: randomToken(),
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt: this.#expiry(now, now, stage),
      ip,
      userAgent: String(userAgent ?? '').slice(0, 200),
      mfaAttempts: 0,
      flash: null,
    };
    await this.store.createSession(session);
    this.#setCookie(reply, sid);
    return session;
  }

  /**
   * Returns the live session for this request, or null. Expired sessions are deleted and
   * `request.sessionExpired` is set, so the caller can tell the user why they were signed out.
   */
  async load(request) {
    const sid = request.cookies?.[this.cookieName];
    if (!sid || sid.length > 100) return null;
    const session = await this.store.getSession(hashId(sid));
    if (!session) return null;

    const now = this.now();
    if (session.expiresAt.getTime() <= now) {
      await this.store.deleteSession(session._id);
      request.sessionExpired = true;
      return null;
    }
    // Sliding idle timeout. Writes are limited to once a minute per session.
    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      session.lastSeenAt = new Date(now);
      session.expiresAt = this.#expiry(session.createdAt.getTime(), now, session.stage);
      await this.store.updateSession(session._id, { lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt });
    }
    return session;
  }

  /** Upgrades an MFA-stage session to a full one under a fresh ID (prevents session fixation). */
  async promote(reply, session, { ip, userAgent }) {
    await this.store.deleteSession(session._id);
    return this.create(reply, { adminId: session.adminId, stage: 'full', ip, userAgent });
  }

  async destroy(reply, session) {
    if (session) await this.store.deleteSession(session._id);
    this.clearCookie(reply);
  }

  async update(session, fields) {
    Object.assign(session, fields);
    await this.store.updateSession(session._id, fields);
  }

  #setCookie(reply, sid) {
    reply.setCookie(this.cookieName, sid, {
      path: '/',
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      // No maxAge: a browser-session cookie. The server enforces the real lifetime.
    });
  }

  clearCookie(reply) {
    reply.clearCookie(this.cookieName, { path: '/', httpOnly: true, secure: this.secure, sameSite: 'strict' });
  }
}
