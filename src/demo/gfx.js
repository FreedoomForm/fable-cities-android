/**
 * demo — shared graphics helpers.
 *
 * The demo city adds a handful of things no module owns: the paved ground under dense blocks, the
 * port, the rail viaduct, motorway furniture and the civic landmarks. They all want the same
 * ingredients — real CC0 PBR sets from `public/assets/shared`, world-space UVs so a 60 m quay wall
 * does not stretch one texture tile across itself, per-vertex tint so one draw call can carry fifty
 * different container colours, and merged geometry so none of it costs draw calls.
 *
 * Everything here is deterministic: no Math.random, no time dependence.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeTexture, TILE as FACADE_TILE } from './facadeTex.js';

export { FACADE_TILE };

const BASE = '/assets/shared/';

/** PBR sets used by the demo. Slots follow MANIFEST.md (two naming families exist). */
const SETS = {
  paving: { dir: 'paving_slabs', map: 'albedo.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg' },
  asphalt: { dir: 'asphalt_light', map: 'albedo.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg' },
  concrete: { dir: 'concrete', map: 'albedo.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg' },
  metal: { dir: 'metalplates006', map: 'color.jpg', normalMap: 'normalgl.jpg', roughnessMap: 'roughness.jpg' },
  brick: { dir: 'bricks_red', map: 'color.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg' },
  wood: { dir: 'wood_planks', map: 'color.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg' },
};

/** sRGB hex → linear RGB triple (vertex colours are consumed linearly). */
export function lin(hex) {
  const c = new THREE.Color(hex);
  c.convertSRGBToLinear();
  return [c.r, c.g, c.b];
}

