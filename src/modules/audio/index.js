/**
 * audio module — procedural Web Audio soundscape for Fable Cities (no downloaded audio).
 *
 *  • Ambience layers: wind (baked wind texture, camera altitude × world.env.windStrength, gust fronts,
 *    foliage rustle in forests), city hum + traffic wash (population / vehicle count, rush hours,
 *    10–12 dB under the wind at max altitude), birds by day (9 synthesised species with formant/noise
 *    components and outdoor early reflections), crickets at night, rain hiss/drops driven by FALLING
 *    precipitation (env.precipitation) with gutter runoff from surface wetness, thunder in storms,
 *    weather muffling (falling snow + snow cover, fog, heavy rain).
 *  • Positional emitters (camera = listener, PannerNodes, doppler, air absorption, reverb send):
 *    traffic voices attached to vehicles (world.traffic list, or virtual vehicles riding the real lane
 *    graph until the traffic module publishes one), zone/building ambiences by lot type (industrial
 *    machinery, commercial crowd, residential dogs/HVAC, office HVAC, construction hammer/drill/beeper,
 *    park fountain), sirens, horns, clock-tower bell.
 *  • Synthesised UI kit (hover / click / toggle / select / place / road / zone / bulldoze / notification /
 *    warning / error / levelup / cash / open / close) triggered by DOM interaction in #ui-root and game events.
 *  • Starts on the first user gesture (or immediately when autoplay is allowed). Zero errors/warnings when blocked.
 *  • Master volume + mute: events 'audio:volume' (number | {master, ambience, sfx, ui, muted}) and 'audio:mute'.
 *
 * Public API: world.audio.api (see buildApi below). Debug HUD: ?audiodebug=1 or api.setDebug(true).
 */
import * as THREE from 'three';
import { AudioCore } from './AudioCore.js';
import { Mixer, computeMixState, GustGenerator, GROUPS } from './Mixer.js';
import { VehicleSim, readVehicles } from './TrafficEmitters.js';
import { collectZoneSources } from './ZoneEmitters.js';
import { EmitterMarkers } from './EmitterMarkers.js';
import { Overlay } from './Overlay.js';
import { renderOffline } from './offline.js';
import { UI_SOUND_NAMES } from './UISounds.js';
import { guard } from './params.js';
import { hashString } from '../../shared/random.js';
import { clamp01 } from '../../shared/math.js';

export const name = 'audio';

const UI_SELECTOR = 'button, [role="button"], a, input, select, textarea, label, .btn, [data-sound]';
const UPDATE_HZ = 24;

let S = null; // module state

export async function init(ctx) {
  const { engine, scene, world, events, config, camera, cameraController, uiRoot } = ctx;
  const rng = world.rng.fork(hashString('audio'));
  const core = new AudioCore({ events, config });

  S = {
    ctx, engine, scene, world, events, config, camera, cameraController, uiRoot,
    rng, core, mixer: null, markers: null, overlay: null,
    gust: new GustGenerator(rng.fork(3)),
    gustValue: 0.4,
    waterFraction: 0,
    forestFraction: 0,
    mixState: null,
    simulated: null,          // { vehicles, population, lots } override (showcase / debugging)
    sim: new VehicleSim(world, rng.fork(21)),
    prevVehicles: new Map(),
    zoneCache: { at: -1e9, list: [] },
    debug: config.get('audiodebug') === '1',
    ready: false,             // game:ready seen → world events may trigger UI sounds
    acc: 0,
    lastHoverEl: null,
    rate: { place: 0, road: 0, zone: 0, bulldoze: 0, levelup: 0 },
    tmpF: new THREE.Vector3(), tmpU: new THREE.Vector3(),
    listenerPos: { x: 0, y: 0, z: 0 },
    disposers: [],
    eventRateScale: 1,
    prevHour: null,           // clock-jump detection (time:set / screenshot presets)
    debugAllowed: config.get('audiodebug') !== '0',   // ?audiodebug=0 forces the whole debug view off
  };

  // Build the graph when the context arrives (immediately if autoplay is allowed, else on gesture).
  core.onGraph((actx, buses) => {
    try {
      S.mixer = new Mixer(actx, buses, rng.fork(11), {
        pickPosition,
        listener: () => S.listenerPos,
        target: () => cameraTarget(),
        groundHeight: (x, z) => world.terrain.getHeight(x, z),
        onEvent: (e) => events.emit('audio:event', { kind: e.kind, variant: e.variant, x: e.x, z: e.z, distance: e.distance, duration: e.end - e.start }),
        vehicles: (dt, state) => vehiclesForAudio(dt, state),
        zoneSources: (state) => zoneSourcesForAudio(state),
        spawnPassBy: (target, type) => S.sim.spawnPassBy(target, type),
      });
      S.mixer.oneShots.rateScale = S.eventRateScale;
      if (config.debug) console.log(`[audio] graph ready · ${actx.sampleRate} Hz · buffers ${S.mixer.buffers.buildMs.toFixed(1)} ms`);
    } catch (err) {
      console.error('[audio] failed to build mixer', err);
    }
  });

  world.audio = { api: buildApi(), get state() { return core.state; }, get settings() { return { ...core.settings }; } };

  wireEvents();
  wireDom();
  if (S.debug) setDebug(true);

  // never blocks init; the probe resolves in the background
  core.start({ eager: true }).catch(() => {});
}

