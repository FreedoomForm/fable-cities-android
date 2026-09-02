/**
 * GroundFXPass — one depth-driven fullscreen pass that supplies the four things the blind judges said
 * were missing from every frame, all from the scene colour + depth the RenderPass already produced:
 *
 *  1. **Wet-surface reflections (screen-space).** On up-facing surfaces, while it is wet, the reflected
 *     ray is marched against the depth buffer and the scene colour is fetched at the hit — so a wet road
 *     really carries the lamp posts, lit windows, vehicles and neon above it as vertical smears. This is
 *     the "CS2 wet roads are dark mirrors" note: the material hook darkens the albedo and drops the
 *     roughness, this pass supplies the actual image in the mirror. Where the ray leaves the screen the
 *     sky colour is used instead, so there is never a hole.
 *  2. **Contact shadows.** A short screen-space ray march toward the sun (≤ 1.6 m) darkens the pixels a
 *     vehicle, kerb, pole or bench occludes — the "firm contact shadow under every prop" the references
 *     have and the cascaded shadow map is too coarse to resolve.
 *  3. **Fine ambient occlusion.** An 8-tap hemisphere SSAO at a 0.45 m radius: the engine's GTAO runs at
 *     2.2 m, which is a massing term. This one tucks darkness into the crease where an object meets the
 *     ground, under eaves, kerbs and guardrails.
 *  4. **Aerial perspective.** Distance haze that *lifts blacks toward the sky colour* and desaturates,
 *     rather than multiplying — LOOK_TARGET rows 11/12 (far third 2.15x brighter than the near third and
 *     carrying only 35-52 % of its contrast).
 *
 * Everything is masked so it cannot touch the sky (depth ≥ 1) and the reflections reject saturated green
 * (vegetation never becomes a mirror). Cost is one fullscreen pass; the two ray marches are branched out
 * on their strength so a dry daytime frame pays for the AO taps only.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FX_NOISE_GLSL } from './wetGlsl.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float uHasDepth;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform mat4 uView;
uniform vec3 uUpView;        // world up in view space
uniform vec3 uSunView;       // direction TOWARD the sun, view space
uniform float uTime;

uniform vec2 uContact;       // strength, length (m)
uniform vec2 uAO;            // strength, radius (m)
uniform float uWet;          // 0 dry … 1 soaked
uniform float uReflect;      // reflection strength multiplier
uniform vec3 uSkyColor;      // fallback reflected radiance (renderer units)
uniform vec4 uAerial;        // density (1/m), desaturation, lift, unused
uniform vec3 uHaze;          // haze colour (renderer units)
uniform float uRipple;       // rain intensity → wobble in the mirror
uniform vec3 uHorizon;       // ndc y of the horizon, falloff, strength (night light-pollution glow)
uniform vec3 uGlowColor;
uniform vec2 uOcclusion;     // occlusion strength, cool sky-bounce fraction
uniform sampler2D uPoolMap;  // world-space drainage map from PuddleField (R pool, G tyre band, B corridor)
uniform vec4 uPoolXf;        // originX, originZ, 1/spanMetres, hasMap

varying vec2 vUv;
${FX_NOISE_GLSL}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** (pool, tyre band, road corridor) at a world XZ; 0 outside the mapped area. */
vec3 drainage(vec2 xz) {
  if (uPoolXf.w < 0.5) return vec3(0.0);
  vec2 uv = (xz - uPoolXf.xy) * uPoolXf.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  return texture2D(uPoolMap, uv).rgb;
}
float rawDepth(vec2 uv) { return texture2D(tDepth, uv).x; }
float viewZ(float d) { return perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y); }   // negative
vec3 viewPos(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = uProjInv * ndc;
  return p.xyz / p.w;
}
/** view → (uv, ndc depth 0..1) */
vec3 project(vec3 v) {
  vec4 c = uProj * vec4(v, 1.0);
  vec3 n = c.xyz / max(abs(c.w), 1e-6) * sign(c.w);
  return vec3(n.xy * 0.5 + 0.5, n.z * 0.5 + 0.5);
}

