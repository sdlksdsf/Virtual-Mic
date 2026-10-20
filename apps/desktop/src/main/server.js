'use strict';

// Local receiver: WebSocket audio ingest, UDP discovery and pairing.
// No traffic ever leaves the LAN and nothing binds to a public interface.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const HEADER = 12;
const CLOSE = {
  badHello: 4400,
  pairing: 4401,
  timeout: 4408,
  rate: 4429,
  internal: 4500,
};

function lanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(ifaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        result.push({ name, address: address.address, netmask: address.netmask });
      }
    }
  }
  return result;
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const iface of lanAddresses()) {
    const ip = iface.address.split('.').map(Number);
    const mask = (iface.netmask || '255.255.255.0').split('.').map(Number);
    if (ip.length === 4 && mask.length === 4) {
      const broadcast = ip.map((part, index) => (part & mask[index]) | (~mask[index] & 255));
      out.add(broadcast.join('.'));
    }
  }
  return [...out];
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parsePacket(buffer, expectedCodec) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER || buffer[0] !== 0x56) return null;
  const codec = buffer[2];
  const flags = buffer[3];
  const seq = buffer.readUInt16LE(4);
  const ts = buffer.readUInt32LE(6);
  const length = buffer.readUInt16LE(10);
  if (HEADER + length !== buffer.length) return null;
  if (codec > 1) return null;
  if (expectedCodec !== undefined && codec !== expectedCodec) return null;
  return { codec, flags, seq, ts, payload: buffer.subarray(HEADER), length };
}

