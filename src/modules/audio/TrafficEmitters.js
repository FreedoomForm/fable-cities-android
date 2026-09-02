/**
 * Positional traffic: every audible car/van/truck/bus is a real emitter in the world with an
 * engine voice (PeriodicWave with a per-type harmonic recipe, firing frequency follows speed),
 * tyre/road noise (bandpassed pink noise, level ∝ speed², brighter and louder on wet asphalt),
 * exhaust rumble for heavy vehicles, true doppler (radial velocity → detune / playback rate),
 * air-absorption lowpass by distance and a PannerNode (camera = listener).
 *
 * Vehicle positions come from `world.traffic` when the traffic module publishes a list
 * (readVehicles() accepts several shapes). Until it does, VehicleSim drives virtual vehicles along
 * the REAL lane graph of world.roads.api.laneGraph() (or straight lines when there are no roads),
 * so pass-bys follow the streets you see, with correct headings and turns at junctions.
 */
import { loopSource } from './buffers.js';
import { clamp, clamp01, lerp, smoothstep } from '../../shared/math.js';
import { setT, setV, expRamp, cancelAt, setVal } from './params.js';

const SPEED_OF_SOUND = 343;
export const VEHICLE_TYPES = {
  car:   { idleHz: 27, cruiseHz: 74, engine: 0.32, tyre: 0.5, lp: 520, rumble: 0.0, share: 0.7 },
  van:   { idleHz: 24, cruiseHz: 62, engine: 0.4, tyre: 0.55, lp: 460, rumble: 0.12, share: 0.12 },
  truck: { idleHz: 16, cruiseHz: 42, engine: 0.65, tyre: 0.7, lp: 380, rumble: 0.5, share: 0.1 },
  bus:   { idleHz: 15, cruiseHz: 38, engine: 0.6, tyre: 0.65, lp: 360, rumble: 0.42, share: 0.08 },
};

function pickType(rng) {
  const r = rng();
  let acc = 0;
  for (const k in VEHICLE_TYPES) { acc += VEHICLE_TYPES[k].share; if (r < acc) return k; }
  return 'car';
}

/**
 * Adapter: read a vehicle list from world.traffic in any of the shapes a traffic module is likely to
 * publish. Returns null when there is no list (the contract only guarantees a count).
 * Velocities are derived from position deltas when the records do not carry them.
 */
export function readVehicles(world, prev, dt) {
  const tr = world.traffic;
  if (!tr) return null;
  let list = null;
  if (Array.isArray(tr.vehicles)) list = tr.vehicles;
  else if (Array.isArray(tr.list)) list = tr.list;
  else if (tr.api && typeof tr.api.getVehicles === 'function') list = tr.api.getVehicles();
  else if (tr.api && typeof tr.api.vehicles === 'function') list = tr.api.vehicles();
  if (!list || !list.length) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v) continue;
    const p = v.position || v.pos || v;
    const x = +p.x, z = +p.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const id = v.id ?? v.uid ?? i;
    let vx = v.vx, vz = v.vz;
    if (v.velocity) { vx = v.velocity.x; vz = v.velocity.z; }
    if (!Number.isFinite(vx) || !Number.isFinite(vz)) {
      const last = prev.get(id);
      if (last && dt > 0) { vx = (x - last.x) / dt; vz = (z - last.z) / dt; } else { vx = 0; vz = 0; }
    }
    let speed = v.speed;
    if (!Number.isFinite(speed)) speed = Math.hypot(vx, vz);
    else if (speed > 45) speed /= 3.6; // km/h → m/s
    let type = String(v.type || v.kind || 'car').toLowerCase();
    if (!VEHICLE_TYPES[type]) type = /truck|lorry|semi|hgv/.test(type) ? 'truck' : /bus|coach/.test(type) ? 'bus' : /van|pickup|delivery/.test(type) ? 'van' : 'car';
    out.push({ id, x, y: Number.isFinite(p.y) ? p.y : null, z, vx, vz, speed, type });
    prev.set(id, { x, z });
  }
  return out;
}