export function update(dt) {
  if (!S) return;
  // The engine logs any exception thrown here as a console error; audio must never be the reason a
  // headless run fails, so the tick is fenced and problems are counted in `guard` (HUD + getState).
  try { tick(dt); } catch (err) { guard.caught++; guard.last = `update: ${err && err.message ? err.message : err}`; if (S.config.debug) console.debug('[audio] update failed', err); }
}

function tick(dt) {
  const { core, world, camera } = S;
  // gust generator runs regardless of context (keeps HUD honest)
  S.gustValue = S.gust.update(dt, clamp01(world.env.windStrength ?? 0.3));

  // A jump in the clock (time:set, a screenshot preset, 4× speed) must not leave scheduled bird
  // calls or cricket chirps ringing into the wrong part of the day.
  const hour = +world.time?.hour;
  if (Number.isFinite(hour)) {
    if (S.prevHour != null) {
      let d = Math.abs(hour - S.prevHour);
      if (d > 12) d = 24 - d;
      if (d > 0.4) S.mixer?.flushSchedules();
    }
    S.prevHour = hour;
  }

  S.acc += dt;
  const step = 1 / UPDATE_HZ;
  if (S.acc >= step) {
    const groundY = world.terrain.getHeight(camera.position.x, camera.position.z);
    sampleSurroundings();
    S.mixState = computeMixState({ world, cameraY: camera.position.y, groundY, gust: S.gustValue, override: S.simulated, water: S.waterFraction, forest: S.forestFraction });
    if (S.mixer && core.running) {
      camera.getWorldDirection(S.tmpF);
      S.tmpU.set(0, 1, 0).applyQuaternion(camera.quaternion);
      // The listener sits at the camera's HEIGHT but drifts horizontally onto the camera's focus
      // point as the view pulls back: at the kerb you hear where you stand, from 300 m up you hear
      // the district you are looking at (a city builder listens with its eyes) — distance
      // attenuation with altitude is unaffected because the height is still the camera's.
      const tgt = cameraTarget();
      const bias = 0.3 + 0.55 * clamp01((S.mixState.altitude - 30) / 190);
      S.listenerPos.x = camera.position.x + (tgt.x - camera.position.x) * bias;
      S.listenerPos.y = camera.position.y;
      S.listenerPos.z = camera.position.z + (tgt.z - camera.position.z) * bias;
      S.mixer.setListener(S.listenerPos, S.tmpF, S.tmpU);
      S.mixer.update(S.acc, S.mixState);
      applyWeatherMuffle(S.mixState);
    }
    S.acc = 0;
  }
  if (S.markers && S.mixer) S.markers.update(dt, S.mixer.oneShots.active, core.now, S.mixer.traffic.liveVoices(), S.mixer.zones.liveVoices());
  if (S.overlay && S.overlay.due(dt)) S.overlay.update(gatherOverlayInfo());
}

