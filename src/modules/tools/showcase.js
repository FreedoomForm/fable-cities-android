/**
 * tools showcase — ?showcase=tools&seed=7
 *
 * Builds a small, honest district through the public APIs (roads → zoning → buildings → services)
 * and then stages every tool preview at once so a single frame shows the whole toolkit:
 * a curved avenue ghost with snap guides and its length/cost chip, a zoning marquee with a live
 * per-cell preview, a fire house ghost with its coverage radius, a selected building with the
 * CS2-style cage, and a bulldoze target flagged in red.
 *
 * Presets: tools_hero, tools_detail, tools_night (+ tools_top, tools_road, tools_service).
 * Scenario switches for critics: __game.toolsDemo.road() / .zone() / .service() / .bulldoze()
 *                                / .select() / .all() / .clear()
 */
import { DEG2RAD } from '../../shared/math.js';
import { hashString } from '../../shared/random.js';
import { debugPreview, debugPointer } from './index.js';

const BLOCK = 80;

export async function showcase(ctx) {
  const { world, events, config } = ctx;
  const rng = world.rng.fork(hashString('tools-showcase'));
  const roads = world.roads && world.roads.api;
  const zones = world.zones && world.zones.api;
  const buildings = world.buildings && world.buildings.api;
  const services = world.services && world.services.api;

  // ---------------- 1. pick the flattest dry spot so the demo reads on any seed
  const O = findSite(world);

  // ---------------- 2. road grid
  const built = [];
  if (roads && typeof roads.build === 'function') {
    roads.build([P(O, 0, -260), P(O, 0, 260)], 'avenue', { curve: 'straight' });
    for (const z of [-200, -120, -40, 40, 120, 200]) built.push(roads.build([P(O, -200, z), P(O, 200, z)], 'local'));
    for (const x of [-200, -120, 120, 200]) built.push(roads.build([P(O, x, -200), P(O, x, 200)], 'local'));
    // a gently curved connector so the network is not a pure grid
    roads.build([P(O, 200, 120), P(O, 268, 60), P(O, 236, -40), P(O, 200, -120)], 'local', { curve: 'bezier' });
  }

  // ---------------- 2b. re-open one street corridor in the north-east of the grid.
  // The flattest candidate is demolished again: roads grade the terrain and never un-grade it, so
  // the empty corridor reads as a prepared road bed and the ghost that fills it is really buildable.
  const gapCandidates = [
    [[120, -200], [120, -40]], [[200, -200], [200, -40]], [[120, -120], [120, 40]],
    [[120, -200], [120, -120]], [[120, -120], [120, -40]], [[200, -200], [200, -120]],
    [[200, -120], [200, -40]], [[120, -40], [120, 40]], [[200, -40], [200, 40]],
    [[0, -200], [120, -200]], [[120, -200], [200, -200]], [[0, -120], [120, -120]],
    [[120, -120], [200, -120]], [[0, -40], [120, -40]], [[120, -40], [200, -40]],
  ].map(([a, b]) => ({ a: P(O, a[0], a[1]), b: P(O, b[0], b[1]), long: Math.hypot(a[0] - b[0], a[1] - b[1]) > 120 }));
  for (const g of gapCandidates) g.slope = slopeOf(world, [g.a, g.b]);
  gapCandidates.sort((a, b) => a.slope - b.slope);
  // prefer a full 160 m corridor when one is buildable, else the flattest short one
  const gap = gapCandidates.find((g) => g.long && g.slope < 0.235) || gapCandidates[0];
  if (roads && typeof roads.remove === 'function') {
    for (const f of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      const hit = roads.nearest(gap.a.x + (gap.b.x - gap.a.x) * f, gap.a.z + (gap.b.z - gap.a.z) * f, 12);
      if (hit && hit.segment) roads.remove(hit.segment.id);
    }
  }

  // ---------------- 3. zoning (two blocks deliberately left empty for the tool ghosts)
  const EMPTY = new Set(['-160,80', '-160,-80', '40,-160']);
  const plan = [
    ['com-high', [[60, -80], [60, 0]]],
    ['office', [[60, 80], [160, 0]]],
    ['res-high', [[-60, 0], [-60, -80]]],
    ['com-low', [[-60, 80], [160, 80]]],
    ['res-low', [[-160, 0], [-160, 160], [160, 160], [60, 160], [-60, 160]]],
    ['ind', [[60, -160], [60, 160]]],
  ];
  if (zones && typeof zones.paintRect === 'function') {
    for (const [type, cells] of plan) {
      for (const [bx, bz] of cells) {
        if (EMPTY.has(`${bx},${bz}`)) continue;
        const c = P(O, bx, bz);
        zones.paintRect(c.x - BLOCK / 2 + 4, c.z - BLOCK / 2 + 4, c.x + BLOCK / 2 - 4, c.z + BLOCK / 2 - 4, type);
      }
    }
  }
  if (buildings && typeof buildings.fastForward === 'function') buildings.fastForward(3600 * 24 * 45);

  // ---------------- 4. two existing service buildings (context for the coverage overlays)
  if (services && typeof services.place === 'function') {
    trySvc(services, 'water', P(O, -160, 80), 0);
    trySvc(services, 'fire', P(O, -160, -160), 0);
  }

  // ---------------- 5. staged tool previews (all at once — see toolsDemo below)
  const ghostA = [snapTo(roads, gap.a), snapTo(roads, gap.b)];   // fills the re-opened corridor
  const ghostB = worstRoute(world, [
    [P(O, 0, -260), P(O, 96, -356)], [P(O, 0, -260), P(O, -96, -356)], [P(O, 0, -260), P(O, 0, -400)],
    [P(O, 200, -200), P(O, 320, -290)], [P(O, -200, -200), P(O, -320, -290)],
  ]);
  const scenarios = {
    clear() { debugPreview(null); },
    road() {
      debugPreview('road', [
        { points: ghostA, type: 'avenue', curve: 'straight', snap: { kind: 'node' } },
        { points: [ghostB[0], mid(ghostB[0], ghostB[1], 0.55, 42), ghostB[1]], type: 'local', curve: 'bezier' },
      ]);
    },
    zone() {
      const c = P(O, 160, -160);
      debugPreview('zone', { rect: { x0: c.x - 34, z0: c.z - 34, x1: c.x + 34, z1: c.z + 34 }, type: 'res-high' });
    },
    service() {
      const c = P(O, 252, -104);
      debugPreview('service', { type: 'police', x: c.x, z: c.z, yaw: -Math.PI / 2 });
    },
    select(emit = true) {
      const b = pickBuilding(world, P(O, 74, -96), 46);
      if (b) debugPreview('select', { kind: 'building', id: b.id, emit });
    },
    bulldoze() {
      for (const c of [[160, -120], [160, -200], [60, -120], [60, -200], [-60, -120]]) {
        const p = P(O, c[0], c[1]);
        const hit = roads && roads.nearest && roads.nearest(p.x, p.z, 10);
        if (hit && hit.segment) { debugPreview('bulldoze', { kind: 'road', id: hit.segment.id }); return; }
      }
    },
    all() {
      scenarios.clear(); scenarios.road(); scenarios.zone(); scenarios.service();
      scenarios.select(true); scenarios.bulldoze();
    },
  };
  window.__game.toolsDemo = { ...scenarios, site: O, pointer: debugPointer };
  scenarios.all();

  // the HUD shows the road tool armed; the staged ghosts stay regardless of the active tool
  events.emit('tool:select', 'road', { type: 'avenue', cost: 420, label: 'Four-Lane Avenue' });

  // ---------------- 6. camera presets
  const PR = window.__game.presets;
  const gm = { x: (ghostA[0].x + ghostA[1].x) / 2, z: (ghostA[0].z + ghostA[1].z) / 2 };
  const look = Math.atan2(ghostA[1].x - ghostA[0].x, ghostA[1].z - ghostA[0].z) * 180 / Math.PI;
  PR.tools_hero = { target: { x: O.x + 128, z: O.z - 176 }, distance: 352, yaw: 29 * DEG2RAD, pitch: 33 * DEG2RAD };
  PR.tools_detail = { target: gm, distance: 104, yaw: (look + 36) * DEG2RAD, pitch: 17 * DEG2RAD };
  PR.tools_night = { target: { x: O.x + 140, z: O.z - 140 }, distance: 430, yaw: 24 * DEG2RAD, pitch: 33 * DEG2RAD };
  PR.tools_top = { target: { x: O.x + 90, z: O.z - 160 }, distance: 520, yaw: 6 * DEG2RAD, pitch: 79 * DEG2RAD };
  PR.tools_zone = { target: { x: O.x + 160, z: O.z - 160 }, distance: 120, yaw: 26 * DEG2RAD, pitch: 28 * DEG2RAD };
  PR.tools_service = { target: { x: O.x + 200, z: O.z - 110 }, distance: 900, yaw: 26 * DEG2RAD, pitch: 42 * DEG2RAD };

  if (config && config.debug) {
    console.info('[tools:showcase] site', O, 'gap', gap.slope.toFixed(3), 'roads', world.roads.segments.size, 'lots', world.zones.lots.length, 'buildings', world.buildings.list.length);
  }
  void rng; void built;
}

