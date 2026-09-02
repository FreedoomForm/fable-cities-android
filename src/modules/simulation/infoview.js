/**
 * Coverage info view (Cities: Skylines style, one service at a time): a terrain-draped shader plane
 * grades the *developed* area on a three-stop ramp — crimson where the city is built but the service
 * cannot reach (hatched, strong), amber at the thin edge of the radius, the service's own colour as a
 * whisper (≤ 12 % alpha) where it is fully served — so colour encodes magnitude instead of painting
 * the map one alarming tone. Undeveloped countryside stays untouched. One crisp radius ring with a
 * soft glow is drawn per facility, the stand-in massing is tinted by coverage and the world is gently
 * desaturated through the effects grading. Emits `infoview:changed { view, legend, … }` for the UI.
 * 'all' / 'utilities' show the composite (weakest service) with a boundary line instead of rings.
 */
import * as THREE from 'three';
import { SERVICE_IDS, SERVICE_TYPES, UTILITY_IDS } from './services.js';
import { smoothstep } from '../../shared/math.js';

const MAX_RINGS = 48;
const SD_RANGE = 240; // metres of distance ramp encoded in the G channel
const VS = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const FS = /* glsl */`
  precision highp float;
  uniform sampler2D tex;
  uniform vec3 colCovered;
  uniform vec3 colWarn;
  uniform vec3 colBad;
  uniform vec3 colRing;
  uniform vec4 rings[${MAX_RINGS}];   // x, z, radius, weight
  uniform int ringCount;
  uniform float edgeLine;             // 1 = draw the composite boundary line (no rings)
  uniform float dim;
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_fragment>
  void main() {
    vec4 s = texture2D(tex, vUv);
    float c = s.r;            // coverage 0..1 (strain-scaled)
    float sdn = s.g;          // 0.5 at the coverage boundary, < 0.5 outside
    float dev = s.b;          // developed-area mask (blurred)
    float devM = smoothstep(0.05, 0.34, dev);
    float strength = smoothstep(0.02, 0.85, c);

    // Three-stop ramp: crimson (no service) → amber (thin) → the service colour (fully served).
    vec3 col = mix(colBad, colWarn, smoothstep(0.0, 0.34, strength));
    col = mix(col, colCovered, smoothstep(0.30, 0.88, strength));

    // Served land gets a whisper of colour; land the city has built on but the service cannot
    // reach gets a strong warning wash, hatched so the gap reads as a gap and not as a tint.
    float aServed = (0.040 + 0.080 * strength) * devM;
    float gap = 1.0 - smoothstep(0.02, 0.32, strength);
    float hatch = smoothstep(0.42, 0.58, fract((vWorld.x + vWorld.z) * 0.055));
    float aGap = gap * devM * 0.38 * (0.62 + 0.38 * hatch);
    float a = max(aServed, aGap);

    // boundary line for composite views
    float edge = (1.0 - smoothstep(0.0, 0.018, abs(sdn - 0.5))) * edgeLine;
    col = mix(col, vec3(1.0), edge * 0.55);
    a = max(a, edge * 0.5);

    // one crisp anti-aliased ring per facility of the selected type, with a soft outer glow
    float ring = 0.0, glow = 0.0;
    for (int i = 0; i < ${MAX_RINGS}; i++) {
      if (i >= ringCount) break;
      vec4 r = rings[i];
      float d = abs(length(vWorld.xz - r.xy) - r.z);
      float w = fwidth(d) * 1.8 + 1.6;
      ring = max(ring, (1.0 - smoothstep(0.0, w, d)) * r.w);
      glow = max(glow, exp(-d * 0.045) * r.w);
    }
    col = mix(col, colRing, max(ring * 0.92, glow * 0.35));
    a = max(a, ring * 0.92 + glow * 0.16);

    gl_FragColor = vec4(col * dim, a * mix(1.0, 0.6, 1.0 - dim));
    #include <fog_fragment>
  }
`;

