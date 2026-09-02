/**
 * Visuals owned by the simulation module:
 *   1. Service buildings — procedural PBR architecture (recipes.js) merged into one mesh per
 *      material, procedural fleet vehicles (vehicles.js), driveways to the nearest road (drop
 *      kerb via roads.api.sampleEdge), additive light pools at night, smoke / steam sources for
 *      the effects module. Per-building albedo jitter + base grime are baked as vertex colours.
 *   2. Stand-in massing blocks for the economy's synthetic stock (standins.js) until the
 *      buildings module delivers real buildings.
 *   3. Info-view overlay (infoview.js).
 * Textures: CC0 ambientCG sets (public/assets/simulation/tex), shared sets (public/assets/shared)
 * and seeded canvas textures (textures.js). Everything loads lazily.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, hashString } from '../../shared/random.js';
import { smoothstep } from '../../shared/math.js';
import { SERVICE_TYPES } from './services.js';
import { RECIPES, makeBuilder } from './recipes.js';
import { buildVehicle } from './vehicles.js';
import { makeWindowSet, makeSign, makeRollerDoor, makeGarbage, makeHedge, makeLightPool, makeFlag, makeChevron, PANES, WINDOW_ROWS } from './textures.js';
import { InfoViewOverlay } from './infoview.js';
import { StandInBuildings } from './standins.js';

const TEX = '/assets/simulation/tex/';
const SETS = {
  concrete: { dir: TEX + 'Concrete034/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg' } },
  brick: { dir: TEX + 'Bricks051/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg' } },
  brick_yellow: { dir: '/assets/shared/bricks_yellow/', files: { map: 'color.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg', aoMap: 'ao.jpg' } },
  steel: { dir: TEX + 'CorrugatedSteel005/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg', metalnessMap: 'Metalness.jpg', aoMap: 'AmbientOcclusion.jpg' } },
  plates: { dir: TEX + 'MetalPlates006/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg', metalnessMap: 'Metalness.jpg' } },
  gravel: { dir: TEX + 'Gravel022/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg', aoMap: 'AmbientOcclusion.jpg' } },
  paving: { dir: TEX + 'PavingStones131/', files: { map: 'Color.jpg', normalMap: 'NormalGL.jpg', roughnessMap: 'Roughness.jpg', aoMap: 'AmbientOcclusion.jpg' } },
  lawn: { dir: '/assets/shared/Grass004/', files: { map: 'color.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg', aoMap: 'ao.jpg' } },
  asphalt: { dir: '/assets/shared/asphalt_light/', files: { map: 'albedo.jpg', normalMap: 'normal.jpg', roughnessMap: 'roughness.jpg', aoMap: 'ao.jpg' } },
};
const NO_SHADOW = new Set(['paving', 'lawn', 'asphalt', 'asphalt_dark', 'court', 'dirt', 'pool', 'mesh', 'paint_white', 'gravel', 'gravel_dark', 'kerb', 'streak', 'membrane']);
const NO_AO = new Set(['pool', 'mesh', 'streak']);
/** Keys that receive the per-building tint + base-grime vertex colour. */
const WALL_KEYS = new Set(['brick', 'brick_red', 'brick_buff', 'concrete', 'concrete_white', 'steel', 'trim', 'plates']);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();

export class ServiceVisuals {
  constructor(ctx, services) {
    this.ctx = ctx;
    this.services = services;
    this.group = new THREE.Group();
    this.group.name = 'service-buildings';
    ctx.scene.add(this.group);
    this.materials = null;
    this.meshes = new Map();
    this.smokeIds = [];
    this._dirty = false;
    this._loading = null;
    this.nightUniform = { value: 0 };
    this.standins = new StandInBuildings(ctx);
    this.infoView = new InfoViewOverlay(ctx, services, this.standins);
    this._off = services.api.onChange(() => { this._dirty = true; this.infoView.markDirty(); this._terrainWatchUntil = performance.now() + 6000; });
    this._offInfo = ctx.events.on('services:infoview', (type) => this.infoView.setType(type));
    // the terrain may finish flattening after we built: re-fit once it reports changes
    this._terrainWatchUntil = 0;
    this._offTerrain = ctx.events.on('terrain:changed', () => { if (this.services.list.length && performance.now() < this._terrainWatchUntil) this._dirty = true; });
    this._offRoads = ctx.events.on('roads:changed', () => { if (this.services.list.length) this._dirty = true; });
    if (services.list.length) this._dirty = true;
  }