// --------------------------------------------------------------------------- helpers

const P = (O, x, z) => ({ x: O.x + x, z: O.z + z });

/** Flattest dry 560 m square within ±420 m of the origin. */
function findSite(world) {
  const t = world.terrain;
  let best = { x: 0, z: 0 }, bestScore = Infinity;
  for (let gz = -1; gz <= 1; gz++) {
    for (let gx = -1; gx <= 1; gx++) {
      const cx = gx * 300, cz = gz * 300;
      let min = Infinity, max = -Infinity, water = 0, n = 0;
      for (let j = -4; j <= 4; j++) {
        for (let i = -4; i <= 4; i++) {
          const x = cx + i * 70, z = cz + j * 70;
          const h = t.getHeight ? t.getHeight(x, z) : 0;
          if (!Number.isFinite(h)) continue;
          min = Math.min(min, h); max = Math.max(max, h);
          if (t.isWater && t.isWater(x, z)) water++;
          n++;
        }
      }
      if (!n) continue;
      const score = (max - min) + water * 26 + Math.hypot(cx, cz) * 0.004;
      if (score < bestScore) { bestScore = score; best = { x: cx, z: cz }; }
    }
  }
  return best;
}

/** Worst gradient along a straight route (used to pick a flat ghost and a deliberately bad one). */
function slopeOf(world, pts) {
  const t = world.terrain;
  const total = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
  const n = Math.max(8, Math.round(total / 2.5));
  const ys = [];
  let water = 0;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = pts[0].x + (pts[1].x - pts[0].x) * f;
    const z = pts[0].z + (pts[1].z - pts[0].z) * f;
    if (!world.inBounds(x, z)) return 99;
    ys.push(t.getHeight ? t.getHeight(x, z) : 0);
    if (t.isWater && t.isWater(x, z)) water++;
  }
  // same metric the road tool uses: sustained gradient over a ~10 m window
  const step = total / n || 1;
  const win = Math.max(2, Math.round(10 / step));
  let worst = 0;
  for (let i = 0; i + win < ys.length; i++) worst = Math.max(worst, Math.abs(ys[i + win] - ys[i]) / (step * win));
  return worst + water * 0.5;
}