void main() {
  vec4 src = texture2D(tDiffuse, vUv);
  vec3 c = src.rgb;
  if (uHasDepth < 0.5) { gl_FragColor = vec4(c, src.a); return; }

  float d0 = rawDepth(vUv);
  if (d0 >= 0.99999) {
    // sky: only the night light-pollution band above the horizon (this shader replaces the old copy step)
    if (uHorizon.z > 0.0001) {
      float dy = (vUv.y * 2.0 - 1.0) - uHorizon.x;
      float band = exp(-max(dy, 0.0) * uHorizon.y) * smoothstep(-0.10, 0.0, dy);
      c += uGlowColor * (luma(c) * 1.4 + 0.0012) * band * uHorizon.z;
    }
    gl_FragColor = vec4(c, src.a);
    return;
  }

  vec2 texel = 1.0 / uResolution;
  vec3 P = viewPos(vUv, d0);
  float dist = length(P);
  vec3 V = P / max(dist, 1e-4);                                       // camera → surface

  // ---- normal from depth (pick the smaller of the two one-sided differences on each axis) ----
  vec3 dxP = viewPos(vUv + vec2(texel.x, 0.0), rawDepth(vUv + vec2(texel.x, 0.0))) - P;
  vec3 dxM = P - viewPos(vUv - vec2(texel.x, 0.0), rawDepth(vUv - vec2(texel.x, 0.0)));
  vec3 dyP = viewPos(vUv + vec2(0.0, texel.y), rawDepth(vUv + vec2(0.0, texel.y))) - P;
  vec3 dyM = P - viewPos(vUv - vec2(0.0, texel.y), rawDepth(vUv - vec2(0.0, texel.y)));
  vec3 ddx = abs(dxP.z) < abs(dxM.z) ? dxP : dxM;
  vec3 ddy = abs(dyP.z) < abs(dyM.z) ? dyP : dyM;
  vec3 N = normalize(cross(ddx, ddy));
  if (dot(N, V) > 0.0) N = -N;

  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  // ---------------- fine ambient occlusion (0.4-0.6 m: kerbs, eaves, object bases) ----------------
  float ao = 1.0;
  if (uAO.x > 0.001) {
    float r = uAO.y;
    float occ = 0.0;
    // 8 fixed hemisphere directions; the only per-pixel variation is a 2x2 Bayer rotation INSIDE one
    // sector, so the term is essentially noise-free (a white-noise rotation reads as dirt on the lens)
    float bay = mod(floor(gl_FragCoord.x), 2.0) + 2.0 * mod(floor(gl_FragCoord.y), 2.0);
    float a0 = bay * 0.19634954;
    for (int i = 0; i < 8; i++) {
      float a = a0 + float(i) * 0.7853982;
      float rad = r * (0.30 + 0.70 * fract(float(i) * 0.37 + bay * 0.25));
      vec3 t = normalize(abs(N.z) < 0.9 ? cross(N, vec3(0.0, 0.0, 1.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
      vec3 b = cross(N, t);
      vec3 dir = normalize(t * cos(a) + b * sin(a) + N * 0.55);
      vec3 sp = P + dir * rad;
      vec3 pr = project(sp);
      if (pr.x < 0.0 || pr.x > 1.0 || pr.y < 0.0 || pr.y > 1.0) continue;
      float sz = viewZ(rawDepth(pr.xy));
      float dz = sz - sp.z;                       // > 0 → the scene is in front of the sample
      float range = smoothstep(0.0, 1.0, r / max(abs(sz - P.z), 1e-3));
      occ += step(0.02, dz) * range;
    }
    ao = 1.0 - uAO.x * (occ / 8.0);
    ao = clamp(mix(1.0, ao, 1.0 - smoothstep(140.0, 460.0, dist)), 0.0, 1.0);
  }

  // ---------------- contact shadow (short march toward the sun) ----------------
  float shadow = 1.0;
  if (uContact.x > 0.001) {
    float len = uContact.y * (1.0 + smoothstep(20.0, 220.0, dist) * 2.2);   // keep it readable at range
    float stepLen = len / 12.0;
    vec3 O = P + N * (0.012 + dist * 0.0025);
    float hit = 0.0;
    for (int i = 1; i <= 12; i++) {
      vec3 sp = O + uSunView * (stepLen * (float(i) - 0.5 + dither * 0.9));
      vec3 pr = project(sp);
      if (pr.x < 0.0 || pr.x > 1.0 || pr.y < 0.0 || pr.y > 1.0) break;
      float sz = viewZ(rawDepth(pr.xy));
      float dz = sz - sp.z;
      float bias = 0.03 + abs(sp.z) * 0.004;
      if (dz > bias && dz < bias + 1.6) { hit = 1.0 - (float(i) - 1.0) / 12.0 * 0.35; break; }
    }
    shadow = 1.0 - uContact.x * hit * (1.0 - smoothstep(120.0, 380.0, dist));
  }

  float shade = min(ao, shadow);
  // Occlusion is an AMBIENT term, and in daylight the ambient IS the sky. Multiplying it toward black is
  // what turned every object base into a hole (20-36 % of the frame clipped to RGB(0,0,0)); instead the
  // occluded fraction is replaced by a dim, COOL sky bounce. The crease then reads deeper *and* bluer
  // than the lit surface, which is LOOK_TARGET row 13 (CS2 shadows measure 1.3-2.2x bluer per unit red;
  // ours measured 0.35-0.65 — the wrong way round).
  float occ = (1.0 - shade) * uOcclusion.x;
  c = c * (1.0 - occ) + uSkyColor * (luma(c) + 0.0015) * occ * uOcclusion.y;

  // ---------------- wet reflections ----------------
  float up = dot(N, uUpView);
  float flat_ = smoothstep(0.80, 0.96, up);
  float lum = luma(c);
  float green = (c.g - max(c.r, c.b)) / max(lum, 1e-3);
  float notGreen = 1.0 - smoothstep(0.06, 0.22, green);                 // grass never becomes a mirror
  float wetMask = uWet * flat_ * notGreen * uReflect;
  if (wetMask > 0.004 && dist < 700.0) {
    vec3 W = (uViewInv * vec4(P, 1.0)).xyz;
    float rim;
    // On the road the pools are real geometry (PuddleField.js) and the drainage map says exactly where
    // they are, so the mirror sharpens on the water and stays a soft smear on the damp tarmac beside it.
    // Off the mapped area the old world-noise field still supplies pavement / forecourt pools.
    vec3 drain = drainage(W.xz);
    float poolMap = smoothstep(0.12, 0.55, drain.r) * smoothstep(0.10, 0.45, uWet);
    float offRoad = 1.0 - smoothstep(0.25, 0.65, drain.b);
    float pool = max(poolMap, fxPuddleMask(W.xz, uWet, rim) * offRoad);
    // ripples / micro-relief: plain damp tarmac wobbles the mirror (long vertical light smears),
    // a pool is nearly flat so it reflects sharply
    float rough = mix(0.85, 0.16, pool);
    vec2 g = vec2(
      fxValueNoise(W.xz * 1.7 + vec2(uTime * 0.05, 0.0)) - fxValueNoise(W.xz * 1.7 + vec2(0.3 + uTime * 0.05, 0.0)),
      fxValueNoise(W.xz * 1.7 + vec2(0.0, uTime * 0.05)) - fxValueNoise(W.xz * 1.7 + vec2(0.0, 0.3 + uTime * 0.05)));
    g += vec2(fxValueNoise(W.xz * 1.45) - 0.5, fxValueNoise(W.xz * 1.45 + 31.0) - 0.5) * (0.30 + 0.5 * uRipple);
    float NdV = clamp(-dot(N, V), 0.0, 1.0);
    float F = 0.028 + 0.972 * pow(1.0 - NdV, 4.5);
    // world-space tilt → view space: long, soft vertical smears on damp tarmac, a clean mirror in a pool.
    // The wobble is scaled by NdV: at grazing angles a 2° tilt moves the reflected sample tens of metres,
    // which turns the mirror into per-pixel speckle.
    vec3 tilt = mat3(uView) * vec3(g.x, 0.0, g.y);
    float wob = rough * 0.05 * (0.16 + 0.84 * NdV) * (1.0 - smoothstep(60.0, 200.0, dist));
    vec3 R = reflect(V, normalize(N + tilt * wob));

    // what a MISSED ray sees: near-horizontal rays look at the horizon haze, steep ones at the sky.
    // Using the zenith colour for everything is what turns a grazing wet road into a white sheet.
    vec3 Rw = mat3(uViewInv) * reflect(V, N);
    vec3 miss = mix(uHaze, uSkyColor, smoothstep(0.03, 0.40, Rw.y)) * 0.75;
    vec3 refl = miss;
    float conf = 0.0;
    if (R.z < 0.35) {                                   // ray not flying straight at the camera
      float t = 0.30 + dist * 0.010;
      vec3 prev = P;
      for (int i = 0; i < 22; i++) {
        vec3 sp = P + R * t;
        vec3 pr = project(sp);
        if (pr.x < -0.02 || pr.x > 1.02 || pr.y < -0.02 || pr.y > 1.02 || sp.z > -uNearFar.x) break;
        float sd = rawDepth(clamp(pr.xy, vec2(0.0), vec2(1.0)));
        float sz = viewZ(sd);
        float dz = sz - sp.z;
        float thick = min(0.55 + t * 0.22, 5.5);
        // a grazing ray skims its own surface for tens of metres: the minimum accepted gap has to grow
        // with the march distance or the road reflects ITSELF as a huge smeared ghost
        float minDz = 0.06 + t * 0.035;
        if (dz > minDz && dz < thick && sd < 0.99999) {
          // one bisection refine so the smear starts at the right place
          vec3 lo = prev, hi = sp;
          for (int k = 0; k < 4; k++) {
            vec3 mid = (lo + hi) * 0.5;
            vec3 pm = project(mid);
            float zm = viewZ(rawDepth(clamp(pm.xy, vec2(0.0), vec2(1.0))));
            if (zm - mid.z > minDz) hi = mid; else lo = mid;
          }
          vec3 pf = project(hi);
          vec2 huv = clamp(pf.xy, vec2(0.0), vec2(1.0));
          refl = texture2D(tDiffuse, huv).rgb;
          vec2 e = smoothstep(vec2(0.0), vec2(0.11), huv) * (1.0 - smoothstep(vec2(0.89), vec2(1.0), huv));
          conf = e.x * e.y;
          break;
        }
        prev = sp;
        t *= 1.28;
        t += 0.14;
        if (t > 260.0) break;
      }
    }
    refl = mix(miss, refl, conf);
    // horizon-grazing pixels get the strongest mirror — that is where a wet street reads as wet
    // a ray that hit real geometry is trusted; a miss only gets a fraction of the weight, so an
    // unresolved grazing road can never flatten into one opaque sheet
    // Damp tarmac is DARK and only faintly reflective; the mirror belongs to the standing water. Giving
    // the whole carriageway a 0.38 floor is what turned a rain frame into one pale blue sheet.
    float k = clamp(F * wetMask * (0.18 + 0.82 * pool) * mix(0.18, 1.0, conf), 0.0, 0.82);
    c = mix(c, refl, k);
    // a pool is water, not paint: extra darkening under it keeps the mirror readable
    c *= 1.0 - 0.20 * pool * uWet;
  }

  // ---------------- aerial perspective (lifts blacks toward the sky, desaturates) ----------------
  if (uAerial.x > 0.0) {
    float f = 1.0 - exp(-dist * uAerial.x);
    float l = luma(c);
    c = mix(c, vec3(l), uAerial.y * f);
    c += uHaze * uAerial.z * f;
  }

  gl_FragColor = vec4(max(c, vec3(0.0)), src.a);
}
`;

export class GroundFXPass extends Pass {
  constructor(camera) {
    super();
    this.name = 'GroundFXPass';
    this.needsSwap = true;
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uHasDepth: { value: 0 },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uNearFar: { value: new THREE.Vector2(1, 15000) },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uContact: { value: new THREE.Vector2(0.55, 1.1) },
      uAO: { value: new THREE.Vector2(0.55, 0.5) },
      uWet: { value: 0 },
      uReflect: { value: 1 },
      uSkyColor: { value: new THREE.Color(0.25, 0.32, 0.45) },
      uAerial: { value: new THREE.Vector4(0.00035, 0.35, 0.006, 0) },
      uHaze: { value: new THREE.Color(0.35, 0.42, 0.55) },
      uRipple: { value: 0 },
      uHorizon: { value: new THREE.Vector3(0, 9, 0) },
      uGlowColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
      uOcclusion: { value: new THREE.Vector2(0.95, 0.30) },
      uPoolMap: { value: null },
      uPoolXf: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, name: 'effects-groundfx',
    });
    this.quad = new FullScreenQuad(this.material);
    this.sunWorld = new THREE.Vector3(0, -1, 0);
    this._nm = new THREE.Matrix3();
  }

  setSize(w, h) { this.uniforms.uResolution.value.set(w, h); }

  /** @param {THREE.Vector3} sunDir direction the sunlight TRAVELS (points down) */
  setSun(sunDir) { this.sunWorld.copy(sunDir); }

  /** Camera matrices are read at RENDER time — at update() time matrixWorldInverse is a frame stale. */
  _syncCamera() {
    const cam = this.camera;
    const u = this.uniforms;
    u.uProj.value.copy(cam.projectionMatrix);
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uViewInv.value.copy(cam.matrixWorld);
    u.uView.value.copy(cam.matrixWorldInverse);
    u.uNearFar.value.set(cam.near, cam.far);
    this._nm.setFromMatrix4(cam.matrixWorldInverse);
    u.uUpView.value.set(0, 1, 0).applyMatrix3(this._nm).normalize();
    u.uSunView.value.copy(this.sunWorld).negate().applyMatrix3(this._nm).normalize();
  }

  /**
   * Draw the scene through the ground-FX shader into whatever target the caller has bound. EffectsPass
   * calls this INSTEAD of its plain copy step: keeping it inside that one pass means only a single pass
   * swaps buffers between the RenderPass and the depth consumers, so the depth texture being sampled is
   * never the depth attachment of the framebuffer being drawn into (that is a GL feedback loop).
   */
  renderCopy(renderer, sceneTexture, depth) {
    this._syncCamera();
    this.uniforms.tDiffuse.value = sceneTexture;
    this.uniforms.tDepth.value = depth || null;
    this.uniforms.uHasDepth.value = depth ? 1 : 0;
    this.quad.render(renderer);
  }

  dispose() { this.material.dispose(); this.quad.dispose(); }
}