export class Gfx {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'demo';
    ctx.scene.add(this.group);
    this.mats = new Map();
    this.emissives = [];
    this._off = null;
  }

  async load() {
    const { assets, engine } = this.ctx;
    const tex = {};
    await Promise.all(Object.entries(SETS).map(async ([key, s]) => {
      const files = {};
      for (const slot of ['map', 'normalMap', 'roughnessMap']) if (s[slot]) files[slot] = BASE + s.dir + '/' + s[slot];
      tex[key] = await assets.loadPBR(files);
    }));
    this.tex = tex;

    // Albedo tints keep us near the LOOK_TARGET numbers: CS2 asphalt sits at Y 0.058 and its
    // buildings at 0.177, so every stock set is pulled well down from its bright studio scan.
    const M = (name, set, o = {}) => {
      const t = set ? tex[set] : {};
      const Ctor = o.clearcoat ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
      const mat = new Ctor({
        color: o.color != null ? o.color : 0xffffff,
        map: o.noMap ? null : (t.map || null),
        normalMap: t.normalMap || null,
        roughnessMap: t.roughnessMap || null,
        roughness: o.roughness != null ? o.roughness : 1,
        metalness: o.metalness != null ? o.metalness : 0,
        vertexColors: true,
        envMapIntensity: o.envMapIntensity != null ? o.envMapIntensity : 1,
        emissive: o.emissive != null ? o.emissive : 0x000000,
        emissiveIntensity: o.emissiveIntensity != null ? o.emissiveIntensity : 1,
        side: o.side || THREE.FrontSide,
        transparent: !!o.transparent,
        opacity: o.opacity != null ? o.opacity : 1,
        ...(o.clearcoat ? { clearcoat: o.clearcoat, clearcoatRoughness: o.clearcoatRoughness != null ? o.clearcoatRoughness : 0.1 } : {}),
      });
      if (t.normalMap && o.normalScale) mat.normalScale.set(o.normalScale, o.normalScale);
      mat.name = 'demo-' + name;
      engine.registerMaterial(mat);
      this.mats.set(name, mat);
      return mat;
    };

    // Two families. "Albedo-carrying" materials hold the tint in material.color and take the vertex
    // colour as a MODULATION around 1.0 (macro dirt, wear, per-instance variation). "Colour-carrying"
    // materials are white and let the vertex colour be the albedo, so one draw call can hold fifty
    // container colours or a car park of different paints.
    // Roughness bases follow docs/MATERIAL_TARGET.md. These are BASE values: every one of these
    // sets carries a roughnessMap that varies around it, and a base of 1.0 was pinning the whole
    // surface to perfect Lambertian — 65 % of the game's materials were doing that, which is why no
    // frame had a specular response anywhere in it.
    M('paving', 'paving', { color: 0x9d9a94, roughness: 0.80, normalScale: 1.0 });
    M('plaza', 'paving', { color: 0xa79c8c, roughness: 0.80, normalScale: 0.85 });
    M('asphalt', 'asphalt', { color: 0x6b6b6d, roughness: 0.66, normalScale: 1.1 });
    M('concrete', 'concrete', { color: 0x9c9992, roughness: 0.80, normalScale: 0.9 });
    M('concrete_dark', 'concrete', { color: 0x6f6d68, roughness: 0.82, normalScale: 1.0 });
    M('brick', 'brick', { color: 0x8f8074, roughness: 0.88, normalScale: 1.0 });
    M('wood', 'wood', { color: 0x9a8265, roughness: 0.85, normalScale: 0.9 });
    // Colour-carrying materials must NOT also carry an albedo map: the vertex colour is already the
    // full albedo, and multiplying it by a scanned metal-plate texture (itself ~0.25 albedo) turned
    // every container, crane and parked car into a black silhouette. Keep the normal and roughness
    // maps — the grain lives in the specular response, not the base colour.
    M('metal', 'metal', { color: 0xffffff, roughness: 0.45, metalness: 0.95, normalScale: 0.7, noMap: true });
    // painted steel (containers, cranes, plant): a clearcoat is what separates painted metal from
    // raw metal, and it is the lobe the reference frames read as "lacquer"
    M('paint', 'metal', { color: 0xffffff, roughness: 0.34, metalness: 0.0, normalScale: 0.3, noMap: true, clearcoat: 0.6, clearcoatRoughness: 0.12 });
    M('markings', null, { color: 0xffffff, roughness: 0.55 });
    const glass = M('glass', null, { color: 0xffffff, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.6 });
    glass.emissive = new THREE.Color(0x000000);
    // Night-lit surfaces: window glow on the landmarks, driven from world.env.nightFactor below.
    const win = M('window_lit', null, { color: 0x14171c, roughness: 0.10, metalness: 0.0, emissive: 0xffc98a, emissiveIntensity: 0, envMapIntensity: 1.4 });
    this.emissives.push({ mat: win, day: 0, night: 2.6 });
    const neon = M('neon', null, { color: 0x101010, roughness: 0.4, emissive: 0xff7a3c, emissiveIntensity: 0 });
    this.emissives.push({ mat: neon, day: 0, night: 3.4 });
    const lampGlass = M('lamp_glow', null, { color: 0x1a1a18, roughness: 0.3, emissive: 0xffd9a0, emissiveIntensity: 0 });
    this.emissives.push({ mat: lampGlass, day: 0, night: 3.0 });

    this._off = this.ctx.events.on('time:tick', () => this.updateNight());
    this.updateNight();
    return this;
  }

  updateNight() {
    const n = (this.ctx.world.env && this.ctx.world.env.nightFactor) || 0;
    const k = Math.min(1, Math.max(0, n * 1.25));
    for (const e of this.emissives) e.mat.emissiveIntensity = e.day + (e.night - e.day) * k;
  }

  mat(name) {
    const m = this.mats.get(name);
    if (!m) throw new Error('[demo] unknown material ' + name);
    return m;
  }

  /**
   * A landmark facade: procedural window grid with an emissive mask that lights up at night.
   * Returns the material key to pass to `mesh()` / `Bucket.push()`.
   */
  facade(style, seed) {
    const key = `facade_${style}_${seed}`;
    if (this.mats.has(key)) return key;
    const t = facadeTexture(style, seed, this.ctx.engine.maxAnisotropy || 8);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      emissiveMap: t.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
      // The probe used to be bound at half strength, so a curtain wall could only be made to read
      // as glass by keeping it rough and unmetallic. Core now binds the sky at full strength for the
      // specular lobe (Engine: IBL split), so the glazing can carry its real roughness and the
      // mullion grid in the map is what keeps it from being a mirror.
      color: style === 'glass' ? 0xb6bec6 : 0xbcb2a2,
      roughness: style === 'glass' ? 0.14 : 0.85,
      metalness: style === 'glass' ? 0.04 : 0.02,
      envMapIntensity: style === 'glass' ? 1.4 : 1.0,
      vertexColors: true,
    });
    mat.name = 'demo-' + key;
    this.ctx.engine.registerMaterial(mat);
    this.mats.set(key, mat);
    this.emissives.push({ mat, day: 0, night: 1.5 });
    return key;
  }

  /**
   * Merge `geos` into one mesh with material `name` and add it to the demo group.
   * Ground surfaces should not cast (they are flat) but must receive.
   */
  mesh(name, geos, o = {}) {
    // mergeGeometries refuses a mix of indexed and non-indexed inputs, and the demo mixes
    // BoxGeometry/CylinderGeometry (indexed) with its own hand-built shells (not) — so flatten.
    const list = geos.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
    if (!list.length) return null;
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) { console.warn('[demo] merge failed for', name, list.length); return null; }
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat(name));
    mesh.name = 'demo-' + name + (o.tag ? '-' + o.tag : '');
    mesh.castShadow = o.cast !== false;
    mesh.receiveShadow = o.receive !== false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (o.reflected !== false) mesh.layers.enable(this.ctx.engine.LAYER_REFLECTED);
    if (o.noAO) mesh.layers.enable(this.ctx.engine.LAYER_NO_AO);
    if (o.renderOrder) mesh.renderOrder = o.renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  dispose() {
    if (this._off) this._off();
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.group.parent && this.group.parent.remove(this.group);
  }
}

