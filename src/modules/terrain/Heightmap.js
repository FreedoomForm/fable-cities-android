/**
 * Procedural heightmap for Fable Cities — pure JS (no three.js) so it can be previewed in Node.
 *
 * Layout (seed-dependent details, stable overall composition so other modules can rely on it):
 *   - a wide flat valley / coastal plain around the map centre (buildable, 5-12 m above water)
 *   - a meandering river running roughly north → south into a sea along the southern edge
 *   - rolling hills on the flanks, a terraced mountain range with cliffs to the north
 *   - water level is 0 m
 *
 * Grid: (N × N) samples, `spacing` metres apart, covering [-half, half]² (N = size/spacing + 1).
 * The analytic generator `sampleGen(x, z)` is unbounded, so an outer "horizon" ring outside the
 * playable map can be meshed from it as well.
 */
import { SimplexNoise } from '../../shared/noise.js';
import { clamp, smoothstep, lerp } from '../../shared/math.js';

export const WATER_LEVEL = 0;

export class Heightmap {
  constructor({ size = 2048, spacing = 2, seed = 1337 } = {}) {
    this.size = size;
    this.half = size / 2;
    this.spacing = spacing;
    this.N = Math.round(size / spacing) + 1;
    this.seed = seed;
    this.waterLevel = WATER_LEVEL;
    this.data = new Float32Array(this.N * this.N);
    this.minH = 0;
    this.maxH = 0;
    this.version = 0;

    // independent noise fields (different seeds → decorrelated)
    this.nBase = new SimplexNoise(seed * 7 + 1);
    this.nMid = new SimplexNoise(seed * 7 + 2);
    this.nHi = new SimplexNoise(seed * 7 + 3);
    this.nMount = new SimplexNoise(seed * 7 + 4);
    this.nRiver = new SimplexNoise(seed * 7 + 5);
    this.nMask = new SimplexNoise(seed * 7 + 6);
    this.nCoast = new SimplexNoise(seed * 7 + 7);
    this.nDrain = new SimplexNoise(seed * 7 + 8);
    this._f = { upland: 0, gully: 0, ridge: 0, wx: 0, wz: 0 };

    // river / coast parameters (seeded variation, bounded so the centre stays buildable)
    const r = (k, a, b) => a + (b - a) * (0.5 + 0.5 * this.nMask.noise2D(k * 13.7, -k * 3.1));
    this.river = {
      x0: r(1, -420, -180),           // mean x of the river centreline
      amp: r(2, 140, 220),            // main meander amplitude
      wave: r(3, 380, 520),           // meander wavelength
      phase: r(4, 0, 6.283),
      width: r(5, 26, 38),            // half width of the channel (m)
    };
    this.coast = {
      z0: r(6, 560, 700),             // mean z of the coastline (south)
      amp: r(7, 90, 160),
      wave: r(8, 420, 620),
      phase: r(9, 0, 6.283),
    };
    this.mountainBias = r(10, 0.6, 0.8);
  }

  // ---------------------------------------------------------------------------------------------
  // analytic generator
  // ---------------------------------------------------------------------------------------------

  /** Centre x of the river at a given z (world coords). */
  riverX(z) {
    const rv = this.river;
    return rv.x0 + rv.amp * Math.sin(z / rv.wave + rv.phase) + 70 * this.nRiver.noise2D(z / 260, 3.3) + 12 * this.nRiver.noise2D(z / 110, 9.1);
  }
  riverHalfWidth(z) {
    return this.river.width * (1 + 0.35 * this.nRiver.noise2D(z / 180, 17.7));
  }
  /** Coastline z at a given x — sea for z beyond this. */
  coastZ(x) {
    const c = this.coast;
    return c.z0 + c.amp * Math.sin(x / c.wave + c.phase) + 60 * this.nCoast.noise2D(x / 300, 1.5) + 18 * this.nCoast.noise2D(x / 80, 4.2);
  }