class Receiver extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.server = null;
    this.wss = null;
    this.udp = null;
    this.port = settings.port || 8720;
    this.code = this.newCode();
    this.remembered = new Map();
    this.failures = new Map();
    this.phone = null;
    this.session = null;
    this.startedAt = 0;
    this.discoveryTimer = null;
    this.statsTimer = null;
    this.pingTimer = null;
    this.socket = null;
    this.rx = 0;
    this.lost = 0;
    this.expectedSeq = null;
    this.lastSeq = null;
    this.staleDrops = 0;
    this.level = 0;
    this.peak = 0;
    this.bufferDepth = 0;
    this.jitter = 0;
    this.rtt = 0;
    this.bitrate = 0;
    this.lastBytes = 0;
    this.lastSeqAt = 0;
    this.codec = settings.codec || 'pcm16';
    this.rate = settings.rate || 48000;
    this.frameMs = settings.frameMs || 20;
    this.pendingPing = null;
  }

  newCode() {
    return String(crypto.randomInt(1000, 10000));
  }

  rotateCode() {
    this.code = this.newCode();
    this.emit('code', this.code);
    return this.code;
  }

  status() {
    return {
      running: Boolean(this.server),
      port: this.port,
      code: this.code,
      addresses: lanAddresses(),
      phone: this.phone,
      session: this.session,
      codec: this.codec,
      rate: this.rate,
      frameMs: this.frameMs,
      rx: this.rx,
      lost: this.lost,
      rtt: this.rtt,
      jitter: this.jitter,
      bufferDepth: this.bufferDepth,
      bitrate: this.bitrate,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  async start() {
    if (this.server) return this.status();
    this.port = this.settings.port || 8720;
    this.remembered = new Map(Object.entries(this.settings.remembered || {}));
    this.startedAt = Date.now();

    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'voxbridge', port: this.port }));
        return;
      }
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('VoxBridge audio endpoint. Connect with a VoxBridge mobile app.');
    });

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    this.server.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith('/mic')) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', resolve);
    });

    this.emit('state', this.status());
    this.startDiscovery();
    this.startStats();
    this.emit('log', { level: 'info', message: `Receiver listening on ${this.port}` });
    return this.status();
  }

  startDiscovery() {
    if (!this.settings.discovery) return;
    try {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp.bind(() => {
        try {
          this.udp.setBroadcast(true);
        } catch (error) {
          this.emit('log', { level: 'warn', message: `Broadcast unavailable: ${error.message}` });
        }
        const payload = () =>
          Buffer.from(
            JSON.stringify({
              voxbridge: 1,
              name: os.hostname(),
              port: this.port,
              pair: Boolean(this.settings.requirePairing),
              version: '1.0.1',
              platform: process.platform,
            }),
          );
        this.discoveryTimer = setInterval(() => {
          for (const address of broadcastAddresses()) {
            this.udp.send(payload(), 8721, address, () => {});
          }
        }, 2000);
      });
      this.udp.on('error', (error) => {
        this.emit('log', { level: 'warn', message: `Discovery stopped: ${error.message}` });
      });
    } catch (error) {
      this.emit('log', { level: 'warn', message: `Discovery unavailable: ${error.message}` });
    }
  }

  stopDiscovery() {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* already closed */
      }
      this.udp = null;
    }
  }

  startStats() {
    this.statsTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return;
      const stats = {
        t: 'stats',
        rx: this.rx,
        lost: this.lost,
        jitter: Math.round(this.jitter),
        buffer: Math.round(this.bufferDepth),
        rtt: Math.round(this.rtt),
        bitrate: Number(this.bitrate.toFixed(1)),
        level: Number(this.level.toFixed(3)),
        peak: Number(this.peak.toFixed(3)),
        codec: this.codec,
        state: 'live',
      };
      try {
        this.socket.send(JSON.stringify(stats));
      } catch {
        /* socket closing */
      }
      this.emit('phoneStats', stats);
      this.emit('state', this.status());
    }, 1000);

    this.pingTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return;
      this.pendingPing = { id: crypto.randomInt(1, 1e6), at: Date.now() };
      this.socket.send(JSON.stringify({ t: 'ping', id: this.pendingPing.id, ts: Date.now() }));
    }, 3000);
  }

  stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.statsTimer = null;
    this.pingTimer = null;
  }

  onConnection(ws, req) {
    const address = req.socket.remoteAddress || 'unknown';
    const failures = this.failures.get(address) || { count: 0, until: 0 };
    if (failures.until > Date.now()) {
      ws.close(CLOSE.rate, 'rate limited');
      return;
    }

    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE.badHello, 'hello timeout');
    }, 6000);

    ws.on('message', (data, isBinary) => {
      if (!authed) {
        try {
          const hello = JSON.parse(data.toString('utf8'));
          if (hello.t !== 'hello' || hello.v !== 1) {
            ws.close(CLOSE.badHello, 'unsupported version');
            return;
          }
          const decision = this.authorize(hello, address);
          if (!decision.ok) {
            this.recordFailure(address);
            ws.send(JSON.stringify({ t: 'denied', reason: decision.reason, hint: decision.hint }));
            setTimeout(() => ws.close(CLOSE.pairing, decision.reason), 200);
            return;
          }
          authed = true;
          clearTimeout(helloTimer);
          this.registerPhone(ws, hello, decision, address);
        } catch {
          ws.close(CLOSE.badHello, 'malformed hello');
        }
        return;
      }

      if (isBinary) {
        const packet = parsePacket(data);
        if (!packet) return;
        this.ingest(packet, data);
        return;
      }
      this.onControl(ws, data.toString('utf8'));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.socket === ws) this.endSession('disconnected');
    });

    ws.on('error', () => {
      if (this.socket === ws) this.endSession('error');
    });
  }

  authorize(hello, address) {
    if (!this.settings.requirePairing) return { ok: true, method: 'open' };
    const code = String(hello.code || '').trim();
    const token = String(hello.token || '').trim();
    if (token) {
      const hashed = hashToken(token);
      if (this.remembered.get(hashed)?.deviceId === hello.deviceId) {
        return { ok: true, method: 'token' };
      }
    }
    if (code && code === this.code) return { ok: true, method: 'code' };
    return {
      ok: false,
      reason: 'pairing-code',
      hint: 'Enter the four digit code shown on the PC.',
    };
  }

  recordFailure(address) {
    const entry = this.failures.get(address) || { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= 5) {
      entry.until = Date.now() + 30000;
      entry.count = 0;
      this.emit('log', { level: 'warn', message: `Rate limited pairing attempts from ${address}` });
    }
    this.failures.set(address, entry);
  }

  registerPhone(ws, hello, decision, address) {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.send(JSON.stringify({ t: 'denied', reason: 'replaced' }));
        this.socket.close(1000, 'replaced');
      } catch {
        /* ignore */
      }
    }

    const deviceId = String(hello.deviceId || crypto.randomUUID());
    this.socket = ws;
    this.session = crypto.randomBytes(4).toString('hex');
    this.rx = 0;
    this.lost = 0;
    this.bitrate = 0;
    this.lastBytes = 0;
    this.expectedSeq = null;
    this.lastSeq = null;
    this.staleDrops = 0;
    this.level = 0;
    this.peak = 0;

    if (decision.method === 'code' && hello.token && this.settings.rememberDevices) {
      this.remembered.set(hashToken(hello.token), {
        name: hello.name || 'Phone',
        deviceId,
        addedAt: Date.now(),
      });
      this.emit('remember', Object.fromEntries(this.remembered));
    }

    this.phone = {
      name: String(hello.name || 'Phone').slice(0, 64),
      device: String(hello.device || 'unknown').slice(0, 32),
      app: String(hello.app || '').slice(0, 32),
      address,
      connectedAt: Date.now(),
      deviceId,
    };

    ws.send(
      JSON.stringify({
        t: 'welcome',
        v: 1,
        session: this.session,
        name: os.hostname(),
        auth: decision.method,
        stream: { rate: this.rate, codec: this.codec, channels: 1, frame_ms: this.frameMs },
        settings: { mute: false, gain: 1 },
        server: '1.0.1',
      }),
    );

    if (this.settings.requirePairing) this.rotateCode();

    this.emit('phone', this.phone);
    this.emit('state', this.status());
    this.emit('log', {
      level: 'info',
      message: `${this.phone.name} connected from ${address} (${decision.method})`,
    });
  }

  ingest(packet, raw) {
    this.lastSeqAt = Date.now();
    const bytes = raw.length;
    this.bitrate = this.bitrate * 0.8 + (bytes * 8) / 0.02 * 0.2 / 1000;

    if (packet.flags & 0x02) return;

    // Drop duplicates and packets that arrive after their slot has passed.
    // A retransmitted or doubled frame is 20 ms of audio played twice, which
    // the user hears as a stutter or a repeated syllable on top of their own
    // voice. The worklet also guards against this, but dropping it here keeps
    // the meter, the recorder and the level maths honest.
    if (this.lastSeq !== null && this.lastSeq !== undefined) {
      const delta = (packet.seq - this.lastSeq) & 0xffff;
      if (delta === 0 || delta >= 0x8000) {
        this.staleDrops = (this.staleDrops || 0) + 1;
        // A reconnecting phone starts its counter over; after a short run of
        // "stale" frames, assume a new stream rather than muting it forever.
        if (this.staleDrops < 25) return;
        this.lastSeq = null;
        this.expectedSeq = null;
      } else {
        this.staleDrops = 0;
      }
    }
    this.lastSeq = packet.seq;

    if (this.expectedSeq !== null) {
      const gap = (packet.seq - this.expectedSeq) & 0xffff;
      if (gap > 0 && gap < 200) this.lost += gap;
      if (gap > 0) {
        const now = Date.now();
        if (this.lastPacketAt) {
          const delta = now - this.lastPacketAt;
          this.jitter = this.jitter * 0.9 + Math.abs(delta - 20) * 0.1;
        }
      }
    }
    this.lastPacketAt = Date.now();
    this.expectedSeq = (packet.seq + 1) & 0xffff;
    this.rx += 1;

    const samples = this.packetSamples(packet);
    if (samples) {
      for (let i = 0; i < samples.length; i += 4) {
        const value = Math.abs(samples[i] ?? 0) / 32768;
        if (value > this.peak) this.peak = value;
      }
      this.level = this.level * 0.7 + this.peak * 0.3;
    }

    this.emit('audio', raw, {
      seq: packet.seq,
      codec: packet.codec,
      silent: Boolean(packet.flags & 0x01),
    });
  }

  packetSamples(packet) {
    if (packet.codec !== 0) return null;
    const out = new Int16Array(Math.floor(packet.payload.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = packet.payload.readInt16LE(i * 2);
    return out;
  }

  onControl(ws, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'pong': {
        if (this.pendingPing && msg.id === this.pendingPing.id) {
          this.rtt = Date.now() - this.pendingPing.at;
          this.pendingPing = null;
        }
        break;
      }
      case 'quality':
        if (typeof msg.rtt === 'number') this.rtt = Math.max(0, Math.min(999, msg.rtt));
        break;
      case 'mute':
        this.emit('phoneMute', Boolean(msg.on));
        break;
      case 'bye':
        this.endSession('bye');
        break;
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', id: msg.id, ts: msg.ts }));
        break;
      default:
        break;
    }
  }

  setTelemetry({ level = 0, peak = 0, buffer = 0 } = {}) {
    this.level = Math.max(0, Math.min(1, level));
    this.peak = Math.max(0, Math.min(1, peak));
    this.bufferDepth = Math.max(0, Math.min(500, buffer));
  }

  setStreamConfig(config) {
    if (config.codec) this.codec = config.codec;
    if (config.rate) this.rate = config.rate;
    if (config.frameMs) this.frameMs = config.frameMs;
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(
        JSON.stringify({
          t: 'config',
          stream: { rate: this.rate, codec: this.codec, channels: 1, frame_ms: this.frameMs },
        }),
      );
    }
    this.emit('state', this.status());
  }

  sendMute(on) {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify({ t: 'mute', on: Boolean(on) }));
      } catch {
        /* ignore */
      }
    }
  }

  endSession(reason) {
    if (this.socket) {
      try {
        this.socket.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.phone = null;
    this.session = null;
    this.expectedSeq = null;
    this.lastSeq = null;
    this.staleDrops = 0;
    this.emit('phone', null);
    this.emit('state', this.status());
    this.emit('log', { level: 'info', message: `Session ended: ${reason}` });
  }

  async stop() {
    this.endSession('shutdown');
    this.stopDiscovery();
    this.stopStats();
    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close(1001, 'shutting down');
        } catch {
          /* ignore */
        }
      }
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.emit('state', this.status());
  }
}

module.exports = { Receiver, parsePacket, lanAddresses, hashToken, CLOSE };