// ------------------------------------------------------------------------------------------------
// geometry helpers — every geometry carries position/normal/uv/color so any two can be merged.

const WHITE = [1, 1, 1];

/** Attach (or overwrite) a flat vertex colour. */
export function tint(geo, rgb) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = rgb || WHITE;
  for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function ensure(geo, rgb) {
  if (!geo.attributes.color) tint(geo, rgb);
  else if (rgb) {
    const a = geo.attributes.color;
    for (let i = 0; i < a.count; i++) a.setXYZ(i, rgb[0], rgb[1], rgb[2]);
    a.needsUpdate = true;
  }
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

/** Box with world-scaled UVs (`tile` metres per texture repeat). */
export function box(w, h, d, tile = 2, rgb) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry vertex groups: +X, -X, +Y, -Y, +Z, -Z — 4 verts each.
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su / tile, uv.getY(k) * sv / tile);
    }
  }
  uv.needsUpdate = true;
  return ensure(g, rgb);
}

/** Cylinder / cone / prism with world-scaled UVs. */
export function cyl(rTop, rBot, h, seg = 12, tile = 2, rgb, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const uv = g.attributes.uv, circ = Math.PI * (rTop + rBot);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / tile, uv.getY(i) * h / tile);
  uv.needsUpdate = true;
  return ensure(g, rgb);
}

/** Horizontal quad in XZ, centred, UVs in world metres / tile. */
export function slab(w, d, tile = 2, rgb) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / tile, uv.getY(i) * d / tile);
  uv.needsUpdate = true;
  return ensure(g, rgb);
}

/** Gable roof: ridge along local X, eaves at y=0, apex at y=h. */
export function gable(w, h, d, tile = 2, rgb) {
  const hw = w / 2, hd = d / 2;
  const tri = [];
  const P = (x, y, z) => ({ x, y, z });
  const quad = (a, b, c, e) => { tri.push([a, b, c], [a, c, e]); };
  // two pitched planes
  quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, 0), P(-hw, h, 0));
  quad(P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, 0), P(hw, h, 0));
  // gable ends
  tri.push([P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, 0)]);
  tri.push([P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, 0)]);
  return fromTriangles(orientOutward(tri, { x: 0, y: h * 0.35, z: 0 }), tile, rgb);
}

/** Barrel vault shell: axis along X, opening downwards, outward normals. */
export function vault(r, len, seg = 14, tile = 2, rgb) {
  const tri = [];
  const hl = len / 2;
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI * (i / seg), a1 = Math.PI * ((i + 1) / seg);
    const p0 = { z: -Math.cos(a0) * r, y: Math.sin(a0) * r };
    const p1 = { z: -Math.cos(a1) * r, y: Math.sin(a1) * r };
    tri.push([{ x: -hl, y: p0.y, z: p0.z }, { x: hl, y: p0.y, z: p0.z }, { x: hl, y: p1.y, z: p1.z }]);
    tri.push([{ x: -hl, y: p0.y, z: p0.z }, { x: hl, y: p1.y, z: p1.z }, { x: -hl, y: p1.y, z: p1.z }]);
  }
  return fromTriangles(orientOutward(tri, { x: 0, y: 0, z: 0 }), tile, rgb);
}

