/* VoxBridge website runtime. */
(function () {
  'use strict';

  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const REPO = 'sdlksdsf/Virtual-Mic';
  const RELEASES = `https://github.com/${REPO}/releases`;
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const VERSION = '1.0.0';

  // Theme ---------------------------------------------------------------------
  function storedTheme() {
    try {
      return localStorage.getItem('voxbridge-theme');
    } catch {
      return null;
    }
  }

  function applyTheme(theme) {
    const resolved = theme === 'system' || !theme ? (prefersDark.matches ? 'dark' : 'light') : theme;
    root.dataset.theme = resolved;
    root.dataset.themeChoice = theme || 'system';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0d0d0a' : '#f4f1ea');
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    });
  }

  applyTheme(storedTheme() || 'system');

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-theme-toggle]');
    if (toggle) {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('voxbridge-theme', next);
      } catch {
        /* storage can be blocked */
      }
      applyTheme(next);
      return;
    }
    const menu = event.target.closest('[data-menu-toggle]');
    if (menu) {
      document.querySelector('.site-nav')?.classList.toggle('is-open');
      menu.setAttribute('aria-expanded', String(menu.getAttribute('aria-expanded') !== 'true'));
      return;
    }
    const target = event.target.closest('.site-nav a');
    if (target) {
      document.querySelector('.site-nav')?.classList.remove('is-open');
    }
  });

  prefersDark.addEventListener('change', () => {
    if ((storedTheme() || 'system') === 'system') applyTheme('system');
  });

  // Sticky header -------------------------------------------------------------
  const header = document.querySelector('.site-header');
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('is-stuck', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Mobile nav aria -----------------------------------------------------------
  document.querySelectorAll('[data-menu-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') !== 'true'));
    });
  });

  // Reveal --------------------------------------------------------------------
  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
      )
    : null;
  document.querySelectorAll('.reveal').forEach((element) => {
    if (revealObserver) revealObserver.observe(element);
    else element.classList.add('is-visible');
  });

  // Animated latency bars -----------------------------------------------------
  const latencyObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.querySelectorAll('[data-width]').forEach((bar) => {
              bar.style.width = `${bar.dataset.width}%`;
            });
            latencyObserver.unobserve(entry.target);
          });
        },
        { threshold: 0.2 },
      )
    : null;
  document.querySelectorAll('[data-latency]').forEach((element) => {
    if (latencyObserver) latencyObserver.observe(element);
    else element.querySelectorAll('[data-width]').forEach((bar) => (bar.style.width = `${bar.dataset.width}%`));
  });

  // Year ----------------------------------------------------------------------
  document.querySelectorAll('[data-year]').forEach((element) => {
    element.textContent = String(new Date().getFullYear());
  });

  // OS detection --------------------------------------------------------------
  function detectPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const p = platform.toLowerCase();
    if (p.includes('win') || ua.includes('windows')) return 'windows';
    if (p.includes('android') || ua.includes('android')) return 'android';
    if (p.includes('iphone') || p.includes('ipad') || ua.includes('iphone') || ua.includes('ipad')) return 'ios';
    if (p.includes('mac') || ua.includes('macintosh')) return 'mac';
    return 'other';
  }

  const platform = detectPlatform();
  document.documentElement.dataset.platform = platform;
  document.querySelectorAll('[data-os]').forEach((element) => {
    if (element.dataset.os === platform) element.classList.add('is-detected');
  });
  document.querySelectorAll('[data-os-name]').forEach((element) => {
    element.textContent = { windows: 'Windows', android: 'Android', ios: 'iPhone', mac: 'macOS', other: 'your device' }[platform];
  });

  // Downloads ----------------------------------------------------------------
  const DOWNLOADS = {
    windows: {
      file: `VoxBridge-Setup-${VERSION}-x64.exe`,
      page: `${RELEASES}`,
      label: 'Download for Windows',
      size: '≈ 39 MB',
    },
    portable: {
      file: `VoxBridge-${VERSION}-win64-portable.zip`,
      page: `${RELEASES}`,
      label: 'Portable build',
      size: '≈ 39 MB',
    },
    android: {
      file: `VoxBridge-${VERSION}-android.apk`,
      page: `${RELEASES}`,
      label: 'Download APK',
      size: '≈ 12 MB',
    },
    ios: {
      file: `VoxBridge-${VERSION}-unsigned.ipa`,
      page: `${RELEASES}`,
      label: 'Download IPA',
      size: '≈ 8 MB',
    },
  };

  const assetCache = new Map();

  async function resolveRelease() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function matchAsset(assets, fileName) {
    if (!Array.isArray(assets)) return null;
    return (
      assets.find((asset) => asset.name === fileName) ||
      assets.find((asset) => {
        if (!asset.name) return false;
        const lower = asset.name.toLowerCase();
        if (fileName.endsWith('.exe')) return lower.endsWith('.exe') && lower.includes('setup');
        if (fileName.endsWith('.apk')) return lower.endsWith('.apk');
        if (fileName.endsWith('.ipa')) return lower.endsWith('.ipa');
        return lower === fileName.toLowerCase();
      }) ||
      null
    );
  }

  async function hydrateDownloads() {
    const release = await resolveRelease();
    document.querySelectorAll('[data-download]').forEach((link) => {
      const key = link.dataset.download;
      const target = DOWNLOADS[key];
      if (!target) return;
      let url = `https://github.com/${REPO}/releases/latest/download/${target.file}`;
      let size = target.size;
      let available = null;
      if (release && release.assets) {
        const asset = matchAsset(release.assets, target.file);
        if (asset) {
          url = asset.browser_download_url;
          size = `${(asset.size / (1024 * 1024)).toFixed(1)} MB`;
          available = true;
          link.dataset.assetName = asset.name;
          const checksumEl = document.querySelector(`[data-checksum="${key}"]`);
          if (checksumEl && asset.digest) checksumEl.textContent = asset.digest.replace('sha256:', '');
        }
      }
      if (release && release.tag_name) {
        document.querySelectorAll('[data-version]').forEach((el) => (el.textContent = release.tag_name.replace(/^v/, '')));
      }
      link.setAttribute('href', url);
      if (available !== null) link.dataset.available = String(available);
      const sizeEl = document.querySelector(`[data-size="${key}"]`);
      if (sizeEl) sizeEl.textContent = size;
      assetCache.set(key, { url, size });
    });
    document.querySelectorAll('[data-download-status]').forEach((element) => {
      element.textContent = release
        ? `Latest release ${release.tag_name || VERSION} · published ${new Date(release.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : 'Direct downloads are served from the public GitHub release page.';
    });
  }

  hydrateDownloads();

  // Track a download click. Fire and forget, never blocks navigation.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-download]');
    if (!link) return;
    trackDownload(link.dataset.download);
  });

  function trackDownload(platformKey) {
    const endpoint = window.VOXBRIDGE_CONFIG?.supabaseUrl;
    const key = window.VOXBRIDGE_CONFIG?.supabaseAnonKey;
    if (!endpoint || !key) return;
    const payload = {
      platform: platformKey,
      version: VERSION,
      source: 'website',
    };
    try {
      navigator.sendBeacon?.(
        `${endpoint}/rest/v1/download_events?apikey=${encodeURIComponent(key)}`,
        new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      );
    } catch {
      /* offline is fine */
    }
  }

  // Copy buttons --------------------------------------------------------------
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = button.dataset.copy || document.querySelector(button.dataset.copyFrom)?.textContent || '';
    try {
      await navigator.clipboard.writeText(value);
      const previous = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = previous), 1600);
    } catch {
      /* clipboard blocked */
    }
  });

  // Supabase live counts ------------------------------------------------------
  const config = window.VOXBRIDGE_CONFIG || {};
  async function loadCounts() {
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    try {
      const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/download_counts`, {
        method: 'POST',
        headers: {
          apikey: config.supabaseAnonKey,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (!response.ok) return;
      const rows = await response.json();
      const counts = {};
      for (const row of rows || []) counts[row.platform] = Number(row.count) || 0;
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      document.querySelectorAll('[data-count]').forEach((element) => {
        const key = element.dataset.count;
        const value = key === 'total' ? total : counts[key];
        if (typeof value === 'number') element.textContent = value.toLocaleString();
      });
      document.querySelectorAll('[data-count-wrap]').forEach((element) => {
        element.hidden = false;
      });
    } catch {
      /* counters are optional */
    }
  }
  loadCounts();

  // Feedback form -------------------------------------------------------------
  const form = document.querySelector('[data-feedback]');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-feedback-status]');
      const data = new FormData(form);
      const payload = {
        email: String(data.get('email') || '').trim() || null,
        topic: String(data.get('topic') || 'general'),
        message: String(data.get('message') || '').trim(),
        platform: platform,
        app_version: VERSION,
      };
      if (payload.message.length < 5) {
        if (status) status.textContent = 'Please add a little more detail.';
        return;
      }
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        if (status) {
          status.innerHTML = `Email <a href="mailto:hello@voxbridge.app">hello@voxbridge.app</a> instead.`;
        }
        return;
      }
      try {
        const response = await fetch(`${config.supabaseUrl}/rest/v1/feedback`, {
          method: 'POST',
          headers: {
            apikey: config.supabaseAnonKey,
            'content-type': 'application/json',
            prefer: 'return=minimal',
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('request failed');
        if (status) status.textContent = 'Thanks — we read every message.';
        form.reset();
      } catch {
        if (status) status.innerHTML = 'Could not send. Email <a href="mailto:hello@voxbridge.app">hello@voxbridge.app</a>.';
      }
    });
  }

  // Live feature canvas (hero feature tile) -----------------------------------
  document.querySelectorAll('[data-wave]').forEach((canvas) => {
    const ctx = canvas.getContext('2d');
    let t = 0;
    let raf = null;
    const drawFrame = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const bars = 42;
      const gap = 3 * dpr;
      const bw = Math.max(1.5 * dpr, w / bars - gap);
      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue('--deck-ink').trim() || '#f4f1e8';
      const accent = styles.getPropertyValue('--accent').trim() || '#ff5a2e';
      for (let i = 0; i < bars; i += 1) {
        const phase = Math.sin(t * 1.4 + i * 0.42) * 0.5 + Math.sin(t * 0.7 + i * 0.17) * 0.5;
        const envelope = Math.sin((i / bars) * Math.PI);
        const value = Math.abs(phase) * envelope;
        const bh = Math.max(2 * dpr, value * h * 0.72);
        ctx.fillStyle = i === 21 ? accent : ink;
        ctx.globalAlpha = 0.35 + value * 0.6;
        const x = i * (bw + gap);
        const y = h / 2 - bh / 2;
        ctx.beginPath();
        const r = bw / 2;
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + bw, y, x + bw, y + bh, r);
        ctx.arcTo(x + bw, y + bh, x, y + bh, r);
        ctx.arcTo(x, y + bh, x, y, r);
        ctx.arcTo(x, y, x + bw, y, r);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      t += 0.016;
      drawFrame();
    };
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Paint one frame immediately so the tile is never an empty box, then
    // animate only while it is on screen (and not at all for reduced motion).
    requestAnimationFrame(() => {
      t = 1.2;
      drawFrame();
    });
    if (still) return;
    const observer = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !raf) loop();
            else if (!entry.isIntersecting && raf) {
              cancelAnimationFrame(raf);
              raf = null;
            }
          });
        })
      : null;
    if (observer) observer.observe(canvas);
    else loop();
  });

  // Smooth in-page anchors offset for sticky header ---------------------------
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const id = link.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top, behavior: 'smooth' });
      history.replaceState(null, '', id);
    });
  });

  // Expose for the download page's manual actions.
  window.VoxBridgeSite = {
    resolveRelease,
    platform,
    version: VERSION,
  };
})();
