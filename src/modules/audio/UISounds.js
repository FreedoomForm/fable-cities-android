/**
 * Synthesised UI feedback sounds — no samples. Every sound is a handful of oscillators/noise
 * bursts with tight envelopes, designed to read as a coherent "kit": soft glassy ticks for
 * hover/select, a wooden click, a satisfying thud+chime for placement, a crunchy bulldoze,
 * a two-note notification chime, an error buzz and a rising level-up arpeggio.
 */
import { loopSource } from './buffers.js';
import { cleanupAfter } from './layers.js';
import { setV, expRamp, linRamp, setVal } from './params.js';

export const UI_SOUND_NAMES = ['hover', 'click', 'toggle', 'select', 'place', 'road', 'zone', 'bulldoze', 'notification', 'warning', 'error', 'levelup', 'cash', 'open', 'close'];

/**
 * Spelling aliases so every name any module might emit maps onto the kit. ARCHITECTURE §4 lists
 * `notify` (this kit calls it `notification`); the rest are the synonyms UI/tools code tends to use.
 */
export const UI_SOUND_ALIASES = {
  notify: 'notification', notification: 'notification', info: 'notification', message: 'notification', beep: 'notification',
  warn: 'warning', alert: 'warning', caution: 'warning',
  fail: 'error', invalid: 'error', denied: 'error',
  success: 'levelup', upgrade: 'levelup', levelUp: 'levelup',
  money: 'cash', coin: 'cash', buy: 'cash', income: 'cash',
  demolish: 'bulldoze', delete: 'bulldoze', remove: 'bulldoze', destroy: 'bulldoze',
  build: 'place', plop: 'place', drop: 'place',
  tap: 'click', tick: 'click', ok: 'click', confirm: 'click',
  back: 'close', dismiss: 'close', menu: 'open', expand: 'open', collapse: 'close',
  switch: 'toggle', check: 'toggle', pick: 'select', highlight: 'hover',
  street: 'road', paint: 'zone',
};

/** Canonical kit name for any spelling, or null when nothing matches. */
export function resolveSoundName(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim();
  if (!k) return null;
  if (UI_SOUND_NAMES.includes(k)) return k;
  const lower = k.toLowerCase();
  return UI_SOUND_ALIASES[k] || UI_SOUND_ALIASES[lower] || (UI_SOUND_NAMES.includes(lower) ? lower : null);
}

const MIN_INTERVAL = { hover: 0.05, click: 0.06, toggle: 0.06, select: 0.06, place: 0.09, road: 0.12, zone: 0.07, bulldoze: 0.12, notification: 0.25, warning: 0.25, error: 0.2, levelup: 0.3, cash: 0.12, open: 0.15, close: 0.15 };

export class UISounds {
  constructor(ctx, dest, buffers, rng) {
    this.ctx = ctx;
    this.dest = dest;
    this.buffers = buffers;
    this.rng = rng;
    this.last = {};
    this.counts = {};
    this.lastPlayed = null;
    this.unknown = {};          // name → count, for getState() (never logged as a warning)
    // gentle high shelf so the kit sits behind the ambience without harshness
    this.shelf = ctx.createBiquadFilter(); this.shelf.type = 'highshelf'; setVal(this.shelf.frequency, 6000); setVal(this.shelf.gain, -3);
    this.trim = ctx.createGain(); setVal(this.trim.gain, 0.5); // kit level relative to the world mix
    this.shelf.connect(this.trim); this.trim.connect(dest);
  }

  /** Play a named sound (aliases resolved, see resolveSoundName). Returns false when unknown or rate-limited. */
  play(rawName, opts = {}) {
    const name = resolveSoundName(rawName);
    if (!name) {
      const key = typeof rawName === 'string' ? rawName.slice(0, 32) : String(rawName);
      this.unknown[key] = (this.unknown[key] || 0) + 1;
      return false;
    }
    const fn = this[`_${name}`];
    if (typeof fn !== 'function') return false;
    const t = this.ctx.currentTime;
    const min = MIN_INTERVAL[name] ?? 0.08;
    if (this.last[name] != null && t - this.last[name] < min) return false;
    this.last[name] = t;
    this.counts[name] = (this.counts[name] || 0) + 1;
    this.lastPlayed = { name, t };
    const gain = this.ctx.createGain();
    setVal(gain.gain, opts.gain ?? 1);
    gain.connect(this.shelf);
    const end = fn.call(this, t, gain, opts) || t + 1;
    cleanupAfter(this.ctx, end + 0.2, () => gain.disconnect());
    return true;
  }

