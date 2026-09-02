/**
 * tools/picking — resolve the pointer to a city entity through public APIs only.
 *
 * Buildings and service buildings are volumes, so the ray is marched in XZ and tested against the
 * record's oriented box (buildings.api.at is a spatial-hash lookup, services.list is short). Roads,
 * lots and terrain are flat, so the terrain hit point resolves them. The first volume along the ray
 * wins, which gives CS2-like behaviour: a tower in front of a street is picked, not the street.
 */
import * as THREE from 'three';

const _ray = new THREE.Raycaster();
const _p = new THREE.Vector3();

export function createPicker(ctx) {
  const { world, camera } = ctx;

  const inBox = (b, x, y, z) => {
    const yaw = b.yaw || 0;
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const dx = x - b.x, dz = z - b.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const hw = (b.w || 16) / 2 + 0.4, hd = (b.d || 16) / 2 + 0.4;
    if (Math.abs(lx) > hw || Math.abs(lz) > hd) return false;
    const base = b.y != null ? b.y : world.terrain.getHeight(b.x, b.z);
    return y >= base - 2.5 && y <= base + (b.height || 12) + 0.6;
  };

  /** Ray → first building / service volume, else the ground entity under the cursor. */
  function pick(ndc, opts = {}) {
    if (!ndc) return null;
    _ray.setFromCamera(ndc, camera);
    const ray = _ray.ray;
    const groundHit = world.terrain.raycast(ray, _p) ? { x: _p.x, y: _p.y, z: _p.z } : null;
    const maxT = groundHit ? ray.origin.distanceTo(_p) : 2600;

    // --- volumes: services first (short list, exact), then buildings (marched hash lookups)
    let best = null, bestT = Infinity;
    const services = world.services && world.services.list;
    if (!opts.skipServices && Array.isArray(services)) {
      for (const b of services) {
        const t = rayBoxT(ray, b, world);
        if (t != null && t < bestT && t <= maxT + 1) { bestT = t; best = { kind: 'service', id: b.id, entity: b }; }
      }
    }
    const bApi = world.buildings && world.buildings.api;
    if (!opts.skipBuildings && bApi && typeof bApi.at === 'function') {
      const step = Math.max(1.6, Math.min(6, maxT / 220));
      const start = Math.max(0, Math.min(bestT, maxT) - 260);
      for (let t = start; t < Math.min(bestT, maxT); t += step) {
        const x = ray.origin.x + ray.direction.x * t;
        const y = ray.origin.y + ray.direction.y * t;
        const z = ray.origin.z + ray.direction.z * t;
        if (y < -60) break;
        const b = bApi.at(x, z);
        if (b && inBox(b, x, y, z)) { bestT = t; best = { kind: 'building', id: b.id, entity: b }; break; }
      }
    }
    if (best) {
      const t = bestT;
      best.point = { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t, z: ray.origin.z + ray.direction.z * t };
      best.distance = t;
      return best;
    }
    if (!groundHit) return null;

    // --- flat entities under the ground point
    const rApi = world.roads && world.roads.api;
    if (!opts.skipRoads && rApi && typeof rApi.nearest === 'function') {
      const hit = rApi.nearest(groundHit.x, groundHit.z, 34);
      if (hit && hit.segment && hit.distance <= (hit.segment.width || 12) / 2 + 2.2) {
        return { kind: 'road', id: hit.segment.id, entity: hit.segment, point: groundHit, distance: maxT, t: hit.t };
      }
    }
    const zApi = world.zones && world.zones.api;
    if (!opts.skipLots && zApi && typeof zApi.lotAt === 'function') {
      const lot = zApi.lotAt(groundHit.x, groundHit.z);
      if (lot) return { kind: 'lot', id: lot.id, entity: lot, point: groundHit, distance: maxT };
    }
    return { kind: 'terrain', id: null, entity: null, point: groundHit, distance: maxT };
  }

  return { pick, inBox };
}

/** Slab test against an axis-aligned box in the record's local (yaw-rotated) frame. */
function rayBoxT(ray, b, world) {
  const yaw = b.yaw || 0;
  const c = Math.cos(-yaw), s = Math.sin(-yaw);
  const ox = ray.origin.x - b.x, oz = ray.origin.z - b.z;
  const lox = ox * c - oz * s, loz = ox * s + oz * c;
  const ldx = ray.direction.x * c - ray.direction.z * s;
  const ldz = ray.direction.x * s + ray.direction.z * c;
  const base = b.y != null ? b.y : world.terrain.getHeight(b.x, b.z);
  const mn = [-(b.w || 16) / 2, base - 0.5, -(b.d || 16) / 2];
  const mx = [(b.w || 16) / 2, base + (b.height || 12), (b.d || 16) / 2];
  const o = [lox, ray.origin.y, loz];
  const d = [ldx, ray.direction.y, ldz];
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-6) { if (o[i] < mn[i] || o[i] > mx[i]) return null; continue; }
    let a = (mn[i] - o[i]) / d[i], bb = (mx[i] - o[i]) / d[i];
    if (a > bb) { const tmp = a; a = bb; bb = tmp; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, bb);
    if (t0 > t1) return null;
  }
  return t0;
}

/** Footprint description used by the highlight renderer. */
export function footprintOf(hit, world) {
  if (!hit || !hit.entity) return null;
  const e = hit.entity;
  if (hit.kind === 'building' || hit.kind === 'service') {
    return { x: e.x, z: e.z, w: e.w || 16, d: e.d || 16, yaw: e.yaw || 0, height: e.height || 10, y: e.y != null ? e.y : world.terrain.getHeight(e.x, e.z) };
  }
  if (hit.kind === 'lot') {
    return { x: e.x, z: e.z, w: e.w || 16, d: e.d || 16, yaw: e.yaw || 0, height: 0, y: world.terrain.getHeight(e.x, e.z) };
  }
  return null;
}