  /** Horizontal distance from (x,z) to the river centreline (approximate but robust for mild meanders). */
  riverDistance(x, z) {
    // the 5 centreline samples depend on z only → cached per row (generation and control maps scan rows)
    let c = this._rowCache;
    if (!c || c.z !== z) {
      c = this._rowCache = { z, r0: this.riverX(z), rm2: this.riverX(z - 40), rm1: this.riverX(z - 20), rp1: this.riverX(z + 20), rp2: this.riverX(z + 40) };
    }
    let d = Math.abs(x - c.r0);
    // refine with neighbouring samples along z so bends do not get artificially thin
    let dx = x - c.rm2, dd = Math.sqrt(dx * dx + 1600); if (dd < d) d = dd;
    dx = x - c.rm1; dd = Math.sqrt(dx * dx + 400); if (dd < d) d = dd;
    dx = x - c.rp1; dd = Math.sqrt(dx * dx + 400); if (dd < d) d = dd;
    dx = x - c.rp2; dd = Math.sqrt(dx * dx + 1600); if (dd < d) d = dd;
    return d;
  }

  /** Signed curvature proxy of the river centreline at z (second derivative of riverX, 1/m). */
  riverCurvature(z) {
    const e = 24;
    return (this.riverX(z + e) - 2 * this.riverX(z) + this.riverX(z - e)) / (e * e);
  }

  /**
   * Erosion-style relief fields shared by the generator and the ground rules (written into the
   * reusable scratch object `this._f`): `upland` 0..1, `gully` 0..1 (1 in a drainage channel),
   * `ridge` 0..1 (ridged multifractal on the warped domain).
   */
  relief(x, z, lod = 0) {
    const nb = this.nBase, nm = this.nMid, nd = this.nDrain, f = this._f;
    const low = nb.fbm2D(x / 1150, z / 1150, 3);
    const mid = nm.fbm2D(x / 300, z / 300, lod < 2 ? 4 : 3);
    f.upland = smoothstep(-0.05, 0.55, low + 0.15 * mid);
    // domain warp → flow-like, non-blobby shapes
    const wx = x + 110 * nd.noise2D(x / 520 + 7.3, z / 520), wz = z + 110 * nd.noise2D(x / 520, z / 520 - 7.3);
    f.wx = wx; f.wz = wz;
    f.ridge = nd.ridged2D(wx / 240 + 3, wz / 240, lod === 0 ? 3 : 2, 2.0, 0.55);
    // drainage: the zero set of a warped noise forms sinuous gullies; wider/softer on the lowland
    const dN = nd.noise2D(wx / 150 - 11, wz / 150 + 5) + 0.25 * nd.noise2D(wx / 48 + 2, wz / 48);
    const halfW = 0.13 + 0.12 * (1 - f.upland);
    const g = 1 - smoothstep(0.0, halfW, Math.abs(dN));
    f.gully = g * g * (3 - 2 * g);
    f.low = low; f.mid = mid;
    return f;
  }

