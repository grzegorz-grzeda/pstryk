# Development

## Setup

Requires Node.js 22+.

```sh
npm install
npm test          # node:test, with no external services needed
npm run lint      # ESLint
```

To run the server you need a MongoDB database and an MQTT broker. A free Atlas cluster works, or use local containers:

```sh
docker run -d --name mongo -p 27017:27017 mongo:8
docker run -d --name mqtt -p 1883:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf

cat > .env <<'EOF'
MONGODB_URI=mongodb://localhost:27017
MQTT_URL=mqtt://localhost:1883
ADMIN_PASSWORD=local-dev-password
# Plain-HTTP PUBLIC_URL turns off Secure cookies automatically (COOKIE_SECURE=false).
PUBLIC_URL=http://localhost:3000
EOF

node --env-file=.env --watch src/server.js
```

Watch messages arrive with `mosquitto_sub -h localhost -t '#' -v`.

## Layout

```
src/
  server.js          entry point: config, MongoDB, MQTT, HTTP server, graceful shutdown
  app.js             builds the Fastify app (store and publisher are injected)
  config.js          environment variables → config object, with validation
  cli.js             admin account maintenance (reset password, disable 2FA, unlock, …)
  routes/webhook.js  /h/:name: token check, rendering, publishing, call logging
  routes/admin/
    index.js         admin area: security headers, rate limit, cross-site check, session + CSRF gate
    auth.js          sign-in, 2FA step, sign-out
    hooks.js         hooks, actions, tokens, test fire
    account.js       password change, 2FA setup, active sessions
    users.js         add and remove admins
    audit.js         audit log page
    util.js          form helpers and password re-confirmation
  auth/
    passwords.js     scrypt hashing and password policy
    sessions.js      server-side sessions (hashed IDs, idle and absolute timeouts)
    throttle.js      per-username and per-IP lockouts
    totp.js          RFC 6238 one-time codes
    bootstrap.js     creates the first admin from the environment
  views/             HTML templates (tagged template literals with auto-escaping)
  static/            admin.css and admin.js; no inline code, so the strict CSP holds
  template.js        {{ placeholder }} rendering and validation
  fire.js            renders all of a hook's actions, then publishes them
  tokens.js          token generation, hashing and constant-time matching
  mqtt.js            persistent MQTT connection; fails fast when disconnected
  store.js           MongoStore (production) and MemoryStore (tests)
test/
  template.test.js   template rendering and validation
  app.test.js        webhook end-to-end tests with a real MQTT client and an in-process broker (aedes)
  admin.test.js      admin end-to-end tests: sign-in, lockouts, sessions, CSRF, 2FA, users
  auth.test.js       password hashing, TOTP (RFC 6238 vectors), throttling
  cli.test.js        first-admin bootstrap and the CLI
  helpers.js         test app factory and a cookie-keeping "browser"
```

## Data model

One `hooks` document per hook, with actions and tokens embedded:

```js
{
  _id: "uuid",
  name: "lights",                // unique
  description: "Living room lights",
  enabled: true,
  actions: [{ id, topic, payload, qos: 0|1|2, retain: bool }],
  tokens:  [{ id, label, hash /* sha256 hex */, hint /* "pstk_ab12" */, createdAt, lastUsedAt }],
  createdAt
}
```

Admin-side collections:

| Collection | Contents | Expiry |
|---|---|---|
| `admins` | `{ username, passwordHash, totpSecret, totpLastStep, lastLoginAt, lastLoginIp, … }` | none |
| `sessions` | `{ _id: sha256(cookie), ref, adminId, stage, csrf, createdAt, lastSeenAt, expiresAt, ip, userAgent, flash }` | TTL on `expiresAt` |
| `login_throttle` | `{ _id: "user:<name>" or "ip:<addr>", count, firstAt, lockedUntil }` | TTL on `expiresAt` |
| `audit` | `{ at, action, actor, ip, detail }` | 180 days |

`calls` holds one document per authenticated webhook call or admin test fire:
`{ hookId, hookName, at, source /* token label */, ip, status, detail, published: [{topic, payload, qos, retain}] }`.
A TTL index on `at` expires these after `CALL_LOG_DAYS`.

## Design notes

- **Tokens** are 32 random bytes, so a fast SHA-256 hash is enough: there's nothing to brute-force, and
  a slow KDF would only make every webhook call slower. Each presented token is compared with all of
  the hook's tokens using `timingSafeEqual`.
- **All or nothing:** every action is rendered before the first publish, so a template error never
  leaves a half-applied set of messages.
- **Fail fast on MQTT:** when the broker is down, calls return 503 immediately instead of being queued
  and replayed later. A delayed "open the garage" is worse than a failed one.
- **The store interface** is a small set of async methods, so `MemoryStore` can stand in for MongoDB
  in tests. `MongoStore` itself isn't covered by the test suite. Exercise it against a real database
  when you change it.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs lint and tests on every push and pull
request, and checks that the Docker image builds. On `main` it also publishes the image and deploys
it (see [deployment.md](deployment.md)). Dependabot opens weekly update pull requests for npm
packages, Actions and the base image.