export function dispose() {
  if (!S) return;
  for (const off of S.disposers) { try { off(); } catch (_) { /* ignore */ } }
  S.markers?.dispose();
  S.overlay?.el.remove();
  S.mixer?.dispose();
  S.core.dispose();
  if (S.world.audio) S.world.audio.api = null;
  S = null;
}

// ------------------------------------------------------------------------------------------ helpers
const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
function cameraTarget() {
  const t = S.cameraController?.target;
  return t ? { x: t.x, z: t.z } : { x: S.camera.position.x, z: S.camera.position.z };
}
/** Water and forest fractions around the camera target (two rings, 45 m and 130 m). */
function sampleSurroundings() {
  const { world } = S;
  const t = cameraTarget();
  const terrain = world.terrain;
  if (!terrain.ready) { S.waterFraction = 0; S.forestFraction = 0; return; }
  const biome = terrain.api && typeof terrain.api.biome === 'function' ? terrain.api.biome : null;
  let n = 0, water = 0, forest = 0;
  for (const r of [45, 130]) {
    const w = r === 45 ? 1.4 : 0.8;
    for (const [dx, dz] of RING) {
      n++;
      const x = t.x + dx * r, z = t.z + dz * r;
      if (typeof terrain.isWater === 'function' && terrain.isWater(x, z)) { water += w; continue; }
      if (biome) {
        const b = biome(x, z);
        if (b === 'forest') forest += w; else if (b === 'grass' || b === 'meadow') forest += w * 0.12;
      }
    }
  }
  S.waterFraction = Math.min(1, water / (n * 0.9));
  S.forestFraction = Math.min(1, forest / (n * 0.9));
}
function applyWeatherMuffle(s) {
  let cutoff = 20000;
  if (s.snow > 0) cutoff = Math.min(cutoff, 20000 - 16500 * s.snow);
  if (s.fog > 0) cutoff = Math.min(cutoff, 20000 - 11000 * s.fog);
  if (s.rain > 0.6) cutoff = Math.min(cutoff, 20000 - 7000 * (s.rain - 0.6) / 0.4);
  S.core.setMuffle(cutoff, 1.0);
}

/** Vehicles for the traffic emitters: the traffic module's list when it publishes one, else virtual vehicles on the lane graph. */
function vehiclesForAudio(dt, state) {
  const target = cameraTarget();
  const real = readVehicles(S.world, S.prevVehicles, dt);
  const wanted = real || state.altN > 0.7 ? 0 : Math.round(Math.min(10, 2 + 9 * state.traffic * state.trafficHour));
  const virtual = S.sim.update(dt, target, wanted, 260);
  return real ? real.concat(virtual) : virtual;
}
/** Zone/building clusters near the camera target, recomputed twice a second. */
function zoneSourcesForAudio(state) {
  if (state.altN > 0.75) return [];
  const now = performance.now();
  if (now - S.zoneCache.at > 500) {
    S.zoneCache.at = now;
    S.zoneCache.list = collectZoneSources(S.world, cameraTarget(), S.simulated?.lots);
  }
  return S.zoneCache.list;
}

