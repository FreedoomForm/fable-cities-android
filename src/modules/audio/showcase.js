/**
 * Audio showcase (?showcase=audio&seed=7).
 *
 * Sound is invisible, so this builds a REAL district through the other modules' public APIs —
 * roads → zoning → buildings → traffic — and then draws what the mixer is actually listening to on
 * top of it: a ground ring on every zone-ambience cluster (industry orange, commerce magenta,
 * residential green, office blue, construction yellow), a small ring under every car that owns a
 * traffic voice, and expanding ripples from sirens / horns / the clock-tower bell. Every voice you
 * see is attached to a building or a vehicle that is really there.
 *
 * Districts are laid out so the mix is legible from the air: industry east, offices north-east,
 * downtown commerce in the middle, residential west and south, and a freshly zoned block that is
 * still under construction (hammer / drill / reversing beeper) in the south-west.
 *
 * Presets: audio_hero (district overview), audio_detail (junction at street level), audio_night
 * (evening avenue), audio_aerial (1.2 km → wind takes over), audio_street, audio_industrial,
 * audio_construction, audio_shore.
 * ?audiodebug=0 hides the in-world rings (the mix monitor HUD stays).
 */
import { DEG2RAD } from '../../shared/math.js';
import { hashString } from '../../shared/random.js';

const HALF = 240;         // district half size (the road grid ends where the zoning ends)
const STEP = 72;          // local street spacing (matches the zoning grid: 9 cells)

