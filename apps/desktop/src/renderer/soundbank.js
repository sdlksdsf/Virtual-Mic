/* VoxBridge sound bank.
 *
 * Every pad is synthesised here, from maths, at load time. Nothing is
 * downloaded, nothing is sampled from a record, and nothing carries a
 * licence: the same 34 sounds ship with the app, work offline, and cost
 * about 40 seconds of Float32 memory.
 *
 * The renderer calls VoxBridgeSoundbank.render(id, rate) once per pad and
 * hands the buffer to the audio worklet, which mixes it into the virtual
 * microphone next to the voice.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  function buffer(rate, seconds) {
    return new Float32Array(Math.max(1, Math.ceil(rate * seconds)));
  }

  // Deterministic noise, so a pad sounds identical on every machine and the
  // bank is reproducible in tests.
  function noise(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return (state / 0xffffffff) * 2 - 1;
    };
  }

  function saw(phase) {
    return 2 * (phase - Math.floor(phase + 0.5));
  }

  function square(phase) {
    return phase - Math.floor(phase) < 0.5 ? 1 : -1;
  }

  function tri(phase) {
    const p = phase - Math.floor(phase);
    return 4 * Math.abs(p - 0.5) - 1;
  }

  function clip(x, lim = 1) {
    return x > lim ? lim : x < -lim ? -lim : x;
  }

  function soft(x, drive) {
    return Math.tanh(x * drive) / Math.tanh(drive);
  }

  // One-pole low/high pass, applied in place. Cheap and smooth.
  function lowpass(data, rate, hz) {
    const a = Math.exp((-TAU * hz) / rate);
    let z = 0;
    for (let i = 0; i < data.length; i += 1) {
      z = data[i] * (1 - a) + z * a;
      data[i] = z;
    }
    return data;
  }

  function highpass(data, rate, hz) {
    const a = Math.exp((-TAU * hz) / rate);
    let z = 0;
    for (let i = 0; i < data.length; i += 1) {
      z = data[i] * (1 - a) + z * a;
      data[i] = data[i] - z;
    }
    return data;
  }

  // Two-pole resonator, the workhorse of the formant voices below.
  function resonate(data, rate, hz, bandwidth, gain = 1) {
    const r = Math.exp((-Math.PI * bandwidth) / rate);
    const theta = (TAU * Math.min(hz, rate * 0.45)) / rate;
    const b1 = 2 * r * Math.cos(theta);
    const b2 = -(r * r);
    const a = (1 - r) * gain;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < data.length; i += 1) {
      const y = a * data[i] + b1 * y1 + b2 * y2;
      y2 = y1;
      y1 = y;
      data[i] = y;
    }
    return data;
  }

  // A short fade at both ends. Every pad gets one, because a sample that
  // starts mid-waveform clicks in the call.
  function fade(data, rate, inMs = 3, outMs = 18) {
    const a = Math.max(1, Math.round((inMs / 1000) * rate));
    const b = Math.max(1, Math.round((outMs / 1000) * rate));
    for (let i = 0; i < a && i < data.length; i += 1) data[i] *= i / a;
    for (let i = 0; i < b && i < data.length; i += 1) data[data.length - 1 - i] *= i / b;
    return data;
  }

  function normalize(data, peak = 0.86) {
    let max = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
      sum += data[i] * data[i];
    }
    if (!max || !Number.isFinite(max)) return data;
    const rms = Math.sqrt(sum / Math.max(1, data.length));
    // Mostly peak-normalise, but pull very quiet or very loud pads toward a
    // shared loudness so the soundboard does not need a volume slider per pad.
    const byPeak = peak / max;
    const byRms = rms > 1e-5 ? 0.19 / rms : byPeak;
    const gain = Math.min(byPeak, Math.max(byPeak * 0.35, byRms));
    for (let i = 0; i < data.length; i += 1) data[i] *= gain;
    return data;
  }

  // Additive bell: partials with independent decays.
  function bell(rate, seconds, partials, gain = 1) {
    const out = buffer(rate, seconds);
    for (const [hz, level, decay] of partials) {
      const step = (TAU * hz) / rate;
      const k = Math.exp(-1 / (decay * rate));
      let amp = level;
      let phase = 0;
      for (let i = 0; i < out.length; i += 1) {
        out[i] += Math.sin(phase) * amp * gain;
        phase += step;
        amp *= k;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Formant voice. Segments describe a vowel: three formant centres plus a
  // pitch contour. The source is a soft sawtooth (a glottal pulse) with a
  // little breath noise, shaped by three resonators. It is not a recording,
  // but it reads as speech at meme distance.
  // -------------------------------------------------------------------------

  const VOWELS = {
    a: [780, 1150, 2600],
    ae: [690, 1660, 2490],
    e: [530, 1840, 2480],
    i: [300, 2200, 2950],
    o: [480, 820, 2500],
    u: [330, 700, 2200],
    uh: [640, 1190, 2390],
    er: [490, 1350, 1690],
    m: [250, 950, 2200],
    n: [250, 1400, 2400],
    r: [420, 1300, 1600],
    l: [360, 1000, 2800],
  };

  // Render a line of voiced segments into `out`. Each segment glides from the
  // previous vowel, which is what makes a sequence of formants read as words
  // rather than as a sequence of beeps.
  function formantLine(out, rate, segments, rnd, options = {}) {
    const breath = options.breath ?? 0;
    const rasp = options.rasp ?? 0;
    let phase = 0;
    let prev = [VOWELS.uh[0], VOWELS.uh[1], VOWELS.uh[2]];
    let f1 = prev[0];
    let f2 = prev[1];
    let f3 = prev[2];

    // Three two-pole resonators in parallel, each with its own output history.
    const state = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    let b11 = 0;
    let b12 = 0;
    let b21 = 0;
    let b22 = 0;
    let b31 = 0;
    let b32 = 0;
    let g1 = 0.1;
    let g2 = 0.06;
    let g3 = 0.04;

    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      let segment = null;
      for (const candidate of segments) {
        if (t >= candidate.at && t < candidate.at + candidate.dur) {
          segment = candidate;
          break;
        }
      }

      let gain = 0;
      if (segment) {
        const local = (t - segment.at) / segment.dur;
        const target = VOWELS[segment.vowel] || VOWELS.uh;
        const glide = Math.min(1, local / 0.16);
        f1 = prev[0] + (target[0] - prev[0]) * (0.06 + 0.94 * glide);
        f2 = prev[1] + (target[1] - prev[1]) * (0.06 + 0.94 * glide);
        f3 = prev[2] + (target[2] - prev[2]) * (0.06 + 0.94 * glide);
        const from = segment.from ?? 120;
        const to = segment.to ?? from;
        const f0 = from + (to - from) * local;
        phase += (f0 * (1 + rnd() * 0.004)) / rate;
        gain = Math.min(1, local / 0.05) * Math.min(1, (1 - local) / 0.18) * (segment.gain ?? 1);
        if (local > 0.9) prev = [f1, f2, f3];
      }

      // Coefficients refreshed every 32 samples: fast enough to glide the
      // vowel, cheap enough to build 34 pads in well under a second.
      if ((i & 31) === 0) {
        const q1 = Math.exp((-Math.PI * 90) / rate);
        const q2 = Math.exp((-Math.PI * 120) / rate);
        const q3 = Math.exp((-Math.PI * 170) / rate);
        b11 = 2 * q1 * Math.cos((TAU * f1) / rate);
        b12 = -q1 * q1;
        b21 = 2 * q2 * Math.cos((TAU * f2) / rate);
        b22 = -q2 * q2;
        b31 = 2 * q3 * Math.cos((TAU * f3) / rate);
        b32 = -q3 * q3;
        g1 = (1 - q1) * 1.2;
        g2 = (1 - q2) * 0.7;
        g3 = (1 - q3) * 0.4;
      }

      const source =
        saw(phase) * 0.66 +
        tri(phase) * 0.28 +
        rnd() * breath +
        (rasp ? saw(phase * 1.5) * rasp : 0);

      const s1 = g1 * source + b11 * state[0][0] + b12 * state[0][1];
      const s2 = g2 * source + b21 * state[1][0] + b22 * state[1][1];
      const s3 = g3 * source + b31 * state[2][0] + b32 * state[2][1];
      state[0][1] = state[0][0];
      state[0][0] = s1;
      state[1][1] = state[1][0];
      state[1][0] = s2;
      state[2][1] = state[2][0];
      state[2][0] = s3;

      out[i] = (s1 + s2 + s3) * gain;
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Pads
  // -------------------------------------------------------------------------

  const DEFS = [];
  function pad(id, name, group, seconds, build) {
    DEFS.push({ id, name, group, seconds, build });
  }

  // --- Horns and stings ----------------------------------------------------

  pad('airhorn', 'Air horn', 'horns', 2.2, (rate) => {
    const out = buffer(rate, 2.2);
    const blasts = [
      [0.02, 0.36],
      [0.46, 0.8],
      [0.9, 2.1],
    ];
    const partials = [233, 311, 466, 622];
    for (const [start, end] of blasts) {
      for (let p = 0; p < partials.length; p += 1) {
        const hz = partials[p] * (p === 0 ? 1 : 1.003);
        const step = (TAU * hz) / rate;
        let phase = p * 0.7;
        const from = Math.round(start * rate);
        const to = Math.round(end * rate);
        const len = to - from;
        for (let i = 0; i < len; i += 1) {
          const pos = i / len;
          const env = Math.min(1, pos * 60) * Math.min(1, (1 - pos) * 14);
          out[from + i] += saw(phase / TAU) * env * (p === 0 ? 0.5 : 0.22 / p);
          phase += step;
        }
      }
    }
    lowpass(out, rate, 5200);
    highpass(out, rate, 180);
    for (let i = 0; i < out.length; i += 1) out[i] = soft(out[i] * 2.4, 2.2);
    return out;
  });

  pad('sadtrombone', 'Sad trombone', 'horns', 3.1, (rate) => {
    const out = buffer(rate, 3.1);
    const notes = [
      [311.1, 0.0, 0.5],
      [277.2, 0.52, 0.46],
      [233.1, 0.98, 0.46],
      [207.7, 1.44, 1.5],
    ];
    for (const [hz, at, dur] of notes) {
      const from = Math.round(at * rate);
      const len = Math.min(out.length - from, Math.round(dur * rate));
      let phase = 0;
      let wah = 0;
      for (let i = 0; i < len; i += 1) {
        const t = i / rate;
        const pos = i / len;
        // Wa-wa: the vowel opens then closes, which is what a plunger mute does.
        const vowel = Math.sin(Math.PI * Math.min(1, pos * 1.15));
        const vib = Math.sin(TAU * 5.2 * t) * 0.012;
        const drop = pos > 0.86 ? 1 - (pos - 0.86) * 0.9 : 1;
        phase += (hz * drop * (1 + vib)) / rate;
        const tone = saw(phase) * 0.7 + saw(phase * 2.02) * 0.15;
        wah += (tone - wah) * (0.0015 + 0.03 * vowel);
        const env = Math.min(1, t / 0.03) * Math.min(1, (1 - pos) * 6);
        out[from + i] += wah * env * (0.6 + 0.4 * vowel);
      }
    }
    lowpass(out, rate, 1800);
    return out;
  });

  pad('womp', 'Womp womp', 'horns', 1.5, (rate) => {
    const out = buffer(rate, 1.5);
    const notes = [
      [233.1, 0, 0.42],
      [185.0, 0.46, 0.95],
    ];
    for (const [hz, at, dur] of notes) {
      const from = Math.round(at * rate);
      const len = Math.min(out.length - from, Math.round(dur * rate));
      let phase = 0;
      let lp = 0;
      for (let i = 0; i < len; i += 1) {
        const pos = i / len;
        phase += (hz * (1 - pos * 0.12) * (1 + Math.sin(TAU * 6 * (i / rate)) * 0.01)) / rate;
        const tone = saw(phase) + saw(phase * 1.005) * 0.5;
        lp += (tone - lp) * (0.02 + 0.12 * Math.sin(Math.PI * pos));
        out[from + i] += lp * Math.min(1, (1 - pos) * 5) * Math.min(1, (i / rate) / 0.03);
      }
    }
    return out;
  });

  pad('vineboom', 'Vine boom', 'horns', 1.4, (rate) => {
    const out = buffer(rate, 1.4);
    const rnd = noise(11);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const f = 92 * Math.exp(-t * 2.4) + 34;
      phase += f / rate;
      const env = Math.exp(-t * 2.1);
      const sub = Math.sin(TAU * phase) * env;
      const thud = rnd() * Math.exp(-t * 26) * 0.5;
      lp += (sub * 1.4 + thud - lp) * 0.09;
      out[i] = soft(lp * 1.6, 1.6);
    }
    return out;
  });

  pad('dun', 'Dun dun dunnn', 'horns', 2.6, (rate) => {
    const out = buffer(rate, 2.6);
    const chord = [73.4, 110, 146.8];
    for (const [index, hz] of chord.entries()) {
      const at = index === 2 ? 0.55 : 0;
      const from = Math.round(at * rate);
      for (let i = from; i < out.length; i += 1) {
        const t = (i - from) / rate;
        const env = Math.min(1, t / 0.06) * Math.exp(-t * (index === 2 ? 1.1 : 2.4));
        const phase = TAU * hz * t;
        out[i] += (saw(phase / TAU) * 0.5 + Math.sin(phase) * 0.6) * env * 0.5;
      }
    }
    const hit = buffer(rate, 0.6);
    const rnd = noise(23);
    let lp = 0;
    for (let i = 0; i < hit.length; i += 1) {
      const t = i / rate;
      lp += (rnd() - lp) * 0.08;
      hit[i] = lp * Math.exp(-t * 9) * 1.4 + Math.sin(TAU * 58 * t) * Math.exp(-t * 12) * 0.7;
    }
    for (let i = 0; i < hit.length; i += 1) out[i] += hit[i] * 0.8;
    lowpass(out, rate, 2400);
    return out;
  });

  pad('rimshot', 'Rimshot', 'horns', 1.3, (rate) => {
    const out = buffer(rate, 1.3);
    const rnd = noise(31);
    // ba
    for (let i = 0; i < Math.round(0.11 * rate); i += 1) {
      const t = i / rate;
      out[i] += rnd() * Math.exp(-t * 45) * 0.9;
    }
    // dum
    const dumAt = Math.round(0.16 * rate);
    for (let i = 0; i < Math.round(0.3 * rate); i += 1) {
      const t = i / rate;
      const f = 150 * Math.exp(-t * 6) + 90;
      out[dumAt + i] += Math.sin(TAU * f * t) * Math.exp(-t * 8) * 0.9;
    }
    // tss
    const tssAt = Math.round(0.3 * rate);
    let hp = 0;
    for (let i = 0; i < out.length - tssAt; i += 1) {
      const t = i / rate;
      const n = rnd();
      hp = n - hp * 0.2;
      out[tssAt + i] += hp * Math.exp(-t * 5) * 0.5;
    }
    highpass(out, rate, 220);
    return out;
  });

  // --- Cartoon and effects -------------------------------------------------

  pad('boing', 'Boing', 'effects', 1.1, (rate) => {
    const out = buffer(rate, 1.1);
    let phase = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const wobble = Math.sin(TAU * 13 * t) * 0.35 * Math.exp(-t * 3);
      const f = 180 + 420 * Math.exp(-t * 4) + wobble * 260;
      phase += f / rate;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 3.4);
      out[i] = (Math.sin(TAU * phase) + 0.3 * Math.sin(TAU * phase * 2)) * env;
    }
    return out;
  });

  pad('slidewhistle', 'Slide whistle', 'effects', 1.9, (rate) => {
    const out = buffer(rate, 1.9);
    const rnd = noise(47);
    let phase = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const up = Math.min(1, t / 0.75);
      const f = t < 0.85 ? 420 + 1180 * up : 1600 - 1250 * Math.min(1, (t - 0.85) / 0.85);
      phase += (f * (1 + Math.sin(TAU * 6.5 * t) * 0.006)) / rate;
      const env = Math.min(1, t / 0.05) * Math.min(1, (1.9 - t) / 0.25);
      out[i] = (Math.sin(TAU * phase) * 0.85 + rnd() * 0.05) * env;
    }
    return out;
  });

  pad('pop', 'Pop', 'effects', 0.3, (rate) => {
    const out = buffer(rate, 0.3);
    let phase = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const f = 60 + 1200 * Math.exp(-t * 55);
      phase += f / rate;
      out[i] = Math.sin(TAU * phase) * Math.exp(-t * 22);
    }
    return out;
  });

  pad('whoosh', 'Whoosh', 'effects', 1.1, (rate) => {
    const out = buffer(rate, 1.1);
    const rnd = noise(59);
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const pos = t / 1.1;
      const hz = 260 + 2600 * Math.sin(Math.PI * Math.min(1, pos * 1.05));
      const k = 1 - Math.exp((-TAU * hz) / rate);
      b1 += (rnd() - b1) * k;
      b2 += (b1 - b2) * k;
      const env = Math.sin(Math.PI * pos) ** 1.6;
      out[i] = (b1 - b2 * 0.4) * env * 2.2;
    }
    return out;
  });

  pad('scratch', 'Record scratch', 'effects', 0.9, (rate) => {
    const out = buffer(rate, 0.9);
    const rnd = noise(71);
    let phase = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const strokes = Math.sin(TAU * 4.2 * t);
      const f = 320 + 900 * Math.abs(strokes);
      phase += f / rate;
      const env = Math.min(1, t / 0.01) * Math.min(1, (0.9 - t) / 0.15) * (0.35 + 0.65 * Math.abs(strokes));
      out[i] = (saw(phase) * 0.6 + rnd() * 0.4) * env;
    }
    highpass(out, rate, 300);
    lowpass(out, rate, 4200);
    return out;
  });

  pad('explosion', 'Explosion', 'effects', 2.0, (rate) => {
    const out = buffer(rate, 2.0);
    const rnd = noise(83);
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const k = 0.045 + 0.5 * Math.exp(-t * 2.2);
      lp += (rnd() - lp) * k;
      out[i] = lp * Math.exp(-t * 2.4) * 2.6 + Math.sin(TAU * 42 * t) * Math.exp(-t * 3.4) * 0.7;
    }
    return out;
  });

  pad('coin', 'Coin', 'effects', 0.6, (rate) => {
    const out = buffer(rate, 0.6);
    const parts = [
      [988, 0, 0.09, 0.5],
      [1319, 0.085, 0.5, 0.6],
    ];
    for (const [hz, at, dur, level] of parts) {
      const from = Math.round(at * rate);
      const len = Math.round(dur * rate);
      for (let i = 0; i < len && from + i < out.length; i += 1) {
        const t = i / rate;
        const env = Math.min(1, t / 0.004) * Math.exp(-t * (dur > 0.2 ? 6 : 30));
        out[from + i] += (square(TAU * hz * t / TAU) * 0.35 + Math.sin(TAU * hz * t) * 0.65) * env * level;
      }
    }
    lowpass(out, rate, 6000);
    return out;
  });

  pad('crickets', 'Crickets', 'effects', 3.0, (rate) => {
    const out = buffer(rate, 3.0);
    const rnd = noise(97);
    for (let burst = 0; burst < 4; burst += 1) {
      const at = burst * 0.72 + rnd() * 0.04;
      for (let chirp = 0; chirp < 4; chirp += 1) {
        const from = Math.round((at + chirp * 0.055) * rate);
        const len = Math.round(0.026 * rate);
        for (let i = 0; i < len && from + i < out.length; i += 1) {
          const t = i / rate;
          const env = Math.sin((Math.PI * i) / len);
          out[from + i] += Math.sin(TAU * 4400 * t) * env * 0.22;
        }
      }
    }
    return out;
  });

  pad('applause', 'Applause', 'effects', 2.4, (rate) => {
    const out = buffer(rate, 2.4);
    const rnd = noise(103);
    for (let clap = 0; clap < 220; clap += 1) {
      const at = Math.pow(rnd() * 0.5 + 0.5, 0.6) * 1.9 + 0.05;
      const from = Math.round(at * rate);
      const len = Math.round((0.02 + Math.random() * 0.02) * rate);
      const level = 0.16 + Math.random() * 0.2;
      for (let i = 0; i < len && from + i < out.length; i += 1) {
        const t = i / rate;
        out[from + i] += rnd() * Math.exp(-t * 190) * level;
      }
    }
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      out[i] *= Math.min(1, t / 0.25) * Math.min(1, (2.4 - t) / 0.6);
    }
    highpass(out, rate, 600);
    lowpass(out, rate, 7000);
    return out;
  });

  pad('drumroll', 'Drum roll', 'effects', 2.2, (rate) => {
    const out = buffer(rate, 2.2);
    const rnd = noise(109);
    let t = 0.05;
    while (t < 1.95) {
      const from = Math.round(t * rate);
      const len = Math.round(0.09 * rate);
      const strength = Math.min(1, 0.35 + t / 1.4) * (0.8 + Math.random() * 0.3);
      for (let i = 0; i < len && from + i < out.length; i += 1) {
        const tt = i / rate;
        const env = Math.exp(-tt * 38);
        out[from + i] += (rnd() * 0.7 + Math.sin(TAU * 190 * tt) * 0.5) * env * strength;
      }
      t += 0.042 + Math.random() * 0.012;
    }
    lowpass(out, rate, 5200);
    return out;
  });

  // --- Body ----------------------------------------------------------------

  pad('fart', 'Fart', 'body', 1.3, (rate) => {
    const out = buffer(rate, 1.3);
    const rnd = noise(127);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const wobble = 1 + Math.sin(TAU * 17 * t) * 0.22 + rnd() * 0.03;
      const f = (88 - 26 * Math.min(1, t / 1.1)) * wobble;
      phase += f / rate;
      const env = Math.min(1, t / 0.02) * Math.exp(-t * 1.6) * (0.65 + 0.35 * Math.sin(TAU * 9 * t));
      const source = saw(phase) * 0.7 + rnd() * 0.3;
      lp += (source - lp) * 0.12;
      out[i] = lp * env * 1.3;
    }
    lowpass(out, rate, 900);
    return out;
  });

  pad('burp', 'Burp', 'body', 1.1, (rate) => {
    const out = buffer(rate, 1.1);
    const rnd = noise(131);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const f = 62 + 20 * Math.exp(-t * 3) + Math.sin(TAU * 24 * t) * 4;
      phase += f / rate;
      const env = Math.min(1, t / 0.04) * Math.exp(-t * 2.2);
      let source = saw(phase) * 0.85 + rnd() * 0.15;
      source += saw(phase * 2.02) * 0.2;
      lp += (source - lp) * 0.18;
      const form = Math.sin(TAU * 430 * t) * 0.3;
      out[i] = (lp + form * lp) * env;
    }
    lowpass(out, rate, 1400);
    return out;
  });

  pad('snore', 'Snore', 'body', 3.0, (rate) => {
    const out = buffer(rate, 3.0);
    const rnd = noise(137);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      // Inhale: filtered noise rising, then the raspy exhale.
      const inhale = t < 1.35 ? Math.sin((Math.PI * t) / 1.35) : 0;
      const exhale = t > 1.5 ? Math.sin((Math.PI * (t - 1.5)) / 1.3) : 0;
      const n = rnd();
      lp += (n - lp) * (t > 1.5 ? 0.09 : 0.22);
      phase += (48 + 14 * Math.sin(TAU * 2.2 * t)) / rate;
      const rasp = saw(phase) * 0.5 + lp * 1.2;
      out[i] = rasp * (inhale * 0.5 + exhale * 1.1);
    }
    lowpass(out, rate, 1200);
    return out;
  });

  // --- Animals -------------------------------------------------------------

  function animalCall(rate, seconds, plan, formants) {
    const out = buffer(rate, seconds);
    const rnd = noise(149);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const planPoint = plan(t);
      const f = planPoint.f;
      phase += (f * (1 + rnd() * 0.01)) / rate;
      const env = planPoint.env;
      const source = saw(phase) * 0.8 + rnd() * planPoint.noise;
      lp += (source - lp) * 0.3;
      let shaped = lp;
      for (const [hz, gain] of formants) {
        shaped += Math.sin(TAU * hz * t) * lp * gain;
      }
      out[i] = shaped * env;
    }
    lowpass(out, rate, 4800);
    return out;
  }

  pad('duck', 'Duck', 'animals', 0.7, (rate) =>
    animalCall(
      rate,
      0.7,
      (t) => {
        const quacks = t < 0.3 ? Math.exp(-((t - 0.12) ** 2) / 0.002) : 0;
        return { f: 190, env: quacks, noise: 0.15 };
      },
      [
        [850, 0.5],
        [1500, 0.25],
      ],
    ),
  );

  pad('cat', 'Cat meow', 'animals', 1.0, (rate) =>
    animalCall(
      rate,
      1.0,
      (t) => {
        const env = Math.sin((Math.PI * t) / 1.0) ** 0.7;
        const f = 420 + 260 * Math.sin(Math.PI * Math.min(1, t / 0.8)) - 90 * Math.max(0, t - 0.7);
        return { f, env, noise: 0.05 };
      },
      [
        [720, 0.6],
        [1900, 0.2],
      ],
    ),
  );

  pad('dog', 'Dog bark', 'animals', 0.8, (rate) =>
    animalCall(
      rate,
      0.8,
      (t) => {
        const a = t < 0.36 ? Math.exp(-((t - 0.1) ** 2) / 0.006) : 0;
        const b = t > 0.42 ? Math.exp(-((t - 0.58) ** 2) / 0.006) : 0;
        return { f: 240, env: Math.max(a, b), noise: 0.55 };
      },
      [
        [520, 0.5],
        [1300, 0.2],
      ],
    ),
  );

  pad('goose', 'Goose', 'animals', 0.9, (rate) =>
    animalCall(
      rate,
      0.9,
      (t) => {
        const a = t < 0.34 ? Math.exp(-((t - 0.14) ** 2) / 0.008) : 0;
        const b = t > 0.44 ? Math.exp(-((t - 0.62) ** 2) / 0.01) : 0;
        return { f: 340, env: Math.max(a, b), noise: 0.3 };
      },
      [
        [900, 0.7],
        [2100, 0.15],
      ],
    ),
  );

  pad('monkey', 'Monkey', 'animals', 1.6, (rate) =>
    animalCall(
      rate,
      1.6,
      (t) => {
        const notes = [0.1, 0.3, 0.55, 0.8, 1.05];
        let env = 0;
        for (const [index, at] of notes.entries()) {
          const width = 0.007 + index * 0.0006;
          env = Math.max(env, Math.exp(-((t - at) ** 2) / width));
        }
        const f = 330 + 220 * Math.min(1, t / 1.2);
        return { f, env, noise: 0.2 };
      },
      [
        [520, 0.7],
        [1150, 0.3],
      ],
    ),
  );

  // --- Alerts --------------------------------------------------------------

  pad('buzzer', 'Wrong buzzer', 'alerts', 1.0, (rate) => {
    const out = buffer(rate, 1.0);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const gate = t < 0.42 || (t > 0.5 && t < 0.92) ? 1 : 0;
      const buzz = (saw(TAU * 118 * t / TAU) + saw(TAU * 121 * t / TAU) * 0.6) * 0.5;
      out[i] = soft(buzz * 2.6, 2.4) * gate * Math.min(1, t / 0.01);
    }
    lowpass(out, rate, 2600);
    return out;
  });

  pad('ding', 'Ding', 'alerts', 1.4, (rate) =>
    normalize(
      bell(rate, 1.4, [
        [1318, 1, 0.55],
        [1976, 0.5, 0.3],
        [2637, 0.28, 0.18],
        [3951, 0.12, 0.09],
      ]),
    ),
  );

  pad('alarm', 'Alarm clock', 'alerts', 1.8, (rate) => {
    const out = buffer(rate, 1.8);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const pulse = Math.sin(TAU * 9 * t) > 0 ? 1 : 0;
      const hz = Math.floor(t / 0.1) % 2 ? 1046 : 784;
      out[i] = square(TAU * hz * t / TAU) * pulse * 0.5;
    }
    lowpass(out, rate, 3200);
    return out;
  });

  pad('telephone', 'Telephone', 'alerts', 2.4, (rate) => {
    const out = buffer(rate, 2.4);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const on = (t > 0.05 && t < 0.5) || (t > 0.72 && t < 1.15) || (t > 1.6 && t < 2.1);
      if (!on) continue;
      const mod = 0.5 + 0.5 * Math.sin(TAU * 20 * t);
      out[i] = (Math.sin(TAU * 440 * t) + Math.sin(TAU * 480 * t)) * 0.4 * mod;
    }
    lowpass(out, rate, 2400);
    return out;
  });

  pad('error', 'Error chord', 'alerts', 1.5, (rate) => {
    const out = buffer(rate, 1.5);
    const notes = [196, 262, 277, 392];
    for (const hz of notes) {
      for (let i = 0; i < out.length; i += 1) {
        const t = i / rate;
        const env = Math.min(1, t / 0.01) * Math.exp(-t * 2.4);
        out[i] += (Math.sin(TAU * hz * t) + Math.sin(TAU * hz * 1.004 * t) * 0.5) * env * 0.22;
      }
    }
    lowpass(out, rate, 3000);
    return out;
  });

  // --- Voices --------------------------------------------------------------

  pad('bruh', 'Bruh', 'voices', 0.9, (rate) => {
    const out = buffer(rate, 0.9);
    const rnd = noise(151);
    const segments = [
      { at: 0, dur: 0.07, vowel: 'm', from: 108, to: 104, gain: 0.5 },
      { at: 0.07, dur: 0.16, vowel: 'r', from: 106, to: 100, gain: 1 },
      { at: 0.23, dur: 0.45, vowel: 'uh', from: 100, to: 82, gain: 1 },
    ];
    return formantLine(out, rate, segments, rnd, { breath: 0.02 });
  });

  pad('hello', 'Hello?', 'voices', 1.0, (rate) => {
    const out = buffer(rate, 1.0);
    const rnd = noise(157);
    const segments = [
      { at: 0, dur: 0.12, vowel: 'e', from: 170, to: 165, gain: 0.6 },
      { at: 0.12, dur: 0.12, vowel: 'l', from: 165, to: 160, gain: 0.5 },
      { at: 0.24, dur: 0.42, vowel: 'o', from: 160, to: 190, gain: 1 },
      { at: 0.68, dur: 0.2, vowel: 'u', from: 190, to: 150, gain: 0.6 },
    ];
    return formantLine(out, rate, segments, rnd, { breath: 0.03 });
  });

  pad('evil_laugh', 'Evil laugh', 'voices', 1.9, (rate) => {
    const out = buffer(rate, 1.9);
    const rnd = noise(163);
    const segments = [];
    for (let i = 0; i < 5; i += 1) {
      segments.push({
        at: 0.1 + i * 0.33,
        dur: 0.22,
        vowel: i % 2 ? 'a' : 'uh',
        from: 135 - i * 8,
        to: 118 - i * 8,
        gain: 1 - i * 0.12,
      });
    }
    return formantLine(out, rate, segments, rnd, { breath: 0.04, rasp: 0.05 });
  });

  pad('giggle', 'Giggle', 'voices', 1.4, (rate) => {
    const out = buffer(rate, 1.4);
    const rnd = noise(167);
    const segments = [];
    for (let i = 0; i < 7; i += 1) {
      segments.push({
        at: 0.05 + i * 0.17,
        dur: 0.11,
        vowel: i % 2 ? 'e' : 'i',
        from: 250 + i * 12,
        to: 230 + i * 12,
        gain: 0.9 - i * 0.07,
      });
    }
    return formantLine(out, rate, segments, rnd, { breath: 0.05 });
  });

  pad('scream', 'Scream', 'voices', 1.1, (rate) => {
    const out = buffer(rate, 1.1);
    const rnd = noise(173);
    const segments = [{ at: 0, dur: 1.1, vowel: 'a', from: 780, to: 640, gain: 1 }];
    formantLine(out, rate, segments, rnd, { breath: 0.25 });
    for (let i = 0; i < out.length; i += 1) {
      const t = i / rate;
      const env = Math.min(1, t / 0.06) * Math.min(1, (1.1 - t) / 0.3);
      out[i] = soft(out[i] * env * 1.4, 1.8) * (0.8 + 0.2 * Math.sin(TAU * 7 * t));
    }
    return out;
  });

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const list = DEFS.map((def, index) => ({
    index,
    id: def.id,
    name: def.name,
    group: def.group,
    seconds: def.seconds,
  }));

  const cache = new Map();

  function render(id, rate = 48000) {
    const key = `${id}@${rate}`;
    if (cache.has(key)) return cache.get(key);
    const def = DEFS.find((item) => item.id === id);
    if (!def) return null;
    let data = def.build(rate);
    if (!data || !data.length) return null;
    data = fade(data, rate, 4, 24);
    normalize(data);
    cache.set(key, data);
    return data;
  }

  // Render everything, one pad per task, so the interface stays responsive
  // while the bank is built the first time the Voice view is opened.
  async function renderAll(rate, onProgress) {
    const out = [];
    for (const def of DEFS) {
      out.push(render(def.id, rate));
      onProgress?.(out.length, DEFS.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return out;
  }

  window.VoxBridgeSoundbank = { list, render, renderAll };
})();
