/**
 * Ground composition rules shared by the control texture (in-map), the horizon vertex attributes
 * (outside the map) and the vegetation scatter — one function, so the map edge is invisible.
 *
 *   controlAt(x, z, h, slope, shoreDist?) → { dry, dirt, sand, rock, forest, field, fieldEdge }
 *
 * Ground cover is driven by the same erosion fields the heightmap uses (hm.relief: upland / gully /
 * ridge), by aspect (sun-facing slopes dry out, hollows stay lush), by slope and by drainage-aligned
 * noise (dirt streaks run down the fall line). Sand exists only on the sea coast and on the inner
 * (convex) side of river meanders where the bank is nearly flat — everywhere else grass or mud runs
 * to the waterline. The forest mask is a thresholded low-frequency clump field (80-300 m stands with
 * ragged edges, ~0 outside) plus riparian strips and hedgerows along the field patchwork.
 */
import { SimplexNoise } from '../../shared/noise.js';
import { hash2 } from '../../shared/random.js';
import { clamp, smoothstep, lerp } from '../../shared/math.js';

const FIELD_CELL = 150;

export function makeGroundControl(hm, seed) {
  const forestNoise = new SimplexNoise(seed * 7 + 21);
  const groundNoise = new SimplexNoise(seed * 7 + 22);
  const fieldSeed = hash2(seed, 4242);
  const wl = hm.waterLevel;

  /** Jittered-grid Voronoi: nearest cell id (0..1 hash), and distance to the nearest cell edge (m). */
  const fields = (x0, z0) => {
    // domain warp → plot edges meander instead of reading as straight polygon edges
    const x = x0 + 26 * groundNoise.noise2D(x0 / 70 + 31, z0 / 70), z = z0 + 26 * groundNoise.noise2D(x0 / 70, z0 / 70 - 17);
    const gx = Math.floor(x / FIELD_CELL), gz = Math.floor(z / FIELD_CELL);
    let d1 = Infinity, d2 = Infinity, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cz = gz + j;
      const hsh = hash2(hash2(fieldSeed, cx * 7919), cz * 104729);
      const jx = ((hsh & 0xffff) / 65535) * 0.8 + 0.1, jz = (((hsh >>> 16) & 0xffff) / 65535) * 0.8 + 0.1;
      const sx = (cx + jx) * FIELD_CELL, sz = (cz + jz) * FIELD_CELL;
      // anisotropic metric → elongated, plot-like cells
      const dx = (x - sx) * 1.25, dz = (z - sz) * 0.85;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < d1) { d2 = d1; d1 = d; id = (hsh % 1000) / 1000; }
      else if (d < d2) d2 = d;
    }
    return { id, edge: (d2 - d1) * 0.5 };
  };

  /** Downhill gradient (gx, gz) of the terrain anywhere (4 m stencil). */
  const gradAt = (x, z) => {
    const e = 4;
    return { gx: (hm.getHeightAny(x + e, z) - hm.getHeightAny(x - e, z)) / (2 * e), gz: (hm.getHeightAny(x, z + e) - hm.getHeightAny(x, z - e)) / (2 * e) };
  };

  /** Field patch weight (0 outside lowland pasture) and per-field id/edge distance. */
  const fieldAt = (x, z, h, slope, riverD, riverW) => {
    const low = smoothstep(26, 14, h - wl) * smoothstep(1.2, 3.0, h - wl) * (1 - smoothstep(0.06, 0.13, slope));
    const nearRiver = smoothstep(riverW + 70, riverW + 20, riverD);
    const w = low * (1 - nearRiver);
    if (w <= 0.001) return { w: 0, id: 0, edge: 999 };
    const f = fields(x, z);
    return { w, id: f.id, edge: f.edge };
  };

  /**
   * 0..1 probability that a tree stands at (x,z). Thresholded clump noise: ≈0.9 inside stands,
   * ≈0 outside; hills carry closed forest, the valley floor copses, riparian strips and hedgerows.
   */
  const forestMask = (x, z, h, slope, pre = null) => {
    const hA = h - wl;
    let gully, ridge, rd, rw;
    if (pre) { gully = pre.gully; ridge = pre.ridge; rd = pre.rd; rw = pre.rw; }
    else { const rel = hm.relief(x, z, 1); gully = rel.gully; ridge = rel.ridge; rd = hm.riverDistance(x, z); rw = hm.riverHalfWidth(z); }
    const big = forestNoise.fbm2D(x / 420, z / 420, 3);                 // 80-300 m stands
    const med = forestNoise.fbm2D(x / 130 + 7.1, z / 130 - 3.3, 2);     // ragged edges
    const moisture = 0.6 * gully - 0.25 * ridge;                        // hollows wetter, ridges drier
    const n = big * 0.75 + med * 0.42 + 0.3 * moisture;
    const upland = smoothstep(16, 42, hA);
    const threshold = lerp(0.30, -0.02, upland);
    let f = smoothstep(threshold - 0.05, threshold + 0.11, n) * (0.82 + 0.18 * smoothstep(-0.5, 0.5, med));
    // lone trees are rare outside the stands
    f = Math.max(f, 0.004);
    // riparian strip along the river bank (broken up along the bank)
    const bankD = rd - rw;
    const ripGate = smoothstep(0.3, 0.62, 0.5 + 0.5 * forestNoise.noise2D(z / 75 + 3, x / 75));
    const riparian = smoothstep(34, 16, bankD) * smoothstep(3.5, 9, bankD) * ripGate * 0.72;
    f = Math.max(f, riparian);
    // hedgerows along the pasture plot edges (on ~45 % of the edges)
    if (hA > 2 && hA < 28 && slope < 0.1 && bankD > 40) {
      const fl = fields(x, z);
      const hedgeGate = smoothstep(0.42, 0.58, 0.5 + 0.5 * groundNoise.noise2D(x / 90 + 55, z / 90 - 21));
      const hedge = (1 - smoothstep(1.2, 3.4, fl.edge)) * hedgeGate * 0.6;
      f = Math.max(f, hedge);
    }
    f *= 1 - smoothstep(0.30, 0.44, slope);                     // nothing on steep faces
    const treeLine = 112 + 18 * forestNoise.noise2D(x / 400 + 3, z / 400);
    f *= 1 - smoothstep(treeLine - 10, treeLine + 12, hA);      // tree line
    return clamp(f, 0, 1);
  };

  /**
   * Ground control at a point. `shoreDist` (metres to the waterline, + on land) is optional — when
   * absent (horizon ring) it is estimated from the river / coast fields.
   */
  const controlAt = (x, z, h, slope, shoreDist) => {
    const hA = h - wl;
    const rel = hm.relief(x, z, 1);
    const gully = rel.gully, ridge = rel.ridge, upland = rel.upland;
    const rd = hm.riverDistance(x, z), rw = hm.riverHalfWidth(z);
    const f = forestMask(x, z, h, slope, { gully, ridge, rd, rw });
    const dc = z - hm.coastZ(x);
    if (shoreDist == null) shoreDist = Math.min(rd - rw, -dc);
    const fld = fieldAt(x, z, h, slope, rd, rw);
    const g = gradAt(x, z);
    const grade = Math.hypot(g.gx, g.gz);
    const aspectSouth = grade > 1e-4 ? clamp(g.gz / grade, -1, 1) : 0;   // +1 = faces south (+z), sun-exposed
    const slopeF = smoothstep(0.02, 0.12, grade);

    // dryness: 20-110 m patches + aspect + ridges + altitude, lush in hollows / drainage
    const dryN = 0.55 * groundNoise.fbm2D(x / 110, z / 110, 3) + 0.32 * groundNoise.fbm2D(x / 24 + 3, z / 24, 2);
    let dry = smoothstep(0.16, 0.62, dryN + 0.22 * aspectSouth * slopeF + 0.22 * (ridge - 0.5) * upland - 0.45 * gully + 0.14 * smoothstep(8, 40, hA)) * (1 - 0.7 * f);
    if (fld.w > 0) {
      const fieldDry = smoothstep(0.35, 0.8, fld.id) * 0.65;         // ~50 % of fields are dry pasture / hay
      const inner = smoothstep(2.5, 9, fld.edge);                     // soft margins along the plot edges
      dry = lerp(dry, fieldDry * inner + dry * (1 - inner) * 0.5, fld.w * 0.85);
    }

    // dirt: fall-line streaks (noise stretched along the downhill direction), gully beds on the hills,
    // worn field margins, steep cuts; forest floor is handled by the canopy mask in the shader
    let dirt = 0;
    if (grade > 0.03) {
      const dx = g.gx / grade, dz = g.gz / grade;
      const along = x * dx + z * dz, across = -x * dz + z * dx;
      const streakN = groundNoise.noise2D(along / 55 + 9, across / 16);
      dirt += smoothstep(0.55, 0.9, streakN) * slopeF * (0.35 + 0.65 * smoothstep(0.35, 0.6, dryN + 0.5)) * 0.42;
    }
    dirt += gully * upland * smoothstep(0.03, 0.09, grade) * 0.34;
    // steep flanks lose their turf only in patches — a solid dirt flank reads as a bald dusty hill
    dirt += smoothstep(0.22, 0.38, slope) * 0.30 * smoothstep(0.35, 0.75, 0.5 + 0.5 * groundNoise.noise2D(x / 33 + 12, z / 33 - 5));
    if (fld.w > 0) dirt = Math.max(dirt, fld.w * smoothstep(3.2, 0.8, fld.edge) * 0.32 * smoothstep(0.35, 0.7, 0.5 + 0.5 * groundNoise.noise2D(x / 40 - 9, z / 40 + 4)));

    // sand: sea beach, and point bars on the inner side of river meanders — flat, patchy
    let sand = 0;
    const flat = 1 - smoothstep(0.08, 0.17, grade);
    const sandN = 0.5 + 0.5 * groundNoise.noise2D(x / 48 + 17, z / 48 - 8);
    if (dc > -140 && hA < 6) {
      // coast: continuous beach where the plain runs out into the sea
      sand = smoothstep(-70 - 30 * sandN, -12, dc) * flat * smoothstep(3.5, 1.0, hA - 0.6 * sandN);
    }
    if (rd < rw + 40 && hA < 4) {
      const curv = hm.riverCurvature(z);
      const side = x - hm.riverX(z);
      const inner = smoothstep(3e-4, 8e-4, side * curv);            // convex bank of a pronounced bend
      const bar = inner * smoothstep(0.6, 0.78, sandN) * flat;      // ~25 % of the inner banks carry a bar
      const sd = Math.max(shoreDist, 0);
      // solid at the waterline, breaking into patches with grass between them further up the bank
      const patch = smoothstep(0.30, 0.62, 0.5 + 0.5 * groundNoise.noise2D(x / 13 + 41, z / 13 - 7) + 0.45 * (1 - smoothstep(0.5, 5, sd)));
      sand = Math.max(sand, bar * smoothstep(4 + 6 * sandN, 0.8, sd) * patch);
    }

    // extra rock: high ground (patchy) + ridge outcrops on the hills
    const rockBoost = Math.max(
      smoothstep(78, 115, hA) * (0.45 + 0.55 * smoothstep(-0.2, 0.5, groundNoise.fbm2D(x / 90 + 40, z / 90, 2))),
      smoothstep(0.62, 0.85, ridge) * upland * smoothstep(0.1, 0.24, grade) * 0.85);
    return { dry: clamp(dry, 0, 1), dirt: clamp(dirt, 0, 1), sand: clamp(sand, 0, 1), rock: clamp(rockBoost, 0, 1), forest: f, field: fld.w, fieldEdge: fld.edge };
  };

  return { controlAt, forestMask, fields, fieldAt };
}
