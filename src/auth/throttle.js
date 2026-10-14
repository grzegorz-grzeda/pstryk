// Brute-force protection for the admin login.
//
// Failures are counted per username and per client IP within a window. Reaching the limit
// locks that key for a while. Locks apply to any username string, existing or not,
// so the lockout itself doesn't reveal which accounts exist.

const MINUTE = 60_000;

export const LIMITS = {
  user: { max: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  ip: { max: 20, windowMs: 15 * MINUTE, lockMs: 60 * MINUTE },
};

const userKey = (username) => `user:${String(username).toLowerCase()}`;
const ipKey = (ip) => `ip:${ip}`;

export class LoginThrottle {
  constructor(store, { limits = LIMITS, now = () => Date.now() } = {}) {
    this.store = store;
    this.limits = limits;
    this.now = now;
  }

  async #lockedUntil(key) {
    const entry = await this.store.getThrottle(key);
    return entry?.lockedUntil && entry.lockedUntil.getTime() > this.now() ? entry.lockedUntil : null;
  }

  /** Returns the time until which login is blocked for this IP or username, or null. */
  async lockedUntil(ip, username) {
    const locks = (await Promise.all([this.#lockedUntil(ipKey(ip)), username ? this.#lockedUntil(userKey(username)) : null])).filter(Boolean);
    return locks.length ? new Date(Math.max(...locks.map((d) => d.getTime()))) : null;
  }

  async #fail(key, { max, windowMs, lockMs }) {
    const now = this.now();
    const entry = await this.store.getThrottle(key);
    const fresh = !entry || now - entry.firstAt.getTime() > windowMs;
    const count = fresh ? 1 : entry.count + 1;
    const lockedUntil = count >= max ? new Date(now + lockMs) : null;
    await this.store.saveThrottle(key, {
      count,
      firstAt: fresh ? new Date(now) : entry.firstAt,
      lockedUntil,
      expiresAt: new Date(now + Math.max(windowMs, lockMs)),
    });
    return Boolean(lockedUntil);
  }

  /** Records a failed attempt. Returns true if this failure triggered a lock. */
  async recordFailure(ip, username) {
    const [ipLocked, userLocked] = await Promise.all([
      this.#fail(ipKey(ip), this.limits.ip),
      username ? this.#fail(userKey(username), this.limits.user) : false,
    ]);
    return ipLocked || userLocked;
  }

  async recordSuccess(username) {
    await this.store.deleteThrottle(userKey(username));
  }

  async unlock(username) {
    await this.store.deleteThrottle(userKey(username));
  }
}
