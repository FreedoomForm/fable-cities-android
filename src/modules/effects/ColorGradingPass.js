/**
 * Colour grading + restrained sun glare + optional LUT + heat shimmer, as one fullscreen pass
 * inserted before the OutputPass (so it operates on linear HDR radiance and AgX tone mapping still
 * provides the final filmic curve).
 *
 * Grade (CS2-like signature, all parameters driven per frame from world.env by index.js):
 *  - white-point anchoring: a 1×1 GPU meter (256 taps of the frame, temporally smoothed, no CPU
 *    read-back) measures the geometric-mean and the p4 power-mean (≈ 95-99th percentile) luminance;
 *    the frame is gained so the bright percentile lands on the white target (clamped, day only) —
 *    noon gets real whites instead of a milky mid-grey frame
 *  - white balance tint, exposure trim
 *  - log-space S-curve around 18 % grey: contrast ~1.45 by day with a shadow toe and a SOFT black
 *    level (a soft knee, never a hard clamp — see the note on the black level below),
 *    a softer curve with a lifted toe at night, a gentle shoulder so bright concrete / sky keep texture,
 *    plus a black-level pull; the white point is solved on the CPU through the inverse of this curve
 *  - saturation with a separate mid-tone boost and highlight desaturation (filmic)
 *  - split toning: cool shadows / warm highlights (masks on scene luminance)
 *  - lift / gain, vignette (radial, aspect-corrected)
 *  - sun glare: small HDR core + tight halo, a weak horizontal anamorphic streak and 3 small
 *    chromatic ghosts (alpha ≤ 0.08); visibility = CPU factor (elevation, clouds, rain, night) ×
 *    depth occlusion from EffectsPass' 1×1 probe
 *  - optional 2D-strip LUT (size N: N×N tiles in a N²×N image) applied in a display-referred domain
 *  - heat shimmer: up to 6 screen-space sources warp the sampled UV with animated noise
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const MAX_SHIMMER = 6;

const METER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tPrev;
uniform float uBlend;     // 0 → snap to the measurement, →1 keep the previous value
varying vec2 vUv;
void main() {
  float sumLog = 0.0;
  float p4 = 0.0;
  for (int j = 0; j < 16; j++) {
    for (int i = 0; i < 16; i++) {
      vec2 uv = (vec2(float(i), float(j)) + 0.5) / 16.0;
      vec3 c = texture2D(tScene, uv).rgb;
      float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4, 64.0);
      sumLog += log2(l);
      float l2 = l * l;
      p4 += l2 * l2;
    }
  }
  vec2 m = vec2(exp2(sumLog / 256.0), pow(p4 / 256.0, 0.25));
  vec2 prev = texture2D(tPrev, vec2(0.5)).rg;
  if (prev.y <= 0.0) prev = m;
  gl_FragColor = vec4(mix(m, prev, uBlend), 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tOcc;      // 1×1: fraction of sky around the sun (EffectsPass probe)
uniform sampler2D tMeter;    // 1×1: geometric-mean luminance, p4 power-mean luminance
uniform vec2 uResolution;
uniform float uTime;

uniform vec4 uAuto;          // white target, gain min, gain max, strength
uniform float uExposure;
uniform float uContrast;
uniform float uToe;          // -1..1 shadow toe: < 0 crush (day), > 0 lift (night)
uniform float uShoulder;     // 0..1 highlight roll-off
uniform float uBlack;        // linear black level pulled to 0
uniform float uSaturation;
uniform float uMidSat;       // extra saturation around mid grey
uniform float uHiDesat;      // highlight desaturation
uniform vec3 uTint;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec2 uVignette;      // strength, radius

uniform vec4 uSun;           // ndc x, ndc y, visibility, unused
uniform vec3 uSunColor;
uniform float uGlare;

uniform sampler2D tLUT;
uniform float uLUTSize;
uniform float uLUTAmount;

uniform vec4 uShimmer[${MAX_SHIMMER}];  // uv.x, uv.y, radius (uv), strength
uniform int uShimmerCount;

varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// 2D-strip LUT lookup (N tiles of N×N along x). Input in [0,1].
vec3 lut(vec3 c) {
  float n = uLUTSize;
  float b = c.b * (n - 1.0);
  float b0 = floor(b), b1 = min(b0 + 1.0, n - 1.0);
  vec2 uv0 = vec2((b0 + c.r * (n - 1.0) / n + 0.5 / n) / n, c.g * (n - 1.0) / n + 0.5 / n);
  vec2 uv1 = vec2((b1 + c.r * (n - 1.0) / n + 0.5 / n) / n, uv0.y);
  return mix(texture2D(tLUT, uv0).rgb, texture2D(tLUT, uv1).rgb, b - b0);
}

// soft aperture disc with a slightly brighter rim (lens ghost)
float ghostDisc(float gd) {
  return smoothstep(1.0, 0.6, gd) * (0.55 + 0.45 * smoothstep(0.35, 0.95, gd));
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;

  // --- heat shimmer: warp UV inside a soft ellipse above each hot source ---
  for (int i = 0; i < ${MAX_SHIMMER}; i++) {
    if (i >= uShimmerCount) break;
    vec4 s = uShimmer[i];
    vec2 d = (uv - s.xy) * vec2(aspect, 1.0);
    float above = smoothstep(-0.2 * s.z, 0.6 * s.z, d.y);           // mostly above the source
    float m = (1.0 - smoothstep(0.0, s.z, length(d * vec2(1.0, 0.45)))) * above;
    if (m > 0.0) {
      float n1 = sin(uv.y * 160.0 * aspect + uTime * 7.0 + uv.x * 40.0);
      float n2 = cos(uv.y * 110.0 + uTime * 5.3 + uv.x * 90.0);
      uv += vec2(n1, n2 * 0.6) * m * s.w;
    }
  }

  vec3 c = texture2D(tDiffuse, uv).rgb;

  // --- white-point anchoring (auto exposure from the meter) ---
  {
    vec2 m = texture2D(tMeter, vec2(0.5)).rg;
    float gain = clamp(uAuto.x / max(m.y, 1e-3), uAuto.y, uAuto.z);
    c *= mix(1.0, gain, uAuto.w);
  }

  // --- white balance & exposure trim ---
  c *= uTint * uExposure;

  // --- log S-curve around mid grey: contrast, small toe, soft shoulder ---
  {
    vec3 lc = log2(max(c, vec3(1e-5)) / 0.18);
    lc *= uContrast;
    // toe below -3 stops: NEGATIVE uToe crushes the shadows towards black (day — CS2 blacks are black),
    // positive lifts them (night — the dark scene keeps its detail)
    vec3 below = min(lc + 3.0, 0.0);
    lc += below * (uToe < 0.0 ? -uToe * 0.55 : -uToe * 0.35);
    // shoulder: only the top ~4 stops (above +2.9 stops = 1.35 linear) roll off, gently — white halls,
    // clouds and snow must reach paper white, not sit at mid grey
    vec3 above = max(lc - 2.9, 0.0);
    lc -= above * uShoulder * 0.3;
    c = 0.18 * exp2(lc);
    // Black level, SOFT. The old max(c - black, 0) sent an entire RANGE of the frame to exactly
    // RGB(0,0,0) — measured at 20-36 % of every daytime pixel against 0.0-0.1 % in the CS2 references —
    // which is not shadow, it is missing data (ground_shadow_ratio explodes because the denominator is
    // zero). c*c/(c+black) subtracts the same amount from anything well above the black point and rolls
    // smoothly into a floor below it: p10 still lands on the 0.010-0.015 target, nothing clips flat.
    c = (c * c) / (c + vec3(uBlack) + 1e-6) / (1.0 - uBlack);
  }

  // --- saturation: base, mid-tone boost, highlight desaturation ---
  {
    float l = luma(c);
    float stops = log2(max(l, 1e-4) / 0.18);
    float mid = exp(-stops * stops * 0.35);                 // gaussian around mid grey (±1.7 stops)
    float hi = smoothstep(0.5, 3.0, stops);
    float sat = uSaturation * (1.0 + uMidSat * mid) * (1.0 - uHiDesat * hi);
    c = mix(vec3(l), c, sat);
  }

  // --- split toning + lift / gain ---
  {
    float l = luma(c);
    float sh = 1.0 - smoothstep(0.015, 0.22, l);
    float hi = smoothstep(0.35, 2.5, l);
    c *= mix(vec3(1.0), uShadowTint, sh) * mix(vec3(1.0), uHighlightTint, hi);
    c = c * uGain + uLift * sh;
  }

  // --- sun glare (restrained): core + halo, weak anamorphic streak, 3 small chromatic ghosts ---
  float vis = uSun.z * texture2D(tOcc, vec2(0.5)).r;
  if (vis > 0.001) {
    vec2 sunUv = uSun.xy * 0.5 + 0.5;
    vec2 d = (vUv - sunUv) * vec2(aspect, 1.0);
    float dist = length(d);
    float glow = exp(-dist * dist * 260.0) * 2.2 + exp(-dist * 9.0) * 0.42 + exp(-dist * 2.4) * 0.05;
    // horizontal anamorphic streak only (no vertical shaft)
    float streak = exp(-abs(d.y) * 95.0) * exp(-abs(d.x) * 2.4) * 0.75;
    vec3 flare = uSunColor * (glow + streak);
    // ghosts on the line through the centre, small, faint, chromatic
    vec2 centre = vec2(0.5);
    vec2 axis = (centre - sunUv) * vec2(aspect, 1.0);
    vec2 p = (vUv - centre) * vec2(aspect, 1.0);
    vec3 gcol = vec3(0.0);
    const int NG = 3;
    float ks[NG]; ks[0] = -0.6; ks[1] = -1.25; ks[2] = 0.35;
    float rs[NG]; rs[0] = 0.035; rs[1] = 0.05; rs[2] = 0.022;
    float bs[NG]; bs[0] = 0.08; bs[1] = 0.06; bs[2] = 0.07;
    for (int i = 0; i < NG; i++) {
      vec2 gp = -axis * ks[i];
      float gd = length(p - gp) / rs[i];
      vec3 disc = vec3(ghostDisc(gd * 0.94), ghostDisc(gd), ghostDisc(gd * 1.07));
      vec3 tint = mix(vec3(0.6, 0.85, 1.0), vec3(1.0, 0.75, 0.6), float(i) / float(NG - 1));
      gcol += tint * disc * bs[i];
    }
    flare += gcol * max(uSunColor.g, 0.2);
    c += flare * vis * uGlare;
  }

  // --- vignette ---
  float vr = length((vUv - 0.5) * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);   // 0 centre … 1 corners
  float vig = 1.0 - uVignette.x * smoothstep(uVignette.y, 1.05, vr);
  c *= vig;

  // --- optional LUT in a display-referred domain (c/(1+c) → LUT → invert) ---
  if (uLUTAmount > 0.001) {
    vec3 t = c / (1.0 + c);
    vec3 g2 = lut(clamp(t, 0.0, 1.0));
    vec3 back = g2 / max(1.0 - g2, 1e-3);
    c = mix(c, back, uLUTAmount);
  }

  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class ColorGradingPass extends ShaderPass {
  constructor() {
    const uniforms = {
      tDiffuse: { value: null },
      tOcc: { value: null },
      tMeter: { value: null },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uTime: { value: 0 },
      uAuto: { value: new THREE.Vector4(2.5, 0.9, 1.85, 0) },
      uExposure: { value: 1 },
      uContrast: { value: 1.35 },
      uToe: { value: 0.2 },
      uShoulder: { value: 0.34 },
      uBlack: { value: 0.0012 },
      uSaturation: { value: 1.0 },
      uMidSat: { value: 0.18 },
      uHiDesat: { value: 0.15 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTint: { value: new THREE.Vector3(0.93, 0.965, 1.07) },
      uHighlightTint: { value: new THREE.Vector3(1.06, 1.0, 0.93) },
      uVignette: { value: new THREE.Vector2(0.14, 0.52) },
      uSun: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uGlare: { value: 1 },
      tLUT: { value: null },
      uLUTSize: { value: 16 },
      uLUTAmount: { value: 0 },
      uShimmer: { value: Array.from({ length: MAX_SHIMMER }, () => new THREE.Vector4()) },
      uShimmerCount: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, name: 'effects-color-grading' });
    super(material, 'tDiffuse');
    this.name = 'ColorGradingPass';
    this.needsSwap = true;

    // --- luminance meter: 1×1 ping-pong, HalfFloat, no CPU read-back ---
    const mk = () => {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      rt.texture.name = 'effects-luma-meter';
      return rt;
    };
    this.meterRT = [mk(), mk()];
    this.meterIndex = 0;
    this.meterMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tPrev: { value: null }, uBlend: { value: 0 } },
      vertexShader: QUAD_VERT, fragmentShader: METER_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending, name: 'effects-luma-meter',
    });
    this.meterQuad = new FullScreenQuad(this.meterMat);
    /** Adaptation rate (1/s) — set per frame by index.js. */
    this.adaptRate = 1.5;
  }

  setSize(w, h) {
    this.uniforms.uResolution.value.set(w, h);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // 1. meter (reads the read buffer, writes a 1×1 target → no feedback)
    const prev = this.meterRT[this.meterIndex];
    const next = this.meterRT[this.meterIndex ^ 1];
    this.meterIndex ^= 1;
    this.meterMat.uniforms.tScene.value = readBuffer.texture;
    this.meterMat.uniforms.tPrev.value = prev.texture;
    const dt = Number.isFinite(deltaTime) && deltaTime > 0 ? Math.min(deltaTime, 0.1) : 1 / 60;
    this.meterMat.uniforms.uBlend.value = Math.exp(-this.adaptRate * dt);
    const oldRT = renderer.getRenderTarget();
    renderer.setRenderTarget(next);
    this.meterQuad.render(renderer);
    renderer.setRenderTarget(oldRT);
    this.uniforms.tMeter.value = next.texture;
    // 2. grade
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  dispose() {
    super.dispose?.();
    this.meterMat.dispose(); this.meterQuad.dispose();
    for (const rt of this.meterRT) rt.dispose();
  }
}
