/* VoxBridge desktop renderer. */
/* eslint-disable no-undef */
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const bridge = window.voxbridge || window.createMockBridge();
  // Result of the last attempt to make the cable the Windows default input.
  let windowsDefault = null;
  // Monitoring plays the processed voice on this PC. With no virtual cable
  // there is nothing to monitor, and the app would just be looping audio into
  // the room, so the header switch is disabled until the cable is installed.
  let cableReady = true;

  const state = {
    app: {},
    settings: {},
    receiver: { running: false, code: '····', addresses: [] },
    service: { status: 'idle', mode: 'software' },
    recorder: { recording: false },
    setup: { phase: 'idle', progress: 0 },
  };

  let pipeline = null;
  let analyser = null;
  let analyserData = null;
  let muted = false;
  let recording = false;
  let recorderTimer = null;
  let testStream = null;
  let testTimer = null;
  let testRAF = null;
  let recordingStartedAt = 0;
  let lastMeter = null;
  let meterLevel = 0;
  let meterPeak = 0;
  let decodedPackets = 0;
  let currentView = 'live';
  let waveSmooth = null;

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', boot);

  async function boot() {
    document.body.classList.add(bridge.isDesktop ? 'desktop' : 'demo');
    document.body.classList.add(`platform-${bridge.platform || 'win32'}`);

    state.app = {};
    try {
      const initial = await bridge.getState();
      Object.assign(state, initial);
      state.settings = initial.settings || {};
      state.receiver = initial.receiver || state.receiver;
      state.service = initial.service || state.service;
      state.recorder = initial.recorder || state.recorder;
      state.setup = initial.setup || state.setup;
    } catch (error) {
      toast('bad', 'Could not load settings', error.message || 'Unknown error');
    }

    applyTheme(state.settings.theme || 'system', false);
    bindNavigation();
    bindActions();
    bindShortcuts();
    bindBridge();
    syncControls();
    renderAll();
    initAudio();
    renderQR();
    startPolling();
    if (!bridge.isDesktop) {
      $('#rail-platform').textContent = 'Demo';
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge events
  // ---------------------------------------------------------------------------
  function bindBridge() {
    bridge.on('app:receiver', (receiver) => {
      state.receiver = { ...state.receiver, ...receiver };
      renderReceiver();
    });
    bridge.on('app:phone', (phone) => {
      state.receiver.phone = phone;
      if (phone) {
        state.receiver.rtt = state.receiver.rtt || 18;
        pipeline?.resume();
        pipeline?.flush();
        if (state.receiver.rate) pipeline?.setOutputRate(state.receiver.rate);
        toast('ok', 'Phone connected', `${phone.name} is now your microphone.`);
      }
      renderReceiver();
    });
    bridge.on('app:phone-stats', (stats) => {
      if (!stats) return;
      Object.assign(state.receiver, {
        rtt: stats.rtt ?? state.receiver.rtt,
        jitter: stats.jitter ?? state.receiver.jitter,
        bufferDepth: stats.buffer ?? state.receiver.bufferDepth,
        bitrate: stats.bitrate ?? state.receiver.bitrate,
        lost: stats.lost ?? state.receiver.lost,
        rx: stats.rx ?? state.receiver.rx,
      });
      updateStats();
    });
    bridge.on('app:phone-audio', ({ packet }) => {
      if (!pipeline || !pipeline.ready) return;
      const buffer = base64ToArrayBuffer(packet);
      if (pipeline.pushPacket(buffer)) {
        decodedPackets += 1;
        if (decodedPackets === 4) {
          document.body.classList.add('is-live');
          renderReceiver();
        }
      }
    });
    bridge.on('app:pair-code', (code) => {
      state.receiver.code = code;
      renderPairing();
    });
    bridge.on('app:service', (service) => {
      state.service = { ...state.service, ...service };
      renderService();
    });
    bridge.on('app:service-event', (event) => {
      if (!event) return;
      // The native service tells us whether it managed to make the cable the
      // Windows default input. That is the difference between "audio arrives"
      // and "Discord actually records it", so it is worth reporting precisely.
      if (event.ev === 'default-input') {
        windowsDefault = { claimed: Boolean(event.claimed), device: event.device || '', previous: event.previous || '' };
        renderVirtualStatus();
        if (event.claimed) {
          toast('ok', 'Windows microphone switched', `${event.device || 'CABLE Output'} is now the default input.`);
        } else {
          toast('warn', 'Choose CABLE Output once', 'Windows would not switch automatically. Pick it in Sound settings and it will stick.');
        }
        return;
      }
      if (event.ev === 'default-input-restored') {
        windowsDefault = null;
        renderVirtualStatus();
        return;
      }
      if (event.ev === 'error') {
        toast('bad', 'Capture service', event.message || event.code || 'The audio service stopped.');
      }
      if (event.ev === 'warn') {
        toast('warn', 'Audio warning', event.message || event.code);
      }
    });
    bridge.on('app:setup', (setup) => {
      const previous = state.setup.phase;
      state.setup = setup;
      renderSetup();
      if (setup.phase === 'done' && previous !== 'done') {
        toast('ok', 'Virtual microphone ready', 'Pick “CABLE Output” in the app you are using.');
        refreshDevices();
      }
      if (setup.phase === 'manual' && previous !== 'manual') {
        toast('warn', 'Finish installation manually', setup.error || 'Open the official VB-Audio page.');
      }
    });
    bridge.on('app:recorder', (recorder) => {
      state.recorder = { ...state.recorder, ...recorder };
      recording = Boolean(recorder.recording);
      renderRecorder();
    });
    bridge.on('app:theme', () => {});
    bridge.on('app:settings', (settings) => {
      state.settings = { ...state.settings, ...settings };
      applyTheme(state.settings.theme, false);
      syncControls(false);
    });
    bridge.on('app:mute', (on) => setMuted(Boolean(on), false));
    bridge.on('app:phone-mute', (on) => setMuted(Boolean(on), false));
    bridge.on('app:toast', (payload) => toast(payload.kind, payload.title, payload.body));
    bridge.on('app:log', () => {});
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------
  async function initAudio() {
    try {
      pipeline = new VoxBridgeAudio.AudioPipeline({
        onFrame: (packet) => {
          bridge.sendProcessedAudio(packet);
        },
        onMeter: (meter) => {
          lastMeter = meter;
          meterLevel = meter.outRms;
          meterPeak = meter.peak;
          bridge.sendTelemetry({
            level: Math.min(1, meter.outRms * 2.2),
            peak: meter.peak,
            buffer: meter.bufferMs,
          });
          updateMeter(meter);
        },
      });
      await pipeline.init();
      pipeline.setOutputRate(state.settings.rate || 48000);
      pipeline.configure(audioSettings());
      pipeline.setMuted(muted);
      pipeline.setMonitor(Boolean(state.settings.monitor), state.settings.monitorGain ?? 0.8);
      window.__pipeline = pipeline;
      analyser = pipeline.context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      analyserData = new Uint8Array(analyser.fftSize);
      const silentSink = pipeline.context.createGain();
      silentSink.gain.value = 0;
      pipeline.node.connect(analyser);
      analyser.connect(silentSink).connect(pipeline.context.destination);
      document.addEventListener('pointerdown', () => pipeline?.resume(), { once: true });
      document.addEventListener('keydown', () => pipeline?.resume(), { once: true });
      drawWave();
    } catch (error) {
      console.error(error);
      toast('bad', 'Audio engine unavailable', 'The Web Audio worklet could not start in this environment.');
    }
  }

  function audioSettings() {
    const s = state.settings;
    return {
      denoise: Number(s.denoise ?? 3),
      gate: s.gate !== false,
      agc: s.agc !== false,
      presence: Number(s.presence ?? 4),
      warmth: Number(s.warmth ?? 3),
      compressor: s.compressor !== false,
      limiter: s.limiter !== false,
      highpass: s.highpass !== false,
      boost: Number(s.outputGainDb ?? 0),
      prefillMs: Number(s.prefillMs ?? 60),
    };
  }

  function pushAudioSettings() {
    pipeline?.configure(audioSettings());
    pipeline?.setOutputRate(state.settings.rate || 48000);
    pipeline?.setMonitor(Boolean(state.settings.monitor), state.settings.monitorGain ?? 0.8);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // Waveform ------------------------------------------------------------------
  function drawWave() {
    const canvas = $('#wave');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      requestAnimationFrame(draw);
      if (document.hidden) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const live = document.body.classList.contains('is-live') && pipeline?.startedAt;
      const styles = getComputedStyle(document.documentElement);
      const ink = styles.getPropertyValue('--deck-ink').trim() || '#f4f1e8';
      const accent = styles.getPropertyValue('--accent').trim() || '#ff5a2e';

      if (!analyser || !live) {
        ctx.strokeStyle = 'rgba(244,241,232,0.18)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.stroke();
        return;
      }

      analyser.getByteTimeDomainData(analyserData);
      const bars = 68;
      const step = Math.floor(analyserData.length / bars);
      const gap = 3 * dpr;
      const barWidth = Math.max(1.5 * dpr, width / bars - gap);
      if (!waveSmooth || waveSmooth.length !== bars) waveSmooth = new Float32Array(bars);
      for (let i = 0; i < bars; i += 1) {
        let value = 0;
        for (let j = 0; j < step; j += 1) {
          value = Math.max(value, Math.abs(analyserData[i * step + j] / 128 - 1));
        }
        const shaped = Math.pow(Math.min(1, value * 1.7), 0.62);
        waveSmooth[i] = waveSmooth[i] * 0.55 + shaped * 0.45;
      }
      for (let i = 0; i < bars; i += 1) {
        const eased = waveSmooth[i];
        const h = Math.max(2 * dpr, eased * height * 0.84);
        ctx.fillStyle = i % 17 === 8 ? accent : ink;
        ctx.globalAlpha = 0.26 + Math.min(0.74, eased * 1.9);
        const x = i * (barWidth + gap);
        roundRect(ctx, x, mid - h / 2, barWidth, h, barWidth / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = ink;
      ctx.fillRect(0, mid - 0.5 * dpr, width, 1 * dpr);
      ctx.globalAlpha = 1;
    };
    draw();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderAll() {
    renderReceiver();
    renderPairing();
    renderService();
    renderSetup();
    renderRecorder();
    renderRemembered();
    renderAddresses();
    renderStats();
    renderSettings();
    refreshDevices();
    setMuted(Boolean(state.settings.muted), false);
    setTimeout(() => refreshDevices(), 1200);
  }

  function renderReceiver() {
    const phone = state.receiver.phone;
    const live = Boolean(phone) && decodedPackets > 0;
    document.body.classList.toggle('is-live', live);
    const deck = $('#deck');
    if (deck) deck.dataset.live = String(live);

    const pill = $('#conn-pill');
    if (pill) {
      pill.dataset.state = live ? (muted ? 'paused' : 'live') : 'idle';
      $('#conn-text').textContent = live
        ? muted
          ? 'Muted'
          : 'On air'
        : phone
          ? 'Connected'
          : 'Waiting for phone';
    }

    $('#live-title').innerHTML = phone
      ? muted
        ? 'Muted, but <em>still here.</em>'
        : 'Your voice is <em>live.</em>'
      : 'Waiting for your <em>phone.</em>';
    $('#live-lede').textContent = phone
      ? `${phone.name} over ${/^(127\.|::1|localhost)/.test(phone.address || '') ? 'USB' : phone.address || 'Wi-Fi'} · ${(state.receiver.rate || 48000) / 1000} kHz · ${state.receiver.codec === 'adpcm' ? 'ADPCM' : 'PCM'}`
      : 'Open VoxBridge on your phone. It shows up here on its own, no cables, no drivers to fight.';

    $('#source-name').textContent = phone ? phone.name : 'Nothing connected';
    $('#source-sub').textContent = phone
      ? live
        ? 'Streaming clean audio'
        : 'Handshaking…'
      : 'Scanning your network';
    $('#rail-device-name').textContent = phone ? phone.name : 'No phone yet';
    $('#rail-device-sub').textContent = phone ? (live ? 'Connected · on air' : 'Connecting…') : 'Waiting for Wi-Fi';
    $('#connect-strip').classList.toggle('is-hidden', Boolean(phone));
    $('#wave-rate').textContent = `${((state.receiver.rate || 48000) / 1000).toFixed(1).replace('.0', '')} kHz · mono`;
    $('#wave-hint').textContent = phone ? (live ? 'Receiving' : 'Waiting for the first packet') : 'Waiting for audio';
    updateStats();
    renderPairing();
  }

  function updateStats() {
    const r = state.receiver;
    const phone = r.phone;
    const rtt = Number(r.rtt || 0);
    const buffer = Number(lastMeter?.bufferMs ?? r.bufferDepth ?? state.settings.prefillMs ?? 60);
    const estimate = phone && decodedPackets ? Math.round(rtt / 2 + buffer + 17) : null;
    $('#stat-latency').textContent = estimate ?? '—';
    $('#stat-jitter').textContent = phone ? Math.round(r.jitter || 0) : '—';
    $('#stat-lost').textContent = phone ? String(r.lost || 0) : '—';
    $('#stat-bitrate').textContent = phone ? Math.round(r.bitrate || 0) : '—';
    const packets = r.rx || decodedPackets;
    $('#packets-label').textContent = `${packets.toLocaleString()} packets`;
    renderRemembered();
  }

  function renderPairing() {
    const code = state.receiver.code || '····';
    $('#pair-code').textContent = String(code).split('').join(' ');
    const link = pairingLink();
    renderQR(link);
    const list = $('#net-list');
    const addresses = state.receiver.addresses || [];
    list.innerHTML = addresses.length
      ? addresses
          .map(
            (entry) => `
        <div class="net-row">
          <svg><use href="#i-wifi" /></svg>
          <span>${escapeHtml(entry.address)}</span>
          <span class="tag">${escapeHtml(entry.name || 'LAN')}</span>
          <button class="copy-btn" data-copy="${escapeHtml(entry.address)}" aria-label="Copy address">
            <svg><use href="#i-copy" /></svg>
          </button>
        </div>`,
          )
          .join('')
      : '<p class="small muted">No active network found. Connect to Wi-Fi or Ethernet.</p>';

    const found = $('#found-list');
    const phone = state.receiver.phone;
    found.innerHTML = phone
      ? `<div class="found-item">
           <div class="found-icon"><svg><use href="#i-phone" /></svg></div>
           <div class="found-copy"><strong>${escapeHtml(phone.name)}</strong><span>${escapeHtml(/^(127\.|::1|localhost)/.test(phone.address || '') ? 'USB link' : phone.address || 'LAN')} · ${escapeHtml(phone.device || 'phone')}</span></div>
           <span class="status-chip ok">Connected</span>
         </div>`
      : `<div class="found-item">
           <div class="found-icon"><svg><use href="#i-phone" /></svg></div>
           <div class="found-copy"><strong>No phone connected</strong><span>Open the app and it appears here</span></div>
           <span class="status-chip">Waiting</span>
         </div>`;
    const chip = $('#discovery-chip');
    chip.textContent = state.receiver.running ? 'Listening' : 'Paused';
    chip.classList.toggle('ok', Boolean(state.receiver.running));
  }

  function pairingLink() {
    const address = (state.receiver.addresses && state.receiver.addresses[0]?.address) || '192.168.1.24';
    return `voxbridge://pair?host=${encodeURIComponent(address)}&port=${state.receiver.port || 8720}&code=${encodeURIComponent(
      state.receiver.code || '',
    )}`;
  }

  function renderQR(link = pairingLink()) {
    const root = $('#qr');
    if (!root) return;
    if (typeof QRCode === 'undefined') {
      root.innerHTML = '<p style="font-size:9px;color:#555;padding:4px">QR unavailable</p>';
      return;
    }
    root.innerHTML = '';
    const canvas = document.createElement('canvas');
    root.appendChild(canvas);
    QRCode.toCanvas(canvas, link, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#15150F', light: '#FFFFFF' },
    }).catch(() => {
      root.innerHTML = '<p style="font-size:9px;color:#555;padding:4px">QR unavailable</p>';
    });
  }

  function renderAddresses() {
    const list = $('#addr-list');
    if (!list) return;
    const addresses = state.receiver.addresses || [];
    list.innerHTML = addresses.length
      ? addresses
          .map(
            (entry) => `
        <div class="addr-row">
          <span>${escapeHtml(entry.name || 'LAN')}</span>
          <code>${escapeHtml(entry.address)}:${state.receiver.port || 8720}</code>
          <button class="copy-btn" data-copy="${escapeHtml(entry.address)}" aria-label="Copy address">
            <svg><use href="#i-copy" /></svg>
          </button>
        </div>`,
          )
          .join('')
      : '<p class="small muted">No network interfaces detected.</p>';
    const adb = $('#adb-command');
    if (adb) adb.textContent = `adb reverse tcp:${state.receiver.port || 8720} tcp:${state.receiver.port || 8720}`;
  }

  function renderRemembered() {
    const list = $('#remember-list');
    if (!list) return;
    const remembered = state.settings.remembered || {};
    const entries = Object.values(remembered).filter((entry) => entry && entry.name);
    if (!entries.length) {
      list.innerHTML =
        '<p class="muted small">Devices you choose to remember will skip the code next time.</p>';
      return;
    }
    list.innerHTML = entries
      .map(
        (entry) => `<div class="remember-row">
          <svg width="16" height="16"><use href="#i-phone" /></svg>
          <div><strong>${escapeHtml(entry.name)}</strong><br><span>${escapeHtml(entry.deviceId || 'remembered device')}</span></div>
          <time>${entry.addedAt ? new Date(entry.addedAt).toLocaleDateString() : ''}</time>
        </div>`,
      )
      .join('');
  }

  function renderService() {
    const service = state.service;
    const native = service.mode === 'native';
    const ready = service.status === 'ready';
    const fallback = service.fallback;
    const nullSink = Boolean(service.nullSink);
    const chip = $('#service-chip');
    chip.textContent = !ready
      ? capitalize(service.status || 'idle')
      : nullSink
        ? 'No cable'
        : fallback
          ? 'Fallback'
          : 'Running';
    chip.className = 'status-chip ' + (ready && !fallback && !nullSink ? 'ok' : ready ? 'warn' : '');

    $('#engine-mode').textContent = native ? 'Native · WASAPI' : 'Software sink';
    $('#engine-device').textContent = service.device || 'No endpoint';
    $('#engine-buffer').textContent = service.bufferMs ? `${service.bufferMs} ms` : '—';
    $('#engine-underruns').textContent = String(lastMeter?.underruns ?? 0);
    $('#engine-version').textContent = service.version || '—';
    $('#engine-note').textContent = native
      ? 'Renders with WASAPI shared mode and automatic sample-rate conversion, so any endpoint the user picks will work.'
      : 'Running in software mode. Install VoxBridge on Windows to render into a real audio endpoint.';

    const notice = $('#service-notice');
    const showNotice = !native || fallback || nullSink || service.status === 'error';
    notice.hidden = !showNotice;
    if (showNotice) {
      $('#service-notice-title').textContent = nullSink
        ? 'Silent until the cable is installed'
        : fallback
          ? 'No virtual microphone found'
          : service.status === 'error'
            ? 'Capture service stopped'
            : 'Virtual microphone not ready';
      $('#service-notice-body').textContent = nullSink
        ? 'VoxBridge is deliberately not playing into your speakers — that is what caused the echo. Install VB-CABLE once and it will route into every app.'
        : fallback
          ? 'Set one up once and every app on Windows will see VoxBridge as a microphone.'
          : service.status === 'error'
            ? service.lastError || 'Restart the service from Studio.'
            : 'Install the native service to route audio into a virtual cable.';
    }
    renderVirtualStatus();
  }

  function renderVirtualStatus() {
    const render = state.devices?.render || [];
    const device = pickVirtualDevice(render) || (state.service.device ? { name: state.service.device } : null);
    // The server reports the truth for both directions: a cable is only usable
    // when Windows exposes a *recording* endpoint for it. Fall back to the old
    // name heuristic when talking to an older build.
    const reported = state.virtual;
    const installed = reported
      ? Boolean(reported.present || reported.installed)
      : Boolean(device && /cable input|voicemeeter|virtual audio cable|voxbridge/i.test(device.name));
    // Only disable the switch when we positively know there is no cable. In
    // software/preview mode the device list is empty for reasons that have
    // nothing to do with the user's machine.
    const known = Boolean(reported) || state.service?.mode === 'native';
    cableReady = !state.service?.nullSink && (!known || installed);
    renderMonitorButton();
    const chip = $('#virtual-chip');
    const studioChip = $('#studio-virtual-chip');
    const badge = $('#endpoint-badge');
    const endpointName = $('#endpoint-name');
    const endpointSub = $('#endpoint-sub');

    if (installed) {
      chip.textContent = 'Installed';
      chip.className = 'status-chip ok';
      studioChip.textContent = 'Ready';
      studioChip.className = 'status-chip ok';
      badge.textContent = 'Active';
      endpointName.textContent = device.name;
      endpointSub.textContent = 'Windows uses it as the default microphone, so most apps need no setup at all.';
      $('#virtual-device').textContent = device.name;
      $('#virtual-sub').textContent = 'Installed and ready — Windows apps can record from this now';
      const defaultNotice = $('#default-notice');
      if (windowsDefault && windowsDefault.claimed) {
        $('#virtual-foot').textContent = 'Set as the Windows default microphone';
        if (defaultNotice) defaultNotice.hidden = true;
      } else if (windowsDefault && !windowsDefault.claimed) {
        $('#virtual-foot').textContent = 'Installed · not the Windows default yet';
        if (defaultNotice) defaultNotice.hidden = false;
      } else {
        $('#virtual-foot').textContent = 'Verified signature · nothing else to do';
        if (defaultNotice) defaultNotice.hidden = true;
      }
      // Once it is installed and detected, there is nothing to download. The
      // repair action moves out of the way instead of asking again on every
      // launch, which is what made the app feel like it had forgotten.
      const cta = $('#virtual-cta');
      cta.hidden = true;
      cta.disabled = true;
      const studioCta = $('#studio-cable-cta');
      if (studioCta) studioCta.hidden = true;
      const studioPage = $('#studio-cable-page');
      if (studioPage) studioPage.hidden = true;
    } else {
      chip.textContent = state.service.mode === 'native' ? 'Missing' : 'Unavailable';
      chip.className = 'status-chip warn';
      studioChip.textContent = 'Not installed';
      studioChip.className = 'status-chip warn';
      badge.textContent = '—';
      endpointName.textContent = 'No virtual microphone';
      endpointSub.textContent = 'Install VB-CABLE once; VoxBridge configures it automatically.';
      $('#virtual-device').textContent = 'No virtual cable found';
      $('#virtual-sub').textContent = 'Setup takes about a minute';
      $('#virtual-foot').textContent = 'Official VB-Audio download';
      const cta = $('#virtual-cta');
      cta.hidden = false;
      cta.disabled = false;
      cta.innerHTML = '<svg><use href="#i-download" /></svg><span>Set up virtual mic</span>';
      const studioCta = $('#studio-cable-cta');
      if (studioCta) studioCta.hidden = false;
      const studioPage = $('#studio-cable-page');
      if (studioPage) studioPage.hidden = false;
    }
    $('#virtual-test').disabled = !state.service || state.service.mode !== 'native';

    const claim = $('#claim-default');
    if (claim) {
      const on = state.settings?.claimDefaultInput !== false;
      claim.checked = on;
      const label = $('#claim-state');
      if (label) label.textContent = on ? 'On' : 'Off';
    }
    $('#test-btn-label').textContent = suiteTestLabel();
    $('#record-folder').textContent = shortPath(state.app.recordingDir || 'Music / VoxBridge');
  }

  function suiteTestLabel() {
    return testStream || testTimer ? 'Testing…' : 'Run 3-second test';
  }

  function renderSetup() {
    const setup = state.setup || {};
    const active = ['downloading', 'extracting', 'installing'].includes(setup.phase);
    const progressVisible = active || setup.phase === 'manual';
    const progress = Math.max(0, Math.min(100, setup.progress || 0));
    $('#setup-progress').hidden = !progressVisible;
    $('#studio-progress').hidden = !progressVisible;
    $('#setup-bar').style.width = `${progress}%`;
    $('#studio-bar').style.width = `${progress}%`;
    $('#setup-message').textContent = setup.message || setup.error || 'Preparing…';
    $('#studio-message').textContent = setup.message || setup.error || 'Preparing…';
    if (active) {
      $('#service-notice-title').textContent = 'Setting up the virtual microphone';
      $('#service-notice-body').textContent = setup.message || 'This can take a minute.';
    }
  }

  function renderRecorder() {
    const rec = state.recorder || {};
    const active = Boolean(rec.recording);
    recording = active;
    ['#record-label', '#record-label-2'].forEach((selector, index) => {
      const el = $(selector);
      if (!el) return;
      el.textContent = active ? 'Stop recording' : index === 0 ? 'Record' : 'Start recording';
    });
    ['#record-btn', '#record-btn-2'].forEach((selector) => {
      const el = $(selector);
      if (!el) return;
      el.classList.toggle('is-recording', active);
      if (active) el.classList.remove('primary');
    });
    const chip = $('#record-chip');
    chip.textContent = active ? 'Recording' : 'Idle';
    chip.className = 'status-chip ' + (active ? 'warn' : '');
    const duration = active ? Math.max(0, Date.now() - (rec.startedAt || Date.now())) : rec.durationMs || 0;
    $('#record-time').textContent = formatDuration(active ? duration : rec.durationMs || 0);
    $('#record-size').textContent = `${((rec.bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
    $('#record-chip').classList.toggle('warn', active);
  }

  function renderSettings() {
    const s = state.settings;
    $('#tray-toggle').checked = s.tray !== false;
    $('#autostart-toggle').checked = Boolean(s.autoStart);
    $('#pairing-toggle').checked = s.requirePairing !== false;
    $('#remember-toggle').checked = s.rememberDevices !== false;
    $('#settings-rate').value = String(s.rate || 48000);
    $('#settings-codec').value = s.codec || 'pcm16';
    $('#settings-frame').value = String(s.frameMs || 20);
    $('#about-platform').textContent = `${platformName(state.app.platform)} · ${state.app.arch || 'x64'}`;
    $$('#theme-picker [data-theme-value]').forEach((button) => {
      button.classList.toggle('is-active', (s.theme || 'system') === button.dataset.themeValue);
    });
    renderStats();
  }

  function renderStats() {
    const s = state.settings;
    $('#denoise').value = String(s.denoise ?? 3);
    $('#presence').value = String(s.presence ?? 4);
    $('#warmth').value = String(s.warmth ?? 3);
    $('#buffer').value = String(s.prefillMs ?? 60);
    $('#boost').value = String(s.outputGainDb ?? 0);
    $('#monitor-gain').value = String(Math.round((s.monitorGain ?? 0.8) * 100));
    $('#gate').checked = s.gate !== false;
    $('#agc').checked = s.agc !== false;
    $('#limiter').checked = s.limiter !== false;
    $('#monitor').checked = Boolean(s.monitor);
    $('#monitor2').checked = Boolean(s.monitor);
    $('#monitor-state').textContent = s.monitor ? 'On' : 'Off';
    $('#monitor-state-2').textContent = s.monitor ? 'On' : 'Off';
    $('#denoise-val').textContent = ['Off', 'Light', 'Medium', 'Strong', 'Max'][Number(s.denoise ?? 3)];
    $('#presence-val').textContent = `+${s.presence ?? 4} dB`;
    $('#warmth-val').textContent = `+${s.warmth ?? 3} dB`;
    $('#buffer-val').textContent = `${s.prefillMs ?? 60} ms`;
    $('#boost-val').textContent = `${s.outputGainDb ?? 0} dB`;
    $('#monitor-gain-val').textContent = `${Math.round((s.monitorGain ?? 0.8) * 100)}%`;
    $('#device-select').value = s.serviceDevice || '';
    $('#rate-select').value = String(s.rate || 48000);
    $('#codec-select').value = s.codec || 'pcm16';
    $('#quality-seg').querySelectorAll('button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.quality === (s.quality || 'balanced'));
    });
    $('#quality-chip').textContent = capitalize(s.quality || 'balanced');
    $$('input[type=range]').forEach(setRangeFill);
    renderReceiver();
  }

  function renderMeterOnly() {
    const peak = meterPeak || 0;
    const level = meterLevel || 0;
    const db = 20 * Math.log10(level + 1e-6);
    $('#level-db').textContent = level > 0.0005 ? `${db.toFixed(1)} dB` : '−∞ dB';
    $('#wave-peak').textContent = peak > 0.001 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : '−∞ dB';
  }

  // A suspended AudioContext is the one failure that looks like "connected but
  // silent". Surface it plainly instead of showing a dead meter.
  function renderAudioHealth() {
    const notice = $('#audio-notice');
    if (!notice) return;
    const stalled = Boolean(pipeline && !pipeline.running && pipeline.packets > 8);
    notice.hidden = !stalled;
    if (stalled) {
      $('#audio-notice-body').textContent =
        'Windows is holding the audio engine paused. Click here once and sound will resume immediately.';
    }
  }

  function updateMeter(meter) {
    renderAudioHealth();
    const level = Math.max(0, Math.min(1, (meter.outRms || 0) * 2.4));
    meterLevel = meter.outRms || 0;
    meterPeak = meter.peak || 0;
    $('#meter-fill').style.width = `${Math.pow(level, 0.65) * 100}%`;
    const peak = Math.max(0, Math.min(1, (meter.peak || 0) * 1.1));
    const peakEl = $('#meter-peak');
    peakEl.style.left = `${peak * 100}%`;
    peakEl.style.opacity = peak > 0.01 ? '0.9' : '0';
    $('#buffer-label').textContent = `buffer ${Math.round(meter.bufferMs || 0)} ms`;
    renderMeterOnly();
    if (meter.started && decodedPackets > 0) {
      document.body.classList.add('is-live');
    }
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------
  async function refreshDevices() {
    try {
      const devices = await bridge.listDevices();
      state.devices = devices;
      const render = devices.render || [];
      const select = $('#device-select');
      if (select) {
        const current = state.settings.serviceDevice;
        select.innerHTML =
          '<option value="">Automatic — best virtual cable</option>' +
          render
            .map(
              (device) =>
                `<option value="${escapeHtml(device.name)}" ${
                  device.name === current ? 'selected' : ''
                }>${escapeHtml(device.name)}${device.default ? ' — default' : ''}</option>`,
            )
            .join('');
      }
      renderVirtualStatus();
      const native = devices.native;
      if (!native && state.service.mode === 'native') {
        $('#virtual-sub').textContent = 'Device enumeration unavailable';
      }
    } catch (error) {
      toast('bad', 'Could not list devices', error.message || 'Unknown error');
    }
  }

  function pickVirtualDevice(render) {
    if (!Array.isArray(render)) return null;
    return (
      render.find((device) => /cable input/i.test(device.name)) ||
      render.find((device) => /voicemeeter input|voice meeter input/i.test(device.name)) ||
      render.find((device) => /virtual audio cable|vbcable/i.test(device.name)) ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function syncControls(bindRanges = true) {
    const s = state.settings;
    $('#monitor').checked = Boolean(s.monitor);
    $('#monitor2').checked = Boolean(s.monitor);
    renderMonitorButton();
    $('#gate').checked = s.gate !== false;
    $('#agc').checked = s.agc !== false;
    $('#limiter').checked = s.limiter !== false;
    $('#denoise').value = String(s.denoise ?? 3);
    if (bindRanges) {
      $$('input[type=range]').forEach(setRangeFill);
    }
    renderStats();
    renderSettings();
  }

  // Monitoring is the one control that can make the user hear themselves, and
  // a speaker playing the microphone back into the phone is exactly how an
  // echo starts. It is therefore a labelled switch in the header, off by
  // default, and it says what it does.
  function renderMonitorButton() {
    const button = $('#monitor-btn');
    if (!button) return;
    button.disabled = !cableReady;
    const on = Boolean(state.settings.monitor);
    const label = $('#monitor-label');
    if (label) label.textContent = on ? 'Monitor on' : 'Monitor off';
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.title = !cableReady
      ? 'Install the virtual cable first — until then there is nothing to monitor.'
      : on
        ? 'Your voice is playing on this PC. Turn it off, or use headphones, to avoid feedback.'
        : 'Play your processed voice on this PC so you can hear what the app hears';
  }

  function setRangeFill(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value || 0);
    const percent = ((value - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${percent}%`);
  }

  async function update(patch, options = {}) {
    state.settings = { ...state.settings, ...patch };
    renderStats();
    if (options.audio !== false) pushAudioSettings();
    try {
      const next = await bridge.setSettings(patch);
      if (next?.settings) state.settings = next.settings;
    } catch (error) {
      toast('bad', 'Setting not saved', error.message || 'Unknown error');
    }
  }

  function setMuted(on, notify = true) {
    muted = Boolean(on);
    pipeline?.setMuted(muted);
    if (notify && bridge.isDesktop) bridge.sendMute(muted);
    if (notify) update({ muted });
    const button = $('#mute-btn');
    button.classList.toggle('is-on', muted);
    button.setAttribute('aria-pressed', String(muted));
    $('#mute-label').textContent = muted ? 'Unmute' : 'Mute';
    renderReceiver();
  }

  function bindNavigation() {
    $$('[data-nav]').forEach((button) => {
      button.addEventListener('click', () => showView(button.dataset.nav));
    });
  }

  function showView(name) {
    if (!name) return;
    currentView = name;
    $$('.view').forEach((view) => {
      const active = view.dataset.view === name;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    });
    $$('[data-nav]').forEach((button) => {
      const active = button.dataset.nav === name;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    $('#crumb-view').textContent = {
      live: 'Live',
      pair: 'Pair',
      studio: 'Studio',
      settings: 'Settings',
      help: 'Guide',
    }[name] || 'Live';
    $('#stage').scrollTop = 0;
    if (name === 'pair') {
      renderPairing();
      renderQR();
    }
    if (name === 'studio') refreshDevices();
  }

  function bindActions() {
    document.addEventListener('click', async (event) => {
      const copyTarget = event.target.closest('[data-copy]');
      if (copyTarget) {
        copyText(copyTarget.dataset.copy);
        toast('ok', 'Copied', copyTarget.dataset.copy);
        return;
      }
      const actionEl = event.target.closest('[data-action]');
      const action = actionEl?.dataset.action;
      const themeButton = event.target.closest('[data-theme-value]');
      if (themeButton) {
        applyTheme(themeButton.dataset.themeValue, true);
        return;
      }
      if (!action) return;
      switch (action) {
        case 'toggle-mute':
          setMuted(!muted);
          break;
        case 'toggle-record':
          await toggleRecording();
          break;
        case 'go-pair':
          showView('pair');
          break;
        case 'go-studio':
          showView('studio');
          break;
        case 'rotate-code':
          await bridge.newPairCode();
          toast('ok', 'New pairing code', 'The previous code no longer works.');
          break;
        case 'copy-link':
          copyText(pairingLink());
          toast('ok', 'Pairing link copied', 'Open it on your phone to connect instantly.');
          break;
        case 'copy-adb':
          copyText(`adb reverse tcp:${state.receiver.port || 8720} tcp:${state.receiver.port || 8720}`);
          toast('ok', 'Command copied');
          break;
        case 'refresh-discovery':
          await bridge.restartReceiver();
          toast('ok', 'Receiver restarted', 'Phones can find this PC again.');
          renderPairing();
          break;
        case 'forget-devices':
          await bridge.forgetDevices();
          state.settings.remembered = {};
          renderRemembered();
          toast('ok', 'Remembered devices cleared');
          break;
        case 'sound-settings':
      if (bridge.openSoundSettings) {
        bridge.openSoundSettings().catch(() => {});
      } else {
        toast('warn', 'Open Sound settings', 'Settings → System → Sound → Input, then choose CABLE Output.');
      }
      break;

    case 'resume-audio':
          await pipeline?.resume();
          renderAudioHealth();
          if (pipeline?.running) toast('ok', 'Audio resumed', 'Your voice is reaching the virtual microphone.');
          break;
        case 'setup-virtual':
          setupVirtual();
          break;
        case 'open-virtual-download':
          bridge.openVirtualDownload();
          break;
        case 'restart-service':
          await bridge.restartService();
          toast('ok', 'Capture service restarting');
          break;
        case 'restart-receiver':
          await bridge.restartReceiver();
          toast('ok', 'Receiver restarted');
          break;
        case 'refresh-devices':
          await refreshDevices();
          toast('ok', 'Device list refreshed');
          break;
        case 'test-virtual':
          runVirtualTest();
          break;
        case 'close-test':
          closeTest();
          break;
        case 'run-test-again':
          runVirtualTest();
          break;
        case 'toggle-monitor': {
          const next = !state.settings.monitor;
          await update({ monitor: next });
          renderMonitorButton();
          if (next) {
            toast('warn', 'Monitoring is on', 'You will hear your own voice on this PC. Use headphones — a speaker will feed back into the phone.');
          } else {
            toast('ok', 'Monitoring off', 'Nothing is played on this PC.');
          }
          break;
        }
        case 'open-recordings':
          await bridge.openRecordings();
          break;
        case 'export-diagnostics':
          await exportDiagnostics();
          break;
        case 'open-github':
          bridge.openExternal('https://github.com/sdlksdsf/VoxBridge');
          break;
        case 'open-site':
          bridge.openExternal('https://voxbridge.vercel.app');
          break;
        case 'open-privacy':
          bridge.openExternal('https://voxbridge.vercel.app/privacy.html');
          break;
        case 'open-license':
          bridge.openExternal('https://voxbridge.vercel.app/licenses.html');
          break;
        case 'open-issues':
          bridge.openExternal('https://github.com/sdlksdsf/VoxBridge/issues/new');
          break;
        case 'reset-settings':
          await resetSettings();
          break;
        case 'preset-clean':
          await update({ denoise: 3, gate: true, agc: true, presence: 4, warmth: 3, compressor: true, limiter: true, highpass: true, outputGainDb: 0 });
          toast('ok', 'Clean preset restored');
          break;
        default:
          break;
      }
    });

    $('#theme-btn').addEventListener('click', () => {
      const order = ['light', 'dark', 'system'];
      const current = state.settings.theme || 'system';
      applyTheme(order[(order.indexOf(current) + 1) % order.length], true);
    });

    // Ranges
    bindRange('#denoise', (value) => update({ denoise: Number(value) }), (value) => {
      $('#denoise-val').textContent = ['Off', 'Light', 'Medium', 'Strong', 'Max'][Number(value)];
    });
    bindRange('#presence', (value) => update({ presence: Number(value) }), (value) => {
      $('#presence-val').textContent = `+${value} dB`;
    });
    bindRange('#warmth', (value) => update({ warmth: Number(value) }), (value) => {
      $('#warmth-val').textContent = `+${value} dB`;
    });
    bindRange('#buffer', (value) => {
      update({ prefillMs: Number(value) });
      $('#buffer-val').textContent = `${value} ms`;
      const preset = Number(value) <= 44 ? 'low' : Number(value) >= 90 ? 'ultra' : 'balanced';
      state.settings.quality = preset;
      $('#quality-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.quality === preset));
      $('#quality-chip').textContent = capitalize(preset);
    }, null);
    bindRange('#boost', (value) => update({ outputGainDb: Number(value) }), (value) => {
      $('#boost-val').textContent = `${value} dB`;
    });
    bindRange('#monitor-gain', (value) => update({ monitorGain: Number(value) / 100 }, { audio: false }), (value) => {
      $('#monitor-gain-val').textContent = `${value}%`;
      pipeline?.setMonitor(state.settings.monitor, Number(value) / 100);
    });

    // Switches
    bindCheck('#gate', (checked) => update({ gate: checked }));
    bindCheck('#agc', (checked) => update({ agc: checked }));
    bindCheck('#limiter', (checked) => update({ limiter: checked }));
    bindCheck('#monitor', (checked) => {
      update({ monitor: checked });
      pipeline?.setMonitor(checked, state.settings.monitorGain ?? 0.8);
    });
    bindCheck('#monitor2', (checked) => {
      update({ monitor: checked });
      pipeline?.setMonitor(checked, state.settings.monitorGain ?? 0.8);
    });
    bindCheck('#claim-default', (checked) => {
      const label = $('#claim-state');
      if (label) label.textContent = checked ? 'On' : 'Off';
      // Restarting the service is what actually re-points Windows at the cable.
      update({ claimDefaultInput: checked }).then(() => {
        if (bridge.restartService) bridge.restartService().catch(() => {});
      });
    });
    bindCheck('#tray-toggle', (checked) => update({ tray: checked }, { audio: false }));
    bindCheck('#autostart-toggle', (checked) => update({ autoStart: checked }, { audio: false }));
    bindCheck('#pairing-toggle', (checked) => update({ requirePairing: checked }, { audio: false }));
    bindCheck('#remember-toggle', (checked) => update({ rememberDevices: checked }, { audio: false }));

    // Selects
    $('#settings-rate').addEventListener('change', (event) => {
      update({ rate: Number(event.target.value) });
    });
    $('#settings-codec').addEventListener('change', (event) => {
      update({ codec: event.target.value });
    });
    $('#settings-frame').addEventListener('change', (event) => {
      update({ frameMs: Number(event.target.value) });
    });
    $('#rate-select').addEventListener('change', (event) => {
      update({ rate: Number(event.target.value) });
      toast('ok', 'Stream format updated', 'The phone reconfigures on the next packet.');
    });
    $('#codec-select').addEventListener('change', (event) => {
      update({ codec: event.target.value });
    });
    $('#device-select').addEventListener('change', async (event) => {
      await update({ serviceDevice: event.target.value }, { audio: false });
      await bridge.restartService();
      toast('ok', 'Output device saved', event.target.value || 'Automatic selection');
    });

    // Quality presets
    $('#quality-seg').addEventListener('click', (event) => {
      const button = event.target.closest('[data-quality]');
      if (!button) return;
      const presets = { low: 30, balanced: 60, ultra: 100 };
      const quality = button.dataset.quality;
      $('#buffer').value = String(presets[quality]);
      setRangeFill($('#buffer'));
      update({ quality, prefillMs: presets[quality] });
      $('#buffer-val').textContent = `${presets[quality]} ms`;
      $('#quality-chip').textContent = capitalize(quality);
      $$('#quality-seg button').forEach((b) => b.classList.toggle('is-active', b === button));
    });

    // Modal backdrop
    $('#test-modal').addEventListener('click', (event) => {
      if (event.target.id === 'test-modal') closeTest();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#test-modal').hidden) closeTest();
    });
  }

  function bindRange(selector, onInput, onPaint) {
    const input = $(selector);
    if (!input) return;
    input.addEventListener('input', () => {
      setRangeFill(input);
      onPaint?.(input.value);
    });
    input.addEventListener('change', () => onInput(input.value));
  }

  function bindCheck(selector, callback) {
    const input = $(selector);
    if (!input) return;
    input.addEventListener('change', () => callback(input.checked));
    input.addEventListener('change', () => {
      if (selector === '#monitor' || selector === '#monitor2') {
        $('#monitor').checked = input.checked;
        $('#monitor2').checked = input.checked;
        $('#monitor-state').textContent = input.checked ? 'On' : 'Off';
        $('#monitor-state-2').textContent = input.checked ? 'On' : 'Off';
      }
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (event) => {
      const tag = (event.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea'].includes(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'm') setMuted(!muted);
      else if (key === 'r') toggleRecording();
      else if (key === 't') $('#theme-btn').click();
      else if (['1', '2', '3', '4', '5'].includes(key)) {
        showView(['live', 'pair', 'studio', 'settings', 'help'][Number(key) - 1]);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function toggleRecording() {
    try {
      if (!recording) {
        const status = await bridge.startRecording();
        state.recorder = status || { recording: true, startedAt: Date.now() };
        recording = true;
        recordingStartedAt = Date.now();
        renderRecorder();
        recorderTimer = setInterval(async () => {
          const current = await bridge.recordingStatus();
          state.recorder = current;
          renderRecorder();
        }, 1000);
        toast('ok', 'Recording started', 'Saving 16-bit WAV from the virtual microphone.');
      } else {
        if (recorderTimer) clearInterval(recorderTimer);
        recorderTimer = null;
        const status = await bridge.stopRecording();
        state.recorder = status;
        recording = false;
        renderRecorder();
        toast('ok', 'Recording saved', shortPath(status?.file || 'VoxBridge Recordings'));
      }
    } catch (error) {
      toast('bad', 'Recording failed', error.message || 'Unknown error');
    }
  }

  async function setupVirtual() {
    if (!bridge.isDesktop && !bridge.demo) return;
    $('#setup-progress').hidden = false;
    $('#setup-bar').style.width = '3%';
    $('#setup-message').textContent = 'Starting…';
    try {
      const result = await bridge.setupVirtualMic();
      if (result?.phase === 'unsupported') {
        toast('warn', 'Windows only', 'Virtual microphone routing is a Windows feature.');
      }
      renderSetup();
    } catch (error) {
      toast('bad', 'Setup failed', error.message || 'Unknown error');
    }
  }

  async function exportDiagnostics() {
    try {
      const result = await bridge.exportDiagnostics();
      if (result?.saved) toast('ok', 'Diagnostics saved', shortPath(result.file));
      else if (!bridge.demo) toast('warn', 'Not saved', 'The save dialog was cancelled.');
    } catch (error) {
      toast('bad', 'Export failed', error.message || 'Unknown error');
    }
  }

  async function resetSettings() {
    const defaults = {
      theme: state.settings.theme,
      codec: 'pcm16',
      rate: 48000,
      frameMs: 20,
      prefillMs: 60,
      serviceDevice: '',
      monitor: false,
      monitorGain: 0.8,
      outputGainDb: 0,
      autoStart: false,
      minimizeToTray: true,
      rememberDevices: true,
      requirePairing: true,
      denoise: 3,
      gate: true,
      agc: true,
      presence: 4,
      warmth: 3,
      compressor: true,
      limiter: true,
      highpass: true,
      tray: true,
      quality: 'balanced',
      muted: false,
    };
    await update(defaults);
    await refreshDevices();
    toast('ok', 'Settings restored', 'Your pairing code and remembered devices are untouched.');
  }

  // Test the virtual microphone end to end -------------------------------------
  async function runVirtualTest() {
    const modal = $('#test-modal');
    modal.hidden = false;
    const outcome = $('#test-outcome');
    outcome.className = 'test-outcome';
    outcome.textContent = 'Listening from the virtual microphone…';
    $('#test-countdown').textContent = '3.0';
    $('#test-chip').textContent = 'Testing';
    $('#test-chip').className = 'status-chip warn';
    stopTest();

    const canvas = $('#test-wave');
    const ctx = canvas.getContext('2d');
    const draw = () => {
      testRAF = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(rect.width * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const styles = getComputedStyle(document.documentElement);
      ctx.strokeStyle = styles.getPropertyValue('--accent').trim() || '#ff5a2e';
      ctx.lineWidth = 1.4 * dpr;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let x = 0; x < w; x += 2 * dpr) {
        const t = x / w;
        const env = Math.sin(t * Math.PI) * 0.5;
        const noise = (Math.random() - 0.5) * (testLevel || 0.02) * 2;
        const y = h / 2 + (Math.sin(x * 0.06 + Date.now() * 0.004) * 0.5 + noise) * h * env;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw();

    if (bridge.demo) {
      simulateTest();
      return;
    }

    let level = 0;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const target = devices.find(
        (device) =>
          device.kind === 'audioinput' &&
          /cable output|voicemeeter out|virtual audio cable|voxbridge/i.test(device.label),
      );
      const constraints = target
        ? { audio: { deviceId: { exact: target.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
        : { audio: true };
      testStream = await navigator.mediaDevices.getUserMedia(constraints);
      const context = new AudioContext();
      const source = context.createMediaStreamSource(testStream);
      const testAnalyser = context.createAnalyser();
      testAnalyser.fftSize = 1024;
      source.connect(testAnalyser);
      const data = new Uint8Array(testAnalyser.fftSize);
      let sum = 0;
      let count = 0;
      let peak = 0;
      const started = performance.now();
      const tick = () => {
        testAnalyser.getByteTimeDomainData(data);
        for (let i = 0; i < data.length; i += 4) {
          const value = Math.abs(data[i] / 128 - 1);
          sum += value * value;
          count += 1;
          if (value > peak) peak = value;
        }
        testLevel = peak;
        const elapsed = (performance.now() - started) / 1000;
        $('#test-countdown').textContent = Math.max(0, 3 - elapsed).toFixed(1);
        if (elapsed < 3) {
          testTimer = setTimeout(tick, 60);
        } else {
          level = Math.sqrt(sum / Math.max(1, count));
          finishTest(level, peak, context);
        }
      };
      tick();
    } catch (error) {
      testFailed(
        error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow it in Windows settings and try again.'
          : 'Could not open the virtual microphone. Install a cable, then pick it in Studio.',
      );
    }
  }

  let testLevel = 0;
  function simulateTest() {
    const started = performance.now();
    const timer = setInterval(() => {
      testLevel = 0.18 + Math.random() * 0.22;
      const elapsed = (performance.now() - started) / 1000;
      $('#test-countdown').textContent = Math.max(0, 3 - elapsed).toFixed(1);
      if (elapsed >= 3) {
        clearInterval(timer);
        testLevel = 0.3;
        finishDemoTest();
      }
    }, 100);
    testTimer = timer;
  }

  function finishDemoTest() {
    const level = 0.034;
    $('#test-fill').style.height = '72%';
    $('#test-title').textContent = 'Signal found — 34%';
    $('#test-detail').textContent = 'The virtual cable is receiving audio cleanly.';
    $('#test-chip').textContent = 'Passed';
    $('#test-chip').className = 'status-chip ok';
    const outcome = $('#test-outcome');
    outcome.className = 'test-outcome ok';
    outcome.textContent = 'Pass. Apps listening on “CABLE Output” will hear this signal. (demo)';
    toast('ok', 'Virtual microphone works', 'A clean signal reached the cable input.');
    setTimeout(() => {
      if (!$('#test-modal').hidden) $('#test-modal').hidden = true;
    }, 2200);
  }

  function finishTest(level, peak, context) {
    testStream?.getTracks().forEach((track) => track.stop());
    context?.close().catch(() => {});
    testStream = null;
    stopTest();
    const db = 20 * Math.log10(level + 1e-7);
    const good = level > 0.004;
    $('#test-countdown').textContent = good ? `${Math.round(Math.min(1, level * 8) * 100)}%` : '0%';
    $('#test-fill').style.height = `${Math.min(100, Math.max(4, level * 500))}%`;
    $('#test-title').textContent = good ? `Signal found — ${(Math.min(1, level * 8) * 100).toFixed(0)}%` : 'Silence';
    $('#test-detail').textContent = good
      ? `Peak ${(20 * Math.log10(peak + 1e-7)).toFixed(1)} dBFS · RMS ${db.toFixed(1)} dBFS`
      : 'No signal reached the cable. Check the endpoint and Windows volume mixer.';
    $('#test-chip').textContent = good ? 'Passed' : 'No signal';
    $('#test-chip').className = 'status-chip ' + (good ? 'ok' : 'bad');
    $('#test-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    const outcome = $('#test-outcome');
    outcome.className = 'test-outcome ' + (good ? 'ok' : 'bad');
    outcome.textContent = good
      ? 'Pass. Apps listening on the virtual cable will hear this signal.'
      : 'The virtual microphone captured silence. Reinstall the cable or pick another endpoint.';
    toast(good ? 'ok' : 'bad', good ? 'Virtual microphone works' : 'No signal detected', good ? 'The chain is verified end to end.' : 'Check Studio → output device.');
    setTimeout(() => {
      if (!$('#test-modal').hidden) $('#test-modal').hidden = true;
    }, 2600);
  }

  function testFailed(message) {
    stopTest();
    $('#test-chip').textContent = 'Failed';
    $('#test-chip').className = 'status-chip bad';
    $('#test-title').textContent = 'Could not capture';
    $('#test-detail').textContent = message;
    const outcome = $('#test-outcome');
    outcome.className = 'test-outcome bad';
    outcome.textContent = message;
    toast('bad', 'Test failed', message);
  }

  function stopTest() {
    if (testTimer) clearTimeout(testTimer);
    if (testTimer && typeof testTimer === 'object') clearInterval(testTimer);
    testTimer = null;
    if (testRAF) cancelAnimationFrame(testRAF);
    testRAF = null;
    if (testStream) {
      testStream.getTracks().forEach((track) => track.stop());
      testStream = null;
    }
  }

  function closeTest() {
    stopTest();
    $('#test-modal').hidden = true;
    $('#test-chip').textContent = $('#test-chip').classList.contains('ok') ? 'Passed' : 'Not run';
    $('#test-btn-label').textContent = 'Run 3-second test';
  }

  // ---------------------------------------------------------------------------
  // Theme, helpers
  // ---------------------------------------------------------------------------
  function applyTheme(theme, persist) {
    const resolved = theme === 'system' || !theme ? systemTheme() : theme;
    document.documentElement.dataset.theme = resolved;
    state.settings.theme = theme || 'system';
    $$('#theme-picker [data-theme-value]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.themeValue === (theme || 'system'));
    });
    if (persist) {
      bridge.setSettings({ theme: theme || 'system' });
      if (bridge.setTheme) bridge.setTheme(theme || 'system');
    }
    renderQR();
  }

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((state.settings.theme || 'system') === 'system') applyTheme('system', false);
  });

  function toast(kind, title, body = '') {
    const root = $('#toasts');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    const icon = kind === 'bad' ? 'i-x' : kind === 'warn' ? 'i-bolt' : 'i-check';
    el.innerHTML = `<svg><use href="#${icon}" /></svg><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></div>`;
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 240);
    }, 4200);
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      /* ignore */
    }
    textarea.remove();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function capitalize(value) {
    const text = String(value || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function platformName(platform) {
    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    if (platform === 'linux') return 'Linux';
    return platform || 'Desktop';
  }

  function shortPath(value) {
    if (!value) return '—';
    const parts = String(value).split(/[\\/]/);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(value);
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function startPolling() {
    setInterval(async () => {
      if (recording) {
        try {
          const status = await bridge.recordingStatus();
          if (status) {
            state.recorder = { ...state.recorder, ...status };
            $('#record-time').textContent = formatDuration(status.durationMs);
            $('#record-size').textContent = `${((status.bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
          }
        } catch {
          /* ignore */
        }
      }
      if (state.receiver.phone) {
        state.receiver.uptime = (state.receiver.uptime || 0) + 1000;
      }
    }, 1000);
  }
})();