export class InfoViewOverlay {
  constructor(ctx, services, standins = null) {
    this.ctx = ctx;
    this.services = services;
    this.standins = standins;
    this.type = null;
    this.mesh = null;
    this._dirty = true;
    this._frame = 0;
    this._lastB = -1;
    this._lastR = -1;
    this._rings = [];
    this._prevSaturation = null;
    const n = services.n * 2; // 8 m texels
    this.n2 = n;
    this.data = new Uint8Array(n * n * 4);
    this.texture = new THREE.DataTexture(this.data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        tex: { value: null },
        colCovered: { value: new THREE.Color(0x35d38a).convertSRGBToLinear() },
        colWarn: { value: new THREE.Color(0xe8a33d).convertSRGBToLinear() },
        colBad: { value: new THREE.Color(0xd6392c).convertSRGBToLinear() },
        colRing: { value: new THREE.Color(0xf2f8ff).convertSRGBToLinear() },
        rings: { value: Array.from({ length: MAX_RINGS }, () => new THREE.Vector4()) },
        ringCount: { value: 0 },
        edgeLine: { value: 0 },
        dim: { value: 1 },
      }]),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.material.uniforms.tex.value = this.texture;
  }

  markDirty() { this._dirty = true; }

  /** The types a view resolves to; single services get rings, composites get the boundary line. */
  typesFor(type) { return type === 'all' ? SERVICE_IDS : type === 'utilities' ? UTILITY_IDS : type ? [type] : []; }

  setType(type) {
    const was = !!this.type;
    this.type = type;
    if (!type) {
      if (this.mesh) this.mesh.visible = false;
      if (was) this._setDesaturate(false);
      if (this.standins) this.standins.setCoverage(null);
      this._emit(null);
      return;
    }
    if (!this.mesh) this._buildMesh();
    this.mesh.visible = true;
    if (!was) this._setDesaturate(true);
    const def = SERVICE_TYPES[type];
    const cov = new THREE.Color(def ? def.color : 0x35d38a);
    if (cov.r + cov.g + cov.b > 2.6) cov.set(0x35d38a);  // white services (health) → green
    if (!def) cov.set(0x35d38a);
    this._color = cov;
    this.material.uniforms.colCovered.value.copy(cov).convertSRGBToLinear();
    this.material.uniforms.colRing.value.copy(cov).lerp(new THREE.Color(0xffffff), 0.42).convertSRGBToLinear();
    this.material.uniforms.edgeLine.value = def ? 0 : 1;
    this._dirty = true;
    this._emit(type);
  }

  /** Legend payload for the UI (and any module that tints by info view). */
  legend(type) {
    if (!type) return null;
    const def = SERVICE_TYPES[type];
    const name = def ? def.name : type === 'utilities' ? 'Utilities' : 'All services';
    const hex = '#' + (this._color || new THREE.Color(0x35d38a)).getHexString();
    return {
      title: `${name} coverage`,
      desc: def ? def.description : 'Weakest service at each location. Dark blocks lack at least one service.',
      low: 'Not reached', high: 'Fully served',
      stops: ['#d6392c', '#e8a33d', hex],
      unit: '%',
      stat: def ? 'coverage.' + type : 'coverage',
      facilities: this.typesFor(type).reduce((n, t) => n + this.services.counts[t], 0),
    };
  }
  _emit(type) {
    this.ctx.events.emit('infoview:changed', { view: type, buildings: true, terrain: true, source: 'simulation', legend: this.legend(type) });
  }

  /** CS2 greys the world out under an info view; we do it through the effects grading if present. */
  _setDesaturate(on) {
    const fx = this.ctx.world.effects && this.ctx.world.effects.api;
    if (!fx || !fx.grading) return;
    if (on) {
      if (this._prevSaturation == null) this._prevSaturation = fx.grading.saturation;
      fx.grading.saturation = 0.55;
    } else if (this._prevSaturation != null) {
      fx.grading.saturation = this._prevSaturation;
      this._prevSaturation = null;
    }
  }

  _buildMesh() {
    const { world, scene } = this.ctx;
    const seg = 160;   // drape resolution: 12.8 m at world.size 2048, 51 k triangles
    const geo = new THREE.PlaneGeometry(world.size, world.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'services-infoview';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.enable(this.ctx.engine.LAYER_NO_AO ?? 1);
    scene.add(this.mesh);
    this._drape();
  }

  _drape() {
    const t = this.ctx.world.terrain;
    const pos = this.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, t.getHeight(pos.getX(i), pos.getZ(i)) + 0.45);
    pos.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this._drapedReady = t.ready;
  }

  /** Bake coverage (R), boundary distance (G) and developed-area mask (B) at 8 m. */
  _bake() {
    this._dirty = false;
    const svc = this.services;
    const n = this.n2, res = svc.res / 2;
    const half = this.ctx.world.half;
    const data = this.data;
    const types = this.typesFor(this.type);
    const bList = svc.list.filter((b) => types.includes(b.type));
    const dev = new Float32Array(n * n);
    const mark = (x, z, r) => {
      const i0 = Math.max(0, Math.floor((x - r + half) / res)), i1 = Math.min(n - 1, Math.floor((x + r + half) / res));
      const j0 = Math.max(0, Math.floor((z - r + half) / res)), j1 = Math.min(n - 1, Math.floor((z + r + half) / res));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = -half + (i + 0.5) * res - x, cz = -half + (j + 0.5) * res - z;
        const d2 = cx * cx + cz * cz;
        if (d2 <= r * r) dev[j * n + i] = Math.max(dev[j * n + i], 1 - Math.pow(d2 / (r * r), 3) * 0.6);
      }
    };
    const world = this.ctx.world;
    for (const b of world.buildings.list || []) if (b && Number.isFinite(b.x)) mark(b.x, b.z, 44);
    if (this.standins && this.standins.list) for (const b of this.standins.list) mark(b.x, b.z, Math.max(b.w, b.d) * 0.8 + 6);
    for (const b of svc.list) mark(b.x, b.z, Math.max(b.w, b.d) + 10);
    if (world.roads.segments) for (const s of world.roads.segments.values()) {
      const pts = s.points;
      if (!pts) continue;
      const step = Math.max(1, Math.floor(pts.length / 16));
      for (let i = 0; i < pts.length; i += step) mark(pts[i].x, pts[i].z, 30);
    }
    if (this._extraDeveloped) for (const p of this._extraDeveloped) mark(p.x, p.z, p.r || 40);
    // 2-pass 5-tap box blur on the mask
    const tmp = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const ii = i + k; if (ii >= 0 && ii < n) { s += dev[j * n + ii]; c++; } }
      tmp[j * n + i] = s / c;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const jj = j + k; if (jj >= 0 && jj < n) { s += tmp[jj * n + i]; c++; } }
      dev[j * n + i] = s / c;
    }
    // signed distance to the coverage boundary: per type the nearest facility edge, composite = worst type
    const byType = types.map((t) => svc.list.filter((b) => b.type === t));
    for (let j = 0; j < n; j++) {
      const cz = -half + (j + 0.5) * res;
      for (let i = 0; i < n; i++) {
        const cx = -half + (i + 0.5) * res;
        let c = types.length ? 1 : 0, sd = -Infinity;
        for (let k = 0; k < types.length; k++) {
          const t = types[k];
          const v = svc.rawCoverageAt(cx, cz, t) * svc.strain[t];
          if (v < c) c = v;
          let dMin = Infinity;
          for (const b of byType[k]) { const d = Math.hypot(cx - b.x, cz - b.z) - b.radius; if (d < dMin) dMin = d; }
          if (dMin > sd) sd = dMin;
        }
        if (!Number.isFinite(sd)) sd = SD_RANGE;
        const kk = (j * n + i) * 4;
        data[kk] = Math.round(Math.min(1, c) * 255);
        data[kk + 1] = Math.round(Math.max(0, Math.min(1, 0.5 - sd / (2 * SD_RANGE))) * 255);
        data[kk + 2] = Math.round(Math.min(1, dev[j * n + i]) * 255);
        data[kk + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
    const single = types.length === 1;
    this._rings = single ? bList.slice(0, MAX_RINGS).map((b) => ({ x: b.x, z: b.z, r: b.radius })) : [];
    this.material.uniforms.ringCount.value = this._rings.length;
    this._lastB = world.buildings.version;
    this._lastR = world.roads.version;
    this._updateRings(true);
    if (this.standins) this.standins.setCoverage((x, z) => {
      let c = 1;
      for (const t of types) { const v = svc.rawCoverageAt(x, z, t) * svc.strain[t]; if (v < c) c = v; }
      return types.length ? c : 0;
    }, this._color);
  }

  /** Rings fade with distance from the camera target and vanish when far larger than the view. */
  _updateRings(force = false) {
    const cc = this.ctx.cameraController;
    if (!cc) return;
    const camD = Math.max(20, cc.distance || 400);
    const tx = cc.target ? cc.target.x : 0, tz = cc.target ? cc.target.z : 0;
    const key = Math.round(camD) + ':' + Math.round(tx / 8) + ':' + Math.round(tz / 8);
    if (!force && key === this._ringKey) return;
    this._ringKey = key;
    const ru = this.material.uniforms.rings.value;
    for (let i = 0; i < this._rings.length; i++) {
      const r = this._rings[i];
      const dist = Math.hypot(r.x - tx, r.z - tz);
      let w = 1 - smoothstep(1.6, 3.0, r.r / camD);
      w *= 1 - smoothstep(camD * 1.6, camD * 3.2, Math.max(0, dist - r.r));
      ru[i].set(r.x, r.z, r.r, w);
    }
  }

  setExtraDeveloped(points) { this._extraDeveloped = points; this._dirty = true; }

  update() {
    if (!this.type || !this.mesh || !this.mesh.visible) return;
    this._frame++;
    const world = this.ctx.world;
    this.material.uniforms.dim.value = 1 - 0.8 * (world.env.nightFactor || 0);
    if (!this._drapedReady && world.terrain.ready) this._drape();
    if (this._frame % 30 === 0 && (world.buildings.version !== this._lastB || world.roads.version !== this._lastR)) this._dirty = true;
    if (this._dirty) this._bake();
    if (this._frame % 4 === 0) this._updateRings();
  }

  dispose() {
    this._setDesaturate(false);
    if (this.mesh) { this.ctx.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.material.dispose();
    this.texture.dispose();
  }
}
