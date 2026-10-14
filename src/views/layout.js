import { VERSION } from '../version.js';
import { csrfField, html } from './html.js';

const NAV = [
  ['dashboard', '/admin', 'Dashboard'],
  ['hooks', '/admin/hooks', 'Hooks'],
  ['users', '/admin/users', 'Users'],
  ['audit', '/admin/audit', 'Audit log'],
  ['account', '/admin/account', 'Account'],
];

/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {{ error?: string, info?: string }} [opts.flash]
 * @param {object} [opts.admin] signed-in admin; omit on the login pages
 * @param {string} [opts.csrf]
 * @param {string} [opts.active] key of the active nav item
 * @param {boolean} [opts.mqttConnected]
 */
export function layout({ title, flash, admin, csrf, active, mqttConnected }, body) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · Pstryk` : 'Pstryk'}</title>
<link rel="stylesheet" href="/admin/static/admin.css">
<script src="/admin/static/admin.js" defer></script>
</head>
<body><main>
${admin
  ? html`<header>
  <a href="/admin">Pstryk</a>
  <span class="status ${mqttConnected ? 'ok' : 'err'}">● MQTT ${mqttConnected ? 'connected' : 'disconnected'}</span>
  <nav>
    ${NAV.map(([key, href, label]) => html`<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`)}
    <span class="muted">${admin.username}</span>
    <form method="post" action="/admin/logout">${csrfField(csrf)}<button class="ghost" type="submit">Sign out</button></form>
  </nav>
</header>`
  : ''}
${flash?.error || flash?.info
  ? html`<div class="${admin ? '' : 'narrow'}">
  ${flash.error ? html`<div class="flash err" role="alert">${flash.error}</div>` : ''}
  ${flash.info ? html`<div class="flash" role="status">${flash.info}</div>` : ''}
</div>`
  : ''}
${body}
${admin ? html`<footer class="muted">Pstryk ${VERSION}</footer>` : ''}
</main></body></html>`;
}