  /** Stand-in stock for the economy's synthetic building list (dropped once real buildings exist). */
  setStandIns(list) { this.standins.setList(list); this.infoView.markDirty(); }

  ensureLoaded() {
    if (this._loading) return this._loading;
    const { assets, engine, world } = this.ctx;
    this._loading = (async () => {
      const sets = {};
      await Promise.all(Object.entries(SETS).map(async ([key, s]) => {
        const files = {};
        for (const [slot, f] of Object.entries(s.files)) files[slot] = s.dir + f;
        sets[key] = await assets.loadPBR(files);
        for (const t of Object.values(sets[key])) t.anisotropy = engine.maxAnisotropy;
      }));

      const reg = (m) => engine.registerMaterial(m);
      const mk = (set, extra = {}, prep = null) => {
        const t = sets[set] || {};
        const params = { roughness: 1, metalness: t.metalnessMap ? 0.6 : 0 };
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (t[k]) params[k] = t[k];
        const m = new THREE.MeshStandardMaterial({ ...params, ...extra });
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        if (prep) prep(m);                       // custom cache key + onBeforeCompile before registration
        return reg(m);
      };
      const paint = (color, roughness = 0.55, metalness = 0.1, extra = {}) => reg(new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
      const wall = (set, extra = {}) => mk(set, { vertexColors: true, ...extra });

      // procedural sets
      const win = makeWindowSet(hashString('service-windows'));
      const roller = makeRollerDoor('#b4b8bb', 7);
      const garbage = makeGarbage(hashString('landfill'));
      const hedgeT = makeHedge(hashString('hedge'));
      const cityName = (world.economy.cityName || 'New Fable').toUpperCase();
      const SIGNS = {
        sign_police: { text: 'POLICE', bg: '#1f3d7a', fg: '#ffffff', w: 7.5, h: 1.15, icon: 'shield' },
        sign_fire: { text: 'FIRE STATION', sub: 'ENGINE COMPANY No. 3', bg: '#b3261e', fg: '#ffffff', w: 10, h: 1.15, icon: 'flame' },
        sign_health: { text: 'MEDICAL CLINIC', bg: '#f4f4f0', fg: '#d3262a', w: 9, h: 1.3, icon: 'cross', border: 'rgba(211,38,42,0.55)' },
        sign_emergency: { text: 'EMERGENCY', bg: '#d3262a', fg: '#ffffff', w: 6.5, h: 0.9 },
        sign_education: { text: 'ELEMENTARY SCHOOL', bg: '#d9822b', fg: '#ffffff', w: 12, h: 1.1, icon: 'book' },
        sign_water: { text: cityName, sub: 'WATER WORKS', bg: '#1e6f9e', fg: '#ffffff', w: 6.4, h: 1.5, icon: 'drop' },
        sign_sewage: { text: 'WATER TREATMENT', bg: '#2f6b5e', fg: '#ffffff', w: 8.5, h: 0.95, icon: 'drop' },
        sign_garbage: { text: 'LANDFILL', sub: 'WASTE MANAGEMENT', bg: '#3f7a2a', fg: '#ffffff', w: 8, h: 1.0, icon: 'leaf' },
        sign_power: { text: cityName + ' POWER', bg: '#f4b942', fg: '#1b1b1b', w: 14, h: 1.6, icon: 'bolt' },
      };
      // glazing: pane-snapped colour/emissive atlas; per-pane hash in the shader staggers the
      // switch-on over dusk and keeps the intensity low enough for bloom to carry the glow
      const glass = new THREE.MeshStandardMaterial({ map: win.map, normalMap: win.normalMap, roughnessMap: win.roughnessMap, emissiveMap: win.emissiveMap, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 1, metalness: 0.15, normalScale: new THREE.Vector2(0.9, 0.9) });
      const nightU = this.nightUniform;
      glass.customProgramCacheKey = () => 'simulation-glass-v2';
      glass.onBeforeCompile = (shader) => {
        shader.uniforms.uNight = nightU;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uNight;')
          .replace('#include <emissivemap_fragment>', `
          #ifdef USE_EMISSIVEMAP
            vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
            vec2 paneId = floor(vEmissiveMapUv * vec2(${PANES}.0, ${WINDOW_ROWS}.0));
            float ph = fract(sin(dot(paneId, vec2(12.9898, 78.233))) * 43758.5453);
            float thr = 0.10 + 0.78 * ph;
            float on = smoothstep(thr - 0.09, thr + 0.09, uNight);
            totalEmissiveRadiance *= emissiveColor.rgb * on;
          #endif`);
      };
      const mats = {
        concrete: wall('concrete'),
        concrete_white: wall('concrete', { color: 0xf1efe9 }),
        trim: wall('concrete', { color: 0xdedcd4, roughness: 0.85 }),
        kerb: mk('concrete', { color: 0xb0aca3 }),
        brick: wall('brick', { normalScale: new THREE.Vector2(1.3, 1.3) }),
        brick_red: wall('brick', { color: 0xd8695a, normalScale: new THREE.Vector2(1.3, 1.3) }),
        brick_buff: wall('brick_yellow', { normalScale: new THREE.Vector2(1.2, 1.2) }),
        steel: wall('steel', { color: 0xdadde0, metalness: 0.3 }),
        plates: wall('plates', { color: 0xcfd3d6, metalness: 0.25 }),
        membrane: mk('gravel', { color: 0x36373a, roughness: 0.95, normalScale: new THREE.Vector2(0.6, 0.6) }),
        gravel: mk('gravel'),
        gravel_dark: mk('gravel', { color: 0x8c7c64 }),
        dirt: mk('gravel', { color: 0x6e5c46 }),
        paving: mk('paving'),
        asphalt: mk('asphalt', { color: 0xbdb9b2, roughness: 0.95 }),
        asphalt_dark: mk('asphalt', { color: 0x8a8781, roughness: 0.95 }),
        court: mk('asphalt', { color: 0x5f8f6c }),
        lawn: mk('lawn', { color: 0x8aa56a }, mownStripes),
        glass: reg(glass),
        roller: reg(new THREE.MeshStandardMaterial({ map: roller.map, normalMap: roller.normalMap, roughnessMap: roller.roughnessMap, roughness: 1, metalness: 0.35 })),
        louvre: reg(new THREE.MeshStandardMaterial({ map: roller.map, normalMap: roller.normalMap, roughnessMap: roller.roughnessMap, color: 0x55595d, roughness: 1, metalness: 0.4 })),
        hedge: reg(new THREE.MeshStandardMaterial({ map: hedgeT.map, normalMap: hedgeT.normalMap, color: 0x9fb187, roughness: 0.95, metalness: 0, normalScale: new THREE.Vector2(1.6, 1.6) })),
        garbage: reg(new THREE.MeshStandardMaterial({ map: garbage.map, normalMap: garbage.normalMap, roughness: 0.9, metalness: 0 })),
        mesh: reg(new THREE.MeshStandardMaterial({ color: 0x2f3236, roughness: 0.7, metalness: 0.5, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })),
        streak: reg(new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0, transparent: true, opacity: 0.30, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })),
        dark: paint(0x2a2b2e, 0.9, 0.05),
        dark_metal: paint(0x3a3d42, 0.55, 0.55),
        white: paint(0xc8c8c4, 0.75, 0.05),
        wood: paint(0x7a5a3a, 0.85, 0.0),
        coal: paint(0x17181a, 1.0, 0.0),
        sludge: reg(new THREE.MeshStandardMaterial({ color: 0x1b2723, roughness: 0.14, metalness: 0.02 })),
        paint_white: paint(0xe8e8e2, 0.6, 0.05, { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        paint_yellow: paint(0xd9b23a, 0.6, 0.05, { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        paint_police: paint(0x1f3d7a, 0.5, 0.15),
        paint_fire: paint(0xb3261e, 0.5, 0.15),
        paint_water: paint(0xc9d6dc, 0.45, 0.25),
        paint_education: paint(0xd9822b, 0.5, 0.15),
        paint_garbage: paint(0x4d7a2a, 0.6, 0.3),
        // fleet (desaturated, real paint response)
        veh_white: paint(0xd6d7d3, 0.38, 0.25),
        veh_silver: paint(0xa9adb1, 0.32, 0.55),
        veh_grey: paint(0x5f6266, 0.4, 0.35),
        veh_black: paint(0x1c1e22, 0.35, 0.4),
        veh_blue: paint(0x2f4a6e, 0.38, 0.3),
        veh_red_dark: paint(0x7a2a25, 0.38, 0.3),
        veh_fire: paint(0xa8302a, 0.36, 0.3),
        veh_green: paint(0x4f6b3a, 0.45, 0.25),
        veh_yellow: paint(0xc9a23b, 0.5, 0.2),
        veh_police: paint(0x1f3556, 0.4, 0.3),
        veh_glass: paint(0x141c22, 0.12, 0.7),
        tyre: paint(0x1d1e20, 0.95, 0.0),
        veh_marker: reg(new THREE.MeshStandardMaterial({ color: 0x4a0d0a, emissive: 0xff3a1e, emissiveIntensity: 0.0, roughness: 0.35 })),
        veh_reflect: reg(new THREE.MeshStandardMaterial({ map: makeChevron(), emissive: 0xffffff, emissiveMap: makeChevron(), emissiveIntensity: 0.0, roughness: 0.45, metalness: 0.0 })),
        flag: reg(new THREE.MeshStandardMaterial({ map: makeFlag(), roughness: 0.85, side: THREE.DoubleSide })),
        warning: reg(new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 1.0, roughness: 0.4 })),
        siren: reg(new THREE.MeshStandardMaterial({ color: 0x001040, emissive: 0x3060ff, emissiveIntensity: 0.6, roughness: 0.4 })),
        lamp: reg(new THREE.MeshStandardMaterial({ color: 0x8a8a86, emissive: 0xffe2b0, emissiveIntensity: 0.0, roughness: 0.4 })),
        flood: reg(new THREE.MeshStandardMaterial({ color: 0x9a9a98, emissive: 0xfff1d6, emissiveIntensity: 0.0, roughness: 0.3 })),
        pool: new THREE.MeshBasicMaterial({ map: makeLightPool(), color: 0xffcf95, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
      };
      for (const [key, def] of Object.entries(SIGNS)) {
        const s = makeSign(def);
        mats[key] = reg(new THREE.MeshStandardMaterial({ map: s.map, emissiveMap: s.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.1, roughness: 0.55, metalness: 0.05 }));
      }
      this.materials = mats;
      this._dirty = true;
    })();
    return this._loading;
  }

  /** Rebuild the merged meshes from the service list (one mesh per material). */
  rebuild() {
    this._dirty = false;
    if (!this.materials) return;
    const byKey = new Map();
    const push = (key, geo) => { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(geo); };
    const world = this.ctx.world;
    const smoke = [];
    for (const b of this.services.list) {
      const def = SERVICE_TYPES[b.type];
      const recipe = RECIPES[b.type];
      if (!def || !recipe) continue;
      const yaw = b.yaw || 0;
      // terrace level: the flattened lot level (services.place) or the highest pad corner
      const hx = def.w / 2 + 7, hd = def.d / 2 + 7, c = Math.cos(yaw), sn = Math.sin(yaw);
      let y = Number.isFinite(b.y) ? b.y : world.terrain.getHeight(b.x, b.z), lo = y;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const h = world.terrain.getHeight(b.x + sx * hx * c + sz * hd * sn, b.z - sx * hx * sn + sz * hd * c);
        if (!b.flattened && h > y) y = h;
        if (h < lo) lo = h;
      }
      b.y = y;
      const rng = makeRng(hashString(b.id));
      const P = makeBuilder(y - lo);
      recipe(P, def, rng);
      // per-building albedo jitter (warm/cool, ±6 %) baked into the wall vertex colours with base grime
      const tint = [0.94 + rng() * 0.12, 0.94 + rng() * 0.12, 0.94 + rng() * 0.12];
      _q.setFromEuler(_e.set(0, yaw, 0));
      _m.compose(_v.set(b.x, y, b.z), _q, _s);
      for (const { key, geo } of P.list) {
        if (WALL_KEYS.has(key)) bakeGrime(geo, tint);
        geo.applyMatrix4(_m);
        push(key, geo);
      }
      for (const v of P.vehicles) {
        const parts = buildVehicle(v.model, makeRng(hashString(b.id + ':' + v.model + ':' + v.x.toFixed(1) + v.z.toFixed(1))));
        const lm = new THREE.Matrix4().compose(new THREE.Vector3(v.x, 0.02, v.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, v.yaw, 0)), _s);
        lm.premultiply(_m);
        for (const { key, geo } of parts) push(key, geo.applyMatrix4(lm));
      }
      for (const acc of P.access) buildDriveway(push, world, b, acc, _m);
      for (const sm of P.smoke) {
        const p = new THREE.Vector3(sm.x, sm.y, sm.z).applyMatrix4(_m);
        smoke.push({ ...sm, x: p.x, y: p.y, z: p.z });
      }
    }
    for (const mesh of this.meshes.values()) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.meshes.clear();
    for (const [key, geos] of byKey) {
      const mat = this.materials[key] || this.materials.concrete;
      // mergeGeometries needs a uniform attribute set: position/normal/uv (+ color on wall keys)
      const keepColor = !!mat.vertexColors;
      for (const g of geos) {
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv' && !(keepColor && k === 'color')) g.deleteAttribute(k);
        if (keepColor && !g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (!g.attributes.normal) g.computeVertexNormals();
      }
      const indexed = geos.filter((g) => !!g.index).length;
      const list = indexed === geos.length || indexed === 0 ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = mergeGeometries(list, false);
      for (const g of geos) g.dispose();
      if (!merged) { console.warn('[simulation] merge failed for', key); continue; }
      if (mat.aoMap && !merged.attributes.uv1) merged.setAttribute('uv1', merged.attributes.uv);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'services-' + key;
      mesh.castShadow = !NO_SHADOW.has(key);
      mesh.receiveShadow = !NO_AO.has(key);
      if (NO_AO.has(key)) mesh.layers.enable(this.ctx.engine.LAYER_NO_AO ?? 1);
      else mesh.layers.enable(this.ctx.engine.LAYER_REFLECTED ?? 3); // static architecture shows in planar water reflections
      if (key === 'pool') mesh.renderOrder = 6;
      if (key === 'mesh' || key === 'streak') mesh.renderOrder = 4;
      this.group.add(mesh);
      this.meshes.set(key, mesh);
    }
    this._applySmoke(smoke);
  }

  _applySmoke(list) {
    const fx = this.ctx.world.effects && this.ctx.world.effects.api;
    if (!fx || typeof fx.addSource !== 'function') return;
    for (const id of this.smokeIds) fx.removeSource(id);
    this.smokeIds = list.map((s) => fx.addSource({ ...s, id: 'svc-' + this.smokeIds.length + '-' + s.x.toFixed(0) + '-' + s.z.toFixed(0) + '-' + s.kind }));
  }

  update(dt) {
    if (this._dirty) {
      if (!this.materials) this.ensureLoaded();
      else this.rebuild();
    }
    const night = this.ctx.world.env.nightFactor || 0;
    this.nightUniform.value = night;
    if (this.materials) {
      const m = this.materials;
      const soft = smoothstep(0.15, 0.7, night);
      m.lamp.emissiveIntensity = 1.5 * soft;
      m.flood.emissiveIntensity = 1.8 * soft;
      m.warning.emissiveIntensity = 0.6 + 1.6 * night;
      m.siren.emissiveIntensity = 0.5 + 1.0 * night;
      m.veh_marker.emissiveIntensity = 0.15 + 1.05 * soft;   // parked-vehicle marker lamps
      m.veh_reflect.emissiveIntensity = 0.06 + 0.55 * soft;  // retro-reflective chevrons catch the apron lights
      m.pool.opacity = 0.5 * soft;
      const s = 0.1 + 0.8 * soft;
      for (const k in m) if (k.startsWith('sign_')) m[k].emissiveIntensity = s;
      const pool = this.meshes.get('pool');
      if (pool) pool.visible = soft > 0.02;
    }
    this.standins.update();
    this.infoView.update(dt);
  }

  dispose() {
    this._off && this._off();
    this._offInfo && this._offInfo();
    this._offTerrain && this._offTerrain();
    this._offRoads && this._offRoads();
    const fx = this.ctx.world.effects && this.ctx.world.effects.api;
    if (fx) for (const id of this.smokeIds) fx.removeSource(id);
    for (const mesh of this.meshes.values()) { this.group.remove(mesh); mesh.geometry.dispose(); }
    this.ctx.scene.remove(this.group);
    this.standins.dispose();
    this.infoView.dispose();
  }
}

/**
 * Mown stripes: a groundsman mows in alternating directions, so the sward reflects light in
 * 2.4 m bands. World-space so neighbouring lots line up, plus a slow patchiness term that breaks
 * the single flat green the lawn texture alone produces.
 */
function mownStripes(m) {
  m.customProgramCacheKey = () => 'simulation-lawn-v1';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLawnW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLawnW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLawnW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float mowBand = smoothstep(-0.30, 0.30, sin(vLawnW.x * 1.30899694));   // 2.4 m mower width
        float mowPatch = sin(vLawnW.x * 0.083 + 1.7) * sin(vLawnW.z * 0.061 - 0.4);
        diffuseColor.rgb *= mix(0.855, 1.14, mowBand) * (0.965 + 0.055 * mowPatch);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.0, 0.86), 0.35 * smoothstep(0.2, 1.0, mowPatch));
      `);
  };
}

/** Vertex colour = building tint × base grime (dark run-off in the lowest 2.6 m). Local space, pad at y = 0. */
function bakeGrime(geo, tint) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const g = 1 - 0.30 * (1 - smoothstep(0, 2.6, y));
    col[i * 3] = tint[0] * g; col[i * 3 + 1] = tint[1] * g; col[i * 3 + 2] = tint[2] * g;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Quad strip between edge A (a0→a1) and edge B (b0→b1), UVs in metres, y from the points. */
function strip(a0, a1, b0, b1, uvScale = 4, lift = 0) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([a0.x, a0.y + lift, a0.z, a1.x, a1.y + lift, a1.z, b0.x, b0.y + lift, b0.z, b1.x, b1.y + lift, b1.z]);
  const w = a0.distanceTo(a1), len = a0.distanceTo(b0);
  const uv = new Float32Array([0, 0, w / uvScale, 0, 0, len / uvScale, w / uvScale, len / uvScale]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  // keep the strip facing up whatever the winding came out as
  if (g.attributes.normal.getY(0) < 0) { g.setIndex([0, 1, 2, 1, 3, 2]); g.computeVertexNormals(); }
  return g;
}

/**
 * Driveway from a lot access point to the nearest road: asphalt to the sidewalk edge
 * (roads.api.sampleEdge), a sloped drop-kerb across the sidewalk to carriageway level, precast
 * kerb strips on both sides, white edge lines and tyre-wear streaks.
 */
function buildDriveway(push, world, b, acc, m) {
  const roads = world.roads && world.roads.api;
  if (!roads || typeof roads.nearest !== 'function' || typeof roads.sampleEdge !== 'function') return;
  const p = new THREE.Vector3(acc.x, 0, acc.z).applyMatrix4(m);
  const dir = new THREE.Vector3(acc.dx ?? 0, 0, acc.dz ?? 1).transformDirection(m).setY(0).normalize();
  const probe = p.clone().addScaledVector(dir, 10);
  const hit = roads.nearest(probe.x, probe.z, 45) || roads.nearest(p.x, p.z, 45);
  if (!hit || !hit.segment) return;
  const tan = new THREE.Vector3(hit.tangent.x, 0, hit.tangent.z).normalize();
  const nrm = new THREE.Vector3(-tan.z, 0, tan.x); // road normal (+side)
  const side = Math.sign(nrm.dot(new THREE.Vector3(p.x - hit.point.x, 0, p.z - hit.point.z))) || 1;
  const edge = roads.sampleEdge(hit.segment.id, hit.t, side);
  if (!edge) return;
  const E = new THREE.Vector3(edge.x, edge.y, edge.z);
  const toRoad = new THREE.Vector3(E.x - p.x, 0, E.z - p.z);
  const len = toRoad.length();
  if (len < 0.8 || len > 45 || toRoad.dot(dir) <= 0) return;
  const w = acc.w || 7;
  const lat = new THREE.Vector3(-dir.z, 0, dir.x);
  if (tan.dot(lat) < 0) tan.negate();
  const A = p.clone().setY(b.y + 0.135);
  const a0 = A.clone().addScaledVector(lat, -w / 2), a1 = A.clone().addScaledVector(lat, w / 2);
  const b0 = E.clone().addScaledVector(tan, -w / 2), b1 = E.clone().addScaledVector(tan, w / 2);
  b0.y = b1.y = E.y + 0.015;
  push('asphalt', strip(a0, a1, b0, b1, 5));
  // the driveway corridor is paved: clear grass tufts and shrubs off it (terrain already clears
  // the service footprint itself on services:changed, but not the access strip)
  const tapi = world.terrain && world.terrain.api;
  if (tapi && typeof tapi.clearVegetationRect === 'function') {
    const xs = [a0.x, a1.x, b0.x, b1.x], zs = [a0.z, a1.z, b0.z, b1.z];
    try { tapi.clearVegetationRect(Math.min(...xs) - 1.5, Math.min(...zs) - 1.5, Math.max(...xs) + 1.5, Math.max(...zs) + 1.5); } catch (_) { /* optional */ }
  }
  // drop kerb across the sidewalk (sidewalk outer edge → carriageway edge, ~0.2 m lower)
  const type = roads.types && roads.types[hit.segment.type];
  const sw = type && Number.isFinite(type.cwHalf) ? Math.max(0.8, hit.segment.width / 2 - type.cwHalf) : 2.2;
  const inward = nrm.clone().multiplyScalar(-side);
  const c0 = b0.clone().addScaledVector(inward, sw - 0.15), c1 = b1.clone().addScaledVector(inward, sw - 0.15);
  c0.y = c1.y = E.y - 0.19;
  push('asphalt_dark', strip(b0, b1, c0, c1, 5, 0.012));
  // flared kerb strips + white edge lines along the drive
  for (const s of [-1, 1]) {
    const ea = s < 0 ? a0 : a1, eb = s < 0 ? b0 : b1;
    const out = lat.clone().multiplyScalar(s);
    push('kerb', strip(ea.clone().addScaledVector(out, 0.0), ea.clone().addScaledVector(out, 0.32), eb.clone().addScaledVector(tan, s * 0.0), eb.clone().addScaledVector(tan, s * 0.32), 2, 0.055));
    push('paint_white', strip(ea.clone().addScaledVector(out, -0.58), ea.clone().addScaledVector(out, -0.28), eb.clone().addScaledVector(tan, -s * 0.58), eb.clone().addScaledVector(tan, -s * 0.28), 1, 0.045));
  }
  // tyre wear: two darker streaks
  for (const s of [-1, 1]) {
    const o = s * Math.min(1.7, w * 0.22);
    push('streak', strip(A.clone().addScaledVector(lat, o - 0.45), A.clone().addScaledVector(lat, o + 0.45), E.clone().addScaledVector(tan, o - 0.5).setY(E.y + 0.015), E.clone().addScaledVector(tan, o + 0.5).setY(E.y + 0.015), 3, 0.01));
  }
}
