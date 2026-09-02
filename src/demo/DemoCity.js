/**
 * Demo city generator — builds a lived-in coastal city on start so that screenshots and critics
 * always see a populated scene. Uses ONLY the public module APIs (terrain / roads / zones /
 * buildings / services / traffic / props / simulation); it never reaches into a module's internals.
 *
 * The city is laid out in a LOCAL FRAME aligned to the coastline that the site picker found:
 *   +v points out to sea, +u runs along the shore (right-handed with +v).
 * Everything below is written in (u, v) metres and mapped to world XZ by `L(u, v)`.
 *
 *   v = SHORE …            open water
 *   v = shore(u) − 16      waterfront promenade (pedestrian path following the real shoreline)
 *   v = COAST_V            coastal boulevard (avenue) + downtown grid begins
 *   v = CORE_V             cross avenue through the middle of downtown
 *   … inland …            mid-rise ring → suburbs (curved crescents) → business park
 *   v = HW_V               motorway with a trumpet interchange onto the avenue spine
 *                          industry sits between the interchange and the city, downwind to +u
 *
 * Everything is deterministic for a given `?seed`.
 */
import { DEG2RAD, clamp, lerp } from '../shared/math.js';
import { Gfx } from './gfx.js';
import { buildDistrictGround } from './DistrictGround.js';
import { buildLandmarks } from './Landmarks.js';
import { shapeMotorway, dressMotorway, buildRail, buildPort } from './Infrastructure.js';
import { registerPresets } from './presets.js';

// ------------------------------------------------------------------------------------------------
// layout constants (metres, local frame)

// Block pitch. Zoning reaches 4 cells (32 m) back from each kerb, and at a block corner the deep
// cells are lost to the perpendicular street, so a *short* block is all corner and yields shallow
// 2-deep parcels. 96 m gives twelve frontages per edge, six of them full 4-cell depth — CS2-sized
// lots with room for real towers — and leaves a ~20 m green core of back gardens.
const DT = 88;

// column (u) grid lines. 0 is the avenue spine; 13 lines → 12 blocks across.
const COLS = Array.from({ length: 13 }, (_, i) => (i - 6) * DT);
// row (v) offsets below COAST_V. index 0 is the coastal boulevard; 8 lines → 7 blocks deep.
const ROWS = Array.from({ length: 8 }, (_, j) => -j * DT);
const AVENUE_COLS = new Set([-3 * DT, 0, 3 * DT]);  // u values built as avenues
const AVENUE_ROWS = new Set([0, 2]);          // ROWS indices built as avenues

const GRID_U0 = COLS[0], GRID_U1 = COLS[COLS.length - 1];
const GRID_V0 = ROWS[ROWS.length - 1];   // inland edge of the grid (most negative v)