export async function showcase(ctx) {
  const { world, engine, events, cameraController } = ctx;
  const api = world.audio?.api;
  if (!api) throw new Error('audio module api missing');
  const presets = window.__game.presets;
  const rng = world.rng.fork(hashString('audio-showcase'));
  const wait = (f) => window.__game.waitStable(f);

  // ---------------------------------------------------------------- 1. a flat, dry site
  const terrain = world.terrain;
  const half = world.half || 1024;
  const limit = Math.min(half - HALF - 100, 620);
  let cx = 0, cz = 0, best = -Infinity;
  for (let x = -limit; x <= limit; x += 160) {
    for (let z = -limit; z <= limit; z += 160) {
      let rough = 0, wet = 0, n = 0;
      for (let a = -HALF; a <= HALF; a += 64) {
        for (let b = -HALF; b <= HALF; b += 64) {
          const h = terrain.getHeight(x + a, z + b);
          rough += Math.abs(terrain.getHeight(x + a + 32, z + b) - h) + Math.abs(terrain.getHeight(x + a, z + b + 32) - h);
          if (terrain.isWater && terrain.isWater(x + a, z + b)) wet++;
          n++;
        }
      }
      const score = -(rough / n) - wet * 15;
      if (score > best) { best = score; cx = x; cz = z; }
    }
  }
  const baseY = Math.max(terrain.getHeight(cx, cz), (terrain.waterLevel || 0) + 3.5);
  terrain.api?.flattenRect?.(cx - HALF - 40, cz - HALF - 40, cx + HALF + 40, cz + HALF + 40, baseY, 120);
  terrain.api?.clearVegetationRect?.(cx - HALF - 24, cz - HALF - 24, cx + HALF + 24, cz + HALF + 24);
  await wait(24);
  const P = (x, z) => ({ x: cx + x, z: cz + z });
  const at = (x, z) => ({ x: cx + x, z: cz + z });

  // ---------------------------------------------------------------- 2. the street network
  let builtRoads = 0;
  try {
    const roads = world.roads?.api;
    if (roads && typeof roads.build === 'function') {
      roads.build([P(0, -HALF), P(0, HALF)], 'avenue');
      roads.build([P(-HALF, 0), P(HALF, 0)], 'avenue');
      builtRoads += 2;
      for (const k of [-3, -2, -1, 1, 2, 3]) {
        roads.build([P(k * STEP, -HALF), P(k * STEP, HALF)], 'local');
        roads.build([P(-HALF, k * STEP), P(HALF, k * STEP)], 'local');
        builtRoads += 2;
      }
      // a couple of service spurs so not every junction is a four-way crossing
      roads.build([P(STEP * 3, STEP * 3), P(HALF + 62, STEP * 3)], 'local');
      roads.build([P(-STEP * 3, -STEP * 2), P(-HALF - 58, -STEP * 2)], 'local');
      builtRoads += 2;
      roads.flush?.();
      const calls = roads.stats ? roads.stats().flattenCalls || 0 : 0;
      await wait(Math.min(360, Math.ceil(calls / 6) + 40));
    } else {
      console.info('[audio showcase] world.roads.api.build missing — falling back to a simulated city');
    }
  } catch (err) { console.info('[audio showcase] roads unavailable:', err.message); }

  // ---------------------------------------------------------------- 3. districts (one per ambience)
  //   industry east · offices north-east · downtown commerce centre · residential west/south
  let zoned = 0;
  const zones = world.zones?.api;
  const buildings = world.buildings?.api;
  const paint = (bx, bz, type) => {
    const x0 = cx + bx * STEP + 9, z0 = cz + bz * STEP + 9;
    zones.paintRect(x0, z0, x0 + STEP - 18, z0 + STEP - 18, type);
  };
  // A real skyline gradient: low suburbs → mid-rise ring → downtown core, industry and offices east.
  const districtOf = (bx, bz) => {
    const r = Math.max(Math.abs(bx + 0.5), Math.abs(bz + 0.5));
    if (bx >= 2) return bz >= 0 ? 'ind' : 'office';
    if (r <= 1.2) return rng() < 0.6 ? 'com-high' : 'office';
    if (r <= 2.3) return rng() < 0.45 ? 'res-high' : 'com-low';
    return 'res-low';
  };
  try {
    if (builtRoads && zones && typeof zones.paintRect === 'function') {
      for (let bx = -4; bx <= 3; bx++) {
        for (let bz = -4; bz <= 3; bz++) {
          if (Math.max(Math.abs(bx + 0.5), Math.abs(bz + 0.5)) > 3.1) continue;   // compact district: keeps the triangle budget sane
          if (bx === -3 && bz >= 1) continue;        // south-west blocks: kept for the building site
          paint(bx, bz, districtOf(bx, bz));
        }
      }
      await wait(14);
      zoned = (world.zones.lots || []).length;
    }
  } catch (err) { console.info('[audio showcase] zoning unavailable:', err.message); }

  // ---------------------------------------------------------------- 4. grow the city, then a building site
  try {
    if (zoned && buildings?.fastForward) {
      for (let k = 0; k < 2; k++) { buildings.fastForward(60 * 60 * 24 * 260); await wait(18); }
      // a district zoned last: its lots are still scaffolding → construction ambience you can see
      for (let bz = 1; bz <= 3; bz++) paint(-3, bz, bz === 3 ? 'ind' : 'res-high');
      await wait(12);
      buildings.fastForward(60 * 60 * 30);           // half a day: sites started, nothing finished
      await wait(40);
    }
  } catch (err) { console.info('[audio showcase] buildings unavailable:', err.message); }

  // ---------------------------------------------------------------- 5. traffic
  try {
    const traffic = world.traffic?.api;
    if (traffic) {
      traffic.setDensity?.(1.35);
      traffic.spawnBurst?.(260);
      await wait(90);
    }
  } catch (err) { console.info('[audio showcase] traffic unavailable:', err.message); }

  // ---------------------------------------------------------------- 6. honest fallback
  const list = world.buildings?.list || [];
  const buildingCount = list.length;
  const vehicleCount = world.traffic?.api?.getVehicles ? world.traffic.api.getVehicles().length : (+world.traffic?.vehicles || 0);
  const lotCount = (world.zones?.lots || []).length;
  let population = world.economy?.population || 0;
  if (population < 200 && buildingCount) {
    // The economy only grows once the simulation has run for a while; the residents actually living
    // in the buildings we just grew are a real number, so use those instead of inventing one.
    let residents = 0, jobs = 0;
    for (const b of list) { residents += b.residents || 0; jobs += b.jobs || 0; }
    if (residents + jobs > 200) {
      population = residents;
      api.setSimulatedCity({ population: residents, jobs, label: `${(residents / 1000).toFixed(1)}k residents · ${(jobs / 1000).toFixed(1)}k jobs (from ${buildingCount} buildings)` });
    }
  }
  if (buildingCount < 20) {
    api.setSimulatedCity({ population: population < 200 ? 16500 : population, vehicles: vehicleCount > 5 ? undefined : 180, lots: simulatedLots(world, cx, cz), label: 'simulated city (zoning/buildings unavailable)' });
    console.info(`[audio showcase] no real buildings (${lotCount} lots) — mix falls back to a simulated city; the HUD footer says so.`);
  } else {
    console.info(`[audio showcase] live city: ${buildingCount} buildings, ${lotCount} lots, ${vehicleCount} vehicles, ${Math.round(population)} residents.`);
  }

  // ---------------------------------------------------------------- 7. camera presets
  // The mix monitor covers the left ~26 % of the frame, so hero/overview targets are nudged along the
  // camera's left so the city itself sits clear of it (right = (cos yaw, 0, −sin yaw)).
  const shift = (v, m) => { const r = { x: Math.cos(v.yaw), z: -Math.sin(v.yaw) }; v.target.x -= r.x * m; v.target.z -= r.z * m; return v; };
  const dense = densestBlock(world, cx, cz);
  presets.audio_hero = shift({ target: { x: (dense.x + cx * 2) / 3, z: (dense.z + cz * 2) / 3 }, distance: 560, yaw: 36 * DEG2RAD, pitch: 40 * DEG2RAD }, 120);
  // Street-level views are SEARCHED on the finished city (a hard-coded coordinate ends up inside a
  // tower as soon as the grower puts one there): each one stands on a real carriageway, looks along
  // it, and is rejected if the camera would sit inside a building.
  const centre = { x: cx, z: cz };
  presets.audio_detail = streetView(world, centre, 52, 17 * DEG2RAD, 'avenue') || { target: at(0, -STEP), distance: 52, yaw: 8 * DEG2RAD, pitch: 17 * DEG2RAD };
  presets.audio_night = streetView(world, at(0, -STEP * 1.5), 82, 25 * DEG2RAD, 'avenue') || presets.audio_detail;
  presets.audio_street = streetView(world, at(-STEP * 1.5, STEP), 40, 12 * DEG2RAD, 'local') || presets.audio_detail;
  presets.audio_industrial = streetView(world, at(STEP * 2.6, STEP * 1.6), 92, 24 * DEG2RAD, 'local', 'ind') || presets.audio_detail;
  presets.audio_construction = streetView(world, at(-STEP * 2.6, STEP * 1.6), 78, 24 * DEG2RAD, 'local', 'construction') || presets.audio_detail;
  presets.audio_aerial = { target: at(0, 0), distance: 1250, yaw: 24 * DEG2RAD, pitch: 58 * DEG2RAD };
  presets.audio_shore = shorePreset(world, cx, cz);

  // ---------------------------------------------------------------- 8. debug view + scripted events
  api.setDebug(true);
  api.setEventRate(5);

  const script = () => {
    if (!api.running) return;
    const act = api.getState().events?.active || [];
    const busy = act.filter((e) => e.kind === 'siren').length > 0;
    const yaw = cameraController.yaw;
    const t = cameraController.target;
    // Place the events IN FRAME: forward = −(sin yaw, cos yaw) from the target, right = (cos yaw, −sin yaw).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // snap every event onto the nearest carriageway: sirens and horns belong on the street, not on a lawn
    const onRoad = (x, z) => {
      const n = world.roads?.api?.nearest ? world.roads.api.nearest(x, z, 90) : null;
      return n && n.point ? { x: n.point.x, z: n.point.z } : { x, z };
    };
    if (!busy) api.playWorld('siren', onRoad(t.x + fx * 46 - rx * 14, t.z + fz * 46 - rz * 14));
    api.playWorld('horn', onRoad(t.x + fx * 18 + rx * 20, t.z + fz * 18 + rz * 20));
    api.playWorld('carpass', { type: 'truck' });
    setTimeout(() => api.running && api.playWorld('horn', onRoad(t.x - fx * 24 + rx * 12, t.z - fz * 24 + rz * 12)), 2400);
  };
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    script();
    let acc = 0;
    engine.onUpdate(function audioShowcaseScript(dt) {
      acc += dt;
      if (acc >= 6) { acc = 0; script(); }   // a siren lasts 9–18 s, so a screenshot always catches one
    });
  };
  if (api.running) arm();
  else events.on('audio:state', (s) => { if (s === 'running') arm(); });
  events.once('audio:ready', () => setTimeout(() => api.play('notify'), 600));
}

