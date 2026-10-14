# pstryk

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

- **Hooks** have a name (`/h/<name>`), one or more **actions** (MQTT publishes) and one or more **tokens**.
- **Tokens** are random, shown once, stored only as SHA-256 hashes, labelled (e.g. "phone") and revocable one by one.
- **Topics and payloads are templates** filled from the request: `home/{{body.room}}/light` → `home/kitchen/light`.
- **Admin UI** at `/admin` for managing hooks, actions and tokens, test-firing, and viewing recent calls.
- Storage is MongoDB (Atlas works well), and MQTT goes through one persistent connection that reconnects on its own.

## Calling a hook

```sh
curl -X POST https://pstryk.example.com/h/lights \
  -H "Authorization: Bearer pstk_…" \
  -H "Content-Type: application/json" \
  -d '{"room": "kitchen", "on": true}'
```

Supported methods are `GET` and `POST`. Bodies can be JSON, form-encoded or plain text.
The token can be sent as `Authorization: Bearer …` or `X-Pstryk-Token: …`, or, only if
`ALLOW_QUERY_TOKEN=true`, as `?token=…`. Avoid the query form where possible, because URLs end up in logs.

| Status | Meaning |
|---|---|
| 200 | `{"ok": true, "published": n}` |
| 400 | A template needed a value the request didn't provide, or a topic value contained `/`, `+` or `#` |
| 401 | Unknown hook or bad token (deliberately indistinguishable) |
| 409 | Hook is disabled |
| 413 | Body larger than `BODY_LIMIT` |
| 429 | Rate limit exceeded |
| 503 | MQTT broker not connected; nothing was published |

All actions are rendered before any is published, so a bad request publishes nothing.

## Templates

| Placeholder | Value |
|---|---|
| `{{body.x.y}}` | Field from the request body (JSON or form). With a text body, `{{body}}` is the whole text. |
| `{{query.x}}` | Query string parameter |
| `{{hook.name}}` | Name of the hook |
| `{{now}}` / `{{ts}}` | ISO timestamp / epoch milliseconds |
| `{{… \| json}}` | JSON-encode the value. Use it for strings inside JSON payloads: `{"msg": {{body.msg\|json}}}` |

Objects and arrays are always inserted as JSON. A missing value is an error (400).
Values inserted into a **topic** may not contain `/`, `+` or `#`, so a caller can't
redirect a message to a topic outside what you configured. Topics may not contain
wildcards or start with `$`.

## Running locally

Requires Node.js 22+, a MongoDB database and an MQTT broker.

```sh
npm install
cp .env.example .env    # fill in MONGODB_URI, MQTT_URL, ADMIN_PASSWORD
node --env-file=.env src/server.js
```

Open http://localhost:3000/admin.

```sh
npm test   # uses an in-process MQTT broker and an in-memory store; no external services needed
```

## Deploying to a VPS

Any small VPS works: 1 vCPU, 1 GB RAM and a few GB of disk is plenty. Data lives in Atlas,
and the images and logs need well under 1 GB.

1. Point a DNS record (e.g. `pstryk.example.com`) at the VPS and open ports 80 and 443.
2. In **MongoDB Atlas**:
   - Create a database user.
   - Add the VPS public IP under **Network Access**.
   - Copy the `mongodb+srv://…` connection string.
3. On the VPS:

   ```sh
   git clone https://github.com/grzegorz-grzeda/pstryk && cd pstryk
   cp .env.example .env && nano .env
   docker compose up -d --build
   ```

   Caddy obtains a Let's Encrypt certificate for `PSTRYK_DOMAIN` automatically.
4. Open `https://pstryk.example.com/admin`, create a hook, add an action, create a token and try it with curl.

`GET /healthz` returns `{"ok", "db", "mqtt"}` and is used by the container healthcheck.

### Where should the broker live?

- **Existing broker at home:** don't expose port 1883 to the internet. Connect the VPS to your home network with
  [Tailscale](https://tailscale.com) or WireGuard, and set `MQTT_URL=mqtt://<tailscale-ip>:1883`.
- **Hosted broker** (HiveMQ Cloud, EMQX Cloud, …): use its `mqtts://…:8883` URL and credentials.
- **Broker on the same VPS:** create a password file, then start with the `broker` profile:

  ```sh
  docker run --rm -it -v "$PWD/deploy/mosquitto:/m" eclipse-mosquitto:2 \
    mosquitto_passwd -c /m/passwd pstryk
  docker compose --profile broker up -d --build
  ```

  Set `MQTT_URL=mqtt://mosquitto:1883` and the matching `MQTT_USERNAME`/`MQTT_PASSWORD`. This broker is only
  reachable inside Docker. If devices outside the VPS need it, add a TLS listener (8883) before publishing the port.

## Configuration

All configuration is through environment variables. See [`.env.example`](.env.example).

| Variable | Default | |
|---|---|---|
| `MONGODB_URI` | required | MongoDB connection string |
| `MONGODB_DB` | `pstryk` | Database name |
| `MQTT_URL` | required | `mqtt://`, `mqtts://`, `ws://` or `wss://` |
| `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID` | | Broker credentials |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / required | Admin UI login. The password must be at least 12 characters. |
| `PUBLIC_URL` | | Used in the example curl commands in the UI |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so client IPs are logged correctly. The Compose file sets it. |
| `ALLOW_QUERY_TOKEN` | `false` | Accept `?token=` |
| `RATE_LIMIT_MAX` | `60` | Webhook requests per minute per IP |
| `BODY_LIMIT` | `65536` | Max body size in bytes |
| `CALL_LOG_DAYS` | `30` | Call history retention (MongoDB TTL index) |
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` | |

## Security notes

- Serve Pstryk only over HTTPS. The Compose setup does this with Caddy.
- The admin UI uses HTTP Basic auth and rejects cross-site form posts. If you want an extra layer,
  restrict `/admin` to your Tailscale network in the Caddyfile.
- Give each caller its own token, so you can revoke one without touching the others.
