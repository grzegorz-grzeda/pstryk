import { RANGES } from '../dashboard.js';
import { fmtDate, html, SafeHtml } from './html.js';

const compact = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : n.toLocaleString('en-US');

const percent = (ratio) => (ratio === null ? '–' : `${(ratio * 100).toFixed(ratio === 1 || ratio === 0 ? 0 : 1)}%`);

const two = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hhmm = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
const dayLabel = (d) => `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
const dateLabel = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
/** Compact timestamp for tables, e.g. "Oct 14, 22:58". The full one is in the title attribute. */
const when = (d) => html`<time class="nowrap" datetime="${new Date(d).toISOString()}" title="${fmtDate(d)}">${dateLabel(new Date(d))}, ${hhmm(new Date(d))}</time>`;

/** Label for one bucket in tooltips and the table view. */
function bucketLabel(start, range) {
  const end = new Date(start.getTime() + RANGES[range].bucketMs);
  if (range === '30d') return `${DAYS[start.getUTCDay()]} ${dateLabel(start)}`;
  if (range === '7d') return `${DAYS[start.getUTCDay()]} ${dateLabel(start)}, ${hhmm(start)}–${hhmm(end)}`;
  return `${dateLabel(start)}, ${hhmm(start)}–${hhmm(end)}`;
}

// Axis labels: every 6 h on the 24 h chart, daily on 7 d, every 5 days on 30 d.
const TICK_EVERY = { '24h': 6, '7d': 4, '30d': 5 };
const tickLabel = (start, range) => (range === '24h' ? hhmm(start) : range === '7d' ? dayLabel(start) : dateLabel(start));

/** A clean axis maximum and step: 1, 2 or 5 × 10ⁿ, at most 4 gridlines. */
function niceScale(max) {
  if (max <= 0) return { max: 4, step: 1 };
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
  const niceStep = Math.max(1, step);
  return { max: Math.ceil(max / niceStep) * niceStep, step: niceStep };
}

/** Path for a bar with 4px rounded top corners and a square base. */
function bar(x, y, w, h, rounded) {
  const r = rounded ? Math.min(4, w / 2, h) : 0;
  const f = (n) => Math.round(n * 100) / 100;
  if (!r) return `M${f(x)},${f(y + h)}V${f(y)}H${f(x + w)}V${f(y + h)}Z`;
  return `M${f(x)},${f(y + h)}V${f(y + r)}A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)}H${f(x + w - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
}

/** Stacked columns: delivered at the base, failed on top, separated by a 2px surface gap. */
function callsChart({ series, range }) {
  const W = 920;
  const H = 240;
  const m = { top: 22, right: 8, bottom: 26, left: 40 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const baseline = m.top + plotH;
  const peak = series.reduce((best, p) => (p.total > best.total ? p : best), series[0]);
  const scale = niceScale(peak.total);
  const y = (v) => (v / scale.max) * plotH;
  const slot = plotW / series.length;
  const barW = Math.min(24, slot * 0.62);
  const GAP = 2;

  const grid = [];
  for (let v = scale.step; v <= scale.max; v += scale.step) {
    const gy = baseline - y(v);
    grid.push(html`<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${gy}" y2="${gy}"></line>
      <text class="tick" x="${m.left - 8}" y="${gy + 4}" text-anchor="end">${compact(v)}</text>`);
  }

  const columns = series.map((p, i) => {
    const x = m.left + i * slot + (slot - barW) / 2;
    const okH = p.ok ? Math.max(2, y(p.ok)) : 0;
    const failH = p.failed ? Math.max(2, y(p.failed)) : 0;
    const label = bucketLabel(p.start, range);
    const tip = JSON.stringify({
      title: label,
      rows: [
        { key: 'ok', label: 'Delivered', value: p.ok },
        { key: 'failed', label: 'Failed', value: p.failed },
      ],
    });
    return html`<g class="col" tabindex="0" data-tip="${tip}" aria-label="${label}: ${p.ok} delivered, ${p.failed} failed">
      <rect class="hit" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${plotH}"></rect>
      ${okH ? html`<path class="bar-ok" d="${bar(x, baseline - okH, barW, okH, !failH)}"></path>` : ''}
      ${failH ? html`<path class="bar-failed" d="${bar(x, baseline - okH - (okH ? GAP : 0) - failH, barW, failH, true)}"></path>` : ''}
      ${i % TICK_EVERY[range] === 0 ? html`<text class="tick" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${tickLabel(p.start, range)}</text>` : ''}
    </g>`;
  });

  // One selective direct label: the busiest bucket.
  const peakIndex = series.indexOf(peak);
  const peakLabel =
    peak.total > 0
      ? html`<text class="peak" x="${m.left + peakIndex * slot + slot / 2}" y="${baseline - y(peak.total) - 6}" text-anchor="middle">${compact(peak.total)}</text>`
      : '';

  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Webhook calls per ${RANGES[range].bucketMs >= 86_400_000 ? 'day' : 'period'}, delivered and failed">
    ${grid}
    <line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${baseline}" y2="${baseline}"></line>
    <text class="tick" x="${m.left - 8}" y="${baseline + 4}" text-anchor="end">0</text>
    ${columns}
    ${peakLabel}
  </svg>`;
}

function delta(current, previous, short) {
  if (!previous) return html`<span class="muted">No calls in the previous ${short}</span>`;
  const change = (current - previous) / previous;
  const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '';
  // Against a tiny baseline a percentage is meaningless (▲ 5000%); show the old count instead.
  if (Math.abs(change) >= 10) return html`<span class="muted">${arrow} from ${compact(previous)} in the previous ${short}</span>`;
  return html`<span class="muted">${arrow} ${Math.abs(Math.round(change * 100))}% vs previous ${short}</span>`;
}

const statusCell = (status) =>
  status === null ? html`<span class="muted">–</span>` : html`<span class="${status < 300 ? 'ok' : 'err'}">${status < 300 ? '✓' : '✕'} ${status}</span>`;

const SECURITY_LABELS = { 'login.failure': 'Failed sign-in', 'login.locked': 'Blocked (locked out)', 'login.mfa_failure': 'Wrong 2FA code' };

export function dashboardPage({ data, mqtt, callLogDays, now }) {
  const { range, rangeInfo, series, totals, previous, hooks, recentCalls, security } = data;
  const truncated = rangeInfo.days > callLogDays;

  return html`
<div class="toolbar">
  <nav class="segmented" aria-label="Time range">
    ${Object.entries(RANGES).map(([key, r]) => html`<a href="/admin?range=${key}" ${key === range ? new SafeHtml('aria-current="page"') : ''}>${r.short}</a>`)}
  </nav>
  <span class="muted">Times in UTC · updated ${hhmm(new Date(now))} · <a href="/admin?range=${range}">Refresh</a></span>
</div>

<div class="tiles">
  <section class="tile">
    <h3>Webhook calls</h3>
    <p class="value">${compact(totals.total)}</p>
    <p class="sub">${delta(totals.total, previous.total, rangeInfo.short)}</p>
  </section>
  <section class="tile">
    <h3>Success rate</h3>
    <p class="value">${percent(totals.successRate)}</p>
    <p class="sub">${totals.failed ? html`<span class="err">✕ ${compact(totals.failed)} failed</span>` : html`<span class="muted">No failed calls</span>`}</p>
  </section>
  <section class="tile">
    <h3>Enabled hooks</h3>
    <p class="value">${hooks.enabled}</p>
    <p class="sub muted">of ${hooks.total} · <a href="/admin/hooks">manage</a></p>
  </section>
  <section class="tile">
    <h3>Failed sign-ins</h3>
    <p class="value">${compact(security.failedSignIns)}</p>
    <p class="sub">${security.failedSignIns ? html`<span class="err">⚠ <a href="/admin/audit">Review audit log</a></span>` : html`<span class="muted">None in the last ${rangeInfo.short}</span>`}</p>
  </section>
  <section class="tile">
    <h3>System</h3>
    <p class="status-line ${mqtt.connected ? 'st-good' : 'st-crit'}">${mqtt.connected ? '✓' : '✕'} MQTT ${mqtt.connected ? 'connected' : 'disconnected'}</p>
    <p class="sub muted">${mqtt.broker ?? ''}${mqtt.connected && mqtt.since ? html` · since ${when(mqtt.since)}` : ''}</p>
    ${!mqtt.connected && mqtt.lastError ? html`<p class="sub err">${mqtt.lastError.message}</p>` : ''}
    <p class="status-line st-good">✓ Database OK</p>
  </section>
</div>

<section>
  <div class="chart-head">
    <h2>Calls · ${rangeInfo.label}</h2>
    <ul class="legend" aria-label="Legend">
      <li><span class="swatch swatch-ok"></span>Delivered</li>
      <li><span class="swatch swatch-failed"></span>Failed</li>
    </ul>
  </div>
  ${truncated ? html`<p class="muted">Call history is kept for ${callLogDays} days (CALL_LOG_DAYS), so older bars are empty.</p>` : ''}
  ${totals.total === 0 ? html`<p class="muted">No calls in this period.</p>` : ''}
  <div class="scroll">${callsChart({ series, range })}</div>
  <details>
    <summary>Show data as a table</summary>
    <div class="scroll"><table class="num">
      <tr><th>Period (UTC)</th><th>Delivered</th><th>Failed</th><th>Total</th></tr>
      ${series.map((p) => html`<tr><td>${bucketLabel(p.start, range)}</td><td>${p.ok}</td><td>${p.failed}</td><td>${p.total}</td></tr>`)}
    </table></div>
  </details>
</section>

<section>
  <h2>Hooks · ${rangeInfo.label}</h2>
  ${hooks.perHook.length === 0
    ? html`<p class="muted">No hooks yet. <a href="/admin/hooks">Create the first one</a>.</p>`
    : html`<div class="scroll"><table class="num">
      <tr><th>Hook</th><th>Calls</th><th>Failed</th><th>Success</th><th>Last call</th><th>Last status</th></tr>
      ${hooks.perHook.map((h) => html`<tr>
        <td><a href="/admin/hooks/${h.hook._id}"><code>${h.hook.name}</code></a>${h.hook.enabled ? '' : html` <span class="badge">disabled</span>`}</td>
        <td>${compact(h.total)}</td>
        <td>${h.failed ? html`<span class="err">${compact(h.failed)}</span>` : '0'}</td>
        <td>${percent(h.total ? (h.total - h.failed) / h.total : null)}</td>
        <td>${h.lastAt ? when(h.lastAt) : html`<span class="muted">–</span>`}</td>
        <td>${statusCell(h.lastStatus)}</td>
      </tr>`)}
    </table></div>`}
</section>

<div class="split">
  <section>
    <h2>Latest calls</h2>
    ${recentCalls.length === 0 ? html`<p class="muted">No calls yet.</p>` : html`<div class="scroll"><table>
      <tr><th>When</th><th>Hook</th><th>Source</th><th>Status</th></tr>
      ${recentCalls.map((c) => html`<tr title="${c.detail}">
        <td>${when(c.at)}</td><td><code>${c.hookName}</code></td><td>${c.source}</td><td>${statusCell(c.status)}</td>
      </tr>`)}
    </table></div>`}
  </section>
  <section>
    <h2>Security events</h2>
    ${security.events.length === 0 ? html`<p class="muted">No failed sign-ins recorded.</p>` : html`<div class="scroll"><table>
      <tr><th>When</th><th>Event</th><th>Username</th><th>IP</th></tr>
      ${security.events.map((e) => html`<tr>
        <td>${when(e.at)}</td><td class="err">${SECURITY_LABELS[e.action] ?? e.action}</td><td>${e.detail?.username ?? ''}</td><td><code>${e.ip}</code></td>
      </tr>`)}
    </table></div>`}
    <p class="mb0"><a href="/admin/audit">Full audit log →</a></p>
  </section>
</div>`;
}
