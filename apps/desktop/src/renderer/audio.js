/* VoxBridge audio runtime.
 * Phone packets arrive as WebSocket binary frames (see docs/PROTOCOL.md).
 * They are decoded, resampled if required, buffered by an adaptive jitter
 * buffer and processed by the DSP chain inside an AudioWorklet. Processed
 * 20 ms frames are handed back to the main process, which forwards them to
 * the native capture service and the optional recorder.
 */

/* eslint-disable no-undef */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Worklet. Stringified, so everything it needs must live inside this
  // function. Runs on the audio thread.
  // -------------------------------------------------------------------------
  function voxbridgeWorklet() {
    'use strict';

    const FFT_N = 512;
    const HOP = 256;

    function dbToGain(db) {
      return Math.pow(10, db / 20);
    }

    class FFT {
      constructor(n) {
        this.n = n;
        this.re = new Float32Array(n);
        this.im = new Float32Array(n);
        this.cos = new Float32Array(n / 2);
        this.sin = new Float32Array(n / 2);
        for (let i = 0; i < n / 2; i += 1) {
          this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
          this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
        }
        this.rev = new Uint32Array(n);
        const bits = Math.log2(n) | 0;
        for (let i = 0; i < n; i += 1) {
          let x = i;
          let r = 0;
          for (let b = 0; b < bits; b += 1) {
            r = (r << 1) | (x & 1);
            x >>= 1;
          }
          this.rev[i] = r;
        }
      }

      transform(re, im, inverse) {
        const n = this.n;
        for (let i = 0; i < n; i += 1) {
          const j = this.rev[i];
          if (j > i) {
            let t = re[i];
            re[i] = re[j];
            re[j] = t;
            t = im[i];
            im[i] = im[j];
            im[j] = t;
          }
        }
        for (let size = 2; size <= n; size <<= 1) {
          const half = size >> 1;
          const step = n / size;
          for (let i = 0; i < n; i += size) {
            for (let j = 0; j < half; j += 1) {
              const k = j * step;
              const wr = this.cos[k];
              const wi = inverse ? -this.sin[k] : this.sin[k];
              const a = i + j;
              const b = a + half;
              const tr = re[b] * wr - im[b] * wi;
              const ti = re[b] * wi + im[b] * wr;
              re[b] = re[a] - tr;
              im[b] = im[a] - ti;
              re[a] += tr;
              im[a] += ti;
            }
          }
        }
        if (inverse) {
          for (let i = 0; i < n; i += 1) {
            re[i] /= n;
            im[i] /= n;
          }
        }
      }
    }

    class Denoiser {
      constructor(strength) {
        this.strength = Math.max(0, Math.min(1, strength));
        this.fft = new FFT(FFT_N);
        this.window = new Float32Array(FFT_N);
        for (let i = 0; i < FFT_N; i += 1) {
          this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
        }
        this.frame = new Float32Array(FFT_N);
        this.pending = new Float32Array(HOP);
        this.pendingFill = 0;
        this.ola = new Float32Array(FFT_N);
        this.ready = new Float32Array(HOP * 2);
        this.readyLen = 0;
        this.readyPos = 0;
        this.mag = new Float32Array(FFT_N / 2 + 1);
        this.noise = new Float32Array(FFT_N / 2 + 1);
        this.gain = new Float32Array(FFT_N / 2 + 1);
        this.initFrames = 0;
      }

      setStrength(value) {
        this.strength = Math.max(0, Math.min(1, value));
      }

      processBlock(input, output) {
        for (let i = 0; i < input.length; i += 1) {
          this.pending[this.pendingFill] = input[i];
          this.pendingFill += 1;
          if (this.pendingFill >= HOP) {
            this.pendingFill = 0;
            this.flushFrame();
          }
        }
        for (let i = 0; i < output.length; i += 1) {
          if (this.readyPos < this.readyLen) {
            output[i] = this.ready[this.readyPos];
            this.readyPos += 1;
          } else {
            output[i] = 0;
          }
        }
        if (this.readyPos >= this.readyLen) {
          this.readyPos = 0;
          this.readyLen = 0;
        }
      }

      flushFrame() {
        this.frame.copyWithin(0, HOP);
        this.frame.set(this.pending, FFT_N - HOP);

        const re = this.fft.re;
        const im = this.fft.im;
        for (let i = 0; i < FFT_N; i += 1) {
          re[i] = this.frame[i] * this.window[i];
          im[i] = 0;
        }
        this.fft.transform(re, im, false);

        const bins = (FFT_N >> 1) + 1;
        const strength = this.strength;
        const floor = 1 - 0.9 * strength;

        for (let i = 0; i < bins; i += 1) {
          const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
          this.mag[i] = mag;
          if (this.initFrames < 18) {
            this.noise[i] = Math.max(this.noise[i] * 0.92, mag * 0.82);
            this.gain[i] = 1;
          } else {
            if (mag < this.noise[i]) this.noise[i] = this.noise[i] * 0.9 + mag * 0.1;
            else this.noise[i] = this.noise[i] * 0.9995 + mag * 0.0005;
            let g = mag > 1e-7 ? (mag - strength * this.noise[i] * 1.45) / mag : 0;
            if (g < floor) g = floor;
            if (g > 1) g = 1;
            this.gain[i] = this.gain[i] * 0.5 + g * 0.5;
          }
          re[i] *= this.gain[i];
          im[i] *= this.gain[i];
        }
        for (let i = 1; i < FFT_N / 2; i += 1) {
          re[FFT_N - i] = re[i];
          im[FFT_N - i] = -im[i];
        }

        this.fft.transform(re, im, true);

        for (let i = 0; i < FFT_N; i += 1) {
          this.ola[i] += re[i] * this.window[i];
        }
        if (this.readyLen + HOP > this.ready.length) {
          const grown = new Float32Array(this.ready.length * 2 + HOP);
          grown.set(this.ready.subarray(this.readyPos, this.readyLen));
          this.ready = grown;
          this.readyLen -= this.readyPos;
          this.readyPos = 0;
        }
        for (let i = 0; i < HOP; i += 1) {
          this.ready[this.readyLen + i] = this.ola[i] / 1.5;
        }
        this.readyLen += HOP;
        this.ola.copyWithin(0, HOP);
        this.ola.fill(0, FFT_N - HOP);
        if (this.initFrames < 1000) this.initFrames += 1;
      }
    }

    class Biquad {
      constructor() {
        this.b0 = 1;
        this.b1 = 0;
        this.b2 = 0;
        this.a1 = 0;
        this.a2 = 0;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
      }
      highpass(rate, hz, q) {
        const w = (2 * Math.PI * hz) / rate;
        const alpha = Math.sin(w) / (2 * q);
        const cos = Math.cos(w);
        const a0 = 1 + alpha;
        this.b0 = (1 + cos) / 2 / a0;
        this.b1 = -(1 + cos) / a0;
        this.b2 = this.b0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
      }
      peaking(rate, hz, q, db) {
        const A = Math.pow(10, db / 40);
        const w = (2 * Math.PI * hz) / rate;
        const alpha = Math.sin(w) / (2 * q);
        const cos = Math.cos(w);
        const a0 = 1 + alpha / A;
        this.b0 = (1 + alpha * A) / a0;
        this.b1 = (-2 * cos) / a0;
        this.b2 = (1 - alpha * A) / a0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha / A) / a0;
      }
      lowshelf(rate, hz, db) {
        const A = Math.pow(10, db / 40);
        const w = (2 * Math.PI * hz) / rate;
        const cos = Math.cos(w);
        const sin = Math.sin(w);
        const alpha = sin / Math.SQRT2;
        const sq = 2 * Math.sqrt(A) * alpha;
        const a0 = (A + 1) + (A - 1) * cos + sq;
        this.b0 = (A * ((A + 1) - (A - 1) * cos + sq)) / a0;
        this.b1 = (2 * A * ((A - 1) - (A + 1) * cos)) / a0;
        this.b2 = (A * ((A + 1) - (A - 1) * cos - sq)) / a0;
        this.a1 = (-2 * ((A - 1) + (A + 1) * cos)) / a0;
        this.a2 = ((A + 1) + (A - 1) * cos - sq) / a0;
      }
      process(x) {
        const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1;
        this.x1 = x;
        this.y2 = this.y1;
        this.y1 = y;
        return y;
      }
      reset() {
        this.x1 = this.x2 = this.y1 = this.y2 = 0;
      }
    }

    class VoxBridgeProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.rate = sampleRate;
        this.queue = [];
        this.queueOffset = 0;
        this.expectedSeq = null;
        this.started = false;
        this.targetMs = 60;
        this.baseTargetMs = 60;
        this.packets = 0;
        this.lostPackets = 0;
        this.underrunEvents = 0;
        this.lastSeq = 0;
        this.silenceQuanta = 0;
        this.lastAudioAt = 0;
        this.lastFrameSamples = new Float32Array(960);

        this.config = {
          denoise: 2,
          gate: true,
          agc: true,
          presence: 3,
          warmth: 2,
          compressor: true,
          limiter: true,
          highpass: true,
          boost: 0,
          muted: false,
          prefillMs: 60,
        };
        this.runtime = { boostDb: 0 };

        this.denoiser = null;
        this.hp = new Biquad();
        this.hp.highpass(this.rate, 78, 0.707);
        this.presence = new Biquad();
        this.presence.peaking(this.rate, 3150, 0.9, 0);
        this.warmth = new Biquad();
        this.warmth.lowshelf(this.rate, 210, 0);

        this.env = 0;
        this.gateGain = 1;
        this.gateHold = 0;
        this.agcGain = 1;
        this.agcEnv = 0;
        this.compEnv = 0;
        this.limitGain = 1;
        this.mutedGain = 1;

        this.chunk = new Int16Array(Math.round(this.rate * 0.02));
        this.chunkFill = 0;
        this.outSeq = 0;

        this.meterInAcc = 0;
        this.meterOutAcc = 0;
        this.meterPeak = 0;
        this.meterCount = 0;
        this.lastMeter = 0;
        this.lastAdapt = 0;

        this.port.onmessage = (event) => this.onMessage(event.data);
      }

      onMessage(message) {
        if (!message || !message.type) return;
        if (message.type === 'audio') {
          this.push(new Float32Array(message.buffer), message.seq);
        } else if (message.type === 'config') {
          this.applyConfig(message.config || {});
        } else if (message.type === 'flush' || message.type === 'reset') {
          this.reset();
        }
      }

      reset() {
        this.queue.length = 0;
        this.queueOffset = 0;
        this.started = false;
        this.expectedSeq = null;
        this.silenceQuanta = 0;
        this.chunkFill = 0;
        this.chunk.fill(0);
        this.denoiser = null;
        this.hp.reset();
        this.presence.reset();
        this.warmth.reset();
        this.agcGain = 1;
        this.limitGain = 1;
        this.gateGain = 1;
        this.mutedGain = 1;
      }

      applyConfig(config) {
        Object.assign(this.config, config);
        this.targetMs = Math.max(20, Math.min(400, this.config.prefillMs || 60));
        this.baseTargetMs = this.targetMs;
        this.runtime.boostDb = Math.max(0, Math.min(24, this.config.boost || 0));
        this.presence.peaking(this.rate, 3150, 0.9, this.config.presence || 0);
        this.warmth.lowshelf(this.rate, 210, this.config.warmth || 0);
        const denoiseLevel = this.config.denoise || 0;
        if (denoiseLevel > 0) {
          if (!this.denoiser) this.denoiser = new Denoiser(denoiseLevel / 4);
          this.denoiser.setStrength(Math.min(1, denoiseLevel / 4));
        } else {
          this.denoiser = null;
        }
      }

      available() {
        let total = 0;
        for (let i = 0; i < this.queue.length; i += 1) {
          total += this.queue[i].length - (i === 0 ? this.queueOffset : 0);
        }
        return total;
      }

      push(samples, seq) {
        const frames = samples.length;
        if (!frames) return;
        if (this.expectedSeq !== null) {
          const gap = (seq - this.expectedSeq) & 0xffff;
          if (gap === 0) {
            // in order
          } else if (gap < 0x4000) {
            if (gap <= 50) {
              // Conceal short gaps with silence of the same duration rather
              // than corrupting the timeline.
              const fill = Math.min(frames * gap, Math.round(this.rate * 0.3));
              this.enqueue(new Float32Array(fill));
              this.lostPackets += gap;
            } else {
              this.queue.length = 0;
              this.queueOffset = 0;
              this.started = false;
              this.lostPackets += gap;
            }
          } else {
            return; // duplicate or very late packet
          }
        }
        this.expectedSeq = (seq + 1) & 0xffff;
        this.lastSeq = seq;
        this.packets += 1;
        this.lastAudioAt = currentTime;
        this.enqueue(samples);
        // Hard cap: never hold more than half a second of audio.
        const maxFrames = Math.round(this.rate * 0.5);
        while (this.available() > maxFrames && this.queue.length > 1) {
          const dropped = this.queue.shift();
          if (this.queue.length) {
            // keep offset semantics simple by dropping whole head packets
          } else {
            break;
          }
        }
      }

      enqueue(samples) {
        this.queue.push(samples);
      }

      pull(count, out) {
        let written = 0;
        while (written < count && this.queue.length) {
          const head = this.queue[0];
          const available = head.length - this.queueOffset;
          const take = Math.min(available, count - written);
          out.set(head.subarray(this.queueOffset, this.queueOffset + take), written);
          written += take;
          this.queueOffset += take;
          if (this.queueOffset >= head.length) {
            this.queue.shift();
            this.queueOffset = 0;
          }
        }
        if (written < count) out.fill(0, written);
        return written;
      }

      driftCorrect() {
        // If we are sitting on far more than the target, trim one 20 ms packet
        // so latency cannot grow without bound over a long call.
        const maxFrames = Math.round(((this.targetMs + 60) / 1000) * this.rate);
        const frame = Math.round(this.rate * 0.02);
        if (this.available() > maxFrames && this.queue.length > 1) {
          const head = this.queue[0];
          this.queueOffset += Math.min(frame, head.length - this.queueOffset);
          if (this.queueOffset >= head.length) {
            this.queue.shift();
            this.queueOffset = 0;
          }
        }
      }

      process(inputs, outputs) {
        const out = outputs[0];
        const channel = out && out[0];
        if (!channel) return true;
        const frames = channel.length;
        const now = currentTime * 1000;

        const targetFrames = Math.round((this.targetMs / 1000) * this.rate);
        if (!this.started) {
          if (this.available() >= targetFrames) {
            this.started = true;
            this.silenceQuanta = 0;
          } else {
            channel.fill(0);
            this.postMeter(now, 0, 0);
            return true;
          }
        }

        this.driftCorrect();

        const inputBuf = new Float32Array(frames);
        const got = this.pull(frames, inputBuf);

        if (got < frames) {
          // Packet loss concealment: repeat the tail of the last frame, fading
          // out, instead of snapping to digital silence (which clicks).
          this.silenceQuanta += 1;
          const fade = Math.max(0, 1 - this.silenceQuanta / 26);
          const offset = Math.round(frames * (this.silenceQuanta % 8));
          for (let i = got; i < frames; i += 1) {
            const idx = (offset + i) % this.lastFrameSamples.length;
            channel[i] = this.lastFrameSamples[idx] * fade;
          }
          if (got === 0) this.underrunEvents += 1;
          if (this.silenceQuanta > 26) {
            this.started = false;
            this.silenceQuanta = 0;
          }
        }
        if (got > 0) {
          this.lastFrameSamples.set(inputBuf.subarray(Math.max(0, got - this.lastFrameSamples.length)), 0);
        }

        let block = inputBuf;
        if (this.denoiser) {
          block = new Float32Array(frames);
          this.denoiser.processBlock(inputBuf, block);
        }

        const boost = Math.pow(10, this.runtime.boostDb / 20);
        const muted = this.config.muted;
        for (let i = 0; i < frames; i += 1) {
          let x = i < got ? block[i] : channel[i];

          if (this.config.highpass) x = this.hp.process(x);
          x = this.presence.process(x);
          x = this.warmth.process(x);

          if (this.config.gate) {
            const abs = Math.abs(x);
            this.env = abs > this.env ? this.env + (abs - this.env) * 0.004 : this.env - this.env * 0.0009;
            if (this.env > 0.0032) this.gateHold = 0.08;
            else this.gateHold = Math.max(0, this.gateHold - frames / this.rate);
            const target = this.env > 0.0032 || this.gateHold > 0 ? 1 : 0.0006;
            this.gateGain += (target - this.gateGain) * (target > this.gateGain ? 0.02 : 0.0015);
            x *= this.gateGain;
          }

          if (this.config.agc) {
            this.agcEnv += (Math.abs(x) - this.agcEnv) * 0.0006;
            if (this.agcEnv > 0.002) {
              const currentDb = 20 * Math.log10(this.agcEnv + 1e-9);
              const desired = Math.max(-3, Math.min(18, -19 - currentDb));
              const maxStepDb = (frames / this.rate) * 26;
              const currentGainDb = 20 * Math.log10(this.agcGain + 1e-9);
              const delta = Math.max(-maxStepDb, Math.min(maxStepDb, desired - currentGainDb));
              this.agcGain *= Math.pow(10, (delta * 0.35) / 20);
              this.agcGain = Math.max(0.35, Math.min(8, this.agcGain));
            }
            x *= this.agcGain;
          }

          if (this.config.compressor) {
            const abs = Math.abs(x);
            this.compEnv = abs > this.compEnv ? this.compEnv + (abs - this.compEnv) * 0.06 : this.compEnv * 0.9992;
            const threshold = 0.125;
            if (this.compEnv > threshold) {
              const over = 20 * Math.log10(this.compEnv / threshold);
              x *= Math.pow(10, (-over * (1 - 1 / 3)) / 20);
            }
            x *= Math.pow(10, 1.2 / 20);
          }

          x *= boost;

          if (this.config.limiter) {
            const ceiling = 0.891;
            const abs = Math.abs(x);
            const targetGain = abs > ceiling ? ceiling / abs : 1;
            if (targetGain < this.limitGain) this.limitGain = targetGain;
            else this.limitGain += (1 - this.limitGain) * 0.0009;
            x *= this.limitGain;
            if (x > 0.999) x = 0.999;
            if (x < -0.999) x = -0.999;
          }

          this.mutedGain += ((muted ? 0 : 1) - this.mutedGain) * 0.0015;
          x *= this.mutedGain;

          channel[i] = x;

          this.meterInAcc += inputBuf[i] * inputBuf[i];
          this.meterOutAcc += x * x;
          const p = Math.abs(x);
          if (p > this.meterPeak) this.meterPeak = p;
          this.meterCount += 1;

          if (this.chunkFill < this.chunk.length) {
            this.chunk[this.chunkFill++] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
            if (this.chunkFill >= this.chunk.length) {
              const finished = this.chunk;
              this.chunk = new Int16Array(finished.length);
              this.chunkFill = 0;
              this.port.postMessage({ type: 'pcm', buffer: finished.buffer, seq: this.outSeq++ }, [
                finished.buffer,
              ]);
            }
          }
        }

        this.postMeter(now, inputBuf, channel, got, frames);

        if (now - this.lastAdapt > 2000) {
          this.lastAdapt = now;
          if (this.underrunEvents >= 2 && this.targetMs < 220) {
            this.targetMs = Math.min(220, this.targetMs + 20);
          } else if (this.underrunEvents === 0 && this.targetMs > this.baseTargetMs) {
            this.targetMs = Math.max(this.baseTargetMs, this.targetMs - 10);
          }
          this.underrunEvents = 0;
        }
        return true;
      }

      postMeter(now, input, channel, got = 0, frames = 128) {
        if (now - this.lastMeter < 90) return;
        this.lastMeter = now;
        const inRms = Math.sqrt(this.meterInAcc / Math.max(1, this.meterCount));
        const outRms = Math.sqrt(this.meterOutAcc / Math.max(1, this.meterCount));
        const peak = this.meterPeak;
        this.meterInAcc = 0;
        this.meterOutAcc = 0;
        this.meterPeak = 0;
        this.meterCount = 0;
        this.port.postMessage({
          type: 'meter',
          inRms,
          outRms,
          peak,
          bufferMs: (this.available() / this.rate) * 1000,
          targetMs: this.targetMs,
          started: this.started,
          lostPackets: this.lostPackets,
          packets: this.packets,
          frames,
        });
      }
    }

    registerProcessor('voxbridge-mic', VoxBridgeProcessor);
  }

  const WORKLET_SOURCE = `(${voxbridgeWorklet.toString()})();`;

  // -------------------------------------------------------------------------
  // IMA ADPCM decoder (matches apps/desktop/service/src/vb_core.h).
  // -------------------------------------------------------------------------
  const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
  const STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
  ];

  function decodeAdpcm(view, offset) {
    const length = view.byteLength - offset;
    if (length < 4) return new Int16Array(0);
    let predictor = view.getInt16(offset, true);
    let index = view.getUint8(offset + 2);
    const output = new Int16Array((length - 4) * 2);
    let out = 0;
    for (let i = offset + 4; i < view.byteLength; i += 1) {
      const byte = view.getUint8(i);
      for (let half = 0; half < 2; half += 1) {
        const code = half === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
        const step = STEP_TABLE[index];
        let diff = step >> 3;
        if (code & 4) diff += step;
        if (code & 2) diff += step >> 1;
        if (code & 1) diff += step >> 2;
        predictor += code & 8 ? -diff : diff;
        if (predictor > 32767) predictor = 32767;
        if (predictor < -32768) predictor = -32768;
        index += INDEX_TABLE[code];
        if (index < 0) index = 0;
        if (index > 88) index = 88;
        output[out++] = predictor;
      }
    }
    return output.subarray(0, out);
  }

  function parsePacket(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    if (bytes.length < 12 || bytes[0] !== 0x56) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const codec = bytes[2];
    const flags = bytes[3];
    const seq = view.getUint16(4, true);
    const ts = view.getUint32(6, true);
    const length = view.getUint16(10, true);
    if (length + 12 !== bytes.length) return null;
    let samples;
    if (codec === 0) {
      samples = new Int16Array(length / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(12 + i * 2, true);
    } else if (codec === 1) {
      samples = decodeAdpcm(view, 12);
    } else {
      return null;
    }
    return { codec, flags, seq, ts, samples };
  }

  function buildPacket(samples, { seq = 0, codec = 0, ts = performance.now() } = {}) {
    const payloadBytes = codec === 0 ? samples.length * 2 : 0;
    const buffer = new ArrayBuffer(12 + payloadBytes);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    bytes[0] = 0x56;
    bytes[1] = 1;
    bytes[2] = codec;
    bytes[3] = 0;
    view.setUint16(4, seq & 0xffff, true);
    view.setUint32(6, Math.round(ts) >>> 0, true);
    view.setUint16(10, payloadBytes, true);
    for (let i = 0; i < samples.length; i += 1) {
      view.setInt16(12 + i * 2, samples[i], true);
    }
    return buffer;
  }

  // Linear resampler with a small hold buffer. Good enough for voice.
  class Resampler {
    constructor(from, to) {
      this.from = from;
      this.to = to;
      this.ratio = from / to;
      this.buffer = new Float32Array(0);
      this.position = 0;
      this.enabled = from !== to;
    }
    process(input) {
      if (!this.enabled) return input;
      const merged = new Float32Array(this.buffer.length + input.length);
      merged.set(this.buffer);
      merged.set(input, this.buffer.length);
      const outLength = Math.floor((merged.length - 1 - this.position) / this.ratio) + 1;
      if (outLength <= 0) {
        this.buffer = merged;
        return new Float32Array(0);
      }
      const out = new Float32Array(outLength);
      let pos = this.position;
      for (let i = 0; i < outLength; i += 1) {
        const index = Math.floor(pos);
        const frac = pos - index;
        const a = merged[index] ?? 0;
        const b = merged[index + 1] ?? a;
        out[i] = a + (b - a) * frac;
        pos += this.ratio;
      }
      const consumed = Math.floor(pos);
      this.buffer = merged.slice(Math.min(consumed, merged.length));
      this.position = pos - consumed;
      return out;
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------
  class AudioPipeline {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.context = null;
      this.node = null;
      this.gain = null;
      this.ready = false;
      this.rate = 48000;
      this.inputRate = 48000;
      this.resampler = new Resampler(48000, 48000);
      this.outSeq = 0;
      this.muted = false;
      this.monitor = false;
      this.monitorGain = 0.8;
      this.pendingConfig = {};
      this.lastMeter = { at: 0, bufferMs: 0 };
      this.stats = { underruns: 0, concealed: 0 };
      this.startedAt = 0;
      this.lastPacketAt = 0;
      this.packets = 0;
    }

    async init() {
      if (this.context) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.rate = this.context.sampleRate;
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.node = new AudioWorkletNode(this.context, 'voxbridge-mic', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.monitor ? this.monitorGain : 0;
      this.node.connect(this.gain).connect(this.context.destination);
      this.node.port.onmessage = (event) => this.onWorkletMessage(event.data);
      this.node.port.postMessage({ type: 'config', config: this.configPayload() });
      this.node.port.postMessage({ type: 'start' });
      this.ready = true;
    }

    async resume() {
      if (this.context && this.context.state === 'suspended') {
        await this.context.resume();
      }
    }

    configPayload() {
      return {
        denoise: this.pendingConfig.denoise ?? 0.55,
        gate: this.pendingConfig.gate !== false,
        agc: this.pendingConfig.agc !== false,
        presence: this.pendingConfig.presence ?? 3,
        warmth: this.pendingConfig.warmth ?? 2,
        compressor: this.pendingConfig.compressor !== false,
        limiter: this.pendingConfig.limiter !== false,
        highpass: this.pendingConfig.highpass !== false,
        boost: this.pendingConfig.boost ?? 0,
        muted: this.muted,
        prefillMs: this.pendingConfig.prefillMs ?? 60,
      };
    }

    configure(config) {
      Object.assign(this.pendingConfig, config);
      if (config.prefillMs) {
        const prefill = Math.max(30, Math.min(400, config.prefillMs));
        // Reset the buffer when the target moves meaningfully, otherwise the
        // new depth only applies after the next starvation event.
        this.pendingConfig.prefillMs = prefill;
      }
      this.node?.port.postMessage({ type: 'config', config: this.configPayload() });
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      this.node?.port.postMessage({ type: 'config', config: this.configPayload() });
      if (this.handlers.onMute) this.handlers.onMute(this.muted);
    }

    setMonitor(on, gain = this.monitorGain) {
      this.monitor = Boolean(on);
      this.monitorGain = Math.max(0, Math.min(1, gain));
      if (this.gain && this.context) {
        this.gain.gain.setTargetAtTime(this.monitor ? this.monitorGain : 0, this.context.currentTime, 0.03);
      }
    }

    setOutputRate(rate) {
      this.inputRate = Number(rate) || 48000;
      this.resampler = new Resampler(this.inputRate, this.rate);
    }

    pushPacket(buffer) {
      const packet = parsePacket(buffer);
      if (!packet) return false;
      if (packet.codec === 0 && this.inputRate !== this.rate) {
        // Resample PCM. ADPCM is decoded at its native rate below.
      }
      let samples = packet.samples;
      if (samples.length === 0) return false;
      if (this.inputRate !== this.rate) {
        const floats = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i] / 32768;
        const resampled = this.resampler.process(floats);
        const out = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i += 1) {
          out[i] = Math.max(-32768, Math.min(32767, Math.round(resampled[i] * 32767)));
        }
        samples = out;
      }
      if (!samples.length) return false;
      const floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i] / 32768;
      this.node?.port.postMessage({ type: 'audio', buffer: floats.buffer, seq: packet.seq }, [
        floats.buffer,
      ]);
      this.packets += 1;
      this.lastPacketAt = performance.now();
      if (!this.startedAt) this.startedAt = performance.now();
      return true;
    }

    onWorkletMessage(message) {
      if (!message) return;
      if (message.type === 'pcm') {
        const samples = new Int16Array(message.buffer);
        const packet = buildPacket(samples, { seq: this.outSeq++, ts: performance.now() });
        this.handlers.onFrame?.(packet);
      } else if (message.type === 'meter') {
        this.lastMeter = message;
        this.stats.underruns = message.underruns;
        this.stats.concealed = message.concealed;
        this.handlers.onMeter?.(message);
      }
    }

    flush() {
      this.node?.port.postMessage({ type: 'flush' });
      this.outSeq = 0;
    }

    async close() {
      try {
        await this.context?.close();
      } catch {
        /* ignore */
      }
      this.context = null;
      this.node = null;
      this.ready = false;
    }
  }

  window.VoxBridgeAudio = {
    AudioPipeline,
    parsePacket,
    buildPacket,
    decodeAdpcm,
    Resampler,
  };
})();