/** Choose a world position for an ambient one-shot: on a road if we have any, else around the camera target. */
function pickPosition(kind) {
  const { world, rng } = S;
  const target = cameraTarget();
  if (kind === 'bell') {
    const list = world.buildings?.list || [];
    if (list.length) {
      let x = 0, z = 0;
      for (const b of list) { x += b.x; z += b.z; }
      x /= list.length; z /= list.length;
      return { x, y: world.terrain.getHeight(x, z), z };
    }
    return { x: target.x + 60, y: world.terrain.getHeight(target.x + 60, target.z - 40), z: target.z - 40 };
  }
  const segs = world.roads?.segments;
  if (segs && segs.size > 0) {
    const near = [];
    for (const seg of segs.values()) {
      const pts = seg.points;
      if (!pts || !pts.length) continue;
      const p = pts[Math.floor(pts.length / 2)];
      const d = Math.hypot(p.x - target.x, p.z - target.z);
      if (d < 900) near.push(seg);
    }
    const pool = near.length ? near : [...segs.values()].filter((s) => s.points && s.points.length);
    if (pool.length) {
      const seg = pool[Math.floor(rng() * pool.length)];
      const p = seg.points[Math.floor(rng() * seg.points.length)];
      return { x: p.x, y: p.y ?? world.terrain.getHeight(p.x, p.z), z: p.z };
    }
  }
  const r = kind === 'siren' ? 140 + rng() * 320 : 70 + rng() * 260;
  const a = rng() * Math.PI * 2;
  const x = target.x + Math.cos(a) * r, z = target.z + Math.sin(a) * r;
  return { x, y: world.terrain.getHeight(x, z), z };
}

function setDebug(on) {
  // ?audiodebug=0 is an explicit "no audio debug view at all" — the showcase may not override it.
  S.debug = !!on && S.debugAllowed;
  if (S.debug) {
    if (!S.overlay) S.overlay = new Overlay(S.uiRoot || document.body);
    S.overlay.setVisible(true);
    if (!S.markers) S.markers = new EmitterMarkers(S.scene, S.world, S.engine, S.camera);
    S.markers.enabled = true;
  } else {
    if (S.overlay) S.overlay.setVisible(false);
    if (S.markers) { S.markers.enabled = false; S.markers.clear(); }
  }
}

function simulationNote() {
  const g = guard.skipped || guard.caught ? ` · param guard: ${guard.skipped} skipped, ${guard.caught} caught` : '';
  if (!S.simulated) return (S.eventRateScale !== 1 ? `events ×${S.eventRateScale}` : '') + g;
  if (S.simulated.label) return S.simulated.label + g;
  const parts = [];
  if (S.simulated.population != null) parts.push('population');
  if (S.simulated.vehicles != null) parts.push('vehicle count');
  if (S.simulated.lots) parts.push(`${S.simulated.lots.length} lots`);
  return `simulated: ${parts.join(', ')}` + g;
}

function gatherOverlayInfo() {
  const m = S.mixer;
  return {
    state: S.core.state,
    sampleRate: S.core.ctx?.sampleRate,
    settings: S.core.settings,
    levels: m?.levels,
    meters: m && S.core.running ? m.readMeters() : null,
    mixState: S.mixState,
    analyser: S.core.running ? S.core.analyser : null,
    log: m?.oneShots.log,
    active: m?.oneShots.active,
    counts: m?.oneShots.counts,
    oneShotLevel: m ? Math.min(1, m.oneShots.active.reduce((a, e) => a + (e.level || 0), 0)) : 0,
    uiLast: m?.ui.lastPlayed?.t,
    now: S.core.now,
    traffic: m ? { voices: m.traffic.assigned, vehicles: S.sim.vehicles.length + (S.prevVehicles.size || 0) } : null,
    zones: m ? { voices: m.zones.assigned, clusters: S.zoneCache.list.length, live: m.zones.liveVoices() } : null,
    birds: m ? m.layers.birds.lastCall : null,
    note: simulationNote(),
  };
}

/** UI kit entry point. Accepts a name, or an object payload `{ name|sound|kind, gain }` from an event. */
function playUI(name, opts) {
  let nm = name, o = opts;
  if (name && typeof name === 'object') { o = name; nm = name.name ?? name.sound ?? name.kind; }
  if (!S.mixer || !S.core.running) return false;
  return S.mixer.ui.play(nm, o && typeof o === 'object' ? o : undefined);
}
function rateOk(key, minInterval) {
  const now = performance.now() / 1000;
  if (now - S.rate[key] < minInterval) return false;
  S.rate[key] = now;
  return true;
}

