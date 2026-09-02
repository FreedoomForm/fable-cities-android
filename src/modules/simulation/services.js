/**
 * City services model — power, water, sewage, garbage, police, fire, health, education.
 *
 * Service buildings are placed with `place(type, x, z)`. Each one radiates coverage on a
 * 16 m grid; `coverageAt(x, z, type)` returns 0..1. Capacity strain (more people than the
 * buildings can serve) scales the coverage of that type down so a single clinic cannot
 * serve a metropolis. Pure logic — the visuals live in visuals.js.
 */
import { clamp01, smoothstep } from '../../shared/math.js';

/** Weekly upkeep (economy.period === 'week') / one-off cost in ¤, radius in metres, capacity in people served. */
export const SERVICE_TYPES = {
  power: {
    id: 'power', name: 'Coal Power Plant', group: 'utilities', radius: 640, capacity: 9000,
    cost: 120000, upkeep: 1150, workers: 40, w: 60, d: 42, height: 22, color: 0xf4b942, icon: '⚡',
    description: 'Supplies electricity to homes and businesses within range.',
  },
  water: {
    id: 'water', name: 'Water Tower', group: 'utilities', radius: 480, capacity: 6000,
    cost: 32000, upkeep: 260, workers: 6, w: 18, d: 18, height: 27, color: 0x4fc3f7, icon: '💧',
    description: 'Pumps fresh water to the surrounding district.',
  },
  sewage: {
    id: 'sewage', name: 'Sewage Treatment Plant', group: 'utilities', radius: 600, capacity: 7000,
    cost: 60000, upkeep: 480, workers: 12, w: 46, d: 38, height: 8, color: 0x8d6e63, icon: '🚰',
    description: 'Treats waste water. Keep it away from housing.',
  },
  garbage: {
    id: 'garbage', name: 'Landfill Site', group: 'utilities', radius: 560, capacity: 7000,
    cost: 45000, upkeep: 420, workers: 18, w: 64, d: 50, height: 7, color: 0x9ccc65, icon: '🗑',
    description: 'Collects household and industrial garbage.',
  },
  police: {
    id: 'police', name: 'Police Station', group: 'safety', radius: 400, capacity: 4500,
    cost: 50000, upkeep: 590, workers: 30, w: 30, d: 22, height: 9.5, color: 0x5c6bc0, icon: '🚓',
    description: 'Reduces crime and raises land value nearby.',
  },
  fire: {
    id: 'fire', name: 'Fire House', group: 'safety', radius: 380, capacity: 4500,
    cost: 42000, upkeep: 560, workers: 24, w: 30, d: 24, height: 9.5, color: 0xef5350, icon: '🚒',
    description: 'Fire protection for homes and businesses.',
  },
  health: {
    id: 'health', name: 'Medical Clinic', group: 'wellbeing', radius: 420, capacity: 4000,
    cost: 70000, upkeep: 820, workers: 40, w: 36, d: 26, height: 13.5, color: 0xffffff, icon: '🏥',
    description: 'Healthcare keeps citizens healthy and happy.',
  },
  education: {
    id: 'education', name: 'Elementary School', group: 'wellbeing', radius: 360, capacity: 3000,
    cost: 55000, upkeep: 720, workers: 26, w: 44, d: 28, height: 8.5, color: 0xffa726, icon: '🏫',
    description: 'Educated citizens fill office jobs and earn more.',
  },
};
export const SERVICE_IDS = Object.keys(SERVICE_TYPES);
export const UTILITY_IDS = ['power', 'water', 'sewage', 'garbage'];

/** Coverage falloff: full strength inside 70 % of the radius, fading to 0 at the radius. */
export function falloff(dist, radius) {
  return smoothstep(1.0, 0.7, dist / radius);
}

