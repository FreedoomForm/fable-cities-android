/**
 * zoning showcase — a small mixed-use district built purely through world.roads.api, then zoned with
 * world.zones.api: an avenue spine with a downtown core, an orthogonal local grid with a diagonal
 * street (acute junctions), a curved suburban loop with cul-de-sacs, an industrial estate and an
 * office quarter. Part of the grid is left unzoned on purpose so the empty CS2-style grid is visible.
 * The district is then grown through world.buildings.api so the ground treatment (ZoneGround: paved
 * plazas, parking aprons, service yards, suburban drives and beds) is judged with buildings standing on
 * it — "dense blocks on paving, not lawn" does not read on empty parcels.
 *
 * Run with ?showcase=zoning&seed=7. Presets carry a `time` (low sun, never noon) and an `overlay` flag:
 *   zoning_hero    district beauty shot, overlay off — the ground treatment in context
 *   zoning_detail  ground treatment close up (plaza, bays, yards, kerb AO), overlay off
 *   zoning_night   downtown at 21:00 with the overlay on — night readability
 *   zoning_overlay / zoning_tool   the zoning tool: colour fields, parcel borders, hover + brush
 *   zoning_curve   the grid following a curved loop · zoning_grid  the bare zonable grid
 *   zoning_street  paving, drives and kerb AO at 50 m
 */
import { hashString } from '../../shared/random.js';

