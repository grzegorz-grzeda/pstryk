// Numbers for the admin dashboard: call volume over time, per-hook activity, and security events.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGES = {
  '24h': { label: 'Last 24 hours', short: '24\u00a0h', bucketMs: HOUR, buckets: 24, days: 1 },
  '7d': { label: 'Last 7 days', short: '7\u00a0days', bucketMs: 6 * HOUR, buckets: 28, days: 7 },
  '30d': { label: 'Last 30 days', short: '30\u00a0days', bucketMs: DAY, buckets: 30, days: 30 },
};

export const SECURITY_ACTIONS = ['login.failure', 'login.locked', 'login.mfa_failure'];

/**
 * The time window for a range, aligned to whole buckets (UTC) so bars line up with clock hours
 * and days. The last bucket is the one containing `now`.
 */
export function rangeWindow(key, now = Date.now()) {
  const range = RANGES[key] ? key : '24h';
  const { bucketMs, buckets } = RANGES[range];
  const until = (Math.floor(now / bucketMs) + 1) * bucketMs;
  const since = until - buckets * bucketMs;
  return { range, since: new Date(since), until: new Date(until), bucketMs, buckets };
}

export async function loadDashboard(store, { range: requested, now = Date.now() } = {}) {
  const window = rangeWindow(requested, now);
  const { since, until, bucketMs, buckets } = window;
  const span = until - since;

  const [stats, previous, hooks, recentCalls, failedSignIns, securityEvents] = await Promise.all([
    store.callStats({ since, until, bucketMs }),
    store.callTotals({ since: new Date(since - span), until: since }),
    store.listHooks(),
    store.recentCalls(null, 10),
    store.countAudit({ actions: SECURITY_ACTIONS, since }),
    store.listAudit(5, { actions: SECURITY_ACTIONS }),
  ]);

  const series = Array.from({ length: buckets }, (_, index) => ({
    start: new Date(since.getTime() + index * bucketMs),
    total: 0,
    failed: 0,
  }));
  for (const b of stats.buckets) {
    if (series[b.index]) Object.assign(series[b.index], { total: b.total, failed: b.failed });
  }
  for (const point of series) point.ok = point.total - point.failed;

  const total = series.reduce((n, p) => n + p.total, 0);
  const failed = series.reduce((n, p) => n + p.failed, 0);

  // Every hook appears, including those without calls; busiest first.
  const activity = new Map(stats.perHook.map((h) => [h.hookId, h]));
  const perHook = hooks
    .map((hook) => ({
      hook,
      total: activity.get(hook._id)?.total ?? 0,
      failed: activity.get(hook._id)?.failed ?? 0,
      lastAt: activity.get(hook._id)?.lastAt ?? null,
      lastStatus: activity.get(hook._id)?.lastStatus ?? null,
    }))
    .sort((a, b) => b.total - a.total || a.hook.name.localeCompare(b.hook.name));

  return {
    ...window,
    rangeInfo: RANGES[window.range],
    series,
    totals: { total, failed, ok: total - failed, successRate: total ? (total - failed) / total : null },
    previous,
    hooks: { total: hooks.length, enabled: hooks.filter((h) => h.enabled).length, perHook },
    recentCalls,
    security: { failedSignIns, events: securityEvents },
  };
}
