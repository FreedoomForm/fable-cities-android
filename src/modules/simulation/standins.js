/**
 * Stand-in city blocks: while the buildings module delivers no stock (world.buildings.list empty)
 * the economy runs on synthetic building records — this renders those records so population,
 * households and jobs are visibly grounded. One InstancedMesh of massing blocks (per-instance size,
 * albedo, seed) with a procedural facade shader: window grid in metres, per-pane hash for lit /
 * unlit + colour temperature at night (staggered switch-on from world.env.nightFactor), coverage
 * tint for the info view; plus one InstancedMesh of gable roofs for the low-rise stock.
 * Drops itself automatically once world.buildings.list is non-empty.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

// eight swatches per class: brick red, buff, render white, warm stone, cool concrete, dark glass…
const PALETTES = {
  'res-low': [0xd9c9a8, 0xc9a98a, 0xb8865e, 0xe2d9c6, 0x9e6b52, 0xcfb9a0, 0xa9503f, 0xeae4d6],
  'res-high': [0xc8c2b6, 0xb9ada0, 0xd4cfc4, 0xa89f93, 0xbfb2a2, 0x9d5f4a, 0xe6ded0, 0x8e9aa2],
  'com-low': [0xd6d2ca, 0xbdb6a9, 0x8f8a80, 0xc4b79c, 0xb5514a, 0xe3ddd0, 0x7d8a92],
  'com-high': [0x8d949c, 0x6f7a86, 0xa8adb2, 0x5d6772, 0x3f4a55, 0xc3c7c9, 0x8a6f5e],
  'ind': [0x6f7275, 0x5d6266, 0x8a8c8a, 0x4f5457, 0x7a6f66, 0x96999a],
  'office': [0x6e7f8f, 0x55677a, 0x8a98a6, 0x47525e, 0x33414d, 0xa9b2b8],
};
const ROOF_COLORS = [0x6b3f33, 0x5a3a30, 0x4a4442, 0x7a4a3a, 0x3e3a38];

export class StandInBuildings {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'standin-buildings';
    ctx.scene.add(this.group);
    this.list = null;
    this.mesh = null;
    this.roofs = null;
    this.plant = null;
    this.uniforms = { uNight: { value: 0 }, uInfo: { value: 0 }, uInfoCol: { value: new THREE.Color(0x35d38a) } };
    this._buildMaterials();
  }

  _buildMaterials() {
    const { engine } = this.ctx;
    const u = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.04 });
    mat.customProgramCacheKey = () => 'simulation-standin-v2';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aDims; attribute vec4 aInfo; attribute vec3 aTint;
          varying vec3 vLocalM; varying vec3 vDims; varying vec4 vInfo; varying vec3 vTint; varying vec3 vNrmL;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLocalM = position * aDims; vDims = aDims; vInfo = aInfo; vTint = aTint; vNrmL = normal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; uniform float uInfo; uniform vec3 uInfoCol;
          varying vec3 vLocalM; varying vec3 vDims; varying vec4 vInfo; varying vec3 vTint; varying vec3 vNrmL;
          float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec3 n = normalize(vNrmL);
            bool isSide = abs(n.y) < 0.5;
            float u = abs(n.x) > 0.5 ? vLocalM.z : vLocalM.x;
            float v = vLocalM.y + vDims.y * 0.5;           // 0 at the pad, height at the top
            float H = vDims.y;
            float floors = max(1.0, floor(H / 3.4 + 0.2));
            float fh = H / floors;
            vec3 base = vTint;
            float pane = 0.0, lit = 0.0; vec3 litCol = vec3(1.0);
            if (isSide) {
              float paneW = vInfo.z;                         // window pitch (m)
              float fx = fract(u / paneW), fy = fract(v / fh);
              float win = step(0.22, fx) * step(fx, 0.78) * step(0.28, fy) * step(fy, 0.82);
              // no windows in the ground floor front of shops? keep a taller shop front instead
              float fl = floor(v / fh);
              if (vInfo.w > 0.5 && fl < 0.5) win = step(0.08, fx) * step(fx, 0.92) * step(0.12, fy) * step(fy, 0.88);
              // hide panes that fall on the edges of the wall
              float uEdge = (abs(n.x) > 0.5 ? vDims.z : vDims.x) * 0.5;
              float uu = abs(n.x) > 0.5 ? vLocalM.z : vLocalM.x;
              win *= step(abs(uu), uEdge - paneW * 0.5);
              win *= step(v, H - 0.6);
              pane = win;
              vec2 id = vec2(floor(u / paneW) + 37.0 * floor(v / fh), vInfo.y * 91.7 + floor(v / fh) + (abs(n.x) > 0.5 ? 13.0 : 0.0) + (n.x + n.z > 0.0 ? 5.0 : 0.0));
              float h1 = hash21(id), h2 = hash21(id + 11.3), h3 = hash21(id + 23.7);
              // 60-75 % of panes light up, staggered over dusk by a per-pane threshold
              float onThr = 0.10 + 0.75 * h2;
              float on = step(h1, 0.68) * smoothstep(onThr - 0.08, onThr + 0.08, uNight);
              // 60 % tungsten 2700 K, 27 % warm white 3500 K, 13 % cool 4000 K; one pane in ten
              // is driven past the bloom threshold so the skyline sparkles instead of flickering flat
              litCol = h3 < 0.60 ? vec3(1.0, 0.63, 0.31) : (h3 < 0.87 ? vec3(1.0, 0.80, 0.58) : vec3(0.84, 0.92, 1.0));
              float boost = step(0.90, hash21(id + 5.1));
              lit = on * (0.50 + 0.42 * hash21(id + 5.1) + 0.85 * boost);
              // glazing by day: dark blue-grey with a faint sky gradient
              vec3 glass = mix(vec3(0.05, 0.07, 0.09), vec3(0.16, 0.2, 0.24), fy);
              base = mix(base, glass, pane * 0.92);
              // floor slab shadow line + base grime + parapet band
              float slab = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.08, fy)) * (1.0 - pane);
              float grime = 1.0 - 0.32 * (1.0 - smoothstep(0.0, 2.4, v));
              float parapet = 1.0 - 0.12 * step(H - 0.6, v);
              base *= slab * grime * parapet;
              // subtle vertical streaks; industrial stock gets ribbed cladding
              base *= 1.0 - 0.06 * hash21(vec2(floor(u * 1.7), vInfo.y));
              // street lighting bounces onto the lowest 6 m of the facade after dusk
              base += vec3(0.020, 0.013, 0.006) * uNight * (1.0 - smoothstep(0.0, 6.0, v));
              if (vInfo.z > 3.0) base *= 0.88 + 0.12 * step(0.5, fract(u * 1.6));
            } else {
              // roof membrane with gravel-ish noise and a lighter parapet lip
              // light single-ply membrane with weathering streaks, a coping band and a plant patch
              float g = hash21(floor(vLocalM.xz * 1.3) + vInfo.y);
              float g2 = hash21(floor(vLocalM.xz * 0.31) + vInfo.y * 3.1);
              base = mix(vec3(0.185, 0.190, 0.196), vec3(0.255, 0.255, 0.250), g);
              base *= 0.90 + 0.16 * g2;
              vec2 e = vDims.xz * 0.5 - abs(vLocalM.xz);
              if (min(e.x, e.y) < 0.9) base = mix(base, vec3(0.30, 0.295, 0.285), 0.75);   // ballast strip
              if (min(e.x, e.y) < 0.32) base = vec3(0.42, 0.41, 0.40);                      // metal coping
            }
            // info view: tint the whole massing by coverage (red → service colour)
            if (uInfo > 0.5) {
              vec3 ramp = mix(vec3(0.72, 0.16, 0.12), vec3(0.85, 0.58, 0.20), smoothstep(0.0, 0.34, vInfo.x));
              ramp = mix(ramp, uInfoCol, smoothstep(0.30, 0.88, vInfo.x));
              base = mix(base * 0.42, ramp, 0.66);
              lit = 0.0;
            }
            diffuseColor.rgb *= base;
            vStandinEmissive = litCol * lit * pane;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vStandinEmissive * 0.72;`)
        .replace('void main() {', 'vec3 vStandinEmissive;\nvoid main() {');
    };
    engine.registerMaterial(mat);
    this.material = mat;

    const roof = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
    engine.registerMaterial(roof);
    this.roofMaterial = roof;

    const plant = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.35 });
    engine.registerMaterial(plant);
    this.plantMaterial = plant;
  }

  /** Render `list` (building records with x, y, z, yaw, w, d, height, type). */
  setList(list) {
    this.list = list;
    this._dispose();
    if (!list || !list.length) return;
    const { world, engine } = this.ctx;
    const n = list.length;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const dims = new Float32Array(n * 3), info = new Float32Array(n * 4), tint = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    mesh.name = 'standin-blocks';
    let lowCount = 0;
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const bury = 1.2; // plinth buried into slopes
      const h = b.height + bury;
      const y = Number.isFinite(b.y) && b.y !== 0 ? b.y : world.terrain.getHeight(b.x, b.z);
      b.y = y;
      _q.setFromEuler(_e.set(0, b.yaw || 0, 0));
      _m.compose(_p.set(b.x, y - bury + h / 2, b.z), _q, _s.set(b.w, h, b.d));
      mesh.setMatrixAt(i, _m);
      dims[i * 3] = b.w; dims[i * 3 + 1] = h; dims[i * 3 + 2] = b.d;
      const seed = hashRecord(b.id, i);
      const shop = b.type === 'com-low' || b.type === 'com-high' ? 1 : 0;
      const paneW = b.type === 'office' || b.type === 'com-high' ? 1.5 : b.type === 'ind' ? 3.2 : 2.4;
      info[i * 4] = 1; info[i * 4 + 1] = seed; info[i * 4 + 2] = paneW; info[i * 4 + 3] = shop;
      const pal = PALETTES[b.type] || PALETTES['com-low'];
      _c.set(pal[Math.floor(seed * pal.length) % pal.length]);
      const j = 0.9 + 0.2 * fract(seed * 7.31);
      tint[i * 3] = _c.r * j; tint[i * 3 + 1] = _c.g * j; tint[i * 3 + 2] = _c.b * j;
      if (b.type === 'res-low' || (b.type === 'com-low' && b.floors <= 1)) lowCount++;
    }
    geo.setAttribute('aDims', new THREE.InstancedBufferAttribute(dims, 3));
    geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    this._info = geo.attributes.aInfo;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.layers.enable(engine.LAYER_REFLECTED ?? 3);
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.mesh = mesh;

    // rooftop plant on the flat-roofed stock: stair core + one or two condenser blocks
    const flats = [];
    for (let i = 0; i < n; i++) {
      const b = list[i];
      if (b.type === 'res-low' || (b.type === 'com-low' && b.floors <= 1)) continue;
      flats.push(i);
    }
    if (flats.length) {
      const pg = new THREE.BoxGeometry(1, 1, 1);
      const per = 3;
      const plant = new THREE.InstancedMesh(pg, this.plantMaterial, flats.length * per);
      plant.name = 'standin-roofplant';
      let k = 0;
      for (const i of flats) {
        const b = list[i];
        const seed = hashRecord(b.id, i);
        const top = b.y + b.height;
        const c = Math.cos(b.yaw || 0), sn = Math.sin(b.yaw || 0);
        for (let j = 0; j < per; j++) {
          const hj = fract(seed * (7.1 + j * 3.7));
          const hj2 = fract(seed * (13.3 + j * 5.1));
          const bw = 1.6 + hj * (j === 0 ? 2.2 : 1.4), bd = 1.4 + hj2 * 1.6;
          const bh = j === 0 ? 2.4 + hj * 0.9 : 0.9 + hj2 * 0.9;
          const lx = (hj - 0.5) * Math.max(0, b.w - bw - 2.4);
          const lz = (hj2 - 0.5) * Math.max(0, b.d - bd - 2.4);
          _q.setFromEuler(_e.set(0, b.yaw || 0, 0));
          _m.compose(_p.set(b.x + lx * c + lz * sn, top + bh / 2, b.z - lx * sn + lz * c), _q, _s.set(bw, bh, bd));
          plant.setMatrixAt(k, _m);
          _c.setHSL(0.09, 0.02, 0.30 + 0.16 * hj2);
          plant.setColorAt(k, _c);
          k++;
        }
      }
      plant.count = k;
      plant.castShadow = true;
      plant.receiveShadow = true;
      plant.frustumCulled = false;
      plant.layers.enable(engine.LAYER_REFLECTED ?? 3);
      plant.instanceMatrix.needsUpdate = true;
      if (plant.instanceColor) plant.instanceColor.needsUpdate = true;
      this.group.add(plant);
      this.plant = plant;
    }

    // gable roofs on the low-rise stock
    if (lowCount) {
      const rg = gableGeometry();
      const roofs = new THREE.InstancedMesh(rg, this.roofMaterial, lowCount);
      roofs.name = 'standin-roofs';
      let k = 0;
      for (let i = 0; i < n; i++) {
        const b = list[i];
        if (!(b.type === 'res-low' || (b.type === 'com-low' && b.floors <= 1))) continue;
        const seed = hashRecord(b.id, i);
        const rh = Math.min(b.w, b.d) * 0.32;
        _q.setFromEuler(_e.set(0, (b.yaw || 0) + (seed > 0.5 ? Math.PI / 2 : 0), 0));
        const along = seed > 0.5 ? b.d : b.w, across = seed > 0.5 ? b.w : b.d;
        _m.compose(_p.set(b.x, b.y + b.height - 0.02, b.z), _q, _s.set(along + 0.7, rh, across + 0.7));
        roofs.setMatrixAt(k, _m);
        _c.set(ROOF_COLORS[Math.floor(fract(seed * 3.7) * ROOF_COLORS.length)]);
        roofs.setColorAt(k, _c);
        k++;
      }
      roofs.castShadow = true;
      roofs.receiveShadow = true;
      roofs.frustumCulled = false;
      roofs.layers.enable(engine.LAYER_REFLECTED ?? 3);
      roofs.instanceMatrix.needsUpdate = true;
      if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
      this.group.add(roofs);
      this.roofs = roofs;
    }
  }

  /** Info-view tint: coverage(x, z) → 0..1 per building; null switches the tint off. */
  setCoverage(fn, color) {
    if (!this.mesh || !this.list) return;
    const a = this._info;
    if (!fn) { this.uniforms.uInfo.value = 0; return; }
    for (let i = 0; i < this.list.length; i++) a.setX(i, fn(this.list[i].x, this.list[i].z));
    a.needsUpdate = true;
    if (color) this.uniforms.uInfoCol.value.copy(color);
    this.uniforms.uInfo.value = 1;
  }

  update() {
    const world = this.ctx.world;
    // real stock arrived: drop the stand-ins
    if (this.mesh && world.buildings.list && world.buildings.list.length) { this._dispose(); this.list = null; return; }
    this.uniforms.uNight.value = world.env.nightFactor || 0;
  }

  get count() { return this.list ? this.list.length : 0; }

  _dispose() {
    for (const m of [this.mesh, this.roofs, this.plant]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    this.mesh = null; this.roofs = null; this.plant = null;
  }
  dispose() {
    this._dispose();
    this.ctx.scene.remove(this.group);
    this.material.dispose();
    this.roofMaterial.dispose();
    this.plantMaterial.dispose();
  }
}

/** Triangular gable prism: unit width (x), unit depth (z, ridge along x), unit height, base at y = 0. */
function gableGeometry() {
  const g = new THREE.BufferGeometry();
  const v = [];
  const push = (...a) => v.push(...a);
  // two slopes
  push(-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0);
  push(0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0);
  // gable ends
  push(0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0);
  push(-0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0);
  // underside
  push(-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5);
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const uv = new Float32Array((v.length / 3) * 2);
  for (let i = 0; i < v.length / 3; i++) { uv[i * 2] = v[i * 3] + 0.5; uv[i * 2 + 1] = v[i * 3 + 2] + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
function fract(x) { return x - Math.floor(x); }
function hashRecord(id, i) {
  let h = 2166136261 ^ i;
  const s = String(id || i);
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
