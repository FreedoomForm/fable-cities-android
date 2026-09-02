/**
 * Simulation showcase (?showcase=simulation). Builds a small grid town through the public
 * roads / zoning / buildings APIs when they are available, places one of every city service,
 * fast-forwards nine game weeks so the economy has real numbers and registers camera presets.
 * The coverage info view is off by default (CS2 shows it only while the info tool is active);
 * the `simulation_infoview` preset switches it on, `?infoview=<type|all>` forces it.
 */
import { makeRng, hashString } from '../../shared/random.js';
import { DEG2RAD } from '../../shared/math.js';
import { api } from './index.js';

const LINES = [-240, -160, -80, 0, 80, 160, 240];

/**
 * Service sites sit on their own block at the edge of the grid so the detail cameras have an
 * open foreground (countryside, not a neighbour's tower) — CS2 frames its service buildings the
 * same way. `cam` is the direction the camera sits in, used by the presets below.
 */
const SERVICE_BLOCKS = {
  fire: { x: 40, z: 200, yaw: 0, cam: { yaw: 18, pitch: 27, dist: 88 } },
  police: { x: -200, z: 40, yaw: -90 * DEG2RAD, cam: { yaw: -74, pitch: 26, dist: 84 } },
  education: { x: 200, z: 120, yaw: 90 * DEG2RAD, cam: { yaw: 104, pitch: 29, dist: 104 } },
  health: { x: -200, z: -120, yaw: -90 * DEG2RAD, cam: { yaw: -104, pitch: 27, dist: 94 } },
  water: { x: 120, z: -200, yaw: 180 * DEG2RAD, cam: { yaw: 196, pitch: 26, dist: 92 } },
};
const OUTSKIRTS = {
  power: { x: 302, z: -40, yaw: -90 * DEG2RAD },
  sewage: { x: -300, z: -60, yaw: 90 * DEG2RAD },
  garbage: { x: -304, z: 140, yaw: 90 * DEG2RAD },
};

/** Treasury the showcase hands over after six weeks: a real budget, not an infinite one. */
const SHOWCASE_TREASURY = 78400;

/**
 * Land use for a CS2-shaped small town: a compact downtown of four blocks, a broad ring of
 * medium-density housing, detached houses on the outskirts and one industrial quarter downwind
 * in the south-west. Roughly 2/3 of the land is residential, so the labour force actually fills
 * the job stock instead of leaving a hundred empty office floors.
 */
function zoneFor(bx, bz) {
  const r = Math.max(Math.abs(bx), Math.abs(bz));
  if (r <= 40) return bx * bz > 0 ? 'com-high' : 'office';   // downtown core (4 blocks)
  if (bx <= -120 && bz >= 120) return 'ind';                  // industrial quarter, SW corner
  if (r <= 120) return 'res-high';                            // mid-density ring
  if (bx >= 120 && bz <= -120) return 'com-low';              // retail strip on the NE edge
  return 'res-low';                                           // detached outskirts
}