function wireEvents() {
  const { events, core, world } = S;
  const on = (ev, fn) => S.disposers.push(events.on(ev, fn));
  on('audio:volume', (v) => core.setVolume(v));
  on('audio:mute', (m) => core.setMuted(m));
  on('audio:play', (nm, opts) => playUI(nm, opts));
  on('audio:sfx', (p) => { if (p && p.kind) playWorld(p.kind, p); });
  on('game:ready', () => { S.ready = true; });
  on('tool:changed', () => { if (S.ready) playUI('toggle'); });
  on('entity:selected', (sel) => { if (S.ready && sel) playUI('select'); });
  on('notification', (n) => {
    if (!S.ready) return;
    const kind = (n && n.kind) || 'info';
    playUI(kind === 'error' ? 'error' : kind === 'warning' || kind === 'warn' ? 'warning' : kind === 'money' || kind === 'income' ? 'cash' : 'notification');
  });
  on('roads:changed', () => { if (S.ready && rateOk('road', 0.25) && world.tool.active === 'road') playUI('road'); });
  on('zones:changed', () => { S.zoneCache.at = -1e9; if (S.ready && rateOk('zone', 0.18) && world.tool.active === 'zone') playUI('zone'); });
  on('building:added', (b) => {
    S.zoneCache.at = -1e9;
    if (!S.ready || !rateOk('place', 0.25)) return;
    const manual = (b && (b.manual || b.byPlayer)) || ['service', 'building', 'place', 'park', 'plop'].includes(world.tool.active);
    if (manual) playUI('place');
  });
  on('building:removed', () => { S.zoneCache.at = -1e9; if (S.ready && rateOk('bulldoze', 0.2) && world.tool.active === 'bulldoze') playUI('bulldoze'); });
  on('building:levelup', () => { if (S.ready && rateOk('levelup', 3)) playUI('levelup', { gain: 0.6 }); });
}

function wireDom() {
  const root = S.uiRoot;
  if (!root) return;
  const overHandler = (e) => {
    const el = e.target && e.target.closest ? e.target.closest(UI_SELECTOR) : null;
    if (!el || el === S.lastHoverEl) return;
    S.lastHoverEl = el;
    const snd = el.getAttribute('data-sound-hover') || 'hover';
    if (snd !== 'none') playUI(snd);
  };
  const outHandler = (e) => {
    if (e.target === S.lastHoverEl && !(e.relatedTarget && S.lastHoverEl.contains(e.relatedTarget))) S.lastHoverEl = null;
  };
  const clickHandler = (e) => {
    const el = e.target && e.target.closest ? e.target.closest(UI_SELECTOR) : null;
    if (!el) return;
    const snd = el.getAttribute('data-sound') || 'click';
    if (snd !== 'none') playUI(snd);
  };
  const changeHandler = (e) => {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.type !== 'range') playUI('toggle');
  };
  root.addEventListener('pointerover', overHandler, true);
  root.addEventListener('pointerout', outHandler, true);
  root.addEventListener('click', clickHandler, true);
  root.addEventListener('change', changeHandler, true);
  S.disposers.push(() => {
    root.removeEventListener('pointerover', overHandler, true);
    root.removeEventListener('pointerout', outHandler, true);
    root.removeEventListener('click', clickHandler, true);
    root.removeEventListener('change', changeHandler, true);
  });
}

/**
 * Sanitise a caller-supplied world position: non-finite coordinates are rejected outright (the
 * emitter then picks its own position) and everything else is clamped into the map so a stray
 * 1e9 cannot park a panner at infinity. `y` falls back to the terrain height.
 */
function sanitizePos(p) {
  if (!p || typeof p !== 'object') return null;
  const x = +p.x, z = +p.z;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const half = Number.isFinite(S.world.half) ? S.world.half : 1024;
  const cx = Math.max(-half, Math.min(half, x));
  const cz = Math.max(-half, Math.min(half, z));
  let y = +p.y;
  if (!Number.isFinite(y)) y = S.world.terrain.getHeight(cx, cz);
  if (!Number.isFinite(y)) y = 0;
  return { x: cx, y: Math.max(-500, Math.min(2000, y)), z: cz };
}

