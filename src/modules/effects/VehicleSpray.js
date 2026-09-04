/**
 * VehicleSpray — the plume of water a moving vehicle throws off a wet road.
 *
 * Emitters are the nearest fast-moving vehicles from `world.traffic.list`; each one owns a fixed block of
 * instances. The CPU writes only the emitter's rear position, its travel direction and its speed once per
 * frame (a few hundred floats); the puffs themselves are animated entirely in the vertex shader from
 * `uTime` and a per-instance phase, so the cost does not scale with the particle count.
 *
 * A puff is born at a rear wheel, is LEFT BEHIND in world space (it moves backwards relative to the car at
 * the car's own speed, which is what makes the plume read as thrown water rather than an attached decal),
 * fans outward, rises and falls, and fades over ~0.6 s. Additive against the dark wet road, tinted by the
 * sky radiance plus a warm term so headlights and tail lights light the mist at night.
 */
import * as THREE from 'three';
import { DEPTH_PARS } from './SmokeSystem.js';

const VERT = /* glsl */ `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aEmit;      // rear x, y, z, direction x
attribute vec4 aVel;       // direction z, speed (m/s), strength 0..1, unused
attribute vec4 aSeed;      // phase, lateral offset (m), size (m), rand

uniform float uTime;
uniform float uWet;
varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
#include <fog_pars_vertex>
void main() {
  float strength = aVel.z * uWet;
  float life = 0.42 + aSeed.w * 0.34;
  float u = fract(uTime / life + aSeed.x);
  float age = u * life;
  vec3 dir = vec3(aEmit.w, 0.0, aVel.x);
  vec3 side = vec3(-dir.z, 0.0, dir.x);
  float speed = aVel.y;
  vec3 p = aEmit.xyz;
  // thrown backwards at (roughly) the vehicle's own speed, fanning out and up, then settling
  p -= dir * (speed * age * 0.55);
  p += side * aSeed.y * (0.55 + 1.9 * u);
  p.y += 0.04 + (0.95 * u - 0.78 * u * u) * (0.40 + 0.055 * speed);
  // p8: the audit bracket is now measured — 3.2 growth read as white cotton foam, 2.0 was
  // invisible (VLM 0/10). 2.6 sits between: puffs reach ~0.9 m, a mist trail, not a sheet.
  float s = aSeed.z * (0.42 + 2.6 * u) * (0.62 + 0.05 * speed);
  vAlpha = smoothstep(0.0, 0.08, u) * pow(1.0 - u, 1.5) * strength;
  vUv = aCorner * 0.5 + 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += aCorner * s * 0.5;
  vViewZ = mv.z;
  vec4 mvPosition = mv;
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vViewZ;
#include <fog_pars_fragment>
${DEPTH_PARS}
void main() {
  float a = texture2D(uTex, vUv).a * vAlpha * uOpacity;
  if (uHasDepth > 0.5) a *= clamp((vViewZ - effectsSceneViewZ() + 0.15) / 0.4, 0.0, 1.0);
  if (a < 0.003) discard;
  float fogAtt = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogAtt = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogAtt = 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(uColor * a * fogAtt, a);
}
`;

