'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  session,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { Store } = require('./store');
const { Receiver } = require('./server');
const { CaptureService } = require('./service');
const { Recorder, defaultDir } = require('./recorder');

const APP_VERSION = '1.0.1';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_DEMO = process.env.VOXBRIDGE_DEMO === '1';
const GITHUB_URL = 'https://github.com/sdlksdsf/VoxBridge';
const SITE_URL = 'https://voxbridge.vercel.app';
const ALLOWED_HOSTS = new Set([
  'github.com',
  'voxbridge.vercel.app',
  'vb-audio.com',
  'www.vb-audio.com',
  'download.vb-audio.com',
]);

let mainWindow = null;
let tray = null;
let store = null;
let receiver = null;
let service = null;
let recorder = null;
const logs = [];
const setupState = { phase: 'idle', progress: 0, message: '', publisher: '', error: '' };

function log(level, message) {
  const entry = { at: new Date().toISOString(), level, message: String(message).slice(0, 1000) };
  logs.push(entry);
  if (logs.length > 400) logs.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:log', entry);
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function resolveTheme(theme) {
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return theme === 'dark' ? 'dark' : 'light';
}

function updateTitleBar(theme) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const dark = resolveTheme(theme) === 'dark';
  if (IS_WIN && mainWindow.setTitleBarOverlay) {
    try {
      mainWindow.setTitleBarOverlay({
        color: dark ? '#0D0D0A' : '#F4F1EA',
        symbolColor: dark ? '#F3EFE6' : '#15150F',
        height: 48,
      });
    } catch {
      /* overlay not supported */
    }
  }
  if (IS_WIN) mainWindow.setBackgroundColor(dark ? '#0D0D0A' : '#F4F1EA');
}

function createWindow() {
  const dark = resolveTheme(store.get('theme')) === 'dark';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: dark ? '#0D0D0A' : '#F4F1EA',
    title: 'VoxBridge',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: IS_WIN
      ? { color: dark ? '#0D0D0A' : '#F4F1EA', symbolColor: dark ? '#F3EFE6' : '#15150F', height: 48 }
      : undefined,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    log('info', `VoxBridge ${APP_VERSION} ready on ${process.platform} ${os.release()}`);
  });

  mainWindow.on('close', (event) => {
    if (store.get('minimizeToTray') && store.get('tray') && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternal(url);
    }
  });
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;
    shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

