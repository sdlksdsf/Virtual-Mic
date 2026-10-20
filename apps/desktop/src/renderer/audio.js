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

    // Spectral denoiser with decision-directed a priori SNR estimation
    // (Ephraim-Malah style). Compared with plain spectral subtraction this
    // keeps consonants intact and produces far less musical noise.
    //
    // Overlap-add uses a square-root Hann window for both analysis and
    // synthesis. The product is a Hann window, which sums to exactly 1.0 at
    // 50% overlap; using Hann twice would modulate the output at the frame
    // rate and sound buzzy.
    class Denoiser {
      constructor(strength) {
        this.strength = Math.max(0, Math.min(1, strength));
        this.fft = new FFT(FFT_N);
        this.window = new Float32Array(FFT_N);
        for (let i = 0; i < FFT_N; i += 1) {
          this.window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
        }
        this.frame = new Float32Array(FFT_N);
        this.pending = new Float32Array(HOP);
        this.pendingFill = 0;
        this.ola = new Float32Array(FFT_N);
        this.ready = new Float32Array(HOP * 4);
        this.readyLen = 0;
        this.readyPos = 0;
        const bins = (FFT_N >> 1) + 1;
        this.power = new Float32Array(bins);
        this.noise = new Float32Array(bins).fill(Infinity);
        this.gain = new Float32Array(bins);
        this.smooth = new Float32Array(bins);
        this.prevGain = new Float32Array(bins);
        this.prevGamma = new Float32Array(bins);
        this.initFrames = 0;
        this.initTarget = 30;  // ~160 ms of room tone before suppression starts
        this.speechHold = 0;
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
        // How much of a noise-only bin survives. The old curve left 18 % of the
        // room tone at the strongest setting (-15 dB), which is audible as hiss
        // under the voice. This one reaches -30 dB and still fades in smoothly.
        const floorGain = 0.22 - 0.19 * strength;
        const alphaDD = 0.92;
        const warming = this.initFrames < this.initTarget;

        // Pass 1: smooth the periodogram. Raw FFT power has a variance as
        // large as its mean, so everything downstream works on the smoothed
        // value; the total drives the speech detector.
        let framePower = 0;
        for (let i = 0; i < bins; i += 1) {
          const raw = re[i] * re[i] + im[i] * im[i];
          this.power[i] += (raw - this.power[i]) * 0.25;
          framePower += this.power[i];
        }
        framePower /= bins;

        // Pass 2: is this frame speech or room? A frame clearly above the
        // tracked noise is speech, and the estimate is then frozen. This is
        // what makes the suppression hold: the old minimum-statistics tracker
        // ran straight through the voice, drifted with it, and left a hiss
        // floor that was 6 dB out.
        if (warming) {
          for (let i = 0; i < bins; i += 1) {
            if (this.noise[i] > this.power[i]) this.noise[i] = this.power[i];
          }
        }
        let noisePower = 0;
        for (let i = 0; i < bins; i += 1) noisePower += this.noise[i];
        noisePower /= bins;
        const loud = noisePower > 1e-9 && framePower > noisePower * 3;
        if (loud) this.speechHold = 80;
        else if (this.speechHold > 0) this.speechHold -= 1;
        const upRate = this.speechHold === 0 ? 0.06 : 0.0005;

        // Pass 3: track the floor and build the gain.
        for (let i = 0; i < bins; i += 1) {
          const ps = this.power[i];
          const prevNoise = this.noise[i];
          if (ps < prevNoise) {
            this.noise[i] = prevNoise + (ps - prevNoise) * 0.4;
          } else {
            this.noise[i] = prevNoise + (ps - prevNoise) * upRate;
          }
          // The warm-up minimum sits a few dB under the true mean; compensate
          // once so the first phrase is already protected.
          if (this.initFrames === this.initTarget) this.noise[i] *= 2.5;
          const floorPower = Math.max(this.noise[i], 1e-12);

          if (warming) {
            this.smooth[i] = 1;
            this.prevGain[i] = 1;
            this.prevGamma[i] = 1;
            continue;
          }

          // Spectral over-subtraction. A plain Wiener gain only removes about
          // half the power of stationary noise, which is why a fan or an air
          // conditioner stayed audible.
          const gamma = Math.max(ps - 0.8 * floorPower, 0.05 * floorPower) / floorPower;
          const xi = Math.min(
            64,
            alphaDD * (this.prevGain[i] * this.prevGain[i]) * Math.min(this.prevGamma[i], 8)
              + (1 - alphaDD) * Math.max(gamma - 1, 0),
          );
          let g = xi / (1 + xi);
          // Hiss lives in the top octaves; lean on them a little harder.
          const hf = i / (bins - 1);
          const floor = floorGain * (1 - 0.35 * hf * hf);
          if (g < floor) g = floor;
          if (g > 1) g = 1;
          this.smooth[i] = g;
          this.prevGamma[i] = gamma;
          this.prevGain[i] = g;
        }

        for (let i = 0; i < bins; i += 1) {
          // Three-tap smoothing across neighbouring bins removes the isolated
          // "musical noise" spikes that make denoised speech sound metallic.
          let g = this.smooth[i];
          if (!warming && i > 0 && i < bins - 1) {
            g = 0.25 * this.smooth[i - 1] + 0.5 * this.smooth[i] + 0.25 * this.smooth[i + 1];
          }
          this.gain[i] = g;
          re[i] *= g;
          im[i] *= g;
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
          const grown = new Float32Array(this.ready.length * 2);
          grown.set(this.ready.subarray(this.readyPos, this.readyLen));
          this.ready = grown;
          this.readyLen -= this.readyPos;
          this.readyPos = 0;
        }
        for (let i = 0; i < HOP; i += 1) {
          // sqrt-Hann analysis x sqrt-Hann synthesis = Hann, which is exactly
          // unity-sum at 50% overlap. No normalisation gain is needed.
          this.ready[this.readyLen + i] = this.ola[i];
        }
        this.readyLen += HOP;
        this.ola.copyWithin(0, HOP);
        this.ola.fill(0, FFT_N - HOP);
        if (this.initFrames < 100000) this.initFrames += 1;
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

    // Block-based lookahead limiter. The output block is one buffer behind the
    // input, so the gain needed for an incoming transient is already applied
    // when that transient reaches the output. Without lookahead a peak passes
    // at full level and is only clamped afterwards, which is the crunchy
    // distortion you hear when the boost is high.
    class LookaheadLimiter {
      constructor(rate, ceilingDb) {
        this.ceiling = dbToGain(ceilingDb);
        this.delay = new Float32Array(128);
        this.prevGain = 1;
        this.gain = 1;
        this.release = 1 - Math.exp(-1 / (rate * 0.12));
      }

      reset() {
        this.delay.fill(0);
        this.prevGain = 1;
        this.gain = 1;
      }

      process(block, out) {
        const n = block.length;
        if (this.delay.length !== n) this.delay = new Float32Array(n);

        let peakIn = 0;
        for (let i = 0; i < n; i += 1) {
          const a = block[i] < 0 ? -block[i] : block[i];
          if (a > peakIn) peakIn = a;
        }
        let peakOut = 0;
        for (let i = 0; i < n; i += 1) {
          const a = this.delay[i] < 0 ? -this.delay[i] : this.delay[i];
          if (a > peakOut) peakOut = a;
        }

        // Be ready for the block that is arriving and keep the block leaving
        // under the ceiling.
        let target = 1;
        if (peakIn > this.ceiling) target = this.ceiling / peakIn;
        if (peakOut > this.ceiling) target = Math.min(target, this.ceiling / peakOut);

        if (target < this.gain) this.gain = target; // instant attack
        else this.gain += (target - this.gain) * this.release; // smooth release

        const startGain = this.prevGain;
        const attacking = this.gain < startGain;
        const step = (this.gain - startGain) / n;

        for (let i = 0; i < n; i += 1) {
          const g = attacking ? this.gain : startGain + step * i;
          let x = this.delay[i] * g;
          if (x > this.ceiling) x = this.ceiling;
          if (x < -this.ceiling) x = -this.ceiling;
          out[i] = x;
          this.delay[i] = block[i];
        }
        this.prevGain = this.gain;
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
        this.gateTarget = 1;
        this.gateHold = 0;
        this.agcGain = 1;
        this.agcEnv = 0;
        this.compEnv = 0;
        this.compGain = 1;
        this.mutedGain = 1;
        this.mix = new Float32Array(128);
        this.limiter = new LookaheadLimiter(this.rate, -1);

        this.chunk = new Int16Array(Math.round(this.rate * 0.02));
        this.chunkFill = 0;
        this.outSeq = 0;

        this.meterInAcc = 0;
        this.meterOutAcc = 0;
        this.meterPeak = 0;
        this.meterCount = 0;
        this.lastMeter = 0;
        this.lastAdapt = 0;
        this.lastRaise = 0;

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
        this.agcEnv = 0;
        this.compGain = 1;
        this.compEnv = 0;
        this.gateGain = 1;
        this.gateTarget = 1;
        this.gateHold = 0;
        this.env = 0;
        this.mutedGain = 1;
        this.limiter.reset();
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
          // out fast, instead of snapping to digital silence (which clicks).
          // The fade is deliberately short: on a jittery Wi-Fi link the late
          // packet still arrives, and long concealment made the user hear the
          // same syllable twice.
          this.silenceQuanta += 1;
          const fade = Math.max(0, 1 - this.silenceQuanta / 8);
          const offset = Math.round(frames * (this.silenceQuanta % 4));
          for (let i = got; i < frames; i += 1) {
            const idx = (offset + i) % this.lastFrameSamples.length;
            channel[i] = this.lastFrameSamples[idx] * fade;
          }
          if (got === 0) {
            this.underrunEvents += 1;
            // Grow the cushion immediately instead of waiting for the slow
            // two-second adjuster. A starving buffer repeats audio; a few more
            // milliseconds of latency do not.
            if (currentTime - this.lastRaise > 0.5 && this.targetMs < 240) {
              this.lastRaise = currentTime;
              this.targetMs = Math.min(240, this.targetMs + 30);
            }
          }
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

        // ---- voice chain -------------------------------------------------
        // Stage order matters: EQ -> auto gain -> gate -> user boost ->
        // compressor -> lookahead limiter. The boost sits *before* the
        // compressor so a hot signal is compressed with a 3:1 ratio instead of
        // being slammed into the limiter ceiling, which is what made the old
        // chain sound distorted at high gain.
        if (this.mix.length < frames) this.mix = new Float32Array(frames);
        const mix = this.mix;
        const dt = 1 / this.rate;
        const boost = dbToGain(this.runtime.boostDb);
        // -40 dBFS opens, -49 dBFS closes. The old pair (-44 / -50) sat low
        // enough that room tone kept the gate open and the auto gain then
        // lifted it another 12 dB.
        const gateOpen = 0.0100;
        const gateClose = 0.0035;
        const envAttack = 1 - Math.exp(-dt / 0.002);
        const envRelease = 1 - Math.exp(-dt / 0.180);
        const agcAttack = 1 - Math.exp(-dt / 0.030);
        const agcRelease = 1 - Math.exp(-dt / 0.400);
        const gateAttack = 1 - Math.exp(-dt / 0.005);
        const gateRelease = 1 - Math.exp(-dt / 0.150);
        const compAttack = 1 - Math.exp(-dt / 0.003);
        const compRelease = 1 - Math.exp(-dt / 0.120);

        for (let i = 0; i < frames; i += 1) {
          let x = i < got ? block[i] : channel[i];

          if (this.config.highpass) x = this.hp.process(x);
          x = this.presence.process(x);
          x = this.warmth.process(x);

          const raw = Math.abs(x);

          // Track the gate envelope first: it answers "is anyone speaking?",
          // and both the gate and the auto gain need that answer.
          if (this.config.gate) {
            this.env += (raw - this.env) * (raw > this.env ? envAttack : envRelease);
            if (this.env > gateOpen) {
              this.gateHold = 0.120;
              this.gateTarget = 1;
            } else if (this.env < gateClose) {
              this.gateHold -= dt;
              if (this.gateHold <= 0) this.gateTarget = 0.0005;
            }
          }
          const speaking = this.config.gate ? this.env > gateOpen : raw > gateOpen;

          // Auto gain rides the level slowly, but only while there is speech.
          // Adapting during pauses is what made the noise floor swell between
          // phrases: with nothing to measure it crept up to +12 dB and lifted
          // the hiss into audibility.
          if (this.config.agc) {
            if (speaking) {
              this.agcEnv += (raw - this.agcEnv)
                * (raw > this.agcEnv ? agcAttack : agcRelease);
              if (this.agcEnv > 0.0016) {
                const currentDb = 20 * Math.log10(this.agcEnv + 1e-9);
                const targetGain = Math.max(0.5, Math.min(4, dbToGain(-20 - currentDb)));
                const glide = 1 - Math.exp(-dt / 0.600);
                this.agcGain += (targetGain - this.agcGain) * glide;
              }
            }
            x *= this.agcGain;
          }

          // Hysteresis gate with a hold and a slow release. The old gate
          // released in milliseconds and chattered on every consonant.
          if (this.config.gate) {
            this.gateGain += (this.gateTarget - this.gateGain)
              * (this.gateTarget > this.gateGain ? gateAttack : gateRelease);
            x *= this.gateGain;
          }

          x *= boost;

          // Soft-knee 3:1 compressor. Unchanged signal below the knee, so a
          // low boost stays completely transparent.
          if (this.config.compressor) {
            const level = Math.abs(x);
            this.compEnv += (level - this.compEnv)
              * (level > this.compEnv ? compAttack : compRelease);
            const levelDb = 20 * Math.log10(this.compEnv + 1e-9);
            const threshold = -14;
            const knee = 6;
            let reduction = 0;
            if (levelDb > threshold + knee) {
              reduction = (levelDb - threshold) * (1 - 1 / 3);
            } else if (levelDb > threshold - knee) {
              const t = (levelDb - (threshold - knee)) / (2 * knee);
              reduction = t * t * knee * (1 - 1 / 3);
            }
            const targetGain = dbToGain(-reduction);
            this.compGain += (targetGain - this.compGain)
              * (targetGain < this.compGain ? compAttack : compRelease);
            x *= this.compGain;
          }

          mix[i] = x;
        }

        // Lookahead limiting, then mute ramp, meters and 20 ms framing on the
        // final signal so what is measured is exactly what the cable receives.
        this.limiter.process(mix, channel);

        const muted = this.config.muted;
        const muteStep = 1 - Math.exp(-dt / 0.012);
        for (let i = 0; i < frames; i += 1) {
          this.mutedGain += ((muted ? 0 : 1) - this.mutedGain) * muteStep;
          const x = channel[i] * this.mutedGain;
          channel[i] = x;

          this.meterInAcc += inputBuf[i] * inputBuf[i];
          this.meterOutAcc += x * x;
          const p = x < 0 ? -x : x;
          if (p > this.meterPeak) this.meterPeak = p;
          this.meterCount += 1;

          if (this.chunkFill < this.chunk.length) {
            let q = Math.round(x * 32767);
            if (q > 32767) q = 32767;
            else if (q < -32768) q = -32768;
            this.chunk[this.chunkFill++] = q;
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
      this.lastResumeTry = 0;
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
      if (this.context && this.context.state !== 'running') {
        try {
          await this.context.resume();
        } catch {
          /* blocked until a gesture; retried on the next packet */
        }
      }
      return this.context ? this.context.state === 'running' : false;
    }

    // Called on every inbound packet. If the context is suspended the worklet
    // is not running, which means nothing is reaching the virtual microphone.
    // Retry at most once a second so a stubborn policy does not spin the main
    // thread, and expose the state so the UI can warn the user.
    ensureRunning() {
      if (!this.context) return false;
      if (this.context.state === 'running') return true;
      const now = Date.now();
      if (now - (this.lastResumeTry || 0) < 1000) return false;
      this.lastResumeTry = now;
      this.resume();
      return false;
    }

    get running() {
      return Boolean(this.context && this.context.state === 'running');
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
      this.ensureRunning();
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
