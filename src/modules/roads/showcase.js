/**
 * roads showcase — a representative small network built purely through world.roads.api:
 * an S-curved avenue spine, a local street grid with T/cross/acute junctions and dead ends,
 * a curved suburban loop with cul-de-sacs and a park path, and a motorway that the avenue
 * transitions into. Run with ?showcase=roads&seed=7.
 */
import { hashString } from '../../shared/random.js';

const D = Math.PI / 180;

export async function showcase(ctx) {
  const { world } = ctx;
  const api = world.roads.api;
  if (!api) throw new Error('roads api missing');
  const rng = world.rng.fork(hashString('roads-showcase'));

  // --- 1. avenue spine (single cubic Bézier, later split by every junction) ---
  api.build([{ x: -10, z: -560 }, { x: 70, z: -240 }, { x: -70, z: 140 }, { x: 0, z: 420 }], 'avenue', { curve: 'bezier' });
  const onAvenue = (z) => {
    const h = api.nearest(0, z, 160);
    return h && h.segment.type === 'avenue' ? { x: h.point.x, z: h.point.z } : { x: 0, z };
  };

  // --- 2. local grid east of the avenue ---
  const rows = [-400, -300, -200, -100, 0, 100, 200];
  for (const z of rows) api.build([onAvenue(z), { x: 340, z }], 'local');
  for (const x of [120, 230, 340]) api.build([{ x, z: -400 }, { x, z: 200 }], 'local');
  // dead-end stubs (cul-de-sac style)
  api.build([{ x: 175, z: -100 }, { x: 175, z: -35 }], 'local');
  api.build([{ x: 285, z: 100 }, { x: 285, z: 165 }], 'local');
  api.build([{ x: 340, z: -300 }, { x: 420, z: -300 }], 'local');
  // a diagonal street: acute-angle crossings
  api.build([{ x: 120, z: 150 }, { x: 340, z: -50 }], 'local');

  // --- 3. suburban loop west (Catmull-Rom), connectors, cul-de-sacs, park path ---
  const cx = -270, cz = -90;
  const loop = [];
  const N = 10;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 150 + rng.range(-22, 22);
    loop.push({ x: cx + Math.cos(a) * r * 1.15, z: cz + Math.sin(a) * r });
  }
  loop.push({ x: loop[0].x, z: loop[0].z });
  api.build(loop, 'local', { curve: 'catmull' });
  const onLoop = (x, z) => {
    const h = api.nearest(x, z, 120);
    return h ? { x: h.point.x, z: h.point.z } : { x, z };
  };
  // connectors avenue ↔ loop (gently curved)
  const cA = onAvenue(-190), lA = onLoop(cx + 172, cz - 100);
  api.build([cA, { x: (cA.x + lA.x) / 2 + 10, z: (cA.z + lA.z) / 2 - 25 }, lA], 'local', { curve: 'bezier' });
  const cB = onAvenue(30), lB = onLoop(cx + 172, cz + 100);
  api.build([cB, { x: (cB.x + lB.x) / 2 - 5, z: (cB.z + lB.z) / 2 + 30 }, lB], 'local', { curve: 'bezier' });
  // cul-de-sacs into the loop interior
  const s1 = onLoop(cx - 172, cz - 40);
  api.build([s1, { x: cx - 90, z: cz - 60 }, { x: cx - 40, z: cz - 20 }], 'local', { curve: 'bezier' });
  const s2 = onLoop(cx + 40, cz + 150);
  api.build([s2, { x: cx + 60, z: cz + 70 }, { x: cx + 30, z: cz + 20 }], 'local', { curve: 'bezier' });
  const s3 = onLoop(cx - 60, cz - 150);
  api.build([s3, { x: cx - 30, z: cz - 90 }], 'local');
  // park path across the loop interior
  const p1 = onLoop(cx - 172, cz + 60), p2 = onLoop(cx + 130, cz - 130);
  api.build([p1, { x: cx - 80, z: cz + 40 }, { x: cx - 10, z: cz - 30 }, { x: cx + 60, z: cz - 90 }, p2], 'path', { curve: 'catmull' });

  // --- 4. motorway: the avenue's south end transitions into a 2×3-lane highway ---
  // pick the first candidate alignment that stays on dry land (the terrain differs per seed)
  const t = world.terrain;
  const dry = (pts) => {
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k <= 8; k++) {
      const x = pts[i].x + ((pts[i + 1].x - pts[i].x) * k) / 8, z = pts[i].z + ((pts[i + 1].z - pts[i].z) * k) / 8;
      if (t.isWater(x, z) || t.getHeight(x, z) < t.waterLevel + 2) return false;
    }
    return true;
  };
  const candidates = [
    [{ x: 0, z: 420 }, { x: 110, z: 520 }, { x: 430, z: 590 }, { x: 900, z: 560 }],
    [{ x: 0, z: 420 }, { x: 130, z: 470 }, { x: 450, z: 470 }, { x: 900, z: 420 }],
    [{ x: 0, z: 420 }, { x: 110, z: 400 }, { x: 450, z: 330 }, { x: 900, z: 280 }],
    [{ x: 0, z: 420 }, { x: -130, z: 500 }, { x: -450, z: 560 }, { x: -900, z: 520 }],
    [{ x: 0, z: 420 }, { x: -120, z: 400 }, { x: -450, z: 330 }, { x: -900, z: 280 }],
  ];
  const hw = candidates.find(dry) || candidates[0];
  api.build(hw, 'highway', { curve: 'catmull' });

  api.flush();
  // the terrain module applies heightmap edits a few regions per frame — let it catch up so the
  // first frames critics see are not half-conformed
  if (world.terrain.api && typeof world.terrain.api.flattenRect === 'function') {
    const frames = Math.min(600, Math.ceil(api.stats().flattenCalls / 6) + 20);
    await window.__game.waitStable(frames);
  }

  // --- camera presets ---
  const P = window.__game.presets;
  // avenue junction on the flattest ground (terrain differs per seed)
  const slopeAt = (x, z) => Math.abs(t.getHeight(x + 12, z) - t.getHeight(x - 12, z)) + Math.abs(t.getHeight(x, z + 12) - t.getHeight(x, z - 12));
  let av = onAvenue(-100), best = Infinity;
  for (const z of [-300, -200, -100, 0, 100]) { const p = onAvenue(z); const sl = slopeAt(p.x, p.z); if (sl < best) { best = sl; av = p; } }
  const hwMid = hw[2];
  // frame the park path itself (nearest() would otherwise snap to the local street that crosses it)
  let pc = { x: cx - 10, z: cz - 30 };
  for (const q of [{ x: cx - 80, z: cz + 40 }, { x: cx - 10, z: cz - 30 }, { x: cx + 60, z: cz - 90 }]) {
    const h = api.nearest(q.x, q.z, 40);
    if (h && h.segment.type === 'path') { pc = { x: h.point.x, z: h.point.z }; break; }
  }
  // Hero, detail and night default to a LOW sun (hour 16.2 → ~28° elevation, shadows ≈ 1.9x object
  // height): the reference beauty frames are never shot at noon, and flat noon light was what made our
  // asphalt read as an untextured colour field.
  P.roads_hero = { target: { x: 40, z: -80 }, distance: 300, yaw: 0.8, pitch: 0.45, time: 16.2 };
  P.roads_detail = { target: { x: 230, z: -100 }, distance: 62, yaw: 0.5, pitch: 0.62, time: 16.2 };
  P.roads_avenue = { target: { x: av.x, z: av.z }, distance: 95, yaw: 0.95, pitch: 0.55 };
  // night: the local cross junction with its corner lamps and light pools, low enough to read the pools and the
  // specular streaks on the asphalt (the avenue junction sits in dense forest on several seeds)
  P.roads_night = { target: { x: 230, z: -100 }, distance: 78, yaw: 0.5, pitch: 0.42, time: 21 };
  P.roads_curve = { target: { x: cx + 40, z: cz }, distance: 330, yaw: -0.7, pitch: 0.62 };
  P.roads_highway = { target: { x: hwMid.x, z: hwMid.z }, distance: 210, yaw: hwMid.x > 0 ? 2.35 : -2.35, pitch: 0.38 };
  P.roads_path = { target: { x: pc.x, z: pc.z }, distance: 26, yaw: 1.15, pitch: 0.5 };
  P.roads_deadend = { target: { x: 175, z: -45 }, distance: 42, yaw: 0.35, pitch: 0.55 };
  P.roads_top = { target: { x: 60, z: -80 }, distance: 760, yaw: 0, pitch: 86 * D };
  P.roads_diagonal = { target: { x: 230, z: 50 }, distance: 70, yaw: 0.4, pitch: 0.6 };
  P.roads_transition = { target: { x: 20, z: 440 }, distance: 110, yaw: 2.9, pitch: 0.5, time: 16.2 };

  // the showcase's own default time is the hero's low sun, not the engine's noon
  if (window.__game.setTime) window.__game.setTime(16.2);
}
