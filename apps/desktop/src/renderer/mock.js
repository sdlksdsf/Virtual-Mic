/* Browser demo bridge.
 * The website hosts the desktop interface as an interactive preview. This
 * file implements the same contract as preload.js so the real UI code runs
 * unchanged, with a simulated phone producing 20 ms audio packets.
 */
(function () {
  'use strict';

  const listeners = new Map();
  let id = 0;

  function emit(channel, payload) {
    for (const entry of listeners.values()) {
      if (entry.channel === channel) entry.callback(payload);
    }
  }

  const settings = {
    theme: 'light',
    codec: 'pcm16',
    rate: 48000,
    frameMs: 20,
    prefillMs: 60,
    deviceName: '',
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
    diagnostics: false,
    quality: 'balanced',
    recordingDir: 'Music/VoxBridge Recordings',
  };

  const receiver = {
    running: true,
    port: 8720,
    code: '4182',
    addresses: [
      { name: 'Wi-Fi', address: '192.168.1.24' },
      { name: 'Ethernet', address: '10.0.0.7' },
    ],
    phone: null,
    session: null,
    codec: 'pcm16',
    rate: 48000,
    frameMs: 20,
    rx: 0,
    lost: 0,
    rtt: 0,
    jitter: 0,
    bufferDepth: 0,
    bitrate: 0,
    uptime: 0,
  };

  const service = {
    mode: 'native',
    status: 'ready',
    device: 'CABLE Input (VB-Audio Virtual Cable)',
    fallback: false,
    rate: 48000,
    bufferMs: 20,
    prefillMs: 60,
    lastError: '',
    restarts: 0,
    version: '1.0.0',
    binary: 'C:\\Program Files\\VoxBridge\\VoxBridgeMic.exe',
  };

  const setup = {
    phase: 'done',
    progress: 100,
    message: 'VB-CABLE is installed and verified',
    publisher: 'signature-valid',
    error: '',
  };

  const recorder = { recording: false, file: '', durationMs: 0, bytes: 0, rate: 48000 };

  const remembered = new Map();
  const startedAt = Date.now();

  const devices = {
    native: true,
    render: [
      { name: 'CABLE Input (VB-Audio Virtual Cable)', default: true },
      { name: 'Headphones (WH-1000XM5)', default: false },
      { name: 'Speakers (Realtek(R) Audio)', default: false },
    ],
    capture: [
      { name: 'CABLE Output (VB-Audio Virtual Cable)', default: true },
      { name: 'Microphone Array (Intel Smart Sound)', default: false },
    ],
  };

  // -------------------------------------------------------------------------
  // Synthetic phone: a breathy, syllable-shaped test voice. It is not speech,
  // but it exercises the whole chain realistically.
  // -------------------------------------------------------------------------
  const voice = {
    phase: 0,
    t: 0,
    syllable: 0,
    interval: null,
    seq: 0,
    packetCount: 0,
    speaking: true,
  };

  function synthChunk(frames = 960, rate = 48000) {
    const out = new Int16Array(frames);
    const syllableRate = 3.6;
    for (let i = 0; i < frames; i += 1) {
      voice.t += 1 / rate;
      voice.phase += (118 + Math.sin(voice.t * 0.7) * 6) / rate;
      voice.syllable = Math.pow(Math.max(0, Math.sin(voice.t * syllableRate * Math.PI * 2)), 0.8);
      const breath = Math.sin(voice.t * 2 * Math.PI * 710) * 0.02 + Math.sin(voice.t * 2 * Math.PI * 1830) * 0.012;
      const formant =
        Math.sin(voice.phase * Math.PI * 2) * 0.5 +
        Math.sin(voice.phase * Math.PI * 4) * 0.22 +
        Math.sin(voice.phase * Math.PI * 6) * 0.1 +
        Math.sin(voice.phase * Math.PI * 10) * 0.05;
      const room = (Math.random() - 0.5) * 0.005;
      const value = (formant + breath + room) * voice.syllable * 0.32;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    }
    return out;
  }

  function base64FromBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function buildPacket(samples, seq) {
    const buffer = new ArrayBuffer(12 + samples.length * 2);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    bytes[0] = 0x56;
    bytes[1] = 1;
    bytes[2] = 0;
    bytes[3] = 0;
    view.setUint16(4, seq & 0xffff, true);
    view.setUint32(6, Math.round(performance.now()) >>> 0, true);
    view.setUint16(10, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) view.setInt16(12 + i * 2, samples[i], true);
    return buffer;
  }

  let analysedLevel = 0;
  let analysedPeak = 0;

  function startPhone() {
    if (voice.interval) return;
    receiver.phone = {
      name: 'Pixel 8 Pro',
      device: 'android',
      app: '1.0.0',
      address: '192.168.1.42',
      connectedAt: Date.now(),
      deviceId: 'demo-android-1',
    };
    receiver.session = 'd3f1a9c2';
    receiver.rtt = 17;
    receiver.jitter = 3;
    receiver.bitrate = 768;
    emit('app:phone', receiver.phone);
    emit('app:receiver', { ...receiver });
    receiver.uptime = Date.now() - startedAt;

    voice.interval = setInterval(() => {
      if (!receiver.phone) return;
      const samples = synthChunk(960, 48000);
      const packet = buildPacket(samples, voice.seq++);
      emit('app:phone-audio', { packet: base64FromBuffer(packet), meta: { seq: voice.seq } });
      voice.packetCount += 1;
      receiver.rx += 1;
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i += 8) {
        const abs = Math.abs(samples[i]) / 32768;
        sum += abs * abs;
        if (abs > peak) peak = abs;
      }
      analysedLevel = Math.sqrt(sum / (samples.length / 8));
      analysedPeak = peak;
      if (settings.monitor) {
        // Keep the visual meter honest even without an audio graph.
        emit('app:meter', { level: analysedLevel, peak: analysedPeak });
      }
      receiver.bufferDepth = Math.round((receiver.bufferDepth || 80) * 0.85 + 74 * 0.15);
      receiver.bitrate = 768;
      receiver.uptime = Date.now() - startedAt;
    }, 20);
  }

  function stopPhone() {
    if (voice.interval) clearInterval(voice.interval);
    voice.interval = null;
    receiver.phone = null;
    receiver.session = null;
    emit('app:phone', null);
    emit('app:receiver', { ...receiver });
  }

  function telemetry(payload) {
    if (!payload) return;
    if (typeof payload.level === 'number') analysedLevel = payload.level;
    if (typeof payload.peak === 'number') analysedPeak = payload.peak;
    if (typeof payload.buffer === 'number') receiver.bufferDepth = payload.buffer;
  }

  // -------------------------------------------------------------------------
  // Public bridge
  // -------------------------------------------------------------------------
  const bridge = {
    isDesktop: false,
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
    demo: true,
    async getState() {
      return {
        app: {
          version: '1.0.0',
          platform: 'win32',
          arch: 'x64',
          hostname: 'STUDIO-PC',
          demo: true,
          packaged: true,
          userData: 'C:\\Users\\you\\AppData\\Roaming\\VoxBridge',
          recordingDir: 'Music/VoxBridge Recordings',
          github: 'https://github.com/sdlksdsf/Virtual-Mic',
          site: 'https://voxbridge.vercel.app',
        },
        settings,
        receiver: { ...receiver },
        service: { ...service },
        recorder: { ...recorder },
        setup: { ...setup },
      };
    },
    async setSettings(patch) {
      Object.assign(settings, patch);
      emit('app:settings', { ...settings });
      return bridge.getState();
    },
    async newPairCode() {
      receiver.code = String(Math.floor(1000 + Math.random() * 9000));
      emit('app:pair-code', receiver.code);
      emit('app:receiver', { ...receiver });
      return receiver.code;
    },
    async forgetDevices() {
      remembered.clear();
      return true;
    },
    async restartReceiver() {
      emit('app:receiver', { ...receiver });
      return true;
    },
    async startService() {
      return service;
    },
    async stopService() {
      return true;
    },
    async listDevices() {
      return devices;
    },
    async restartService() {
      emit('app:service', { ...service, status: 'starting' });
      setTimeout(() => emit('app:service', { ...service, status: 'ready' }), 700);
      return service;
    },
    async sendPacket() {
      return true;
    },
    sendProcessedAudio() {},
    sendTelemetry: telemetry,
    sendMute() {},
    async startRecording() {
      recorder.recording = true;
      recorder.file = 'C:\\Users\\you\\Music\\VoxBridge Recordings\\VoxBridge 2026-10-19 16.02.11.wav';
      recorder.bytes = 0;
      recorder.durationMs = 0;
      recorder.startedAt = Date.now();
      emit('app:recorder', { ...recorder });
      return recorder;
    },
    async stopRecording() {
      recorder.recording = false;
      emit('app:recorder', { ...recorder, size: '14.2 MB' });
      return recorder;
    },
    async recordingStatus() {
      if (recorder.recording) {
        recorder.durationMs = Date.now() - recorder.startedAt;
        recorder.bytes = Math.round((recorder.durationMs / 1000) * 96000);
      }
      return { ...recorder };
    },
    async openRecordings() {
      return true;
    },
    async setupVirtualMic() {
      const phases = [
        { phase: 'downloading', progress: 12, message: 'Downloading VB-CABLE from vb-audio.com' },
        { phase: 'downloading', progress: 48, message: 'Downloading VB-CABLE from vb-audio.com' },
        { phase: 'extracting', progress: 74, message: 'Verifying the installer' },
        { phase: 'installing', progress: 88, message: 'Signature verified. Windows will ask for permission.' },
        { phase: 'done', progress: 100, message: 'Driver installer finished. Restart Windows if the device does not appear.' },
      ];
      phases.forEach((phase, index) => {
        setTimeout(() => {
          Object.assign(setup, phase, { publisher: 'signature-valid', error: '' });
          emit('app:setup', { ...setup });
        }, 500 + index * 900);
      });
      return { ...setup };
    },
    async virtualState() {
      return { ...setup };
    },
    async openVirtualDownload() {
      window.open('https://vb-audio.com/Cable/', '_blank', 'noopener');
      return true;
    },
    async verifySignature() {
      return { valid: true, detail: 'signature-valid' };
    },
    async exportDiagnostics() {
      emit('app:toast', { kind: 'ok', title: 'Diagnostics ready', body: 'This is a demo; nothing was written to disk.' });
      return { saved: false };
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
      return true;
    },
    async checkUpdates() {
      return { current: '1.0.0', available: false, url: 'https://github.com/sdlksdsf/Virtual-Mic/releases' };
    },
    async quit() {},
    async windowControl() {},
    async setTheme(theme) {
      settings.theme = theme;
      return true;
    },
    on(channel, callback) {
      const key = `l${(id += 1)}`;
      listeners.set(key, { channel, callback });
      return () => listeners.delete(key);
    },
    startPhone,
    stopPhone,
  };

  window.createMockBridge = () => {
    setTimeout(() => {
      emit('app:service', { ...service });
      emit('app:receiver', { ...receiver });
      startPhone();
    }, 900);
    setInterval(() => {
      if (!receiver.phone) return;
      receiver.rtt = 14 + Math.round(Math.random() * 8);
      receiver.jitter = Math.round(Math.random() * 4);
      emit('app:receiver', { ...receiver });
      emit('app:phone-stats', {
        rtt: receiver.rtt,
        jitter: receiver.jitter,
        buffer: receiver.bufferDepth,
        bitrate: 768,
        level: analysedLevel,
        peak: analysedPeak,
        lost: 0,
        rx: receiver.rx,
      });
      if (recorder.recording) {
        recorder.durationMs = Date.now() - recorder.startedAt;
        recorder.bytes = Math.round((recorder.durationMs / 1000) * 96000);
        emit('app:recorder', { ...recorder });
      }
    }, 1000);
    return bridge;
  };
})();
