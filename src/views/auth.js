import { csrfField, html } from './html.js';

export function loginPage({ username } = {}) {
  return html`
<section class="auth">
  <h1>Pstryk</h1>
  <p class="muted">Sign in to manage hooks.</p>
  <form class="stack" method="post" action="/admin/login">
    <label>Username<input type="text" name="username" required maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus value="${username ?? ''}"></label>
    <label>Password<input type="password" name="password" required maxlength="256" autocomplete="current-password"></label>
    <div><button type="submit">Sign in</button></div>
  </form>
</section>`;
}

export function mfaPage({ csrf }) {
  return html`
<section class="auth">
  <h1>Two-factor authentication</h1>
  <p class="muted">Enter the 6-digit code from your authenticator app.</p>
  <form class="stack" method="post" action="/admin/login/2fa">
    ${csrfField(csrf)}
    <label>Code<input type="text" name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" autofocus></label>
    <div class="row-actions"><button type="submit">Verify</button></div>
  </form>
  <form method="post" action="/admin/logout" class="mt">${csrfField(csrf)}<button class="ghost" type="submit">Cancel</button></form>
</section>`;
}