  /**
   * Unbounded terrain height in metres at world (x, z).
   * `lod` selects the octave budget for the sampling density: 0 → 2 m grid (full detail),
   * 1 → 8 m grid, 2 → 32 m grid. Dropping octaves whose wavelength is below the sampling step
   * keeps the far horizon smooth instead of aliasing into sawtooth spikes.
   */
  sampleGen(x, z, lod = 0) {
    const nm = this.nMid, nh = this.nHi;
    // --- rolling base + erosion-style relief ---------------------------------------------------
    const f = this.relief(x, z, lod);
    const mid = f.mid, upland = f.upland;
    const hi = lod === 0 ? nh.fbm2D(x / 46, z / 46, 3) : lod === 1 ? nh.fbm2D(x / 46, z / 46, 1) : 0.0; // surface detail
    // rolling relief on the lowland: 100-400 m wavelengths, 6-14 m amplitude (grades stay < 6 %)
    const roll = nm.fbm2D(x / 230 + 5.5, z / 230 - 2.5, lod < 2 ? 3 : 2);
    const roll2 = nm.fbm2D(x / 560 - 3.1, z / 560 + 8.4, 2);
    const knoll = Math.abs(nm.noise2D(x / 90 + 2, z / 90));
    let h = 7.5 + 1.6 * mid * (0.35 + 0.65 * upland) + 0.45 * hi * (0.4 + 0.6 * upland)
      + (1 - upland) * (5.0 * roll + 3.4 * roll2 + 1.4 * knoll - 0.8 * f.gully)
      + upland * (34 + 26 * mid + 6 * knoll + 18 * (f.ridge - 0.5) - 5.5 * f.gully);

    // --- mountains (north, terraced ridges → cliffs) ---------------------------------------
    const mMaskNoise = this.nMount.fbm2D(x / 1500 + 4.2, z / 1500 - 1.7, 3) + this.mountainBias * (-clamp(z, -this.half, this.half) / this.half) - 0.05;
    let mount = smoothstep(0.22, 0.7, mMaskNoise) * smoothstep(120, 520, Math.hypot(x, z));
    let mh = 0;
    if (mount > 0.0005) {
      const ridge = this.nMount.ridged2D(x / 360 + 9, z / 360 - 5, lod === 0 ? 5 : lod === 1 ? 4 : 3, 2.1, lod === 0 ? 0.5 : 0.42);
      // per-massif amplitude (±35 %) so summits reach different altitudes — some stay below the snow line
      const peakVar = 1 + 0.35 * this.nMount.noise2D(x / 760 + 3.3, z / 760 - 6.1);
      mh = 60 + 150 * ridge * peakVar;
      // terracing → cliffs & benches (softened on the far rings where coarse sampling cannot resolve a step)
      const step = 22;
      const q = Math.floor(mh / step) * step;
      const tfr = (mh - q) / step;
      const tf = smoothstep(0.35, 0.75, tfr);
      mh = lerp(mh, q + tf * step, lod === 0 ? 0.55 : lod === 1 ? 0.35 : 0.12);
      // far ring: the range keeps rising towards the horizon so it reads as a real massif behind the map
      const rOut = Math.max(Math.abs(x), Math.abs(z)) - this.half;
      if (rOut > 0) mh += 70 * smoothstep(200, 2200, rOut) * smoothstep(0.3, 0.8, mMaskNoise);
    }

    // --- river & coast masks --------------------------------------------------------------
    const zc = this.coastZ(x);
    const dc = z - zc;                                         // >0 = seaward
    const d = this.riverDistance(x, z);
    const w = this.riverHalfWidth(z) * (1 + 0.9 * smoothstep(-420, 60, dc)); // estuary widens
    const floodH = 4.6 + 1.4 * mid + 0.25 * hi + 1.2 * roll - 0.5 * f.gully;   // floodplain height (faintly rolling, old drainage swales)
    const floodBlend = smoothstep(260, 90, d);                 // 1 near river, 0 far away
    mount *= smoothstep(120, 460, d) * smoothstep(-80, -520, dc);
    h = lerp(h, floodH, floodBlend);
    h += mount * mh;

    // --- coastal plain & beach (south) ----------------------------------------------------
    const coastalPlain = smoothstep(-460, -140, dc);           // lowers land towards the coast
    h = lerp(h, 3.8 + 1.2 * mid + 0.3 * hi, coastalPlain * (1 - mount) * 0.92);
    const beach = smoothstep(-80, 0, dc);                      // gentle beach slope down to the water
    h = lerp(h, 1.4 - 2.6 * (dc + 80) / 80, beach * 0.95);

    // --- river channel with a continuous, natural bank profile ------------------------------
    if (d < w + 30) {
      const bank = smoothstep(w + 30, w + 6, d);                // 0 at outer bank → 1 at channel edge
      const bankH = 1.3 + 0.5 * this.nRiver.noise2D(x / 37, z / 37); // grassy banks ~1-1.8 m above the water
      // low bluffs / cut banks: on stretches where the mask is on, the outer bank keeps its height and drops
      // steeply to the water over ~8 m instead of easing down (soil shows on the cut, no beach)
      const side = x - this.riverX(z) > 0 ? 1 : -1;
      const bluffN = this.nRiver.noise2D(z / 210 + 40, side * 7.7) + 0.35 * this.nRiver.noise2D(z / 60 - 11, side * 3.1);
      const bluff = smoothstep(0.32, 0.6, bluffN) * (1 - beach) * smoothstep(-40, -200, dc) * (1 - mount);
      const bluffH = Math.max(h, bankH + 4.5 + 3.5 * smoothstep(0.5, 0.9, bluffN));
      const target = lerp(Math.min(h, bankH), bluffH, bluff);
      h = lerp(h, target, bank);
      if (d < w + 6) {
        const step = smoothstep(w + 6, w, d);
        // bluff: steep face (most of the drop happens in the last 3 m); soft bank: gentle step
        h = lerp(lerp(h, Math.min(h, 0.7), step), lerp(h, 0.7, smoothstep(w + 4.5, w + 0.5, d)), bluff);
      }
      if (d < w) {
        const u = d / w;
        const prof = Math.pow(1 - u * u, 1.15);                 // 0 at the edge, 1 in the middle (2-4 m shallow shelf, then deep)
        h = Math.min(h, 0.7 - 9.0 * prof);
      }
    }

    // --- sea ------------------------------------------------------------------------------
    if (dc > 0) {
      const depth = -2.5 - 14 * smoothstep(0, 260, dc) - 6 * smoothstep(200, 900, dc) - 14 * smoothstep(900, 3000, dc) + 1.2 * hi;
      const sea = lerp(h, depth, smoothstep(0, 40, dc));
      h = Math.min(h, sea);
    }
    return h;
  }