export class ServicesModel {
  constructor(world, events, economyRef) {
    this.world = world;
    this.events = events;
    this.economy = economyRef; // world.economy (for cost deduction)
    this.res = 16; // coverage grid cell in metres
    this.n = Math.ceil(world.size / this.res);
    this.grids = {};
    this.strain = {};
    this.demandServed = {};
    this.capacity = {};
    this.counts = {};
    for (const id of SERVICE_IDS) {
      this.grids[id] = new Float32Array(this.n * this.n);
      this.strain[id] = 1;
      this.capacity[id] = 0;
      this.counts[id] = 0;
      this.demandServed[id] = 0;
    }
    this.list = [];
    this._byId = new Map();
    this._nextId = 1;
    this.version = 0;
    this.infoView = null;
    this._listeners = new Set();

    const self = this;
    this.api = {
      types: SERVICE_TYPES,
      ids: SERVICE_IDS,
      get list() { return self.list; },
      /** reason of the last failed place() */
      get lastError() { return self.lastError || null; },
      place: (type, x, z, opts) => self.place(type, x, z, opts),
      remove: (id) => self.remove(id),
      canPlace: (type, x, z, opts) => self.canPlace(type, x, z, opts),
      coverageAt: (x, z, type) => self.coverageAt(x, z, type),
      rawCoverageAt: (x, z, type) => self.rawCoverageAt(x, z, type),
      get: (id) => self._byId.get(id) || null,
      at: (x, z) => self.at(x, z),
      inRadius: (x, z, r) => self.list.filter((b) => (b.x - x) ** 2 + (b.z - z) ** 2 <= r * r),
      stats: () => self.stats(),
      /** Info-view overlay (visuals.js implements it): 'power' | … | 'all' | null */
      setInfoView: (type) => self.setInfoView(type),
      getInfoView: () => self.infoView,
      grid: (type) => self.grids[type] || null,
      gridInfo: () => ({ res: self.res, n: self.n, half: self.world.half }),
      onChange: (fn) => { self._listeners.add(fn); return () => self._listeners.delete(fn); },
    };
  }

  /** Resolve loose type names ('Police', 'fire-station', 'school') to a service id. */
  resolveType(type) {
    if (!type) return null;
    const t = String(type).toLowerCase();
    if (SERVICE_TYPES[t]) return t;
    if (t.startsWith('elec') || t.includes('power')) return 'power';
    if (t.includes('water')) return 'water';
    if (t.includes('sewage') || t.includes('sewer')) return 'sewage';
    if (t.includes('garbage') || t.includes('landfill') || t.includes('waste')) return 'garbage';
    if (t.includes('police') || t.includes('crime')) return 'police';
    if (t.includes('fire')) return 'fire';
    if (t.includes('health') || t.includes('clinic') || t.includes('hospital') || t.includes('medical')) return 'health';
    if (t.includes('school') || t.includes('educ')) return 'education';
    return null;
  }

  canPlace(type, x, z, opts = {}) {
    const id = this.resolveType(type);
    if (!id) return { ok: false, reason: `unknown service type "${type}"` };
    const def = SERVICE_TYPES[id];
    const world = this.world;
    const hw = def.w / 2 + 2, hd = def.d / 2 + 2;
    if (!world.inBounds(x - hw, z - hd) || !world.inBounds(x + hw, z + hd)) return { ok: false, reason: 'outside the map' };
    const terrain = world.terrain;
    if (terrain.isWater(x, z) || terrain.isWater(x - hw, z - hd) || terrain.isWater(x + hw, z + hd) || terrain.isWater(x - hw, z + hd) || terrain.isWater(x + hw, z - hd)) {
      return { ok: false, reason: 'cannot build on water' };
    }
    if (!opts.free && this.economy.money < def.cost) return { ok: false, reason: 'not enough money' };
    // overlap with other service buildings (axis-aligned bounds, footprints are compact)
    for (const b of this.list) {
      if (Math.abs(b.x - x) < (b.w + def.w) / 2 + 3 && Math.abs(b.z - z) < (b.d + def.d) / 2 + 3) return { ok: false, reason: 'overlaps another service building' };
    }
    // overlap with zoned buildings
    const buildings = world.buildings && world.buildings.list;
    if (Array.isArray(buildings) && !opts.ignoreBuildings) {
      for (const b of buildings) {
        if (!b || typeof b.x !== 'number') continue;
        const bw = (b.w || 16) / 2, bd = (b.d || 16) / 2;
        if (Math.abs(b.x - x) < bw + hw && Math.abs(b.z - z) < bd + hd) return { ok: false, reason: 'overlaps a building' };
      }
    }
    // overlap with roads (centre-line distance)
    const roads = world.roads && world.roads.api;
    if (roads && typeof roads.nearest === 'function' && !opts.ignoreRoads) {
      try {
        const hit = roads.nearest(x, z, Math.max(hw, hd) + 14);
        if (hit && hit.segment && hit.distance < Math.min(hw, hd) + (hit.segment.width || 12) / 2) return { ok: false, reason: 'too close to a road' };
      } catch (_) { /* roads api not ready */ }
    }
    return { ok: true, type: id, def };
  }