export class VehicleSpray {
  /** @param {{emitters:number, perEmitter:number, texture:THREE.Texture}} opts */
  constructor({ emitters, perEmitter, texture }) {
    this.emitters = emitters;
    this.per = perEmitter;
    const count = emitters * perEmitter;
    this.count = count;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    this.emit = new Float32Array(count * 4);
    this.vel = new Float32Array(count * 4);
    const seed = new Float32Array(count * 4);
    // deterministic per-slot layout: phase spread over the lifetime, lateral offset = one of the two
    // wheel tracks with jitter, size and lifetime jitter
    let h = 0x9e3779b9;
    const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
    for (let e = 0; e < emitters; e++) {
      for (let k = 0; k < perEmitter; k++) {
        const i = (e * perEmitter + k) * 4;
        const wheel = k % 2 === 0 ? -1 : 1;
        seed[i] = (k + rnd() * 0.6) / perEmitter;
        seed[i + 1] = wheel * (0.62 + rnd() * 0.30);
        seed[i + 2] = 0.40 + rnd() * 0.44;
        seed[i + 3] = rnd();
      }
    }
    geo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(this.emit, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.InstancedBufferAttribute(this.vel, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    // fog: true means three refreshes fogColor / fogNear|fogDensity on THIS uniform set — they must exist
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uWet: { value: 0 }, uTex: { value: null }, uColor: { value: new THREE.Color(0.6, 0.65, 0.7) },
      uOpacity: { value: 1 }, tDepth: { value: null }, uHasDepth: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(1, 15000) },
    }]);
    this.uniforms.uTex.value = texture;      // merge() clones the texture reference away
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: true, side: THREE.DoubleSide,
      name: 'effects-vehicle-spray',
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'effects-vehicle-spray';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this._prev = new Map();
    this._live = 0;
  }

  get live() { return this._live; }

  /**
   * Rewrite the emitter blocks from the traffic list. O(vehicles) with a tiny constant; nothing is
   * allocated per frame.
   * @param {Array} vehicles world.traffic.list
   * @param {THREE.Vector3} camPos
   * @param {number} wet 0..1
   * @param {number} range metres
   */
  sync(vehicles, camPos, wet, range) {
    if (!vehicles || !vehicles.length || wet < 0.10) { this._live = 0; this.geometry.instanceCount = 0; return 0; }
    const per = this.per, maxE = this.emitters;
    const emit = this.emit, vel = this.vel;
    const r2 = range * range;
    let n = 0;
    // one pass: keep the first maxE vehicles that are close enough and actually moving
    for (let i = 0; i < vehicles.length && n < maxE; i++) {
      const v = vehicles[i];
      if (!v || v.dead) continue;
      const speed = v.v || 0;
      // 3.2 m/s (11.5 km/h) was above almost every vehicle the street presets actually frame — traffic
      // slowing for a signal still throws water. 1.8 m/s is a walking pace: below that a tyre lifts none.
      if (speed < 1.8) continue;
      const dx = v.x - camPos.x, dz = v.z - camPos.z, dy = v.y - camPos.y;
      const d2 = dx * dx + dz * dz + dy * dy;
      if (d2 > r2) continue;
      // travel direction from the actual displacement — no yaw-convention guessing
      let p = this._prev.get(v.id);
      if (!p) { p = { x: v.x, z: v.z, dx: 0, dz: 1 }; this._prev.set(v.id, p); }
      const mx = v.x - p.x, mz = v.z - p.z;
      const ml = Math.hypot(mx, mz);
      if (ml > 1e-4) { p.dx = mx / ml; p.dz = mz / ml; }
      p.x = v.x; p.z = v.z;
      const half = v.half || 2;
      const rx = v.x - p.dx * half * 0.82, rz = v.z - p.dz * half * 0.82;
      const strength = Math.min(1, (speed - 1.6) / 5) * (1 - Math.sqrt(d2) / range) ** 0.6;
      const base = n * per * 4;
      for (let k = 0; k < per; k++) {
        const o = base + k * 4;
        emit[o] = rx; emit[o + 1] = v.y + 0.05; emit[o + 2] = rz; emit[o + 3] = p.dx;
        vel[o] = p.dz; vel[o + 1] = speed; vel[o + 2] = strength; vel[o + 3] = 0;
      }
      n++;
    }
    if (this._prev.size > maxE * 8) this._prev.clear();
    this._live = n;
    this.geometry.instanceCount = n * per;
    if (n) {
      this.geometry.getAttribute('aEmit').needsUpdate = true;
      this.geometry.getAttribute('aVel').needsUpdate = true;
    }
    return n;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