function playWorld(kind, p = {}) {
  if (!S.mixer || !S.core.running) return null;
  if (p && typeof p !== 'object') p = {};
  const os = S.mixer.oneShots;
  const pos = sanitizePos(p);
  switch (kind) {
    case 'siren': return os.siren(pos, p.variant || null);
    case 'horn': return os.horn(pos);
    case 'thunder': return os.thunder(S.mixState, typeof p.near === 'boolean' ? p.near : null);
    case 'bell': return os.bell(Number.isFinite(+p.hour) ? +p.hour : Math.floor(S.world.time.hour));
    case 'carpass': return os.carPass(S.mixState || { altN: 0 }, p.variant || p.type || null);
    default: return null;
  }
}

/**
 * Hostile-input self test: throws NaN / Infinity / strings / out-of-world coordinates at every public
 * entry point and reports what the guards caught. `guardDelta.skipped` counts non-finite AudioParam
 * writes that were REFUSED — it must stay 0 for positions (they are rejected before an emitter spawns)
 * and every spawned event must carry finite coordinates. Volume/mute settings are restored afterwards.
 */
function selfTest() {
  const before = { skipped: guard.skipped, caught: guard.caught };
  const settings = { ...S.core.settings };
  const out = { cases: 0, throws: [], guardDelta: null, spawned: 0, allFinite: true, unknownNames: null };
  const run = (label, fn) => { out.cases++; try { fn(); } catch (err) { out.throws.push(`${label}: ${err && err.message ? err.message : err}`); } };
  const nasty = [NaN, Infinity, -Infinity, null, undefined, 'loud', {}, [], -5, 1e9];
  for (const v of nasty) {
    run(`volume(${String(v)})`, () => S.events.emit('audio:volume', v));
    run(`mute(${String(v)})`, () => S.events.emit('audio:mute', v));
    run(`play(${String(v)})`, () => S.events.emit('audio:play', v));
    run(`sfx(${String(v)})`, () => S.events.emit('audio:sfx', v));
  }
  const activeBefore = S.mixer ? S.mixer.oneShots.active.length : 0;
  for (const v of [NaN, 1e9]) {
    run(`playWorld siren ${String(v)}`, () => playWorld('siren', { x: v, z: v }));
    run(`playWorld horn ${String(v)}`, () => playWorld('horn', { x: v, y: v, z: v }));
    run(`sfx carpass ${String(v)}`, () => S.events.emit('audio:sfx', { kind: 'carpass', x: v, z: v }));
  }
  run('play alias notify', () => S.events.emit('audio:play', 'notify'));
  run('play alias warn', () => S.events.emit('audio:play', 'warn'));
  run('toggle twice', () => { S.world.audio.api.toggle(); S.world.audio.api.toggle(); });
  // restore the mix settings the test just scribbled on
  S.core.setVolume({ master: settings.master, ambience: settings.ambience, sfx: settings.sfx, ui: settings.ui });
  S.core.setMuted(!!settings.muted);
  if (S.mixer) {
    const act = S.mixer.oneShots.active;
    out.spawned = act.length - activeBefore;
    out.allFinite = act.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z));
    out.unknownNames = { ...S.mixer.ui.unknown };
  }
  out.guardDelta = { skipped: guard.skipped - before.skipped, caught: guard.caught - before.caught };
  out.settingsRestored = JSON.stringify({ ...S.core.settings }) === JSON.stringify(settings);
  return out;
}

