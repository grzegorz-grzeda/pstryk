import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';

export const ADMIN_PASSWORD = 'correct-horse-battery';

export function testConfig(overrides = {}) {
  return {
    trustProxy: false,
    bodyLimit: 4096,
    rateLimitMax: 1000,
    allowQueryToken: false,
    publicUrl: '',
    sessionIdleMinutes: 30,
    sessionMaxHours: 12,
    cookieSecure: false,
    callLogDays: 30,
    ...overrides,
  };
}

/** Records published messages instead of talking to a broker. */
export function fakePublisher() {
  const published = [];
  return { connected: true, published, async publish(message) { published.push(message); } };
}

export async function createApp({ store, publisher = fakePublisher(), config = {} }) {
  return buildApp({ config: testConfig(config), store, publisher, logger: false });
}

export async function addAdmin(store, username = 'admin', password = ADMIN_PASSWORD) {
  return store.createAdmin({ username, passwordHash: await hashPassword(password) });
}

/** A tiny browser: keeps cookies and the latest CSRF token between requests. */
export class Browser {
  constructor(app, { ip = '127.0.0.1' } = {}) {
    this.app = app;
    this.ip = ip;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request({ method = 'GET', url, form, headers = {} }) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      payload: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.cookies) {
      const expired = c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now()) || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const token = /name="_csrf" value="([^"]+)"/.exec(res.body);
    if (token) this.csrf = token[1];
    return res;
  }

  get(url, headers) {
    return this.request({ url, headers });
  }

  /** POSTs a form, adding the current CSRF token unless the form sets _csrf itself. */
  post(url, form = {}, headers) {
    return this.request({ method: 'POST', url, form: { _csrf: this.csrf ?? '', ...form }, headers });
  }

  async login(username = 'admin', password = ADMIN_PASSWORD) {
    await this.get('/admin/login');
    return this.post('/admin/login', { username, password });
  }
}