  /**
   * Place a service building. Deducts the building cost (unless opts.free). Returns the record or null.
   * opts: { yaw, free, ignoreRoads, ignoreBuildings, name }
   */
  place(type, x, z, opts = {}) {
    const check = this.canPlace(type, x, z, opts);
    if (!check.ok) {
      this.lastError = check.reason;
      if (!opts.silent) this.events.emit('notification', { kind: 'warning', title: 'Cannot build here', text: check.reason });
      return null;
    }
    const def = check.def;
    const world = this.world;
    const y = world.terrain.getHeight(x, z);
    const rec = {
      id: 'svc-' + this._nextId++,
      type: def.id,
      name: opts.name || def.name,
      x, y, z,
      yaw: opts.yaw || 0,
      w: def.w, d: def.d, height: def.height,
      radius: def.radius,
      capacity: def.capacity,
      upkeep: def.upkeep,
      workers: def.workers,
      state: 'built',
      builtDay: world.time.totalDays || 0,
      efficiency: 1,
      flattened: false,
    };
    // terrace the whole lot (building + lawn + kerb) if the terrain module offers it: the pad then
    // sits flush on level ground and the visuals need no retaining wall
    const tapi = world.terrain.api;
    if (tapi) {
      try {
        const yaw = rec.yaw, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
        const hw = (def.w + 15) / 2, hd = (def.d + 15) / 2;
        const ex = hw * c + hd * s, ez = hw * s + hd * c;
        if (typeof tapi.flattenRect === 'function') {
          const level = tapi.flattenRect(x - ex, z - ez, x + ex, z + ez, undefined, 10);
          if (Number.isFinite(level)) { rec.y = level; rec.flattened = true; }
        } else if (typeof tapi.flatten === 'function') {
          const cell = world.toCell(x - ex, z - ez);
          const level = tapi.flatten(cell.cx, cell.cz, Math.ceil(ex * 2 / world.cellSize), Math.ceil(ez * 2 / world.cellSize), undefined);
          if (Number.isFinite(level)) { rec.y = level; rec.flattened = true; }
        }
      } catch (_) { /* optional */ }
    }
    if (!opts.free) this.economy.money -= def.cost;
    this.list.push(rec);
    this._byId.set(rec.id, rec);
    this._rasterise(def.id);
    this._bump('service:added', rec);
    return rec;
  }

  remove(id) {
    const rec = this._byId.get(id);
    if (!rec) return false;
    this.list.splice(this.list.indexOf(rec), 1);
    this._byId.delete(id);
    this._rasterise(rec.type);
    this._bump('service:removed', rec);
    return true;
  }

