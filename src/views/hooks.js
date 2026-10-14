import { csrfField, fmtDate, html, SafeHtml } from './html.js';

const QOS_OPTIONS = [
  [0, '0 – at most once'],
  [1, '1 – at least once'],
  [2, '2 – exactly once'],
];

/** Topic, payload, QoS and retain inputs, shared by the add and edit forms. */
function actionFields(values = {}) {
  const qos = values.qos ?? 1;
  return html`
    <label>Topic<input type="text" name="topic" required maxlength="1024" placeholder="home/{{body.room}}/light/set" value="${values.topic ?? ''}"></label>
    <label>Payload<textarea name="payload" maxlength="65536" placeholder='{"state": {{body.state|json}}, "at": "{{now}}"}'>${values.payload ?? ''}</textarea></label>
    <div class="grid2">
      <label>QoS<select name="qos">${QOS_OPTIONS.map(([value, label]) => html`<option value="${value}" ${value === qos ? new SafeHtml('selected') : ''}>${label}</option>`)}</select></label>
      <label class="check"><input type="checkbox" name="retain" ${values.retain ? new SafeHtml('checked') : ''}> Retain</label>
    </div>
    <p class="muted mb0">Placeholders: <code>{{body.x}}</code>, <code>{{query.x}}</code>, <code>{{hook.name}}</code>, <code>{{now}}</code>, <code>{{ts}}</code>. Add <code>|json</code> to JSON-encode a value.</p>`;
}

export function actionEditPage({ hook, action, csrf, values }) {
  const base = `/admin/hooks/${hook._id}`;
  const position = hook.actions.findIndex((a) => a.id === action.id) + 1;
  return html`
<p class="mb0"><a href="${base}">← Back to <code>${hook.name}</code></a></p>
<section class="mt">
  <h2>Edit action ${position} of ${hook.actions.length} <span class="muted">· hook <code>${hook.name}</code></span></h2>
  <form class="stack" method="post" action="${base}/actions/${action.id}">
    ${csrfField(csrf)}
    ${actionFields(values ?? action)}
    <div class="row-actions"><button type="submit">Save action</button><a class="button ghost" href="${base}">Cancel</a></div>
  </form>
</section>`;
}

export function hooksPage({ hooks, csrf }) {
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
    ${csrfField(csrf)}
    <label class="grow1">Name (a-z, 0-9, - and _)<input type="text" name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9_\\-]{0,63}" placeholder="garage-open"></label>
    <label class="grow3">Description<input type="text" name="description" maxlength="200" placeholder="Opens the garage door"></label>
    <button type="submit">Create</button>
  </form>
</section>`;
}

export function hookPage({ hook, calls, csrf, publicUrl, newToken, testResult, testBody, allowQueryToken, actionDraft }) {
  const url = `${publicUrl || ''}/h/${hook.name}`;
  const base = `/admin/hooks/${hook._id}`;
  return html`
<section>
  <h2><code>${hook.name}</code></h2>
  <form class="stack" method="post" action="${base}/update">
    ${csrfField(csrf)}
    <label>Description<input type="text" name="description" maxlength="200" value="${hook.description}"></label>
    <label class="check"><input type="checkbox" name="enabled" ${hook.enabled ? 'checked' : ''}> Enabled</label>
    <div><button type="submit">Save</button></div>
  </form>
  <p class="muted mb0">Call it with:</p>
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
      <td><div class="row-actions">
        <a class="button ghost" href="${base}/actions/${a.id}/edit">Edit</a>
        <form class="inline" method="post" action="${base}/actions/${a.id}/delete" data-confirm="Remove this action?">${csrfField(csrf)}<button class="danger" type="submit">Remove</button></form>
      </div></td>
    </tr>`)}
  </table></div>`}
  <h2 class="mt">Add action</h2>
  <form class="stack" method="post" action="${base}/actions">
    ${csrfField(csrf)}
    ${actionFields(actionDraft)}
    <div><button type="submit">Add action</button></div>
  </form>
</section>

<section>
  <h2>Tokens</h2>
  ${newToken ? html`<div class="flash secret"><strong>New token for “${newToken.label}”.</strong> Copy it now; it won't be shown again.
    <pre id="new-token">${newToken.token}</pre><p class="mb0"><button class="ghost" type="button" data-copy="#new-token">Copy</button></p></div>` : ''}
  ${hook.tokens.length === 0 ? html`<p class="muted">No tokens yet. Nobody can call this hook until you create one.</p>` : html`<div class="scroll"><table>
    <tr><th>Label</th><th>Starts with</th><th>Created</th><th>Last used</th><th></th></tr>
    ${hook.tokens.map((t) => html`<tr>
      <td>${t.label}</td><td><code>${t.hint}…</code></td><td>${fmtDate(t.createdAt)}</td><td>${fmtDate(t.lastUsedAt)}</td>
      <td><form class="inline" method="post" action="${base}/tokens/${t.id}/delete" data-confirm="Revoke token “${t.label}”? Callers using it will stop working.">${csrfField(csrf)}<button class="danger" type="submit">Revoke</button></form></td>
    </tr>`)}
  </table></div>`}
  <form class="row mt" method="post" action="${base}/tokens">
    ${csrfField(csrf)}
    <label class="grow1">Label<input type="text" name="label" required maxlength="64" placeholder="phone, tasker, home-assistant…"></label>
    <button type="submit">Create token</button>
  </form>
</section>

<section>
  <h2>Test fire</h2>
  <form class="stack" method="post" action="${base}/test">
    ${csrfField(csrf)}
    <label>JSON body (available as <code>body</code>)<textarea name="body">${testBody ?? '{}'}</textarea></label>
    <div><button type="submit">Fire now</button></div>
  </form>
  ${testResult ? html`<div class="mt"><p class="${testResult.ok ? 'ok' : 'err'}">${testResult.message}</p>
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
  <form method="post" action="${base}/delete" data-confirm="Delete hook ${hook.name}? This cannot be undone.">
    ${csrfField(csrf)}
    <button class="danger" type="submit">Delete hook</button>
  </form>
</section>`;
}