  // ---------------------------------------------------------------------------------------------
  // grid generation
  // ---------------------------------------------------------------------------------------------

  generate() {
    const { N, spacing, half, data } = this;
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < N; j++) {
      const z = -half + j * spacing;
      for (let i = 0; i < N; i++) {
        const x = -half + i * spacing;
        const h = this.sampleGen(x, z);
        data[j * N + i] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    this.minH = mn;
    this.maxH = mx;
    this.version++;
    this._buildOuterGrids();
    return this;
  }

  /**
   * Coarse grids for the horizon ring outside the playable map:
   *   outer: 8 m spacing, covers ±2·half   (built at lod 1, lod 0 inside 96 m of the map edge → seamless)
   *   far:   32 m spacing, covers ±4·half  (lod 2)
   * Inside the playable map both copy the fine grid so every grid agrees on the shared boundary.
   */
  _buildOuterGrids() {
    const half = this.half;
    this.outer = new CoarseGrid(8, half * 2);
    this.outer.fill((x, z) => {
      const r = Math.max(Math.abs(x), Math.abs(z));
      if (r <= half) return this.getHeight(x, z);
      return this.sampleGen(x, z, r - half < 96 ? 0 : 1);
    });
    this.far = new CoarseGrid(32, half * 4);
    this.far.fill((x, z) => {
      const r = Math.max(Math.abs(x), Math.abs(z));
      if (r <= half * 2) return this.outer.getHeight(x, z);
      return this.sampleGen(x, z, r - half * 2 < 128 ? 1 : 2);
    });
  }

  /** Height anywhere: fine grid inside the map, coarse grids on the horizon ring (clamped beyond). */
  getHeightAny(x, z) {
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r <= this.half) return this.getHeight(x, z);
    if (r <= this.half * 2) return this.outer.getHeight(x, z);
    return this.far.getHeight(x, z);
  }
  /** Slope anywhere (see getSlope). */
  getSlopeAny(x, z) {
    const r = Math.max(Math.abs(x), Math.abs(z));
    const e = r <= this.half ? this.spacing : r <= this.half * 2 ? 8 : 32;
    const dx = (this.getHeightAny(x + e, z) - this.getHeightAny(x - e, z)) / (2 * e);
    const dz = (this.getHeightAny(x, z + e) - this.getHeightAny(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  // ---------------------------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------------------------

  /** Bilinear height at world (x, z). Coordinates are clamped to the map. */
  getHeight(x, z) {
    const { N, spacing, half, data } = this;
    let fx = (x + half) / spacing, fz = (z + half) / spacing;
    if (fx < 0) fx = 0; else if (fx > N - 1) fx = N - 1;
    if (fz < 0) fz = 0; else if (fz > N - 1) fz = N - 1;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i >= N - 1) i = N - 2;
    if (j >= N - 1) j = N - 2;
    const tx = fx - i, tz = fz - j;
    const a = data[j * N + i], b = data[j * N + i + 1], c = data[(j + 1) * N + i], d = data[(j + 1) * N + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Normal at world (x,z) written to `out` {x,y,z}. */
  getNormal(x, z, out) {
    const e = this.spacing;
    const dx = this.getHeight(x + e, z) - this.getHeight(x - e, z);
    const dz = this.getHeight(x, z + e) - this.getHeight(x, z - e);
    let nx = -dx / (2 * e), ny = 1, nz = -dz / (2 * e);
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** Slope (0 flat … 1 vertical-ish) = 1 - normal.y. */
  getSlope(x, z) {
    const e = this.spacing;
    const dx = (this.getHeight(x + e, z) - this.getHeight(x - e, z)) / (2 * e);
    const dz = (this.getHeight(x, z + e) - this.getHeight(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  /**
   * Ray-march the terrain. `ray` = { origin:{x,y,z}, direction:{x,y,z} } (direction normalised).
   * Writes the hit into `out` {x,y,z}. Returns true on hit. Beyond the map the terrain is treated
   * as continuing at the edge height so the camera always has something to grab.
   */
  raycast(ray, out, maxDist = 12000) {
    const o = ray.origin, dir = ray.direction;
    let t = 0;
    // skip the part of the ray that is above the highest terrain
    if (o.y > this.maxH + 1) {
      if (dir.y >= 0) return false;
      t = (this.maxH + 1 - o.y) / dir.y;
    }
    let px = o.x + dir.x * t, py = o.y + dir.y * t, pz = o.z + dir.z * t;
    let prevT = t, prevDiff = py - this.getHeight(px, pz);
    if (prevDiff < 0) { // started below the surface
      out.x = px; out.y = py; out.z = pz; return true;
    }
    const horiz = Math.hypot(dir.x, dir.z);
    while (t < maxDist) {
      // adaptive step: proportional to the height above the terrain, bounded
      const step = clamp(prevDiff * 0.6, 1.5, 40);
      t += step;
      px = o.x + dir.x * t; py = o.y + dir.y * t; pz = o.z + dir.z * t;
      const diff = py - this.getHeight(px, pz);
      if (diff <= 0) {
        // bisection refine between prevT and t
        let a = prevT, b = t;
        for (let k = 0; k < 10; k++) {
          const m = 0.5 * (a + b);
          const mx = o.x + dir.x * m, my = o.y + dir.y * m, mz = o.z + dir.z * m;
          if (my - this.getHeight(mx, mz) > 0) a = m; else b = m;
        }
        const tt = 0.5 * (a + b);
        out.x = o.x + dir.x * tt; out.y = o.y + dir.y * tt; out.z = o.z + dir.z * tt;
        return true;
      }
      if (dir.y >= 0 && py > this.maxH + 1) return false;
      if (horiz < 1e-6 && dir.y >= 0) return false;
      prevT = t;
      prevDiff = diff;
    }
    return false;
  }

  /**
   * Signed distance to the shoreline (metres, + on land, − under water) for every grid sample, as a
   * Uint8 texture payload: 128 + 4·sd (±32 m at 0.25 m). Near the shore the first-order estimate
   * h / |∇h| is used (exact for a planar bank, smooth across triangle facets); farther away an exact
   * Euclidean distance transform of the water mask. Returns `out` (Uint8Array N·N).
   */
  computeShoreDistance(out) {
    const { N, data, spacing } = this;
    const wl = this.waterLevel;
    const total = N * N;
    if (!out) out = new Uint8Array(total);
    const INF = 1e12;
    const dWater = this._edtScratchA || (this._edtScratchA = new Float64Array(total));
    const dLand = this._edtScratchB || (this._edtScratchB = new Float64Array(total));
    for (let k = 0; k < total; k++) { const w = data[k] < wl; dWater[k] = w ? 0 : INF; dLand[k] = w ? INF : 0; }
    edt2d(dWater, N); edt2d(dLand, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const h = data[k] - wl;
      const far = h >= 0 ? Math.sqrt(dWater[k]) * spacing : -Math.sqrt(dLand[k]) * spacing;
      // first-order shoreline distance from the local gradient
      const il = i > 0 ? k - 1 : k, ir = i < N - 1 ? k + 1 : k, ju = j > 0 ? k - N : k, jd = j < N - 1 ? k + N : k;
      const gx = (data[ir] - data[il]) / ((ir - il) * spacing || spacing), gz = (data[jd] - data[ju]) / (((jd - ju) / N) * spacing || spacing);
      const grad = Math.max(Math.hypot(gx, gz), 0.02);
      const near = clamp(h / grad, -8, 8);
      const aFar = Math.abs(far);
      const w = smoothstep(1.5, 6, aFar);
      const sd = lerp(near, far, w);
      out[k] = Math.max(0, Math.min(255, Math.round(128 + 4 * sd)));
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // editing
  // ---------------------------------------------------------------------------------------------

  /**
   * Flatten a rectangle [x0,x1]×[z0,z1] (world metres) to height `y` with a smooth blend of
   * `falloff` metres outside. Returns the modified grid bounds {i0,i1,j0,j1} or null.
   */
  flattenRect(x0, z0, x1, z1, y, falloff = 6) {
    const { N, spacing, half, data } = this;
    const i0 = clamp(Math.floor((Math.min(x0, x1) - falloff + half) / spacing), 0, N - 1);
    const i1 = clamp(Math.ceil((Math.max(x0, x1) + falloff + half) / spacing), 0, N - 1);
    const j0 = clamp(Math.floor((Math.min(z0, z1) - falloff + half) / spacing), 0, N - 1);
    const j1 = clamp(Math.ceil((Math.max(z0, z1) + falloff + half) / spacing), 0, N - 1);
    if (i1 < i0 || j1 < j0) return null;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let j = j0; j <= j1; j++) {
      const z = -half + j * spacing;
      const dz = z < az ? az - z : z > bz ? z - bz : 0;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * spacing;
        const dx = x < ax ? ax - x : x > bx ? x - bx : 0;
        const d = Math.hypot(dx, dz);
        const w = falloff > 0 ? 1 - smoothstep(0, falloff, d) : (d === 0 ? 1 : 0);
        if (w <= 0) continue;
        const k = j * N + i;
        data[k] = lerp(data[k], y, w);
        if (data[k] > this.maxH) this.maxH = data[k];
        if (data[k] < this.minH) this.minH = data[k];
      }
    }
    this.version++;
    return { i0, i1, j0, j1 };
  }

  /**
   * Conform the terrain to a corridor: `points` = dense centreline samples {x,y,z} carrying the final
   * bed height in `y`, `width` = full corridor width, `falloff` = metres of smooth blend outside it.
   * Heights are interpolated along the polyline (no terraces), every grid point is touched once.
   * Returns the modified grid bounds {i0,i1,j0,j1} or null.
   */
  conformPath(points, width, falloff = 6) {
    if (!points || points.length < 2) return null;
    const { N, spacing, half, data } = this;
    const r = width / 2, reach = r + falloff;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
    const i0 = clamp(Math.floor((minX - reach + half) / spacing), 0, N - 1), i1 = clamp(Math.ceil((maxX + reach + half) / spacing), 0, N - 1);
    const j0 = clamp(Math.floor((minZ - reach + half) / spacing), 0, N - 1), j1 = clamp(Math.ceil((maxZ + reach + half) / spacing), 0, N - 1);
    if (i1 < i0 || j1 < j0) return null;
    const W = i1 - i0 + 1, H = j1 - j0 + 1;
    const bestD = new Float32Array(W * H).fill(Infinity);
    const bestY = new Float32Array(W * H);
    for (let s = 0; s < points.length - 1; s++) {
      const a = points[s], b = points[s + 1];
      const abx = b.x - a.x, abz = b.z - a.z, len2 = abx * abx + abz * abz;
      if (len2 < 1e-6) continue;
      const si0 = clamp(Math.floor((Math.min(a.x, b.x) - reach + half) / spacing), i0, i1), si1 = clamp(Math.ceil((Math.max(a.x, b.x) + reach + half) / spacing), i0, i1);
      const sj0 = clamp(Math.floor((Math.min(a.z, b.z) - reach + half) / spacing), j0, j1), sj1 = clamp(Math.ceil((Math.max(a.z, b.z) + reach + half) / spacing), j0, j1);
      for (let j = sj0; j <= sj1; j++) {
        const z = -half + j * spacing;
        for (let i = si0; i <= si1; i++) {
          const x = -half + i * spacing;
          const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
          const px = a.x + abx * u, pz = a.z + abz * u;
          const d = Math.hypot(x - px, z - pz);
          if (d >= reach) continue;
          const k = (j - j0) * W + (i - i0);
          if (d < bestD[k]) { bestD[k] = d; bestY[k] = a.y + (b.y - a.y) * u; }
        }
      }
    }
    let touched = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = (j - j0) * W + (i - i0);
      const d = bestD[k];
      if (d === Infinity) continue;
      const w = d <= r ? 1 : 1 - smoothstep(r, reach, d);
      if (w <= 0) continue;
      const g = j * N + i;
      data[g] = lerp(data[g], bestY[k], w);
      if (data[g] > this.maxH) this.maxH = data[g];
      if (data[g] < this.minH) this.minH = data[g];
      touched = true;
    }
    if (!touched) return null;
    this.version++;
    return { i0, i1, j0, j1 };
  }

  /** Conform a disc (junction pad) to height y with a smooth falloff outside radius r. */
  conformDisc(x, z, r, y, falloff = 6) {
    const { N, spacing, half, data } = this;
    const reach = r + falloff;
    const i0 = clamp(Math.floor((x - reach + half) / spacing), 0, N - 1), i1 = clamp(Math.ceil((x + reach + half) / spacing), 0, N - 1);
    const j0 = clamp(Math.floor((z - reach + half) / spacing), 0, N - 1), j1 = clamp(Math.ceil((z + reach + half) / spacing), 0, N - 1);
    if (i1 < i0 || j1 < j0) return null;
    for (let j = j0; j <= j1; j++) {
      const dz = -half + j * spacing - z;
      for (let i = i0; i <= i1; i++) {
        const dx = -half + i * spacing - x;
        const d = Math.hypot(dx, dz);
        if (d >= reach) continue;
        const w = d <= r ? 1 : 1 - smoothstep(r, reach, d);
        const g = j * N + i;
        data[g] = lerp(data[g], y, w);
        if (data[g] > this.maxH) this.maxH = data[g];
        if (data[g] < this.minH) this.minH = data[g];
      }
    }
    this.version++;
    return { i0, i1, j0, j1 };
  }

  /** Average height inside a rectangle (used to pick the flatten level for lots). */
  averageHeight(x0, z0, x1, z1) {
    const n = 4;
    let sum = 0;
    for (let a = 0; a <= n; a++) for (let b = 0; b <= n; b++) sum += this.getHeight(lerp(x0, x1, a / n), lerp(z0, z1, b / n));
    return sum / ((n + 1) * (n + 1));
  }

  /** World bounds of grid index range → {x0,z0,x1,z1}. */
  gridToWorld(i0, j0, i1, j1) {
    const { spacing, half } = this;
    return { x0: -half + i0 * spacing, z0: -half + j0 * spacing, x1: -half + i1 * spacing, z1: -half + j1 * spacing };
  }
}

/** Simple square height grid (spacing metres) covering [-half, half]² with bilinear lookup. */
export class CoarseGrid {
  constructor(spacing, half) {
    this.spacing = spacing;
    this.half = half;
    this.N = Math.round(half * 2 / spacing) + 1;
    this.data = new Float32Array(this.N * this.N);
    this.minH = 0; this.maxH = 0;
  }
  fill(fn) {
    const { N, spacing, half, data } = this;
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < N; j++) {
      const z = -half + j * spacing;
      for (let i = 0; i < N; i++) {
        const h = fn(-half + i * spacing, z);
        data[j * N + i] = h;
        if (h < mn) mn = h; if (h > mx) mx = h;
      }
    }
    this.minH = mn; this.maxH = mx;
    return this;
  }
  getHeight(x, z) {
    const { N, spacing, half, data } = this;
    let fx = (x + half) / spacing, fz = (z + half) / spacing;
    if (fx < 0) fx = 0; else if (fx > N - 1) fx = N - 1;
    if (fz < 0) fz = 0; else if (fz > N - 1) fz = N - 1;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i >= N - 1) i = N - 2;
    if (j >= N - 1) j = N - 2;
    const tx = fx - i, tz = fz - j;
    const a = data[j * N + i], b = data[j * N + i + 1], c = data[(j + 1) * N + i], d = data[(j + 1) * N + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
}


/** In-place exact Euclidean distance transform (squared distances) of an N×N grid (Felzenszwalb & Huttenlocher). */
function edt2d(f, N) {
  const g = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1);
  const INF = 1e20;
  const edt1d = (get, set) => {
    for (let q = 0; q < N; q++) g[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < N; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < N; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
    }
    for (let q = 0; q < N; q++) set(q, d[q]);
  };
  for (let j = 0; j < N; j++) { const row = j * N; edt1d((i) => f[row + i], (i, val) => { f[row + i] = val; }); }
  for (let i = 0; i < N; i++) edt1d((j) => f[j * N + i], (j, val) => { f[j * N + i] = val; });
}
