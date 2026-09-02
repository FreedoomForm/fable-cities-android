/**
 * GPU ring-buffer puff system: industrial smoke, steam, house chimney smoke, construction dust.
 *
 * All motion is evaluated in the vertex shader from static per-particle attributes and `uTime`;
 * the CPU only touches uniforms per frame. Particles loop: age = fract(t / life + phase) * life,
 * so a plume is in steady state from frame 0 and never needs re-spawning.
 *
 * Rendered by EffectsPass (not the main scene): depthTest is OFF and occlusion + soft edges come
 * entirely from the sampled scene depth of the current frame (`tDepth`). The base quad's `position`
 * attribute is all zeros (corners live in `aCorner`) so the mesh is degenerate under any override
 * material.
 *
 * Plume model (round 3): puffs are born at ≈ 0.6 stack diameters and stay TIGHT AND OPAQUE for the first
 * third of their life (delayed growth curve + optical-mass conservation), so the column has a dense,
 * self-shadowed body at the mouth, then blooms and dissolves into haze — the plume ends instead of roping
 * on. Per-kind optical density (`dens`) drives the terminator width, the core self-shadow, how much sky
 * light the medium swallows and how fast the soot albedo pales with age: industrial reads as grey-brown
 * lit volume, steam as thin white vapour. The turbulence is keyed on the
 * EMISSION time (uTime − age), so puffs released together travel together: the column meanders as one
 * body (real plume behaviour) rather than every sprite wandering on its own. Wind entrainment is slow
 * (τ 3.5 s) so the plume stays attached to the stack.
 * Lighting: the atlas RGB is a lobe pseudo-normal; smoke is lit by the dominant celestial light (sun by
 * day, moon by night) with a terminator per lobe (sun side / shadow side), forward-scatter transmission
 * and a silhouette rim pow(1 − n·v, 3) when backlit, by sky radiance as a thick multiple-scattering medium,
 * by ground bounce, and by up to 4 LOCAL point lights (floodlights, street lights — nearest to the camera,
 * chosen on the CPU). Dust (kind 1) hugs the ground: tan, sun-lit, emitted in gusts, densest near the
 * ground, thinning as it lifts; it is faded out by `uDustFade` while it rains.
 */
import * as THREE from 'three';

export const MAX_LOCAL_LIGHTS = 4;

export const DEPTH_PARS = /* glsl */ `
uniform sampler2D tDepth;
uniform float uHasDepth;
uniform vec2 uResolution;
uniform vec2 uNearFar;
#include <packing>
float effectsSceneViewZ() {
  float d = texture2D(tDepth, gl_FragCoord.xy / uResolution).x;
  return perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
}
`;