export async function showcase(ctx) {
  const { world } = ctx;
  const roads = world.roads.api;
  const zones = world.zones.api;
  if (!roads) throw new Error('roads api missing');
  if (!zones) throw new Error('zones api missing');
  const rng = world.rng.fork(hashString('zoning-showcase'));

  // --- 1. avenue spine (gentle S-curve, split by every junction) ---
  roads.build([{ x: -12, z: -360 }, { x: 40, z: -120 }, { x: -40, z: 120 }, { x: 8, z: 360 }], 'avenue', { curve: 'bezier' });
  const onAvenue = (z) => {
    const h = roads.nearest(0, z, 160);
    return h && h.segment.type === 'avenue' ? { x: h.point.x, z: h.point.z } : { x: 0, z };
  };

  // --- 2. local grid east of the avenue: 4 rows × 3 columns of blocks (block ≈ 96 m) ---
  const rows = [-300, -200, -100, 0, 100, 200, 300];
  for (const z of rows) roads.build([onAvenue(z), { x: 330, z }], 'local');
  for (const x of [110, 220, 330]) roads.build([{ x, z: -300 }, { x, z: 300 }], 'local');
  // a diagonal high street through the south-east blocks → acute junctions
  roads.build([{ x: 110, z: 300 }, { x: 330, z: 100 }], 'local');
  // dead-end service stub into the industrial estate
  roads.build([{ x: 165, z: -300 }, { x: 165, z: -250 }], 'local');

  // --- 3. curved suburban loop west of the avenue, with connectors and two cul-de-sacs ---
  const cx = -250, cz = 40;
  const loop = [];
  const N = 10;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 135 + rng.range(-16, 16);
    loop.push({ x: cx + Math.cos(a) * r * 1.12, z: cz + Math.sin(a) * r });
  }
  loop.push({ x: loop[0].x, z: loop[0].z });
  roads.build(loop, 'local', { curve: 'catmull' });
  const onLoop = (x, z) => { const h = roads.nearest(x, z, 120); return h ? { x: h.point.x, z: h.point.z } : { x, z }; };
  const cA = onAvenue(-60), lA = onLoop(cx + 150, cz - 70);
  roads.build([cA, { x: (cA.x + lA.x) / 2 + 8, z: (cA.z + lA.z) / 2 - 18 }, lA], 'local', { curve: 'bezier' });
  const cB = onAvenue(150), lB = onLoop(cx + 150, cz + 90);
  roads.build([cB, { x: (cB.x + lB.x) / 2 - 6, z: (cB.z + lB.z) / 2 + 22 }, lB], 'local', { curve: 'bezier' });
  const s1 = onLoop(cx - 150, cz - 20);
  roads.build([s1, { x: cx - 80, z: cz - 40 }, { x: cx - 35, z: cz - 10 }], 'local', { curve: 'bezier' });
  const s2 = onLoop(cx + 30, cz + 135);
  roads.build([s2, { x: cx + 45, z: cz + 60 }, { x: cx + 20, z: cz + 15 }], 'local', { curve: 'bezier' });

  // --- 4. zoning: paint by block rectangles (cells whose centre lies inside the rectangle) ---
  const block = (gx, gz, type) => {
    // block (gx, gz) spans x ∈ [110·gx … 110·(gx+1)], z ∈ [100·gz … 100·(gz+1)] relative to (0, -300)
    const x0 = gx === 0 ? -40 : 110 * gx, x1 = 110 * (gx + 1);
    const z0 = -300 + 100 * gz, z1 = z0 + 100;
    zones.paintRect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, type);
  };
  // downtown core along the avenue (west and east frontages): high commercial, offices north, high-res south
  zones.paintRect(-60, -340, -2, -180, 'office');
  zones.paintRect(-60, -180, -2, 60, 'com-high');
  zones.paintRect(-60, 60, -2, 340, 'res-high');
  // east grid — row 0 (z -300..-200) industrial estate, row 1 offices/commercial, rows 2-3 downtown, rows 4-5 residential
  block(0, 0, 'ind'); block(1, 0, 'ind'); block(2, 0, 'ind');
  block(0, 1, 'office'); block(1, 1, 'office'); block(2, 1, 'com-low');
  block(0, 2, 'com-high'); block(1, 2, 'com-low'); block(2, 2, 'res-high');
  block(0, 3, 'com-high'); block(1, 3, 'res-high'); block(2, 3, 'res-high');
  block(0, 4, 'res-high'); block(1, 4, 'res-low'); block(2, 4, 'com-low');
  block(0, 5, 'res-low'); block(1, 5, 'res-low'); // block (2,5) intentionally left unzoned → empty grid visible
  // suburban loop: low-density residential everywhere around the loop
  zones.paintRect(cx - 175, cz - 175, cx + 165, cz + 175, 'res-low');
  // small mixed corner at the loop connectors
  zones.paintRect(cx + 90, cz - 60, cx + 175, cz + 5, 'com-low');

  // --- 5. grow the district so the ground treatment is judged in context, not on empty parcels ---
  // (the zoning showcase disables the demo city, and "dense blocks on paving vs lawn" only reads with
  //  buildings standing on the parcels — see JUDGE_FEEDBACK defect #5)
  const buildings = world.buildings && world.buildings.api;
  if (buildings) {
    const brng = world.rng.fork(hashString('zoning-showcase-buildings'));
    const LEVELS = { 'res-low': [1, 2], 'res-high': [2, 4], 'com-low': [1, 3], 'com-high': [3, 5], office: [3, 5], ind: [1, 3] };
    for (const lot of zones.lotsFor()) {
      // block (2,5) and a scatter of parcels stay empty so the bare CS2 grid is still visible
      if (lot.x > 220 && lot.z > 200) continue;
      if (brng() < 0.12) continue;
      const lv = LEVELS[lot.type] || [1, 2];
      try { buildings.spawn(lot, { level: Math.round(lv[0] + brng() * (lv[1] - lv[0])), state: 'built' }); } catch (_) { /* non-fatal */ }
    }
  }

  // representative interactive state, framed by zoning_detail: a hovered cell next to the kerb and a
  // 3×2-cell brush preview on the empty frontage across the junction (what the player sees while zoning).
  const lots = zones.lotsFor();
  let near = null, bestD = Infinity;
  for (const l of lots) { const d = (l.x - 86) ** 2 + (l.z - 114) ** 2; if (d < bestD) { bestD = d; near = l; } }
  if (near) zones.setHover(near.x, near.z);
  zones.setBrush({ x0: 127, z0: 108, x1: 159, z1: 132 }, 'com-high');

  const G = window.__game;
  const P = G.presets;
  // Presets carry `time` (low sun, never noon — LOOK_TARGET puts the CS2 beauty band at hour 16.0-16.5)
  // and `overlay`: the coloured zone tiles belong to the zoning *tool*, so the district beauty shots run
  // without them and the tool shots with them. An explicit --time on the CLI still wins (shot.mjs calls
  // setTime after setCamera).
  // district overview: avenue spine, downtown core, suburb loop and industrial estate in one frame
  P.zoning_hero = { target: { x: 40, z: 10 }, distance: 540, yaw: 0.78, pitch: 0.60, time: 16.3, overlay: false };
  // ground treatment close up: plaza paving against the kerb, painted parking bays, concrete service
  // yards, tyre wear and the contact darkening at every building foot (no overlay — this is the world)
  P.zoning_detail = { target: { x: 214, z: 150 }, distance: 100, yaw: 0.76, pitch: 0.47, time: 16.3, overlay: false };
  // night readability over the downtown core
  P.zoning_night = { target: { x: -10, z: -70 }, distance: 300, yaw: -0.9, pitch: 0.55, time: 21.0, overlay: true };
  // the same district with the zoning overlay on — CS2 colour fields over the real ground treatment
  P.zoning_overlay = { target: { x: 40, z: 10 }, distance: 540, yaw: 0.78, pitch: 0.60, time: 16.3, overlay: true };
  // the zoning tool at work: four zone types meeting at a junction, parcel borders, frontage bars,
  // hover ring and the 3x2-cell brush preview
  P.zoning_tool = { target: { x: 118, z: 104 }, distance: 96, yaw: 0.95, pitch: 0.48, time: 16.3, overlay: true };
  // curved suburban loop: cells follow the road, cul-de-sacs, soft outer edge
  P.zoning_curve = { target: { x: -258, z: 55 }, distance: 250, yaw: 0.4, pitch: 0.78, time: 16.3, overlay: true };
  // the deliberately unzoned block: the bare CS2 zonable grid next to painted zones
  P.zoning_grid = { target: { x: 274, z: 250 }, distance: 150, yaw: 2.2, pitch: 0.52, time: 16.3, overlay: true };
  // street level: paving, painted bays, tyre wear and kerb AO at eye height
  P.zoning_street = { target: { x: -158, z: 92 }, distance: 52, yaw: 0.9, pitch: 0.40, time: 16.3, overlay: false };

  // Apply the per-preset time / overlay state. showcase.js owns its own presets, so it wraps the debug
  // setCamera rather than asking core for a new field.
  if (!G.__zoningPresetHook) {
    G.__zoningPresetHook = true;
    const base = G.setCamera.bind(G);
    G.setCamera = (nameOrView, immediate = true) => {
      const view = typeof nameOrView === 'string' ? G.presets[nameOrView] : nameOrView;
      const ok = base(nameOrView, immediate);
      if (ok && view) {
        if (typeof view.overlay === 'boolean' && world.zones.api) world.zones.api.setOverlayVisible(view.overlay);
        if (Number.isFinite(view.time)) G.setTime(view.time);
      }
      return ok;
    };
  }

  // default state for ?showcase=zoning with no explicit camera: the district beauty shot at a low sun
  zones.setOverlayVisible(false);
  const hasTime = new URLSearchParams(window.location.search).has('time');
  if (!hasTime) G.setTime(16.3);
}