/** Ring of `n` flat panels around an ellipse — stadium stands, arena roofs. */
export function ringPanels(rx, rz, n, y0, y1, inset, tile = 2, rgb) {
  const tri = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const o0 = { x: Math.cos(a0) * rx, z: Math.sin(a0) * rz };
    const o1 = { x: Math.cos(a1) * rx, z: Math.sin(a1) * rz };
    const i0 = { x: Math.cos(a0) * (rx - inset), z: Math.sin(a0) * (rz - inset) };
    const i1 = { x: Math.cos(a1) * (rx - inset), z: Math.sin(a1) * (rz - inset) };
    // outer wall
    tri.push([{ x: o0.x, y: y0, z: o0.z }, { x: o1.x, y: y0, z: o1.z }, { x: o1.x, y: y1, z: o1.z }]);
    tri.push([{ x: o0.x, y: y0, z: o0.z }, { x: o1.x, y: y1, z: o1.z }, { x: o0.x, y: y1, z: o0.z }]);
    // raked top surface falling inwards
    tri.push([{ x: o0.x, y: y1, z: o0.z }, { x: o1.x, y: y1, z: o1.z }, { x: i1.x, y: y0 + (y1 - y0) * 0.25, z: i1.z }]);
    tri.push([{ x: o0.x, y: y1, z: o0.z }, { x: i1.x, y: y0 + (y1 - y0) * 0.25, z: i1.z }, { x: i0.x, y: y0 + (y1 - y0) * 0.25, z: i0.z }]);
  }
  return fromTriangles(orientOutward(tri, { x: 0, y: y0 - (y1 - y0) * 0.6, z: 0 }), tile, rgb);
}

/**
 * Flip any triangle whose face normal points back towards `ref` — the cheap way to guarantee a
 * hand-built shell (hull, vault, stand) has consistent outward normals whichever way its stations
 * were walked. A face lit from behind reads as pure black, which is exactly how the port's ships
 * first rendered.
 */
export function orientOutward(tris, ref = { x: 0, y: 0, z: 0 }) {
  for (const t of tris) {
    const [a, b, c] = t;
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const ox = (a.x + b.x + c.x) / 3 - ref.x, oy = (a.y + b.y + c.y) / 3 - ref.y, oz = (a.z + b.z + c.z) / 3 - ref.z;
    if (nx * ox + ny * oy + nz * oz < 0) { t[1] = c; t[2] = b; }
  }
  return tris;
}