export async function buildDemoCity(ctx) {
  const { world, config, events } = ctx;
  const roads = world.roads && world.roads.api;
  if (!roads || typeof roads.build !== 'function') {
    console.warn('[demo] roads api not available yet — skipping demo city');
    return;
  }
  const t0 = performance.now();
  // The demo fabricates months of history in a few hundred ms; the resulting milestone / budget /
  // service toasts would otherwise cover a quarter of the first screenshots.
  const unmute = events.mute ? events.mute('notification') : () => {};
  // Freeze the clock while we build: the demo awaits real frames between phases, and a running
  // simulation would make the final population depend on wall-clock speed rather than on ?seed.
  const speed0 = world.time.speed, paused0 = world.time.paused;
  world.time.speed = 0; world.time.paused = true;
  events.emit('time:speed', 0);

  const rng = world.rng.fork(0xde30c1);
  const terrain = world.terrain;
  // The demo's own PBR sets (paving, concrete, metal, brick, wood) start loading now and are awaited
  // after the road network is built, so the decode overlaps the ~1.4 s of road meshing.
  const gfx = new Gfx(ctx);
  const gfxReady = gfx.load().catch((err) => { console.error('[demo] gfx load failed', err); return null; });
  const phase = {};
  let tMark = performance.now();
  const mark = (name) => { const n = performance.now(); phase[name] = Math.round(n - tMark); tMark = n; };

  // ------------------------------------------------------------------ 1. site + local frame
  const site = pickSite(terrain, world);
  mark('site');
  const { cx, cz, ux, uz, vx, vz } = site;
  /** local (u,v) → world {x,z} */
  const L = (u, v) => ({ x: cx + ux * u + vx * v, z: cz + uz * u + vz * v });
  /** world (x,z) → local {u,v} */
  const toLocal = (x, z) => {
    const dx = x - cx, dz = z - cz;
    return { u: dx * ux + dz * uz, v: dx * vx + dz * vz };
  };
  const heightAt = (u, v) => { const p = L(u, v); return terrain.getHeight(p.x, p.z); };

  // shoreline profile in the local frame: shore(u) = v where the water starts (Infinity inland)
  const shore = shoreProfile(terrain, world, L, site.shoreDist);
  mark('shore');
  const COAST_V = Math.round(clamp(shore.minV - 54, -220, 620));
  const CORE_V = COAST_V + ROWS[2];
  const HW_V = COAST_V + GRID_V0 - 300;             // motorway, well inland of the last grid row
  const IND_U0 = 190, IND_U1 = 720;                 // industry: downwind side, by the interchange
  const IND_V0 = HW_V + 96, IND_V1 = HW_V + 300;

  // ------------------------------------------------------------------ 1b. district plan
  // Blocks are addressed by (i, j) = (column gap, row gap) of the main grid. Some are held back from
  // zoning: civic blocks take a service building, park blocks keep the terrain's trees, landmark
  // blocks are built by the demo itself, and one is zoned last so there is a live building site.
  // Nine blocks, not fourteen: every reserved block is frontage the city cannot build on, and on a
  // cramped site that is the difference between 15k residents and 9k. The rest of the service
  // buildings find their own plot through tryPlace()'s spiral search.
  const CIVIC = new Map([
    ['4,1', 'police'], ['8,4', 'fire'], ['3,3', 'health'], ['9,2', 'education'],
    ['1,5', 'education'], ['6,5', 'fire'], ['10,0', 'water'], ['2,1', 'health'], ['7,3', 'police'],
    ['5,6', 'education'], ['11,4', 'health'], ['0,2', 'education'],
    ['1,0', 'police'], ['10,6', 'fire'],
  ]);
  // Heavy utilities need a plot no lot may claim, so the zoning field carves these discs out and the
  // buildings are placed before anything grows.
  const UTIL = [
    { t: 'power', u: IND_U1 - 40, v: IND_V0 + 34, r: 62 },
    { t: 'power', u: -310, v: COAST_V + GRID_V0 - 96, r: 62 },
    { t: 'sewage', u: IND_U0 - 130, v: IND_V0 + 18, r: 56 },
    { t: 'sewage', u: -300, v: HW_V + 150, r: 56 },
    { t: 'garbage', u: 470, v: HW_V + 58, r: 64 },
    { t: 'fire', u: IND_U0 + 200, v: IND_V1 - 34, r: 42 },
    { t: 'police', u: GRID_U0 - 300, v: COAST_V + ROWS[4] + 30, r: 42 },
    { t: 'water', u: GRID_U0 - 316, v: COAST_V + ROWS[6] - 30, r: 40 },
    { t: 'water', u: GRID_U1 + 246, v: COAST_V + ROWS[2] - 20, r: 40 },
  ];
  const PARKS = new Set(['5,1', '8,2', '2,3', '9,5']);
  const SITE_BLOCK = '2,2';   // zoned last -> visible construction
  // Signature silhouettes the buildings module cannot grow out of a 32 m lot.
  const LANDMARK = new Map([
    ['6,1', 'tower_deco'], ['5,2', 'tower_twin'], ['7,2', 'tower_round'],
    ['4,2', 'townhall'], ['6,4', 'cathedral'],
  ]);
  const colOf = (u) => { for (let i = 0; i < COLS.length - 1; i++) if (u >= COLS[i] && u < COLS[i + 1]) return i; return -1; };
  const rowOf = (v) => { const t = v - COAST_V; for (let j = 0; j < ROWS.length - 1; j++) if (t <= ROWS[j] && t > ROWS[j + 1]) return j; return -1; };
  const blockTypes = new Map();
  const blockType = (i, j) => {
    const key = `${i},${j}`;
    let t = blockTypes.get(key);
    if (t === undefined) {
      const u = (COLS[i] + COLS[i + 1]) / 2, v = COAST_V + (ROWS[j] + ROWS[j + 1]) / 2;
      t = zoneFor(u, v - CORE_V, world.rng.fork(0x51de + i * 977 + j * 31));
      blockTypes.set(key, t);
    }
    return t;
  };
  // Yaw of the city frame in world space: demo geometry laid along local +u uses this rotation.
  const cityYaw = Math.atan2(-uz, ux);
  const hallShore = shore.at(150);
  const gset = {
    L, toLocal, COLS, ROWS, COAST_V, CORE_V, HW_V, GRID_U0, GRID_U1, GRID_V0, DT,
    IND_U0, IND_U1, IND_V0, IND_V1, PARKS, CIVIC, LANDMARK, blockType, yaw: cityYaw, shore, site,
    RAIL_U: -170,
    ARENA_U: GRID_U0 - 150, ARENA_V: COAST_V + GRID_V0 - 165,
    OBS_U: GRID_U1 + 215, OBS_V: COAST_V + ROWS[5] + 40,
    HALL_U: 150, HALL_V: Number.isFinite(hallShore) ? hallShore - 96 : COAST_V + 150,
  };

  // ------------------------------------------------------------------ 1c. grade the blocks
  // Real cities grade their blocks; ours were letting the raw hillside run through them, which cost
  // lots (zoning drops steep cells, so a hilly seed produced half the population of a flat one) and
  // left grass berms and cut faces between the kerb and the buildings. Level each block to a
  // SMOOTHED version of its own ground height before the roads are built, so the streets become the
  // ramps between terraces and the blocks themselves are flat, buildable ground.
  const gradeBlocks = () => {
    if (!terrain.api || typeof terrain.api.conformPath !== 'function') return 0;
    const nI = COLS.length - 1, nJ = ROWS.length - 1;
    const H = new Float64Array(nI * nJ), wet = new Uint8Array(nI * nJ);
    const wl = terrain.waterLevel != null ? terrain.waterLevel : -Infinity;
    for (let i = 0; i < nI; i++) {
      for (let j = 0; j < nJ; j++) {
        const u0 = COLS[i], u1 = COLS[i + 1], v0 = COAST_V + ROWS[j + 1], v1 = COAST_V + ROWS[j];
        const hs = [];
        let nWet = 0, n = 0;
        for (let a = 0; a <= 2; a++) {
          for (let b = 0; b <= 2; b++) {
            const p = L(u0 + (u1 - u0) * (a / 2), v0 + (v1 - v0) * (b / 2));
            if (!world.inBounds(p.x, p.z)) { nWet++; n++; continue; }
            if (terrain.isWater && terrain.isWater(p.x, p.z)) nWet++;
            hs.push(terrain.getHeight(p.x, p.z));
            n++;
          }
        }
        hs.sort((a, b) => a - b);
        H[i * nJ + j] = hs.length ? hs[hs.length >> 1] : wl + 2;
        wet[i * nJ + j] = nWet > n * 0.34 ? 1 : 0;
      }
    }
    // smooth so neighbouring terraces step gently instead of forming walls
    for (let pass = 0; pass < 2; pass++) {
      const src = H.slice();
      for (let i = 0; i < nI; i++) {
        for (let j = 0; j < nJ; j++) {
          let sum = 0, w = 0;
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || ii >= nI || jj < 0 || jj >= nJ) continue;
              const k = di === 0 && dj === 0 ? 3 : 1;
              sum += src[ii * nJ + jj] * k; w += k;
            }
          }
          H[i * nJ + j] = sum / w;
        }
      }
    }
    let graded = 0;
    for (let i = 0; i < nI; i++) {
      for (let j = 0; j < nJ; j++) {
        if (wet[i * nJ + j]) continue;
        const y = Math.max(H[i * nJ + j], wl + 1.4);
        const vc = COAST_V + (ROWS[j] + ROWS[j + 1]) / 2;
        const a = L(COLS[i] + 10, vc), b = L(COLS[i + 1] - 10, vc);
        terrain.api.conformPath([{ x: a.x, y, z: a.z }, { x: b.x, y, z: b.z }], DT - 30, 20);
        graded++;
      }
    }
    return graded;
  };
  let gradedBlocks = 0;
  try { gradedBlocks = gradeBlocks(); } catch (err) { console.error('[demo] block grading failed', err); }
  mark('grade');

  // ------------------------------------------------------------------ 2. street network
  const M = 48;   // keep road ends off the map border
  const inside = (p) => p.x > -world.half + M && p.x < world.half - M && p.z > -world.half + M && p.z < world.half - M;
  /** Build a polyline given in local (u,v); clipped to the longest run of in-bounds points. */
  const build = (pts, type, opts) => {
    try {
      const w3 = pts.map((p) => (p.u !== undefined ? L(p.u, p.v) : p));
      let bs = -1, bl = 0, s = -1;
      for (let i = 0; i <= w3.length; i++) {
        if (i < w3.length && inside(w3[i])) { if (s < 0) s = i; continue; }
        if (s >= 0 && i - s > bl) { bl = i - s; bs = s; }
        s = -1;
      }
      if (bl < 2) return null;
      return roads.build(w3.slice(bs, bs + bl), type, opts);
    } catch (err) { console.error('[demo] road build failed', err); return null; }
  };
  const bez = { curve: 'bezier' };

  // The motorway mainline sits on an embankment. Shaping the ground BEFORE the carriageway is built
  // is the whole trick: the road conforms to the raised crest, the slip roads climb the batter, and
  // the interchange stops reading as grey ribbons painted on a field.
  const HW_PTS = [
    { u: -620, v: HW_V - 26 }, { u: -380, v: HW_V + 14 }, { u: -120, v: HW_V + 4 },
    { u: 300, v: HW_V - 10 }, { u: 560, v: HW_V + 16 }, { u: 760, v: HW_V - 6 },
  ];
  try { shapeMotorway(ctx, gset, HW_PTS); } catch (err) { console.error('[demo] embankment failed', err); }

  try {
    // --- motorway across the inland edge, with a gentle S so it is not a ruler line
    build(HW_PTS, 'highway', bez);

    // --- avenue spine: interchange → downtown boulevard
    build([{ u: 0, v: HW_V + 210 }, { u: 0, v: COAST_V }], 'avenue');

    // --- trumpet interchange: four slip roads between the spine and the motorway
    build([{ u: 0, v: HW_V + 186 }, { u: 96, v: HW_V + 150 }, { u: 210, v: HW_V + 62 }, { u: 330, v: HW_V + 20 }, { u: 470, v: HW_V + 4 }], 'local', bez);
    build([{ u: -470, v: HW_V + 2 }, { u: -330, v: HW_V + 22 }, { u: -206, v: HW_V + 64 }, { u: -92, v: HW_V + 152 }, { u: 0, v: HW_V + 186 }], 'local', bez);
    build([{ u: 0, v: HW_V + 128 }, { u: -120, v: HW_V + 116 }, { u: -196, v: HW_V + 44 }, { u: -150, v: HW_V + 4 }], 'local', bez);
    build([{ u: 0, v: HW_V + 128 }, { u: 132, v: HW_V + 120 }, { u: 214, v: HW_V + 48 }, { u: 168, v: HW_V + 4 }], 'local', bez);

    // --- the main grid ----------------------------------------------------------------
    for (let j = 0; j < ROWS.length; j++) {
      const v = COAST_V + ROWS[j];
      const type = AVENUE_ROWS.has(j) ? 'avenue' : 'local';
      const pad = AVENUE_ROWS.has(j) ? 108 : 0;   // avenues run past the grid into the outskirts
      build([{ u: GRID_U0 - pad, v }, { u: 0, v }, { u: GRID_U1 + pad, v }], type);
    }
    for (let i = 0; i < COLS.length; i++) {
      const u = COLS[i];
      if (AVENUE_COLS.has(u)) continue;                 // the spine is already built
      // outer columns stop short of the coast where the land narrows
      const vTop = COAST_V + (Math.abs(u) > 380 ? ROWS[1] : ROWS[0]);
      build([{ u, v: vTop }, { u, v: COAST_V + GRID_V0 }], 'local');
    }

    // --- coastal boulevard continues along the shore past the grid, curving with the bay
    const promW = [], boulE = [], boulW = [];
    for (let u = GRID_U0 - 108; u >= GRID_U0 - 430; u -= 108) boulW.push({ u, v: COAST_V - 8 - (GRID_U0 - 108 - u) * 0.06 });
    for (let u = GRID_U1 + 108; u <= GRID_U1 + 430; u += 108) boulE.push({ u, v: COAST_V - 8 - (u - GRID_U1 - 108) * 0.06 });
    if (boulW.length) build([{ u: GRID_U0 - 108, v: COAST_V }, ...boulW], 'avenue', bez);
    if (boulE.length) build([{ u: GRID_U1 + 108, v: COAST_V }, ...boulE], 'avenue', bez);

    // --- esplanade: an avenue that follows the real shoreline, so the strip between the straight
    // boulevard and the water becomes waterfront blocks instead of an empty lawn.
    const esplV = (u) => {
      const sv = shore.at(u);
      return Number.isFinite(sv) ? Math.min(sv - 48, COAST_V + 300) : NaN;
    };
    let espl = [];
    const flushEspl = () => { if (espl.length > 2) build(espl, 'avenue', bez); espl = []; };
    for (let u = GRID_U0 - 70; u <= GRID_U1 + 70; u += 64) {
      const ev = esplV(u);
      if (!Number.isFinite(ev) || ev < COAST_V + 76) { flushEspl(); continue; }
      espl.push({ u, v: ev });
    }
    flushEspl();
    // cross streets tying the boulevard to the esplanade → real waterfront blocks
    for (let u = GRID_U0 + DT; u <= GRID_U1; u += DT) {
      const ev = esplV(u);
      if (!Number.isFinite(ev) || ev < COAST_V + 76) continue;
      build([{ u, v: COAST_V }, { u, v: ev }], 'local');
    }

    // --- waterfront promenade: a pedestrian path right at the water's edge
    for (let u = GRID_U0 - 60; u <= GRID_U1 + 60; u += 44) {
      const sv = shore.at(u);
      if (!Number.isFinite(sv)) { if (promW.length > 3) { build(promW.slice(), 'path', bez); } promW.length = 0; continue; }
      promW.push({ u, v: Math.min(sv - 14, COAST_V + 330) });
    }
    if (promW.length > 3) build(promW, 'path', bez);
    // short links from the esplanade down to the promenade
    for (let u = GRID_U0 + 96; u <= GRID_U1; u += 3 * DT) {
      const sv = shore.at(u), ev = esplV(u);
      if (!Number.isFinite(sv) || !Number.isFinite(ev) || sv - ev < 26) continue;
      build([{ u, v: ev }, { u: u + 10, v: (ev + sv) * 0.5 }, { u, v: sv - 14 }], 'path', bez);
    }

    // --- suburban crescents: two curved loops on the inland-west side of the grid
    const subCU = GRID_U0 - 170, subCV = COAST_V + ROWS[4] - 20;
    for (const [rad, a0, a1] of [[152, -80, 96], [238, -68, 88]]) {
      const pts = [];
      for (let k = 0; k <= 9; k++) {
        const a = lerp(a0, a1, k / 9) * DEG2RAD;
        pts.push({ u: subCU + Math.sin(a) * rad, v: subCV + Math.cos(a) * rad });
      }
      build(pts, 'local', bez);
    }
    // radials tying the crescents to the grid + two cul-de-sac stubs
    for (const a of [-58, 0, 58]) {
      const r0 = 112, r1 = 288, ar = a * DEG2RAD;
      build([
        { u: subCU + Math.sin(ar) * r0, v: subCV + Math.cos(ar) * r0 },
        { u: subCU + Math.sin(ar) * r1, v: subCV + Math.cos(ar) * r1 },
      ], 'local');
    }
    build([{ u: GRID_U0, v: subCV + 96 }, { u: subCU + 120, v: subCV + 124 }], 'local', bez);
    build([{ u: GRID_U0, v: subCV - 130 }, { u: subCU + 118, v: subCV - 158 }], 'local', bez);

    // --- eastern hillside suburb: one crescent hooked onto the grid
    const eCU = GRID_U1 + 190, eCV = COAST_V + ROWS[3] + 30;
    const ePts = [];
    for (let k = 0; k <= 8; k++) {
      const a = lerp(112, 250, k / 8) * DEG2RAD;
      ePts.push({ u: eCU + Math.sin(a) * 176, v: eCV + Math.cos(a) * 176 });
    }
    build(ePts, 'local', bez);
    build([{ u: GRID_U1, v: eCV + 40 }, { u: eCU - 96, v: eCV + 86 }], 'local', bez);
    build([{ u: GRID_U1, v: eCV - 152 }, { u: eCU - 74, v: eCV - 178 }], 'local', bez);

    // --- industrial estate + freight link to the motorway ramps
    build([{ u: IND_U0 - 190, v: IND_V1 + 40 }, { u: IND_U0 - 30, v: IND_V1 + 6 }, { u: IND_U1, v: IND_V1 - 10 }], 'avenue', bez);
    for (let u = IND_U0 - 30; u <= IND_U1; u += 112) build([{ u, v: IND_V1 + 6 }, { u: u + 14, v: IND_V0 }], 'local', bez);
    for (let v = IND_V0 + 96; v < IND_V1 - 30; v += 96) build([{ u: IND_U0 - 30, v }, { u: IND_U1, v }], 'local');
    build([{ u: 168, v: HW_V + 4 }, { u: 220, v: IND_V0 - 30 }, { u: IND_U0 - 30, v: IND_V0 }], 'local', bez);
    // spine → industry connector so trucks reach downtown
    build([{ u: 0, v: COAST_V + GRID_V0 }, { u: 180, v: COAST_V + GRID_V0 - 60 }, { u: IND_U0 - 30, v: IND_V1 + 6 }], 'avenue', bez);

    // --- a couple of country lanes so the city does not end at a hard rectangle
    build([{ u: GRID_U1 + 96, v: COAST_V + ROWS[6] }, { u: GRID_U1 + 260, v: COAST_V + ROWS[6] - 130 }, { u: GRID_U1 + 300, v: HW_V + 230 }], 'local', bez);

    roads.flush?.();
  } catch (err) {
    console.error('[demo] road network failed', err);
  }
  await frames(ctx, 3);
  mark('roads');

  // ------------------------------------------------------------------ 2b. landmarks
  // Sited and levelled BEFORE zoning, so their pads exist when lots are cut and the ground they
  // reserve is excluded from the land-use field.
  let landmarks = { spots: [], reserved: [] };
  let rail = null, port = null;
  try {
    await gfxReady;
    landmarks = buildLandmarks(ctx, gfx, gset);
  } catch (err) {
    console.error('[demo] landmarks failed', err);
  }
  mark('landmarks');

  // ------------------------------------------------------------------ 2c. infrastructure
  try {
    dressMotorway(ctx, gfx, gset);
    rail = buildRail(ctx, gfx, gset);
    port = buildPort(ctx, gfx, gset);
    for (const r of [...(rail ? rail.reserved : []), ...(port ? port.reserved : [])]) landmarks.reserved.push(r);

  } catch (err) {
    console.error('[demo] infrastructure failed', err);
  }
  mark('infra');

  // ------------------------------------------------------------------ 3. districts
  // Land use is a FIELD over the local frame, evaluated on the zoning module's own cells: walking
  // its cells (rather than painting world-axis rectangles) is the only way to cover a road grid that
  // is rotated against the world axes — a "cell centre inside my quad" test drops the kerb cell of
  // every other column, and a column whose kerb cell is unzoned is discarded whole.
  // Blocks are addressed by (i, j) = (column gap, row gap) of the main grid. A few are held back:
  // civic blocks take a service building, park blocks stay unzoned so the terrain keeps its trees and
  // they read as green squares, and one block is zoned last so there is a live construction site.
  const zones = world.zones && world.zones.api;
  const buckets = new Map();  // zoneType -> [{cx,cz}]
  const push = (type, cell) => {
    let a = buckets.get(type);
    if (!a) buckets.set(type, (a = []));
    a.push(cell);
  };
  /** Land use at a point in the local frame; null = leave unzoned. */
  const landUse = (u, v) => {
    const i = colOf(u), j = rowOf(v);
    if (i >= 0 && j >= 0) {
      const key = `${i},${j}`;
      if (PARKS.has(key) || CIVIC.has(key) || LANDMARK.has(key) || key === SITE_BLOCK) return null;
      return blockType(i, j);
    }
    for (const q of UTIL) { const du = u - q.u, dv2 = v - q.v; if (du * du + dv2 * dv2 < q.r * q.r) return null; }
    for (const q of landmarks.reserved) { const du = u - q.u, dv2 = v - q.v; if (du * du + dv2 * dv2 < q.r * q.r) return null; }
    if (v < HW_V + 44) return null;                                  // motorway verges stay green
    if (u > IND_U0 - 150 && u < IND_U1 + 90 && v > IND_V0 - 70 && v < IND_V1 + 70) return 'ind';
    if (v > COAST_V) return Math.abs(u) < 200 ? 'com-low' : 'res-high';   // waterfront apartments
    // Outskirts: terraces close to the grid softening into detached houses further out. The patch
    // size matters more than the mix — zoning discards a whole frontage column whose kerb cell has a
    // different type from the cells behind it, so a fine-grained mix costs lots (and therefore
    // population) on any seed whose streets do not line up with the patch grid.
    const edge = Math.max(0, Math.max(Math.abs(u) - GRID_U1, (COAST_V + GRID_V0) - v));
    const r = world.rng.fork(0x9a17 + Math.round(u / 224) * 613 + Math.round(v / 224) * 17);
    if (r.chance(0.10)) return 'com-low';
    return r.chance(edge < 200 ? 0.74 : edge < 380 ? 0.5 : 0.3) ? 'res-high' : 'res-low';
  };

  let siteCells = null;
  /** Walk every zoning cell in the map, classify it with the land-use field and paint it. */
  const paintZones = async () => {
    if (!zones || typeof zones.cellsInRect !== 'function') return;
    siteCells = [];
    buckets.clear();
    const seen = new Set();
    for (const c of zones.cellsInRect(-world.half, -world.half, world.half, world.half)) {
      const k = c.cz * 65536 + c.cx;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = world.cellCenter(c.cx, c.cz);
      const real = zones.cellAt(p.x, p.z);
      const l = toLocal(real ? real.x : p.x, real ? real.z : p.z);
      const i = colOf(l.u), j = rowOf(l.v);
      if (i >= 0 && j >= 0 && `${i},${j}` === SITE_BLOCK) { siteCells.push({ cx: c.cx, cz: c.cz }); continue; }
      const t = landUse(l.u, l.v);
      if (t) push(t, { cx: c.cx, cz: c.cz });
    }
    for (const [type, cells] of buckets) zones.paint(cells, type);
    await frames(ctx, 2);
  };
  try {
    await paintZones();
  } catch (err) {
    console.error('[demo] zoning failed', err);
  }
  mark('zoning');
  const lots = (world.zones.lots || []).length;

  // ------------------------------------------------------------------ 4. city services
  const svc = world.services && world.services.api;
  let placed = 0, refused = 0;
  /** Try a spot, then a small deterministic spiral around it, so a service always finds a free site. */
  const tryPlace = (type, u, v, spread = 0) => {
    if (!svc || typeof svc.place !== 'function') return false;
    const N = spread ? 22 : 0;
    for (let k = 0; k <= N; k++) {
      const a = k * 2.399963, r = spread * 1.5 * Math.sqrt(k / Math.max(1, N));
      const c = L(u + Math.cos(a) * r, v + Math.sin(a) * r);
      if (!world.inBounds(c.x, c.z)) continue;
      if (svc.place(type, c.x, c.z, { free: true, silent: true })) { placed++; return true; }
    }
    refused++;
    if (config.debug) console.warn(`[demo] service ${type} refused: ${svc.lastError}`);
    return false;
  };
  try {
    if (svc) {
      for (const [key, type] of CIVIC) {
        const [i, j] = key.split(',').map(Number);
        tryPlace(type, (COLS[i] + COLS[i + 1]) / 2, COAST_V + (ROWS[j] + ROWS[j + 1]) / 2, 24);
      }
      for (const q of UTIL) tryPlace(q.t, q.u, q.v, q.r * 0.5);
      await frames(ctx, 2);
    }
  } catch (err) {
    console.error('[demo] services failed', err);
  }
  mark('services');

  // ------------------------------------------------------------------ 5. grow the city
  const buildings = world.buildings && world.buildings.api;
  try {
    if (lots && buildings && typeof buildings.fastForward === 'function') {
      buildings.fastForward(60 * 60 * 24 * 400); await frames(ctx, 1);
    }
  } catch (err) {
    console.error('[demo] buildings failed', err);
  }
  mark('grow');

  // ------------------------------------------------------------------ 5b. district ground
  // Dense blocks get paving, service courts and off-street parking; suburbs keep their gardens.
  let ground = null;
  try {
    await gfxReady;
    ground = buildDistrictGround(ctx, gfx, gset);
  } catch (err) {
    console.error('[demo] district ground failed', err);
  }
  mark('ground');

  // ------------------------------------------------------------------ 6. populate
  // Buildings exist but nobody has moved in yet (residents arrive per game hour), so run the
  // economy forward. The clock hour is restored afterwards: `?time=` must still hold.
  try {
    const sim = ctx.modules.simulation && ctx.modules.simulation.api;
    if (sim && typeof sim.fastForward === 'function') {
      for (const t of ['residential', 'commercial', 'industrial', 'office']) sim.setTax?.(t, 0.085);
      // The fast-forward ages the city by roughly a year, which walks the calendar into late
      // November — where the sun never climbs past 20 deg and 17:00 is already night. LOOK_TARGET's
      // measured sun band (22-34 deg elevation at hour 15.6-16.6) assumes the start date, so put the
      // calendar back where it was and keep the beauty hours meaningful.
      const t0date = {
        hour: world.time.hour, minute: world.time.minute, day: world.time.day, weekday: world.time.weekday,
        month: world.time.month, year: world.time.year, totalDays: world.time.totalDays,
      };
      const hour = t0date.hour;
      // Residential CAPACITY is what the population converges to, and it depends on how much of the
      // grid the terrain let us zone — which varies by seed. Top the levels up between passes so
      // every seed lands inside the 15-30k spec instead of only the friendly ones.
      const capacity = () => {
        let cap = 0;
        for (const b of world.buildings.list) if (b.type === 'res-low' || b.type === 'res-high') cap += b.residents || 0;
        return cap;
      };
      const topUp = (want) => {
        let cap = capacity();
        if (cap >= want) return cap;
        const list = world.buildings.list
          .filter((b) => (b.type === 'res-low' || b.type === 'res-high') && b.level < 5)
          .sort((a, x) => (x.residents || 0) - (a.residents || 0) || a.id - x.id);
        for (const b of list) {
          if (cap >= want) break;
          const before = b.residents || 0;
          const nb = buildings.setLevel?.(b.id, Math.min(5, b.level + 1));
          if (nb) cap += (nb.residents || 0) - before;
        }
        return cap;
      };
      // Capacity first, then let the whole fast-forward fill it: occupancy converges slowly, so a
      // late top-up buys height but no citizens.
      // Capacity is what the population converges to; on a site that yielded few lots every
      // residential building is already at level 5 and there is nothing left to raise. (Converting
      // the office and high-street blocks to housing was tried and is worse: it removes the jobs,
      // and the occupancy model then empties the flats faster than the extra capacity fills them.)
      const cap0 = capacity();
      const cap1 = topUp(24000);
      phase.cap = `${Math.round(cap0)}->${Math.round(cap1)}`;
      for (let pass = 0; pass < 2; pass++) {
        sim.fastForward(60 * 60 * 24 * 7 * 17);       // seventeen game weeks
        await frames(ctx, 1);
        buildings?.fastForward?.(60 * 60 * 24 * 340); // demand moved on — let lots catch up / level up
        await frames(ctx, 1);
      }
      // Still short? That is a seed whose site yielded far fewer lots (a broken shoreline halves the
      // count). Occupancy, not capacity, is the brake there: cut taxes so happiness and the move-in
      // rate recover, add height, and give it more weeks.
      if (world.economy.population < 15300) {
        for (const t of ['residential', 'commercial', 'industrial', 'office']) sim.setTax?.(t, 0.055);
      }
      for (let extra = 0; extra < 2 && world.economy.population < 15300; extra++) {
        topUp(24000 + extra * 6000);
        sim.fastForward(60 * 60 * 24 * 7 * 12);
        await frames(ctx, 1);
        buildings?.fastForward?.(60 * 60 * 24 * 120);
        await frames(ctx, 1);
      }
      Object.assign(world.time, t0date);
      events.emit('time:set', hour);
      // the block held back: zoned last so its lots are still scaffolding
      if (siteCells && zones) { zones.paint(siteCells, 'res-high'); await frames(ctx, 1); }
      buildings?.fastForward?.(60 * 60 * 30);
      await frames(ctx, 1);
    }
  } catch (err) {
    console.error('[demo] simulation fast-forward failed', err);
  }
  mark('economy');

  // ------------------------------------------------------------------ 7. traffic + props
  try {
    world.props.api?.refresh?.();
    // "A 16,000-citizen city ran under ten vehicles at noon": run the roads full.
    world.traffic.api?.setDensity?.(2);
    world.traffic.api?.spawnBurst?.(420);
  } catch (err) {
    console.error('[demo] traffic failed', err);
  }
  await frames(ctx, 2);
  mark('traffic');

  world.time.speed = speed0; world.time.paused = paused0;
  events.emit('time:speed', speed0);
  unmute();

  // ------------------------------------------------------------------ 8. camera presets
  // Frame the district presets on what actually got built rather than on where it was planned:
  // the terrain decides which suburb crescent or industrial row survived.
  const cluster = (types, bin = 130, pref = null) => {
    const bins = new Map();
    for (const b of world.buildings.list) {
      if (!types.includes(b.type)) continue;
      const l = toLocal(b.x, b.z);
      const k = `${Math.round(l.u / bin)},${Math.round(l.v / bin)}`;
      let e = bins.get(k);
      if (!e) bins.set(k, (e = { n: 0, u: 0, v: 0 }));
      e.n++; e.u += l.u; e.v += l.v;
    }
    let best = null, bestScore = -Infinity;
    for (const e of bins.values()) {
      const u = e.u / e.n, v = e.v / e.n;
      const sc = e.n - (pref ? Math.hypot(u - pref.u, v - pref.v) / 260 : 0);
      if (sc > bestScore) { bestScore = sc; best = { u, v, n: e.n }; }
    }
    return best;
  };
  const subSpot = cluster(['res-low'], 150, { u: GRID_U0 - 170, v: COAST_V + ROWS[4] }) || { u: GRID_U0 - 170, v: COAST_V + ROWS[4] };
  const indSpot = cluster(['ind'], 150) || { u: (IND_U0 + IND_U1) / 2, v: (IND_V0 + IND_V1) / 2 };
  // A hilltop neighbourhood seen across its back gardens is half empty grass; put the camera on the
  // crescent itself, looking along the kerb line towards town, so the street fills the frame.
  let subView = null;
  try {
    const p = L(subSpot.u, subSpot.v), core = L(0, CORE_V);
    const hit = roads.nearest(p.x, p.z, 140);
    if (hit && hit.point && hit.tangent) {
      let tx = hit.tangent.x, tz = hit.tangent.z;
      if (tx * (core.x - hit.point.x) + tz * (core.z - hit.point.z) < 0) { tx = -tx; tz = -tz; }
      subView = { target: { x: hit.point.x, y: hit.point.y, z: hit.point.z }, yaw: Math.atan2(-tx, -tz) };
    }
  } catch (err) { void err; }
  registerPresets(ctx, {
    ...gset, heightAt, subU: subSpot.u, subV: subSpot.v, indU: indSpot.u, indV: indSpot.v, subView,
    landmarks: landmarks.spots, rail, port,
  });

  const bstats = buildings?.stats?.() || {};
  console.info(`[demo] coastal city @(${cx.toFixed(0)}, ${cz.toFixed(0)}) shore ${Math.round(site.shoreDist)} m — ` +
    `${world.roads.segments.size} segments, ${lots} lots, ${world.buildings.list.length} buildings ` +
    `(${bstats.construction || 0} building), ${placed} services${refused ? ` (${refused} refused)` : ''}, ` +
    `pop ${world.economy.population}, ${gradedBlocks} graded, ${landmarks.spots.length} landmarks, rail ${rail ? rail.spans + " spans" : "-"}, ` +
    `ground ${ground ? ground.cells + " cells/" + ground.meshes + " meshes" : "-"} in ${Math.round(performance.now() - t0)} ms ` + JSON.stringify(phase));
}

