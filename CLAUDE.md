# Pstryk

Self-hosted service that turns token-protected webhooks (`/h/<name>`) into MQTT publishes, with an
admin UI at `/admin`. Node.js 22 (ESM, no build step), Fastify 5, MongoDB driver, mqtt.js.

## Commands

```sh
npm test        # node:test, all of test/*.test.js; no external services needed (~15 s, scrypt is slow on purpose)
npm run lint    # ESLint flat config; CI fails on any error
node --test test/admin.test.js   # one file
node src/cli.js --help           # admin account recovery CLI (needs MONGODB_URI)
```

Run lint and tests before every commit; CI (`.github/workflows/ci.yml`) runs both, then builds the
Docker image, and on `main` publishes to ghcr.io and deploys over SSH.

## Layout

- `src/server.js` wires config → `MongoStore` → first-admin bootstrap → MQTT publisher → `buildApp`.
- `src/app.js` builds the Fastify app with **injected** `store` and `publisher` (tests pass fakes).
- `src/routes/webhook.js`: the public endpoint. `src/routes/admin/*`: the admin area, where `index.js`
  holds the security headers, rate limit, cross-site check, and the session + CSRF gate for everything
  except `auth.js`.
- `src/auth/*`: passwords (scrypt), sessions, login throttling, TOTP, first-admin bootstrap.
- `src/views/*`: HTML via the `html` tagged template in `views/html.js`, which auto-escapes interpolations.
- `src/store.js`: `MongoStore` and `MemoryStore` with the **same interface**.
- Docs live in `docs/` (api, deployment, security, development). Update them when behaviour changes.

## Rules that are easy to break

- **Both stores, always.** Any new store method goes into `MongoStore` and `MemoryStore`. Tests only
  exercise `MemoryStore`, because MongoDB binaries can't be downloaded in the sandbox
  (mongodb-memory-server fails), so review Mongo queries carefully against the driver API. Example:
  `Collection` has no `.db` property; use `this.db`. `MemoryStore` must return clones
  (`structuredClone`), never live objects.
- **Strict CSP on /admin:** `script-src 'self'; style-src 'self'`. No inline `<script>`, `<style>`,
  `style="…"`, or `on*=` attributes. Styling goes in `src/static/admin.css` (use classes; for SVG,
  colour via classes, not `fill` attributes), behaviour in `src/static/admin.js`. A test scans pages
  for inline code. Add any new admin page to that list in `test/admin.test.js`.
- **Every admin POST form** needs `${csrfField(csrf)}`; the gate rejects POSTs without a valid `_csrf`.
- **Escape by default:** interpolate through `html\`…\``. Only wrap in `SafeHtml` for markup you
  built yourself, never for user input. In browser JS, use `textContent`, never `innerHTML`.
- **Audit admin changes:** state-changing admin routes call `audit(request, '<area>.<verb>', detail)`,
  and new action names get a label in `AUDIT_LABELS` (`src/views/account.js`). Never log tokens or passwords.
- **Webhook semantics:** unknown hook and bad token must stay indistinguishable (same 401 body). All
  actions are rendered before any publish (all-or-nothing). Template values in topics may not contain
  `/ + #`.
- **Flash messages** go through the session (`redirectWith`), never through query strings with free
  text. The login page's `?m=` only maps to fixed messages.
- **Times** are shown in UTC.

## Testing patterns

- `test/helpers.js`: `createApp({ store, publisher, config })`, `addAdmin(store)`, a fake publisher
  that records messages, and `Browser`, a cookie-keeping client that picks up the CSRF token from the
  last HTML response (`browser.login()`, `browser.get()`, `browser.post(url, form)`).
- `test/app.test.js` uses a real in-process MQTT broker (aedes) for webhook end-to-end tests.
- `app.inject` doesn't send browser headers. When touching the cross-site check, test the
  `Origin: null` / `Sec-Fetch-Site` combinations explicitly; a real browser once revealed a bug the tests missed.
- For UI changes, render the page and look at it (Playwright and Chromium are preinstalled in cloud
  sessions): start an app over `MemoryStore` with seeded data, sign in, and screenshot it in light,
  dark and phone (390 px) views.

## Git

- `main` is protected by convention: work on a branch and open a PR. Merging to `main` deploys
  (once `DEPLOY_HOST` is configured).
- The repo is public. Never commit `.env`, credentials or real hostnames.
