/**
 * AudioCore — owns the Web Audio context lifecycle and the master signal chain.
 *
 *   ambience bus ─┐
 *   sfx bus ──────┼─► compressor ─► weather muffle (lowpass) ─► master gain ─► analyser ─► destination
 *   ui bus ───────┘ (ui bypasses the muffle)          master gain ─► limiter ─► analyser ─► destination
 *
 * Autoplay policy: the AudioContext is only constructed (a) inside a user-gesture handler or
 * (b) after a silent <audio> probe proved that autoplay is allowed (headless screenshots, high
 * media-engagement users). Chrome logs a console warning when an AudioContext is created without
 * permission to start — this design never triggers it and never throws when autoplay is blocked.
 */

import { setT, setVal } from './params.js';
const STORAGE_KEY = 'fable.audio.settings';
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend', 'mousedown'];

/** 44-byte WAV header + 32 zero samples (mono 8 kHz 16-bit) as a data URI; used to probe autoplay silently. */
function silentWavURI() {
  const samples = 32;
  const bytes = new Uint8Array(44 + samples * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, samples * 2, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

/** Resolves true when the browser lets this page start audio without a gesture. Never logs, never throws. */
export function probeAutoplay() {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') return resolve(false);
      const el = document.createElement('audio');
      el.setAttribute('aria-hidden', 'true');
      el.preload = 'auto';
      el.src = silentWavURI();
      const p = el.play();
      if (!p || typeof p.then !== 'function') return resolve(false);
      const done = (ok) => { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) { /* ignore */ } resolve(ok); };
      p.then(() => done(true), () => done(false));
      setTimeout(() => done(false), 1500);
    } catch (_) {
      resolve(false);
    }
  });
}

export class AudioCore {
  constructor({ events, config }) {
    this.events = events;
    this.config = config;
    this.ctx = null;
    this.buses = null;
    this.analyser = null;
    /** idle | waiting (for gesture) | running | suspended | blocked | unsupported | closed */
    this.state = 'idle';
    this.unlocked = false;          // a gesture or probe allowed us to run
    this.userMutedByVisibility = false;
    this.settings = { master: 0.8, ambience: 1.0, sfx: 1.0, ui: 0.9, muted: false };
    this._onGraph = [];
    this._gestureHandler = null;
    this._visHandler = null;
    this._suspendTimer = 0;
    this.supported = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this._loadSettings();
  }

  // ---------------------------------------------------------------- lifecycle
  /** Install gesture listeners and (optionally) probe autoplay. Never rejects. */
  async start({ eager = true } = {}) {
    if (!this.supported) { this.state = 'unsupported'; return; }
    this.state = 'waiting';
    this._installGestureUnlock();
    this._installVisibility();
    if (eager) {
      const allowed = await probeAutoplay();
      if (allowed && !this.ctx) this._createContext();
      else if (!allowed) this.state = this.ctx ? this.state : 'waiting';
    }
  }

  /** Called from a user gesture (or when autoplay is known to be allowed). */
  unlock() {
    if (!this.supported) return;
    this.unlocked = true;
    if (!this.ctx) this._createContext();
    else this._resume();
  }