const VERT = /* glsl */ `
precision highp float;
attribute vec2 aCorner;
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aParam;   // phase, life, size0, size1
attribute vec4 aStyle;   // spriteIdx, rotSpeed, buoyancy, drag
attribute vec4 aColor;   // albedo rgb, opacity
attribute vec2 aKind;    // x: 0 smoke/steam, 1 dust — y: optical density (0 thin steam … 1 thick soot)

uniform float uTime;
uniform vec3 uWind;      // world wind velocity (m/s) at plume height
uniform vec2 uAtlas;     // cols, rows
uniform vec2 uFade;      // distance fade start, end
uniform float uSizeBoost;
uniform float uDustFade; // 1 dry … 0 raining (dust is knocked down by rain)

varying vec2 vUv;
varying vec4 vColor;     // albedo + alpha
varying vec3 vRot;       // cos, sin of billboard rotation, mirror sign
varying float vViewZ;
varying vec3 vViewPos;   // view-space position of the billboard centre
varying float vSoft;
varying float vAge;
varying float vKind;
varying float vDens;
varying float vNear;

#include <fog_pars_vertex>

void main() {
  float phase = aParam.x;
  float life = aParam.y;
  float t = fract(uTime / life + phase) * life;
  float u = t / life;
  float dust = step(0.5, aKind.x);

  // drag-limited initial velocity
  float k = max(aStyle.w, 0.02);
  vec3 p = aOrigin + aVel * (1.0 - exp(-k * t)) / k;
  // buoyancy: accelerates then settles to a terminal rise (negative for dust: settles back down)
  p.y += aStyle.z * t * min(t, 4.0) * 0.5;
  if (dust > 0.5) p.y = max(p.y, aOrigin.y + 0.15);
  // wind entrainment: velocity approaches wind speed with tau = 3.5 s (dust stays low: half the wind)
  float tau = 3.5 - 1.5 * dust;
  p += uWind * (t - tau * (1.0 - exp(-t / tau))) * (1.0 - 0.5 * dust);
  // coherent turbulence: keyed on the EMISSION time so puffs born together meander together (one column
  // that snakes, not 250 sprites wandering) + a small per-puff jitter that grows with age
  float eh = aOrigin.x * 0.37 + aOrigin.z * 0.71 + aOrigin.y * 0.13;
  float te = uTime - t;
  float rise = min(t, 8.0);
  p += vec3(sin(te * 0.55 + eh) + 0.5 * sin(te * 1.35 + eh * 1.7), 0.0, cos(te * 0.43 + eh * 1.3) + 0.5 * cos(te * 1.1 + eh * 0.6)) * rise * (0.16 - 0.06 * dust);
  float sp = phase * 43.7;
  float tb = min(t, 6.0) * (0.09 + 0.10 * dust);
  p += vec3(sin(t * 1.31 + sp), sin(t * 0.83 + sp * 1.7) * 0.6 * (1.0 - 0.6 * dust), cos(t * 1.07 + sp * 0.6)) * tb;

  // growth: the puff leaves the mouth at ~0.6 stack diameters and STAYS tight for the first third of its
  // life (the dense, opaque column), then blooms as it entrains air — pow() delays the widening
  float grow = pow(1.0 - exp(-t / (life * 0.34)), 0.92);
  float size = mix(aParam.z, aParam.w, grow) * uSizeBoost;
  float ang = aStyle.y * t + phase * 6.2831853;
  float c = cos(ang), s = sin(ang);
  float mirror = fract(phase * 17.31) < 0.5 ? -1.0 : 1.0;
  vRot = vec3(c, s, mirror);

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  float dist = -mvPosition.z;
  vViewPos = mvPosition.xyz;
  // keep far plumes readable: grow slightly with distance, then fade out
  size *= 1.0 + dist * 0.0008;
  vec2 corner = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * size * 0.5;
  mvPosition.xy += corner;

  // optical mass conservation: a puff that grows N× in diameter thins out
  float conserve = pow(aParam.z / max(mix(aParam.z, aParam.w, grow), 1e-3), 0.56);
  float fadeIn = smoothstep(0.0, 0.02, u);
  // the plume must END: after ~60 % of the life the puff dissolves into haze instead of roping on
  float fadeOut = pow(1.0 - u, 1.35) * exp(-0.75 * u);
  float distFade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
  float nearFade = smoothstep(1.5, 6.0, dist);
  // dust: densest close to the ground, thinning as it lifts, gone in rain
  float lift = 1.0 - 0.55 * dust * clamp((p.y - aOrigin.y) / 4.0, 0.0, 1.0);
  float rainOff = mix(1.0, uDustFade, dust);
  vColor = vec4(aColor.rgb, aColor.a * fadeIn * fadeOut * conserve * distFade * nearFade * lift * rainOff);

  float col = mod(aStyle.x, uAtlas.x);
  float row = floor(aStyle.x / uAtlas.x);
  vUv = (vec2(col, row) + vec2(aCorner.x * mirror, aCorner.y) * 0.5 + 0.5) / uAtlas;
  vViewZ = mvPosition.z;
  vSoft = mix(0.7, 4.0, u) * (0.5 + 0.5 * size / max(aParam.w, 1e-3));
  vAge = u;
  vKind = aKind.x;
  vDens = aKind.y;
  vNear = 1.0 - smoothstep(6.0, 22.0, dist);

  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlasTex;
uniform vec3 uLightDirView;  // direction light travels (view space) — sun by day, moon by night
uniform vec3 uLightColor;    // radiance scale of that light
uniform vec3 uAmbient;       // sky radiance reaching the plume
uniform vec3 uGroundBounce;  // ground radiance from below
uniform vec4 uLocalPos[${MAX_LOCAL_LIGHTS}];    // view-space xyz, range
uniform vec3 uLocalColor[${MAX_LOCAL_LIGHTS}];  // colour × intensity (cd)
uniform int uLocalCount;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vRot;
varying float vViewZ;
varying vec3 vViewPos;
varying float vSoft;
varying float vAge;
varying float vKind;
varying float vDens;
varying float vNear;

#include <fog_pars_fragment>
${DEPTH_PARS}

void main() {
  vec4 tex = texture2D(uAtlasTex, vUv);
  float alpha = tex.a * vColor.a;
  // occlusion + soft edge against the real scene depth (depthTest is off)
  if (uHasDepth > 0.5) {
    float dz = vViewZ - effectsSceneViewZ();      // > 0 when the particle is in front of the scene
    alpha *= clamp(dz / vSoft, 0.0, 1.0);
  }
  if (alpha < 0.003) discard;

  // lobe pseudo-normal, mirrored + rotated with the billboard
  vec3 n = tex.rgb * 2.0 - 1.0;
  n.x *= vRot.z;
  n.xy = vec2(n.x * vRot.x - n.y * vRot.y, n.x * vRot.y + n.y * vRot.x);
  n = normalize(n);
  vec3 viewDir = normalize(-vViewPos);
  vec3 L = -uLightDirView;
  float ndl = dot(n, L);
  // terminator on every lobe: a hard-ish lit side and a shadow side. Dense (sooty) smoke has a narrow
  // wrap and a dark shadow side; thin steam wraps almost all the way round (strong multiple scattering).
  float wrap = mix(0.55, 0.16, vDens);
  float lit = mix(0.34, 0.05, vDens) + (1.0 - mix(0.34, 0.05, vDens)) * smoothstep(-wrap, wrap + 0.30, ndl);
  // forward scattering: looking towards the light through the thin fringe — backlit plumes glow at sunset
  float vl = max(dot(viewDir, -L), 0.0);
  float thin = 1.0 - tex.a * 0.75;
  float forward = pow(vl, 8.0) * thin * (1.6 + 0.6 * vKind);
  // silhouette rim pow(1 − n·v, 3): the fringe of every puff lights up when the light is behind it
  float ndv = max(dot(n, viewDir), 0.0);
  float rim = pow(1.0 - ndv, 3.0) * smoothstep(0.1, 0.95, vl) * 1.3 * (0.5 + 0.5 * thin);
  // self-shadowing: the dense young core is much darker than the fringe — this is what makes an
  // industrial plume read as a lit VOLUME with an opaque body instead of a white airbrush smear
  float core = 1.0 - (0.22 + 0.62 * vDens + 0.10 * vKind) * tex.a * (1.0 - vAge * 0.55);
  // thick medium: sky light arrives from all sides (slight top bias), ground bounce from below.
  // A dense plume swallows most of the sky light; steam is almost pure multiple scattering.
  vec3 sky = uAmbient * (0.82 + 0.18 * n.y) * (1.0 - 0.72 * vDens) + uGroundBounce * (0.30 - 0.22 * n.y);
  vec3 light = sky * core + uLightColor * (lit * core + forward + rim);
  // local lights (floodlights, street lamps): inverse-square with a smooth range cutoff
  for (int i = 0; i < ${MAX_LOCAL_LIGHTS}; i++) {
    if (i >= uLocalCount) break;
    vec3 toL = uLocalPos[i].xyz - vViewPos;
    float d2 = dot(toL, toL);
    float d = sqrt(d2);
    float range = uLocalPos[i].w;
    float win = clamp(1.0 - d / range, 0.0, 1.0);
    float att = win * win / (d2 + 1.0);
    vec3 Ld = toL / max(d, 1e-3);
    float w = dot(n, Ld) * 0.5 + 0.5;
    light += uLocalColor[i] * att * (w * w * core + 0.25);
  }
  // soot dilutes as the plume entrains air: a young puff is dark grey-brown, an old one pale haze
  vec3 albedo = vColor.rgb * (0.85 + 0.55 * vAge * vDens);
  vec3 col = albedo * light;

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

/** Emitter kind presets (all sizes in metres, times in seconds). */
export const PUFF_KINDS = {
  // Industrial: SOOT. Born at ~0.6 stack diameters, opaque for the first seconds, blooming to ~4.5 m and
  // dissolving inside ~9 s so the plume terminates in haze instead of roping across the map. `dens` = 1
  // → a hard terminator, a dark self-shadowed core and a grey-brown albedo that pales as it disperses.
  industrial: { count: 360, life: [6.5, 12], rise: [3.4, 4.8], lateral: 0.34, size: [1.45, 7.6], albedo: [0.295, 0.276, 0.252], opacity: 1.0, drag: 0.22, buoyancy: 0.10, rot: 0.12, jitter: 0.26, sprites: [0, 16], dens: 1.0 },
  // Steam: white, thin, wraps light almost fully, gone in a few seconds
  steam: { count: 90, life: [2.2, 4.2], rise: [3.0, 4.2], lateral: 0.28, size: [0.55, 4.2], albedo: [0.90, 0.91, 0.94], opacity: 0.46, drag: 0.7, buoyancy: 0.1, rot: 0.3, jitter: 0.22, sprites: [0, 16], dens: 0.18 },
  chimney: { count: 110, life: [3.6, 7.0], rise: [1.7, 2.6], lateral: 0.18, size: [0.34, 3.6], albedo: [0.415, 0.402, 0.386], opacity: 0.88, drag: 0.55, buoyancy: 0.06, rot: 0.3, jitter: 0.14, sprites: [0, 16], dens: 0.80 },
  // tan, sun-lit, ground-hugging gusts at the footprint edges — readable from the 235 m hero distance
  dust: { count: 150, life: [2.6, 5.5], rise: [0.35, 1.0], lateral: 1.5, size: [1.5, 4.6], albedo: [0.55, 0.455, 0.325], opacity: 0.62, drag: 1.0, buoyancy: -0.05, rot: 0.2, jitter: 1.0, sprites: [0, 16], kind: 1, bursts: 5, dens: 0.72 },
  exhaust: { count: 14, life: [1.0, 1.8], rise: [0.6, 1], lateral: 0.4, size: [0.18, 1.0], albedo: [0.42, 0.41, 0.40], opacity: 0.34, drag: 1.5, buoyancy: 0.02, rot: 0.4, jitter: 0.13, sprites: [0, 16], dens: 0.8 },
};

export class SmokeSystem {
  /**
   * @param {{atlas:{texture:THREE.Texture,cols:number,rows:number}, maxParticles:number, name?:string}} opts
   */
  constructor({ atlas, maxParticles, name = 'effects-smoke' }) {
    this.max = maxParticles;
    this.count = 0;
    const geo = new THREE.InstancedBufferGeometry();
    // degenerate base quad (see header) — corners come from aCorner
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.origin = new Float32Array(maxParticles * 3);
    this.vel = new Float32Array(maxParticles * 3);
    this.param = new Float32Array(maxParticles * 4);
    this.style = new Float32Array(maxParticles * 4);
    this.color = new Float32Array(maxParticles * 4);
    this.kind = new Float32Array(maxParticles * 2);
    const mk = (arr, n) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    geo.setAttribute('aOrigin', mk(this.origin, 3));
    geo.setAttribute('aVel', mk(this.vel, 3));
    geo.setAttribute('aParam', mk(this.param, 4));
    geo.setAttribute('aStyle', mk(this.style, 4));
    geo.setAttribute('aColor', mk(this.color, 4));
    geo.setAttribute('aKind', mk(this.kind, 2));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      uAtlas: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
      uAtlasTex: { value: null },
      uFade: { value: new THREE.Vector2(700, 1100) },
      uSizeBoost: { value: 1 },
      uDustFade: { value: 1 },
      uLightDirView: { value: new THREE.Vector3(0, -1, 0) },
      uLightColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.3, 0.3, 0.3) },
      uGroundBounce: { value: new THREE.Color(0.1, 0.1, 0.1) },
      uLocalPos: { value: Array.from({ length: MAX_LOCAL_LIGHTS }, () => new THREE.Vector4(0, 0, 0, 1)) },
      uLocalColor: { value: Array.from({ length: MAX_LOCAL_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
      uLocalCount: { value: 0 },
      tDepth: { value: null },
      uHasDepth: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(1, 15000) },
    }]);
    // UniformsUtils.merge clones the texture ref away; set explicitly
    this.uniforms.uAtlasTex.value = atlas.texture;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,          // occlusion comes from the sampled scene depth (EffectsPass)
      blending: THREE.NormalBlending,
      fog: true,
      lights: false,
      name,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 900;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Puffs an emitter asks for (before the global budget scale). */
  static countFor(e) {
    const k = PUFF_KINDS[e.kind] || PUFF_KINDS.industrial;
    const scale = e.scale ?? 1;
    return Math.max(1, Math.round(k.count * Math.pow(scale, 1.3) * (e.density ?? 1)));
  }

  /** Rebuild all particles from a list of emitters. Cheap enough to call on every building change (debounced). */
  build(emitters, rng) {
    // global budget: when a big city asks for more puffs than the buffer holds, every emitter is thinned
    // by the same factor (opacity compensated) instead of the last emitters getting nothing
    let want = 0;
    for (const e of emitters) want += SmokeSystem.countFor(e);
    const budget = want > this.max ? this.max / want : 1;
    let i = 0;
    const o = this.origin, v = this.vel, p = this.param, s = this.style, c = this.color, kd = this.kind;
    for (const e of emitters) {
      const k = PUFF_KINDS[e.kind] || PUFF_KINDS.industrial;
      const scale = e.scale ?? 1;
      // a big stack visibly dominates: more puffs, bigger, rising faster and living longer
      const n = Math.max(1, Math.round(SmokeSystem.countFor(e) * budget));
      const sizeK = Math.pow(scale, 0.6);
      const bursts = k.bursts || 0;
      const opacityK = Math.min(1.6, 1 / Math.sqrt(budget));
      for (let j = 0; j < n && i < this.max; j++, i++) {
        // spawn jitter: dust spawns on the footprint perimeter, others in a small disc (stack mouth)
        let ox = e.x, oy = e.y, oz = e.z;
        if (e.rect) {
          const { w, d, yaw } = e.rect;
          const side = rng.int(0, 3);
          const t = rng() * 2 - 1;
          let lx = side === 0 ? t * w * 0.5 : side === 1 ? t * w * 0.5 : side === 2 ? w * 0.5 : -w * 0.5;
          let lz = side === 0 ? d * 0.5 : side === 1 ? -d * 0.5 : t * d * 0.5;
          const cy = Math.cos(yaw), sy = Math.sin(yaw);
          ox += lx * cy - lz * sy;
          oz += lx * sy + lz * cy;
        } else {
          const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * k.jitter * Math.sqrt(scale);
          ox += Math.cos(a) * r; oz += Math.sin(a) * r;
        }
        o[i * 3] = ox; o[i * 3 + 1] = oy; o[i * 3 + 2] = oz;
        const rise = rng.range(k.rise[0], k.rise[1]) * (0.65 + 0.35 * scale);
        const la = rng() * Math.PI * 2, lr = k.lateral * (0.3 + rng() * 0.7);
        let vx = Math.cos(la) * lr, vz = Math.sin(la) * lr;
        if (e.rect) { // dust: push outwards from the centre
          const dx = ox - e.x, dz = oz - e.z, l = Math.hypot(dx, dz) || 1;
          vx += (dx / l) * k.lateral * 0.8; vz += (dz / l) * k.lateral * 0.8;
        }
        v[i * 3] = vx; v[i * 3 + 1] = rise; v[i * 3 + 2] = vz;
        const life = rng.range(k.life[0], k.life[1]) * rng.range(0.85, 1.25) * (0.8 + 0.2 * scale);
        // bursts (dust): phases cluster into a few groups so puffs come off the machinery in gusts
        p[i * 4] = bursts ? (rng.int(0, bursts - 1) + rng() * 0.22) / bursts : rng();
        p[i * 4 + 1] = life;
        p[i * 4 + 2] = k.size[0] * sizeK * rng.range(0.75, 1.25);
        p[i * 4 + 3] = k.size[1] * sizeK * rng.range(0.7, 1.35);
        s[i * 4] = rng.int(k.sprites[0], k.sprites[1] - 1);
        s[i * 4 + 1] = (rng() < 0.5 ? -1 : 1) * k.rot * rng.range(0.5, 1.2);
        s[i * 4 + 2] = k.buoyancy * scale;
        s[i * 4 + 3] = k.drag;
        const tint = 0.92 + rng() * 0.16;
        const alb = e.albedo || k.albedo;
        c[i * 4] = alb[0] * tint; c[i * 4 + 1] = alb[1] * tint; c[i * 4 + 2] = alb[2] * tint;
        c[i * 4 + 3] = Math.min(1, (e.opacity ?? k.opacity) * rng.range(0.8, 1.15) * opacityK);
        kd[i * 2] = k.kind || 0;
        kd[i * 2 + 1] = e.dens ?? k.dens ?? 1;
      }
      if (i >= this.max) break;
    }
    this.count = i;
    this.geometry.instanceCount = i;
    this.mesh.visible = i > 0;
    for (const name of ['aOrigin', 'aVel', 'aParam', 'aStyle', 'aColor', 'aKind']) {
      this.geometry.getAttribute(name).needsUpdate = true;
    }
    return i;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