// ------------------------------------------------------------------------------------------ helpers
/**
 * Find a street-level camera on a real road near `near`: stands on the carriageway, looks along it,
 * prefers a canyon with buildings on both sides, and rejects any position that would put the camera
 * inside a building. Returns a preset or null.
 */
function streetView(world, near, distance, pitch, preferType, wantZone) {
  const segs = world.roads && world.roads.segments ? [...world.roads.segments.values()] : [];
  if (!segs.length) return null;
  const list = world.buildings?.list || [];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  let best = null, bestScore = -Infinity;
  for (const seg of segs) {
    const pts = seg.points;
    if (!pts || pts.length < 6) continue;
    for (let i = 2; i < pts.length - 3; i += 3) {
      const p = pts[i], q = pts[i + 1];
      const dx = q.x - p.x, dz = q.z - p.z;
      const L = Math.hypot(dx, dz);
      if (!(L > 0.01)) continue;
      const ux = dx / L, uz = dz / L;
      const tx = p.x + ux * 26, tz = p.z + uz * 26;                 // look 26 m up the street
      const nearD = Math.hypot(tx - near.x, tz - near.z);
      if (nearD > 150) continue;
      const camX = tx - ux * distance * cp, camZ = tz - uz * distance * cp;
      const camY = world.terrain.getHeight(camX, camZ) + sp * distance;
      let clear = true, flank = 0, match = 0;
      for (const b of list) {
        const rr = Math.max(b.w || 12, b.d || 12) * 0.5 + 8;
        if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 < rr * rr && (b.y || 0) + (b.height || 10) > camY - 5) { clear = false; break; }
        const dt2 = (b.x - tx) ** 2 + (b.z - tz) ** 2;
        if (dt2 < 3600) {
          flank += Math.min(2.5, (b.height || 8) / 14);
          if (wantZone && (wantZone === 'construction' ? b.state === 'construction' : String(b.type || '').startsWith(wantZone))) match += 2.5;
        }
      }
      if (!clear) continue;
      const score = flank * 0.6 + match - nearD * 0.08 + (seg.type === preferType ? 5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { target: { x: tx, z: tz }, distance, yaw: Math.atan2(-ux, -uz), pitch };
      }
    }
  }
  return best;
}
/** Centre of the densest 96 m cell of real buildings (the hero shot aims there). */
function densestBlock(world, cx, cz) {
  const list = world.buildings?.list || [];
  if (!list.length) return { x: cx, z: cz };
  const cells = new Map();
  for (const b of list) {
    const k = `${Math.floor(b.x / 96)}:${Math.floor(b.z / 96)}`;
    let c = cells.get(k);
    if (!c) { c = { x: 0, z: 0, w: 0 }; cells.set(k, c); }
    const w = 1 + (b.height || 10) / 20;
    c.x += b.x * w; c.z += b.z * w; c.w += w;
  }
  let best = null;
  for (const c of cells.values()) if (!best || c.w > best.w) best = c;
  return best ? { x: best.x / best.w, z: best.z / best.w } : { x: cx, z: cz };
}

