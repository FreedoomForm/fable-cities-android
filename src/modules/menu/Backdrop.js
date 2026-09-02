/**
 * Cinematic backdrop for the start screen.
 *
 * WHY IT IS ITS OWN RENDERER: the menu resolves BEFORE the module loop runs (that is the whole point
 * of §5b — the player's seed has to reach the terrain generator), so terrain / environment / water do
 * not exist yet while the screen is up and there is no world to fly a camera over. Instead the menu
 * flies over *the land the seed will actually produce*: the same analytic generator
 * (terrain/Heightmap.sampleGen) meshed into an aerial vista in a small second WebGL context.
 * Rerolling the seed rebuilds it, so the backdrop IS the seed preview at full size.
 *
 * Three tricks keep it cheap enough that a menu is never the heaviest thing in the app:
 *  - ONE non-uniform mesh. The grid is warped (|u|^3 blended with u), so cells are ~13 m under the
 *    camera and ~120 m at the 9 km rim: near detail plus a covered horizon with no LOD seams.
 *  - Lighting is baked into vertex colours on the CPU — albedo ramp × sun N·L × ray-marched cast
 *    shadows × sky ambient. No lights, no shadow maps, one unlit draw call.
 *  - Water and sky are small hand-written shaders; total ≈ 3 draw calls.
 */
import * as THREE from 'three';

const SUN_AZ = -1.05;          // radians; sun to the west, a little to the south
const SUN_EL = 0.262;          // ~13° — long raking shadows, late afternoon
const WATER_LEVEL = 0;

