// Server-rendered admin pages. `html` escapes every interpolated value unless it is
// already a SafeHtml (another html`` fragment) or an array of them.

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escape(value);
}

export function html(strings, ...values) {
  return new SafeHtml(strings.reduce((out, str, i) => out + str + (i < values.length ? interpolate(values[i]) : ''), ''));
}

const fmtDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'never');

const STYLE = `
:root { --bg:#f7f7f5; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e3e3de; --accent:#d4561c; --ok:#2f7d32; --err:#b3261e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1e1e1c; --text:#ececea; --muted:#9b9b95; --line:#33332f; --accent:#f07a42; --ok:#6bbf6e; --err:#f2786f; } }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--text); }
main { max-width:960px; margin:0 auto; padding:24px 16px 64px; }
header { display:flex; align-items:baseline; gap:12px; margin-bottom:24px; }
header a { color:inherit; text-decoration:none; font-weight:700; font-size:22px; }
header span { color:var(--muted); }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:20px; }
h2 { font-size:16px; margin:0 0 12px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
.scroll { overflow-x:auto; }
code, pre, textarea, input[type=text] { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; }
pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; overflow-x:auto; white-space:pre-wrap; word-break:break-all; margin:0; }
form.row { display:flex; flex-wrap:wrap; gap:8px; align-items:end; }
form.stack { display:grid; gap:10px; }
label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
input[type=text], input[type=password], textarea, select { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
textarea { min-height:80px; }
button { padding:7px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
button.ghost { background:transparent; color:var(--text); border-color:var(--line); }
button.danger { background:transparent; color:var(--err); border-color:var(--err); }
.muted { color:var(--muted); }
.badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; border:1px solid var(--line); }
.ok { color:var(--ok); } .err { color:var(--err); }
.flash { padding:10px 14px; border-radius:8px; margin-bottom:20px; border:1px solid var(--line); background:var(--card); }
.flash.err { border-color:var(--err); }
.secret { border:2px solid var(--accent); }
.inline { display:inline; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; }
`;

export function layout({ title, flash, error, mqttConnected }, body) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · Pstryk` : 'Pstryk'}</title>
<style>${new SafeHtml(STYLE)}</style>
</head>
<body><main>
<header><a href="/admin">Pstryk</a><span>a flick of a switch</span>
<span style="margin-left:auto" class="${mqttConnected ? 'ok' : 'err'}">● MQTT ${mqttConnected ? 'connected' : 'disconnected'}</span></header>
${error ? html`<div class="flash err">${error}</div>` : ''}
${flash ? html`<div class="flash">${flash}</div>` : ''}
${body}
</main></body></html>`;
}

export function hooksPage({ hooks }) {
  return html`
<section>
  <h2>Hooks</h2>
  ${hooks.length === 0
    ? html`<p class="muted">No hooks yet. Create one below.</p>`
    : html`<div class="scroll"><table>
      <tr><th>Name</th><th>Description</th><th>Actions</th><th>Tokens</th><th>Status</th></tr>
      ${hooks.map((h) => html`<tr>
        <td><a href="/admin/hooks/${h._id}"><code>${h.name}</code></a></td>
        <td>${h.description}</td>
        <td>${h.actions.length}</td>
        <td>${h.tokens.length}</td>
        <td>${h.enabled ? html`<span class="badge ok">enabled</span>` : html`<span class="badge">disabled</span>`}</td>
      </tr>`)}
    </table></div>`}
</section>
<section>
  <h2>New hook</h2>
  <form class="row" method="post" action="/admin/hooks">
    <label style="flex:1 1 180px">Name (a-z, 0-9, - and _)<input type="text" name="name" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}" placeholder="garage-open"></label>
    <label style="flex:3 1 260px">Description<input type="text" name="description" placeholder="Opens the garage door"></label>
    <button type="submit">Create</button>
  </form>
</section>`;
}

