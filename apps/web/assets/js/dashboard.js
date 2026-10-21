/* Owner dashboard.
 *
 * Everything on this page comes from five database functions that take the
 * owner key as their first argument. The key is never stored server-side in
 * plain text: only its SHA-256 hash lives in `owner_access`, and a wrong key
 * is rate limited. Without the key the tables are unreadable through the
 * public API, so this page is useless to anyone who does not have it — which
 * is the point of it being a page and not an account system.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'voxbridge-owner-key';
  const RANGE_KEY = 'voxbridge-owner-range';
  const THEME_KEY = 'voxbridge-theme';
  const REFRESH_MS = 30_000;
  const HEALTH_DAYS = 7;
  const API = window.VOXBRIDGE_CONFIG?.supabaseUrl;
  const ANON = window.VOXBRIDGE_CONFIG?.supabaseAnonKey;

  const state = {
    key: '',
    days: Number(localStorage.getItem(RANGE_KEY)) || 30,
    busy: false,
    timer: null,
    traffic: null,
    live: null,
    health: null,
    messages: null,
  };

  const $ = (id) => document.getElementById(id);
  const num = new Intl.NumberFormat();
  const regionNames = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      return null;
    }
  })();

  /* --- theme ------------------------------------------------------------- */

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const sun = document.querySelector('#theme .icon-sun');
    const moon = document.querySelector('#theme .icon-moon');
    if (sun) sun.hidden = theme === 'dark';
    if (moon) moon.hidden = theme !== 'dark';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d0d0a' : '#f4f1ea');
  }

  function initTheme() {
    let stored = '';
    try {
      stored = localStorage.getItem(THEME_KEY) || '';
    } catch {
      stored = '';
    }
    applyTheme(stored === 'dark' || stored === 'light' ? stored : prefersDark.matches ? 'dark' : 'light');
    $('theme')?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode */
      }
    });
  }

  /* --- api --------------------------------------------------------------- */

  async function rpc(name, params) {
    if (!API || !ANON) throw new Error('The site configuration is missing.');
    const response = await fetch(`${API}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = String(body?.message || body?.hint || `Request failed (${response.status})`);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  const guarded = (name, params) => rpc(name, { p_key: state.key, ...params });

  /* --- helpers ----------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function countryLabel(code) {
    const value = String(code || '').trim().toUpperCase();
    if (!value || value === 'UNKNOWN' || value.length !== 2) return 'Unknown';
    const name = regionNames?.of(value) || value;
    const flag = [...value].map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
    return `${flag} ${name}`;
  }

  function friendlyPath(path) {
    if (!path || path === '/') return '/ (home)';
    return path;
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '—';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 90) return '1 min ago';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 7200) return '1 hour ago';
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours ago`;
    return `${Math.round(seconds / 86_400)} days ago`;
  }

  function clockTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  /* --- gate -------------------------------------------------------------- */

  function showGate(message = '') {
    state.key = '';
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
    $('gate').hidden = false;
    $('app').hidden = true;
    $('refresh').hidden = true;
    $('range-tabs').hidden = true;
    document.querySelectorAll('.gate-error').forEach((element) => { element.textContent = message; });
    setText('live-pill-text', 'Locked');
    $('live-pill')?.classList.remove('is-live');
  }

  async function unlock(key, { remember = true } = {}) {
    const trimmed = String(key || '').trim();
    if (!trimmed) return false;
    $('gate-submit')?.setAttribute('disabled', '');
    const button = $('gate-submit');
    if (button) button.textContent = 'Checking…';
    try {
      await rpc('owner_ping', { p_key: trimmed });
      state.key = trimmed;
      if (remember) {
        try {
          localStorage.setItem(STORAGE_KEY, trimmed);
        } catch { /* ignore */ }
      }
      $('gate').hidden = true;
      $('app').hidden = false;
      $('refresh').hidden = false;
      $('range-tabs').hidden = false;
      $('live-pill').classList.add('is-live');
      setText('live-pill-text', 'Live');
      startAutoRefresh();
      await loadAll();
      return true;
    } catch (error) {
      const message = /invalid access key/i.test(error.message)
        ? 'That key is not right.'
        : /too many/i.test(error.message)
          ? 'Too many wrong keys — wait a few minutes, then try again.'
          : error.message;
      showGate(message);
      return false;
    } finally {
      if (button) {
        button.removeAttribute('disabled');
        button.textContent = 'Unlock';
      }
    }
  }

  /* --- live -------------------------------------------------------------- */

  function renderPulse(pulse) {
    const host = $('pulse-chart');
    if (!host) return;
    const points = (pulse || []).slice(0, 12);
    if (!points.length) {
      host.innerHTML = '<p class="empty-note">No samples yet.</p>';
      return;
    }
    const width = 260;
    const height = 58;
    const max = Math.max(1, ...points.map((point) => Math.max(point.views, point.downloads)));
    const step = width / Math.max(points.length - 1, 1);
    const line = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)},${(height - (point.views / max) * (height - 8) - 2).toFixed(1)}`)
      .join(' ');
    const area = `${line} L${width},${height} L0,${height} Z`;
    const bars = points
      .map((point, index) => {
        const barHeight = (point.downloads / max) * (height - 8);
        if (!barHeight) return '';
        const x = index * step - 3;
        return `<rect x="${x.toFixed(1)}" y="${(height - barHeight).toFixed(1)}" width="4" height="${barHeight.toFixed(1)}" rx="1" fill="currentColor" opacity="0.32"/>`;
      })
      .join('');
    host.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Page views and downloads over the last hour">
        <path d="${area}" fill="var(--accent)" opacity="0.12"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
        <g color="var(--ink)">${bars}</g>
      </svg>`;
  }

  function renderLive(data) {
    state.live = data;
    setText('live-online', num.format(data.online || 0));
    setText('live-visitors', num.format(data.visitors_15m || 0));
    setText('live-views', `${num.format(data.views_15m || 0)} page views`);
    setText('live-views-today', num.format(data.views_today || 0));
    setText('live-downloads-today', num.format(data.downloads_today || 0));
    setText('live-downloads-recent', `${num.format(data.downloads_15m || 0)} in the last 15 min`);
    setText('live-generated', `updated ${timeAgo(data.generated)}`);
    setText('live-pill-text', data.online > 0 ? `${num.format(data.online)} on site` : 'Live');
    renderPulse(data.pulse);
  }

  /* --- chart ------------------------------------------------------------- */

  function niceMax(value) {
    if (value <= 4) return 4;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / magnitude) * magnitude;
  }

  function renderChart(series) {
    const host = $('traffic-chart');
    if (!host) return;
    const points = series || [];
    if (!points.length) {
      host.innerHTML = '<p class="empty-note">No data in this range.</p>';
      return;
    }
    const width = 900;
    const height = 240;
    const pad = { top: 12, right: 8, bottom: 26, left: 30 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(4, ...points.map((point) => Math.max(point.visits, point.downloads))));
    const step = innerW / Math.max(points.length - 1, 1);
    const barWidth = Math.min(18, Math.max(2, (innerW / points.length) * 0.42));

    const y = (value) => pad.top + innerH - (value / max) * innerH;
    const line = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${(pad.left + index * step).toFixed(1)},${y(point.visits).toFixed(1)}`)
      .join(' ');
    const area = `${line} L${(pad.left + (points.length - 1) * step).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pad.left},${(pad.top + innerH).toFixed(1)} Z`;

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((fraction) => {
        const value = Math.round(max * fraction);
        const gy = y(value).toFixed(1);
        return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="var(--line)" stroke-width="1" stroke-dasharray="${fraction === 0 ? '0' : '2 4'}" opacity="0.7"/>
                <text x="${pad.left - 8}" y="${(Number(gy) + 3).toFixed(1)}" text-anchor="end" font-size="9" font-family="var(--mono)" fill="var(--muted-2)">${value}</text>`;
      })
      .join('');

    const bars = points
      .map((point, index) => {
        const barHeight = (point.downloads / max) * innerH;
        if (!barHeight) return '';
        const x = pad.left + index * step - barWidth / 2;
        return `<rect x="${x.toFixed(1)}" y="${(pad.top + innerH - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="var(--ink)" opacity="0.42"><title>${point.day}: ${point.downloads} download${point.downloads === 1 ? '' : 's'}</title></rect>`;
      })
      .join('');

    const labelEvery = Math.max(1, Math.ceil(points.length / 8));
    const labels = points
      .map((point, index) => {
        if (index % labelEvery !== 0 && index !== points.length - 1) return '';
        const date = new Date(`${point.day}T12:00:00`);
        const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `<text x="${(pad.left + index * step).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9.5" font-family="var(--mono)" fill="var(--muted-2)">${escapeHtml(label)}</text>`;
      })
      .join('');

    const dots = points
      .map((point, index) => `<circle cx="${(pad.left + index * step).toFixed(1)}" cy="${y(point.visits).toFixed(1)}" r="${point.visits ? 2.4 : 0}" fill="var(--accent)"><title>${point.day}: ${point.visits} view${point.visits === 1 ? '' : 's'}, ${point.visitors} visitor${point.visitors === 1 ? '' : 's'}</title></circle>`)
      .join('');

    host.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Page views and downloads by day">
        ${grid}
        <path d="${area}" fill="var(--accent)" opacity="0.09"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${bars}
        ${dots}
        ${labels}
      </svg>`;
    setText('chart-hint', `${points.length} day${points.length === 1 ? '' : 's'} · peak ${num.format(max)}`);
  }

  /* --- lists ------------------------------------------------------------- */

  function renderBars(panel, rows, { format = (label) => label } = {}) {
    const host = document.querySelector(`[data-panel="${panel}"]`);
    if (!host) return;
    const items = (rows || []).filter((row) => row && row.label !== undefined);
    if (!items.length) {
      host.innerHTML = '<p class="empty-note">Nothing in this range.</p>';
      return;
    }
    const max = Math.max(1, ...items.map((row) => Number(row.count) || 0));
    host.innerHTML = items
      .map((row) => {
        const count = Number(row.count) || 0;
        const percent = Math.max(2, (count / max) * 100);
        return `<div class="bar-row">
          <span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(format(row.label))}</span>
          <span class="bar-value">${num.format(count)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${percent.toFixed(1)}%"></span></span>
        </div>`;
      })
      .join('');
  }

  /* --- health ------------------------------------------------------------ */

  async function probe(path) {
    const started = performance.now();
    try {
      const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}probe=${Date.now()}`, {
        method: 'HEAD',
        cache: 'no-store',
      });
      return { ok: response.ok, ms: Math.round(performance.now() - started), status: response.status };
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - started), status: 0 };
    }
  }

  async function runLiveProbe() {
    const button = $('probe-run');
    if (button) {
      button.disabled = true;
      button.textContent = 'Testing…';
    }
    const cells = [...document.querySelectorAll('#live-probe .probe')];
    cells.forEach((cell) => {
      cell.className = 'probe is-pending';
      const ms = cell.querySelector('.ms');
      if (ms) ms.textContent = '…';
    });
    const results = await Promise.all(cells.map((cell) => probe(cell.dataset.probe)));
    results.forEach((result, index) => {
      const cell = cells[index];
      cell.className = `probe ${result.ok ? 'ok' : 'bad'}`;
      const ms = cell.querySelector('.ms');
      if (ms) ms.textContent = result.ok ? `${result.ms} ms` : result.status ? `${result.status}` : 'offline';
    });
    const healthy = results.every((result) => result.ok);
    setText('probe-hint', healthy ? 'all endpoints answer' : 'a check failed — see above');
    if (button) {
      button.disabled = false;
      button.textContent = 'Run test';
    }
  }

  function renderHealth(data) {
    state.health = data;
    const checks = (data?.checks || []).filter(Boolean);
    const runs = checks.length;
    const passed = checks.filter((check) => check.ok).length;
    const uptime = runs ? (passed / runs) * 100 : null;
    const latencies = checks.map((check) => Number(check.latency_ms)).filter((value) => Number.isFinite(value) && value > 0);
    const average = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;

    setText('health-uptime', uptime === null ? '—' : `${uptime.toFixed(uptime === 100 ? 0 : 1)}%`);
    const uptimeEl = $('health-uptime');
    if (uptimeEl) uptimeEl.className = `value ${uptime === null ? '' : uptime >= 99 ? 'ok' : 'bad'}`;
    setText('health-latency', average === null ? '—' : `${average} ms`);
    setText('health-runs', num.format(runs));
    const last = checks[0];
    setText('health-last', last ? timeAgo(last.checked_at) : '—');
    setText('health-updated', last ? `last probe ${timeAgo(last.checked_at)}` : 'waiting for the first check');

    const daily = (data?.daily || []).map((entry) => ({ ...entry, day: String(entry.day) }));
    const host = $('health-bars');
    if (host) {
      if (!daily.length) {
        host.innerHTML = '<p class="empty-note" style="margin:0">The scheduled probe starts on the next 15-minute tick.</p>';
      } else {
        const maxRuns = Math.max(...daily.map((entry) => entry.runs || 0), 1);
        host.innerHTML = daily
          .map((entry) => {
            const ratio = entry.runs ? entry.ok / entry.runs : 0;
            const state_ = !entry.runs ? 'idle' : ratio >= 0.99 ? '' : ratio >= 0.5 ? 'degraded' : 'down';
            const height = Math.max(8, ((entry.runs || 0) / maxRuns) * 100);
            return `<span class="${state_}" style="height:${height}%" title="${escapeHtml(entry.day)}: ${entry.ok}/${entry.runs} checks passed${entry.avg_ms ? `, ${entry.avg_ms} ms average` : ''}"></span>`;
          })
          .join('');
      }
    }

    const body = $('health-table');
    if (body) {
      if (!checks.length) {
        body.innerHTML = '<tr><td colspan="4" class="empty-note">No checks recorded yet. The workflow runs every 15 minutes.</td></tr>';
      } else {
        body.innerHTML = checks.slice(0, 8)
          .map((check) => {
            const results = Object.entries(check.checks || {});
            const failed = results.filter(([, value]) => value && value.ok === false);
            const summary = results.length
              ? failed.length
                ? `${failed.map(([name]) => name).join(', ')} failed`
                : `${results.length} endpoints ok`
              : '—';
            return `<tr>
              <td class="mono">${escapeHtml(clockTime(check.checked_at))}</td>
              <td><span class="status-chip ${check.ok ? '' : 'bad'}">${check.ok ? 'up' : 'down'}</span></td>
              <td class="mono">${check.latency_ms ? `${check.latency_ms} ms` : '—'}</td>
              <td>${escapeHtml(summary)}</td>
            </tr>`;
          })
          .join('');
      }
    }
    setText('health-table-hint', `${HEALTH_DAYS}-day history`);
  }

  /* --- messages ---------------------------------------------------------- */

  function renderMessages(data) {
    state.messages = data;
    const list = $('messages');
    if (!list) return;
    const messages = data?.messages || [];
    if (!messages.length) {
      list.innerHTML = '<p class="empty-note">No messages yet.</p>';
      return;
    }
    list.innerHTML = messages
      .map((message) => `<article class="message-item">
        <div class="message-meta">
          <b>${escapeHtml(message.topic || 'general')}</b>
          <span>${escapeHtml(message.platform || 'unknown device')}</span>
          ${message.app_version ? `<span>v${escapeHtml(message.app_version)}</span>` : ''}
          <span>${escapeHtml(timeAgo(message.created_at))}</span>
          ${message.email ? `<span>${escapeHtml(message.email)}</span>` : ''}
        </div>
        <div class="message-body">${escapeHtml(message.message)}</div>
      </article>`)
      .join('');
  }

  /* --- load -------------------------------------------------------------- */

  function renderTraffic(data) {
    state.traffic = data;
    const totals = data.totals || {};
    setText('kpi-visits', num.format(totals.visits || 0));
    setText('kpi-visitors', num.format(totals.visitors || 0));
    setText('kpi-downloads', num.format(totals.downloads || 0));
    setText('kpi-messages', num.format(totals.messages || 0));
    const days = data.range?.days || state.days;
    setText('range-label', days === 1 ? 'today' : `last ${days} days`);
    const perVisitor = totals.visitors ? (totals.visits / totals.visitors).toFixed(1) : '0';
    setText('kpi-visits-sub', `${perVisitor} pages per visitor`);

    renderChart(data.series || []);
    renderBars('pages', data.pages, { format: friendlyPath });
    renderBars('referrers', data.referrers);
    renderBars('countries', data.countries, { format: countryLabel });
    renderBars('devices', data.devices);
    renderBars('browsers', data.browsers);
    renderBars('campaigns', data.campaigns);
    renderBars('platforms', data.platforms);
    renderBars('sources', data.sources);
    renderBars('download_countries', data.download_countries, { format: countryLabel });
    renderBars('download_devices', data.download_devices);
  }

  async function loadAll() {
    if (!state.key || state.busy) return;
    state.busy = true;
    const timezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();
    $('refresh')?.classList.add('is-busy');
    try {
      const [live, traffic, health, messages] = await Promise.all([
        guarded('owner_live'),
        guarded('owner_traffic', { p_days: state.days, p_tz: timezone }),
        guarded('owner_health', { p_days: HEALTH_DAYS, p_tz: timezone }),
        guarded('owner_messages', { p_limit: 40 }),
      ]);
      renderLive(live || {});
      renderTraffic(traffic || { totals: {}, series: [] });
      renderHealth(health || {});
      renderMessages(messages || {});
    } catch (error) {
      if (/invalid access key/i.test(error.message) || error.status === 401 || error.status === 403) {
        showGate('That key is no longer valid. Unlock again.');
        stopAutoRefresh();
      } else {
        console.warn('dashboard:', error.message);
        setText('live-generated', `could not refresh — ${error.message}`);
      }
    } finally {
      state.busy = false;
      $('refresh')?.classList.remove('is-busy');
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    state.timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadAll();
    }, REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
  }

  /* --- events ------------------------------------------------------------ */

  function init() {
    initTheme();

    $('gate-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = $('gate-key')?.value || '';
      if ($('gate-key')) $('gate-key').value = '';
      unlock(value);
    });

    $('refresh')?.addEventListener('click', () => loadAll());

    $('range-tabs')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-days]');
      if (!button) return;
      const days = Number(button.dataset.days) || 30;
      state.days = days;
      try {
        localStorage.setItem(RANGE_KEY, String(days));
      } catch { /* ignore */ }
      $('range-tabs').querySelectorAll('button').forEach((element) => {
        element.setAttribute('aria-pressed', String(element === button));
      });
      loadAll();
    });

    $('range-tabs')?.querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.days) === state.days));
    });

    $('probe-run')?.addEventListener('click', runLiveProbe);

    $('lock')?.addEventListener('click', () => {
      stopAutoRefresh();
      showGate('');
    });

    $('rotate')?.addEventListener('click', async () => {
      if (!state.key) return;
      const confirmed = window.confirm('Generate a new key? The current one stops working immediately.');
      if (!confirmed) return;
      const bytes = new Uint8Array(30);
      crypto.getRandomValues(bytes);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      let fresh = 'vb_';
      for (const byte of bytes) fresh += alphabet[byte % alphabet.length];
      try {
        await rpc('owner_rotate', { p_key: state.key, p_new_key: fresh });
        state.key = fresh;
        try {
          localStorage.setItem(STORAGE_KEY, fresh);
        } catch { /* ignore */ }
        const panel = $('key-reveal');
        setText('key-value', fresh);
        panel?.classList.add('is-visible');
      } catch (error) {
        window.alert(`Could not rotate: ${error.message}`);
      }
    });

    $('key-copy')?.addEventListener('click', async () => {
      const value = $('key-value')?.textContent || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setText('key-copy', 'Copied');
        window.setTimeout(() => setText('key-copy', 'Copy'), 1600);
      } catch {
        window.prompt('Copy the key:', value);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.key) loadAll();
    });

    let stored = '';
    try {
      stored = localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      stored = '';
    }
    if (stored) {
      unlock(stored);
    } else {
      showGate('');
    }
    $('gate-key')?.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
