# Admin security

The admin area at `/admin` controls every hook and token, so it gets several layers of protection.
This page explains what each layer does and how to recover when you're locked out.

## Accounts

- Several admins can exist, and they all have full rights. Add and remove them under **Users**.
  Adding an admin requires your own password.
- The **first** admin is created from `ADMIN_USER`/`ADMIN_PASSWORD` on the first start only.
  After that, those variables are ignored and a warning asks you to remove the password from the environment.
- Usernames are lowercase (`a-z 0-9 . - _`) and sign-in is case-insensitive.
- **Password rules:** 12–256 characters, must not contain the username, and must not be overly
  repetitive. Long passphrases work well.
- Passwords are hashed with **scrypt** (N=2¹⁵, r=8, p=1, 16-byte random salt), which is deliberately slow
  and memory-hard. Unknown usernames go through the same work, so response timing doesn't reveal which
  accounts exist.

## Signing in

```
username + password ──▶ correct? ──▶ 2FA on? ── no ──▶ signed in
                                        │
                                       yes ──▶ 6-digit code ──▶ signed in
```

- A wrong username and a wrong password produce the same message: "Invalid username or password."
- **Two-factor authentication (TOTP)** is optional per admin, and strongly recommended. Turn it on under
  **Account**: scan the QR code with any authenticator app, then confirm with your password and a code.
  - Codes are accepted for ±30 seconds to allow for clock drift, and each code works only once.
  - Five wrong codes end the sign-in attempt, and they also count towards the lockout below.
  - Between the password and the code, the half-signed-in session can do nothing but submit a code,
    and it expires after 5 minutes.
  - Turning 2FA on signs out your other sessions. Turning it off requires your password and a current code.

## Brute-force protection

| Layer | Limit | Effect |
|---|---|---|
| Request rate limit | 10 sign-in POSTs per minute per IP (300/min for the whole admin area) | HTTP 429 |
| Account lockout | 5 failures for one username within 15 min | That username is locked for 15 min, from every IP, **even with the right password** |
| IP lockout | 20 failures from one IP within 15 min, any usernames | That IP is locked for 1 hour |

- Failures include wrong passwords, wrong 2FA codes, and wrong "current password" entries on the account
  and users pages. A stolen session therefore can't be used to guess the password either.
- Locks apply to any username string, existing or not, so a lockout doesn't reveal whether an account exists.
- Counters are stored in MongoDB, so they survive restarts and expire automatically.
- Every failure and lockout appears in the **Audit log**.

> Lockouts rely on the real client IP. Behind Caddy, `TRUST_PROXY=true` is required (the Compose file
> sets it). Never set it when Pstryk is reachable directly, because clients could then fake their IP
> with an `X-Forwarded-For` header.

## Sessions

- Sessions are stored server-side. The cookie holds a random 256-bit ID, and the database stores only its
  SHA-256 hash.
- A session ends after `SESSION_IDLE_MINUTES` of inactivity (default 30) and at the latest after
  `SESSION_MAX_HOURS` (default 12). Signing out deletes it on the server, so an old cookie is useless.
- A new session ID is issued at sign-in and again after the 2FA step (prevents session fixation).
- **Cookie:** `__Host-pstryk_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, and no
  `Max-Age`, so it is gone when the browser closes. The `__Host-` prefix and `Secure` are dropped only
  when `COOKIE_SECURE=false`, which is meant for local development over plain HTTP.
- **Account → Active sessions** lists your sessions with IP, browser and last activity, and lets you
  sign out any of them, or all except the current one.
- Changing your password signs out all your other sessions.

## Request protections

| Protection | How |
|---|---|
| CSRF | Every form carries a per-session token, checked on every POST. Cross-site POSTs are also refused based on `Sec-Fetch-Site`/`Origin`, and the cookie is `SameSite=Strict`. |
| XSS | All output is HTML-escaped. The Content Security Policy allows only this site's own CSS and JS, with no inline scripts or styles. |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| Caching | `Cache-Control: no-store` on every admin response, so new tokens and pages never land in caches |
| Other headers | `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy`/`-Resource-Policy: same-origin`, `Permissions-Policy`. Caddy adds HSTS. |
| Messages | Notices on the sign-in page come from a fixed list, so links can't inject text |

## Audit log

The **Audit log** page shows the latest 200 events, and events are kept for 180 days. It records:
sign-ins (successful, failed, locked out, wrong 2FA code), sign-outs, password and 2FA changes, ended
sessions, admins added or removed, hooks, actions and tokens created, changed or removed, and test fires.
Each entry has the time, the admin, the IP and details. Token values and passwords are never logged.

## Recovery: the command-line tool

If nobody can sign in (forgotten password, lost phone, lockout), use the CLI on the server. It talks
directly to MongoDB:

```sh
docker compose exec pstryk node src/cli.js list-admins
docker compose exec pstryk node src/cli.js reset-password <username>   # also clears the lockout and ends sessions
docker compose exec pstryk node src/cli.js disable-2fa <username>      # lost authenticator
docker compose exec pstryk node src/cli.js unlock <username>           # clear an account lockout
docker compose exec pstryk node src/cli.js revoke-sessions <username>  # sign them out everywhere
docker compose exec pstryk node src/cli.js create-admin <username>
```

Passwords are typed at a hidden prompt; they never appear in arguments or the shell history.
CLI actions are recorded in the audit log with `cli` as the actor.

## Known limits

- **One role:** every admin can do everything, including deleting other admins.
- **TOTP secrets** are stored unencrypted in MongoDB. Someone with database access already controls all
  hooks, so protect the database credentials and the Atlas IP allowlist.
- **No recovery codes for 2FA.** Recovery goes through the CLI, which requires server access.
- **No email.** There is no "forgot password" link; use the CLI.
- For an extra layer, restrict `/admin` to your VPN; see the hardening checklist in
  [deployment.md](deployment.md#hardening-checklist).
