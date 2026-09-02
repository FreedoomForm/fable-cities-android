/**
 * PuddleField — standing water on the road, built from the REAL road network.
 *
 * Why this exists: the previous puddle mask lived in `#ifdef USE_UV` branches of the global material
 * hook and keyed off `vUv.x` as "lateral metres from the centre line". Neither holds in three r185 —
 * `USE_UV` is never defined by WebGLProgram (only USE_UV1/2/3 are), so the whole road-space branch was
 * dead code, and the road UVs are texture UVs anyway, not road space. Every "puddles in the camber and
 * gutters" frame therefore fell through to a world-noise blob field and read as one uniform wet sheet.
 *
 * The fix is to stop guessing at road space and ask the roads module for it:
 *
 *  - `world.roads.segments` gives dense centre-line samples; `roads.api.types[t].definition` gives the
 *    carriageway half-width `cwHalf`, the median half-width and the lane width, and `asphaltPts` gives
 *    the CAMBER (e.g. a local road drops 7.6 cm from crown to gutter). `roads.api.surfaceHeight(x,z)`
 *    returns the cambered asphalt height, so a pool sits ON the asphalt, not on a fictional flat plane.
 *  - Water therefore goes where water goes: the gutter (the outer ~1 m of the carriageway, which the
 *    camber drains into) and the wheel ruts of each lane. Pools are discrete ellipses stretched ALONG
 *    the kerb, never blobs across the crown.
 *
 * Two products, from the same deterministic ellipse list, so they can never disagree:
 *
 *  1. **Geometry** — one merged, indexed mesh of feathered discs with a real
 *     `MeshPhysicalMaterial` at **roughness 0.06 / metalness 0 / envMapIntensity 1.9**
 *     (docs/MATERIAL_TARGET.md "Puddle"). It is a genuine mirror: the PMREM sky probe gives it the sky,
 *     the sun gives it a specular glint, the GroundFXPass gives it the buildings and the lamps. The
 *     alpha ramps 1 → 0 over the outer 16 % of the radius: a hard boundary at 30 m, no aliased rim.
 *  2. **A world-space RGBA drainage map** (`R` pool, `G` ploughed tyre band, `B` road corridor) that the
 *     screen-space pass and the material hook sample by world XZ, so the wet-road mirror sharpens
 *     exactly where the pools are and the snow tyre tracks follow the real lanes.
 *
 * Everything is seeded from `world.seed` + the segment id, so a given `?seed` always produces the same
 * puddles. Cost: one draw call, ~25 k triangles on the demo city, rebuilt only when roads change.
 */
import * as THREE from 'three';
import { makeRng, hashString } from '../../shared/random.js';
import { FX_NOISE_GLSL } from './wetGlsl.js';
import { WET_UNIFORMS } from './WetSurfaces.js';

/** Ring segments per puddle disc (a 3 m pool is ~10 px across at 120 m — 8 is plenty). */
const RING = 8;
/** Triangle budget guard: the demo city has ~15 km of kerb, which is more pools than a frame needs. */
const MAX_POOLS = 2800;
/** Alpha stays 1 out to this fraction of the radius, then falls to 0 — the shore band. */
const CORE = 0.84;
/** How high the water film sits over the asphalt (metres). Enough to clear depth-buffer noise, small
 *  enough that the parallax against the road is under a pixel at street distance. */
const LIFT = 0.022;
/** Map texel size in metres (upper bound; the map is capped at MAP_MAX texels a side). */
const TEXEL = 0.6;
const MAP_MAX = 2048;