export function hookPage({ hook, calls, publicUrl, newToken, testResult, testBody, allowQueryToken }) {
  const url = `${publicUrl || ''}/h/${hook.name}`;
  return html`
<section>
  <h2><code>${hook.name}</code></h2>
  <form class="stack" method="post" action="/admin/hooks/${hook._id}/update">
    <label>Description<input type="text" name="description" value="${hook.description}"></label>
    <label style="display:flex; gap:8px; align-items:center; color:var(--text)"><input type="checkbox" name="enabled" ${hook.enabled ? 'checked' : ''}> Enabled</label>
    <div><button type="submit">Save</button></div>
  </form>
  <p class="muted" style="margin-bottom:6px">Call it with:</p>
  <pre>curl -X POST ${url} \\
  -H "Authorization: Bearer &lt;token&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"example": "value"}'</pre>
  ${allowQueryToken ? html`<p class="muted">Query tokens are enabled: <code>${url}?token=&lt;token&gt;</code> also works, but the token will appear in logs.</p>` : ''}
</section>

<section>
  <h2>Actions <span class="muted">(MQTT publish, in order)</span></h2>
  ${hook.actions.length === 0 ? html`<p class="muted">No actions yet, so calls publish nothing.</p>` : html`<div class="scroll"><table>
    <tr><th>Topic</th><th>Payload</th><th>QoS</th><th>Retain</th><th></th></tr>
    ${hook.actions.map((a) => html`<tr>
      <td><code>${a.topic}</code></td>
      <td><pre>${a.payload}</pre></td>
      <td>${a.qos}</td>
      <td>${a.retain ? 'yes' : 'no'}</td>
      <td><form class="inline" method="post" action="/admin/hooks/${hook._id}/actions/${a.id}/delete"><button class="danger" type="submit">Remove</button></form></td>
    </tr>`)}
  </table></div>`}
  <h2 style="margin-top:16px">Add action</h2>
  <form class="stack" method="post" action="/admin/hooks/${hook._id}/actions">
    <label>Topic<input type="text" name="topic" required placeholder="home/{{body.room}}/light/set"></label>
    <label>Payload<textarea name="payload" placeholder='{"state": {{body.state|json}}, "at": "{{now}}"}'></textarea></label>
    <div class="grid2">
      <label>QoS<select name="qos"><option value="0">0 – at most once</option><option value="1" selected>1 – at least once</option><option value="2">2 – exactly once</option></select></label>
      <label style="display:flex; gap:8px; align-items:center; color:var(--text)"><input type="checkbox" name="retain"> Retain</label>
    </div>
    <p class="muted" style="margin:0">Placeholders: <code>{{body.x}}</code>, <code>{{query.x}}</code>, <code>{{hook.name}}</code>, <code>{{now}}</code>, <code>{{ts}}</code>. Add <code>|json</code> to JSON-encode a value.</p>
    <div><button type="submit">Add action</button></div>
  </form>
</section>

<section>
  <h2>Tokens</h2>
  ${newToken ? html`<div class="flash secret"><strong>New token for “${newToken.label}”.</strong> Copy it now; it won't be shown again.<pre>${newToken.token}</pre></div>` : ''}
  ${hook.tokens.length === 0 ? html`<p class="muted">No tokens yet. Nobody can call this hook until you create one.</p>` : html`<div class="scroll"><table>
    <tr><th>Label</th><th>Starts with</th><th>Created</th><th>Last used</th><th></th></tr>
    ${hook.tokens.map((t) => html`<tr>
      <td>${t.label}</td><td><code>${t.hint}…</code></td><td>${fmtDate(t.createdAt)}</td><td>${fmtDate(t.lastUsedAt)}</td>
      <td><form class="inline" method="post" action="/admin/hooks/${hook._id}/tokens/${t.id}/delete"><button class="danger" type="submit">Revoke</button></form></td>
    </tr>`)}
  </table></div>`}
  <form class="row" method="post" action="/admin/hooks/${hook._id}/tokens" style="margin-top:12px">
    <label style="flex:1 1 220px">Label<input type="text" name="label" required placeholder="phone, tasker, home-assistant…"></label>
    <button type="submit">Create token</button>
  </form>
</section>

<section>
  <h2>Test fire</h2>
  <form class="stack" method="post" action="/admin/hooks/${hook._id}/test">
    <label>JSON body (available as <code>body</code>)<textarea name="body">${testBody ?? '{}'}</textarea></label>
    <div><button type="submit">Fire now</button></div>
  </form>
  ${testResult ? html`<div style="margin-top:12px"><p class="${testResult.ok ? 'ok' : 'err'}">${testResult.message}</p>
    ${testResult.published?.length ? html`<pre>${JSON.stringify(testResult.published, null, 2)}</pre>` : ''}</div>` : ''}
</section>

<section>
  <h2>Recent calls</h2>
  ${calls.length === 0 ? html`<p class="muted">No calls yet.</p>` : html`<div class="scroll"><table>
    <tr><th>When</th><th>Source</th><th>IP</th><th>Status</th><th>Detail</th></tr>
    ${calls.map((c) => html`<tr>
      <td>${fmtDate(c.at)}</td><td>${c.source}</td><td>${c.ip}</td>
      <td class="${c.status < 300 ? 'ok' : 'err'}">${c.status}</td><td>${c.detail}</td>
    </tr>`)}
  </table></div>`}
</section>

<section>
  <h2>Danger zone</h2>
  <form method="post" action="/admin/hooks/${hook._id}/delete" onsubmit="return confirm('Delete hook ${hook.name}? This cannot be undone.')">
    <button class="danger" type="submit">Delete hook</button>
  </form>
</section>`;
}