function createTray() {
  if (!store.get('tray') || tray) return;
  const iconPath = path.join(__dirname, '..', '..', 'build', 'tray.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('VoxBridge');
  const rebuild = () => {
    const status = receiver ? receiver.status() : { phone: null };
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status.phone ? `${status.phone.name} connected` : 'Waiting for a phone', enabled: false },
        { type: 'separator' },
        { label: 'Open VoxBridge', click: () => (mainWindow ? mainWindow.show() : createWindow()) },
        {
          label: 'Mute microphone',
          type: 'checkbox',
          checked: Boolean(store.get('muted')),
          click: (item) => {
            store.set({ muted: item.checked });
            receiver?.sendMute(item.checked);
            send('app:mute', item.checked);
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            app.isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  rebuild();
  tray.on('click', () => {
    if (!mainWindow) return createWindow();
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  tray.on('double-click', () => mainWindow?.show());
  setInterval(rebuild, 5000);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function statePayload() {
  return {
    app: {
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      demo: IS_DEMO,
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      recordingDir: store.get('recordingDir') || defaultDir(),
      github: GITHUB_URL,
      site: SITE_URL,
    },
    settings: store.get(),
    receiver: receiver ? receiver.status() : { running: false, code: '----', port: 8720 },
    service: service ? service.info() : { mode: 'software', status: 'idle' },
    recorder: recorder ? recorder.status() : { recording: false },
    setup: setupState,
  };
}

function startReceiver() {
  if (!receiver) {
    receiver = new Receiver({ ...store.get(), remembered: store.get('remembered') || {} });
    receiver.on('state', (status) => send('app:receiver', status));
    receiver.on('phone', (phone) => {
      send('app:phone', phone);
      if (phone) store.set({ lastPhone: { name: phone.name, device: phone.device } });
    });
    receiver.on('audio', (packet, meta) => send('app:phone-audio', { packet: packet.toString('base64'), meta }));
    receiver.on('phoneStats', (stats) => send('app:phone-stats', stats));
    receiver.on('phoneMute', (on) => {
      store.set({ muted: on });
      send('app:phone-mute', on);
    });
    receiver.on('code', (code) => send('app:pair-code', code));
    receiver.on('remember', (devices) => store.set({ remembered: devices }));
    receiver.on('log', (entry) => log(entry.level, entry.message));
  }
  receiver
    .start()
    .then(() => log('info', `Receiver started on port ${receiver.port}`))
    .catch((error) => {
      log('error', `Receiver failed: ${error.message}`);
      send('app:receiver-error', { message: error.message });
    });
}

async function stopReceiver() {
  if (receiver) {
    await receiver.stop();
  }
}

function startService() {
  if (!service) {
    service = new CaptureService();
    service.on('event', (event) => {
      send('app:service-event', event);
      if (event.ev === 'error') log('error', `Capture service: ${event.message || event.code}`);
      if (event.ev === 'ready') log('info', `Capture service ready: ${event.device}`);
      if (event.ev === 'warn') log('warn', `Capture service warning: ${event.message || event.code}`);
    });
    service.on('state', (info) => send('app:service', info));
    service.on('log', (entry) => log(entry.level, entry.message));
  }
  const info = service.start({
    device: store.get('serviceDevice') || '',
    rate: Math.round(store.get('rate') / (store.get('frameMs') === 10 ? 2 : 1)) || 48000,
    bufferMs: store.get('quality') === 'low' ? 30 : store.get('quality') === 'ultra' ? 12 : 20,
    prefillMs: store.get('prefillMs') || 80,
    wavOut: '',
    diagnostics: store.get('diagnostics'),
  });
  return info;
}

function stopService() {
  if (service) service.stop();
}

// ---------------------------------------------------------------------------
// Virtual microphone setup
// ---------------------------------------------------------------------------

const CABLE_PAGES = [
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip',
  'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack46.zip',
];

function updateSetup(patch) {
  Object.assign(setupState, patch);
  send('app:setup', { ...setupState });
}

function httpsDownload(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const request = https.get(url, { headers: { 'user-agent': 'VoxBridge/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return resolve(httpsDownload(next, destination, redirects - 1));
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
        if (total) {
          updateSetup({ progress: Math.min(70, Math.round((received / total) * 70)) });
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('Download timed out')));
  });
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

async function setupVirtualMicrophone() {
  if (!IS_WIN) {
    updateSetup({
      phase: 'unsupported',
      error: 'Virtual microphone installation is only available on Windows.',
    });
    return setupState;
  }
  if (setupState.phase === 'downloading' || setupState.phase === 'installing') return setupState;
  updateSetup({ phase: 'downloading', progress: 2, message: 'Contacting VB-Audio', error: '', publisher: '' });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voxbridge-cable-'));
  const zipPath = path.join(temp, 'VBCABLE.zip');
  let downloaded = false;
  let lastError = '';

  for (const url of CABLE_PAGES) {
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
    shell.openExternal('https://vb-audio.com/Cable/');
    return setupState;
  }

  updateSetup({ phase: 'extracting', progress: 74, message: 'Verifying the installer' });
  const extractDir = path.join(temp, 'extracted');
  try {
    await powershell(
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    );
  } catch (error) {
    updateSetup({ phase: 'manual', error: `Could not unpack the download: ${error.message}` });
    return setupState;
  }

  const installer = ['VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe']
    .map((name) => path.join(extractDir, name))
    .find((file) => fs.existsSync(file));

  if (!installer) {
    updateSetup({
      phase: 'manual',
      error: 'The download did not contain the expected installer. Use the official page.',
    });
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

  if (!verification.valid) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Signature check failed',
      message: 'VoxBridge could not verify the VB-CABLE installer signature.',
      detail: `Details: ${verification.detail}. Only continue if you downloaded this from vb-audio.com.`,
      buttons: ['Cancel', 'Continue anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) {
      updateSetup({ phase: 'manual', error: 'Installation cancelled after signature warning.' });
      return setupState;
    }
  }

  try {
    await powershell(`Start-Process -FilePath '${installer}' -Verb RunAs -Wait`, 300000);
    updateSetup({
      phase: 'done',
      progress: 100,
      message: 'Driver installer finished. Restart Windows if the device does not appear yet.',
    });
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
// Diagnostics
// ---------------------------------------------------------------------------

function diagnosticsReport() {
  const redacted = { ...store.get() };
  delete redacted.remembered;
  if (Array.isArray(redacted.rememberedList)) delete redacted.rememberedList;
  const report = {
    generatedAt: new Date().toISOString(),
    app: { version: APP_VERSION, platform: process.platform, arch: process.arch, release: os.release() },
    settings: redacted,
    receiver: receiver ? receiver.status() : null,
    service: service ? service.info() : null,
    devices: service ? service.listDevices() : null,
    recorder: recorder ? recorder.status() : null,
    logs: logs.slice(-200),
  };
  return report;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  store = new Store();
  receiver = null;
  service = null;
  recorder = new Recorder();

  if (IS_DEMO) {
    store.set({ theme: store.get('theme') || 'light' });
  }

  if (store.get('autoStart')) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  nativeTheme.on('updated', () => {
    if (store.get('theme') === 'system') {
      send('app:theme', 'system');
      updateTitleBar('system');
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'audioCapture', 'clipboard-read'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'audioCapture'].includes(permission);
  });

  createWindow();
  createTray();
  startReceiver();
  startService();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopReceiver();
  stopService();
  if (recorder) recorder.stop('quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in the tray when the user asked for it.
    if (store && store.get('tray') && store.get('minimizeToTray') && mainWindow) return;
    app.quit();
  }
});

app.on('will-quit', () => {
  destroyTray();
});

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

ipcMain.handle('app:get-state', () => statePayload());

ipcMain.handle('app:set-settings', (event, patch) => {
  if (!patch || typeof patch !== 'object') return statePayload();
  const allowed = [
    'theme',
    'codec',
    'rate',
    'frameMs',
    'prefillMs',
    'deviceName',
    'serviceDevice',
    'monitor',
    'monitorGain',
    'outputGainDb',
    'autoStart',
    'minimizeToTray',
    'rememberDevices',
    'requirePairing',
    'denoise',
    'gate',
    'agc',
    'presence',
    'warmth',
    'compressor',
    'limiter',
    'highpass',
    'tray',
    'showWelcome',
    'diagnostics',
    'quality',
    'recordingDir',
    'onBoard',
    'muted',
    'voiceId',
    'voicePitch',
    'voiceFormant',
    'voiceAmount',
    'soundboardGain',
  ];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
  }
  store.set(clean);
  if ('theme' in clean) {
    updateTitleBar(clean.theme);
    send('app:theme', clean.theme);
  }
  if ('tray' in clean) {
    if (clean.tray) createTray();
    else destroyTray();
  }
  if ('autoStart' in clean) {
    app.setLoginItemSettings({ openAtLogin: Boolean(clean.autoStart), args: ['--hidden'] });
  }
  if ('codec' in clean || 'rate' in clean || 'frameMs' in clean) {
    receiver?.setStreamConfig({
      codec: clean.codec || store.get('codec'),
      rate: clean.rate || store.get('rate'),
      frameMs: clean.frameMs || store.get('frameMs'),
    });
    service?.flush();
  }
  if ('requirePairing' in clean) receiver?.settings && (receiver.settings.requirePairing = clean.requirePairing);
  if ('rememberDevices' in clean) {
    receiver?.settings && (receiver.settings.rememberDevices = clean.rememberDevices);
  }
  send('app:settings', store.get());
  return statePayload();
});

ipcMain.handle('app:new-code', () => {
  if (!receiver) return null;
  const code = receiver.rotateCode();
  return code;
});

ipcMain.handle('app:forget-devices', () => {
  store.set({ remembered: {} });
  if (receiver) {
    receiver.remembered.clear();
    receiver.settings.remembered = {};
  }
  return true;
});

ipcMain.handle('receiver:restart', async () => {
  await stopReceiver();
  startReceiver();
  return true;
});

ipcMain.handle('service:start', () => startService());
ipcMain.handle('service:stop', () => {
  stopService();
  return true;
});
ipcMain.handle('service:devices', () => (service ? service.listDevices() : { native: false, render: [], capture: [] }));
ipcMain.handle('service:restart', () => {
  stopService();
  return startService();
});

ipcMain.handle('audio:packet', (event, buffer) => {
  if (!service) return false;
  const packet = Buffer.from(buffer);
  const written = service.write(packet);
  if (written) {
    const payload = packet.subarray(12);
    recorder?.write(payload);
  }
  return written;
});

// Last processed frame written. Two windows (or a stale tab) would otherwise
// hand back the same packet and the cable would play every syllable twice, out
// of order. Sequence numbers are monotonic per stream, so a repeat or a step
// backwards inside a short window is a duplicate; a gap over 400 ms means the
// writer restarted and is accepted.
let lastProcessed = { seq: null, at: 0 };

ipcMain.on('audio:processed', (event, data) => {
  const buffer = Buffer.from(data);
  if (buffer.length < 12) return;
  const seq = buffer.readUInt16LE(4);
  const now = Date.now();
  if (lastProcessed.seq !== null) {
    const delta = (seq - lastProcessed.seq) & 0xffff;
    if ((delta === 0 || delta >= 0x8000) && now - lastProcessed.at < 400) return;
  }
  lastProcessed = { seq, at: now };
  service?.write(buffer);
  recorder?.write(buffer.subarray(12));
});

ipcMain.on('session:telemetry', (event, telemetry) => {
  receiver?.setTelemetry(telemetry);
});

ipcMain.on('session:mute', (event, on) => {
  receiver?.sendMute(on);
});

ipcMain.handle('record:start', () => recorder.start({ dir: store.get('recordingDir') || defaultDir(), rate: store.get('rate') }));
ipcMain.handle('record:stop', () => recorder.stop('user'));
ipcMain.handle('record:status', () => recorder.status());
ipcMain.handle('record:open-folder', () => {
  const dir = store.get('recordingDir') || defaultDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('virtual:setup', () => setupVirtualMicrophone());
ipcMain.handle('virtual:state', () => ({ ...setupState }));
ipcMain.handle('virtual:open-download', () => shell.openExternal('https://vb-audio.com/Cable/'));
ipcMain.handle('virtual:verify-signature', (event, file) =>
  service ? service.verifySignature(file) : { valid: false, detail: 'service-missing' },
);

ipcMain.handle('diag:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save VoxBridge diagnostics',
    defaultPath: path.join(app.getPath('desktop'), 'voxbridge-diagnostics.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, JSON.stringify(diagnosticsReport(), null, 2));
  return { saved: true, file: result.filePath };
});

ipcMain.handle('app:open-external', (event, url) => openExternal(url));

ipcMain.handle('app:open-sound-settings', () => {
  // Deep-link into the Windows input page. Nothing is fetched; this only asks
  // the shell to open the system settings pane.
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'ms-settings:sound'], { windowsHide: true, detached: true });
    return true;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.sound'], { detached: true });
    return true;
  }
  return false;
});

ipcMain.handle('app:check-updates', async () => {
  return {
    current: APP_VERSION,
    available: false,
    reason: 'manual',
    url: `${GITHUB_URL}/releases`,
  };
});

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.handle('window:control', (event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
  if (action === 'close') mainWindow.close();
});

ipcMain.handle('app:set-theme', (event, theme) => {
  store.set({ theme });
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme;
  updateTitleBar(theme);
  return true;
});
