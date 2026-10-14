# pstryk

[![CI/CD](https://github.com/grzegorz-grzeda/pstryk/actions/workflows/ci.yml/badge.svg)](https://github.com/grzegorz-grzeda/pstryk/actions/workflows/ci.yml)

A flick of a switch. Pstryk is a small self-hosted service that turns
token-protected webhooks into MQTT messages.

```
phone / script / IFTTT / Home Assistant
        │  POST https://pstryk.example.com/h/garage-open
        │  Authorization: Bearer pstk_…
        ▼
     Pstryk ── checks the token, renders the hook's actions
        │
        ▼
   MQTT broker ──▶ ESP32, Zigbee2MQTT, Home Assistant, …
```

- **Hooks**: each has a URL (`/h/<name>`), one or more MQTT publish **actions** and one or more **tokens**.
- **Tokens**: random, shown once, stored only as hashes, labelled per caller and revocable individually.
- **Templates**: topics and payloads are filled from the request, e.g. `home/{{body.room}}/light`, with
  guards so callers can't escape the configured topic.
- **Dashboard** at `/admin`: call volume over 24 h / 7 days / 30 days (delivered vs failed), success rate,
  per-hook activity, latest calls, failed sign-ins, and MQTT/database status.
- **Admin UI**: manage hooks, actions and tokens, test-fire hooks, and browse each hook's recent calls.
- **Hardened admin sign-in**: scrypt-hashed passwords, optional two-factor authentication (TOTP), account
  and IP lockouts, server-side sessions with timeouts, CSRF protection, a strict Content Security Policy,
  multiple admins and an audit log.
- **Stack**: Node.js 22, Fastify, MongoDB (Atlas), mqtt.js, Docker and Caddy.

## Quick example

Create a hook `lights` in the admin UI with this action:

- Topic: `home/{{body.room}}/light/set`
- Payload: `{"state": {{body.state|json}}}`

Then create a token and call the hook:

```sh
curl -X POST https://pstryk.example.com/h/lights \
  -H "Authorization: Bearer pstk_…" \
  -H "Content-Type: application/json" \
  -d '{"room": "kitchen", "state": "ON"}'
# → {"ok":true,"published":1}   and   home/kitchen/light/set  {"state": "ON"}
```

## Documentation

| | |
|---|---|
| [Webhook API & templates](docs/api.md) | Authentication, request formats, status codes, template syntax and examples |
| [Deployment](docs/deployment.md) | VPS + Atlas setup, automatic deploys from GitHub Actions, broker options, operations |
| [Admin security](docs/security.md) | How sign-in, sessions, 2FA and lockouts work; the recovery CLI |
| [Versioning & releases](docs/releasing.md) | SemVer policy, changelog rules, how to cut a release |
| [Development](docs/development.md) | Running locally, tests, code layout, design notes |
| [`.env.example`](.env.example) | Every configuration variable, with comments |

## Quick start

```sh
git clone https://github.com/grzegorz-grzeda/pstryk.git && cd pstryk
cp .env.example .env    # set domain, MongoDB URI, MQTT URL and the first admin's password
docker compose up -d
```

Open `https://<your-domain>/admin`, sign in, and turn on two-factor authentication under **Account**.
See [deployment](docs/deployment.md) for the full guide.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Versions follow [Semantic Versioning 2.0.0](https://semver.org/).

## License

[MIT](LICENSE)
