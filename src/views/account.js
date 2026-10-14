import { MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { csrfField, fmtDate, html } from './html.js';

const passwordInput = (name, label, autocomplete) =>
  html`<label>${label}<input type="password" name="${name}" required maxlength="256" autocomplete="${autocomplete}"></label>`;

const newPasswordInput = (name = 'newPassword', label = 'New password') =>
  html`<label>${label} <span class="muted">(at least ${MIN_PASSWORD_LENGTH} characters)</span><input type="password" name="${name}" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="256" autocomplete="new-password"></label>`;

export function accountPage({ admin, csrf, sessions, currentSessionId, enrollment }) {
  return html`
<section>
  <h2>Account</h2>
  <p class="mb0">Signed in as <strong>${admin.username}</strong>.
  Last sign-in before this one: ${fmtDate(admin.previousLoginAt)}${admin.previousLoginIp ? html` from <code>${admin.previousLoginIp}</code>` : ''}.
  Password last changed ${fmtDate(admin.passwordChangedAt)}.</p>
</section>

<section>
  <h2>Change password</h2>
  <form class="stack" method="post" action="/admin/account/password">
    ${csrfField(csrf)}
    ${passwordInput('currentPassword', 'Current password', 'current-password')}
    ${newPasswordInput()}
    ${newPasswordInput('confirmPassword', 'Repeat new password')}
    <p class="muted mb0">Changing your password signs out all your other sessions.</p>
    <div><button type="submit">Change password</button></div>
  </form>
</section>

<section>
  <h2>Two-factor authentication</h2>
  ${admin.totpSecret
    ? html`<p><span class="badge ok">enabled</span> A code from your authenticator app is required at every sign-in.</p>
      <form class="stack" method="post" action="/admin/account/2fa/disable" data-confirm="Turn off two-factor authentication?">
        ${csrfField(csrf)}
        ${passwordInput('password', 'Current password', 'current-password')}
        <label>Current 6-digit code<input type="text" name="code" required inputmode="numeric" maxlength="7" autocomplete="one-time-code"></label>
        <div><button class="danger" type="submit">Turn off 2FA</button></div>
      </form>`
    : enrollment
      ? html`<p>Scan this QR code with an authenticator app (Aegis, Google Authenticator, 1Password, Bitwarden, …), then enter the code it shows.</p>
        <img class="qr" src="${enrollment.qr}" alt="QR code for the authenticator app">
        <p class="muted">Can't scan it? Enter this key manually: <code id="totp-secret">${enrollment.secret}</code>
          <button class="ghost" type="button" data-copy="#totp-secret">Copy</button></p>
        <form class="stack" method="post" action="/admin/account/2fa/confirm">
          ${csrfField(csrf)}
          ${passwordInput('password', 'Current password', 'current-password')}
          <label>6-digit code<input type="text" name="code" required inputmode="numeric" maxlength="7" autocomplete="one-time-code"></label>
          <div><button type="submit">Turn on 2FA</button></div>
        </form>`
      : html`<p><span class="badge">off</span> Recommended: require a code from an authenticator app in addition to your password.</p>
        <form method="post" action="/admin/account/2fa/start">${csrfField(csrf)}<button type="submit">Set up 2FA</button></form>`}
</section>

<section>
  <h2>Active sessions</h2>
  <div class="scroll"><table>
    <tr><th>Signed in</th><th>Last active</th><th>IP</th><th>Browser</th><th></th></tr>
    ${sessions.map((s) => html`<tr>
      <td>${fmtDate(s.createdAt)}</td><td>${fmtDate(s.lastSeenAt)}</td><td><code>${s.ip}</code></td>
      <td class="muted">${s.userAgent}</td>
      <td>${s._id === currentSessionId
        ? html`<span class="badge ok">this session</span>`
        : html`<form class="inline" method="post" action="/admin/account/sessions/${s.ref}/revoke">${csrfField(csrf)}<button class="danger" type="submit">Sign out</button></form>`}</td>
    </tr>`)}
  </table></div>
  ${sessions.length > 1 ? html`<form class="mt" method="post" action="/admin/account/sessions/revoke-others">${csrfField(csrf)}<button class="danger" type="submit">Sign out all other sessions</button></form>` : ''}
</section>`;
}

export function usersPage({ admins, admin, csrf }) {
  return html`
<section>
  <h2>Admin users</h2>
  <p class="muted">Every admin has full access to hooks, tokens and other admins.</p>
  <div class="scroll"><table>
    <tr><th>Username</th><th>2FA</th><th>Created</th><th>Last sign-in</th><th></th></tr>
    ${admins.map((a) => html`<tr>
      <td><strong>${a.username}</strong>${a._id === admin._id ? html` <span class="muted">(you)</span>` : ''}</td>
      <td>${a.totpSecret ? html`<span class="badge ok">on</span>` : html`<span class="badge">off</span>`}</td>
      <td>${fmtDate(a.createdAt)}</td>
      <td>${fmtDate(a.lastLoginAt)}${a.lastLoginIp ? html` <span class="muted">from ${a.lastLoginIp}</span>` : ''}</td>
      <td>${a._id === admin._id ? '' : html`<form class="inline" method="post" action="/admin/users/${a._id}/delete" data-confirm="Delete admin ${a.username}? Their sessions end immediately.">${csrfField(csrf)}<button class="danger" type="submit">Delete</button></form>`}</td>
    </tr>`)}
  </table></div>
</section>

<section>
  <h2>Add admin</h2>
  <form class="stack" method="post" action="/admin/users">
    ${csrfField(csrf)}
    <label>Username (a-z, 0-9, ., - and _)<input type="text" name="username" required maxlength="64" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    ${newPasswordInput('newPassword', 'Initial password')}
    ${passwordInput('currentPassword', 'Your current password (to confirm)', 'current-password')}
    <p class="muted mb0">Share the initial password over a secure channel and ask them to change it and set up 2FA.</p>
    <div><button type="submit">Add admin</button></div>
  </form>
</section>`;
}

const AUDIT_LABELS = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in',
  'login.locked': 'Sign-in blocked (locked out)',
  'login.mfa_failure': 'Wrong 2FA code',
  logout: 'Signed out',
  'password.change': 'Changed password',
  '2fa.enable': 'Turned on 2FA',
  '2fa.disable': 'Turned off 2FA',
  'session.revoke': 'Ended a session',
  'session.revoke_others': 'Ended all other sessions',
  'admin.create': 'Added admin',
  'admin.delete': 'Deleted admin',
  'hook.create': 'Created hook',
  'hook.update': 'Updated hook',
  'hook.delete': 'Deleted hook',
  'action.add': 'Added action',
  'action.remove': 'Removed action',
  'token.create': 'Created token',
  'token.revoke': 'Revoked token',
  'hook.test': 'Test-fired hook',
};

export function auditPage({ entries }) {
  return html`
<section>
  <h2>Audit log <span class="muted">(latest ${entries.length}, kept 180 days)</span></h2>
  ${entries.length === 0 ? html`<p class="muted">Nothing yet.</p>` : html`<div class="scroll"><table>
    <tr><th>When</th><th>Who</th><th>Event</th><th>Details</th><th>IP</th></tr>
    ${entries.map((e) => html`<tr>
      <td>${fmtDate(e.at)}</td>
      <td>${e.actor ?? html`<span class="muted">–</span>`}</td>
      <td class="${e.action.startsWith('login.') && e.action !== 'login.success' ? 'err' : ''}">${AUDIT_LABELS[e.action] ?? e.action}</td>
      <td>${Object.entries(e.detail ?? {}).map(([k, v]) => html`<span class="muted">${k}:</span> ${String(v)} `)}</td>
      <td><code>${e.ip}</code></td>
    </tr>`)}
  </table></div>`}
</section>`;
}