/** Deterministic stand-in lots (only used when zoning/buildings produce nothing). */
function simulatedLots(world, cx, cz) {
  const rng = world.rng.fork(0xa0d10);
  const lots = [];
  const district = (x, z) => {
    if (x >= STEP * 2) return z >= 0 ? 'ind' : 'office';
    if (x <= -STEP * 3) return 'res-low';
    if (Math.abs(x) < STEP && Math.abs(z) < STEP) return 'com-high';
    if (z <= -STEP * 3) return 'com-low';
    return 'res-high';
  };
  let id = 0;
  for (let bx = -4; bx <= 3; bx++) {
    for (let bz = -4; bz <= 3; bz++) {
      if (Math.max(Math.abs(bx + 0.5), Math.abs(bz + 0.5)) > 3.6) continue;
      for (let k = 0; k < 3; k++) {
        const s = bx * STEP + 18 + k * 18, sz = bz * STEP + 18 + k * 18;
        for (const [lx, lz] of [[s, bz * STEP + 18], [s, bz * STEP + STEP - 18], [bx * STEP + 18, sz], [bx * STEP + STEP - 18, sz]]) {
          const x = cx + lx, z = cz + lz;
          if (world.terrain.isWater(x, z)) continue;
          const type = district(lx, lz);
          lots.push({ id: id++, x, z, w: 20, d: 20, yaw: 0, type, state: rng() < 0.08 ? 'construction' : 'built', buildingId: null });
        }
      }
    }
  }
  return lots;
}

/** A view over the shoreline nearest the district (water lapping / gulls). */
function shorePreset(world, cx, cz) {
  const t = world.terrain;
  const fallback = { target: { x: cx, z: cz }, distance: 160, yaw: 0, pitch: 25 * DEG2RAD };
  if (!t.ready) return fallback;
  let best = null, bestD = Infinity;
  const step = 24;
  for (let x = -world.half + step; x < world.half; x += step) {
    for (let z = -world.half + step; z < world.half; z += step) {
      if (!t.isWater(x, z)) continue;
      if (t.isWater(x + step, z) && t.isWater(x - step, z) && t.isWater(x, z + step) && t.isWater(x, z - step)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d < bestD) { bestD = d; best = { x, z }; }
    }
  }
  if (!best) return fallback;
  const yaw = Math.atan2(cx - best.x, cz - best.z);   // stand on the land side, look out over the water
  return { target: { x: best.x, z: best.z }, distance: 120, yaw, pitch: 20 * DEG2RAD };
}
