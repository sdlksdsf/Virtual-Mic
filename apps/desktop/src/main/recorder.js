'use strict';

// Session recorder. Writes exactly what was sent to the virtual microphone,
// so the file can be compared with what apps hear.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024 * 1024 - 64;

function defaultDir() {
  try {
    return path.join(app.getPath('music'), 'VoxBridge Recordings');
  } catch {
    return path.join(app.getPath('userData'), 'recordings');
  }
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

class Recorder {
  constructor() {
    this.file = null;
    this.fd = null;
    this.bytes = 0;
    this.startedAt = 0;
    this.rate = 48000;
    this.stoppedReason = '';
  }

  status() {
    return {
      recording: Boolean(this.fd),
      file: this.file,
      durationMs: this.fd ? Date.now() - this.startedAt : 0,
      bytes: this.bytes,
      rate: this.rate,
    };
  }

  start({ dir, rate = 48000 } = {}) {
    if (this.fd) return this.status();
    const target = dir && dir.trim() ? dir.trim() : defaultDir();
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, `VoxBridge ${timestamp()}.wav`);
    const fd = fs.openSync(file, 'w');
    const header = Buffer.alloc(44);
    this.rate = rate;
    header.write('RIFF', 0);
    header.writeUInt32LE(36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(0, 40);
    fs.writeSync(fd, header);
    this.fd = fd;
    this.file = file;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.stoppedReason = '';
    return this.status();
  }

  write(int16Buffer) {
    if (!this.fd) return;
    if (this.bytes >= MAX_BYTES) {
      this.stop('size-limit');
      return;
    }
    const buffer = Buffer.isBuffer(int16Buffer)
      ? int16Buffer
      : Buffer.from(int16Buffer.buffer || int16Buffer);
    try {
      fs.writeSync(this.fd, buffer);
      this.bytes += buffer.length;
    } catch (error) {
      this.stop(`write-error: ${error.message}`);
    }
  }

  stop(reason = 'user') {
    if (!this.fd) return this.status();
    const fd = this.fd;
    this.fd = null;
    this.stoppedReason = reason;
    try {
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + this.bytes, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(this.rate, 24);
      header.writeUInt32LE(this.rate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(this.bytes, 40);
      fs.writeSync(fd, header, 0, 44, 0);
      fs.closeSync(fd);
    } catch {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    return this.status();
  }
}

module.exports = { Recorder, defaultDir };
