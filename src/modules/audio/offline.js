/**
 * Offline verification renders: build the full mixer on an OfflineAudioContext, hold a fixed mix
 * state (optionally firing one-shots / UI sounds), render N seconds and return level/band statistics.
 * This is the audio equivalent of a screenshot — used by tools and critics to prove each group
 * produces the expected spectrum without listening.
 *
 * `solo` isolates ONE group through the mixer-owned post gains and ASSERTS isolation: the per-group
 * meters are sampled at every step and the render fails loudly (`isolation.ok === false`, plus a
 * thrown error unless `allowLeak`) when any non-solo group rises above -80 dBFS.
 */
import { Mixer, computeMixState, GROUPS } from './Mixer.js';
import { buildMasterChain } from './AudioCore.js';
import { VehicleSim } from './TrafficEmitters.js';
import { collectZoneSources } from './ZoneEmitters.js';
import { setVal, guard, resetGuard } from './params.js';

const BANDS = [[20, 80, 'sub'], [80, 250, 'low'], [250, 1000, 'lowmid'], [1000, 3000, 'mid'], [3000, 7000, 'high'], [7000, 16000, 'air']];
const LEAK_DB = -80;

/**
 * @param {object} o
 *   seconds (4), sampleRate (48000), stepHz (30)
 *   state: partial mix-state override { hour, night, rain, wet, snowfall, snowCover, fog, wind, gust, temp, altitude, altN, population, vehicles, forest, water }
 *   events: [{ kind:'siren'|'horn'|'thunder'|'bell'|'carpass', at: seconds, x?, z?, variant?, near?, hour? }]
 *   ui: [{ name, at }]
 *   solo: group to keep — 'wind'|'city'|'traffic'|'zones'|'water'|'rain'|'birds'|'crickets'|null
 *   vehicles: number of virtual vehicles to simulate around the listener (default from state.vehicles)
 *   lots: simulated lot records [{ x, z, type, w, d, state? }] for zone emitters (default: world.zones.lots)
 *   allowLeak: do not throw when isolation is broken (result still reports it)
 */
export async function renderOffline(o = {}) {
  const seconds = o.seconds ?? 4;
  const sr = o.sampleRate ?? 48000;
  const stepHz = o.stepHz ?? 30;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext unsupported');
  if (o.solo && !GROUPS.includes(o.solo)) throw new Error(`unknown solo group "${o.solo}" (${GROUPS.join(', ')})`);
  resetGuard();
  const ctx = new Offline(2, Math.floor(sr * seconds), sr);
  const buses = buildMasterChain(ctx, ctx.destination);
  setVal(buses.master.gain, 1);
  const rng = o.rng;
  const world = o.world;
  const listener = { x: 0, y: o.state?.altitude ?? 60, z: 0 };
  const target = { x: 0, z: 0 };
  const sim = new VehicleSim({ roads: { segments: new Map(), version: 0, api: null }, terrain: { getHeight: () => 0 } }, rng.fork(77));
  const lots = o.lots || (world.zones?.lots?.length ? null : defaultLots());
  const wantedVehicles = o.vehicles ?? Math.round(Math.min(8, (o.state?.vehicles ?? 0) / 25));
  let simState = null;
  const mixer = new Mixer(ctx, buses, rng, {
    pickPosition: (kind) => ({ x: (kind === 'horn' ? 90 : 220) * (rng() < 0.5 ? -1 : 1), y: 0, z: 120 }),
    listener: () => listener,
    target: () => target,
    groundHeight: () => 0,
    onEvent: () => {},
    vehicles: (dt) => sim.update(dt, target, wantedVehicles, 220),
    zoneSources: () => (simState && simState.altN < 0.7 ? collectZoneSources(world, target, lots) : []),
    spawnPassBy: (tg, type) => sim.spawnPassBy(tg, type),
  });
  if (o.solo) mixer.setSolo(o.solo);
  // fixed state
  const base = computeMixState({ world, cameraY: listener.y, groundY: 0, gust: o.state?.gust ?? 0.5, override: { vehicles: o.state?.vehicles ?? world.traffic.vehicles, population: o.state?.population ?? world.economy.population }, water: o.state?.water ?? 0, forest: o.state?.forest ?? 0 });
  const state = { ...base, ...(o.state || {}) };
  if (o.state?.altitude != null) { state.altitude = o.state.altitude; const x = Math.max(0, Math.min(1, (o.state.altitude - 15) / 900)); state.altN = x * x * (3 - 2 * x); }
  if (o.state?.altN != null) state.altN = o.state.altN;
  if (o.state?.rain != null && o.state.wet == null) state.wet = o.state.rain;
  simState = state;
  mixer.setListener(listener, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
  mixer.oneShots.rateScale = o.randomEvents ? 1 : 0;

  const step = 1 / stepHz;
  const n = Math.floor(seconds * stepHz);
  const events = (o.events || []).slice().sort((a, b) => a.at - b.at);
  const uiQ = (o.ui || []).slice().sort((a, b) => a.at - b.at);
  const errors = [];
  mixer.update(step, state);
  for (let k = 1; k < n; k++) {
    const t = k * step;
    ctx.suspend(t).then(() => {
      try {
        while (events.length && events[0].at <= t) {
          const e = events.shift();
          if (e.kind === 'siren') mixer.oneShots.siren(e.x != null ? { x: e.x, y: 0, z: e.z } : null, e.variant || null);
          else if (e.kind === 'horn') mixer.oneShots.horn(e.x != null ? { x: e.x, y: 0, z: e.z } : null);
          else if (e.kind === 'thunder') mixer.oneShots.thunder(state, e.near ?? null);
          else if (e.kind === 'bell') mixer.oneShots.bell(e.hour ?? 12);
          else if (e.kind === 'carpass') mixer.oneShots.carPass(state, e.variant || null);
        }
        while (uiQ.length && uiQ[0].at <= t) mixer.ui.play(uiQ.shift().name);
        mixer.update(step, state);
        mixer.readMeters();
      } catch (err) { errors.push(String(err && err.message || err)); console.error('[audio] offline step failed', err); }
      ctx.resume();
    });
  }
  const buffer = await ctx.startRendering();
  const meterMax = mixer.meterMax();
  const meterMaxDb = {};
  for (const k in meterMax) meterMaxDb[k] = meterMax[k] > 1e-9 ? +(20 * Math.log10(meterMax[k])).toFixed(1) : -120;
  let isolation = null;
  if (o.solo) {
    const quietBuses = !(o.events && o.events.length) && !(o.ui && o.ui.length) && !o.randomEvents ? ['events', 'ui'] : [];
    const leaks = GROUPS.filter((g) => g !== o.solo && meterMaxDb[g] > LEAK_DB).concat(quietBuses.filter((g) => meterMaxDb[g] > LEAK_DB));
    isolation = { solo: o.solo, ok: leaks.length === 0, leaks: leaks.map((g) => `${g} ${meterMaxDb[g]} dB`), threshold: LEAK_DB };
    if (!isolation.ok && !o.allowLeak) throw new Error(`[audio] solo isolation broken: ${isolation.leaks.join(', ')}`);
  }
  return analyse(buffer, {
    state, levels: { ...mixer.levels }, meterMaxDb, isolation, errors,
    birdCalls: mixer.layers.birds.calls, birdSpecies: mixer.layers.birds.lastCall?.species || null,
    events: { ...mixer.oneShots.counts }, ui: { ...mixer.ui.counts },
    traffic: { voices: mixer.traffic.assigned, vehicles: sim.vehicles.length },
    zones: { voices: mixer.zones.assigned, grains: { ...mixer.zones.counts } },
    buffersMs: +mixer.buffers.buildMs.toFixed(1),
    guard: { ...guard },
  });
}

/** A representative simulated block around the listener for zone verification. */
function defaultLots() {
  const lots = [];
  const put = (x, z, type, state) => lots.push({ id: lots.length, x, z, w: 24, d: 24, type, state });
  for (let i = 0; i < 4; i++) { put(-120 + i * 20, -60, 'ind'); put(-120 + i * 20, -40, 'ind'); }
  for (let i = 0; i < 4; i++) { put(60 + i * 20, -40, 'com-high'); put(60 + i * 20, -20, 'com-low'); }
  for (let i = 0; i < 4; i++) { put(-40 + i * 20, 70, 'res-low'); put(-40 + i * 20, 90, 'res-high'); }
  for (let i = 0; i < 3; i++) put(110 + i * 20, 80, 'office');
  put(-20, -110, 'res-high', 'construction'); put(0, -110, 'com-high', 'construction');
  put(40, 40, 'park');
  return lots;
}

function analyse(buffer, extra) {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  let sum = 0, peak = 0, sumL = 0, sumR = 0;
  for (let i = 0; i < L.length; i++) {
    const l = L[i], r = R[i];
    sum += l * l + r * r; sumL += l * l; sumR += r * r;
    const a = Math.max(Math.abs(l), Math.abs(r)); if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / (2 * L.length));
  const db = (v) => (v > 1e-9 ? +(20 * Math.log10(v)).toFixed(1) : -120);
  const win = Math.floor(sr * 0.1);
  const env = [];
  for (let s = 0; s + win <= L.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += L[i] * L[i] + R[i] * R[i];
    env.push(db(Math.sqrt(e / (2 * win))));
  }
  const N = 2048;
  const re = new Float64Array(N), im = new Float64Array(N);
  const spec = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= L.length; s += N * 2) {
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = 0.5 * (L[s + i] + R[s + i]) * w; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) spec[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
  }
  const bands = {};
  let total = 0;
  for (let i = 1; i < N / 2; i++) total += spec[i];
  for (const [f0, f1, nm] of BANDS) {
    const b0 = Math.floor((f0 / sr) * N), b1 = Math.min(N / 2, Math.floor((f1 / sr) * N));
    let e = 0;
    for (let i = b0; i < b1; i++) e += spec[i];
    bands[nm] = total > 0 ? +(e / total).toFixed(3) : 0;
  }
  let num = 0;
  for (let i = 1; i < N / 2; i++) num += (i * sr / N) * spec[i];
  const centroid = total > 0 ? Math.round(num / total) : 0;
  // spectral flatness (0 = tonal/peaky, 1 = white) — distinguishes textured/tonal content from plain hiss
  let logSum = 0, lin = 0, cnt = 0;
  for (let i = 4; i < N / 2; i++) { const v = spec[i] / Math.max(1, frames) + 1e-18; logSum += Math.log(v); lin += v; cnt++; }
  const flatness = cnt ? +(Math.exp(logSum / cnt) / (lin / cnt)).toFixed(3) : 0;
  return {
    seconds: +(L.length / sr).toFixed(2), sampleRate: sr, rmsDb: db(rms), peakDb: db(peak), rmsLDb: db(Math.sqrt(sumL / L.length)), rmsRDb: db(Math.sqrt(sumR / R.length)),
    stereoDiff: +Math.abs(db(Math.sqrt(sumL / L.length)) - db(Math.sqrt(sumR / R.length))).toFixed(1),
    envelopeDb: env, bands, centroidHz: centroid, flatness, frames, ...extra,
  };
}

/** In-place radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
