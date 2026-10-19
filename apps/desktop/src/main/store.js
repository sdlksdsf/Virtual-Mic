'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  theme: 'system',
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
  showWelcome: true,
  diagnostics: false,
  port: 8720,
  discovery: true,
  recordingDir: '',
  lastPhone: null,
  quality: 'balanced',
  onBoard: false,
  muted: false,
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.data = { ...DEFAULTS, ...parsed };
    } catch {
      // First launch or unreadable file: defaults are safe.
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  reset() {
    this.data = { ...DEFAULTS };
    this.save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS };
