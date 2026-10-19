'use strict';

// VoxBridge standalone host.
//
// Runs the desktop UI and the audio receiver without Electron. The interface is
// served over loopback HTTP and talks to this process through a small WebSocket
// bridge. Audio rendering still happens in the native WASAPI service; the
// browser only runs the DSP worklet, exactly like the Electron build.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { WebSocketServer } = require('ws');

const APP_VERSION = '1.0.0';
const GITHUB_URL = 'https://github.com/sdlksdsf/Virtual-Mic';
const SITE_URL = 'https://voxbridge-app-pi.vercel.app';
const IS_WIN = process.platform === 'win32';
const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const DATA_DIR = process.env.VOXBRIDGE_DATA ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VoxBridge');
const MUSIC_DIR = path.join(os.homedir(), 'Music');
const DESKTOP_DIR = path.join(os.homedir(), 'Desktop');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ALLOWED_HOSTS = new Set([
  'github.com',
  'voxbridge-app-pi.vercel.app',
  'vb-audio.com',
  'www.vb-audio.com',
  'download.vb-audio.com',
]);

// Documentation screenshots are captured on Linux, where the native service
// cannot run. This flag makes the preview report the Windows service shape so
// the captured interface matches what a Windows user actually sees.
const PREVIEW_NATIVE = process.env.VOXBRIDGE_PREVIEW_NATIVE === '1';
const PREVIEW_DEVICES = {
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
const PREVIEW_SERVICE = {
  mode: 'native',
  status: 'ready',
  device: 'CABLE Input (VB-Audio Virtual Cable)',
  fallback: false,
  rate: 48000,
  bufferMs: 20,
  prefillMs: 60,
  lastError: '',
  restarts: 0,
  version: APP_VERSION,
  binary: 'C:\\Program Files\\VoxBridge\\VoxBridgeMic.exe',
};

const logs = [];
const setupState = { phase: 'idle', progress: 0, message: '', publisher: '', error: '' };
const clients = new Set();
let lastClientAt = Date.now();
let store = null;
let receiver = null;
let service = null;
let recorder = null;
let httpServer = null;
let idleTimer = null;

function log(level, message) {
  const entry = { at: new Date().toISOString(), level, message: String(message).slice(0, 1000) };
  logs.push(entry);
  if (logs.length > 400) logs.shift();
  broadcast('app:log', entry);
  if (process.env.VOXBRIDGE_VERBOSE === '1' || level === 'error') {
    console.log(`[${level}] ${entry.message}`);
  }
}

function broadcast(channel, payload) {
  const message = JSON.stringify({ type: 'event', channel, payload });
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

// ---------------------------------------------------------------------------
// Electron shim. The store and recorder modules only use app.getPath().
// ---------------------------------------------------------------------------

const electronShim = {
  app: {
    isPackaged: true,
    getVersion: () => APP_VERSION,
    getPath(name) {
      if (name === 'music') return MUSIC_DIR;
      if (name === 'desktop') return DESKTOP_DIR;
      return DATA_DIR;
    },
    getAppPath: () => ROOT,
    setLoginItemSettings() {},
    requestSingleInstanceLock: () => true,
    quit() {
      shutdown(0);
    },
  },
  shell: {
    openExternal: (url) => openExternal(url),
    openPath: (target) => openPath(target),
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
  },
  nativeTheme: { shouldUseDarkColors: false, on() {}, themeSource: 'system' },
  ipcMain: { handle() {}, on() {} },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronShim;
  return originalLoad.call(this, request, parent, isMain);
};

const { Store } = require(path.join(ROOT, 'src/main/store'));
const { Receiver } = require(path.join(ROOT, 'src/main/server'));
const { CaptureService } = require(path.join(ROOT, 'src/main/service'));
const { Recorder, defaultDir } = require(path.join(ROOT, 'src/main/recorder'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) return false;
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', parsed.toString()], { windowsHide: true, detached: true });
    else spawn('xdg-open', [parsed.toString()], { detached: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function openPath(target) {
  try {
    if (IS_WIN) spawn('explorer.exe', [target], { windowsHide: true, detached: true });
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function powershell(script, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
        resolve(String(stdout || '').trim());
      },
    );
  });
}

function httpsDownload(url, destination, redirects = 6) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const request = https.get(url, { headers: { 'user-agent': 'VoxBridge/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        response.resume();
        return resolve(httpsDownload(new URL(response.headers.location, url).toString(), destination, redirects - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const file = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total) updateSetup({ progress: Math.min(70, Math.round((received / total) * 70)) });
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(45000, () => request.destroy(new Error('Download timed out')));
  });
}

function startupShortcutPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'VoxBridge.cmd');
}

function applyAutoStart(enabled) {
  if (!IS_WIN) return;
  const target = startupShortcutPath();
  try {
    if (enabled) {
      const launcher = process.env.VOXBRIDGE_LAUNCHER || path.join(path.dirname(process.execPath), 'VoxBridge.exe');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `@echo off\r\nstart "" "${launcher}"\r\n`, 'utf8');
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  } catch (error) {
    log('warn', `Could not update startup: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Virtual microphone (VB-CABLE)
// ---------------------------------------------------------------------------

const CABLE_URLS = [
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack46.zip',
];

function updateSetup(patch) {
  Object.assign(setupState, patch);
  broadcast('app:setup', { ...setupState });
}

async function setupVirtualMicrophone() {
  if (!IS_WIN) {
    updateSetup({ phase: 'unsupported', error: 'Virtual microphone installation is available on Windows only.' });
    return setupState;
  }
  if (setupState.phase === 'downloading' || setupState.phase === 'installing') return setupState;
  updateSetup({ phase: 'downloading', progress: 2, message: 'Contacting VB-Audio', error: '', publisher: '' });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voxbridge-cable-'));
  const zipPath = path.join(temp, 'VBCABLE.zip');
  let downloaded = false;
  let lastError = '';
  for (const url of CABLE_URLS) {
    try {
      updateSetup({ message: 'Downloading VB-CABLE from vb-audio.com', progress: 5 });
      await httpsDownload(url, zipPath);
      downloaded = true;
      break;
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!downloaded) {
    updateSetup({
      phase: 'manual',
      progress: 0,
      error: `Automatic download was unavailable (${lastError}). Open the official page and run the installer.`,
      message: 'Manual install required',
    });
    openExternal('https://vb-audio.com/Cable/');
    return setupState;
  }

  updateSetup({ phase: 'extracting', progress: 74, message: 'Verifying the installer' });
  const extractDir = path.join(temp, 'extracted');
  try {
    await powershell(`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`);
  } catch (error) {
    updateSetup({ phase: 'manual', error: `Could not unpack the download: ${error.message}` });
    return setupState;
  }

  const installer = ['VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe']
    .map((name) => path.join(extractDir, name))
    .find((file) => fs.existsSync(file));
  if (!installer) {
    updateSetup({ phase: 'manual', error: 'The download did not contain the expected installer.' });
    return setupState;
  }

  const verification = service ? service.verifySignature(installer) : { valid: false, detail: 'service-missing' };
  updateSetup({
    phase: 'installing',
    progress: 85,
    publisher: verification.detail || 'unknown',
    message: verification.valid
      ? 'Signature verified. Windows will ask for permission.'
      : 'Signature could not be verified. Review the prompt carefully.',
  });

  try {
    await powershell(`Start-Process -FilePath '${installer}' -Verb RunAs -Wait`, 300000);
    updateSetup({ phase: 'done', progress: 100, message: 'Driver installer finished. Restart Windows if the device does not appear.' });
    log('info', 'VB-CABLE installer finished');
  } catch (error) {
    updateSetup({
      phase: 'manual',
      error: `The installer did not complete: ${error.message}`,
      message: 'Finish the installation manually',
    });
  }
  return setupState;
}

// ---------------------------------------------------------------------------
// State and audio
// ---------------------------------------------------------------------------

function statePayload() {
  return {
    app: {
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      demo: false,
      packaged: true,
      standalone: true,
      userData: DATA_DIR,
      recordingDir: store.get('recordingDir') || defaultDir(),
      github: GITHUB_URL,
      site: SITE_URL,
    },
    settings: store.get(),
    receiver: receiver ? receiver.status() : { running: false, code: '----', port: 8720 },
    service: PREVIEW_NATIVE ? { ...PREVIEW_SERVICE } : service ? service.info() : { mode: 'software', status: 'idle' },
    recorder: recorder ? recorder.status() : { recording: false },
    setup: setupState,
  };
}

function startReceiver() {
  if (!receiver) {
    receiver = new Receiver({ ...store.get(), remembered: store.get('remembered') || {} });
    receiver.on('state', (status) => broadcast('app:receiver', status));
    receiver.on('phone', (phone) => {
      broadcast('app:phone', phone);
      if (phone) store.set({ lastPhone: { name: phone.name, device: phone.device } });
    });
    receiver.on('audio', (packet, meta) => {
      broadcast('app:phone-audio', { packet: packet.toString('base64'), meta });
      // Keep audio flowing even when the window is closed: skip the browser DSP
      // and hand the raw PCM to the service.
      if (clients.size === 0) {
        service?.write(packet);
        recorder?.write(packet.subarray(12));
      }
    });
    receiver.on('phoneStats', (stats) => {
      broadcast('app:phone-stats', stats);
      broadcast('app:recorder', recorder.status());
    });
    receiver.on('phoneMute', (on) => {
      store.set({ muted: on });
      broadcast('app:phone-mute', on);
    });
    receiver.on('code', (code) => broadcast('app:pair-code', code));
    receiver.on('remember', (devices) => store.set({ remembered: devices }));
    receiver.on('log', (entry) => log(entry.level, entry.message));
  }
  receiver
    .start()
    .then(() => log('info', `Receiver started on port ${receiver.port}`))
    .catch((error) => {
      log('error', `Receiver failed: ${error.message}`);
      broadcast('app:receiver-error', { message: error.message });
    });
}

async function stopReceiver() {
  if (receiver) await receiver.stop();
}

function startService() {
  if (!service) {
    service = new CaptureService();
    service.on('event', (event) => {
      broadcast('app:service-event', event);
      if (event.ev === 'error') log('error', `Capture service: ${event.message || event.code}`);
      if (event.ev === 'ready') log('info', `Capture service ready: ${event.device}`);
      if (event.ev === 'warn') log('warn', `Capture service warning: ${event.message || event.code}`);
    });
    service.on('state', (info) => broadcast('app:service', info));
    service.on('log', (entry) => log(entry.level, entry.message));
  }
  return service.start({
    device: store.get('serviceDevice') || '',
    rate: Math.round(store.get('rate') / (store.get('frameMs') === 10 ? 2 : 1)) || 48000,
    bufferMs: store.get('quality') === 'low' ? 30 : store.get('quality') === 'ultra' ? 12 : 20,
    prefillMs: store.get('prefillMs') || 80,
    wavOut: '',
    diagnostics: store.get('diagnostics'),
  });
}

function stopService() {
  if (service) service.stop();
}

// ---------------------------------------------------------------------------
// RPC surface
// ---------------------------------------------------------------------------

const METHODS = {
  getState: () => statePayload(),

  setSettings: (patch) => {
    if (!patch || typeof patch !== 'object') return statePayload();
    const allowed = [
      'theme', 'codec', 'rate', 'frameMs', 'prefillMs', 'deviceName', 'serviceDevice', 'monitor',
      'monitorGain', 'outputGainDb', 'autoStart', 'minimizeToTray', 'rememberDevices',
      'requirePairing', 'denoise', 'gate', 'agc', 'presence', 'warmth', 'compressor', 'limiter',
      'highpass', 'tray', 'showWelcome', 'diagnostics', 'quality', 'recordingDir', 'onBoard', 'muted',
    ];
    const clean = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    store.set(clean);
    if ('theme' in clean) broadcast('app:theme', clean.theme);
    if ('autoStart' in clean) applyAutoStart(Boolean(clean.autoStart));
    if ('codec' in clean || 'rate' in clean || 'frameMs' in clean) {
      receiver?.setStreamConfig({
        codec: clean.codec || store.get('codec'),
        rate: clean.rate || store.get('rate'),
        frameMs: clean.frameMs || store.get('frameMs'),
      });
      service?.flush();
    }
    if ('requirePairing' in clean && receiver?.settings) receiver.settings.requirePairing = clean.requirePairing;
    if ('rememberDevices' in clean && receiver?.settings) receiver.settings.rememberDevices = clean.rememberDevices;
    broadcast('app:settings', store.get());
    return statePayload();
  },

  newPairCode: () => (receiver ? receiver.rotateCode() : null),

  forgetDevices: () => {
    store.set({ remembered: {} });
    if (receiver) {
      receiver.remembered.clear();
      receiver.settings.remembered = {};
    }
    return true;
  },

  restartReceiver: async () => {
    await stopReceiver();
    startReceiver();
    return true;
  },

  startService: () => startService(),
  stopService: () => {
    stopService();
    return true;
  },
  listDevices: () => (PREVIEW_NATIVE ? { ...PREVIEW_DEVICES } : service ? service.listDevices() : { native: false, render: [], capture: [] }),
  restartService: () => {
    stopService();
    return startService();
  },

  sendPacket: (base64) => {
    if (!service || typeof base64 !== 'string') return false;
    const packet = Buffer.from(base64, 'base64');
    const written = service.write(packet);
    if (written) recorder?.write(packet.subarray(12));
    return written;
  },

  sendProcessedAudio: (base64) => {
    if (typeof base64 !== 'string') return false;
    const buffer = Buffer.from(base64, 'base64');
    service?.write(buffer);
    recorder?.write(buffer.subarray(12));
    return true;
  },

  sendTelemetry: (telemetry) => {
    receiver?.setTelemetry(telemetry);
    return true;
  },

  sendMute: (on) => {
    receiver?.sendMute(Boolean(on));
    store.set({ muted: Boolean(on) });
    return true;
  },

  startRecording: () => {
    const status = recorder.start({ dir: store.get('recordingDir') || defaultDir(), rate: store.get('rate') });
    broadcast('app:recorder', status);
    return status;
  },
  stopRecording: () => {
    const status = recorder.stop('user');
    broadcast('app:recorder', status);
    return status;
  },
  recordingStatus: () => recorder.status(),
  openRecordings: () => {
    const dir = store.get('recordingDir') || defaultDir();
    fs.mkdirSync(dir, { recursive: true });
    openPath(dir);
    return dir;
  },

  setupVirtualMic: () => setupVirtualMicrophone(),
  virtualState: () => ({ ...setupState }),
  openVirtualDownload: () => openExternal('https://vb-audio.com/Cable/'),
  verifySignature: (file) => (service ? service.verifySignature(file) : { valid: false, detail: 'service-missing' }),

  exportDiagnostics: async () => {
    const redacted = { ...store.get() };
    delete redacted.remembered;
    const report = {
      generatedAt: new Date().toISOString(),
      app: { version: APP_VERSION, platform: process.platform, arch: process.arch, release: os.release(), standalone: true },
      settings: redacted,
      receiver: receiver ? receiver.status() : null,
      service: service ? service.info() : null,
      devices: service ? service.listDevices() : null,
      recorder: recorder ? recorder.status() : null,
      logs: logs.slice(-200),
    };
    const file = path.join(DESKTOP_DIR, 'voxbridge-diagnostics.json');
    fs.mkdirSync(DESKTOP_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return { saved: true, file };
  },

  openExternal: (url) => openExternal(url),

  checkUpdates: async () => ({
    current: APP_VERSION,
    available: false,
    reason: 'manual',
    url: `${GITHUB_URL}/releases`,
  }),

  quit: () => {
    setTimeout(() => shutdown(0), 50);
    return true;
  },

  windowControl: () => false,

  setTheme: (theme) => {
    store.set({ theme });
    broadcast('app:theme', theme);
    return true;
  },
};

// ---------------------------------------------------------------------------
// HTTP + WebSocket bridge
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(request, response) {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: APP_VERSION, uptime: Math.round(process.uptime()), x: 'voxbridge' }));
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(RENDERER, relative));
  if (!file.startsWith(RENDERER + path.sep) && file !== path.join(RENDERER, 'index.html')) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    });
    response.end(data);
  });
}

function attachBridge(server) {
  const wss = new WebSocketServer({ server, path: '/bridge', maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (socket) => {
    clients.add(socket);
    lastClientAt = Date.now();
    socket.on('close', () => {
      clients.delete(socket);
      lastClientAt = Date.now();
    });
    socket.on('error', () => clients.delete(socket));
    socket.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type !== 'call' || typeof message.method !== 'string') return;
      const handler = METHODS[message.method];
      if (!handler) {
        socket.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: `Unknown method ${message.method}` }));
        return;
      }
      try {
        const value = await handler(...(Array.isArray(message.args) ? message.args : []));
        socket.send(JSON.stringify({ type: 'result', id: message.id, ok: true, value }));
      } catch (error) {
        log('error', `${message.method}: ${error.message}`);
        socket.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: error.message }));
      }
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

async function listen(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (!(await isPortFree(port))) continue;
    const server = http.createServer(serveStatic);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return { server, port };
    } catch {
      /* try the next port */
    }
  }
  throw new Error('No free local port');
}

function edgePath() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function openUi(port) {
  const url = `http://127.0.0.1:${port}/`;
  const browser = edgePath();
  if (browser) {
    spawn(browser, [
      `--app=${url}`,
      '--window-size=1280,840',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${path.join(DATA_DIR, 'browser-profile')}`,
    ], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function shutdown(code = 0) {
  try {
    stopService();
    receiver?.stop();
    recorder?.stop('quit');
    httpServer?.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 100);
}

function startIdleWatch() {
  if (process.env.VOXBRIDGE_KEEPALIVE === '1') return;
  idleTimer = setInterval(() => {
    const phone = receiver ? receiver.status().phone : null;
    if (clients.size === 0 && !phone && !recorder.status().recording) {
      if (Date.now() - lastClientAt > 10 * 60 * 1000) {
        log('info', 'No clients for ten minutes; stopping the host');
        shutdown(0);
      }
    } else {
      lastClientAt = Date.now();
    }
  }, 15000);
  idleTimer.unref?.();
}

async function main() {
  store = new Store();
  recorder = new Recorder();

  const preferred = Number(process.env.VOXBRIDGE_PORT || 47800);
  const { server, port } = await listen(preferred);
  httpServer = server;
  attachBridge(server);

  startReceiver();
  startService();
  applyAutoStart(Boolean(store.get('autoStart')));
  startIdleWatch();

  log('info', `VoxBridge ${APP_VERSION} standalone host on http://127.0.0.1:${port}`);
  if (process.env.VOXBRIDGE_OPEN !== '0' || process.argv.includes('--open')) openUi(port);

  const stop = () => shutdown(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