export async function showcase(ctx) {
  const { world, events, config } = ctx;
  const rng = world.rng.fork(hashString('simulation-showcase'));
  const { services, visuals } = api.internals();
  const log = (...a) => console.info('[simulation:showcase]', ...a);

  // ---------------- 1. road grid (if the roads module is here) ----------------
  const roads = world.roads.api;
  let roadsBuilt = 0;
  if (roads && typeof roads.build === 'function') {
    try {
      for (const x of LINES) { roads.build([{ x, z: -240 }, { x, z: 240 }], x === 0 ? 'avenue' : 'local', { curve: 'straight' }); roadsBuilt++; }
      for (const z of LINES) { roads.build([{ x: -240, z }, { x: 240, z }], z === 0 ? 'avenue' : 'local', { curve: 'straight' }); roadsBuilt++; }
      roads.build([{ x: 240, z: -80 }, { x: 264, z: -80 }], 'local', { curve: 'straight' }); roadsBuilt++;
      roads.build([{ x: -240, z: -80 }, { x: -264, z: -80 }], 'local', { curve: 'straight' }); roadsBuilt++;
      roads.build([{ x: -240, z: 160 }, { x: -264, z: 160 }], 'local', { curve: 'straight' }); roadsBuilt++;
    } catch (err) { log('roads api failed', err); }
  } else log('roads api not available — skipping road grid');

  // ---------------- 2. zoning ----------------
  const zones = world.zones.api;
  const blocks = [];
  for (let i = 0; i < LINES.length - 1; i++) for (let j = 0; j < LINES.length - 1; j++) {
    const x0 = LINES[i], x1 = LINES[i + 1], z0 = LINES[j], z1 = LINES[j + 1];
    const bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
    const reserved = Object.values(SERVICE_BLOCKS).some((s) => s.x === bx && s.z === bz);
    blocks.push({ x0, x1, z0, z1, bx, bz, type: reserved ? null : zoneFor(bx, bz) });
  }
  if (zones && typeof zones.paintRect === 'function') {
    try {
      for (const b of blocks) if (b.type) zones.paintRect(b.x0 + 7, b.z0 + 7, b.x1 - 7, b.z1 - 7, b.type);
    } catch (err) { log('zones api failed', err); }
  } else log('zones api not available — skipping zoning');

  // ---------------- 3. service buildings ----------------
  for (const [type, p] of Object.entries(SERVICE_BLOCKS)) services.place(type, p.x, p.z, { free: true, yaw: p.yaw || 0 });
  for (const [type, p] of Object.entries(OUTSKIRTS)) services.place(type, p.x, p.z, { free: true, yaw: p.yaw || 0 });
  if (services.list.length < 8) log('some services could not be placed:', services.lastError);

  // ---------------- 4. buildings ----------------
  const buildings = world.buildings.api;
  if (buildings && typeof buildings.fastForward === 'function') {
    try { buildings.fastForward(3600 * 24 * 30); } catch (err) { log('buildings.fastForward failed', err); }
  }
  let synthetic = null;
  if (!world.buildings.list.length) {
    // no buildings module yet: feed the economy a deterministic stand-in city so the numbers are real,
    // and render those records as massing blocks (standins.js) so the population is visibly grounded.
    // Both drop away automatically once world.buildings.list is non-empty.
    synthetic = syntheticBuildings(blocks, rng, services.list.reduce((n, b) => n + b.workers, 0));
    for (const b of synthetic) b.y = world.terrain.getHeight(b.x, b.z);
    api.setBuildingSource(() => (world.buildings.list.length ? world.buildings.list : synthetic));
    if (visuals) visuals.setStandIns(synthetic);
    log(`buildings api not available — simulating ${synthetic.length} stand-in buildings`);
  }

  // ---------------- 5. run nine game weeks ----------------
  api.setTax('residential', 0.11);
  api.setTax('commercial', 0.10);
  api.setTax('industrial', 0.12);
  api.setTax('office', 0.09);
  api.fastForward(3600 * 24 * 63);
  // Hand the player a treasury a small town would actually have: the weekly ±¤2-3k swing and the
  // ¤90k milestone rewards then mean something (the sandbox default of ¤350k makes them noise).
  world.economy.money = SHOWCASE_TREASURY;
  if (world.economy.budget) world.economy.budget.money = SHOWCASE_TREASURY;
  api.setSpeed(config.paused ? 0 : 1);

  // ---------------- 6. info view (off unless asked; one service at a time) ----------------
  const forced = config.get('infoview', null);
  api.setInfoView(forced && forced !== 'none' ? forced : null);
  // 'water' is the one coverage view the HUD's own catalogue carries today, so routing the preset
  // through `tool:select` opens the real legend panel next to the overlay (see docs/requests/simulation.md).
  const INFO_PRESET_VIEW = config.get('infopreset', 'water');
  if (config.get('simhud') === '1') api.showHud(true);

  /**
   * Placing eight services leaves the tools overlay holding a preview outline, which draws a dashed
   * white line across the fire-house apron in every screenshot. Clear it through the tools module's
   * own public api (`debugPreview(null)` clears; see src/modules/tools/index.js) and deselect.
   */
  const clearToolGhost = () => {
    const t = world.tools && world.tools.api;
    if (t && typeof t.debugPreview === 'function') { try { t.debugPreview(null); } catch (_) { /* optional */ } }
    if (t && typeof t.debugPointer === 'function') { try { t.debugPointer(null); } catch (_) { /* optional */ } }
    if (t && typeof t.cancel === 'function') { try { t.cancel(); } catch (_) { /* optional */ } }
    events.emit('entity:selected', null);
  };

  // ---------------- 7. camera presets ----------------
  const P = window.__game.presets;
  const site = (id, extra = {}) => {
    const s = SERVICE_BLOCKS[id];
    return { target: { x: s.x + (extra.dx || 0), z: s.z + (extra.dz || 0) }, distance: extra.dist || s.cam.dist, yaw: (extra.yaw ?? s.cam.yaw) * DEG2RAD, pitch: (extra.pitch ?? s.cam.pitch) * DEG2RAD };
  };
  P.simulation_hero = { target: { x: 6, z: -6 }, distance: 545, yaw: 28 * DEG2RAD, pitch: 41 * DEG2RAD };
  P.simulation_detail = site('fire', { dz: -6 });
  P.simulation_night = { target: { x: 150, z: -20 }, distance: 390, yaw: 64.7 * DEG2RAD, pitch: 22.9 * DEG2RAD }; // plant in the foreground, lit town behind
  P.simulation_downtown = { target: { x: -30, z: 30 }, distance: 235, yaw: 34 * DEG2RAD, pitch: 21 * DEG2RAD };
  P.simulation_infoview = { target: { x: 0, z: 20 }, distance: 780, yaw: 0.32, pitch: 64 * DEG2RAD };
  P.simulation_water = site('water', { dz: 4 });
  P.simulation_clinic = site('health', { dx: 6 });
  P.simulation_school = site('education', { dx: -6 });
  P.simulation_police = site('police', { dx: 6 });
  P.simulation_power = { target: { x: 300, z: -36 }, distance: 175, yaw: -122 * DEG2RAD, pitch: 27 * DEG2RAD };
  P.simulation_sewage = { target: { x: -300, z: -60 }, distance: 118, yaw: 112 * DEG2RAD, pitch: 30 * DEG2RAD };
  P.simulation_landfill = { target: { x: -304, z: 140 }, distance: 136, yaw: 100 * DEG2RAD, pitch: 32 * DEG2RAD };
  P.simulation_fire_apron = { target: { x: 40, z: 210 }, distance: 46, yaw: 34 * DEG2RAD, pitch: 18 * DEG2RAD };

  // The info view belongs to its own preset: switch it on for `simulation_infoview`, off for every
  // other named preset (unless ?infoview= forces it). Going through `tool:select` means the HUD
  // opens its legend panel too, exactly as it does when a player picks the info view by hand.
  {
    const G = window.__game;
    const orig = G.setCamera;
    let armed = false;
    G.setCamera = (view, immediate) => {
      const ok = orig.call(G, view, immediate);
      if (typeof view === 'string' && view.startsWith('simulation_')) {
        clearToolGhost();
        const want = view === 'simulation_infoview';
        if (!forced && want !== armed) {
          armed = want;
          if (events.listenerCount('tool:select')) events.emit('tool:select', want ? 'info' : 'select', want ? { view: INFO_PRESET_VIEW } : {});
          else api.setInfoView(want ? INFO_PRESET_VIEW : null);
        }
      }
      return ok;
    };
    const origTime = G.setTime;
    if (typeof origTime === 'function') {
      G.setTime = (t) => { const r = origTime.call(G, t); clearToolGhost(); return r; };
    }
  }

  // Leave the game in the neutral 'select' tool with nothing selected: placing eight services
  // leaves the tools overlay holding a placement ghost, which draws a dashed outline across the
  // fire-house apron in every screenshot (see docs/requests/simulation.md).
  if (events.listenerCount('tool:select')) events.emit('tool:select', 'select', {});
  clearToolGhost();

  events.emit('notification', { kind: 'info', title: 'Simulation showcase', text: `${roadsBuilt} roads, ${services.list.length} services, ${world.economy.population.toLocaleString('en-US')} residents after 9 weeks.` });
  log('ready', api.stats());
}

