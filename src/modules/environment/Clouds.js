/**
 * Volumetric cloud layer: a ray-marched spherical shell (see CLOUD_FRAGMENT) fed by a baked
 * 64³ Perlin-Worley shape texture and a tileable 2D weather map. Deterministic per seed.
 */
import * as THREE from 'three';
import { TileablePerlin3D, TileableWorley3D, TileablePerlin2D, remap, clamp01 } from './proceduralNoise.js';
import { CLOUD_VERTEX, CLOUD_FRAGMENT } from './shaders.js';

const NOISE_SIZE = 64;
const WEATHER_SIZE = 256;

export function buildCloudNoiseTexture(seed) {
  const N = NOISE_SIZE;
  const perlin = new TileablePerlin3D(seed ^ 0x51ab, 4);
  const w1 = new TileableWorley3D(seed ^ 0x1001, 4);
  const w2 = new TileableWorley3D(seed ^ 0x1002, 8);
  const w3 = new TileableWorley3D(seed ^ 0x1003, 16);
  const w4 = new TileableWorley3D(seed ^ 0x1004, 32);
  const data = new Uint8Array(N * N * N * 4);
  let i = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N, v = (y + 0.5) / N, w = (z + 0.5) / N;
        // perlin fbm at 4/8/16 cells across the tile
        const p = perlin.fbm(u * 4, v * 4, w * 4, 3, 4);
        const a = w1.sample(u, v, w), b = w2.sample(u, v, w), c = w3.sample(u, v, w), d = w4.sample(u, v, w);
        const worleyFbm = a * 0.625 + b * 0.25 + c * 0.125;
        // Perlin-Worley: dilate perlin by worley (Schneider)
        const pw = clamp01(remap(p, 0, 1, worleyFbm, 1));
        data[i++] = Math.round(clamp01(pw) * 255);
        data[i++] = Math.round(clamp01(b) * 255);
        data[i++] = Math.round(clamp01(c) * 255);
        data[i++] = Math.round(clamp01(d) * 255);
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearMipmapLinearFilter; // explicit LOD in the shader (textureLod) removes far-field aliasing
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export function buildWeatherTexture(seed) {
  const N = WEATHER_SIZE;
  const n1 = new TileablePerlin2D(seed ^ 0x7e01, 4);
  const n2 = new TileablePerlin2D(seed ^ 0x7e02, 8);
  const data = new Uint8Array(N * N * 4);
  const raw = new Float32Array(N * N);
  const mids = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N;
      // coverage field: broad fbm plus mid-frequency structure so cloud fields have fronts and gaps
      const big = n1.fbm(u * 4, v * 4, 5, 4);
      const mid = n2.fbm(u * 8, v * 8, 3, 8);
      raw[y * N + x] = big * 0.72 + mid * 0.28;
      mids[y * N + x] = mid;
    }
  }
  // rank-equalise → uniform distribution, so a coverage threshold of (1 - c) covers exactly c of the sky
  const order = Array.from(raw.keys()).sort((a, b) => raw[a] - raw[b]);
  const rank = new Float32Array(N * N);
  for (let i = 0; i < order.length; i++) rank[order[i]] = (i + 0.5) / order.length;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N;
      const i = y * N + x;
      const type = clamp01(remap(n2.fbm(u * 8 + 0.31, v * 8 + 0.77, 3, 8), 0.3, 0.7, 0, 1));
      data[i * 4] = Math.round(rank[i] * 255);
      data[i * 4 + 1] = Math.round(type * 255);
      data[i * 4 + 2] = Math.round(mids[i] * 255);
      data[i * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // no mipmaps: the map is sampled inside the divergent ray-march loop, where implicit-LOD texture() gets undefined
  // derivatives and picks a different mip per quad half (2-row 'scanline' stripes across the whole deck); one texel
  // is 86 m, never minified at the distances the shell is visible
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 2D cirrus sheet: R = fibrous streak noise (ridged fbm), G = broad patches; both rank-equalised, tileable. */
export function buildCirrusTexture(seed) {
  const N = 256;
  const fine = new TileablePerlin2D(seed ^ 0x2c11, 6);
  const broad = new TileablePerlin2D(seed ^ 0x2c12, 2);
  const r = new Float32Array(N * N), g = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N;
      // ridged: fibres where the fbm crosses its midline; a second octave set adds finer strands
      const a = 1 - Math.abs(2 * fine.fbm(u * 6, v * 6, 4, 6) - 1);
      const b = 1 - Math.abs(2 * fine.fbm(u * 6 + 0.37, v * 6 + 0.11, 5, 6, 0.6) - 1);
      const soft = fine.fbm(u * 6 + 0.71, v * 6 + 0.29, 3, 6);
      // fibres (ridged) blended with a soft fbm so the veil has filaments without knife-edge streaks
      r[y * N + x] = clamp01(Math.pow(clamp01(a * 0.6 + b * 0.4), 1.25) * 0.55 + soft * 0.45);
      g[y * N + x] = broad.fbm(u * 2, v * 2, 3, 2);
    }
  }
  const equalise = (arr) => {
    const order = Array.from(arr.keys()).sort((i, j) => arr[i] - arr[j]);
    const out = new Float32Array(arr.length);
    for (let i = 0; i < order.length; i++) out[order[i]] = (i + 0.5) / order.length;
    return out;
  };
  const rq = equalise(r), gq = equalise(g);
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(rq[i] * 255);
    data[i * 4 + 1] = Math.round(gq[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter; // sampled after the divergent loop, but keep the LOD explicit-free as well
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class CloudLayer {
  constructor({ seed, quality }) {
    this.noise = buildCloudNoiseTexture(seed);
    this.weather = buildWeatherTexture(seed);
    this.cirrus = buildCirrusTexture(seed);
    const steps = { low: 14, medium: 22, high: 32, ultra: 40 }[quality?.name] ?? 32;
    const lightSteps = { low: 3, medium: 4, high: 5, ultra: 6 }[quality?.name] ?? 5;
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientTop: { value: new THREE.Color(0.3, 0.4, 0.6) },
      uAmbientBottom: { value: new THREE.Color(0.15, 0.18, 0.25) },
      uAmbientSunSide: { value: new THREE.Color(0, 0, 0) },
      uHazeColor: { value: new THREE.Color(0.6, 0.7, 0.85) },
      uHazeDensity: { value: 0.00003 },
      uCoverage: { value: 0.3 },
      uCloudType: { value: 0.7 },
      uDensity: { value: 0.04 },
      uPrecip: { value: 0 },
      uCloudBase: { value: 1000 },
      uCloudTop: { value: 3350 },
      uCurvatureRadius: { value: 2.4e6 },
      uWindOffset: { value: new THREE.Vector3() },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uTime: { value: 0 },
      uEnvMode: { value: 0 },
      uSteps: { value: steps },
      uLightSteps: { value: lightSteps },
      uNoise: { value: this.noise },
      uWeather: { value: this.weather },
      uWeatherScale: { value: 22000 },
      uBaseScale: { value: 5600 },
      uDetailScale: { value: 1050 },
      uCirrus: { value: this.cirrus },
      uCirrusCover: { value: 0.4 },
      uCirrusAlt: { value: 7200 },
      uCirrusScale: { value: 30000 },
      uHistory: { value: null },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uHistoryWeight: { value: 0 },
      uFrame: { value: 0 },
      uPixelAngle: { value: 0.0015 }, // radians per render-target pixel (mip selection)
      uDebug: { value: 0 },
      uScatterGain: { value: 2.6 },
      uBaseJitter: { value: 0.24 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'env-clouds',
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      premultipliedAlpha: true,
      fog: false,
      lights: false,
    });
    const geo = new THREE.SphereGeometry(1, 24, 12);
    // ray-march mesh: rendered off-screen at reduced resolution (smooths the march noise, ~4x cheaper)
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'env-clouds-raymarch';
    this.mesh.scale.setScalar(9000);
    this.mesh.frustumCulled = false;
    this.offscreenScene = new THREE.Scene();
    this.offscreenScene.add(this.mesh);
    // exact 1/2 of the drawing buffer: an irrational magnification beats against the texel grid and turns the
    // residual temporal noise into row/column moire (the r0 'dashed stripes'); 1:2 reconstructs cleanly
    this.resolutionScale = { low: 1 / 3, medium: 0.5, high: 0.75, ultra: 1.0 }[quality?.name] ?? 0.75;
    this.targets = [null, null]; // ping-pong: [write, history]
    this.target = null;
    this.targetSize = new THREE.Vector2();
    this.historyValid = false;
    this.historyWeight = 0.94;
    this._rotView = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    // composite mesh in the main scene: same dome at the far plane (depth test hides covered pixels)
    this.compositeUniforms = {
      uTex: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2(1, 1) },
    };
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'env-clouds-composite',
      glslVersion: THREE.GLSL3,
      uniforms: this.compositeUniforms,
      vertexShader: CLOUD_VERTEX,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        out vec4 fragColor;
        uniform sampler2D uTex;
        uniform vec2 uResolution;
        uniform vec2 uTexel;
        void main() {
          vec2 uv = gl_FragCoord.xy / uResolution;
          // Gaussian reconstruction in render-target texel space (sigma 0.75 texel, 4x4 texel-centred taps): a
          // smooth magnification with no grid beat, and no edge-aware weighting that would turn residual
          // temporal noise into worms along the (horizontally coherent) far deck
          vec2 tc = uv / uTexel - 0.5;
          vec2 base = floor(tc);
          vec2 f = tc - base;
          vec4 c = vec4(0.0);
          float wsum = 0.0;
          for (int j = -1; j <= 2; j++) {
            for (int i = -1; i <= 2; i++) {
              vec2 d = vec2(float(i), float(j)) - f;
              float w = exp(-dot(d, d) / (2.0 * 0.52 * 0.52));
              c += texture2D(uTex, (base + vec2(float(i), float(j)) + 0.5) * uTexel) * w;
              wsum += w;
            }
          }
          c /= wsum;
          if (c.a < 0.002) discard;
          fragColor = c;
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      premultipliedAlpha: true,
      fog: false,
      lights: false,
    });
    this.compositeMesh = new THREE.Mesh(geo, this.compositeMaterial);
    this.compositeMesh.name = 'env-clouds';
    this.compositeMesh.scale.setScalar(9000);
    this.compositeMesh.frustumCulled = false;
    this.compositeMesh.renderOrder = -900; // first among transparents
    this.compositeMesh.castShadow = false;
    this.compositeMesh.receiveShadow = false;
    // twin for the reflection probe scene (shares material/uniforms, full ray march at probe resolution)
    this.probeMesh = new THREE.Mesh(geo, this.material);
    this.probeMesh.name = 'env-clouds-probe';
    this.probeMesh.scale.setScalar(9000);
    this.probeMesh.frustumCulled = false;
    this.probeMesh.renderOrder = -900;
    this._size = new THREE.Vector2();
    this._clear = new THREE.Color(0, 0, 0);
    this._dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._dummy.needsUpdate = true;
    this.uniforms.uHistory.value = this._dummy;
  }

  /** Drop the temporal history (time / weather jumps): the next frame starts from scratch. */
  resetHistory() {
    this.historyValid = false;
  }

  /** Ray-march the clouds into the reduced-resolution target from the main camera. Call once per frame before the scene renders. */
  renderOffscreen(renderer, camera) {
    renderer.getDrawingBufferSize(this._size);
    const w = Math.max(2, Math.round(this._size.x * this.resolutionScale));
    const h = Math.max(2, Math.round(this._size.y * this.resolutionScale));
    let write = this.targets[0];
    const history = this.targets[1]; // may have another size (resize) — reprojection samples it in normalised uv, so it stays valid
    if (!write || write.width !== w || write.height !== h) {
      if (write) write.dispose();
      write = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      write.texture.name = 'env-clouds-rt';
    }
    this.targetSize.set(w, h);
    const u = this.uniforms;
    u.uPixelAngle.value = (camera.fov * Math.PI / 180) / h;
    const useHistory = this.historyValid && history;
    u.uHistory.value = useHistory ? history.texture : this._dummy; // never bind the write target (feedback loop)
    u.uHistoryWeight.value = useHistory ? this.historyWeight : 0;
    u.uFrame.value = (u.uFrame.value + 1) % 1024;
    this.compositeUniforms.uResolution.value.copy(this._size);
    this.compositeUniforms.uTexel.value.set(1 / w, 1 / h);
    this.mesh.position.copy(camera.position);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clear);
    renderer.setRenderTarget(write);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, false, false);
    renderer.render(this.offscreenScene, camera);
    renderer.setClearColor(this._clear, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    // this frame's rotation-only view-projection becomes next frame's reprojection matrix
    this._rotView.extractRotation(camera.matrixWorld).invert();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, this._rotView);
    u.uPrevViewProj.value.copy(this._viewProj);
    // swap: the freshly written buffer is what the composite shows and next frame's history
    this.targets[0] = history;
    this.targets[1] = write;
    this.target = write;
    this.compositeUniforms.uTex.value = write.texture;
    this.historyValid = true;
  }
  setVisible(v) {
    this.compositeMesh.visible = v;
    this.probeMesh.visible = v;
  }
  dispose() {
    this.noise.dispose();
    this.weather.dispose();
    this.cirrus.dispose();
    this.material.dispose();
    this.compositeMaterial.dispose();
    for (const t of this.targets) if (t) t.dispose();
    this.mesh.geometry.dispose();
  }
}
