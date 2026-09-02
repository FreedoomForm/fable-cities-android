/**
 * buildings showcase — a zoned town grown purely through the public APIs (roads → zoning → buildings).
 * 8×8 blocks on an 80 m grid around two avenues, one curved boulevard on the west edge, six districts
 * (com-high core, office north, res-high south, com-low along the avenue, res-low suburbs, industry
 * north-west), 60 game days of growth via buildings.api.fastForward, a few active construction sites.
 * Run with ?showcase=buildings&seed=7. Presets: buildings_hero, buildings_detail, buildings_night.
 */
import { hashString } from '../../shared/random.js';

const LINES = [-320, -240, -160, -80, 0, 80, 160, 240, 320];

/** District plan by block centre. */
export function districtFor(bx, bz) {
  const r = Math.max(Math.abs(bx), Math.abs(bz));
  if (r <= 80) return 'com-high';
  if (r <= 160) {
    if (Math.abs(bx) <= 80) return bz > 0 ? 'com-low' : 'com-high';
    return bz < 0 ? 'office' : 'res-high';
  }
  if (r <= 240) {
    if (Math.abs(bx) <= 80 && bz > 0) return 'com-low';
    if (bz > 0) return 'res-low';
    return bx < 0 ? 'ind' : 'res-high';
  }
  if (bx < -160 && bz < -80) return 'ind';
  if (bx > 160 && bz < -160) return 'office';
  return 'res-low';
}

export async function showcase(ctx) {
  const { world, config } = ctx;
  const log = (...a) => console.info('[buildings:showcase]', ...a);
  const roads = world.roads.api;
  const zones = world.zones.api;
  const buildings = world.buildings.api;
  if (!buildings) throw new Error('buildings api missing');
  const rng = world.rng.fork(hashString('buildings-showcase'));

  // ---------------- 1. roads ----------------
  if (roads && typeof roads.build === 'function') {
    for (const x of LINES) roads.build([{ x, z: -330 }, { x, z: 330 }], x === 0 ? 'avenue' : 'local', { curve: 'straight' });
    for (const z of LINES) roads.build([{ x: -330, z }, { x: 330, z }], z === 0 ? 'avenue' : 'local', { curve: 'straight' });
    // curved suburban boulevard on the west edge + two connectors
    roads.build([{ x: -320, z: 330 }, { x: -470, z: 160 }, { x: -470, z: -160 }, { x: -320, z: -330 }], 'local', { curve: 'bezier' });
    roads.build([{ x: -320, z: 80 }, { x: -430, z: 80 }], 'local', { curve: 'straight' });
    roads.build([{ x: -320, z: -80 }, { x: -430, z: -80 }], 'local', { curve: 'straight' });
    if (typeof roads.flush === 'function') roads.flush();
  } else log('roads api not available');

  // ---------------- 2. zoning ----------------
  const blocks = [];
  for (let i = 0; i < LINES.length - 1; i++) for (let j = 0; j < LINES.length - 1; j++) {
    const x0 = LINES[i], x1 = LINES[i + 1], z0 = LINES[j], z1 = LINES[j + 1];
    blocks.push({ x0, x1, z0, z1, bx: (x0 + x1) / 2, bz: (z0 + z1) / 2, type: districtFor((x0 + x1) / 2, (z0 + z1) / 2) });
  }
  const inset = (line) => (line === 0 ? 13.5 : 7.5);
  let lots = [];
  if (zones && typeof zones.paintRect === 'function') {
    for (const b of blocks) zones.paintRect(b.x0 + inset(b.x0), b.z0 + inset(b.z0), b.x1 - inset(b.x1), b.z1 - inset(b.z1), b.type);
    // west boulevard: suburban ribbon
    zones.paintRect(-500, -340, -326, 340, 'res-low');
    lots = zones.lotsFor();
  } else {
    lots = buildings.autoZone({ typeFor: (seg, x, z) => districtFor(x, z) });
    log('zoning api not available — using fallback lots');
  }
  log(`${lots.length} lots`);

  // ---------------- 3. growth ----------------
  buildings.fastForward(3600 * 24 * 60);

  // a few active construction sites of different types near the core (a mature city is always building)
  const list = world.buildings.list;
  const wanted = ['com-high', 'res-high', 'office', 'com-low', 'res-low', 'ind'];
  for (const type of wanted) {
    const cands = list.filter((b) => b.type === type && b.state === 'built' && Math.hypot(b.x, b.z) < 260);
    if (!cands.length) continue;
    const b = cands[Math.floor(rng() * cands.length)];
    const lot = lots.find((l) => l.id === b.lotId);
    if (!lot) continue;
    const level = Math.min(5, b.level + 1);
    buildings.remove(b.id);
    buildings.spawn(lot, { level, seed: b.seed, state: 'construction', progress: 0.2 + rng() * 0.55 });
  }
  const st = buildings.stats();
  log(`${st.buildings} buildings (${st.built} built, ${st.construction} under construction), ${st.residents} residents, ${st.jobs} jobs`);

  // ---------------- 4. camera presets ----------------
  const P = (window.__game.presets = window.__game.presets || {});
  // hero, detail and night all sit at a LOW sun (elevation 22-34 deg, LOOK_TARGET row "times of
  // day"): a noon overview is the shot we lost the blind comparison with.
  P.buildings_hero = { target: { x: 30, z: 70 }, distance: 400, yaw: 0.72, pitch: 0.42, time: 16.2 };
  P.buildings_detail = { target: { x: 84, z: 196 }, distance: 88, yaw: -0.65, pitch: 0.28, time: 16.2 };
  P.buildings_night = { target: { x: 0, z: 20 }, distance: 290, yaw: 2.35, pitch: 0.4, time: 21 };
  P.buildings_industry = { target: { x: -230, z: -190 }, distance: 200, yaw: 2.6, pitch: 0.38, time: 16.2 };
  P.buildings_suburb = { target: { x: -240, z: 200 }, distance: 130, yaw: 0.4, pitch: 0.30, time: 16.2 };
  // default the showcase clock to the low sun unless the URL asked for a specific hour
  try {
    if (!new URLSearchParams(window.location.search).has('time')) window.__game.setTime(16.2);
  } catch (e) { /* non-browser host */ }
  if (config.debug) log('presets registered');
}
