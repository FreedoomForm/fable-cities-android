/**
 * Zone / building ambience — the spatial soundscape of a Cities: Skylines city. Lots and
 * buildings near the camera are clustered per category and each cluster gets a positional
 * emitter (PannerNode, camera = listener, air-absorption lowpass, reverb send):
 *   ind          industrial machinery loop (mains hum, compressor chuffs, clanks, steam)
 *   com          crowd babble, evening bass thump from bars/clubs
 *   res          faint HVAC + neighbourhood dogs (synthesised barks, seeded intervals)
 *   office       rooftop HVAC fans
 *   construction hammer grains in bursts, pneumatic drill, reversing beeper (buildings in state 'construction')
 *   park         fountain trickle (park lots); parks also raise bird activity via state.forest
 * Sources: world.zones.lots (type) + world.buildings.list (type, state). A simulated lot list can be
 * supplied when those modules are not present (the showcase labels this honestly).
 */
import { loopSource } from './buffers.js';
import { clamp, clamp01, smoothstep } from '../../shared/math.js';
import { setT, setV, expRamp, cancelAt, setVal } from './params.js';

export const ZONE_CATEGORIES = ['ind', 'com', 'res', 'office', 'construction', 'park'];
const POOL = { ind: 2, com: 2, res: 2, office: 1, construction: 2, park: 1 };
const CELL = 48;

export function categorize(rec) {
  if (!rec) return null;
  if (rec.state === 'construction') return 'construction';
  const t = String(rec.type || rec.zone || rec.zoneType || '').toLowerCase();
  if (!t) return null;
  if (t.startsWith('ind')) return 'ind';
  if (t.startsWith('com') || /shop|retail|market|mall/.test(t)) return 'com';
  if (t.startsWith('res') || /house|apartment|home/.test(t)) return 'res';
  if (t.startsWith('office') || /tower|business/.test(t)) return 'office';
  if (/park|garden|plaza|playground/.test(t)) return 'park';
  return null;
}

/** world.services types → an ambience category (utilities hum, schools murmur, stations idle). */
const SERVICE_CATEGORY = { power: 'ind', sewage: 'ind', garbage: 'ind', water: 'ind', education: 'com', health: 'office', police: 'office', fire: 'office' };

