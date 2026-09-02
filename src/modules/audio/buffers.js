/**
 * Deterministic procedural sample buffers. Everything is generated from a seeded RNG so the
 * same seed produces the same textures — no downloaded audio is needed.
 *
 * Besides raw noise colours there are BAKED TEXTURES with real temporal structure, rendered once
 * at init with the sample-level DSP in dsp.js and then looped:
 *   windTexture  – pink noise through a wandering resonance with slow gust swells (16 kHz)
 *   cityWash     – ~90 overlapping distant pass-bys (doppler-swept band noise) + hum (16 kHz)
 *   babble       – a dozen formant-filtered pulse-train "voices" = distant crowd murmur (16 kHz)
 *   machinery    – industrial: mains hum + harmonics, compressor chuffs, clanks, steam (24 kHz)
 *   hvac         – rooftop fan: broadband + blade tone + hiss (16 kHz)
 *   hammer[4]    – construction impact grains, drill – pneumatic burst (24 kHz)
 *   outdoorIR    – short bright early-reflection response for birds / street sounds
 *   impulse      – city-scale reverb tail for sirens/horns
 * Textures are baked at reduced sample rates where their content allows (the source node
 * resamples), keeping the whole set well under 100 ms on Apple Silicon.
 */
import { Biquad, Pink, Wander, hann, normalize, seamlessLoop, toBuffer } from './dsp.js';
import { setVal } from './params.js';

/** Stereo white noise, decorrelated channels. */
export function makeWhiteNoise(ctx, rng, seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  }
  return buf;
}

/** Stereo pink noise (Paul Kellet's refined -3 dB/oct filter). */
export function makePinkNoise(ctx, rng, seconds = 4) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const p = new Pink(rng);
    for (let i = 0; i < n; i++) d[i] = p.next();
  }
  return normalize(buf, 0.9);
}

/** Stereo brown (red) noise — leaky integrator of white noise. Deep rumble base for wind/traffic/thunder. */
export function makeBrownNoise(ctx, rng, seconds = 4) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) { const x = d[i]; hp = 0.995 * (hp + x - prev); prev = x; d[i] = hp; }
  }
  return normalize(buf, 0.9);
}

/** Rain on surfaces: sparse plips of decaying sine + noise bursts at random frequencies and pans. Loopable. */
export function makeRainDrops(ctx, rng, seconds = 8, dropsPerSecond = 28) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const count = Math.floor(seconds * dropsPerSecond);
  for (let k = 0; k < count; k++) {
    const start = Math.floor(rng() * n);
    const f = 1200 + rng() * 5200;
    const dur = 0.006 + rng() * 0.022;
    const len = Math.floor(dur * sr);
    const amp = 0.25 + rng() * 0.75;
    const pan = rng();
    const gl = Math.cos(pan * Math.PI / 2) * amp, gr = Math.sin(pan * Math.PI / 2) * amp;
    const noiseMix = rng() * 0.5;
    const phase = rng() * Math.PI * 2;
    for (let i = 0; i < len; i++) {
      const idx = (start + i) % n;
      const t = i / sr;
      const env = Math.exp(-t / (dur * 0.35)) * Math.min(1, i / 24);
      const s = (Math.sin(phase + 2 * Math.PI * f * t * (1 + 0.6 * t / dur)) * (1 - noiseMix) + (rng() * 2 - 1) * noiseMix) * env;
      L[idx] += s * gl;
      R[idx] += s * gr;
    }
  }
  return normalize(buf, 0.8);
}

/** City-scale reverb impulse: decaying noise whose brightness fades (air absorption) + sparse early reflections. */
export function makeImpulseResponse(ctx, rng, seconds = 2.6, decay = 3.2) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const w = rng() * 2 - 1;
      const a = 0.2 + 0.72 * Math.min(1, t / seconds);
      lp = lp * a + w * (1 - a);
      d[i] = lp * Math.exp(-decay * t) * (t < 0.008 ? t / 0.008 : 1);
    }
    for (let r = 0; r < 6; r++) {
      const at = Math.floor((0.012 + rng() * 0.07) * sr);
      const g = (0.25 + rng() * 0.35) * (rng() < 0.5 ? -1 : 1);
      for (let i = 0; i < 64 && at + i < n; i++) d[at + i] += g * (rng() * 2 - 1) * (1 - i / 64);
    }
  }
  return normalize(buf, 0.6);
}

/**
 * Outdoor "space" for small sources (birds, dogs, hammers): a handful of discrete early
 * reflections off facades/trees (5–60 ms) and a short, bright, fast-decaying diffuse tail.
 */