/** The candidate route with the worst gradient — an honest "cannot build here" demo. */
function worstRoute(world, list) {
  let best = list[0], score = -1;
  for (const r of list) {
    const sc = slopeOf(world, r);
    if (sc > score && sc < 90) { score = sc; best = r; }
  }
  return best;
}

/** Point at fraction f along a→b, pushed sideways by `off` metres (bezier control point). */
function mid(a, b, f, off) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * f - (dz / l) * off, z: a.z + dz * f + (dx / l) * off };
}

function snapTo(roads, p) {
  if (!roads || typeof roads.snap !== 'function') return p;
  const s = roads.snap(p.x, p.z, 26);
  return s ? { x: s.x, z: s.z } : p;
}

function trySvc(services, type, p, yaw) {
  try {
    for (const off of [[0, 0], [14, 0], [-14, 0], [0, 16], [0, -16], [22, 22]]) {
      const rec = services.place(type, p.x + off[0], p.z + off[1], { yaw, free: true, silent: true });
      if (rec) return rec;
    }
  } catch (err) { console.warn('[tools:showcase] service', type, err && err.message); }
  return null;
}

/** Tallest finished building near p (a tall silhouette shows the selection cage best). */
function pickBuilding(world, p, radius) {
  const list = world.buildings && world.buildings.list;
  if (!Array.isArray(list) || !list.length) return null;
  let best = null, bestScore = -Infinity;
  for (const b of list) {
    const d2 = (b.x - p.x) ** 2 + (b.z - p.z) ** 2;
    if (d2 > radius * radius) continue;
    const score = (b.height || 8) * 1.1 - Math.sqrt(d2);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}
