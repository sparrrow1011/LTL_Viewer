/**
 * Sync Status pills in the global header.
 *
 * Polls /api/sync-status every 60s and updates one pill per source.
 * Color codes by age of last_run_at:
 *   green  : <  30 min
 *   amber  : <  2 h
 *   red    : >= 2 h or never
 */
(function () {
  const POLL_MS = 60 * 1000;
  const COLORS = {
    fresh:  { dot: 'bg-green-500',  text: 'text-green-700 dark:text-green-400',  border: 'border-green-300 dark:border-green-700' },
    stale:  { dot: 'bg-amber-500',  text: 'text-amber-700 dark:text-amber-400',  border: 'border-amber-300 dark:border-amber-700' },
    old:    { dot: 'bg-red-500',    text: 'text-red-700 dark:text-red-400',      border: 'border-red-300 dark:border-red-700' },
    none:   { dot: 'bg-gray-400',   text: 'text-gray-600 dark:text-gray-400',    border: 'border-gray-300 dark:border-gray-600' },
  };

  function classes(s) {
    // Tolerate accidental multi-space separators so we never feed an empty
    // string to classList.add/remove (which would throw SyntaxError).
    return String(s || '').split(/\s+/).filter(Boolean);
  }

  function parseTimestamp(iso) {
    if (!iso) return null;

    let d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;

    // Some engines refuse 6-digit fractional seconds (Postgres microseconds).
    // Truncate them to milliseconds and retry.
    const trimmed = String(iso).replace(/(\.\d{3})\d+/, '$1');
    d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) return d;

    // Final fallback: drop the fractional second entirely.
    const noFrac = trimmed.replace(/\.\d+/, '');
    d = new Date(noFrac);
    if (!Number.isNaN(d.getTime())) return d;

    return null;
  }

  function formatRelative(date) {
    const diff = Math.max(0, Date.now() - date.getTime());
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function pickAgeKey(date) {
    if (!date) return 'none';
    const minutes = (Date.now() - date.getTime()) / 60000;
    if (minutes < 30) return 'fresh';
    if (minutes < 120) return 'stale';
    return 'old';
  }

  function applyColor(pill, ageKey) {
    const dot = pill.querySelector('.sync-dot');
    const palette = COLORS[ageKey];
    if (!palette || !dot) return;

    // Reset color classes we may have added previously.
    Object.values(COLORS).forEach(c => {
      const dotCls = classes(c.dot);
      const textCls = classes(c.text);
      const borderCls = classes(c.border);
      if (dotCls.length) dot.classList.remove(...dotCls);
      if (textCls.length) pill.classList.remove(...textCls);
      if (borderCls.length) pill.classList.remove(...borderCls);
    });

    const dotCls = classes(palette.dot);
    const textCls = classes(palette.text);
    const borderCls = classes(palette.border);
    if (dotCls.length) dot.classList.add(...dotCls);
    if (textCls.length) pill.classList.add(...textCls);
    if (borderCls.length) pill.classList.add(...borderCls);
  }

  function renderPill(pill, info) {
    const rel = pill.querySelector('.sync-relative');
    if (!rel) return;

    const lastRunIso = info && info.last_run_at;
    const date = parseTimestamp(lastRunIso);
    const valid = !!date;

    if (!valid) {
      rel.textContent = 'never';
      pill.title = 'No sync recorded yet';
      applyColor(pill, 'none');
      return;
    }

    rel.textContent = formatRelative(date);

    const status = info.status || 'ok';
    const rows = info.rows_affected;
    const tooltipParts = [
      `Last update: ${date.toLocaleString()}`,
      `Status: ${status}`,
    ];
    if (rows !== null && rows !== undefined) tooltipParts.push(`Rows: ${rows}`);
    if (info.error_message) tooltipParts.push(`Error: ${info.error_message}`);
    pill.title = tooltipParts.join('\n');

    applyColor(pill, status === 'ok' ? pickAgeKey(date) : 'old');
  }

  async function poll() {
    const pills = document.querySelectorAll('#syncStatusPills .sync-pill');
    if (!pills.length) return;

    try {
      const res = await fetch('/api/sync-status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.debug('[sync-status] payload', data);
      pills.forEach(p => {
        const src = p.dataset.syncSource;
        try {
          renderPill(p, data[src] || null);
        } catch (renderErr) {
          // One pill failing must never break the others.
          console.error(`[sync-status] renderPill(${src}) failed:`, renderErr);
        }
      });
    } catch (err) {
      // Don't spam toasts; the pill turns gray and stays quiet.
      pills.forEach(p => {
        try { renderPill(p, null); } catch (_) { /* noop */ }
      });
      console.warn('[sync-status] poll failed:', err);
    }
  }

  function start() {
    poll();
    // Re-render relative time every minute even if backend hasn't changed.
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