// ------------------------------------------------------------------------------------------------
// zoning mix

/** Land use as a function of position relative to the downtown core (u across, dv inland/seaward). */
function zoneFor(u, dv, rng) {
  const r = Math.hypot(u * 0.80, dv * 1.06);
  if (r < 150) return rng.chance(0.44) ? 'office' : 'com-high';                                   // tower core
  if (r < 285) return rng.chance(0.24) ? 'office' : (rng.chance(0.42) ? 'com-high' : 'res-high'); // downtown fringe
  if (r < 430) return rng.chance(0.88) ? 'res-high' : 'com-low';                                  // mid-rise ring
  if (r < 560) return rng.chance(0.84) ? 'res-high' : (rng.chance(0.6) ? 'res-low' : 'com-low');
  return rng.chance(0.62) ? 'res-high' : (rng.chance(0.72) ? 'res-low' : 'com-low');              // outer terraces
}


// ------------------------------------------------------------------------------------------------
// helpers

/** Wait for `n` rendered frames so modules can process the events we just emitted. */
function frames(ctx, n) {
  const engine = ctx.engine;
  return new Promise((resolve) => {
    const start = engine.frame;
    const step = () => (engine.frame - start >= n ? resolve() : requestAnimationFrame(step));
    step();
  });
}

/**
 * Pick the town site: flat, dry, inside the map, and with a coastline 250–700 m away so the city
 * gets a real waterfront. Returns the centre plus a local frame whose +v axis points out to sea and
 * whose +u axis runs along the (least-squares fitted) shoreline.
 */