  // ---- primitives ---------------------------------------------------------------
  tone(dest, t0, dur, f0, f1, type, amp, attack = 0.003, curve = 'exp') {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    setV(o.frequency, f0, t0);
    if (f1 !== f0) expRamp(o.frequency, Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    setV(g.gain, 0.0001, t0);
    expRamp(g.gain, amp, t0 + attack);
    if (curve === 'exp') expRamp(g.gain, 0.0001, t0 + dur);
    else { setV(g.gain, amp, t0 + dur - 0.02); linRamp(g.gain, 0, t0 + dur); }
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  noise(dest, t0, dur, amp, filterType, f0, f1, Q = 0.7, attack = 0.002) {
    const ctx = this.ctx;
    const src = loopSource(ctx, this.buffers.white, this.rng, 1);
    const f = ctx.createBiquadFilter(); f.type = filterType; setVal(f.Q, Q);
    setV(f.frequency, f0, t0);
    if (f1 !== f0) expRamp(f.frequency, Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    setV(g.gain, 0.0001, t0);
    expRamp(g.gain, amp, t0 + attack);
    expRamp(g.gain, 0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.stop(t0 + dur + 0.02);
  }

  // ---- kit ----------------------------------------------------------------------
  _hover(t, out) {
    this.tone(out, t, 0.035, 2600, 2300, 'sine', 0.07, 0.002);
    this.noise(out, t, 0.012, 0.03, 'highpass', 5000, 5000);
    return t + 0.05;
  }
  _select(t, out) {
    this.tone(out, t, 0.06, 1500, 1800, 'sine', 0.11, 0.003);
    this.tone(out, t + 0.03, 0.05, 2250, 2250, 'sine', 0.05, 0.003);
    return t + 0.1;
  }
  _click(t, out) {
    this.noise(out, t, 0.01, 0.35, 'bandpass', 2200, 1200, 1.5);   // wooden transient
    this.tone(out, t, 0.07, 880, 520, 'triangle', 0.22, 0.002);
    return t + 0.09;
  }
  _toggle(t, out) {
    this.tone(out, t, 0.05, 1200, 1500, 'sine', 0.14, 0.002);
    this.noise(out, t, 0.008, 0.2, 'highpass', 3000, 3000);
    return t + 0.07;
  }
  _open(t, out) {
    this.tone(out, t, 0.12, 620, 980, 'sine', 0.13, 0.01);
    this.noise(out, t, 0.06, 0.05, 'bandpass', 1800, 3200, 0.8);
    return t + 0.14;
  }
  _close(t, out) {
    this.tone(out, t, 0.12, 980, 560, 'sine', 0.13, 0.01);
    this.noise(out, t, 0.06, 0.05, 'bandpass', 3200, 1400, 0.8);
    return t + 0.14;
  }
  _place(t, out) {
    // thud (weight) + settle + confirm chime
    this.tone(out, t, 0.16, 150, 55, 'sine', 0.5, 0.004);
    this.noise(out, t, 0.05, 0.25, 'lowpass', 1500, 300, 0.7);
    this.tone(out, t + 0.05, 0.26, 1046, 1046, 'triangle', 0.13, 0.008);
    this.tone(out, t + 0.11, 0.3, 1568, 1568, 'triangle', 0.1, 0.008);
    return t + 0.45;
  }
  _road(t, out) {
    // asphalt slap: low thud + gravelly mid noise
    this.tone(out, t, 0.14, 120, 48, 'sine', 0.45, 0.004);
    this.noise(out, t, 0.18, 0.28, 'bandpass', 900, 400, 1.2, 0.004);
    this.noise(out, t + 0.02, 0.08, 0.12, 'highpass', 2500, 2500);
    return t + 0.25;
  }
  _zone(t, out) {
    // soft paint-brush swish
    this.noise(out, t, 0.11, 0.16, 'bandpass', 1200, 2600, 0.9, 0.02);
    this.tone(out, t, 0.08, 700, 900, 'sine', 0.05, 0.01);
    return t + 0.14;
  }
  _bulldoze(t, out) {
    // crunch: falling lowpass rumble + debris crackle + thud
    this.noise(out, t, 0.42, 0.5, 'lowpass', 900, 120, 0.8, 0.006);
    this.noise(out, t + 0.03, 0.25, 0.3, 'bandpass', 2600, 800, 2.5, 0.004);
    this.noise(out, t + 0.12, 0.18, 0.18, 'bandpass', 3200, 1500, 3, 0.004);
    this.tone(out, t, 0.2, 95, 40, 'sine', 0.55, 0.004);
    return t + 0.5;
  }
  _notification(t, out) {
    // two-note glassy chime E5 → A5 with soft tails
    this.tone(out, t, 0.5, 659.3, 659.3, 'sine', 0.16, 0.006);
    this.tone(out, t, 0.3, 1318.5, 1318.5, 'sine', 0.05, 0.006);
    this.tone(out, t + 0.16, 0.7, 880, 880, 'sine', 0.16, 0.006);
    this.tone(out, t + 0.16, 0.4, 1760, 1760, 'sine', 0.045, 0.006);
    return t + 0.9;
  }
  _warning(t, out) {
    this.tone(out, t, 0.32, 740, 740, 'triangle', 0.14, 0.006);
    this.tone(out, t + 0.2, 0.5, 622, 622, 'triangle', 0.14, 0.006);
    return t + 0.75;
  }
  _error(t, out) {
    this.tone(out, t, 0.11, 220, 200, 'square', 0.08, 0.004, 'lin');
    this.tone(out, t + 0.14, 0.16, 196, 170, 'square', 0.08, 0.004, 'lin');
    return t + 0.35;
  }
  _levelup(t, out) {
    const notes = [523.3, 659.3, 784, 1046.5];
    notes.forEach((f, i) => {
      this.tone(out, t + i * 0.085, 0.42, f, f, 'triangle', 0.13, 0.006);
      this.tone(out, t + i * 0.085, 0.25, f * 2, f * 2, 'sine', 0.04, 0.006);
    });
    this.noise(out, t + 0.3, 0.35, 0.05, 'highpass', 5000, 8000, 0.5, 0.05);
    return t + 0.9;
  }
  _cash(t, out) {
    // coin: two bright metallic partials
    this.tone(out, t, 0.28, 2093, 2093, 'sine', 0.12, 0.002);
    this.tone(out, t, 0.22, 3136, 3136, 'sine', 0.06, 0.002);
    this.tone(out, t + 0.07, 0.35, 2637, 2637, 'sine', 0.11, 0.002);
    return t + 0.45;
  }
}