export function makeOutdoorIR(ctx, rng, seconds = 0.7) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // direct-less: the dry signal is mixed separately, so no spike at 0
    for (let r = 0; r < 9; r++) {
      const at = Math.floor((0.006 + rng() * 0.055) * sr);
      const g = (0.18 + rng() * 0.32) * (rng() < 0.5 ? -1 : 1) * (1 - r / 12);
      const len = 40 + Math.floor(rng() * 90);
      const lp = new Biquad('lowpass', sr).set(2500 + rng() * 4000, 0.7);
      for (let i = 0; i < len && at + i < n; i++) d[at + i] += lp.process((rng() * 2 - 1) * g) * (1 - i / len);
    }
    const lp = new Biquad('lowpass', sr).set(5200, 0.6);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const tail = t < 0.015 ? 0 : Math.exp(-9.5 * t) * 0.35;
      d[i] += lp.process((rng() * 2 - 1)) * tail;
    }
  }
  return normalize(buf, 0.5);
}

// ------------------------------------------------------------------------------------ baked textures

/** Wind body: pink noise through a wandering resonant lowpass with slow gust swells. 16 kHz, ~14 s. */
export function makeWindTexture(ctx, rng, seconds = 14) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const gust = new Wander(rng, 0.35, 1.0, 3.5, sr, 1.2);     // shared swell
  const cut = [new Wander(rng, 140, 720, 2.2, sr, 0.6), new Wander(rng, 140, 720, 2.6, sr, 0.6)];
  const pink = [new Pink(rng), new Pink(rng)];
  const lp = [new Biquad('lowpass', sr), new Biquad('lowpass', sr)];
  const hp = [new Biquad('highpass', sr).set(60, 0.6), new Biquad('highpass', sr).set(60, 0.6)];
  for (let i = 0; i < n; i++) {
    const g = gust.next();
    for (let c = 0; c < 2; c++) {
      if ((i & 63) === 0) lp[c].set(cut[c].next() * (0.7 + 0.5 * g), 1.25);
      else cut[c].next();
      const x = pink[c].next();
      chans[c][i] = hp[c].process(lp[c].process(x)) * (0.45 + 0.55 * g * g);
    }
  }
  return toBuffer(ctx, seamlessLoop(chans, sr, 0.4), sr, 0.9);
}

/**
 * City wash: many overlapping distant vehicle pass-bys — each a Hann-shaped burst of pink noise
 * through a bandpass that sweeps down (doppler + tyre spectrum) with its own pan — plus a low hum.
 * The result has the restless, granular "sea of traffic" quality of a real city heard from a rooftop.
 */
export function makeCityWash(ctx, rng, seconds = 10, grains = 60) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const pink = new Pink(rng);
  for (let k = 0; k < grains; k++) {
    const dur = 1.0 + rng() * 2.6;
    const len = Math.floor(dur * sr);
    const start = Math.floor(rng() * n);
    const f0 = 700 + rng() * 1100, f1 = f0 * (0.45 + rng() * 0.2);
    const amp = 0.25 + rng() * 0.75;
    const pan = rng();
    const gl = Math.cos(pan * Math.PI / 2) * amp, gr = Math.sin(pan * Math.PI / 2) * amp;
    const bp = new Biquad('bandpass', sr);
    for (let i = 0; i < len; i++) {
      const u = i / len;
      if ((i & 127) === 0) bp.set(f0 * Math.pow(f1 / f0, u), 1.1);
      const s = bp.process(pink.next()) * hann(i, len);
      const idx = (start + i) % n;
      chans[0][idx] += s * gl; chans[1][idx] += s * gr;
    }
  }
  // steady low hum bed (HVAC, distant engines) so the wash never drops to silence
  const hum = [new Biquad('lowpass', sr).set(180, 0.8), new Biquad('lowpass', sr).set(180, 0.8)];
  let peak = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) peak = Math.max(peak, Math.abs(chans[c][i]));
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) chans[c][i] += hum[c].process(pink.next()) * peak * 0.22;
  return toBuffer(ctx, seamlessLoop(chans, sr, 0.5), sr, 0.9);
}

/**
 * Crowd babble: voices are sawtooth pulse trains (100–230 Hz, wandering) through two formant
 * bandpasses whose centres jump every syllable, gated by syllable envelopes with pauses.
 * A dozen of them, panned, lowpassed = the unintelligible murmur of a busy street.
 */
