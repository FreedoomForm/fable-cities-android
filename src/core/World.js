import * as THREE from 'three';
import { makeRng } from '../shared/random.js';

/**
 * Shared world state. This is the contract between modules — see ARCHITECTURE.md.
 * Modules *fill in* the sub-objects they own (e.g. terrain fills `world.terrain`),
 * other modules only *read* them (or call the exposed `api`).
 */
export class World {
  constructor(config) {
    this.config = config;
    this.size = config.mapSize; // metres, map spans [-size/2, size/2] on X and Z
    this.half = this.size / 2;
    this.seed = config.seed;
    this.rng = makeRng(config.seed);
    this.cellSize = 8; // one zoning cell = 8 m (Cities: Skylines grid)

    /** Game clock. `hour` is fractional [0, 24). speed: 0 paused, 1..3 speed steps. */
    this.time = {
      hour: config.time,
      minute: 0,
      day: 1,
      weekday: 0,      // 0 = Monday
      month: 5,
      year: 2026,
      totalDays: 0,
      speed: config.paused ? 0 : 1,
      paused: config.paused,
      secondsPerHour: 20, // real seconds per in-game hour at speed 1 (8 min per day)
      elapsedGameSeconds: 0,
    };

    /** Terrain query interface — filled by the terrain module. Flat fallback until then. */
    this.terrain = {
      ready: false,
      size: this.size,
      waterLevel: 0,
      getHeight: (_x, _z) => 0,
      getNormal: (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, 0),
      isWater: (_x, _z) => false,
      /** Raycast against the terrain surface. Returns true and fills `out` on hit. */
      raycast: (ray, out) => {
        const t = -ray.origin.y / ray.direction.y;
        if (!Number.isFinite(t) || t < 0) return false;
        out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
        return true;
      },
      api: null,
    };

    /** Road network — filled by the roads module. */
    this.roads = { version: 0, nodes: new Map(), segments: new Map(), api: null };
    /** Zoning — filled by the zoning module. */
    this.zones = { version: 0, lots: [], api: null };
    /** Buildings — filled by the buildings module. */
    this.buildings = { version: 0, list: [], api: null };
    /** Street furniture — props module. */
    this.props = { api: null };
    /** Vehicles and pedestrians — traffic module. */
    this.traffic = { api: null, vehicles: 0, pedestrians: 0 };
    /** City services (power, water, etc.) — simulation module. */
    this.services = { api: null, list: [], types: null, version: 0 };

    /** Economy & city statistics — simulation module. */
    this.economy = {
      money: 350000,
      population: 0,
      households: 0,
      jobs: 0,
      workers: 0,
      employed: 0,
      unemployment: 0,
      income: 0,
      expenses: 0,
      net: 0,
      period: 'week',   // all flows are per game week (ARCHITECTURE §4)
      taxRate: { residential: 0.1, commercial: 0.1, industrial: 0.1, office: 0.1 },
      happiness: 0.72,
      demand: { residential: 0.6, commercial: 0.35, industrial: 0.4, office: 0.2 },
      cityName: 'New Fable',
    };

    /** Environment state — written by the environment module, read by everyone. */
    this.env = {
      sunDirection: new THREE.Vector3(-0.35, -0.8, 0.45).normalize(), // direction light travels (towards ground)
      sunColor: new THREE.Color(1.0, 0.96, 0.9),
      sunIntensity: 3.0,
      moonIntensity: 0.0,
      skyColor: new THREE.Color(0.55, 0.7, 1.0),
      groundColor: new THREE.Color(0.35, 0.33, 0.28),
      ambientIntensity: 0.6,
      /** 0 at full day, 1 at deep night. Buildings/props use this to switch lights on. */
      nightFactor: 0,
      weather: config.weather,
      cloudCover: 0.3,
      rain: 0,
      snow: 0,
      fogDensity: 0.00012,
      wind: new THREE.Vector2(0.7, 0.3),
      windStrength: 0.35,
      temperature: 21,
    };

    /** Active tool state — written by the UI/tools modules. */
    this.tool = { active: 'select', options: {} };
    this.selection = null;
    this.notifications = [];
  }

  inBounds(x, z) {
    return x >= -this.half && x <= this.half && z >= -this.half && z <= this.half;
  }
  clampToMap(v) {
    v.x = Math.max(-this.half, Math.min(this.half, v.x));
    v.z = Math.max(-this.half, Math.min(this.half, v.z));
    return v;
  }
  /** Convert world position to zoning grid cell indices. */
  toCell(x, z) {
    return { cx: Math.floor((x + this.half) / this.cellSize), cz: Math.floor((z + this.half) / this.cellSize) };
  }
  cellCenter(cx, cz) {
    return { x: -this.half + (cx + 0.5) * this.cellSize, z: -this.half + (cz + 0.5) * this.cellSize };
  }
}
