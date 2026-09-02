/**
 * Vertex-cluster decimation for BufferGeometry (shared util — added by the props module).
 *
 * Photogrammetry-grade CC0 props (a Poly Haven fire hydrant is 43 k triangles) are far too heavy for
 * a city full of instances. This collapses every vertex that falls inside the same grid cell into one
 * representative vertex, drops the triangles that degenerate as a result, and recomputes normals —
 * the classic Rossignac/Borrel algorithm. It is fast (one pass), deterministic, and keeps the model's
 * silhouette; small surface detail is what disappears, which is exactly what you cannot see on a 0.8 m
 * prop at street distance.
 *
 * Only `position`, `normal`, `uv` and `uv1` survive; the geometry comes back indexed.
 */
import * as THREE from 'three';

/**
 * @param {THREE.BufferGeometry} geometry source (not modified)
 * @param {number} cell grid size in local units; larger = fewer triangles
 * @returns {THREE.BufferGeometry} decimated copy (or the original when nothing could be removed)
 */
export function clusterDecimate(geometry, cell) {
  const pos = geometry.getAttribute('position');
  if (!pos || !(cell > 0)) return geometry;
  const index = geometry.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount < 64) return geometry;

  const uv = geometry.getAttribute('uv');
  const uv1 = geometry.getAttribute('uv1');
  const inv = 1 / cell;
  const map = new Map();          // cell key → representative index
  const acc = [];                 // { n, x, y, z, u, v, u1, v1 }
  const vertexCell = new Int32Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    const key = `${cx},${cy},${cz}`;
    let id = map.get(key);
    if (id === undefined) {
      id = acc.length;
      map.set(key, id);
      acc.push({ n: 0, x: 0, y: 0, z: 0, u: 0, v: 0, u1: 0, v1: 0 });
    }
    const a = acc[id];
    a.n++; a.x += x; a.y += y; a.z += z;
    if (uv) { a.u += uv.getX(i); a.v += uv.getY(i); }
    if (uv1) { a.u1 += uv1.getX(i); a.v1 += uv1.getY(i); }
    vertexCell[i] = id;
  }
  if (acc.length >= pos.count * 0.92) return geometry;   // nothing meaningful to gain

  const outPos = new Float32Array(acc.length * 3);
  const outUv = uv ? new Float32Array(acc.length * 2) : null;
  const outUv1 = uv1 ? new Float32Array(acc.length * 2) : null;
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i], k = 1 / a.n;
    outPos[i * 3] = a.x * k; outPos[i * 3 + 1] = a.y * k; outPos[i * 3 + 2] = a.z * k;
    if (outUv) { outUv[i * 2] = a.u * k; outUv[i * 2 + 1] = a.v * k; }
    if (outUv1) { outUv1[i * 2] = a.u1 * k; outUv1[i * 2 + 1] = a.v1 * k; }
  }

  const idx = [];
  const get = (t) => (index ? index.getX(t) : t);
  for (let t = 0; t < triCount; t++) {
    const a = vertexCell[get(t * 3)], b = vertexCell[get(t * 3 + 1)], c = vertexCell[get(t * 3 + 2)];
    if (a === b || b === c || a === c) continue;         // collapsed to a sliver
    idx.push(a, b, c);
  }
  if (!idx.length) return geometry;

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outUv) out.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  if (outUv1) out.setAttribute('uv1', new THREE.BufferAttribute(outUv1, 2));
  out.setIndex(acc.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Triangle count of a geometry (indexed or not). */
export function triangleCount(geometry) {
  const index = geometry.getIndex();
  const pos = geometry.getAttribute('position');
  if (!pos) return 0;
  return ((index ? index.count : pos.count) / 3) | 0;
}