/** Cluster lots/buildings/services near `target` into CELL-sized cells per category. */
export function collectZoneSources(world, target, simulatedLots, radius = 330) {
  const cells = new Map();
  const add = (rec, w) => {
    const cat = categorize(rec);
    if (!cat) return;
    const x = +rec.x, z = +rec.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (Math.abs(x - target.x) > radius || Math.abs(z - target.z) > radius) return;
    const key = `${cat}:${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
    let c = cells.get(key);
    if (!c) { c = { cat, x: 0, z: 0, weight: 0, count: 0, top: 0 }; cells.set(key, c); }
    c.x += x * w; c.z += z * w; c.weight += w; c.count++;
    const top = (+rec.y || 0) + (+rec.height || 0);          // roof height, for the debug markers
    if (Number.isFinite(top) && top > c.top) c.top = top;
  };
  const buildings = world.buildings?.list;
  const lotsWithBuilding = new Set();
  if (buildings && buildings.length) {
    for (const b of buildings) {
      if (!b) continue;
      if (b.lotId != null) lotsWithBuilding.add(b.lotId);
      const area = (b.w || 16) * (b.d || 16) / 256;
      add(b, area * (b.state === 'construction' ? 1.2 : 0.7 + 0.15 * (b.floors || b.level || 1)));
    }
  }
  // service buildings have their own character: utilities hum like industry, schools sound like a
  // crowd, stations/clinics are office HVAC (simulation renders them, so they are really there)
  const services = world.services?.list;
  if (services && services.length) {
    for (const sv of services) {
      const cat = SERVICE_CATEGORY[sv && sv.type];
      if (!cat) continue;
      add({ x: sv.x, z: sv.z, type: cat }, Math.max(1, ((sv.w || 24) * (sv.d || 24)) / 256) * 0.9);
    }
  }
  const lots = (world.zones?.lots && world.zones.lots.length) ? world.zones.lots : (simulatedLots || []);
  for (const lot of lots) {
    if (!lot || lotsWithBuilding.has(lot.id)) continue;
    add(lot, ((lot.w || 16) * (lot.d || 16) / 256) * (lot.state === 'construction' ? 1.2 : 0.8));
  }
  const out = [];
  for (const c of cells.values()) {
    c.x /= c.weight; c.z /= c.weight;
    c.d = Math.hypot(c.x - target.x, c.z - target.z);
    if (c.d <= radius) out.push(c);
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

export class ZoneEmitters {
  /** @param hooks { listener() → {x,y,z}, groundHeight(x,z), reverbSend? } */
  constructor(ctx, buffers, rng, dest, hooks) {
    this.ctx = ctx; this.rng = rng; this.hooks = hooks; this.buffers = buffers;
    this.out = ctx.createGain(); setVal(this.out.gain, 0);
    this.post = ctx.createGain(); setVal(this.post.gain, 1);
    this.out.connect(this.post); this.post.connect(dest);
    // reverb send of every voice goes through a group-owned gain so mute/solo silences the wet path too
    this.sendPost = ctx.createGain(); setVal(this.sendPost.gain, 1);
    if (hooks.reverbSend) this.sendPost.connect(hooks.reverbSend);
    this.muted = false;
    this.voices = [];
    for (const cat of ZONE_CATEGORIES) for (let i = 0; i < POOL[cat]; i++) this.voices.push(this._makeVoice(cat));
    this.level = 0;
    this.assigned = 0;
    this.maxDist = 300;
    this.targets = {};
    this.counts = { bark: 0, hammer: 0, drill: 0, beeper: 0 };
  }
  setMuted(m) { this.muted = !!m; setVal(this.post.gain, this.muted ? 0 : 1); setVal(this.sendPost.gain, this.muted ? 0 : 1); }

  _makeVoice(cat) {
    const ctx = this.ctx, rng = this.rng, B = this.buffers;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = 28; panner.maxDistance = 900; panner.rolloffFactor = 0.9;
    panner.coneInnerAngle = 360; panner.coneOuterAngle = 360;
    const fade = ctx.createGain(); setVal(fade.gain, 0);
    const airLP = ctx.createBiquadFilter(); airLP.type = 'lowpass'; setVal(airLP.frequency, 5000); setVal(airLP.Q, 0.3);
    fade.connect(airLP); airLP.connect(panner); panner.connect(this.out);
    let send = null;
    if (this.hooks.reverbSend) { send = ctx.createGain(); setVal(send.gain, cat === 'construction' ? 0.35 : 0.15); panner.connect(send); send.connect(this.sendPost); }
    const v = { cat, panner, fade, airLP, send, cluster: null, active: false, since: 0, level: 0, x: 0, y: 0, z: 0, next: 0, nodes: [] };
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; setVal(b.frequency, f); setVal(b.Q, q); return b; };
    if (cat === 'ind') {
      v.src = loopSource(ctx, B.machinery, rng, 0.96 + rng() * 0.08);
      v.lp = mk('lowpass', 2200, 0.6);
      v.g = ctx.createGain(); setVal(v.g.gain, 0.9);
      v.src.connect(v.lp); v.lp.connect(v.g); v.g.connect(fade);
    } else if (cat === 'com') {
      v.src = loopSource(ctx, B.babble, rng, 0.94 + rng() * 0.12);
      v.bp = mk('bandpass', 720, 0.7);
      v.g = ctx.createGain(); setVal(v.g.gain, 0.8);
      v.src.connect(v.bp); v.bp.connect(v.g); v.g.connect(fade);
      // evening bass from bars: 52 Hz sine gated at ~2 Hz
      v.thump = ctx.createOscillator(); v.thump.type = 'sine'; setVal(v.thump.frequency, 50 + rng() * 6);
      v.thumpGate = ctx.createOscillator(); v.thumpGate.type = 'square'; setVal(v.thumpGate.frequency, 1.9 + rng() * 0.3);
      const gateG = ctx.createGain(); setVal(gateG.gain, 0.5);
      v.thumpAmp = ctx.createGain(); setVal(v.thumpAmp.gain, 0.5);
      v.thumpGate.connect(gateG); gateG.connect(v.thumpAmp.gain);
      v.thumpG = ctx.createGain(); setVal(v.thumpG.gain, 0);
      v.thump.connect(v.thumpAmp); v.thumpAmp.connect(v.thumpG); v.thumpG.connect(fade);
      v.thump.start(); v.thumpGate.start();
    } else if (cat === 'res' || cat === 'office') {
      v.src = loopSource(ctx, B.hvac, rng, 0.9 + rng() * 0.2);
      v.g = ctx.createGain(); setVal(v.g.gain, cat === 'office' ? 0.7 : 0.25);
      v.src.connect(v.g); v.g.connect(fade);
    } else if (cat === 'park') {
      // fountain: bright trickle with slow burbling
      v.src = loopSource(ctx, B.white, rng, 1);
      v.bp = mk('bandpass', 2600, 0.9);
      v.g = ctx.createGain(); setVal(v.g.gain, 0.18);
      v.lfo = ctx.createOscillator(); v.lfo.type = 'sine'; setVal(v.lfo.frequency, 0.6 + rng() * 0.5);
      const lg = ctx.createGain(); setVal(lg.gain, 0.05);
      v.lfo.connect(lg); lg.connect(v.g.gain); v.lfo.start();
      v.src.connect(v.bp); v.bp.connect(v.g); v.g.connect(fade);
      v.src2 = loopSource(ctx, B.pink, rng, 1);
      v.bp2 = mk('bandpass', 900, 1.5);
      v.g2 = ctx.createGain(); setVal(v.g2.gain, 0.12);
      v.src2.connect(v.bp2); v.bp2.connect(v.g2); v.g2.connect(fade);
    } else if (cat === 'construction') {
      v.g = ctx.createGain(); setVal(v.g.gain, 1); v.g.connect(fade);
      v.hits = 0; v.burstLeft = 0; v.nextDrill = 0; v.nextBeep = 0;
    }
    return v;
  }

  _setPos(node, x, y, z, t, tc) {
    if (node.positionX) { setT(node.positionX, x, t, tc); setT(node.positionY, y, t, tc); setT(node.positionZ, z, t, tc); }
    else if (node.setPosition) node.setPosition(x, y, z);
  }

  /** Activity of a category by hour (0..1). */
  static activity(cat, s) {
    const h = s.hour;
    switch (cat) {
      case 'ind': return 0.3 + 0.7 * smoothstep(5.5, 7.5, h) * (1 - smoothstep(19, 22, h));
      case 'com': return 0.08 + 0.92 * smoothstep(8, 10.5, h) * (1 - smoothstep(22.5, 24, h));
      case 'construction': return smoothstep(6.5, 7.5, h) * (1 - smoothstep(17.5, 18.5, h)) * (1 - 0.8 * s.rain) * (1 - s.snowfall);
      case 'office': return 0.35 + 0.65 * smoothstep(6, 8, h) * (1 - smoothstep(19, 21, h));
      case 'res': return 0.5 + 0.5 * (1 - s.night);
      case 'park': return 1;
      default: return 1;
    }
  }

  update(dt, t, s, clusters) {
    const l = this.hooks.listener();
    const detail = 1 - smoothstep(0.28, 0.7, s.altN);
    const group = detail * 0.9;
    setT(this.out.gain, group, t, 0.5);
    if (group < 0.01 || !clusters || !clusters.length) {
      for (const v of this.voices) if (v.active) this._release(v, t);
      this.level = 0; this.assigned = 0; this.targets = { group, voices: 0 };
      return 0;
    }
    // per category: nearest clusters to the listener
    const byCat = {};
    for (const c of clusters) {
      c.dl = Math.hypot(c.x - l.x, c.z - l.z);
      if (c.dl > this.maxDist) continue;
      (byCat[c.cat] || (byCat[c.cat] = [])).push(c);
    }
    let level = 0, n = 0;
    for (const cat of ZONE_CATEGORIES) {
      const pool = this.voices.filter((v) => v.cat === cat);
      const list = (byCat[cat] || []).sort((a, b) => a.dl - b.dl).slice(0, pool.length);
      const keys = new Set(list.map((c) => this._key(c)));
      for (const v of pool) if (v.active && !keys.has(v.clusterKey) && t - v.since > 1.2) this._release(v, t);
      for (const c of list) {
        const key = this._key(c);
        let voice = pool.find((v) => v.active && v.clusterKey === key);
        if (!voice) { voice = pool.find((v) => !v.active); if (!voice) continue; this._bind(voice, c, key, t); }
        this._drive(voice, c, s, t, l);
        level += voice.level; n++;
      }
    }
    this.level = Math.min(1, level);
    this.assigned = n;
    this.targets = { group, voices: n };
    return this.level * group;
  }

  _key(c) { return `${c.cat}:${Math.round(c.x / CELL)}:${Math.round(c.z / CELL)}`; }

  _bind(v, c, key, t) {
    v.active = true; v.clusterKey = key; v.since = t; v.cluster = c;
    cancelAt(v.fade.gain, t);
    setV(v.fade.gain, 0.0001, t);
    expRamp(v.fade.gain, 1, t + 0.8);
    v.next = t + 0.5 + this.rng() * 2;
  }
  _release(v, t) {
    v.active = false; v.clusterKey = null; v.cluster = null; v.level = 0;
    cancelAt(v.fade.gain, t);
    setT(v.fade.gain, 0, t, 0.3);
  }

  _drive(v, c, s, t, l) {
    const y = (this.hooks.groundHeight ? this.hooks.groundHeight(c.x, c.z) : 0) + (v.cat === 'office' ? 18 : 4);
    v.x = c.x; v.y = y; v.z = c.z;
    this._setPos(v.panner, c.x, y, c.z, t, 0.2);
    const dist = Math.max(1, Math.hypot(c.x - l.x, y - l.y, c.z - l.z));
    setT(v.airLP.frequency, clamp(7000 * Math.pow(40 / Math.max(40, dist), 0.7), 500, 7000), t, 0.3);
    const density = 1 - Math.exp(-c.weight / 5);                  // 0..1 by lot mass in the cell
    const act = ZoneEmitters.activity(v.cat, s);
    const amp = (0.35 + 0.65 * density) * act;
    v.level = amp * clamp01(28 / dist);
    switch (v.cat) {
      case 'ind':
        setT(v.g.gain, 0.9 * amp, t, 0.5);
        break;
      case 'com': {
        setT(v.g.gain, 0.8 * amp * (1 - 0.6 * s.rain), t, 0.5);
        const evening = smoothstep(18.5, 20.5, s.hour) * (1 - smoothstep(1, 3, s.hour)) + (s.hour < 3 ? 0.6 : 0);
        setT(v.thumpG.gain, 0.35 * density * clamp01(evening), t, 0.8);
        break;
      }
      case 'res':
        setT(v.g.gain, 0.25 * amp, t, 0.5);
        this._dogs(v, c, s, t, density);
        break;
      case 'office':
        setT(v.g.gain, 0.7 * amp, t, 0.5);
        break;
      case 'park':
        setT(v.g.gain, 0.18 * amp * (1 - 0.5 * s.rain), t, 0.5);
        setT(v.g2.gain, 0.12 * amp, t, 0.5);
        break;
      case 'construction':
        this._construction(v, s, t, act);
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ scheduled grains
  _dogs(v, c, s, t, density) {
    if (t < v.next) return;
    const rng = this.rng;
    // more barking in the evening and when sirens/traffic are around; quieter in rain and at night
    const mood = (0.5 + 0.5 * (1 - s.night)) * (1 - 0.7 * s.rain);
    v.next = t + (7 + rng() * 22) / Math.max(0.15, density * mood);
    if (rng() > 0.7 * mood) return;
    const barks = 1 + Math.floor(rng() * 3);
    const big = rng() < 0.4;
    let tt = t + 0.05;
    for (let i = 0; i < barks; i++) { this._bark(v.g, tt, big); tt += 0.28 + rng() * 0.2; }
    this.counts.bark++;
  }
  _bark(dest, t0, big) {
    const ctx = this.ctx, rng = this.rng;
    const dur = big ? 0.19 : 0.13;
    const f0 = (big ? 240 : 420) * (0.9 + rng() * 0.2);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    setV(osc.frequency, f0 * 1.15, t0);
    expRamp(osc.frequency, f0 * 0.75, t0 + dur);
    const env = ctx.createGain();
    setV(env.gain, 0.0001, t0);
    expRamp(env.gain, 0.9, t0 + 0.02);
    setV(env.gain, 0.9, t0 + dur * 0.45);
    expRamp(env.gain, 0.0001, t0 + dur);
    const nodes = [osc, env];
    for (const [f, q, g] of [[big ? 620 : 900, 4, 1], [big ? 1250 : 1700, 5, 0.55], [2600, 5, 0.2]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; setVal(bp.frequency, f * (0.95 + rng() * 0.1)); setVal(bp.Q, q);
      const bg = ctx.createGain(); setVal(bg.gain, g);
      osc.connect(bp); bp.connect(bg); bg.connect(env); nodes.push(bp, bg);
    }
    const src = loopSource(ctx, this.buffers.white, rng, 1);
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; setVal(nb.frequency, 1500); setVal(nb.Q, 1.5);
    const ng = ctx.createGain(); setVal(ng.gain, 0.2);
    src.connect(nb); nb.connect(ng); ng.connect(env); src.stop(t0 + dur + 0.02);
    nodes.push(src, nb, ng);
    env.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    cleanupLater(ctx, t0 + dur + 0.3, nodes);
  }

  _construction(v, s, t, act) {
    if (act < 0.05) return;
    const rng = this.rng, ctx = this.ctx;
    // hammer bursts
    if (t >= v.next) {
      if (v.burstLeft > 0) {
        v.burstLeft--;
        this._grain(v.g, this.buffers.hammer[Math.floor(rng() * this.buffers.hammer.length)], t + 0.02, 0.85 + rng() * 0.3, 0.7 + rng() * 0.4);
        v.next = t + 0.5 + rng() * 0.35;
        this.counts.hammer++;
      } else {
        v.burstLeft = 3 + Math.floor(rng() * 5);
        v.next = t + 2 + rng() * 5;
      }
    }
    // pneumatic drill
    if (v.nextDrill === 0) v.nextDrill = t + 3 + rng() * 8;
    if (t >= v.nextDrill) {
      this._grain(v.g, this.buffers.drill, t + 0.02, 0.9 + rng() * 0.2, 0.75);
      v.nextDrill = t + 7 + rng() * 14;
      this.counts.drill++;
    }
    // reversing beeper
    if (v.nextBeep === 0) v.nextBeep = t + 10 + rng() * 20;
    if (t >= v.nextBeep) {
      const n = 4 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const t0 = t + 0.05 + i * 0.8;
        const o = ctx.createOscillator(); o.type = 'square'; setVal(o.frequency, 1000);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; setVal(lp.frequency, 2600);
        const g = ctx.createGain();
        setV(g.gain, 0.0001, t0); expRamp(g.gain, 0.22, t0 + 0.01); setV(g.gain, 0.22, t0 + 0.32); expRamp(g.gain, 0.0001, t0 + 0.36);
        o.connect(lp); lp.connect(g); g.connect(v.g); o.start(t0); o.stop(t0 + 0.4);
        cleanupLater(ctx, t0 + 0.6, [o, lp, g]);
      }
      v.nextBeep = t + 25 + rng() * 40;
      this.counts.beeper++;
    }
  }

  _grain(dest, buffer, t0, rate, amp) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buffer; setVal(src.playbackRate, rate);
    const g = ctx.createGain(); setVal(g.gain, amp);
    src.connect(g); g.connect(dest);
    src.start(t0); src.stop(t0 + buffer.duration / rate + 0.02);
    cleanupLater(ctx, t0 + buffer.duration / rate + 0.3, [src, g]);
  }

  liveVoices() { return this.voices.filter((v) => v.active).map((v) => ({ x: v.x, y: v.y, z: v.z, cat: v.cat, level: v.level, top: v.cluster ? v.cluster.top : 0 })); }

  dispose() {
    for (const v of this.voices) for (const k of ['src', 'src2', 'thump', 'thumpGate', 'lfo']) { if (v[k]) { try { v[k].stop(); } catch (_) { /* ignore */ } } }
  }
}

function cleanupLater(ctx, endTime, nodes) {
  const check = () => {
    if (ctx.state === 'closed' || ctx.currentTime >= endTime) { for (const n of nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } } return; }
    setTimeout(check, Math.max(60, (endTime - ctx.currentTime) * 1000 + 40));
  };
  setTimeout(check, Math.max(60, (endTime - ctx.currentTime) * 1000 + 40));
}