function buildApi() {
  return {
    /** Start audio now (call from a user-gesture handler). Safe to call any time. */
    unlock: () => S.core.unlock(),
    get state() { return S.core.state; },
    get running() { return S.core.running; },
    get context() { return S.core.ctx; },
    setVolume: (v) => S.core.setVolume(v),
    setMuted: (m) => S.core.setMuted(m),
    /** ARCHITECTURE §5 name for the mute toggle; `toggleMute` is kept as an alias. */
    toggle: () => S.core.setMuted(undefined),
    toggleMute: () => S.core.setMuted(undefined),
    getSettings: () => ({ ...S.core.settings }),
    /** UI kit: play a named sound. */
    play: (nm, opts) => playUI(nm, opts),
    sounds: UI_SOUND_NAMES.slice(),
    /** World one-shots: kind = 'siren' | 'horn' | 'thunder' | 'bell' | 'carpass', at {x, z} (optional). */
    playWorld: (kind, opts) => playWorld(kind, opts),
    /** Debug HUD + emitter markers. */
    setDebug: (on) => setDebug(on),
    get debug() { return S.debug; },
    /** Mix groups: mute one or solo one (null = restore). */
    groups: GROUPS.slice(),
    setGroupMuted: (g, m) => { S.mixer?.setMuted(g, m); },
    setSolo: (g) => { S.mixer?.setSolo(g); },
    /** Override vehicles/population/lots for the mix (showcase, tuning). Pass null to clear. lots: [{x,z,type,w,d,state?}]. */
    setSimulatedCity: (o) => {
      S.simulated = o && typeof o === 'object' ? { vehicles: o.vehicles, population: o.population, jobs: o.jobs, lots: Array.isArray(o.lots) ? o.lots : null, label: typeof o.label === 'string' ? o.label : null } : null;
      S.zoneCache.at = -1e9;
    },
    /** Scale the random-event rate (sirens, horns, thunder). */
    setEventRate: (scale) => { S.eventRateScale = Math.max(0, +scale || 1); if (S.mixer) S.mixer.oneShots.rateScale = S.eventRateScale; },
    /** Snapshot for critics/tests. */
    getState: () => ({
      state: S.core.state,
      running: S.core.running,
      sampleRate: S.core.ctx?.sampleRate || 0,
      currentTime: S.core.now,
      settings: { ...S.core.settings },
      mix: S.mixState,
      levels: S.mixer ? { ...S.mixer.levels } : null,
      meters: S.mixer && S.core.running ? S.mixer.readMeters() : null,
      birds: S.mixer ? { activity: S.mixer.layers.birds.activity, calls: S.mixer.layers.birds.calls, last: S.mixer.layers.birds.lastCall } : null,
      crickets: S.mixer ? { activity: S.mixer.layers.crickets.activity } : null,
      traffic: S.mixer ? { voices: S.mixer.traffic.liveVoices(), virtualVehicles: S.sim.vehicles.map((v) => ({ id: v.id, type: v.type, x: Math.round(v.x), z: Math.round(v.z), speed: +v.speed.toFixed(1), onLane: !!v.rec })) } : null,
      zones: S.mixer ? { voices: S.mixer.zones.liveVoices(), clusters: S.zoneCache.list.map((c) => ({ cat: c.cat, x: Math.round(c.x), z: Math.round(c.z), weight: +c.weight.toFixed(1), count: c.count })), grains: { ...S.mixer.zones.counts } } : null,
      events: S.mixer ? { active: S.mixer.oneShots.active.map((e) => ({ kind: e.kind, variant: e.variant, x: Math.round(e.x), z: Math.round(e.z), level: e.level })), counts: { ...S.mixer.oneShots.counts }, log: S.mixer.oneShots.log.slice() } : null,
      ui: S.mixer ? { counts: { ...S.mixer.ui.counts }, last: S.mixer.ui.lastPlayed, unknown: { ...S.mixer.ui.unknown } } : null,
      buffersMs: S.mixer?.buffers.buildMs,
      /** guarded AudioParam writes that were skipped (non-finite) or threw — must stay 0 */
      guard: { ...guard },
      simulated: S.simulated ? { population: S.simulated.population, vehicles: S.simulated.vehicles, lots: S.simulated.lots ? S.simulated.lots.length : 0 } : null,
    }),
    /** Hostile-input self test (NaN/Infinity/strings on every public entry point). */
    selfTest: () => selfTest(),
    /** Offline verification render (no speakers needed): returns RMS/band statistics for a fixed state. */
    renderOffline: (opts) => renderOffline({ ...opts, world: S.world, lots: opts?.lots ?? S.simulated?.lots ?? undefined, rng: S.rng.fork(hashString('offline:' + JSON.stringify(opts || {}))) }),
  };
}
