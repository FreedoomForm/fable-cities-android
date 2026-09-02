/**
 * Mixer — assembles the whole procedural soundscape on any BaseAudioContext: baked buffers,
 * ambience layers, positional traffic + zone emitters, one-shots, UI kit, reverb send and
 * per-group meters. The same class drives the live game and OfflineAudioContext verification.
 *
 * Groups (mute/solo/meter): wind, city, rain, water, birds, crickets, traffic, zones.
 * Every group has a mixer-owned `post` gain that the group itself never touches, so solo
 * isolation is exact and verifiable (see offline.js).
 */
import { makeBufferSet, loopSource } from './buffers.js';
import { WindLayer, CityLayer, RainLayer, BirdLayer, CricketLayer, WaterLayer } from './layers.js';
import { TrafficEmitters } from './TrafficEmitters.js';
import { ZoneEmitters } from './ZoneEmitters.js';
import { OneShots } from './OneShots.js';
import { UISounds } from './UISounds.js';
import { buildMasterChain } from './AudioCore.js';
import { setT, setVal, num } from './params.js';

export const GROUPS = ['wind', 'city', 'traffic', 'zones', 'water', 'rain', 'birds', 'crickets'];

class Meter {
  constructor(ctx, node) {
    this.an = ctx.createAnalyser();
    this.an.fftSize = 256;
    this.an.smoothingTimeConstant = 0;
    this.buf = new Float32Array(256);
    node.connect(this.an);
    this.rms = 0;
    this.shown = 0;     // slow-release envelope: a pulsed layer (crickets, birds) must not read -inf
    this.peak = 0;
    this.max = 0;
  }
  read() {
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = this.buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    this.rms = Math.sqrt(sum / this.buf.length);
    this.shown = Math.max(this.rms, this.shown * 0.87);
    this.peak = Math.max(peak, this.peak * 0.92);
    if (this.rms > this.max) this.max = this.rms;
    return this.rms;
  }
  get db() { return this.shown > 1e-6 ? 20 * Math.log10(this.shown) : -120; }
}

export class Mixer {
  /**
   * @param ctx BaseAudioContext
   * @param buses master buses from buildMasterChain (or null to build a private chain → ctx.destination)
   * @param rng seeded rng (forked per subsystem inside)
   * @param hooks { pickPosition(kind), listener(), target(), groundHeight(x,z), onEvent(ev), vehicles(), zoneSources(), spawnPassBy(target, type) }
   */
  constructor(ctx, buses, rng, hooks) {
    this.ctx = ctx;
    this.buses = buses || buildMasterChain(ctx, ctx.destination);
    this.rng = rng;
    this.hooks = hooks;
    this.buffers = makeBufferSet(ctx, rng.fork(101));

    // reverb send: city-scale early reflections + tail for positional sources
    const rev = ctx.createConvolver();
    rev.buffer = this.buffers.impulse;
    rev.normalize = true;
    const revSend = ctx.createGain(); setVal(revSend.gain, 1);
    const revReturn = ctx.createGain(); setVal(revReturn.gain, 0.6);
    const revLP = ctx.createBiquadFilter(); revLP.type = 'lowpass'; setVal(revLP.frequency, 4200); setVal(revLP.Q, 0.4);
    revSend.connect(rev); rev.connect(revLP); revLP.connect(revReturn); revReturn.connect(this.buses.sfx);
    this.buses.reverb = rev; this.buses.reverbSend = revSend;

    const b = this.buses;
    this.layers = {
      wind: new WindLayer(ctx, this.buffers, rng.fork(1), b.ambience),
      city: new CityLayer(ctx, this.buffers, rng.fork(2), b.ambience),
      rain: new RainLayer(ctx, this.buffers, rng.fork(3), b.ambience),
      water: new WaterLayer(ctx, this.buffers, rng.fork(8), b.ambience),
      birds: new BirdLayer(ctx, this.buffers, rng.fork(4), b.ambience),
      crickets: new CricketLayer(ctx, this.buffers, rng.fork(5), b.ambience),
    };
    const emitterHooks = { listener: hooks.listener, groundHeight: hooks.groundHeight, reverbSend: revSend };
    this.traffic = new TrafficEmitters(ctx, this.buffers, rng.fork(9), b.ambience, emitterHooks);
    this.zones = new ZoneEmitters(ctx, this.buffers, rng.fork(10), b.ambience, emitterHooks);
    this.groups = { ...this.layers, traffic: this.traffic, zones: this.zones };
    this.oneShots = new OneShots(ctx, b, this.buffers, rng.fork(6), hooks);
    this.ui = new UISounds(ctx, b.ui, this.buffers, rng.fork(7));

    this.meters = {};
    for (const g of GROUPS) this.meters[g] = new Meter(ctx, this.groups[g].post);
    this.meters.events = new Meter(ctx, b.sfx);
    this.meters.ui = new Meter(ctx, b.ui);
    this.meters.master = new Meter(ctx, b.master);
    this.levels = {};     // CPU-side mix targets (0..1-ish), for the HUD
    this.solo = null;
  }