  /** Register a callback that builds nodes once the context exists (called immediately if it does). */
  onGraph(fn) {
    this._onGraph.push(fn);
    if (this.ctx) { try { fn(this.ctx, this.buses); } catch (err) { console.error('[audio] graph callback failed', err); } }
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  _createContext() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.unlocked = true;
      this.buses = buildMasterChain(ctx, ctx.destination);
      this.analyser = this.buses.analyser;
      this.applySettings(true);
      // build the mixer graph first so listeners of audio:state/audio:ready can play sounds immediately
      for (const fn of this._onGraph) {
        try { fn(ctx, this.buses); } catch (err) { console.error('[audio] graph callback failed', err); }
      }
      ctx.addEventListener('statechange', () => this._syncState());
      this._syncState();
      if (ctx.state !== 'running') this._resume();
      this.events?.emit('audio:ready', { sampleRate: ctx.sampleRate });
    } catch (err) {
      // Should not happen, but the game must never break because of audio.
      this.state = 'blocked';
      this.ctx = null;
      console.error('[audio] could not create AudioContext', err);
    }
  }

  _resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => { this.state = 'blocked'; });
    } catch (_) { this.state = 'blocked'; }
  }

  _syncState() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') { this.state = 'running'; this._removeGestureUnlock(); }
    else if (ctx.state === 'closed') this.state = 'closed';
    else this.state = this.unlocked && !this.userMutedByVisibility ? 'blocked' : 'suspended';
    this.events?.emit('audio:state', this.state);
  }

  _installGestureUnlock() {
    if (this._gestureHandler) return;
    this._gestureHandler = () => this.unlock();
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, this._gestureHandler, { capture: true, passive: true });
  }
  _removeGestureUnlock() {
    if (!this._gestureHandler) return;
    for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, this._gestureHandler, { capture: true });
    this._gestureHandler = null;
  }

  _installVisibility() {
    if (this._visHandler || typeof document === 'undefined') return;
    this._visHandler = () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this.userMutedByVisibility = true;
        this._rampMaster(0, 0.15);
        clearTimeout(this._suspendTimer);
        this._suspendTimer = setTimeout(() => { if (document.hidden && this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }, 400);
      } else {
        clearTimeout(this._suspendTimer);
        this.userMutedByVisibility = false;
        this._resume();
        this.applySettings();
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);
  }

  // ---------------------------------------------------------------- settings
  /** Accepts a number (master 0..1) or a partial settings object. */
  setVolume(v) {
    if (typeof v === 'number' && Number.isFinite(v)) this.settings.master = clamp01(v);
    else if (v && typeof v === 'object') {
      for (const k of ['master', 'ambience', 'sfx', 'ui']) if (typeof v[k] === 'number' && Number.isFinite(v[k])) this.settings[k] = clamp01(v[k]);
      if (typeof v.muted === 'boolean') this.settings.muted = v.muted;
    }
    this.applySettings();
    this._saveSettings();
    this.events?.emit('audio:changed', { ...this.settings });
  }
  setMuted(m) {
    this.settings.muted = m === undefined ? !this.settings.muted : !!m;
    this.applySettings();
    this._saveSettings();
    this.events?.emit('audio:changed', { ...this.settings });
  }

  applySettings(immediate = false) {
    if (!this.ctx || !this.buses) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.001 : 0.04;
    // perceptual (squared) curve for the master fader
    const master = s.muted || this.userMutedByVisibility ? 0 : s.master * s.master;
    setT(this.buses.master.gain, master, t, tc);
    setT(this.buses.ambience.gain, s.ambience, t, tc);
    setT(this.buses.sfx.gain, s.sfx, t, tc);
    setT(this.buses.ui.gain, s.ui, t, tc);
  }
  _rampMaster(v, tc) {
    if (!this.ctx || !this.buses) return;
    setT(this.buses.master.gain, v, this.ctx.currentTime, tc);
  }

  /** Weather muffling: lowpass cutoff on world audio (snow/fog), UI unaffected. */
  setMuffle(cutoffHz, tc = 0.8) {
    if (!this.ctx || !this.buses) return;
    setT(this.buses.muffle.frequency, Math.max(200, Math.min(20000, cutoffHz)), this.ctx.currentTime, tc);
  }

  _loadSettings() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const s = JSON.parse(raw);
        for (const k of ['master', 'ambience', 'sfx', 'ui']) if (typeof s[k] === 'number' && Number.isFinite(s[k])) this.settings[k] = clamp01(s[k]);
        if (typeof s.muted === 'boolean') this.settings.muted = s.muted;
      }
    } catch (_) { /* private mode / disabled storage */ }
    const q = this.config?.get?.('volume');
    if (q != null && Number.isFinite(parseFloat(q))) this.settings.master = clamp01(parseFloat(q));
    if (this.config?.get?.('mute') === '1') this.settings.muted = true;
  }
  _saveSettings() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch (_) { /* ignore */ }
  }

  dispose() {
    this._removeGestureUnlock();
    if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
    clearTimeout(this._suspendTimer);
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.ctx = null;
    this.state = 'closed';
  }
}

/**
 * Build the master chain on any BaseAudioContext (also used for offline verification renders).
 * Returns the bus object: { ambience, sfx, ui, mix, compressor, muffle, master, analyser, reverb, reverbSend }
 */
export function buildMasterChain(ctx, destination) {
  const ambience = ctx.createGain();
  const sfx = ctx.createGain();
  const ui = ctx.createGain();
  const mix = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  setVal(compressor.threshold, -14);
  setVal(compressor.knee, 18);
  setVal(compressor.ratio, 3.5);
  setVal(compressor.attack, 0.008);
  setVal(compressor.release, 0.28);
  const muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass';
  setVal(muffle.frequency, 20000);
  setVal(muffle.Q, 0.5);
  const master = ctx.createGain();
  setVal(master.gain, 0);
  // brick-wall-ish safety limiter: nothing above ~-1 dBFS leaves the game
  const limiter = ctx.createDynamicsCompressor();
  setVal(limiter.threshold, -6);
  setVal(limiter.knee, 2);
  setVal(limiter.ratio, 16);
  setVal(limiter.attack, 0.001);
  setVal(limiter.release, 0.12);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.72;
  analyser.minDecibels = -96;
  analyser.maxDecibels = -6;

  ambience.connect(mix);
  sfx.connect(mix);
  mix.connect(compressor);
  compressor.connect(muffle);
  muffle.connect(master);
  ui.connect(master);
  master.connect(limiter);
  limiter.connect(analyser);
  analyser.connect(destination);

  return { ambience, sfx, ui, mix, compressor, muffle, master, limiter, analyser, reverb: null, reverbSend: null };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