export function makeBabble(ctx, rng, seconds = 9, voices = 12) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const VOWELS = [[730, 1090], [270, 2290], [300, 870], [530, 1840], [640, 1190], [440, 1020], [390, 1990]];
  for (let v = 0; v < voices; v++) {
    const f0Base = 95 + rng() * 140;
    const pan = rng();
    const gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
    const level = 0.35 + rng() * 0.65;
    const f1 = new Biquad('bandpass', sr), f2 = new Biquad('bandpass', sr);
    const lp = new Biquad('lowpass', sr).set(3200, 0.7);
    let phase = 0, i = 0;
    while (i < n) {
      // a phrase: 3–9 syllables, then a pause
      const syllables = 3 + Math.floor(rng() * 7);
      for (let s = 0; s < syllables && i < n; s++) {
        const len = Math.floor((0.08 + rng() * 0.16) * sr);
        const vw = VOWELS[Math.floor(rng() * VOWELS.length)];
        f1.set(vw[0] * (0.9 + rng() * 0.2), 5); f2.set(vw[1] * (0.9 + rng() * 0.2), 7);
        const f0 = f0Base * (0.85 + rng() * 0.35);
        const slide = (rng() - 0.5) * 0.25;
        const amp = level * (0.6 + rng() * 0.4);
        for (let k = 0; k < len && i < n; k++, i++) {
          const u = k / len;
          phase += (f0 * (1 + slide * u)) / sr;
          if (phase >= 1) phase -= 1;
          const saw = 2 * phase - 1;
          const env = Math.sin(Math.PI * u);           // syllable envelope
          const x = (f1.process(saw) * 0.7 + f2.process(saw) * 0.5 + saw * 0.05) * env * amp;
          const y = lp.process(x);
          chans[0][i] += y * gl; chans[1][i] += y * gr;
        }
        i += Math.floor((0.01 + rng() * 0.05) * sr);
      }
      i += Math.floor((0.25 + rng() * 1.6) * sr);
    }
  }
  return toBuffer(ctx, seamlessLoop(chans, sr, 0.4), sr, 0.9);
}

/** Industrial machinery loop: 50 Hz hum + harmonics with slow AM, compressor chuffs, metallic clanks, steam hiss. 24 kHz. */
export function makeMachinery(ctx, rng, seconds = 9) {
  const sr = 24000;
  const n = Math.floor(sr * seconds);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const pink = new Pink(rng);
  const humF = 49.5 + rng();
  // hum: one period of the harmonic series in a wavetable (6 partials), read with a phase accumulator
  const TABLE = 2048;
  const table = new Float32Array(TABLE);
  for (let i = 0; i < TABLE; i++) { const ph = (i / TABLE) * 2 * Math.PI; let h = 0; for (let k = 1; k <= 6; k++) h += Math.sin(ph * k + k * 0.7) / (k * k * 0.9); table[i] = h; }
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const am = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.37 * t) * Math.sin(2 * Math.PI * 0.11 * t + 1);
    const idx = phase * TABLE, i0 = idx | 0, fr = idx - i0;
    const h = table[i0 % TABLE] * (1 - fr) + table[(i0 + 1) % TABLE] * fr;
    phase += humF / sr; if (phase >= 1) phase -= 1;
    const s = h * 0.22 * am;
    chans[0][i] += s; chans[1][i] += s * 0.9;
  }
  // compressor / press chuffs every ~0.62 s
  const chuffLP = new Biquad('lowpass', sr).set(420, 0.9);
  const period = 0.55 + rng() * 0.2;
  for (let t0 = rng() * period; t0 < seconds; t0 += period) {
    const start = Math.floor(t0 * sr), len = Math.floor(0.14 * sr);
    const pan = 0.3 + rng() * 0.4, gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp(-i / (len * 0.25)) * Math.min(1, i / 60);
      const s = chuffLP.process(pink.next()) * env * 0.9;
      chans[0][start + i] += s * gl; chans[1][start + i] += s * gr;
    }
  }
  // clanks: inharmonic partials, sparse
  const clanks = Math.floor(seconds * 0.7);
  for (let k = 0; k < clanks; k++) {
    const start = Math.floor(rng() * n);
    const base = 380 + rng() * 900;
    const ratios = [1, 1.47, 2.09, 2.56, 3.31, 4.2];
    const dur = 0.25 + rng() * 0.45, len = Math.floor(dur * sr);
    const amp = 0.25 + rng() * 0.45;
    const pan = rng(), gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      let s = 0;
      for (let r = 0; r < ratios.length; r++) s += Math.sin(2 * Math.PI * base * ratios[r] * t) * Math.exp(-t * (6 + r * 4)) / (1 + r * 0.6);
      s *= amp * Math.min(1, i / 30);
      if (i < 200) s += (rng() * 2 - 1) * amp * 0.6 * (1 - i / 200); // strike transient
      chans[0][start + i] += s * gl; chans[1][start + i] += s * gr;
    }
  }
  // steam hiss bursts
  const hissBP = new Biquad('bandpass', sr).set(3800, 0.8);
  for (let k = 0; k < Math.floor(seconds * 0.35); k++) {
    const start = Math.floor(rng() * n), len = Math.floor((0.5 + rng() * 1.2) * sr);
    const pan = rng(), gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
    for (let i = 0; i < len && start + i < n; i++) {
      const s = hissBP.process(rng() * 2 - 1) * hann(i, len) * 0.35;
      chans[0][start + i] += s * gl; chans[1][start + i] += s * gr;
    }
  }
  return toBuffer(ctx, seamlessLoop(chans, sr, 0.3), sr, 0.9);
}

