/**
 * Tiny sample-by-sample DSP helpers used to BAKE textures into AudioBuffers at init
 * (wind, city wash, crowd babble, machinery, HVAC, hammer/drill grains, impulse responses).
 * Baking once and looping a buffer is far cheaper than dozens of live biquads and lets the
 * textures have real temporal structure (grains, pass-bys, syllables) instead of steady hiss.
 */

/** RBJ biquad (Audio EQ Cookbook). */
export class Biquad {
  constructor(type = 'lowpass', sampleRate = 48000) {
    this.sr = sampleRate;
    this.type = type;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
    this.set(1000, 0.707, 0);
  }
  set(freq, Q = 0.707, gainDb = 0) {
    const sr = this.sr;
    freq = Math.max(10, Math.min(sr * 0.45, freq));
    const w0 = (2 * Math.PI * freq) / sr;
    const cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * Math.max(0.05, Q));
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'highpass':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'bandpass': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'notch':
        b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'peaking': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      }
      default: // lowpass
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  /** Transposed direct form II. */
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

/** One-pole smoother / lowpass: y += (x - y) * k. */
export class OnePole {
  constructor(k = 0.01) { this.k = k; this.y = 0; }
  process(x) { this.y += (x - this.y) * this.k; return this.y; }
}

/** Smooth random walk in [lo, hi]: new target every `hold` seconds, exponential glide. */
export class Wander {
  constructor(rng, lo, hi, holdSeconds, sampleRate, glide = 0.35) {
    this.rng = rng; this.lo = lo; this.hi = hi;
    this.holdN = Math.max(1, Math.floor(holdSeconds * sampleRate));
    this.k = 1 - Math.exp(-1 / (glide * sampleRate));
    this.target = lo + (hi - lo) * rng();
    this.value = this.target;
    this.n = Math.floor(this.holdN * rng());
  }
  next() {
    if (--this.n <= 0) { this.n = Math.floor(this.holdN * (0.5 + this.rng())); this.target = this.lo + (this.hi - this.lo) * this.rng(); }
    this.value += (this.target - this.value) * this.k;
    return this.value;
  }
}

/** Pink noise generator (Paul Kellet). */
export class Pink {
  constructor(rng) { this.rng = rng; this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0; }
  next() {
    const w = this.rng() * 2 - 1;
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362) * 0.11;
    this.b6 = w * 0.115926;
    return out;
  }
}

/** Hann window value for i in [0, n). */
export const hann = (i, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));

/** Peak-normalise all channels of an AudioBuffer to `peakTarget`. */
export function normalize(buf, peakTarget = 0.9) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0) {
    const g = peakTarget / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return buf;
}

/**
 * Make a seamless loop: cross-fade the tail of each channel INTO its head and drop the tail
 * (returns shorter arrays). The loop point then has continuous samples on both sides.
 */
export function seamlessLoop(channels, sampleRate, fadeSeconds = 0.25) {
  const n = channels[0].length;
  const fadeN = Math.min(Math.floor(sampleRate * fadeSeconds), Math.floor(n / 4));
  return channels.map((d) => {
    const out = new Float32Array(n - fadeN);
    out.set(d.subarray(0, n - fadeN));
    for (let i = 0; i < fadeN; i++) {
      const w = i / fadeN;
      out[i] = d[i] * w + d[n - fadeN + i] * (1 - w);
    }
    return out;
  });
}

/** Float32Array channels → AudioBuffer (any sample rate 8–96 kHz; the source node resamples). */
export function toBuffer(ctx, channels, sampleRate, peakTarget = 0.9) {
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return peakTarget > 0 ? normalize(buf, peakTarget) : buf;
}