  at(x, z) {
    for (const b of this.list) if (Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.z - z) <= b.d / 2) return b;
    return null;
  }

  _bump(evt, rec) {
    this.version++;
    this.world.services.version = this.version;
    this.events.emit(evt, rec);
    this.events.emit('services:changed', { version: this.version });
    for (const fn of this._listeners) fn(evt, rec);
  }

  /** Re-rasterise the coverage grid of one service type. */
  _rasterise(type) {
    const g = this.grids[type];
    g.fill(0);
    const { n, res } = this;
    const half = this.world.half;
    let count = 0, cap = 0;
    for (const b of this.list) {
      if (b.type !== type) continue;
      count++;
      cap += b.capacity;
      const r = b.radius;
      const i0 = Math.max(0, Math.floor((b.x - r + half) / res)), i1 = Math.min(n - 1, Math.ceil((b.x + r + half) / res));
      const j0 = Math.max(0, Math.floor((b.z - r + half) / res)), j1 = Math.min(n - 1, Math.ceil((b.z + r + half) / res));
      for (let j = j0; j <= j1; j++) {
        const cz = -half + (j + 0.5) * res;
        const dz = cz - b.z;
        for (let i = i0; i <= i1; i++) {
          const cx = -half + (i + 0.5) * res;
          const dx = cx - b.x;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d >= r) continue;
          const k = j * n + i;
          const v = g[k] + falloff(d, r);
          g[k] = v > 1 ? 1 : v;
        }
      }
    }
    this.counts[type] = count;
    this.capacity[type] = cap;
  }

  /** Coverage before capacity strain, bilinear-sampled. */
  rawCoverageAt(x, z, type) {
    const g = this.grids[type];
    if (!g) return 0;
    const { n, res } = this;
    const half = this.world.half;
    const fx = (x + half) / res - 0.5, fz = (z + half) / res - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const s = (ii, jj) => (ii < 0 || jj < 0 || ii >= n || jj >= n ? 0 : g[jj * n + ii]);
    const a = s(i, j) * (1 - tx) + s(i + 1, j) * tx;
    const b = s(i, j + 1) * (1 - tx) + s(i + 1, j + 1) * tx;
    return a * (1 - tz) + b * tz;
  }

  /** Effective coverage 0..1 (raw × strain). With no type → object of all types. */
  coverageAt(x, z, type) {
    if (type) {
      const id = this.resolveType(type);
      if (!id) return 0;
      return clamp01(this.rawCoverageAt(x, z, id) * this.strain[id]);
    }
    const out = {};
    for (const id of SERVICE_IDS) out[id] = clamp01(this.rawCoverageAt(x, z, id) * this.strain[id]);
    return out;
  }

  /**
   * Capacity strain: called by the economy each hour with the number of people each service
   * must serve. A service serving 150 % of its capacity works at ~67 %.
   */
  updateStrain(demandByType, efficiency = 1) {
    for (const id of SERVICE_IDS) {
      const demand = demandByType[id] || 0;
      const cap = this.capacity[id] * efficiency;
      this.demandServed[id] = demand;
      this.strain[id] = cap <= 0 ? 0 : demand <= 0 ? 1 : Math.min(1, cap / demand);
    }
    for (const b of this.list) b.efficiency = efficiency * this.strain[b.type];
  }

  /** Total upkeep of all service buildings per game month (matches economy.period). */
  weeklyUpkeep() {
    let sum = 0;
    for (const b of this.list) sum += b.upkeep;
    return sum;
  }
  monthlyUpkeep() { return this.weeklyUpkeep() * 52 / 12; }
  totalWorkers() {
    let sum = 0;
    for (const b of this.list) sum += b.workers;
    return sum;
  }

  setInfoView(type) {
    const id = type === 'all' || type === 'utilities' || type == null ? type ?? null : this.resolveType(type);
    if (type && !id) return this.infoView;
    this.infoView = id;
    this.world.services.infoView = id;
    this.events.emit('services:infoview', id);
    return id;
  }

  stats() {
    const out = {};
    for (const id of SERVICE_IDS) {
      out[id] = {
        count: this.counts[id],
        capacity: this.capacity[id],
        demand: Math.round(this.demandServed[id]),
        strain: +this.strain[id].toFixed(3),
        upkeep: this.counts[id] * SERVICE_TYPES[id].upkeep,
      };
    }
    return out;
  }
}