const PUDDLE_PARS = /* glsl */ `
uniform float uPudTime;
uniform float uPudRain;
uniform float uPudWet;
uniform float uPudFade;
${FX_NOISE_GLSL}
vec2 pudRings(vec2 p, float t, float speed) {
  vec2 g = vec2(0.0);
  vec2 cell = floor(p);
  for (int j = -1; j <= 0; j++) for (int i = -1; i <= 0; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    vec2 h = fxHash2(c);
    vec2 centre = c + 0.5 + (h - 0.5) * 0.9;
    float ph = fract(t * speed + h.x * 7.31 + h.y * 3.17);
    vec2 d = p - centre;
    float r = length(d);
    float ring = ph * 0.8;
    float w = 0.04 + ph * 0.05;
    float x = (r - ring) / w;
    float amp = exp(-x * x) * (1.0 - ph) * (1.0 - ph);
    g += (d / max(r, 1e-3)) * amp * (-2.0 * x / w);
  }
  return g;
}
`;

// Injected before <lights_physical_fragment>: the water surface itself. Roughness is left at the
// material's 0.06 — this only tilts the normal (rain rings + a slow surface wobble) so the mirror
// moves, and fades the pool out with distance and with dryness.
const PUDDLE_INJECT = /* glsl */ `
{
  vec3 pudWorld = cameraPosition + (-vViewPosition) * mat3(viewMatrix);
  float pudDist = length(vViewPosition);
  // slow surface undulation: a real pool is never an optically flat mirror
  vec2 wob = vec2(
    fxValueNoise(pudWorld.xz * 1.25 + vec2(uPudTime * 0.07, 0.0)) - 0.5,
    fxValueNoise(pudWorld.xz * 1.25 + vec2(0.0, uPudTime * 0.07) + 19.0) - 0.5);
  vec2 g = wob * 0.55;
  // rain impact rings, near the camera only (they are 10-30 cm features)
  float rip = uPudRain * (1.0 - smoothstep(30.0, 85.0, pudDist));
  if (rip > 0.002) {
    g += (pudRings(pudWorld.xz * 2.4, uPudTime, 2.4) * 0.6 + pudRings(pudWorld.xz * 1.15 + 5.0, uPudTime, 1.6) * 0.4) * rip * 0.55;
  }
  vec3 gv = mat3(viewMatrix) * vec3(g.x, 0.0, g.y);
  normal = normalize(normal - gv * 0.030);
  // dry → gone; far → gone (a 2 m pool under 2 px is nothing but specular aliasing)
  diffuseColor.a *= uPudWet * (1.0 - smoothstep(uPudFade * 0.62, uPudFade, pudDist));
  if (diffuseColor.a < 0.004) discard;
}
#include <lights_physical_fragment>
`;