/** Rooftop HVAC: broadband fan (pink through a broad bandpass) + blade-pass tone with wobble + faint hiss. 16 kHz. */
export function makeHvac(ctx, rng, seconds = 8) {
  const sr = 16000;
  const n = Math.floor(sr * seconds);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const pink = [new Pink(rng), new Pink(rng)];
  const bp = [new Biquad('bandpass', sr).set(260, 0.7), new Biquad('bandpass', sr).set(260, 0.7)];
  const hiss = [new Biquad('highpass', sr).set(2200, 0.6), new Biquad('highpass', sr).set(2200, 0.6)];
  const blade = 170 + rng() * 60;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wob = 1 + 0.004 * Math.sin(2 * Math.PI * 0.8 * t);
    const tone = (Math.sin(2 * Math.PI * blade * wob * t) + 0.4 * Math.sin(2 * Math.PI * blade * 2 * wob * t)) * 0.12;
    for (let c = 0; c < 2; c++) {
      const p = pink[c].next();
      chans[c][i] = bp[c].process(p) * 0.9 + hiss[c].process(p) * 0.08 + tone * (c ? 0.9 : 1);
    }
  }
  return toBuffer(ctx, seamlessLoop(chans, sr, 0.3), sr, 0.9);
}

/** Hammer impact grain: noise transient + wood/metal resonances. Several variants. 24 kHz, 0.35 s. */
export function makeHammer(ctx, rng, variant = 0) {
  const sr = 24000;
  const n = Math.floor(sr * 0.35);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const metal = variant % 2 === 1;
  const modes = metal ? [[1450, 7], [2380, 9], [3900, 12], [620, 5]] : [[420, 18], [760, 22], [1180, 30], [2100, 40]];
  const lp = new Biquad('lowpass', sr).set(metal ? 6000 : 3200, 0.8);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = lp.process(rng() * 2 - 1) * Math.exp(-t * 90) * 1.2;   // transient
    for (const [f, k] of modes) s += Math.sin(2 * Math.PI * f * (1 + 0.02 * variant) * t) * Math.exp(-t * k) * (metal ? 0.35 : 0.5);
    d[i] = s * Math.min(1, i / 8);
  }
  return normalize(buf, 0.9);
}

/** Pneumatic drill / jackhammer burst: ~13 Hz pulse train of bandpassed noise bursts. 24 kHz, 1.6 s. */
export function makeDrill(ctx, rng) {
  const sr = 24000;
  const n = Math.floor(sr * 1.6);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const bp = new Biquad('bandpass', sr).set(1500, 1.2);
  const lp = new Biquad('lowpass', sr).set(5000, 0.7);
  const rate = 12 + rng() * 3;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = (t * rate) % 1;
    const pulse = Math.exp(-ph * 14);
    const env = hann(i, n) * 1.4 > 1 ? 1 : hann(i, n) * 1.4;
    const s = lp.process(bp.process(rng() * 2 - 1) * pulse * 1.3 + (rng() * 2 - 1) * pulse * 0.25);
    d[i] = s * env + Math.sin(2 * Math.PI * 95 * t) * pulse * 0.25 * env;
  }
  return normalize(buf, 0.9);
}

/** Looping buffer source started at a seeded offset (decorrelates identical buffers). */
export function loopSource(ctx, buffer, rng, playbackRate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  setVal(src.playbackRate, playbackRate);
  src.start(0, rng() * buffer.duration);
  return src;
}

/** Bundle of all procedural buffers for a context. */
export function makeBufferSet(ctx, rng) {
  const t0 = performance.now();
  const set = {
    white: makeWhiteNoise(ctx, rng.fork(11), 2),
    pink: makePinkNoise(ctx, rng.fork(12), 4),
    brown: makeBrownNoise(ctx, rng.fork(13), 4),
    rainDrops: makeRainDrops(ctx, rng.fork(14), 8),
    impulse: makeImpulseResponse(ctx, rng.fork(15), 2.6),
    outdoorIR: makeOutdoorIR(ctx, rng.fork(16), 0.7),
    windTexture: makeWindTexture(ctx, rng.fork(21)),
    cityWash: makeCityWash(ctx, rng.fork(22)),
    babble: makeBabble(ctx, rng.fork(23)),
    machinery: makeMachinery(ctx, rng.fork(24)),
    hvac: makeHvac(ctx, rng.fork(25)),
    hammer: [0, 1, 2, 3].map((v) => makeHammer(ctx, rng.fork(30 + v), v)),
    drill: makeDrill(ctx, rng.fork(35)),
  };
  set.buildMs = performance.now() - t0;
  return set;
}
