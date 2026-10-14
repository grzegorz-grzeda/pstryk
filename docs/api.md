# Webhook API

## Endpoint

```
GET|POST /h/<hook-name>
```

Hook names are 1–64 characters: lowercase letters, digits, `-` and `_`, starting with a letter or digit.

### Authentication

Send a token for the hook in one of these ways:

| How | Example |
|---|---|
| Bearer header (preferred) | `Authorization: Bearer pstk_…` |
| Custom header | `X-Pstryk-Token: pstk_…` |
| Query string (only when `ALLOW_QUERY_TOKEN=true`) | `/h/lights?token=pstk_…` |

Tokens belong to a single hook, so a token for `lights` won't open `garage`.
Avoid the query string form where possible: URLs end up in proxy logs, browser history and the
caller's own logs. The `token` parameter is removed before templates see the query string.

### Request body

| `Content-Type` | Available in templates as |
|---|---|
| `application/json` | `body` is the parsed JSON |
| `application/x-www-form-urlencoded` | `body` is an object of form fields |
| `text/plain` | `body` is the whole text |
| none (e.g. `GET`) | `body` is `{}` |

Bodies larger than `BODY_LIMIT` (64 KiB by default) are rejected.

### Responses

All responses are JSON.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok": true, "published": 2}` | All actions were published |
| 400 | `{"ok": false, "error": "Missing value for {{body.on}}"}` | A template couldn't be filled. Nothing was published. |
| 401 | `{"ok": false, "error": "unauthorized"}` | Unknown hook or wrong token. The two cases are indistinguishable on purpose. |
| 409 | `{"ok": false, "error": "hook disabled"}` | The token is valid but the hook is switched off |
| 413 | | Body too large |
| 415 | | Unsupported `Content-Type` |
| 429 | | Rate limit exceeded (`RATE_LIMIT_MAX` requests per minute per IP) |
| 503 | `{"ok": false, "error": "MQTT broker is not connected"}` | The broker is unreachable. Retry later. |

Every authenticated call is recorded in the hook's call log, which is visible in the admin UI.
Calls with a bad token are only written to the application log.

## Templates

Each action has a **topic** and a **payload** template. Placeholders use `{{ path }}`:

| Placeholder | Value |
|---|---|
| `{{body}}`, `{{body.a.b}}` | The request body, or a field inside it |
| `{{query.x}}` | Query string parameter |
| `{{hook.name}}` | The hook's name |
| `{{now}}` | Current time, ISO 8601 (`2026-10-14T21:03:00.000Z`) |
| `{{ts}}` | Current time, epoch milliseconds |

How values are inserted:

- Strings are inserted as they are, and numbers and booleans as text.
- Objects, arrays and `null` are inserted as JSON.
- Add `|json` to JSON-encode any value. Use it for strings inside JSON payloads, so quotes are escaped:
  `{"msg": {{body.msg|json}}}`.
- A placeholder whose value is missing makes the call fail with 400.

### Topic rules

When the admin saves an action, its topic is checked. It must not be empty, contain `+` or `#`, start
with `$`, or be longer than 1024 bytes.

When a call comes in, values inserted into a topic must not contain `/`, `+`, `#` or a null character.
This keeps callers inside the topic structure you configured: with `home/{{body.room}}/light`,
`room` can be `kitchen` but not `kitchen/../alarm` or `#`.

### Examples

Turn a light on or off (Zigbee2MQTT style):

| | |
|---|---|
| Topic | `zigbee2mqtt/{{body.room}}_light/set` |
| Payload | `{"state": {{body.state\|json}}}` |
| Call | `curl -X POST …/h/light -H "Authorization: Bearer …" -H "Content-Type: application/json" -d '{"room":"kitchen","state":"ON"}'` |

Fixed command with no input, e.g. a garage door:

| | |
|---|---|
| Topic | `home/garage/cmd` |
| Payload | `open` |
| Call | `curl -X POST …/h/garage-open -H "Authorization: Bearer …"` |

Forward the whole request plus metadata:

| | |
|---|---|
| Topic | `events/{{hook.name}}` |
| Payload | `{"at": "{{now}}", "data": {{body}}}` |

## Health check

```
GET /healthz  →  200 {"ok": true, "db": true, "mqtt": true}
              →  503 when MongoDB or MQTT is unreachable
```

It needs no authentication and reveals nothing beyond connectivity.