  /** Per-tick: move all params toward the state's targets. `state` from computeMixState(). */
  update(dt, state) {
    const t = this.ctx.currentTime;
    const L = this.layers;
    this.levels.wind = L.wind.update(t, state);
    this.levels.city = L.city.update(t, state);
    this.levels.rain = L.rain.update(t, state);
    this.levels.water = L.water.update(t, state);
    this.levels.birds = L.birds.update(t, state);
    this.levels.crickets = L.crickets.update(t, state);
    const vehicles = this.hooks.vehicles ? this.hooks.vehicles(dt, state) : null;
    this.levels.traffic = this.traffic.update(dt, t, state, vehicles, this.hooks.groundHeight);
    const sources = this.hooks.zoneSources ? this.hooks.zoneSources(state) : null;
    this.levels.zones = this.zones.update(dt, t, state, sources);
    this.oneShots.update(dt, t, state);
  }

  /**
   * Clock jumped (time:set / a screenshot preset): cancel every scheduled ambience voice so a
   * daytime bird call cannot keep singing three hours later, and drop the one-shots that are in
   * flight for the same reason.
   */
  flushSchedules() {
    const t = this.ctx.currentTime;
    this.layers.birds.flush(t);
    this.layers.crickets.flush(t);
  }

  /** Mute/solo. `setSolo(null)` restores everything. */
  setMuted(group, muted) { const g = this.groups[group]; if (g) g.setMuted(muted); }
  setSolo(group) {
    this.solo = group || null;
    for (const k of GROUPS) this.groups[k].setMuted(!!group && k !== group);
  }