function pickSite(terrain, world) {
  const fallback = { cx: 0, cz: 0, ux: 1, uz: 0, vx: 0, vz: 1, shoreDist: 600 };
  if (!terrain || !terrain.ready) return fallback;
  const R = Math.min(700, world.half * 0.70);
  let best = -Infinity, bestSite = null;
  for (let x = -R; x <= R; x += 104) {
    for (let z = -R; z <= R; z += 104) {
      const s = scoreSite(terrain, world, x, z);
      if (s && s.score > best) { best = s.score; bestSite = s; }
    }
  }
  if (!bestSite) return fallback;
  // local refinement
  for (let x = bestSite.cx - 78; x <= bestSite.cx + 78; x += 39) {
    for (let z = bestSite.cz - 78; z <= bestSite.cz + 78; z += 39) {
      const s = scoreSite(terrain, world, x, z);
      if (s && s.score > best) { best = s.score; bestSite = s; }
    }
  }
  return bestSite;
}

function scoreSite(terrain, world, x, z) {
  if (!world.inBounds(x, z)) return null;
  const nw = nearestWater(terrain, world, x, z, 1150, 40);
  let vx, vz, shoreDist;
  if (nw) { vx = nw.dx; vz = nw.dz; shoreDist = nw.dist; } else { vx = 0; vz = 1; shoreDist = 1400; }
  // level the frame against the local shoreline so the coast runs along +u
  if (nw) {
    const ux0 = vz, uz0 = -vx;
    let n = 0, su = 0, sd = 0, suu = 0, sud = 0;
    for (let u = -420; u <= 420; u += 84) {
      const ox = x + ux0 * u, oz = z + uz0 * u;
      const d = marchToWater(terrain, world, ox, oz, vx, vz, 1150, 24);
      if (d == null) continue;
      n++; su += u; sd += d; suu += u * u; sud += u * d;
    }
    if (n >= 4) {
      const den = n * suu - su * su;
      const slope = Math.abs(den) > 1e-6 ? (n * sud - su * sd) / den : 0;
      const a = Math.atan(clamp(slope, -1.2, 1.2));
      const c = Math.cos(a), s = Math.sin(a);
      const nvx = vx * c - vz * s, nvz = vx * s + vz * c;
      vx = nvx; vz = nvz;
      shoreDist = (sd / n) * Math.cos(a);
    }
  }
  const len = Math.hypot(vx, vz) || 1; vx /= len; vz /= len;
  const ux = vz, uz = -vx;

  // Sample the whole city footprint in the local frame. What actually decides the population is how
  // much of it zoning can turn into lots, so score BUILDABLE area directly (in bounds, dry, gentle)
  // rather than a blend of roughness and wetness — those two traded one seed for another.
  let rough = 0, wet = 0, oob = 0, n = 0, wsum = 0, good = 0;
  const vTop = Math.min(shoreDist - 60, 620);
  for (let u = -820; u <= 820; u += 100) {
    for (let v = -1080; v <= vTop; v += 100) {
      const px = x + ux * u + vx * v, pz = z + uz * u + vz * v;
      // the dense core matters most
      const w = (Math.abs(u) < 560 && v > -740 && v < vTop) ? 2.4 : 1;
      n++; wsum += w;
      if (!world.inBounds(px, pz)) { oob++; continue; }
      const h = terrain.getHeight(px, pz);
      const dh = Math.abs(terrain.getHeight(px + 34, pz) - h) + Math.abs(terrain.getHeight(px, pz + 34) - h);
      rough += dh * w;
      const isWet = terrain.isWater && terrain.isWater(px, pz);
      if (isWet) { wet += w; continue; }
      if (dh < 2.6) good += w;
    }
  }
  const shorePref = shoreDist > 1200 ? -70 : -Math.abs(shoreDist - 430) * 0.055;
  // Out-of-bounds is the expensive one: `build()` silently clips a road run that leaves the map, so a
  // site near the edge loses whole districts and lands the population under the 15k floor (seeds 1,
  // 12 and 42 all failed that way). Weight it an order of magnitude above roughness.
  const score = -(rough / n) * 3.4 - (wet / n) * 900 - (oob / n) * 2600 + shorePref - Math.hypot(x, z) / 1400;
  void good; void wsum;
  return { cx: x, cz: z, ux, uz, vx, vz, shoreDist, score };
}

