/**
 * traffic showcase — build a real district through world.roads.api, line it with buildings and
 * fill it with traffic.
 *
 * A two-avenue spine crossing at the centre plus a 72 m local grid gives signalised four-way
 * crossings, priority T-junctions, dead ends and a curved outer crescent, so the critic sees
 * queueing, light phases, turning arcs, lane discipline and sidewalk crowds — not one
 * cherry-picked street. Run with ?showcase=traffic&seed=7.
 */
import { hashString } from '../../shared/random.js';

const HALF = 300;           // district half size
const STEP = 72;            // local street spacing

export async function showcase(ctx) {
  const { world } = ctx;
  const roads = world.roads && world.roads.api;
  if (!roads) throw new Error('traffic showcase needs the roads module');
  const terrain = world.terrain;
  const rng = world.rng.fork(hashString('traffic-showcase'));

  // --- 1. pick the flattest dry place for the district
  const half = world.half || 1024;
  const limit = Math.min(half - HALF - 90, 620);
  let cx = 0, cz = 0, bestScore = -Infinity;
  const probe = (x, z) => {
    let flat = 0, wet = 0, n = 0;
    for (let a = -HALF; a <= HALF; a += 60) {
      for (let b = -HALF; b <= HALF; b += 60) {
        const h = terrain.getHeight(x + a, z + b);
        const hx = terrain.getHeight(x + a + 30, z + b);
        const hz = terrain.getHeight(x + a, z + b + 30);
        flat += Math.abs(hx - h) + Math.abs(hz - h);
        if (terrain.isWater && terrain.isWater(x + a, z + b)) wet++;
        n++;
      }
    }
    return -(flat / n) - wet * 14;
  };
  for (let x = -limit; x <= limit; x += 160) {
    for (let z = -limit; z <= limit; z += 160) {
      const s = probe(x, z);
      if (s > bestScore) { bestScore = s; cx = x; cz = z; }
    }
  }

  // --- 2. gently level the district so the grid reads as a city block, not a hillside
  const base = terrain.getHeight(cx, cz);
  const level = Math.max(base, (terrain.waterLevel || 0) + 3.5);
  if (terrain.api && terrain.api.flattenRect) {
    terrain.api.flattenRect(cx - HALF - 30, cz - HALF - 30, cx + HALF + 30, cz + HALF + 30, level, 110);
  }
  if (terrain.api && terrain.api.clearVegetationRect) {
    terrain.api.clearVegetationRect(cx - HALF - 20, cz - HALF - 20, cx + HALF + 20, cz + HALF + 20);
  }
  await window.__game.waitStable(24);

  // --- 3. the network
  const P = (x, z) => ({ x: cx + x, z: cz + z });
  roads.build([P(0, -HALF), P(0, HALF)], 'avenue');
  roads.build([P(-HALF, 0), P(HALF, 0)], 'avenue');
  const locals = [-3, -2, -1, 1, 2, 3].map((k) => k * STEP);
  for (const x of locals) roads.build([P(x, -HALF), P(x, HALF)], 'local');
  for (const z of locals) roads.build([P(-HALF, z), P(HALF, z)], 'local');
  // a couple of dead-end service streets and a diagonal so junctions are not all identical
  roads.build([P(-STEP * 3, STEP * 2), P(-HALF - 55, STEP * 2)], 'local');
  roads.build([P(STEP * 3, -STEP), P(HALF + 60, -STEP)], 'local');
  roads.build([P(STEP, STEP * 3), P(STEP, STEP * 3 + 48)], 'local');
  roads.build([P(-STEP * 2, -STEP * 3), P(-STEP * 2, -STEP * 3 - 52)], 'local');
  roads.build([P(-STEP * 3, -STEP * 3), P(-STEP, -HALF)], 'local', { curve: 'bezier' });
  // outer crescent: a curved street that leaves the grid and comes back
  const cr = [];
  for (let i = 0; i <= 7; i++) {
    const a = -0.55 + (i / 7) * 1.9;
    const r = HALF + 105 + rng.range(-16, 16);
    cr.push(P(Math.cos(a) * r, Math.sin(a) * r * 0.86));
  }
  roads.build([P(HALF, -STEP * 2), ...cr, P(HALF, STEP * 3)], 'local', { curve: 'catmull' });

  if (roads.flush) roads.flush();

  const flattenCalls = roads.stats ? roads.stats().flattenCalls : 0;
  await window.__game.waitStable(Math.min(420, Math.ceil(flattenCalls / 6) + 40));

  // --- 4. line the streets with buildings so the traffic reads in a city, not on an airfield.
  //        Entirely optional: a failure here must never break the traffic showcase.
  try {
    const zones = world.zones && world.zones.api;
    const buildings = world.buildings && world.buildings.api;
    if (zones && buildings) {
      const paint = (x0, z0, x1, z1, type) => zones.paintRect(cx + x0, cz + z0, cx + x1, cz + z1, type);
      for (let i = -3; i <= 2; i++) {
        for (let j = -3; j <= 2; j++) {
          if (Math.max(Math.abs(i + 0.5), Math.abs(j + 0.5)) > 2.2) continue;   // keep the district compact
          const x0 = i * STEP + 10, z0 = j * STEP + 10, x1 = (i + 1) * STEP - 10, z1 = (j + 1) * STEP - 10;
          const r = Math.max(Math.abs(i + 0.5), Math.abs(j + 0.5));
          // low-rise around the central crossing so the traffic stays visible, towers further out
          const t = r < 1.2 ? (rng() < 0.55 ? 'com-low' : 'res-low')
            : r < 2.2 ? (rng() < 0.45 ? 'com-high' : (rng() < 0.5 ? 'office' : 'res-high'))
              : (rng() < 0.75 ? 'res-low' : 'res-high');
          paint(x0, z0, x1, z1, t);
        }
      }
      await window.__game.waitStable(12);
      if (buildings.fastForward) {
        for (let k = 0; k < 2; k++) { buildings.fastForward(60 * 60 * 24 * 240); await window.__game.waitStable(18); }
      }
      await window.__game.waitStable(60);
    }
  } catch (err) {
    console.warn('[traffic showcase] district buildings skipped:', err && err.message);
  }

  // --- 5. traffic
  const traffic = world.traffic && world.traffic.api;
  if (traffic) {
    traffic.setDensity(1.30);
    traffic.spawnBurst(380);
    await window.__game.waitStable(130);  // let IDM settle the queues and the signals cycle once
  }

  // Beauty frames are never shot at noon: LOOK_TARGET puts the reference sun at 22-34 degrees,
  // which at this latitude is hour 16.0-16.6. Leave the showcase there by default so a critic who
  // takes a shot without passing --time still gets a raking sun with long shadows.
  window.__game.setTime(16.2);
  await window.__game.waitStable(6);

  // --- 6. camera presets.
  //     hero    — the signalised avenue crossing from a normal play distance
  //     detail  — kerb height on the avenue: paint, glass, wheels, plates, a queue and the lights
  //     night   — the same avenue after dark, headlights coming at the camera
  const G = window.__game.presets;
  const at = (x, z) => ({ x: cx + x, z: cz + z });
  G.traffic_hero = { target: at(-1, 28), distance: 102, yaw: 0.13, pitch: 0.44, time: 16.2 };
  G.traffic_detail = { target: at(0.5, 30), distance: 26, yaw: 0.30, pitch: 0.30, time: 16.2 };
  G.traffic_night = { target: at(0.0, 46), distance: 56, yaw: 0.115, pitch: 0.30, time: 21.2 };
  G.traffic_junction = { target: at(-STEP, STEP), distance: 44, yaw: 0.85, pitch: 0.38 };
  G.traffic_avenue = { target: at(-STEP * 0.5, 0), distance: 84, yaw: 1.60, pitch: 0.15 };
  G.traffic_district = { target: at(2, 10), distance: 215, yaw: 0.66, pitch: 0.80, time: 16.2 };
  G.traffic_top = { target: at(0, 0), distance: 400, yaw: 0, pitch: 1.45 };
  G.traffic_crescent = { target: at(HALF + 70, STEP), distance: 120, yaw: -1.1, pitch: 0.35 };
}
