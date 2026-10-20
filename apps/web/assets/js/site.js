/* VoxBridge website runtime. */
(function () {
  'use strict';

  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const REPO = 'sdlksdsf/Virtual-Mic';
  const VERSION = '1.0.1';

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

  // Platform ------------------------------------------------------------------
  const PLATFORM_LABELS = { windows: 'Windows', android: 'Android', ios: 'iPhone', mac: 'macOS', other: 'your device' };

  function detectPlatform() {
    const preset = document.documentElement.dataset.platform;
    if (preset && PLATFORM_LABELS[preset]) return preset;
    const ua = navigator.userAgent.toLowerCase();
    const raw = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const p = raw.toLowerCase();
    if (p.includes('android') || ua.includes('android')) return 'android';
    if (/iphone|ipod/.test(ua) || /ipad/.test(ua) || (p.includes('mac') && navigator.maxTouchPoints > 1)) return 'ios';
    if (p.includes('win') || ua.includes('windows')) return 'windows';
    if (p.includes('mac') || ua.includes('macintosh')) return 'mac';
    return 'other';
  }

  const platform = detectPlatform();
  document.documentElement.dataset.platform = platform;
  document.querySelectorAll('[data-os]').forEach((element) => {
    if (element.dataset.os === platform) element.classList.add('is-detected');
  });
  document.querySelectorAll('[data-os-name]').forEach((element) => {
    element.textContent = PLATFORM_LABELS[platform];
  });

  // Downloads ----------------------------------------------------------------
  const DOWNLOADS = {
    windows: {
      file: `VoxBridge-Setup-${VERSION}-x64.exe`,
      path: '/downloads/VoxBridge-windows-setup.exe',
      size: '≈ 40 MB',
    },
    portable: {
      file: `VoxBridge-${VERSION}-win64-portable.zip`,
      path: '/downloads/VoxBridge-windows-portable.zip',
      size: '≈ 38 MB',
    },
    android: {
      file: `VoxBridge-${VERSION}-android.apk`,
      path: '/downloads/VoxBridge-android.apk',
      size: '≈ 2 MB',
    },
    ios: {
      file: `VoxBridge-${VERSION}-unsigned.ipa`,
      path: '/downloads/VoxBridge-ios.ipa',
      size: '≈ 0.3 MB',
    },
  };

  // The build mirrors every artifact next to the site and writes this manifest.
  // Same-origin downloads are what fixed phones: no GitHub redirect, real
  // Content-Length, and range requests so a dropped signal resumes.
  async function loadManifest() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('/downloads/manifest.json', {
        cache: 'no-store',
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

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function hydrateDownloads() {
    const manifest = await loadManifest();
    const files = (manifest && manifest.files) || {};

    document.querySelectorAll('[data-download]').forEach((link) => {
      const key = link.dataset.download;
      const target = DOWNLOADS[key];
      if (!target) return;
      const entry = files[key];
      if (entry && entry.path) {
        link.setAttribute('href', entry.path);
        link.setAttribute('download', '');
        link.dataset.available = 'true';
        link.dataset.assetName = entry.name || target.file;
        if (entry.size) {
          document.querySelectorAll(`[data-size="${key}"]`).forEach((el) => (el.textContent = formatSize(entry.size)));
        }
        if (entry.sha256) {
          document.querySelectorAll(`[data-checksum="${key}"]`).forEach((el) => (el.textContent = entry.sha256));
        }
      } else {
        // The mirror is missing for this file; the release page still has it.
        link.setAttribute('href', `https://github.com/${REPO}/releases/latest/download/${target.file}`);
        link.removeAttribute('download');
      }
    });

    if (manifest && manifest.version) {
      document.querySelectorAll('[data-version]').forEach((element) => (element.textContent = manifest.version));
    }

    document.querySelectorAll('[data-download-status]').forEach((element) => {
      element.textContent = manifest && manifest.version
        ? `Latest release ${manifest.version} · downloads served from this site`
        : 'Downloads are served from the latest GitHub release.';
    });

    // The homepage hero must never offer a Windows .exe to a phone.
    const cta = document.querySelector('[data-primary-cta]');
    if (cta) {
      const label = cta.querySelector('[data-primary-label]');
      const icon = cta.querySelector('use');
      if (platform === 'android' && files.android) {
        cta.setAttribute('href', files.android.path);
        cta.setAttribute('download', '');
        cta.dataset.download = 'android';
        cta.dataset.assetName = files.android.name || 'VoxBridge-android.apk';
        if (label) label.textContent = 'Download the APK';
        if (icon) icon.setAttribute('href', '#i-android');
      } else if (platform === 'ios' && files.ios) {
        cta.setAttribute('href', files.ios.path);
        cta.setAttribute('download', '');
        cta.dataset.download = 'ios';
        cta.dataset.assetName = files.ios.name || 'VoxBridge-ios.ipa';
        if (label) label.textContent = 'Download the IPA';
        if (icon) icon.setAttribute('href', '#i-apple');
      }
    }
  }

  hydrateDownloads();

  // In-app browsers (Instagram, WhatsApp, Facebook, most Android WebViews)
  // silently swallow file downloads. Say so instead of leaving the user with a
  // progress bar that never finishes.
  function warnInAppDownload() {
    let toast = document.getElementById('inapp-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'inapp-toast';
      toast.className = 'inapp-toast';
      toast.setAttribute('role', 'alert');
      const title = document.createElement('strong');
      title.textContent = 'Downloads are blocked in this browser.';
      const body = document.createElement('span');
      body.textContent =
        'Tap ⋮ or the share button, choose “Open in Chrome” (Android) or “Open in Safari” (iPhone), then download again.';
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '✕';
      close.addEventListener('click', () => toast.remove());
      toast.append(title, body, close);
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 15000);
    }
    requestAnimationFrame(() => toast.classList.add('is-visible'));
  }

  // Track a download click. Fire and forget, never blocks navigation.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-download]');
    if (!link) return;
    if (document.documentElement.dataset.inapp === 'true') {
      event.preventDefault();
      warnInAppDownload();
      return;
    }
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
    hydrateDownloads,
    platform,
    version: VERSION,
  };
})();
