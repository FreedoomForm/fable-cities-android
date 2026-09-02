/**
 * Positional one-shot events synthesised on demand: emergency sirens (wail / yelp / hi-lo),
 * car & truck horns (formant-shaped, with attack "blat"), thunder and a clock-tower bell.
 * Sirens and horns are placed in the world (PannerNode, camera = listener) with distance
 * lowpass, doppler and a reverb send so they sit "inside" the city. Car pass-bys are real
 * vehicles injected into the traffic emitter simulation (they follow the nearest street).
 */
import { loopSource } from './buffers.js';
import { cleanupAfter } from './layers.js';
import { clamp, clamp01, lerp } from '../../shared/math.js';
import { setT, setV, expRamp, setVal } from './params.js';

const SPEED_OF_SOUND = 343;

function makePanner(ctx) {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = 45;
  p.maxDistance = 5000;
  p.rolloffFactor = 1.1;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  return p;
}

export function setNodePosition(node, x, y, z, t, tc = 0.06) {
  if (node.positionX) {
    setT(node.positionX, x, t, tc);
    setT(node.positionY, y, t, tc);
    setT(node.positionZ, z, t, tc);
  } else if (node.setPosition) node.setPosition(x, y, z);
}

export class OneShots {
  /**
   * @param ctx BaseAudioContext
   * @param buses master buses (sfx, reverbSend)
   * @param buffers procedural buffers
   * @param rng seeded rng
   * @param hooks { pickPosition(kind) → {x,y,z}, listener() → {x,y,z}, onEvent(ev) }
   */
  constructor(ctx, buses, buffers, rng, hooks) {
    this.ctx = ctx;
    this.buses = buses;
    this.buffers = buffers;
    this.rng = rng;
    this.hooks = hooks;
    this.active = [];        // { kind, x, y, z, vx, vz, start, end, nodes:{…}, level }
    this.rateScale = 1;      // showcase can accelerate random events
    this.cooldown = { siren: 0, horn: 0, carpass: 0, thunder: 0 };
    this.lastHourStruck = -1;
    this.prevHour = null;
    this.counts = { siren: 0, horn: 0, carpass: 0, thunder: 0, bell: 0 };
    this.log = [];
    this.bellPos = null;
  }

  // -------------------------------------------------------------------------- scheduler
  update(dt, t, s) {
    // retire finished events, move sirens
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ev = this.active[i];
      if (t > ev.end + 0.3 || !this._evOk(ev)) { this.active.splice(i, 1); continue; }
      if (ev.kind === 'siren') this._moveSiren(ev, dt, t, s);
    }
    for (const k in this.cooldown) this.cooldown[k] = Math.max(0, this.cooldown[k] - dt);