export class PuddleField {
  /**
   * @param {{engine:any, scene:THREE.Scene, world:any, seed:number}} ctx
   */
  constructor({ engine, scene, world, seed }) {
    this.engine = engine;
    this.scene = scene;
    this.world = world;
    this.seed = seed >>> 0;
    this.count = 0;
    this.version = -1;

    this.uniforms = {
      uPudTime: { value: 0 },
      uPudRain: { value: 0 },
      uPudWet: { value: 0 },
      uPudFade: { value: 300 },
    };

    // --- the water material: docs/MATERIAL_TARGET.md "Puddle" row ---
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'effects/puddle',
      color: new THREE.Color(0x0a0d10),      // dark water bed; the image comes from the reflection
      roughness: 0.06,
      metalness: 0.0,
      envMapIntensity: 1.9,                  // scene.environmentIntensity is 0.52 — a mirror needs the sky back
      transparent: true,
      depthWrite: false,
      vertexColors: true,                    // vec4 colour attribute → per-vertex ALPHA (the shore feather)
      side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -6,
    });
    mat.userData.noWetness = true;           // the global wet hook must not re-grade the water
    mat.userData.noPuddles = true;
    mat.userData.fxSkipHook = true;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + PUDDLE_PARS)
        .replace('#include <lights_physical_fragment>', PUDDLE_INJECT);
    };
    mat.customProgramCacheKey = () => 'effects-puddle-v1';
    engine.registerMaterial(mat);
    this.material = mat;

    // --- a second, glossier film for the damp shore ring is not needed: one material, one draw call ---
    this.group = new THREE.Group();
    this.group.name = 'effects-puddles';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    this.mesh = null;

    // --- world drainage map (R pool, G ploughed tyre band, B road corridor) ---
    // The map is published through the SHARED wet uniforms, so the global material hook and the
    // screen-space ground pass read exactly the same drainage field this field's geometry was built from.
    this.map = null;
    this.mapXf = WET_UNIFORMS.uFxPoolXf.value;    // originX, originZ, 1/spanMetres, hasMap
    this.mapUniforms = {
      uFxPoolMap: WET_UNIFORMS.uFxPoolMap,
      uFxPoolXf: WET_UNIFORMS.uFxPoolXf,
    };
  }

  /** Rebuild from world.roads. Safe to call when roads are missing (leaves an empty field). */
  build() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const roads = this.world.roads;
    const api = roads && roads.api;
    const segs = roads && roads.segments ? Array.from(roads.segments.values()) : [];
    this._clearMesh();
    this.count = 0;
    if (!segs.length) { this.mapXf.w = 0; return 0; }

    // ---- 1. bounds ----
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of segs) for (const p of s.points || []) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    if (!Number.isFinite(x0)) { this.mapXf.w = 0; return 0; }
    const pad = 24;
    x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
    const span = Math.max(x1 - x0, z1 - z0);
    const size = Math.min(MAP_MAX, Math.max(256, 1 << Math.ceil(Math.log2(span / TEXEL))));
    const texel = span / size;

    // ---- 2. drainage map raster ----
    const data = new Uint8Array(size * size * 4);
    const put = (x, z, ch, v) => {
      const ix = ((x - x0) / span * size) | 0, iz = ((z - z0) / span * size) | 0;
      if (ix < 0 || iz < 0 || ix >= size || iz >= size) return;
      const o = (iz * size + ix) * 4 + ch;
      const b = v * 255;
      if (b > data[o]) data[o] = b;
    };

    // ---- 3. walk every segment: pools in the gutters and wheel ruts, tyre bands, corridor mask ----
    const ell = [];               // {x,y,z,tx,tz,ra,rb}
    const defOf = (t) => (api && api.types && api.types[t] && api.types[t].definition) || null;
    const step = Math.max(0.45, texel * 0.75);

    for (const seg of segs) {
      const pts = seg.points;
      if (!pts || pts.length < 2) continue;
      const def = defOf(seg.type);
      const cwHalf = def ? def.cwHalf : Math.max(2, (seg.width || 12) * 0.34);
      if (cwHalf < 1.6) continue;                                // footpaths do not pond
      const medianHalf = def ? (def.medianHalf || 0) : 0;
      const laneW = def ? (def.laneWidth || 3.6) : 3.6;
      const sw = def ? (def.sidewalk || 0) : 1.6;
      const corridor = cwHalf + sw + 1.2;
      // wheel ruts: one pair per lane, 1.7 m apart, centred on the lane
      const ruts = [];
      for (let i = 0; ; i++) {
        const c = medianHalf + laneW * (i + 0.5);
        if (c + 0.9 > cwHalf) break;
        ruts.push(c - 0.85, c + 0.85);
        if (i > 6) break;
      }
      const rng = makeRng((hashString(String(seg.id)) ^ this.seed ^ 0x9d2b) >>> 0);

      // arc-length walk
      let carry = rng.range(2, 11);                              // distance to the next gutter pool
      let carryRut = rng.range(6, 26);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        let dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;                                 // right-hand normal

        // --- raster: corridor + tyre bands, marched along this span ---
        for (let s = 0; s < len; s += step) {
          const px = a.x + dx * s, pz = a.z + dz * s;
          for (let lat = -corridor; lat <= corridor; lat += step) {
            const wx = px + nx * lat, wz = pz + nz * lat;
            put(wx, wz, 2, 1);                                   // B: road corridor
            const al = Math.abs(lat);
            if (al <= cwHalf) {
              let band = 0;
              for (let r = 0; r < ruts.length; r++) band = Math.max(band, 1 - Math.abs(al - ruts[r]) / 0.95);
              if (band > 0) put(wx, wz, 1, Math.min(1, band));   // G: ploughed tyre band
            }
          }
        }

        // --- gutter pools: long, thin, hugging the kerb (the camber drains here) ---
        let s = carry;
        while (s < len) {
          const side = rng() < 0.5 ? -1 : 1;
          const lat = side * (cwHalf - 0.35 - rng.range(0, 0.75));
          const ra = rng.range(1.5, 4.4);                        // along the kerb
          const rb = Math.min(rng.range(0.65, 1.55), cwHalf * 0.34);
          const px = a.x + dx * s + nx * lat, pz = a.z + dz * s + nz * lat;
          ell.push({ x: px, z: pz, tx: dx, tz: dz, ra, rb, str: rng.range(0.85, 1) });
          s += rng.range(5, 15);
        }
        carry = s - len;

        // --- rut pools: shorter, in the wheel tracks, only where the ruts exist ---
        if (ruts.length) {
          let t = carryRut;
          while (t < len) {
            const r = ruts[(rng() * ruts.length) | 0];
            const side = rng() < 0.5 ? -1 : 1;
            const lat = side * r;
            const ra = rng.range(1.0, 3.0);
            const rb = rng.range(0.4, 0.85);
            const px = a.x + dx * t + nx * lat, pz = a.z + dz * t + nz * lat;
            ell.push({ x: px, z: pz, tx: dx, tz: dz, ra, rb, str: rng.range(0.6, 0.9) });
            t += rng.range(9, 26);
          }
          carryRut = t - len;
        }
      }
    }

    // ---- 4. lift every pool onto the cambered asphalt and drop the ones off-road ----
    const surfaceHeight = api && typeof api.surfaceHeight === 'function' ? api.surfaceHeight : null;
    const keep = [];
    for (const e of ell) {
      if (keep.length >= MAX_POOLS) break;
      let y = null;
      if (surfaceHeight) { try { y = surfaceHeight(e.x, e.z); } catch (_) { y = null; } }
      if (!Number.isFinite(y)) y = this.world.terrain ? this.world.terrain.getHeight(e.x, e.z) + 0.05 : null;
      if (!Number.isFinite(y)) continue;
      e.y = y + LIFT;
      // Camber ramp. The crossfall is linear over the 1-3 m a pool spans, so two extra probes across the
      // road give the whole disc its slope — 3 spatial queries per pool instead of one per vertex.
      e.slope = 0;
      if (surfaceHeight) {
        const nx = -e.tz, nz = e.tx, o = Math.max(0.5, e.rb);
        let hp = null, hm = null;
        try { hp = surfaceHeight(e.x + nx * o, e.z + nz * o); hm = surfaceHeight(e.x - nx * o, e.z - nz * o); } catch (_) { /* off road */ }
        if (Number.isFinite(hp) && Number.isFinite(hm)) e.slope = (hp - hm) / (2 * o);
      }
      keep.push(e);
      // R: the pool itself, into the drainage map
      const r = Math.max(e.ra, e.rb);
      const stamp = Math.max(0.35, texel * 0.9);
      for (let ox = -r; ox <= r; ox += stamp) {
        for (let oz = -r; oz <= r; oz += stamp) {
          const u = (ox * e.tx + oz * e.tz) / e.ra, v = (-ox * e.tz + oz * e.tx) / e.rb;
          const d = Math.sqrt(u * u + v * v);
          if (d <= 1.05) put(e.x + ox, e.z + oz, 0, e.str * Math.min(1, 1.3 - d * 0.9));
        }
      }
    }

    // ---- 5. publish the map ----
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    if (this.map) this.map.dispose();
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.name = 'effects/drainage';
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    this.map = tex;
    WET_UNIFORMS.uFxPoolMap.value = tex;
    this.mapXf.set(x0, z0, 1 / span, 1);

    // ---- 6. merged disc geometry ----
    this.count = keep.length;
    if (!keep.length) return 0;
    const perV = 1 + RING * 2, perI = RING * 3;
    const pos = new Float32Array(keep.length * perV * 3);
    const nrm = new Float32Array(keep.length * perV * 3);
    const col = new Float32Array(keep.length * perV * 4);
    const idx = new Uint32Array(keep.length * perI * 3);
    let vo = 0, io = 0;
    for (const e of keep) {
      const base = vo;
      // centre
      pos[vo * 3] = e.x; pos[vo * 3 + 1] = e.y; pos[vo * 3 + 2] = e.z;
      nrm[vo * 3 + 1] = 1;
      col[vo * 4] = col[vo * 4 + 1] = col[vo * 4 + 2] = 1; col[vo * 4 + 3] = 1;
      vo++;
      for (let ring = 0; ring < 2; ring++) {
        const k = ring === 0 ? CORE : 1.0;
        const alpha = ring === 0 ? 1 : 0;
        for (let i = 0; i < RING; i++) {
          const th = (i / RING) * Math.PI * 2;
          const u = Math.cos(th) * e.ra * k, v = Math.sin(th) * e.rb * k;
          const vx = e.x + u * e.tx - v * e.tz, vz = e.z + u * e.tz + v * e.tx;
          // Follow the CAMBER. A road crossfalls 7.6-15 cm from crown to gutter, so a planar disc
          // stretched 2 m up the camber sinks under the asphalt and is killed by the depth test — which
          // is exactly why the previous pass could not find its own puddles in any frame.
          pos[vo * 3] = vx;
          pos[vo * 3 + 1] = e.y + e.slope * v;
          pos[vo * 3 + 2] = vz;
          nrm[vo * 3 + 1] = 1;
          col[vo * 4] = col[vo * 4 + 1] = col[vo * 4 + 2] = 1; col[vo * 4 + 3] = alpha;
          vo++;
        }
      }
      const r0 = base + 1, r1 = base + 1 + RING;
      for (let i = 0; i < RING; i++) {
        const j = (i + 1) % RING;
        idx[io++] = base; idx[io++] = r0 + j; idx[io++] = r0 + i;               // core fan
        idx[io++] = r0 + i; idx[io++] = r0 + j; idx[io++] = r1 + j;             // shore
        idx[io++] = r0 + i; idx[io++] = r1 + j; idx[io++] = r1 + i;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, io), 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'effects-puddles';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;                                   // after the opaque road, before the particles
    mesh.layers.enable(this.engine.LAYER_NO_AO);            // the GTAO pre-pass cannot alpha-test
    this.mesh = mesh;
    this.group.add(mesh);
    this.engine.registerObject ? this.engine.registerObject(mesh) : this.engine.registerMaterial(this.material);
    this.buildMs = +((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(1);
    return keep.length;
  }

  /** @param {number} wet 0..1 @param {number} rain 0..1 @param {number} time seconds @param {number} draw metres */
  update(wet, rain, time, draw) {
    const u = this.uniforms;
    u.uPudTime.value = time;
    u.uPudRain.value = rain;
    // pools appear once the ground is properly wet and shrink as it dries
    u.uPudWet.value = Math.max(0, Math.min(1, (wet - 0.12) / 0.35));
    u.uPudFade.value = Math.max(120, Math.min(420, draw * 0.42));
    if (this.mesh) this.mesh.visible = u.uPudWet.value > 0.004;
  }

  _clearMesh() {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  dispose() {
    this._clearMesh();
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.map) this.map.dispose();
    this.material.dispose();
  }
}
