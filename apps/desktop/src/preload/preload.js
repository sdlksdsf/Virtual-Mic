'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

function on(channel, callback) {
  const key = `${channel}:${Math.random().toString(36).slice(2)}`;
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  listeners.set(key, { channel, handler });
  return () => {
    ipcRenderer.removeListener(channel, handler);
    listeners.delete(key);
  };
}

contextBridge.exposeInMainWorld('voxbridge', {
  isDesktop: true,
  platform: process.platform,
  demo: false,
  getState: () => ipcRenderer.invoke('app:get-state'),
  setSettings: (patch) => ipcRenderer.invoke('app:set-settings', patch),
  newPairCode: () => ipcRenderer.invoke('app:new-code'),
  forgetDevices: () => ipcRenderer.invoke('app:forget-devices'),
  restartReceiver: () => ipcRenderer.invoke('receiver:restart'),
  startService: () => ipcRenderer.invoke('service:start'),
  stopService: () => ipcRenderer.invoke('service:stop'),
  listDevices: () => ipcRenderer.invoke('service:devices'),
  restartService: () => ipcRenderer.invoke('service:restart'),
  sendPacket: (buffer) => ipcRenderer.invoke('audio:packet', buffer),
  sendProcessedAudio: (buffer) => ipcRenderer.send('audio:processed', buffer),
  sendTelemetry: (telemetry) => ipcRenderer.send('session:telemetry', telemetry),
  sendMute: (on) => ipcRenderer.send('session:mute', on),
  startRecording: () => ipcRenderer.invoke('record:start'),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  recordingStatus: () => ipcRenderer.invoke('record:status'),
  openRecordings: () => ipcRenderer.invoke('record:open-folder'),
  setupVirtualMic: () => ipcRenderer.invoke('virtual:setup'),
  virtualState: () => ipcRenderer.invoke('virtual:state'),
  openVirtualDownload: () => ipcRenderer.invoke('virtual:open-download'),
  verifySignature: (file) => ipcRenderer.invoke('virtual:verify-signature', file),
  exportDiagnostics: () => ipcRenderer.invoke('diag:export'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  quit: () => ipcRenderer.invoke('app:quit'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  on,
});