/**
 * Deterministic stand-in buildings (used only when no buildings module exists): lots around all
 * four sides of every zoned block, fronting the streets. Job stock is sized to ~1.1× the labour
 * force at full occupancy (minus service staff) so the R/C/I balance can converge.
 */
function syntheticBuildings(blocks, rng, serviceWorkers = 0) {
  const out = [];
  let id = 1;
  const spec = {
    'res-low': { w: 13, d: 12, floors: [1, 2], residents: [5, 11], jobs: [0, 0], gap: 3.5 },
    'res-high': { w: 20, d: 18, floors: [5, 9], residents: [80, 150], jobs: [0, 0], gap: 2.5 },
    'com-low': { w: 15, d: 15, floors: [1, 2], residents: [0, 0], jobs: [8, 18], gap: 2 },
    'com-high': { w: 22, d: 20, floors: [6, 12], residents: [0, 0], jobs: [40, 85], gap: 2 },
    'ind': { w: 26, d: 22, floors: [1, 2], residents: [0, 0], jobs: [20, 40], gap: 3 },
    'office': { w: 22, d: 20, floors: [6, 14], residents: [0, 0], jobs: [35, 75], gap: 2 },
  };
  // setback from the block edge: road half-width (avenue 12 / local 6) + a 5 m front garden
  const sb = (line) => (line === 0 ? 12 : 6) + 5;
  for (const b of blocks) {
    if (!b.type) continue;
    const s = spec[b.type];
    const xw = b.x0 + sb(b.x0), xe = b.x1 - sb(b.x1), zn = b.z0 + sb(b.z0), zs = b.z1 - sb(b.z1);
    const make = (x, z, yaw) => {
      const floors = rng.int(s.floors[0], s.floors[1]);
      const w = s.w * rng.range(0.9, 1.08), d = s.d * rng.range(0.9, 1.08);
      out.push({
        id: 'demo-' + id++, lotId: null, type: b.type, level: rng.int(1, 3), x, y: 0, z, yaw,
        w, d, floors, height: floors * 3.4 + (floors <= 2 ? 0.6 : 1.2),
        residents: rng.int(s.residents[0], s.residents[1]), jobs: rng.int(s.jobs[0], s.jobs[1]),
        state: 'built', progress: 1,
      });
    };
    const step = s.w + s.gap;
    // a row of lots centred between a0 and a1 along one axis
    const row = (a0, a1, fn) => {
      const n = Math.max(0, Math.floor((a1 - a0) / step));
      const start = (a0 + a1) / 2 - (n * step) / 2 + step / 2;
      for (let i = 0; i < n; i++) fn(start + i * step);
    };
    row(xw + s.d + 1, xe - s.d - 1, (x) => { make(x, zn + s.d / 2, Math.PI); make(x, zs - s.d / 2, 0); }); // north / south rows
    row(zn, zs, (z) => { make(xw + s.d / 2, z, -Math.PI / 2); make(xe - s.d / 2, z, Math.PI / 2); });   // west / east rows
  }
  // size the job stock: 1.1 × workers at full occupancy, service staff already counted
  const residents = out.reduce((n, b) => n + b.residents, 0);
  const jobs = out.reduce((n, b) => n + b.jobs, 0);
  const target = Math.max(0, residents * 0.62 * 1.1 - serviceWorkers);
  const k = jobs > 0 ? target / jobs : 1;
  for (const b of out) b.jobs = Math.round(b.jobs * k);
  return out;
}