  /** Camera → listener. forward/up are unit vectors. */
  setListener(pos, forward, up) {
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      setT(l.positionX, pos.x, t, 0.05); setT(l.positionY, pos.y, t, 0.05); setT(l.positionZ, pos.z, t, 0.05);
      setT(l.forwardX, forward.x, t, 0.05); setT(l.forwardY, forward.y, t, 0.05); setT(l.forwardZ, forward.z, t, 0.05);
      setT(l.upX, up.x, t, 0.05); setT(l.upY, up.y, t, 0.05); setT(l.upZ, up.z, t, 0.05);
    } else if (l.setPosition) {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Per-group level with a slow release (what the HUD shows); `meterMax` keeps the raw peaks. */
  readMeters() {
    const out = {};
    for (const k in this.meters) { const m = this.meters[k]; m.read(); out[k] = m.shown; }
    return out;
  }
  /** Highest RMS seen per meter since construction (offline isolation checks). */
  meterMax() {
    const out = {};
    for (const k in this.meters) out[k] = this.meters[k].max;
    return out;
  }

  dispose() {
    try {
      for (const k in this.layers) { const l = this.layers[k]; for (const key in l) { const n = l[key]; if (n && typeof n.stop === 'function') { try { n.stop(); } catch (_) { /* already stopped */ } } } }
      this.traffic.dispose();
      this.zones.dispose();
    } catch (_) { /* ignore */ }
  }
}

// ------------------------------------------------------------------------------------------------
/**
 * Compute the per-tick mix state from world + camera. Pure function of its inputs (plus the gust
 * generator value) so it can be unit-tested and reused by the offline renderer.
 *
 *   world.env: nightFactor, weather, precipitation (FALLING rain/snow 0..1), wetness / rain (surface
 *              wetness), snow (snow COVER), fogDensity, windStrength, temperature
 *   world.economy.population, world.traffic.vehicles (count)
 *
 * Rain audio follows env.precipitation gated by the weather (rain vs snow); wetness only drives
 * gutter runoff and tyre splash. The snow muffle blends falling snow with steady-state cover.
 */
export function computeMixState({ world, cameraY, groundY, gust, override, water = 0, forest = 0 }) {
  // Every input is sanitised here (num → finite or default): a NaN anywhere upstream (terrain not
  // ready, a module writing a non-number) must never reach an AudioParam or a scheduler.
  const env = world.env || {};
  const hour = ((num(world.time && world.time.hour, 12) % 24) + 24) % 24;
  const altitude = Math.max(0, num(cameraY, 60) - num(groundY, 0));
  const altN = smooth01((altitude - 15) / 900);
  const population = Math.max(0, num(override?.population ?? world.economy?.population, 0));
  // Workers make city noise too: an office/industrial district with few residents is still loud.
  const jobs = Math.max(0, num(override?.jobs ?? world.economy?.jobs, 0));
  const rawVehicles = override?.vehicles ?? countOf(world.traffic?.vehicles);
  const vehicles = Math.max(0, num(rawVehicles, 0));
  const urban = 1 - Math.exp(-(population + 0.75 * jobs) / 9000);   // 0 … 1, saturating ~25 k people present
  const traffic = 1 - Math.exp(-vehicles / 110);              // 0 … 1 saturating around 350 vehicles
  const rushAM = Math.exp(-Math.pow((hour - 8.2) / 1.6, 2));
  const rushPM = Math.exp(-Math.pow((hour - 17.6) / 1.9, 2));
  const night = clamp01(num(env.nightFactor, 0));
  const dayBase = 0.35 + 0.35 * (1 - night);
  const trafficHour = Math.min(1, dayBase + 0.45 * Math.max(rushAM, rushPM));
  const weather = typeof env.weather === 'string' ? env.weather : 'clear';
  const fog = weather === 'fog' ? 1 : clamp01((num(env.fogDensity, 0.00012) - 0.00012) / 0.0008);
  const temp = num(env.temperature, 18);
  const storm = weather === 'storm' || weather === 'thunderstorm';
  const rainy = weather === 'rain' || storm;
  const snowy = weather === 'snow';
  // Falling precipitation: env.precipitation is authoritative when the environment writes it. Without
  // it, honour BOTH the weather preset name and the spec's `world.env.rain > 0` trigger (a producer
  // that only writes env.rain still gets rain audio; env.rain then doubles as wetness below).
  const hasPrecip = Number.isFinite(env.precipitation);
  const precip = clamp01(hasPrecip ? env.precipitation : Math.max(rainy || snowy ? 1 : 0, clamp01(num(env.rain, 0))));
  // rain vs snow split: the sky decides, temperature breaks ties while presets cross-fade
  const isSnowfall = snowy || (!rainy && temp < 0.5);
  const rain = isSnowfall ? 0 : precip;
  const snowfall = isSnowfall ? precip : 0;
  const wet = clamp01(num(env.wetness ?? env.rain, rainy ? 1 : 0));
  const snowCover = clamp01(num(env.snow, 0));
  const snow = clamp01(0.75 * snowfall + 0.65 * snowCover);      // muffle amount
  return {
    hour,
    night,
    rain,
    wet,
    snowfall,
    snowCover,
    snow,
    water: clamp01(num(water, 0)),
    forest: clamp01(num(forest, 0)),
    fog,
    weather,
    storm,
    wind: clamp01(num(env.windStrength, 0.3)),
    gust: clamp01(num(gust, 0.4)),
    temp,
    altitude,
    altN,
    population,
    jobs,
    vehicles,
    urban,
    traffic,
    trafficHour,
  };
}
/** Vehicle count from whatever the traffic module publishes: number, array, Map/Set or object with .length/.size. */
function countOf(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v.size === 'number') return v.size;
  if (typeof v.length === 'number') return v.length;
  return 0;
}

/** Smooth, seeded gust generator: slow sines + occasional gust fronts. Value in [0, 1]. */
export class GustGenerator {
  constructor(rng) {
    this.rng = rng;
    this.p1 = rng() * 6.28; this.p2 = rng() * 6.28; this.p3 = rng() * 6.28;
    this.front = 0;
    this.frontT = 0;
    this.frontDur = 0;
    this.nextFront = 4 + rng() * 8;
    this.value = 0.4;
    this.t = 0;
  }
  update(dt, windStrength) {
    this.t += dt;
    const t = this.t;
    const base = 0.42 + 0.22 * Math.sin(t * 0.31 + this.p1) + 0.14 * Math.sin(t * 0.83 + this.p2) + 0.08 * Math.sin(t * 1.9 + this.p3);
    this.nextFront -= dt;
    if (this.nextFront <= 0 && this.frontDur <= 0) {
      this.frontDur = 2.5 + this.rng() * 4;
      this.frontT = 0;
      this.nextFront = 5 + this.rng() * (22 - 14 * windStrength);
    }
    let front = 0;
    if (this.frontDur > 0) {
      this.frontT += dt;
      const x = this.frontT / this.frontDur;
      front = x >= 1 ? 0 : Math.sin(Math.PI * Math.min(1, x)) * (0.35 + 0.45 * windStrength);
      if (x >= 1) this.frontDur = 0;
    }
    const target = clamp01(base * (0.6 + 0.6 * windStrength) + front);
    this.value += (target - this.value) * Math.min(1, dt * 2.5);
    return this.value;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v === v ? v : 0; }
function smooth01(x) { x = clamp01(x); return x * x * (3 - 2 * x); }

export { loopSource };