/** Build a geometry from explicit triangles with tri-planar-ish world UVs. */
export function fromTriangles(tris, tile = 2, rgb) {
  const n = tris.length * 3;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let k = 0;
  for (const t of tris) {
    const [a, b, c] = t;
    let nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    let ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    let nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (const p of t) {
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
      if (ay >= ax && ay >= az) { uv[k * 2] = p.x / tile; uv[k * 2 + 1] = p.z / tile; }
      else if (ax >= az) { uv[k * 2] = p.z / tile; uv[k * 2 + 1] = p.y / tile; }
      else { uv[k * 2] = p.x / tile; uv[k * 2 + 1] = p.y / tile; }
      k++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return ensure(g, rgb);
}

/** Move / rotate (about Y) / scale a geometry in place. */
export function at(geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (ry) geo.rotateY(ry);
  geo.translate(x, y, z);
  return geo;
}

/** A 4-point convex quad (world coords, y each) as two triangles with world-space UVs. */
export function quadXZ(p0, p1, p2, p3, tile = 2, rgb) {
  const pos = new Float32Array(18), uv = new Float32Array(12), nrm = new Float32Array(18);
  const pts = [p0, p1, p2, p0, p2, p3];
  for (let i = 0; i < 6; i++) {
    pos[i * 3] = pts[i].x; pos[i * 3 + 1] = pts[i].y; pos[i * 3 + 2] = pts[i].z;
    uv[i * 2] = pts[i].x / tile; uv[i * 2 + 1] = pts[i].z / tile;
  }
  for (let t = 0; t < 2; t++) {
    const a = pts[t * 3], b = pts[t * 3 + 1], c = pts[t * 3 + 2];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let i = 0; i < 3; i++) { const k = (t * 3 + i) * 3; nrm[k] = nx; nrm[k + 1] = ny; nrm[k + 2] = nz; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return ensure(g, rgb);
}

/** Vertical quad between two ground points, dropping `depth` (a kerb face / skirt). */
export function skirtQuad(ax, ay, az, bx, by, bz, depth, tile = 2, rgb) {
  return quadXZ(
    { x: ax, y: ay, z: az }, { x: bx, y: by, z: bz },
    { x: bx, y: by - depth, z: bz }, { x: ax, y: ay - depth, z: az }, tile, rgb,
  );
}

/**
 * A terrain-conforming paved surface.
 *
 * `cells(u, v)` returns null to leave a cell out, or a `{ mat, rgb, tile }` descriptor. Cells are
 * emitted per material bucket and the boundary of each bucket gets a vertical kerb skirt, which is
 * what gives every paved area a real edge for contact shadows and AO instead of a floating decal.
 *
 * @param {{ u0,u1,v0,v1, step, toWorld(u,v), heightAt(x,z), cell(u,v), lift, skirt }} o
 * @returns {Map<string, THREE.BufferGeometry[]>}
 */
export function pavedField(o) {
  const { u0, u1, v0, v1, step, toWorld, heightAt, cell } = o;
  const lift = o.lift != null ? o.lift : 0.17;
  const skirt = o.skirt != null ? o.skirt : 0.42;
  const nu = Math.max(1, Math.round((u1 - u0) / step));
  const nv = Math.max(1, Math.round((v1 - v0) / step));
  // The city frame may be left- or right-handed against world XZ depending on which way the coast
  // runs. Emit the winding that makes the ground normal point UP either way, or every paved metre is
  // back-face culled and invisible.
  const oa = toWorld(u0, v0), ob = toWorld(u0 + step, v0), oc = toWorld(u0, v0 + step);
  const flip = ((ob.x - oa.x) * (oc.z - oa.z) - (ob.z - oa.z) * (oc.x - oa.x)) > 0;
  const out = new Map();
  const desc = new Array((nu + 1) * (nv + 1)).fill(null);
  const pt = new Array((nu + 1) * (nv + 1)).fill(null);
  const idx = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = u0 + i * step, v = v0 + j * step;
      const w = toWorld(u, v);
      pt[idx(i, j)] = { x: w.x, y: heightAt(w.x, w.z) + lift, z: w.z };
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      desc[idx(i, j)] = cell(u0 + (i + 0.5) * step, v0 + (j + 0.5) * step);
    }
  }
  const push = (matName, g) => {
    let a = out.get(matName);
    if (!a) out.set(matName, (a = []));
    a.push(g);
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const d = desc[idx(i, j)];
      if (!d) continue;
      const a = pt[idx(i, j)], b = pt[idx(i + 1, j)], c = pt[idx(i + 1, j + 1)], e = pt[idx(i, j + 1)];
      push(d.mat, flip ? quadXZ(a, e, c, b, d.tile || 2, d.rgb) : quadXZ(a, b, c, e, d.tile || 2, d.rgb));
      // kerb skirts on any edge that leaves the paved set
      const nb = [
        [i - 1, j, a, e], [i + 1, j, c, b], [i, j - 1, b, a], [i, j + 1, e, c],
      ];
      for (const [ni, nj, p, q] of nb) {
        const inside = ni >= 0 && ni < nu && nj >= 0 && nj < nv && desc[idx(ni, nj)];
        if (inside) continue;
        const [s, e2] = flip ? [q, p] : [p, q];
        push(d.mat, skirtQuad(s.x, s.y, s.z, e2.x, e2.y, e2.z, skirt, d.tile || 2, d.rgb));
      }
    }
  }
  return out;
}

/** Merge one bucket map into another (used to gather many blocks into one mesh per material). */
export function mergeInto(target, add) {
  for (const [k, v] of add) {
    let a = target.get(k);
    if (!a) target.set(k, (a = []));
    for (const g of v) a.push(g);
  }
  return target;
}

/** Bucket helper for structures: `push(mat, geo)`. */
export class Bucket {
  constructor() { this.map = new Map(); }
  push(mat, geo) {
    if (!geo) return this;
    let a = this.map.get(mat);
    if (!a) this.map.set(mat, (a = []));
    a.push(geo);
    return this;
  }
  add(mat, geo, x, y, z, ry = 0, rgb) {
    if (rgb) tint(geo, rgb);
    return this.push(mat, at(geo, x, y, z, ry));
  }
  emit(gfx, opts = {}) {
    const made = [];
    for (const [mat, geos] of this.map) made.push(gfx.mesh(mat, geos, opts));
    this.map.clear();
    return made;
  }
  get count() { let n = 0; for (const v of this.map.values()) n += v.length; return n; }
}
