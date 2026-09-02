/**
 * Rain / snow / ground splashes — GPU-simulated, camera-following volumes.
 *
 *  - Streaks & flakes live in a box volume that follows the camera; world positions are wrapped with
 *    `mod()` relative to the volume centre so moving the camera never makes drops pop.
 *  - Rain streaks are thin quads with a guaranteed on-screen width (`uMinPx`, 1.6-2.4 px depending on
 *    the layer), 0.6-1.2 m long (fall speed × exposure), stretched along the screen-space fall direction.
 *    Two-tone shading from the scene colour behind the drop: sky-lit (brighter) over dark asphalt / brick,
 *    slightly darker than the sky over the sky; only a near-white sky hides them. Three layers: a dense
 *    sheet within ~15 m of the lens (defocused close to the camera), the main volume to ~60 m and a far
 *    fine-rain haze between 40 and 300 m.
 *  - Snow flakes: perspective-sized soft discs with a 2.5 px floor (readable from aerials), defocus blur
 *    close to the camera, motion stretch along the fall direction, tumbling drift, distance fade; never
 *    darker than what is behind them.
 *  - Splashes (SplashSystem) are two kinds in one draw: camera-facing 12-22 cm spray crowns standing on
 *    the ground everywhere it rains, and 20-36 cm impact rings that exist ONLY inside the puddle mask
 *    (the same noise the wet-surface hook uses). Additive, lit by sky + sun radiance.
 *
 * Rendered by EffectsPass: depthTest is OFF, occlusion comes from the sampled scene depth (with a
 * small soft range so drops do not cut hard against walls). Base `position` attributes are zero.
 */
import * as THREE from 'three';
import { DEPTH_PARS } from './SmokeSystem.js';
import { FX_NOISE_GLSL } from './wetGlsl.js';

const PRECIP_VERT = /* glsl */ `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aSeed;      // rx, ry, rz in [0,1), speed factor

uniform float uTime;
uniform vec3 uCenter;      // volume centre (world)
uniform vec3 uVolume;      // volume size (world)
uniform vec3 uVelocity;    // base fall velocity (world, m/s) incl. wind
uniform float uMode;       // 0 = rain streak, 1 = snow flake
uniform float uStreak;     // exposure length factor (seconds of motion blur)
uniform vec2 uSize;        // streak width (m), flake size (m)
uniform float uPixel;      // world size of one pixel at z = 1
uniform float uMinPx;      // minimum on-screen width (px)
uniform float uSway;       // lateral sway amplitude (snow)
uniform vec4 uDistFade;    // fade-in start/end, fade-out start/end (m)

varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
varying float vNear;     // 1 = right in front of the lens (defocused), 0 = far
#include <fog_pars_vertex>

void main() {
  float speed = mix(0.75, 1.25, aSeed.w);
  vec3 vel = uVelocity * speed;
  vec3 base = aSeed.xyz * uVolume;
  vec3 travel = vel * uTime;
  if (uMode > 0.5) {
    float ph = aSeed.x * 37.0 + aSeed.z * 11.0;
    // drift + tumble: slow sway, a faster flutter and a per-flake fall-speed wobble (turbulence)
    travel.x += sin(uTime * 0.9 + ph) * uSway + sin(uTime * 2.3 + ph * 0.7) * uSway * 0.3 + sin(uTime * 4.1 + ph * 2.3) * 0.06;
    travel.z += cos(uTime * 0.7 + ph * 1.3) * uSway + cos(uTime * 1.9 + ph) * uSway * 0.3 + cos(uTime * 3.7 + ph * 1.9) * 0.06;
    travel.y += sin(uTime * 1.7 + ph * 3.1) * 0.12;
  }
  vec3 local = mod(base + travel - uCenter + uVolume * 0.5, uVolume) - uVolume * 0.5;
  vec3 p = uCenter + local;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float px = uPixel * dist;       // metres per pixel at this depth

  vec2 c = aCorner;
  float alpha = 1.0;
  vec3 vv = mat3(viewMatrix) * vel;
  vec2 dir = vv.xy;
  float l2 = dot(dir, dir);
  dir = l2 > 1e-6 ? dir / sqrt(l2) : vec2(0.0, -1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float near = 0.0;
  if (uMode < 0.5) {
    // streak: motion-blur length, width never under uMinPx pixels; right in front of the lens the drop
    // is out of focus (wider, fainter)
    // per-drop exposure length: real rain is a mix of long and short strokes, never one ruled length
    float len = max(length(vv) * uStreak * mix(0.55, 1.45, aSeed.z), px * 4.0);
    float wid = max(uSize.x, px * uMinPx);
    near = 1.0 - smoothstep(0.6, 3.0, dist);
    wid *= 1.0 + 1.2 * near;
    // drops thin out with distance: a 200 m drop is a hint of haze, not the same rod as a 5 m one
    alpha *= (1.0 - 0.45 * near) * mix(0.62, 1.0, aSeed.y) * (1.0 - 0.55 * smoothstep(25.0, 140.0, dist));
    mv.xy += dir * c.y * len * 0.5 + perp * c.x * wid * 0.5;
  } else {
    // flakes: PHYSICAL size (∝ 1/depth) with a wide spread — near flakes are fat defocused bokeh discs,
    // far ones collapse towards a 1.2 px dot, so the fall reads as a depth volume instead of confetti
    near = 1.0 - smoothstep(1.2, 5.0, dist);
    float big = smoothstep(0.80, 1.0, aSeed.y);
    float s = uSize.y * mix(0.30, 1.0, aSeed.y * aSeed.y) * (1.0 + 1.8 * big) * (1.0 + 1.9 * near);
    s = max(s, px * uMinPx);
    alpha *= (1.0 - 0.82 * near) * mix(0.45, 1.0, aSeed.y) * (1.0 - 0.45 * smoothstep(30.0, 90.0, dist));
    float len = s + length(vv) * uStreak;
    mv.xy += dir * c.y * len * 0.5 + perp * c.x * s * 0.5;
  }
  vNear = near;

  vec3 e = abs(local) / (uVolume * 0.5);
  float edge = (1.0 - smoothstep(0.7, 1.0, e.x)) * (1.0 - smoothstep(0.7, 1.0, e.z)) * (1.0 - smoothstep(0.85, 1.0, e.y));
  float df = smoothstep(uDistFade.x, uDistFade.y, dist) * (1.0 - smoothstep(uDistFade.z, uDistFade.w, dist));
  vAlpha = edge * df * alpha;
  vUv = c * 0.5 + 0.5;
  vViewZ = mv.z;
  vec4 mvPosition = mv;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}
`;