    const rs = this.rateScale;
    const audibleDetail = 1 - clamp01((s.altN - 0.55) / 0.4); // individual sources fade out at altitude
    // sirens: frequency scales with how urban the city is
    if (s.urban > 0.04 && audibleDetail > 0 && this.count('siren') < 1 && this.cooldown.siren <= 0) {
      const mean = lerp(260, 55, clamp01(s.urban)) / rs;
      if (this.rng() < dt / mean) this.siren();
    }
    // horns: with traffic density, more during rush hour, rarer at night
    if (s.traffic > 0.04 && audibleDetail > 0 && this.count('horn') < 2 && this.cooldown.horn <= 0) {
      const mean = lerp(170, 11, clamp01(s.traffic * s.trafficHour)) / rs;
      if (this.rng() < dt / mean) this.horn();
    }
    // thunder: storms often, heavy FALLING rain rarely (distant) — gated by precipitation, never by wetness
    if (this.count('thunder') < 1 && this.cooldown.thunder <= 0) {
      let mean = 0;
      if (s.storm) mean = 24;
      else if (s.rain > 0.75) mean = lerp(140, 70, clamp01((s.rain - 0.75) / 0.25));
      if (mean > 0 && this.rng() < dt / (mean / rs)) this.thunder(s, s.storm ? null : false);
    }
    // clock-tower bell on the hour (daytime, only once a city exists)
    const h = Math.floor(s.hour);
    if (h !== this.lastHourStruck) {
      const wasInit = this.lastHourStruck >= 0;
      // only a natural crossing rings the bell: the previous tick was within the last few minutes before the hour
      const prev = this.prevHour;
      const naturally = prev != null && prev < h && h - prev < 0.1 && s.hour - h < 0.05;
      this.lastHourStruck = h;
      if (wasInit && naturally && s.urban > 0.12 && h >= 7 && h <= 21 && s.altN < 0.9) this.bell(h);
    }
    this.prevHour = s.hour;
  }

  count(kind) { let n = 0; for (const e of this.active) if (e.kind === kind) n++; return n; }

  /**
   * A finite, in-world position for an event. A caller-supplied position that is not finite is
   * REJECTED (never clamped into a fake coordinate): the emitter falls back to its own pick, and if
   * even that fails, to a point 90 m from the listener. Guarantees every event carries finite x/y/z,
   * so no per-frame panner/gain write can ever go non-finite. (audio:sfx is a public entry point.)
   */
  _pos(pos, kind) {
    const fin = Number.isFinite;
    const take = (p) => (p && fin(+p.x) && fin(+p.z) ? { x: +p.x, y: fin(+p.y) ? +p.y : 0, z: +p.z } : null);
    let p = take(pos);
    if (!p && this.hooks.pickPosition) { try { p = take(this.hooks.pickPosition(kind)); } catch (_) { p = null; } }
    if (!p) {
      const l = this.hooks.listener ? this.hooks.listener() : { x: 0, y: 0, z: 0 };
      const a = this.rng() * Math.PI * 2;
      const lx = fin(l.x) ? l.x : 0, lz = fin(l.z) ? l.z : 0;
      p = { x: lx + Math.cos(a) * 90, y: 0, z: lz + Math.sin(a) * 90 };
    }
    if (this.hooks.groundHeight && !pos) {
      const g = this.hooks.groundHeight(p.x, p.z);
      if (fin(g)) p.y = g;
    }
    return p;
  }

  /** True when an event's position/velocity is still usable; a failed event is retired silently. */
  _evOk(ev) {
    const fin = Number.isFinite;
    return fin(ev.x) && fin(ev.y) && fin(ev.z) && (ev.vx === undefined || (fin(ev.vx) && fin(ev.vz)));
  }

  _record(ev) {
    this.active.push(ev);
    this.counts[ev.kind] = (this.counts[ev.kind] || 0) + 1;
    const l = this.hooks.listener();
    const d = Math.hypot(ev.x - l.x, ev.z - l.z);
    const entry = { kind: ev.kind, x: ev.x, z: ev.z, distance: Math.round(d), start: ev.start, end: ev.end, variant: ev.variant || '' };
    this.log.unshift(entry);
    if (this.log.length > 8) this.log.length = 8;
    this.hooks.onEvent?.({ ...entry, event: ev });
  }

  _spatialChain(ev, distLP) {
    const ctx = this.ctx;
    const panner = makePanner(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; setVal(lp.frequency, distLP); setVal(lp.Q, 0.4);
    const env = ctx.createGain(); setVal(env.gain, 0);
    env.connect(lp); lp.connect(panner); panner.connect(this.buses.sfx);
    if (this.buses.reverbSend) {
      const send = ctx.createGain(); setVal(send.gain, 0.45);
      panner.connect(send); send.connect(this.buses.reverbSend);
      ev.send = send;
    }
    setNodePosition(panner, ev.x, ev.y, ev.z, ctx.currentTime, 0.001);
    ev.panner = panner; ev.lp = lp; ev.env = env;
    return env;
  }

  /** Air absorption approximation: further sources lose highs. */
  _distanceCutoff(d) { return clamp(9000 * Math.pow(60 / Math.max(60, d), 0.9), 500, 12000); }

  // -------------------------------------------------------------------------- sirens
  siren(pos = null, variant = null) {
    const ctx = this.ctx, rng = this.rng, t = ctx.currentTime;
    const p = this._pos(pos, 'siren');
    variant = variant || (rng() < 0.55 ? 'wail' : rng() < 0.6 ? 'yelp' : 'hilo');
    const dur = 9 + rng() * 9;
    const heading = rng() * Math.PI * 2;
    const speed = 12 + rng() * 10; // m/s
    const ev = { kind: 'siren', variant, x: p.x, y: (p.y || 0) + 1.5, z: p.z, vx: Math.cos(heading) * speed, vz: Math.sin(heading) * speed, start: t, end: t + dur, level: 0 };
    const l = this.hooks.listener();
    const dist = Math.hypot(ev.x - l.x, ev.y - l.y, ev.z - l.z);
    const env = this._spatialChain(ev, this._distanceCutoff(dist));

    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const osc2 = ctx.createOscillator(); osc2.type = 'square'; // thin square doubles the fundamental → "electronic" siren
    const oscMix = ctx.createGain(); setVal(oscMix.gain, 0.35);
    const shape = ctx.createBiquadFilter(); shape.type = 'lowpass'; setVal(shape.Q, 3.5); setVal(shape.frequency, 1900);
    osc.connect(shape); osc2.connect(oscMix); oscMix.connect(shape); shape.connect(env);
    const base = variant === 'hilo' ? 435 : 720;
    setVal(osc.frequency, base); setVal(osc2.frequency, base);
    if (variant === 'wail') {
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; setVal(lfo.frequency, 0.28 + rng() * 0.12);
      const lg = ctx.createGain(); setVal(lg.gain, 330);
      lfo.connect(lg); lg.connect(osc.frequency); lg.connect(osc2.frequency);
      setVal(osc.frequency, 1000); setVal(osc2.frequency, 1000);
      lfo.start(t); lfo.stop(t + dur + 0.5);
      ev.lfo = lfo;
    } else if (variant === 'yelp') {
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; setVal(lfo.frequency, 3.2 + rng() * 0.8);
      const lg = ctx.createGain(); setVal(lg.gain, 300);
      lfo.connect(lg); lg.connect(osc.frequency); lg.connect(osc2.frequency);
      setVal(osc.frequency, 1050); setVal(osc2.frequency, 1050);
      lfo.start(t); lfo.stop(t + dur + 0.5);
      ev.lfo = lfo;
    } else {
      // European two-tone: 435 / 580 Hz alternating every 0.6 s
      const period = 0.6;
      for (let k = 0, tt = t; tt < t + dur; k++, tt += period) {
        const f = k % 2 === 0 ? 435 : 580;
        setV(osc.frequency, f, tt);
        setV(osc2.frequency, f, tt);
      }
    }
    const amp = 0.95;
    setV(env.gain, 0.0001, t);
    expRamp(env.gain, amp, t + Math.min(2.2, dur * 0.25));
    setV(env.gain, amp, t + dur - Math.min(3.5, dur * 0.35));
    expRamp(env.gain, 0.0001, t + dur);
    osc.start(t); osc.stop(t + dur + 0.1);
    osc2.start(t); osc2.stop(t + dur + 0.1);
    ev.osc = osc; ev.osc2 = osc2;
    ev.nodes = [osc, osc2, oscMix, shape, env];
    this.cooldown.siren = 20 / this.rateScale;
    this._record(ev);
    cleanupAfter(ctx, ev.end + 0.5, () => { for (const n of ev.nodes) n.disconnect(); ev.panner.disconnect(); ev.lp.disconnect(); ev.send?.disconnect(); });
    return ev;
  }

  _moveSiren(ev, dt, t, s) {
    if (t > ev.end) return;
    ev.x += ev.vx * dt; ev.z += ev.vz * dt;
    if (this.hooks.groundHeight) { const g = this.hooks.groundHeight(ev.x, ev.z); if (Number.isFinite(g)) ev.y = g + 1.5; }
    if (!this._evOk(ev)) return;
    setNodePosition(ev.panner, ev.x, ev.y, ev.z, t, 0.08);
    const l = this.hooks.listener();
    const dx = l.x - ev.x, dy = l.y - ev.y, dz = l.z - ev.z;
    const d = Math.max(1, Math.hypot(dx, dy, dz));
    // doppler: radial velocity toward listener
    const vr = (ev.vx * dx + ev.vz * dz) / d;
    const ratio = SPEED_OF_SOUND / Math.max(200, SPEED_OF_SOUND - vr);
    const cents = clamp(1200 * Math.log2(ratio), -120, 120);
    setT(ev.osc.detune, cents, t, 0.1);
    setT(ev.osc2.detune, cents, t, 0.1);
    setT(ev.lp.frequency, this._distanceCutoff(d), t, 0.2);
    // envelope-following level for the debug HUD (0..1)
    const phase = clamp01((t - ev.start) / Math.min(2.2, (ev.end - ev.start) * 0.25)) * clamp01((ev.end - t) / Math.min(3.5, (ev.end - ev.start) * 0.35));
    ev.level = phase * clamp01(45 / d);
  }

  // -------------------------------------------------------------------------- horns
  horn(pos = null) {
    const ctx = this.ctx, rng = this.rng, t = ctx.currentTime;
    const p = this._pos(pos, 'horn');
    const truck = rng() < 0.22;
    // real horns are a diaphragm pair a third apart; trucks use air horns a fourth apart and much lower
    const f1 = truck ? 205 + rng() * 40 : [349, 370, 392, 415, 440, 466][Math.floor(rng() * 6)];
    const f2 = f1 * (truck ? 1.33 : 1.26);
    const honks = rng() < 0.4 ? 2 : 1;
    const hold = truck ? 0.6 + rng() * 0.7 : 0.18 + rng() * 0.5;
    const gap = 0.15 + rng() * 0.12;
    const dur = honks * (hold + gap) + 0.15;
    const ev = { kind: 'horn', variant: truck ? 'truck' : 'car', x: p.x, y: (p.y || 0) + 1, z: p.z, start: t, end: t + dur, level: 0 };
    const l = this.hooks.listener();
    const dist = Math.hypot(ev.x - l.x, ev.y - l.y, ev.z - l.z);
    const env = this._spatialChain(ev, Math.min(this._distanceCutoff(dist), 4200));
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; setVal(o1.frequency, f1);
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; setVal(o2.frequency, f2);
    const o1b = ctx.createOscillator(); o1b.type = 'square'; setVal(o1b.frequency, f1 * 1.004); // slight beating = diaphragm buzz
    const o3 = ctx.createOscillator(); o3.type = 'square'; setVal(o3.frequency, f1 * 0.5);
    const g1b = ctx.createGain(); setVal(g1b.gain, 0.25);
    const g3 = ctx.createGain(); setVal(g3.gain, truck ? 0.35 : 0.06);
    const pre = ctx.createGain(); setVal(pre.gain, 0.6);
    o1.connect(pre); o2.connect(pre); o1b.connect(g1b); g1b.connect(pre); o3.connect(g3); g3.connect(pre);
    // horn body resonances (bell/trumpet formants) instead of a single bandpass
    const nodes = [o1, o2, o1b, o3, g1b, g3, pre, env];
    for (const [f, q, g] of truck ? [[420, 3, 1], [900, 4, 0.7], [1500, 5, 0.3]] : [[1000, 3, 1], [1700, 4, 0.8], [2600, 5, 0.35]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; setVal(bp.frequency, f * (0.95 + rng() * 0.1)); setVal(bp.Q, q);
      const bg = ctx.createGain(); setVal(bg.gain, g);
      pre.connect(bp); bp.connect(bg); bg.connect(env); nodes.push(bp, bg);
    }
    const direct = ctx.createGain(); setVal(direct.gain, 0.25); pre.connect(direct); direct.connect(env); nodes.push(direct);
    const amp = truck ? 1.0 : 0.8;
    let tt = t;
    setV(env.gain, 0.0001, t);
    for (let k = 0; k < honks; k++) {
      // attack "blat": pitch sags in for a few ms while the diaphragm spins up
      for (const [o, base] of [[o1, f1], [o2, f2], [o1b, f1 * 1.004]]) { setV(o.frequency, base * 0.93, tt); expRamp(o.frequency, base, tt + 0.045); }
      expRamp(env.gain, amp, tt + 0.025);
      setV(env.gain, amp, tt + hold);
      expRamp(env.gain, 0.0001, tt + hold + 0.07);
      tt += hold + gap;
    }
    for (const o of [o1, o2, o1b, o3]) { o.start(t); o.stop(t + dur + 0.05); }
    ev.nodes = nodes;
    ev.level = 1;
    this.cooldown.horn = 2.5 / this.rateScale;
    this._record(ev);
    cleanupAfter(ctx, ev.end + 0.3, () => { for (const n of ev.nodes) n.disconnect(); ev.panner.disconnect(); ev.lp.disconnect(); ev.send?.disconnect(); });
    return ev;
  }

  // -------------------------------------------------------------------------- car pass-by (real vehicle on the nearest street)
  carPass(s, type = null) {
    const t = this.ctx.currentTime;
    const l = this.hooks.listener();
    const target = this.hooks.target ? this.hooks.target() : { x: l.x, z: l.z };
    const veh = this.hooks.spawnPassBy ? this.hooks.spawnPassBy(target, type) : null;
    if (!veh) return null;
    const ev = { kind: 'carpass', variant: veh.type, x: veh.x, y: veh.y, z: veh.z, start: t, end: t + 6, level: 0.5, vehicle: veh, nodes: [] };
    this.cooldown.carpass = 0.8 / this.rateScale;
    this._record(ev);
    return ev;
  }

  // -------------------------------------------------------------------------- thunder
  thunder(s = null, nearOverride = null) {
    const ctx = this.ctx, rng = this.rng, t = ctx.currentTime;
    const near = nearOverride != null ? !!nearOverride : rng() < 0.3;
    const dur = near ? 4.5 + rng() * 2.5 : 6 + rng() * 5;
    const delay = near ? 0.05 : 0.4 + rng() * 1.6;   // light travels first
    const t0 = t + delay;
    const src = loopSource(ctx, this.buffers.brown, rng, near ? 1.0 : 0.7);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; setVal(lp.Q, 0.9);
    setV(lp.frequency, near ? 900 : 260, t0);
    expRamp(lp.frequency, 70, t0 + dur);
    const env = ctx.createGain();
    const amp = near ? 1.05 : 0.7;
    setV(env.gain, 0.0001, t0);
    expRamp(env.gain, amp, t0 + (near ? 0.06 : 0.5 + rng() * 0.6));
    expRamp(env.gain, amp * 0.45, t0 + dur * 0.35);
    expRamp(env.gain, 0.0001, t0 + dur);
    // rolling rumble modulation
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; setVal(lfo.frequency, 2.2 + rng() * 2);
    const lg = ctx.createGain(); setVal(lg.gain, amp * 0.3);
    lfo.connect(lg); lg.connect(env.gain); lfo.start(t0); lfo.stop(t0 + dur + 0.1);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(lp); lp.connect(env);
    let tail = env;
    if (pan) { setVal(pan.pan, (rng() - 0.5) * 1.2); env.connect(pan); tail = pan; }
    tail.connect(this.buses.sfx);
    if (this.buses.reverbSend) { const send = ctx.createGain(); setVal(send.gain, 0.5); tail.connect(send); send.connect(this.buses.reverbSend); }
    const nodes = [src, lp, env, lfo, lg, pan].filter(Boolean);
    if (near) {
      // sharp crack: white noise burst through a highpass
      const crack = loopSource(ctx, this.buffers.white, rng, 1);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; setVal(hp.frequency, 1500);
      const cg = ctx.createGain(); setV(cg.gain, 0.0001, t0); expRamp(cg.gain, 0.8, t0 + 0.012); expRamp(cg.gain, 0.0001, t0 + 0.35);
      crack.connect(hp); hp.connect(cg); cg.connect(tail);
      crack.stop(t0 + 0.4);
      nodes.push(crack, hp, cg);
    }
    src.stop(t0 + dur + 0.1);
    const l = this.hooks.listener();
    const ev = { kind: 'thunder', variant: near ? 'near' : 'distant', x: l.x, y: l.y, z: l.z, start: t0, end: t0 + dur, level: amp, nodes };
    this.cooldown.thunder = 12 / this.rateScale;
    this._record(ev);
    cleanupAfter(ctx, ev.end + 0.3, () => { for (const n of ev.nodes) n.disconnect(); });
    return ev;
  }

  // -------------------------------------------------------------------------- clock-tower bell
  bell(hour) {
    const ctx = this.ctx, rng = this.rng, t = ctx.currentTime;
    if (!this.bellPos) this.bellPos = this._pos(null, 'bell');
    const p = this.bellPos;
    const strikes = Math.min(6, (hour % 12) || 12);
    const interval = 1.7;
    const ring = 4.5;
    const dur = strikes * interval + ring;
    const ev = { kind: 'bell', variant: `${strikes}×`, x: p.x, y: (p.y || 0) + 30, z: p.z, start: t, end: t + dur, level: 0.6 };
    const l = this.hooks.listener();
    const dist = Math.hypot(ev.x - l.x, ev.y - l.y, ev.z - l.z);
    const env = this._spatialChain(ev, Math.min(this._distanceCutoff(dist), 4500));
    setVal(env.gain, 1);
    setV(env.gain, 1, t);
    const f0 = 392 * (0.92 + rng() * 0.1);
    const partials = [[0.5, 0.35, 6.5], [1, 1, 5], [1.183, 0.45, 3.4], [1.506, 0.35, 2.8], [2.0, 0.28, 2.1], [2.514, 0.18, 1.5], [2.662, 0.12, 1.3], [3.011, 0.1, 1.0]];
    const nodes = [env];
    for (let k = 0; k < strikes; k++) {
      const ts = t + k * interval;
      for (const [ratio, amp, decay] of partials) {
        const o = ctx.createOscillator(); o.type = 'sine'; setVal(o.frequency, f0 * ratio);
        const g = ctx.createGain();
        setV(g.gain, 0.0001, ts);
        expRamp(g.gain, amp * 0.32, ts + 0.006);
        setT(g.gain, 0.0001, ts + 0.01, decay / 4);
        o.connect(g); g.connect(env);
        o.start(ts); o.stop(ts + ring);
        nodes.push(o, g);
      }
    }
    ev.nodes = nodes;
    this._record(ev);
    cleanupAfter(ctx, ev.end + 0.3, () => { for (const n of ev.nodes) n.disconnect(); ev.panner.disconnect(); ev.lp.disconnect(); ev.send?.disconnect(); });
    return ev;
  }
}
