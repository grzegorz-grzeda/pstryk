# Changelog

All notable changes to Pstryk are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.y.z`, Pstryk is in initial development and any release may contain
breaking changes; these are called out under **Changed** or **Removed**.

## [Unreleased]

## [0.1.0] - 2026-10-14

First release.

### Added

- **Webhooks:** `GET`/`POST /h/<name>` publish a hook's MQTT messages. Accepts JSON, form and
  plain-text bodies. Responses distinguish published (200), bad input (400), unauthorized (401),
  disabled hook (409), body too large (413), rate-limited (429) and broker unavailable (503).
- **Tokens:** per-caller, labelled tokens (`pstk_…`), shown once, stored as SHA-256 hashes and
  revocable individually. Accepted as `Authorization: Bearer`, `X-Pstryk-Token`, or `?token=` when
  `ALLOW_QUERY_TOKEN=true`. Unknown hooks and bad tokens are indistinguishable.
- **Actions:** each hook publishes one or more MQTT messages in order, with QoS 0–2 and retain.
  All actions are rendered before any is published, so a call publishes all of its messages or none.
- **Templates:** `{{body.x}}`, `{{query.x}}`, `{{hook.name}}`, `{{now}}`, `{{ts}}` and the `|json`
  filter in topics and payloads. Values inserted into topics can't contain `/`, `+` or `#`.
- **Admin UI** at `/admin`:
  - Create, edit, enable/disable and delete hooks.
  - Add, edit in place and remove actions.
  - Create and revoke tokens.
  - Test-fire hooks and see each hook's recent calls.
- **Dashboard:** call volume over 24 hours, 7 days or 30 days (delivered vs failed) with tooltips and
  a table view; success rate; per-hook activity; latest calls; failed sign-ins; MQTT and database status.
- **Admin accounts and security:**
  - Sign-in page with scrypt-hashed passwords and optional TOTP two-factor authentication.
  - Server-side sessions with idle and absolute timeouts, on hardened cookies.
  - Per-username and per-IP lockouts, plus rate limiting.
  - CSRF tokens, a strict Content Security Policy and security headers.
  - Multiple admins, an account page (password, 2FA, active sessions) and an audit log.
- **Recovery CLI** (`node src/cli.js`): list and create admins, reset passwords, disable 2FA,
  clear lockouts, end sessions.
- **Deployment:** Docker image, Docker Compose with Caddy (automatic HTTPS) and optional Mosquitto,
  MongoDB Atlas support, and `/healthz`.
- **CI/CD:** GitHub Actions for lint, tests, image build, publishing to `ghcr.io` and deploying to a VPS
  over SSH; Dependabot updates.
- **Documentation:** webhook API, deployment, admin security and development guides.

[Unreleased]: https://github.com/grzegorz-grzeda/pstryk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/grzegorz-grzeda/pstryk/releases/tag/v0.1.0