const PRECIP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform sampler2D tScene;   // scene colour of this frame (background)
uniform vec3 uColor;        // sky-lit colour of the drop / flake
uniform float uOpacity;
uniform float uLumaFade;    // 0..1 how much a near-white sky hides the drops
uniform float uMode;
varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
varying float vNear;
#include <fog_pars_fragment>
${DEPTH_PARS}
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  float tex = texture2D(uTex, vUv).a;
  if (uMode > 0.5 && vNear > 0.15) {
    // defocused near flake: a flat bokeh disc with a faintly brighter rim, not a hard dot
    float r = length(vUv * 2.0 - 1.0);
    float boke = (1.0 - smoothstep(0.72, 1.0, r)) * (0.72 + 0.28 * smoothstep(0.30, 0.85, r));
    tex = mix(tex, boke, smoothstep(0.15, 0.75, vNear));
  }
  float a = tex * vAlpha * uOpacity;
  if (uHasDepth > 0.5) a *= clamp((vViewZ - effectsSceneViewZ()) / 0.35, 0.0, 1.0);
  if (a < 0.003) discard;
  vec3 bg = texture2D(tScene, gl_FragCoord.xy / uResolution).rgb;
  float bl = dot(bg, LUMA);
  vec3 col;
  if (uMode < 0.5) {
    // A raindrop is a LENS, not a white rod: it shows the (slightly dimmed, defocused) background behind
    // it plus a small lift of sky radiance. Then a hard contrast limiter keeps the streak within ~22 % of
    // the local background luminance, so drops read over dark asphalt AND over a bright overcast sky
    // without ever looking like scratches painted on the frame.
    col = bg * 0.86 + uColor * 0.55;
    float cl = dot(col, LUMA);
    // over a dark surface the floor dominates (a drop is clearly brighter than wet asphalt); over a bright
    // overcast sky the ratio dominates (only ~35 % lift) so the streaks never read as scratches
    float lim = bl * 1.35 + 0.075;
    col *= min(1.0, lim / max(cl, 1e-4));
    // never darker than ~85 % of the background either
    float lo = bl * 0.86;
    col *= max(1.0, lo / max(dot(col, LUMA), 1e-4));
    a *= 1.0 - uLumaFade * smoothstep(1.4, 5.0, bl / max(dot(uColor, LUMA), 1e-4));
  } else {
    // flakes are never darker than what is behind them (no dark specks against a bright overcast sky)
    col = max(uColor, bg * 1.12 + vec3(0.01));
  }
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}
`;

const SPLASH_VERT = /* glsl */ `
precision highp float;
attribute vec2 aCorner;
attribute vec3 aPos;       // world position on the ground
attribute vec4 aSeed;      // phase, life, size, rotation
attribute float aKind;     // 0 = spray crown (camera-facing), 1 = impact ring (ground, puddles only)
uniform float uTime;
uniform vec3 uAnchor;
uniform float uRadius;
uniform float uWet;        // wetness → puddle mask (same field as WetSurfaces)
varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
varying float vKind;
#include <fog_pars_vertex>
${FX_NOISE_GLSL}
void main() {
  float life = aSeed.y;
  float t = fract(uTime / life + aSeed.x) * life;
  float u = t / life;
  float d = length(aPos.xz - uAnchor.xz) / uRadius;
  float area = 1.0 - smoothstep(0.6, 1.0, d);
  vec3 p = aPos;
  float alpha;
  if (aKind < 0.5) {
    // crown: stands on the ground, faces the camera about the vertical axis, shoots up then falls
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    camRight.y = 0.0;
    camRight = normalize(camRight + vec3(1e-4, 0.0, 0.0));
    float w = aSeed.z;                                   // 0.12-0.22 m
    float h = w * 1.4 * (0.35 + 0.65 * smoothstep(0.0, 0.4, u)) * (1.0 - 0.35 * smoothstep(0.6, 1.0, u));
    p += camRight * aCorner.x * w * 0.5 + vec3(0.0, (aCorner.y + 1.0) * 0.5 * h, 0.0);
    alpha = smoothstep(0.0, 0.06, u) * pow(1.0 - u, 1.3);
  } else {
    // ring: expands fast then decelerates; only inside puddles
    float rim;
    float puddle = fxPuddleMask(aPos.xz, uWet, rim);
    float s = aSeed.z * 2.8 * (0.15 + 0.85 * sqrt(u));   // final diameter 0.20-0.36 m
    float c = cos(aSeed.w), sn = sin(aSeed.w);
    vec2 rc = vec2(aCorner.x * c - aCorner.y * sn, aCorner.x * sn + aCorner.y * c) * s * 0.5;
    p += vec3(rc.x, 0.005, rc.y);
    alpha = smoothstep(0.0, 0.04, u) * pow(1.0 - u, 1.1) * smoothstep(0.2, 0.6, puddle);
  }
  vKind = aKind;
  vUv = aCorner * 0.5 + 0.5;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vViewZ = mvPosition.z;
  // A splash crown is a 15 cm object: past ~20 m it is sub-pixel and a field of them reads as gravel
  // grain on the tarmac rather than as rain. Rings are 3x larger, so they survive a little further.
  float far = -mvPosition.z;
  float dfade = aKind < 0.5 ? 1.0 - smoothstep(15.0, 38.0, far) : 1.0 - smoothstep(26.0, 62.0, far);
  vAlpha = alpha * area * dfade;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// additive: fog attenuates instead of tinting
const SPLASH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTexCrown;
uniform sampler2D uTexRing;
uniform vec3 uColor;        // crown colour
uniform vec3 uColorRing;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
varying float vKind;
#include <fog_pars_fragment>
${DEPTH_PARS}
void main() {
  float tex = vKind < 0.5 ? texture2D(uTexCrown, vUv).a : texture2D(uTexRing, vUv).a;
  float a = tex * vAlpha * uOpacity;
  // both kinds sit ON the ground: bias towards the camera so the surface itself never occludes them
  if (uHasDepth > 0.5) a *= clamp((vViewZ - effectsSceneViewZ() + 0.2) / 0.3, 0.0, 1.0);
  if (a < 0.003) discard;
  float fogAtt = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogAtt = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogAtt = 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  vec3 col = vKind < 0.5 ? uColor : uColorRing;
  gl_FragColor = vec4(col * a * fogAtt, a);
}
`;

function depthUniforms() {
  return { tDepth: { value: null }, uHasDepth: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(1, 15000) } };
}

export class PrecipitationSystem {
  /**
   * @param {{count:number, texture:THREE.Texture, mode:0|1, name:string}} opts
   */
  constructor({ count, texture, mode, name }) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.seed = new Float32Array(count * 4);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.count = count;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, depthUniforms(), {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uVolume: { value: new THREE.Vector3(80, 50, 80) },
      uVelocity: { value: new THREE.Vector3(0, -10, 0) },
      uMode: { value: mode },
      uStreak: { value: 0.05 },
      uSize: { value: new THREE.Vector2(0.004, 0.03) },
      uPixel: { value: 0.001 },
      uMinPx: { value: 1.8 },
      uSway: { value: 0.6 },
      uDistFade: { value: new THREE.Vector4(1.2, 3.2, 40, 90) },
      uTex: { value: null },
      tScene: { value: null },
      uColor: { value: new THREE.Color(0.6, 0.65, 0.7) },
      uOpacity: { value: 0 },
      uLumaFade: { value: 0 },
    }]);
    this.uniforms.uTex.value = texture;
    this.material = new THREE.ShaderMaterial({
      vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending, fog: true, side: THREE.DoubleSide, name,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 950;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.geometry = geo;
  }
  fill(rng) {
    for (let i = 0; i < this.count; i++) {
      this.seed[i * 4] = rng(); this.seed[i * 4 + 1] = rng(); this.seed[i * 4 + 2] = rng(); this.seed[i * 4 + 3] = rng();
    }
    this.geometry.getAttribute('aSeed').needsUpdate = true;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

export class SplashSystem {
  constructor({ count, crownTexture, ringTexture, name = 'effects-splashes' }) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(count * 3);
    this.seed = new Float32Array(count * 4);
    this.kind = new Float32Array(count);
    const posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', posAttr);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 4));
    geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(this.kind, 1));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.count = count;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, depthUniforms(), {
      uTime: { value: 0 },
      uAnchor: { value: new THREE.Vector3() },
      uRadius: { value: 40 },
      uWet: { value: 0 },
      uTexCrown: { value: null },
      uTexRing: { value: null },
      uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
      uColorRing: { value: new THREE.Color(0.7, 0.75, 0.8) },
      uOpacity: { value: 0 },
    }]);
    this.uniforms.uTexCrown.value = crownTexture;
    this.uniforms.uTexRing.value = ringTexture;
    this.material = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: true, side: THREE.DoubleSide, name,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 940;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.geometry = geo;
    this.offsets = new Float32Array(count * 2); // unit-disc offsets, fixed per seed
  }
  fill(rng) {
    for (let i = 0; i < this.count; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng());
      this.offsets[i * 2] = Math.cos(a) * r; this.offsets[i * 2 + 1] = Math.sin(a) * r;
      const ring = rng() < 0.55;      // slightly more crowns: they are what reads on plain wet asphalt
      this.kind[i] = ring ? 1 : 0;
      this.seed[i * 4] = rng();
      this.seed[i * 4 + 1] = ring ? 0.28 + rng() * 0.16 : 0.20 + rng() * 0.12;   // life: ring 0.28-0.44 s, crown 0.20-0.32 s
      this.seed[i * 4 + 2] = ring ? 0.06 + rng() * 0.05 : 0.085 + rng() * 0.07;   // ring 17-31 cm (×2.8) / crown width 8.5-15 cm
      this.seed[i * 4 + 3] = rng() * Math.PI * 2;
    }
    this.geometry.getAttribute('aSeed').needsUpdate = true;
    this.geometry.getAttribute('aKind').needsUpdate = true;
  }
  /** Re-place splashes on the ground around `anchor` (world x,z). */
  place(anchor, radius, surfaceHeight) {
    const p = this.pos;
    for (let i = 0; i < this.count; i++) {
      const x = anchor.x + this.offsets[i * 2] * radius;
      const z = anchor.z + this.offsets[i * 2 + 1] * radius;
      p[i * 3] = x;
      p[i * 3 + 1] = surfaceHeight(x, z);
      p[i * 3 + 2] = z;
    }
    this.geometry.getAttribute('aPos').needsUpdate = true;
    this.uniforms.uAnchor.value.set(anchor.x, 0, anchor.z);
    this.uniforms.uRadius.value = radius;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