function marchToWater(terrain, world, x, z, dx, dz, maxR, step) {
  if (!terrain.isWater) return null;
  for (let r = step; r <= maxR; r += step) {
    const px = x + dx * r, pz = z + dz * r;
    if (!world.inBounds(px, pz)) return null;
    if (terrain.isWater(px, pz)) return r;
  }
  return null;
}

function nearestWater(terrain, world, x, z, maxR, step) {
  if (!terrain.isWater) return null;
  let best = Infinity, bdx = 0, bdz = 0;
  for (let a = 0; a < 32; a++) {
    const th = (a / 32) * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
    const d = marchToWater(terrain, world, x, z, dx, dz, maxR, step);
    if (d != null && d < best) { best = d; bdx = dx; bdz = dz; }
  }
  return best === Infinity ? null : { dist: best, dx: bdx, dz: bdz };
}

/**
 * Shoreline in the local frame: `at(u)` → the v where water starts (Infinity if the ray never hits
 * water inside the map). Smoothed so the promenade is a graceful curve rather than a saw.
 */
function shoreProfile(terrain, world, L, shoreDist) {
  const U0 = -1000, U1 = 1000, STEP = 25;
  const n = Math.round((U1 - U0) / STEP) + 1;
  const raw = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const u = U0 + i * STEP;
    let hit = Infinity;
    for (let v = Math.max(60, shoreDist - 420); v <= shoreDist + 620; v += 10) {
      const p = L(u, v);
      if (!world.inBounds(p.x, p.z)) break;
      if (terrain.isWater && terrain.isWater(p.x, p.z)) { hit = v; break; }
    }
    raw[i] = hit;
  }
  // 5-tap smoothing over finite samples
  const sm = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n || !Number.isFinite(raw[j])) continue;
      const wk = 1 / (1 + Math.abs(k));
      s += raw[j] * wk; w += wk;
    }
    if (w > 0 && Number.isFinite(raw[i])) sm[i] = s / w;
  }
  let minV = Infinity;
  for (let i = 0; i < n; i++) {
    const u = U0 + i * STEP;
    if (u < -560 || u > 560) continue;
    if (Number.isFinite(sm[i])) minV = Math.min(minV, sm[i]);
  }
  if (!Number.isFinite(minV)) minV = Number.isFinite(shoreDist) ? shoreDist : 600;
  return {
    minV,
    at(u) {
      const f = (u - U0) / STEP;
      const i = Math.round(f);
      if (i < 0 || i >= n) return Infinity;
      return sm[i];
    },
  };
}
