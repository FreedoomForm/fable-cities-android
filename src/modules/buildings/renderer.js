/**
 * Instanced rendering for buildings. Parts are grouped into InstancedMesh pools keyed by
 * (geometry, material). Two tiers:
 *   - static: building masses (walls, roofs, tanks, ground quads) — persistent instances with
 *     swap-remove; thousands of buildings cost ~30 draw calls per pass.
 *   - dynamic: rooftop / street-level detail, balconies, signs, fences, scaffolding and cranes —
 *     rebuilt from the buildings near the camera whenever it moves (CPU LOD streaming).
 * Every pool carries instanceColor plus aParams/aParams2 (facade parameters), aTint (info views)
 * and aVariant (atlas column) instanced attributes.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Alpha-tested / negligible materials kept out of the shadow passes (alpha-test shadows are costly). */
const NO_SHADOW = new Set(['chain', 'sign', 'picket', 'lamp', 'beacon']);

class Pool {
  constructor(renderer, geoKey, matKey, dynamic) {
    this.r = renderer;
    this.geoKey = geoKey;
    this.matKey = matKey;
    this.dynamic = dynamic;
    this.count = 0;
    this.capacity = 0;
    this.mesh = null;
    this.owners = [];
    this.ground = geoKey === 'plane';
    this._alloc(dynamic ? 256 : 128);
  }
  _alloc(capacity) {
    const geo = this.r.geometries[this.geoKey].clone();
    const mat = this.r.mats[this.matKey];
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = this.count;
    mesh.frustumCulled = false;
    // ground plates and alpha-tested panels (chain-link, signs) stay out of the shadow passes:
    // they contribute almost nothing and alpha-test shadows are the most expensive draws we submit
    mesh.castShadow = !this.ground && !NO_SHADOW.has(this.matKey);
    mesh.receiveShadow = true;
    mesh.layers.enable(this.r.layerReflected);
    mesh.name = `buildings/${this.dynamic ? 'detail' : 'mass'}/${this.geoKey}/${this.matKey}`;
    mesh.userData.entity = 'building';
    mesh.userData.buildingAt = (i) => (this.owners[i] ? this.owners[i].owner : null); // static pools: instanceId → record
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    const p1 = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const p2 = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    const variant = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [color, p1, p2, tint, variant]) a.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = color;
    geo.setAttribute('aParams', p1);
    geo.setAttribute('aParams2', p2);
    geo.setAttribute('aTint', tint);
    geo.setAttribute('aVariant', variant);
    if (this.mesh) {
      const old = this.mesh;
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.count * 16));
      color.array.set(old.instanceColor.array.subarray(0, this.count * 3));
      p1.array.set(old.geometry.getAttribute('aParams').array.subarray(0, this.count * 4));
      p2.array.set(old.geometry.getAttribute('aParams2').array.subarray(0, this.count * 4));
      tint.array.set(old.geometry.getAttribute('aTint').array.subarray(0, this.count * 3));
      variant.array.set(old.geometry.getAttribute('aVariant').array.subarray(0, this.count));
      this.r.scene.remove(old);
      old.geometry.dispose();
      old.dispose();
    }
    this.mesh = mesh;
    this.capacity = capacity;
    this.r.scene.add(mesh);
    this._dirty();
  }
  _dirty() {
    const g = this.mesh.geometry;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    g.getAttribute('aParams').needsUpdate = true;
    g.getAttribute('aParams2').needsUpdate = true;
    g.getAttribute('aTint').needsUpdate = true;
    g.getAttribute('aVariant').needsUpdate = true;
  }
  _write(i, matrix, part) {
    const g = this.mesh.geometry;
    matrix.toArray(this.mesh.instanceMatrix.array, i * 16);
    const c = part.color;
    const ca = this.mesh.instanceColor.array;
    if (c) { ca[i * 3] = c[0]; ca[i * 3 + 1] = c[1]; ca[i * 3 + 2] = c[2]; } else { ca[i * 3] = ca[i * 3 + 1] = ca[i * 3 + 2] = 1; }
    const p1 = g.getAttribute('aParams').array, p2 = g.getAttribute('aParams2').array;
    const a = part.p1, b = part.p2;
    if (a) { p1[i * 4] = a[0]; p1[i * 4 + 1] = a[1]; p1[i * 4 + 2] = a[2]; p1[i * 4 + 3] = a[3]; } else { p1[i * 4] = 3; p1[i * 4 + 1] = 0; p1[i * 4 + 2] = 0; p1[i * 4 + 3] = 3; }
    if (b) { p2[i * 4] = b[0]; p2[i * 4 + 1] = b[1]; p2[i * 4 + 2] = b[2]; p2[i * 4 + 3] = b[3]; } else { p2[i * 4] = 3; p2[i * 4 + 1] = 0.5; p2[i * 4 + 2] = 0.5; p2[i * 4 + 3] = 3; }
    g.getAttribute('aVariant').array[i] = part.variant || 0;
  }
  /** static tier */
  add(matrix, part, owner) {
    if (this.count >= this.capacity) this._alloc(this.capacity * 2);
    const i = this.count++;
    this._write(i, matrix, part);
    const ref = { pool: this, i, owner };
    this.owners[i] = ref;
    this.mesh.count = this.count;
    this._dirty();
    return ref;
  }
  setMatrix(ref, matrix) {
    matrix.toArray(this.mesh.instanceMatrix.array, ref.i * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  setTint(ref, r, g, b) {
    const t = this.mesh.geometry.getAttribute('aTint');
    t.array[ref.i * 3] = r; t.array[ref.i * 3 + 1] = g; t.array[ref.i * 3 + 2] = b;
    t.needsUpdate = true;
  }
  remove(ref) {
    if (ref.i < 0 || ref.pool !== this) return;
    const last = this.count - 1;
    const i = ref.i;
    if (i !== last) {
      const g = this.mesh.geometry;
      const copy = (arr, n) => { for (let k = 0; k < n; k++) arr[i * n + k] = arr[last * n + k]; };
      copy(this.mesh.instanceMatrix.array, 16);
      copy(this.mesh.instanceColor.array, 3);
      copy(g.getAttribute('aParams').array, 4);
      copy(g.getAttribute('aParams2').array, 4);
      copy(g.getAttribute('aTint').array, 3);
      copy(g.getAttribute('aVariant').array, 1);
      const moved = this.owners[last];
      moved.i = i;
      this.owners[i] = moved;
    }
    this.owners.length = last;
    this.count = last;
    this.mesh.count = last;
    ref.i = -1;
    this._dirty();
  }
  /** dynamic tier */
  begin() { this.count = 0; }
  push(matrix, part) {
    if (this.count >= this.capacity) this._alloc(this.capacity * 2);
    this._write(this.count++, matrix, part);
  }
  end() {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this._dirty();
  }
  dispose() {
    if (!this.mesh) return;
    this.r.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.mesh = null;
  }
}

export class BuildingRenderer {
  constructor({ scene, geometries, mats, layerReflected, layerNoAo }) {
    this.scene = scene;
    this.geometries = geometries;
    this.mats = mats;
    // fall back to the contract's layer id: layers.enable(undefined) silently enables layer 0,
    // which is how building pools can end up missing from the planar water reflection
    this.layerReflected = Number.isInteger(layerReflected) ? layerReflected : 3;
    this.pools = new Map();
    this.dynamicPools = [];
    this._buildingMatrix = new THREE.Matrix4();
    // selection highlight
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.selBox = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x5fd7ff, transparent: true, opacity: 0.16, depthWrite: false }));
    this.selEdges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.9 }));
    for (const o of [this.selBox, this.selEdges]) {
      o.visible = false;
      o.frustumCulled = false;
      o.renderOrder = 50;
      o.layers.set(layerNoAo);
      o.name = 'buildings/selection';
      scene.add(o);
    }
  }
  pool(geoKey, matKey, dynamic = false) {
    const key = (dynamic ? 'D:' : 'S:') + geoKey + '|' + matKey;
    let p = this.pools.get(key);
    if (!p) {
      if (!this.geometries[geoKey]) throw new Error(`[buildings] unknown geometry "${geoKey}"`);
      if (!this.mats[matKey]) throw new Error(`[buildings] unknown material "${matKey}"`);
      p = new Pool(this, geoKey, matKey, dynamic);
      this.pools.set(key, p);
      if (dynamic) this.dynamicPools.push(p);
    }
    return p;
  }
  /** Compose the world matrix of a part given the building frame. */
  worldMatrix(b, part, out = _m) {
    this._buildingMatrix.makeRotationY(b.yaw).setPosition(b.x, b.y, b.z);
    _q.setFromEuler(_e.set(part.rx || 0, part.ry || 0, part.rz || 0));
    _local.compose(_p.set(part.x, part.y, part.z), _q, _s.set(part.w, part.h, part.d));
    return out.multiplyMatrices(this._buildingMatrix, _local);
  }
  addStatic(b, part) {
    const m = this.worldMatrix(b, part);
    return this.pool(part.geo, part.mat, false).add(m, part, b);
  }
  updateStatic(ref, b, part) {
    if (ref.i < 0) return;
    ref.pool.setMatrix(ref, this.worldMatrix(b, part));
  }
  removeStatic(ref) { ref.pool.remove(ref); }
  beginDynamic() { for (const p of this.dynamicPools) p.begin(); }
  pushDynamic(b, part) {
    const m = this.worldMatrix(b, part);
    this.pool(part.geo, part.mat, true).push(m, part);
  }
  endDynamic() { for (const p of this.dynamicPools) p.end(); }
  setSelection(b) {
    const show = !!b;
    this.selBox.visible = this.selEdges.visible = show;
    if (!show) return;
    const w = (b.w || 8) + 1.0, d = (b.d || 8) + 1.0, h = (b.height || 6) + 0.8;
    for (const o of [this.selBox, this.selEdges]) {
      o.position.set(b.x, b.y - 0.1, b.z);
      o.rotation.set(0, b.yaw || 0, 0);
      o.scale.set(w, h, d);
    }
  }
  dispose() {
    for (const p of this.pools.values()) p.dispose();
    this.pools.clear();
    this.dynamicPools.length = 0;
    for (const o of [this.selBox, this.selEdges]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
  }
}