// ------------------------------------------------------------------------------ virtual vehicles
export class VehicleSim {
  constructor(world, rng) {
    this.world = world;
    this.rng = rng;
    this.vehicles = [];
    this.version = -1;
    this.lanes = [];
    this.laneById = new Map();
    this.conns = new Map();
    this.nextId = 1;
  }

  _refreshGraph() {
    const roads = this.world.roads;
    const api = roads?.api;
    if (!api || typeof api.laneGraph !== 'function' || !roads.segments || roads.segments.size === 0) { this.lanes = []; this.laneById.clear(); this.version = roads?.version ?? -1; return; }
    if (roads.version === this.version && this.lanes.length) return;
    let graph = null;
    try { graph = api.laneGraph(); } catch (_) { graph = null; }
    this.version = roads.version;
    this.lanes = []; this.laneById.clear(); this.conns = new Map();
    if (!graph || !graph.lanes) return;
    for (const l of graph.lanes) {
      if (!l.points || l.points.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < l.points.length; i++) cum.push(cum[i - 1] + Math.hypot(l.points[i].x - l.points[i - 1].x, l.points[i].z - l.points[i - 1].z));
      if (!(cum[cum.length - 1] >= 2)) continue; // also rejects NaN lanes
      const rec = { lane: l, cum, length: cum[cum.length - 1], mid: l.points[Math.floor(l.points.length / 2)] };
      this.lanes.push(rec);
      this.laneById.set(l.id, rec);
    }
    const conns = graph.connections;
    if (conns) for (const [id, arr] of conns instanceof Map ? conns : Object.entries(conns)) this.conns.set(id, arr);
    // vehicles whose lane vanished respawn
    this.vehicles = this.vehicles.filter((v) => !v.rec || this.laneById.has(v.rec.lane.id));
  }

  _posOn(rec, s, out) {
    const pts = rec.lane.points, cum = rec.cum;
    s = clamp(s, 0, rec.length);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const u = (s - cum[i - 1]) / seg;
    out.x = a.x + (b.x - a.x) * u; out.z = a.z + (b.z - a.z) * u; out.y = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * u;
    out.tx = (b.x - a.x) / seg; out.tz = (b.z - a.z) / seg;
    return out;
  }

