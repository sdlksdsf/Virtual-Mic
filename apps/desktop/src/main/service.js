'use strict';

// Owns the native Windows capture service process. The service is a small C++
// binary that renders PCM into a virtual audio endpoint; when it is not
// available (non-Windows dev machines, or before installation) the app falls
// back to a software sink so the rest of the pipeline still works.

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEADER = 12;
const SERVICE_NAME = process.platform === 'win32' ? 'VoxBridgeMic.exe' : 'VoxBridgeMic';

function candidatePaths() {
  const list = [];
  if (process.env.VOXBRIDGE_SERVICE) list.push(process.env.VOXBRIDGE_SERVICE);
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'service', SERVICE_NAME));
  list.push(path.join(__dirname, '..', '..', 'service-bin', SERVICE_NAME));
  list.push(path.join(__dirname, '..', '..', 'service', 'build', 'Release', SERVICE_NAME));
  list.push(path.join(__dirname, '..', '..', 'service', 'build', SERVICE_NAME));
  return list;
}

function findBinary() {
  for (const candidate of candidatePaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

class CaptureService extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.binary = findBinary();
    this.buffer = '';
    this.state = {
      mode: this.binary ? 'native' : 'software',
      status: 'idle',
      device: '',
      fallback: false,
      rate: 48000,
      bufferMs: 20,
      prefillMs: 80,
      lastError: '',
      restarts: 0,
      version: null,
    };
    this.intentionalStop = false;
    this.framesSent = 0;
  }

  info() {
    return { ...this.state, binary: this.binary };
  }

  listDevices() {
    if (!this.binary || process.platform !== 'win32') {
      return {
        native: false,
        render: [],
        capture: [],
        note: 'Native device enumeration is only available on Windows.',
      };
    }
    const result = spawnSync(this.binary, ['--list-devices'], { encoding: 'utf8', timeout: 8000 });
    if (result.status !== 0 || !result.stdout) {
      return { native: false, render: [], capture: [], note: 'Device enumeration failed.' };
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ev === 'devices') return { native: true, ...parsed };
      } catch {
        /* keep looking */
      }
    }
    return { native: false, render: [], capture: [], note: 'No device list returned.' };
  }

  verifySignature(file) {
    if (!this.binary || process.platform !== 'win32') return { valid: false, detail: 'unsupported-platform' };
    const result = spawnSync(this.binary, ['--verify', file], { encoding: 'utf8', timeout: 10000 });
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.ev === 'verify') return parsed;
      } catch {
        /* ignore */
      }
    }
    return { valid: false, detail: 'verify-failed' };
  }

  start(options = {}) {
    if (this.proc) return this.info();
    this.intentionalStop = false;
    const {
      device = '',
      rate = 48000,
      bufferMs = 20,
      prefillMs = 80,
      wavOut = '',
      diagnostics = false,
    } = options;

    this.state.rate = rate;
    this.state.bufferMs = bufferMs;
    this.state.prefillMs = prefillMs;
    this.state.lastError = '';

    if (!this.binary || process.platform !== 'win32') {
      this.state.mode = 'software';
      this.state.status = 'software';
      this.state.device = 'Software sink';
      this.state.fallback = true;
      this.emit('event', {
        ev: 'ready',
        device: 'Software sink',
        fallback: true,
        note: 'Native capture service not installed. Audio is processed but will not appear as a microphone until VoxBridge is installed on Windows.',
      });
      this.emit('state', this.info());
      return this.info();
    }

    const args = [
      '--device',
      device,
      '--rate',
      String(rate),
      '--buffer-ms',
      String(bufferMs),
      '--prefill-ms',
      String(prefillMs),
    ];
    if (wavOut) args.push('--wav-out', wavOut);
    if (diagnostics) {
      const logPath = path.join(os.tmpdir(), 'voxbridge-service.log');
      args.push('--log', logPath);
    }

    this.emit('event', { ev: 'spawning', args });
    const proc = spawn(this.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.state.status = 'starting';
    this.state.mode = 'native';
    this.emit('state', this.info());

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.emit('log', { level: 'warn', message: String(chunk).trim().slice(0, 500) });
    });
    proc.on('error', (error) => {
      this.state.lastError = error.message;
      this.state.status = 'error';
      this.emit('event', { ev: 'error', code: 'spawn', message: error.message });
      this.emit('state', this.info());
    });
    proc.on('exit', (code) => {
      this.proc = null;
      this.state.status = this.intentionalStop ? 'stopped' : 'error';
      this.emit('event', { ev: 'stopped', code });
      if (!this.intentionalStop && this.state.restarts < 3) {
        this.state.restarts += 1;
        setTimeout(() => {
          if (!this.proc && !this.intentionalStop) this.start(options);
        }, 700 * this.state.restarts);
      }
      this.emit('state', this.info());
    });

    return this.info();
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (event.ev === 'ready') {
          this.state.status = 'ready';
          this.state.device = event.device || '';
          this.state.fallback = Boolean(event.fallback);
          this.state.rate = event.rate || this.state.rate;
          this.state.bufferMs = event.bufferMs || this.state.bufferMs;
          this.state.prefillMs = event.prefillMs || this.state.prefillMs;
        }
        if (event.ev === 'error') {
          this.state.status = 'error';
          this.state.lastError = event.message || event.code || 'unknown';
        }
        if (event.ev === 'boot') this.state.version = event.version || null;
        this.emit('event', event);
        this.emit('state', this.info());
      } catch {
        /* ignore malformed line */
      }
    }
  }

  framePacket(packet) {
    if (!Buffer.isBuffer(packet)) packet = Buffer.from(packet);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(packet.length, 0);
    return Buffer.concat([header, packet]);
  }

  write(packet) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(this.framePacket(packet));
      this.framesSent += 1;
      return true;
    } catch {
      return false;
    }
  }

  command(payload) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    try {
      this.proc.stdin.write(Buffer.concat([header, body]));
      return true;
    } catch {
      return false;
    }
  }

  setGain(db) {
    this.command({ cmd: 'volume', db });
  }

  flush() {
    this.command({ cmd: 'flush' });
  }

  stop() {
    this.intentionalStop = true;
    if (!this.proc) {
      this.state.status = 'idle';
      this.emit('state', this.info());
      return;
    }
    try {
      this.command({ cmd: 'quit' });
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const proc = this.proc;
    setTimeout(() => {
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    }, 800);
    this.proc = null;
    this.state.status = 'stopped';
    this.emit('state', this.info());
  }
}

module.exports = { CaptureService, findBinary, HEADER };
