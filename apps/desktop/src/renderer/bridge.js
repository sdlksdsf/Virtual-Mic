/* VoxBridge desktop bridge.
 *
 * In the packaged app the interface is served by the standalone host and talks
 * to it over a WebSocket. This file exposes the same window.voxbridge surface
 * that the Electron preload provides, so the rest of the renderer is unchanged.
 */
(function () {
  'use strict';

  if (window.voxbridge) return;

  const listeners = new Map();
  const pending = new Map();
  let socket = null;
  let sequence = 0;
  let connected = false;
  let reconnectTimer = null;

  function toBase64(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer || value);
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function emit(channel, payload) {
    const entries = listeners.get(channel);
    if (!entries) return;
    for (const callback of entries) {
      try {
        callback(payload);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/bridge`);
    socket.addEventListener('open', () => {
      connected = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    });
    socket.addEventListener('close', () => {
      connected = false;
      for (const [id, entry] of pending) {
        entry.reject(new Error('VoxBridge host disconnected'));
        pending.delete(id);
      }
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1200);
      }
    });
    socket.addEventListener('error', () => {
      /* close handler runs next */
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'event') {
        emit(message.channel, message.payload);
        return;
      }
      if (message.type === 'result') {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error || 'VoxBridge request failed'));
      }
    });
  }

  function call(method, ...args) {
    connect();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const send = () => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ type: 'call', id, method, args }));
      };
      if (connected && socket.readyState === 1) {
        send();
        return;
      }
      const wait = () => {
        if (connected && socket.readyState === 1) return send();
        setTimeout(wait, 60);
      };
      wait();
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('VoxBridge host did not respond'));
        }
      }, 15000);
    });
  }

  connect();

  window.voxbridge = {
    isDesktop: true,
    platform: 'win32',
    demo: false,
    standalone: true,
    getState: () => call('getState'),
    setSettings: (patch) => call('setSettings', patch),
    newPairCode: () => call('newPairCode'),
    forgetDevices: () => call('forgetDevices'),
    restartReceiver: () => call('restartReceiver'),
    startService: () => call('startService'),
    stopService: () => call('stopService'),
    listDevices: () => call('listDevices'),
    restartService: () => call('restartService'),
    sendPacket: (buffer) => call('sendPacket', toBase64(buffer)),
    sendProcessedAudio: (buffer) => call('sendProcessedAudio', toBase64(buffer)),
    sendTelemetry: (telemetry) => call('sendTelemetry', telemetry),
    sendMute: (on) => call('sendMute', on),
    startRecording: () => call('startRecording'),
    stopRecording: () => call('stopRecording'),
    recordingStatus: () => call('recordingStatus'),
    openRecordings: () => call('openRecordings'),
    setupVirtualMic: () => call('setupVirtualMic'),
    virtualState: () => call('virtualState'),
    openVirtualDownload: () => call('openVirtualDownload'),
    openSoundSettings: () => call('openSoundSettings'),
    verifySignature: (file) => call('verifySignature', file),
    exportDiagnostics: () => call('exportDiagnostics'),
    openExternal: (url) => call('openExternal', url),
    checkUpdates: () => call('checkUpdates'),
    quit: () => call('quit'),
    windowControl: (action) => call('windowControl', action),
    setTheme: (theme) => call('setTheme', theme),
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(callback);
      return () => {
        const entries = listeners.get(channel);
        if (entries) entries.delete(callback);
      };
    },
  };
})();