  /** Keep `wanted` virtual vehicles within `radius` of target. */
  update(dt, target, wanted, radius = 260) {
    this._refreshGraph();
    const rng = this.rng;
    const tmp = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    // move + retire
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.rec) {
        const remaining = v.rec.length - v.s;
        const slow = 0.5 + 0.5 * Math.min(1, remaining / 28) * Math.min(1, (v.s + 6) / 20);
        v.speed += (v.cruise * slow - v.speed) * Math.min(1, dt * 1.8);
        v.s += v.speed * dt;
        if (v.s >= v.rec.length) {
          const next = this.conns.get(v.rec.lane.id) || [];
          const cand = next.map((id) => this.laneById.get(id)).filter(Boolean);
          if (cand.length && v.hops < 12) { v.rec = cand[Math.floor(rng() * cand.length)]; v.s = 0; v.hops++; } else { this.vehicles.splice(i, 1); continue; }
        }
        this._posOn(v.rec, v.s, tmp);
        v.vx = tmp.tx * v.speed; v.vz = tmp.tz * v.speed;
        v.x = tmp.x; v.y = tmp.y; v.z = tmp.z;
      } else {
        v.x += v.vx * dt; v.z += v.vz * dt;
        v.y = this.world.terrain.getHeight(v.x, v.z);
        v.life -= dt;
        if (v.life <= 0) { this.vehicles.splice(i, 1); continue; }
      }
      if (!Number.isFinite(v.x) || !Number.isFinite(v.z) || !Number.isFinite(v.speed)) { this.vehicles.splice(i, 1); continue; }
      if (Math.hypot(v.x - target.x, v.z - target.z) > radius * 1.35) this.vehicles.splice(i, 1);
    }
    // spawn
    let guard = 0;
    while (this.vehicles.length < wanted && guard++ < 6) {
      const type = pickType(rng);
      if (this.lanes.length) {
        const near = [];
        for (const rec of this.lanes) if (Math.hypot(rec.mid.x - target.x, rec.mid.z - target.z) < radius) near.push(rec);
        if (!near.length) break;
        const rec = near[Math.floor(rng() * near.length)];
        const kmh = rec.lane.speed || 50;
        const cruise = (kmh / 3.6) * (0.6 + rng() * 0.35) * (type === 'truck' || type === 'bus' ? 0.85 : 1);
        const v = { id: 'v' + this.nextId++, type, rec, s: rng() * rec.length, speed: cruise, cruise, hops: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, virtual: true };
        this._posOn(rec, v.s, tmp);
        v.x = tmp.x; v.y = tmp.y; v.z = tmp.z; v.vx = tmp.tx * v.speed; v.vz = tmp.tz * v.speed;
        this.vehicles.push(v);
      } else {
        // no roads: straight pass-bys that cross the neighbourhood of the target
        const a = rng() * Math.PI * 2;
        const r = radius * (0.6 + 0.4 * rng());
        const sx = target.x + Math.cos(a) * r, sz = target.z + Math.sin(a) * r;
        const off = (rng() - 0.5) * 90;
        const ex = target.x + Math.cos(a + Math.PI) * r + Math.cos(a + Math.PI / 2) * off, ez = target.z + Math.sin(a + Math.PI) * r + Math.sin(a + Math.PI / 2) * off;
        const d = Math.hypot(ex - sx, ez - sz);
        const cruise = 9 + rng() * 7;
        const v = { id: 'v' + this.nextId++, type, rec: null, x: sx, z: sz, y: this.world.terrain.getHeight(sx, sz), vx: ((ex - sx) / d) * cruise, vz: ((ez - sz) / d) * cruise, speed: cruise, cruise, life: d / cruise, virtual: true };
        this.vehicles.push(v);
      }
    }
    return this.vehicles;
  }

  /** Scripted pass-by close to `target` (for api.playWorld('carpass') and the showcase). */
  spawnPassBy(target, type = null) {
    this._refreshGraph();
    const rng = this.rng;
    type = type || pickType(rng);
    const tmp = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    let best = null, bestD = Infinity;
    for (const rec of this.lanes) {
      const d = Math.hypot(rec.mid.x - target.x, rec.mid.z - target.z);
      if (d < bestD) { bestD = d; best = rec; }
    }
    if (best && bestD < 140) {
      const cruise = ((best.lane.speed || 50) / 3.6) * 0.8;
      const v = { id: 'p' + this.nextId++, type, rec: best, s: 0, speed: cruise, cruise, hops: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, virtual: true, pass: true };
      this._posOn(best, 0, tmp);
      v.x = tmp.x; v.y = tmp.y; v.z = tmp.z; v.vx = tmp.tx * cruise; v.vz = tmp.tz * cruise;
      this.vehicles.push(v);
      return v;
    }
    const a = rng() * Math.PI * 2, r = 110;
    const sx = target.x + Math.cos(a) * r, sz = target.z + Math.sin(a) * r;
    const ex = target.x - Math.cos(a) * r + Math.cos(a + Math.PI / 2) * 14, ez = target.z - Math.sin(a) * r + Math.sin(a + Math.PI / 2) * 14;
    const d = Math.hypot(ex - sx, ez - sz), cruise = 12;
    const v = { id: 'p' + this.nextId++, type, rec: null, x: sx, z: sz, y: this.world.terrain.getHeight(sx, sz), vx: ((ex - sx) / d) * cruise, vz: ((ez - sz) / d) * cruise, speed: cruise, cruise, life: d / cruise, virtual: true, pass: true };
    this.vehicles.push(v);
    return v;
  }
}