export class Backdrop {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ reducedMotion?: boolean, tier?: 'low'|'high' }} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.reducedMotion = !!opts.reducedMotion;
    this.tier = opts.tier || 'high';
    this.ok = false;
    this.running = false;
    this.t = 0;
    this._raf = 0;
    this._last = 0;
    this._token = 0;

    this.N = this.tier === 'low' ? 240 : 384;      // mesh resolution (warped grid)
    this.RIM = 9000;                               // half-extent of the meshed vista
    this.CORE = 0.20;                              // fraction of the warp that stays linear
    this.SN = this.tier === 'low' ? 208 : 288;     // uniform grid used for cast shadows
    this.SHALF = 2900;
    this.CX = -120;
    this.CZ = -60;

    this.sun = new THREE.Vector3(
      Math.cos(SUN_EL) * Math.sin(SUN_AZ),
      Math.sin(SUN_EL),
      Math.cos(SUN_EL) * Math.cos(SUN_AZ),
    ).normalize();

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false, powerPreference: 'default' });
    } catch (err) {
      this.renderer = null;
      return;
    }
    if (!this.renderer.getContext()) { this.renderer = null; return; }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.tier === 'low' ? 1 : 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.97;
    this.renderer.setClearColor(0x0a0f15, 1);
    this.ok = true;

    this.scene = new THREE.Scene();
    this.haze = new THREE.Color(0xa9bccb);
    this.scene.fog = new THREE.FogExp2(this.haze.clone(), 0.00026);

    this.camera = new THREE.PerspectiveCamera(38, 1, 5, 40000);
    this._baseFov = 38;

    this._buildSky();
    this._buildHorizonPlate();

    this.terrain = null;
    this.water = null;
    this._onLost = (e) => { e.preventDefault(); this.ok = false; this.stop(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
  }

  // ------------------------------------------------------------------ sky
  _buildSky() {
    const uniforms = {
      uZenith: { value: new THREE.Color(0x2a5c9e) },
      uHorizon: { value: new THREE.Color(0x86aed3) },
      uHaze: { value: this.haze.clone() },
      uSunColor: { value: new THREE.Color(0xffd39c) },
      uSunDir: { value: this.sun.clone() },
      uTime: { value: 0 },
      uCloudY: { value: 2100 },
    };
    this.skyUniforms = uniforms;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = wp.xyz - cameraPosition;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uZenith, uHorizon, uHaze, uSunColor, uSunDir;
        uniform float uTime, uCloudY;

        float h21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.58));
          col = mix(col, uHaze, exp(-max(y, 0.0) * 13.0) * 0.90);
          col = mix(col, uHaze * 0.92, smoothstep(0.0, -0.08, y));

          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 1800.0) * 16.0 + pow(sd, 30.0) * 0.40 + pow(sd, 5.0) * 0.20);

          // flat cloud deck projected onto a plane -> real perspective convergence at the horizon
          if (y > 0.006) {
            float tPlane = (uCloudY - cameraPosition.y) / y;
            vec2 pw = (cameraPosition.xz + d.xz * tPlane) * 0.00040 + vec2(uTime * 0.0032, uTime * 0.0011);
            float f = fbm(pw * 3.0);
            float cov = smoothstep(0.44, 0.80, f) * smoothstep(0.010, 0.15, y) * (1.0 - smoothstep(0.72, 1.0, y) * 0.3);
            float lit = 0.80 + 0.95 * pow(sd, 2.0) + 0.40 * smoothstep(0.45, 0.9, f);
            vec3 cloud = mix(vec3(0.70, 0.74, 0.80), uSunColor * 1.2, 0.45 * pow(sd, 1.3) + 0.14) * lit;
            col = mix(col, cloud, cov * 0.9);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.skyMat = mat;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 20), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
  }

  _buildHorizonPlate() {
    // guarantees no sky leaks under the horizon beyond the meshed vista (fully fogged out there)
    const g = new THREE.CircleGeometry(34000, 48).rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: this.haze.clone(), fog: false });
    this.plate = new THREE.Mesh(g, m);
    this.plate.position.y = -14;
    this.plate.renderOrder = -5;
    this.scene.add(this.plate);
  }

  // ------------------------------------------------------------------ world
  /** Axis of the warped grid: dense in the middle, coarse at the rim, no seams. */
  _axis(centre) {
    const N = this.N, rim = this.RIM, core = this.CORE;
    const a = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1;
      const s = u < 0 ? -1 : 1;
      const au = Math.abs(u);
      a[i] = centre + rim * (core * u + (1 - core) * s * au * au * au);
    }
    return a;
  }

  /**
   * Rebuild the vista for a height source. Yields to the event loop between slices so typing in the
   * seed field never stutters. Safe to call repeatedly; the newest call wins.
   */
  async setSource(source) {
    if (!this.ok) return;
    const token = ++this._token;
    const N = this.N;
    const AX = this._axis(this.CX);
    const AZ = this._axis(this.CZ);

    const H = new Float32Array(N * N);
    for (let j0 = 0; j0 < N; j0 += 24) {
      const jEnd = Math.min(N, j0 + 24);
      for (let j = j0; j < jEnd; j++) {
        const z = AZ[j];
        const row = j * N;
        for (let i = 0; i < N; i++) H[row + i] = source.sample(AX[i], z, 1);
      }
      if (jEnd < N) { await frame(); if (token !== this._token) return; }
    }

    const shadow = await this._bakeShadows(source, token);
    if (token !== this._token || !shadow) return;

    const terrainGeo = this._buildTerrainGeometry(H, AX, AZ, shadow);
    if (token !== this._token) { terrainGeo.dispose(); return; }
    await frame();
    if (token !== this._token) { terrainGeo.dispose(); return; }

    const waterGeo = this._buildWaterGeometry(H, AX, AZ);
    if (token !== this._token) { terrainGeo.dispose(); if (waterGeo) waterGeo.dispose(); return; }

    this._swapTerrain(terrainGeo);
    this._swapWater(waterGeo);
    if (!this.running) this.renderOnce();
  }

  /**
   * Cast shadows on a uniform grid over the area the camera actually sees. Half-resolution march
   * (shadows are soft; nobody can tell) and a bilinear lookup back onto the warped mesh.
   */
  async _bakeShadows(source, token) {
    const M = this.SN;
    const half = this.SHALF;
    const step = (half * 2) / (M - 1);
    const x0 = this.CX - half, z0 = this.CZ - half;
    const G = new Float32Array(M * M);
    for (let j0 = 0; j0 < M; j0 += 32) {
      const jEnd = Math.min(M, j0 + 32);
      for (let j = j0; j < jEnd; j++) {
        const z = z0 + j * step;
        for (let i = 0; i < M; i++) G[j * M + i] = source.sample(x0 + i * step, z, 1);
      }
      if (jEnd < M) { await frame(); if (token !== this._token) return null; }
    }

    const K = M;
    const kStep = step;
    const out = new Float32Array(K * K);
    const sx = this.sun.x, sy = this.sun.y, sz = this.sun.z;
    const STEPS = 24;
    const ts = new Float32Array(STEPS);
    let t = 12;
    for (let s = 0; s < STEPS; s++) { ts[s] = t; t *= 1.235; }
    const look = (x, z) => {
      let fx = (x - x0) / step, fz = (z - z0) / step;
      if (fx < 0) fx = 0; else if (fx > M - 1.001) fx = M - 1.001;
      if (fz < 0) fz = 0; else if (fz > M - 1.001) fz = M - 1.001;
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
      const a = G[j * M + i], b = G[j * M + i + 1], c = G[(j + 1) * M + i], d = G[(j + 1) * M + i + 1];
      return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    };
    for (let j = 0; j < K; j++) {
      const z = z0 + j * kStep;
      for (let i = 0; i < K; i++) {
        const x = x0 + i * kStep;
        const y = look(x, z);
        let occ = 0;
        for (let s = 0; s < STEPS; s++) {
          const tt = ts[s];
          const d = look(x + sx * tt, z + sz * tt) - (y + sy * tt + 1.0);
          if (d > 0) {
            const v = d > 10 ? 1 : d / 10;
            if (v > occ) occ = v;
            if (occ >= 0.995) break;
          }
        }
        out[j * K + i] = 1 - occ * occ * (3 - 2 * occ);
      }
    }
    out.K = K; out.kStep = kStep; out.x0 = x0; out.z0 = z0; out.half = half;
    return out;
  }

  _buildTerrainGeometry(H, AX, AZ, shadow) {
    const N = this.N;
    const count = N * N;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const { K, kStep, x0, z0, half } = shadow;

    const C = (hex) => new THREE.Color(hex);
    const SAND = C(0xc3ad82), GRASS_A = C(0x4a6a2e), GRASS_B = C(0x67813c), DRY = C(0x7e7a4c);
    const ROCK = C(0x585148), ROCK_D = C(0x3a362f), SNOW = C(0xe6edf2), BED = C(0x36412f), DEEP = C(0x16242f);
    const FOREST = C(0x27391c), MEADOW = C(0x87884d);
    const SUN_COL = C(0xffe4c0), SKY_COL = C(0x8fb6e2), BOUNCE = C(0x59653f);
    const tmp = new THREE.Color();
    const sunX = this.sun.x, sunY = this.sun.y, sunZ = this.sun.z;

    for (let j = 0; j < N; j++) {
      const z = AZ[j];
      const dzUp = (j < N - 1 ? AZ[j + 1] : AZ[j]) - (j > 0 ? AZ[j - 1] : AZ[j]);
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = AX[i];
        const h = H[k];
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;

        const dxR = (i < N - 1 ? AX[i + 1] : AX[i]) - (i > 0 ? AX[i - 1] : AX[i]);
        const hl = H[j * N + (i > 0 ? i - 1 : i)];
        const hr = H[j * N + (i < N - 1 ? i + 1 : i)];
        const hd = H[(j > 0 ? j - 1 : j) * N + i];
        const hu = H[(j < N - 1 ? j + 1 : j) * N + i];
        const dx = dxR > 0 ? (hr - hl) / dxR : 0;
        const dz = dzUp > 0 ? (hu - hd) / dzUp : 0;
        const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        const nx = -dx * inv, ny = inv, nz = -dz * inv;
        const slope = 1 - ny;
        // a fake sub-cell normal: the mesh cannot resolve relief under ~10 m, so shade it in instead
        const bx = (vnoise2(x * 0.026 + 11.3, z * 0.026 - 4.1) - 0.5) * 0.30;
        const bz = (vnoise2(x * 0.026 - 19.7, z * 0.026 + 7.9) - 0.5) * 0.30;
        const lInv = 1 / Math.sqrt((dx + bx) * (dx + bx) + (dz + bz) * (dz + bz) + 1);
        const lnx = -(dx + bx) * lInv, lny = lInv, lnz = -(dz + bz) * lInv;

        // ---- albedo ramp: meadow / pasture patchwork, woodland, then altitude
        const vn = vnoise2(x * 0.0042, z * 0.0042);
        const patch = vnoise2(x * 0.0125 + 5.2, z * 0.0125 - 8.8);
        tmp.copy(GRASS_A).lerp(GRASS_B, vn * 0.6 + patch * 0.4);
        tmp.lerp(MEADOW, sstep(0.58, 0.92, patch) * 0.55 * (1 - sstep(0.30, 0.55, slope)));
        // woodland: patches of darker canopy on gentle, low-to-mid ground
        const wood = sstep(0.44, 0.66, vnoise2(x * 0.0090 + 31.7, z * 0.0090 - 12.3) * 0.72
                                     + vnoise2(x * 0.0290, z * 0.0290) * 0.28)
                   * (1 - sstep(0.34, 0.62, slope)) * sstep(2.2, 6.0, h) * (1 - sstep(80, 145, h));
        if (wood > 0.01) tmp.lerp(FOREST, wood * 0.95);
        if (h > 22) tmp.lerp(DRY, sstep(22, 60, h) * 0.38);
        if (h > 48) tmp.lerp(ROCK, sstep(48, 112, h) * 0.92);
        if (slope > 0.20) tmp.lerp(ROCK, sstep(0.22, 0.58, slope));
        if (slope > 0.48) tmp.lerp(ROCK_D, sstep(0.50, 0.86, slope) * 0.85);
        if (h < 4.5) tmp.lerp(SAND, sstep(4.5, 1.0, h) * (1 - sstep(0.32, 0.58, slope)));
        if (h > 155) tmp.lerp(SNOW, sstep(166, 232, h) * (1 - sstep(0.46, 0.78, slope) * 0.92));
        if (h < WATER_LEVEL) {
          tmp.lerp(BED, sstep(0.4, -2.0, h));
          tmp.lerp(DEEP, sstep(-2.0, -16.0, h));
        }

        // ---- baked lighting
        let sh = 1;
        if (Math.abs(x - this.CX) < half && Math.abs(z - this.CZ) < half) {
          let fx = (x - x0) / kStep, fz = (z - z0) / kStep;
          if (fx < 0) fx = 0; else if (fx > K - 1.001) fx = K - 1.001;
          if (fz < 0) fz = 0; else if (fz > K - 1.001) fz = K - 1.001;
          const si = fx | 0, sj = fz | 0, tx = fx - si, tz = fz - sj;
          const a = shadow[sj * K + si], b = shadow[sj * K + si + 1];
          const c = shadow[(sj + 1) * K + si], d = shadow[(sj + 1) * K + si + 1];
          sh = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
        }
        let ndl = lnx * sunX + lny * sunY + lnz * sunZ;
        if (ndl < 0) ndl = 0;
        const sun = 1.95 * ndl * sh;
        const skyAmt = (0.12 + 0.22 * lny) * (0.70 + 0.30 * sh);   // shade also loses sky light
        const bnc = 0.10 * (1 - ny);
        const grain = 0.90 + 0.20 * vnoise2(x * 0.052 + 7.1, z * 0.052 - 3.4);

        col[k * 3] = tmp.r * (SUN_COL.r * sun + SKY_COL.r * skyAmt + BOUNCE.r * bnc) * grain;
        col[k * 3 + 1] = tmp.g * (SUN_COL.g * sun + SKY_COL.g * skyAmt + BOUNCE.g * bnc) * grain;
        col[k * 3 + 2] = tmp.b * (SUN_COL.b * sun + SKY_COL.b * skyAmt + BOUNCE.b * bnc) * grain;
      }
    }

    const idx = new (count > 65535 ? Uint32Array : Uint16Array)((N - 1) * (N - 1) * 6);
    let o = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  _buildWaterGeometry(H, AX, AZ) {
    const N = this.N;
    const pos = [];
    const dep = [];
    const idx = [];
    let v = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
        if (Math.min(a, b, c, d) >= 0.25) continue;
        const xa = AX[i], xb = AX[i + 1], za = AZ[j], zb = AZ[j + 1];
        pos.push(xa, WATER_LEVEL, za, xb, WATER_LEVEL, za, xa, WATER_LEVEL, zb, xb, WATER_LEVEL, zb);
        dep.push(Math.max(0, -a), Math.max(0, -b), Math.max(0, -c), Math.max(0, -d));
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 4;
      }
    }
    if (!v) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    geo.setIndex(v > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.computeBoundingSphere();
    return geo;
  }

  _swapTerrain(geo) {
    if (!this.terrainMat) this.terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    if (this.terrain) { this.terrain.geometry.dispose(); this.terrain.geometry = geo; }
    else { this.terrain = new THREE.Mesh(geo, this.terrainMat); this.terrain.frustumCulled = false; this.scene.add(this.terrain); }
  }

  _swapWater(geo) {
    if (!this.waterMat) {
      this.waterUniforms = {
        uSunDir: { value: this.sun.clone() },
        uSunColor: { value: new THREE.Color(0xffd39c) },
        uSkyTop: { value: new THREE.Color(0x2d5f9c) },
        uSkyHorizon: { value: new THREE.Color(0x9dc0dc) },
        uShallow: { value: new THREE.Color(0x2f6f74) },
        uDeep: { value: new THREE.Color(0x0b2634) },
        uFogColor: { value: this.haze.clone() },
        uFogDensity: { value: this.scene.fog.density },
        uTime: { value: 0 },
      };
      this.waterMat = new THREE.ShaderMaterial({
        uniforms: this.waterUniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */`
          attribute float aDepth;
          varying vec3 vWorld;
          varying float vDepth;
          void main(){
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            vDepth = aDepth;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          varying vec3 vWorld;
          varying float vDepth;
          uniform vec3 uSunDir, uSunColor, uSkyTop, uSkyHorizon, uShallow, uDeep, uFogColor;
          uniform float uTime, uFogDensity;
          void main(){
            vec3 V = normalize(cameraPosition - vWorld);
            vec2 p = vWorld.xz;
            float w1 = sin(p.x * 0.029 + p.y * 0.016 + uTime * 0.55);
            float w2 = sin(p.x * -0.018 + p.y * 0.041 + uTime * 0.41);
            float w3 = sin(p.x * 0.083 - p.y * 0.058 + uTime * 0.95);
            vec3 Nn = normalize(vec3(0.05 * (w1 + 0.55 * w3), 1.0, 0.05 * (w2 - 0.55 * w3)));

            float fres = 0.025 + 0.975 * pow(1.0 - clamp(dot(Nn, V), 0.0, 1.0), 5.0);
            vec3 R = reflect(-V, Nn);
            vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.5));

            float sdot = max(dot(R, uSunDir), 0.0);
            float spec = pow(sdot, 300.0) * 7.0 + pow(sdot, 26.0) * 0.35;

            vec3 body = mix(uShallow, uDeep, smoothstep(0.5, 12.0, vDepth));
            vec3 col = mix(body, sky, fres) + uSunColor * spec;

            float foam = (1.0 - smoothstep(0.0, 1.2, vDepth)) * 0.45;
            col = mix(col, vec3(0.80, 0.85, 0.88), foam);

            float dist = length(cameraPosition - vWorld);
            float fogF = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
            col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

            gl_FragColor = vec4(col, mix(0.82, 0.97, smoothstep(0.0, 3.0, vDepth)));
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
    }
    if (this.water) {
      this.water.geometry.dispose();
      if (geo) { this.water.geometry = geo; this.water.visible = true; }
      else this.water.visible = false;
    } else if (geo) {
      this.water = new THREE.Mesh(geo, this.waterMat);
      this.water.frustumCulled = false;
      this.water.renderOrder = 2;
      this.scene.add(this.water);
    }
  }

  // ------------------------------------------------------------------ camera + loop
  _updateCamera() {
    const t = this.reducedMotion ? 8 : this.t;
    const yaw = -0.26 + t * 0.0060;
    const pitch = 0.188 + 0.012 * Math.sin(t * 0.043);
    const dist = 1020 + 90 * Math.sin(t * 0.030 + 1.2) - t * 1.1;
    const tx = -190 + 22 * Math.sin(t * 0.021);
    const tz = -240 + 16 * Math.cos(t * 0.026);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this.camera.position.set(tx + Math.sin(yaw) * cp * dist, 46 + sp * dist, tz + Math.cos(yaw) * cp * dist);
    this.camera.lookAt(tx, 42, tz);
    this.sky.position.copy(this.camera.position);
    this.plate.position.set(this.camera.position.x, -14, this.camera.position.z);
  }

  resize() {
    if (!this.ok) return;
    const w = Math.max(2, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // keep the horizontal field of view constant so a portrait phone does not zoom in
    const base = this._baseFov * Math.PI / 180;
    const refAspect = 16 / 9;
    // widen only as far as 54° vertical: a portrait phone gets a tall crop of the same vista
    // rather than a fisheye of mostly sky.
    this.camera.fov = aspect >= refAspect
      ? this._baseFov
      : Math.min(54, 2 * Math.atan(Math.tan(base / 2) * (refAspect / aspect)) * 180 / Math.PI);
    this.camera.updateProjectionMatrix();
    if (!this.running) this.renderOnce();
  }

  renderOnce() {
    if (!this.ok || !this.terrain) return;
    this._updateCamera();
    this.skyUniforms.uTime.value = this.t;
    if (this.waterUniforms) this.waterUniforms.uTime.value = this.t;
    try { this.renderer.render(this.scene, this.camera); } catch (err) { this.ok = false; }
  }

  start() {
    if (!this.ok || this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - this._last < 24) return;             // soft 40 fps cap — a menu must stay cheap
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (document.hidden) return;
      if (!this.reducedMotion) this.t += dt;
      this.renderOnce();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  dispose() {
    this.stop();
    this._token++;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    for (const m of [this.terrain, this.water, this.sky, this.plate]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    this.terrain = this.water = this.sky = this.plate = null;
    if (this.renderer) {
      this.renderer.dispose();
      try { this.renderer.forceContextLoss(); } catch (e) { /* not fatal */ }
      this.renderer = null;
    }
    this.ok = false;
  }
}

/** Cheap deterministic value noise in [0,1] — albedo detail only, never geometry. */
function hash21(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function vnoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash21(xi, yi), b = hash21(xi + 1, yi), c = hash21(xi, yi + 1), d = hash21(xi + 1, yi + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function sstep(a, b, v) {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
function frame() {
  return new Promise((r) => setTimeout(r, 0));
}