// ------------------------------------------------------------------------------------- emitters
function enginePeriodicWave(ctx, type, rng) {
  const N = 20;
  const real = new Float32Array(N), imag = new Float32Array(N);
  const heavy = type === 'truck' || type === 'bus';
  for (let n = 1; n < N; n++) {
    let a = 1 / Math.pow(n, heavy ? 1.15 : 1.35);
    if (n % 2 === 0) a *= heavy ? 0.85 : 1.25;      // 4-cyl cars emphasise even harmonics
    if (n === 1) a *= heavy ? 1.3 : 0.8;
    a *= 0.85 + 0.3 * rng();
    const ph = rng() * Math.PI * 2;
    real[n] = a * Math.cos(ph); imag[n] = a * Math.sin(ph);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

export class TrafficEmitters {
  /**
   * @param hooks { listener() → {x,y,z}, reverbSend?: AudioNode }
   */
  constructor(ctx, buffers, rng, dest, hooks, voices = 9) {
    this.ctx = ctx;
    this.rng = rng;
    this.hooks = hooks;
    this.out = ctx.createGain(); setVal(this.out.gain, 0);
    this.post = ctx.createGain(); setVal(this.post.gain, 1);
    this.out.connect(this.post); this.post.connect(dest);
    // reverb send of every voice goes through a group-owned gain so mute/solo silences the wet path too
    this.sendPost = ctx.createGain(); setVal(this.sendPost.gain, 1);
    if (hooks.reverbSend) this.sendPost.connect(hooks.reverbSend);
    this.muted = false;
    this.waves = {};
    for (const k in VEHICLE_TYPES) this.waves[k] = enginePeriodicWave(ctx, k, rng);
    this.voices = [];
    for (let i = 0; i < voices; i++) this.voices.push(this._makeVoice(buffers));
    this.level = 0;
    this.assigned = 0;
    this.maxDist = 240;
    this.targets = {};
  }
  setMuted(m) { this.muted = !!m; setVal(this.post.gain, this.muted ? 0 : 1); setVal(this.sendPost.gain, this.muted ? 0 : 1); }

  _makeVoice(buffers) {
    const ctx = this.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = 11; panner.maxDistance = 600; panner.rolloffFactor = 1.0;
    panner.coneInnerAngle = 360; panner.coneOuterAngle = 360;
    const fade = ctx.createGain(); setVal(fade.gain, 0);
    const airLP = ctx.createBiquadFilter(); airLP.type = 'lowpass'; setVal(airLP.frequency, 6000); setVal(airLP.Q, 0.3);
    fade.connect(airLP); airLP.connect(panner); panner.connect(this.out);
    let send = null;
    if (this.hooks.reverbSend) { send = ctx.createGain(); setVal(send.gain, 0.18); panner.connect(send); send.connect(this.sendPost); }
    // engine: two detuned oscillators sharing a wave → lowpass → gain
    const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator();
    osc1.setPeriodicWave(this.waves.car); osc2.setPeriodicWave(this.waves.car);
    setVal(osc1.frequency, 40); setVal(osc2.frequency, 40.3);
    const engLP = ctx.createBiquadFilter(); engLP.type = 'lowpass'; setVal(engLP.frequency, 500); setVal(engLP.Q, 1.1);
    const engGain = ctx.createGain(); setVal(engGain.gain, 0);
    osc1.connect(engLP); osc2.connect(engLP); engLP.connect(engGain); engGain.connect(fade);
    // roughness: slow AM at half the firing rate (uneven combustion)
    const rough = ctx.createOscillator(); rough.type = 'sine'; setVal(rough.frequency, 13);
    const roughG = ctx.createGain(); setVal(roughG.gain, 0);
    rough.connect(roughG); roughG.connect(engGain.gain);
    // tyre / road noise
    const tyre = loopSource(ctx, buffers.pink, this.rng, 1);
    const tyreBP = ctx.createBiquadFilter(); tyreBP.type = 'bandpass'; setVal(tyreBP.frequency, 1100); setVal(tyreBP.Q, 0.8);
    const tyreGain = ctx.createGain(); setVal(tyreGain.gain, 0);
    tyre.connect(tyreBP); tyreBP.connect(tyreGain); tyreGain.connect(fade);
    // exhaust rumble (heavy vehicles)
    const rum = loopSource(ctx, buffers.brown, this.rng, 1);
    const rumLP = ctx.createBiquadFilter(); rumLP.type = 'lowpass'; setVal(rumLP.frequency, 130); setVal(rumLP.Q, 0.8);
    const rumGain = ctx.createGain(); setVal(rumGain.gain, 0);
    rum.connect(rumLP); rumLP.connect(rumGain); rumGain.connect(fade);
    osc1.start(); osc2.start(); rough.start();
    return { panner, fade, airLP, send, osc1, osc2, engLP, engGain, rough, roughG, tyre, tyreBP, tyreGain, rum, rumGain, vehicleId: null, type: 'car', active: false, level: 0, x: 0, y: 0, z: 0, since: 0 };
  }

  _setPos(node, x, y, z, t, tc) {
    if (node.positionX) { setT(node.positionX, x, t, tc); setT(node.positionY, y, t, tc); setT(node.positionZ, z, t, tc); }
    else if (node.setPosition) node.setPosition(x, y, z);
  }

  /**
   * @param vehicles [{ id, x, y|null, z, vx, vz, speed, type }] (already merged real + virtual)
   * @param groundHeight (x,z) → y
   */
  update(dt, t, s, vehicles, groundHeight) {
    const l = this.hooks.listener();
    const detail = 1 - smoothstep(0.22, 0.62, s.altN);           // individual vehicles fade out at altitude
    const group = detail * 0.95;
    setT(this.out.gain, group, t, 0.4);
    if (group < 0.01 || !vehicles || !vehicles.length) {
      for (const v of this.voices) if (v.active) this._release(v, t);
      this.level = 0; this.assigned = 0; this.targets = { group, voices: 0 };
      return 0;
    }
    // nearest vehicles first
    const scored = [];
    for (const veh of vehicles) {
      if (!veh || !Number.isFinite(veh.x) || !Number.isFinite(veh.z)) continue;
      const d = Math.hypot(veh.x - l.x, veh.z - l.z);
      if (d < this.maxDist) scored.push({ veh, d });
    }
    scored.sort((a, b) => a.d - b.d);
    const pick = scored.slice(0, this.voices.length);
    const wantedIds = new Set(pick.map((p) => p.veh.id));
    // release voices whose vehicle left the pick (with a little hysteresis: keep if still < maxDist*1.15 and recently bound)
    for (const v of this.voices) {
      if (v.active && !wantedIds.has(v.vehicleId)) {
        const still = scored.find((p) => p.veh.id === v.vehicleId);
        if (!still || t - v.since > 1.5) this._release(v, t);
      }
    }
    // bind new vehicles to free voices
    let level = 0, n = 0;
    for (const { veh, d } of pick) {
      let voice = this.voices.find((v) => v.active && v.vehicleId === veh.id);
      if (!voice) {
        voice = this.voices.find((v) => !v.active);
        if (!voice) continue;
        this._bind(voice, veh, t);
      }
      this._drive(voice, veh, d, l, s, t, groundHeight);
      level += voice.level; n++;
    }
    this.level = Math.min(1, level);
    this.assigned = n;
    this.targets = { group, voices: n };
    return this.level * group;
  }

  _bind(voice, veh, t) {
    const type = VEHICLE_TYPES[veh.type] ? veh.type : 'car';
    voice.vehicleId = veh.id; voice.type = type; voice.active = true; voice.since = t;
    voice.osc1.setPeriodicWave(this.waves[type]); voice.osc2.setPeriodicWave(this.waves[type]);
    setT(voice.engLP.frequency, VEHICLE_TYPES[type].lp, t, 0.05);
    cancelAt(voice.fade.gain, t);
    setV(voice.fade.gain, 0.0001, t);
    expRamp(voice.fade.gain, 1, t + 0.35);
  }

  _release(voice, t) {
    voice.active = false; voice.vehicleId = null; voice.level = 0;
    cancelAt(voice.fade.gain, t);
    setT(voice.fade.gain, 0, t, 0.12);
  }

  _drive(voice, veh, d, l, s, t, groundHeight) {
    const T = VEHICLE_TYPES[voice.type];
    const y = veh.y != null ? veh.y + 0.8 : (groundHeight ? groundHeight(veh.x, veh.z) : 0) + 0.8;
    voice.x = veh.x; voice.y = y; voice.z = veh.z;
    this._setPos(voice.panner, veh.x, y, veh.z, t, 0.07);
    // doppler from radial velocity toward the listener
    const dx = l.x - veh.x, dy = l.y - y, dz = l.z - veh.z;
    const dist = Math.max(1, Math.hypot(dx, dy, dz));
    const vr = ((veh.vx || 0) * dx + (veh.vz || 0) * dz) / dist;
    const ratio = SPEED_OF_SOUND / Math.max(200, SPEED_OF_SOUND - vr);
    const cents = clamp(1200 * Math.log2(ratio), -160, 160);
    const speed = Math.max(0, Number.isFinite(veh.speed) ? veh.speed : Math.hypot(veh.vx || 0, veh.vz || 0) || 0);
    const spN = clamp01(speed / 18);
    // engine
    const f = lerp(T.idleHz, T.cruiseHz, Math.pow(spN, 0.85));
    setT(voice.osc1.frequency, f, t, 0.12);
    setT(voice.osc2.frequency, f * 1.006, t, 0.12);
    setT(voice.osc1.detune, cents, t, 0.08);
    setT(voice.osc2.detune, cents, t, 0.08);
    setT(voice.rough.frequency, f * 0.5, t, 0.1);
    const eng = T.engine * (0.55 + 0.45 * spN);
    setT(voice.engGain.gain, eng, t, 0.1);
    setT(voice.roughG.gain, eng * 0.25, t, 0.1);
    setT(voice.engLP.frequency, T.lp + 260 * spN, t, 0.15);
    // tyres: level ∝ speed², wet asphalt = louder + brighter splash
    const wet = clamp01(s.wet || 0);
    const tyre = T.tyre * Math.pow(spN, 1.7) * (1 + 0.9 * wet) * 0.6;
    setT(voice.tyreGain.gain, tyre, t, 0.12);
    setT(voice.tyreBP.frequency, (850 + 700 * spN + 900 * wet) * ratio, t, 0.12);
    setT(voice.tyre.playbackRate, ratio, t, 0.08);
    setT(voice.rumGain.gain, T.rumble * (0.5 + 0.5 * spN) * 0.5, t, 0.15);
    // air absorption
    setT(voice.airLP.frequency, clamp(9000 * Math.pow(30 / Math.max(30, dist), 0.8), 600, 9000), t, 0.15);
    voice.level = clamp01(11 / dist) * (0.4 + 0.6 * spN);
  }

  /** Positions of live voices (debug markers). */
  liveVoices() { return this.voices.filter((v) => v.active).map((v) => ({ x: v.x, y: v.y, z: v.z, type: v.type, level: v.level })); }

  dispose() {
    for (const v of this.voices) { for (const k of ['osc1', 'osc2', 'rough', 'tyre', 'rum']) { try { v[k].stop(); } catch (_) { /* ignore */ } } }
  }
}
