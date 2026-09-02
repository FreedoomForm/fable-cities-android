/**
 * EffectsPass — renders the particle layer right after the RenderPass, with real scene depth.
 *
 * Why a pass: the RenderPass writes the scene into the composer's *read* buffer and that buffer's
 * depth attachment is the only true scene depth of this frame. Sampling it while drawing into the
 * same target is a WebGL feedback loop, so transparent effects that want soft edges / occlusion from
 * depth cannot live in the main scene render. This pass copies the read buffer into the write buffer
 * (one fullscreen quad), then draws the particle scene on top while sampling `readBuffer.depthTexture`
 * — no feedback, no GTAO pre-pass involvement (the particles are not in the main scene at all), and
 * the occlusion test is fully depth-texture driven (materials use depthTest = false).
 *
 * It also renders the sun-occlusion probe (13 depth taps around the sun → 1×1 texture) that the
 * colour-grading pass reads later in the frame, again without touching a bound depth attachment.
 *
 * Note: `engine.post.depthTexture` belongs to composer.renderTarget1, which the RenderPass never
 * targets (EffectComposer renders it into renderTarget2 = the clone) — see docs/requests/effects.md.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// copy + night light-pollution glow: a faint warm band above the horizon on SKY pixels only (depth ≥ far),
// tied to nightFactor by index.js (uHorizon = ndc y of the horizon, falloff, strength)
const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float uHasDepth;
uniform vec2 uNearFar;
uniform vec3 uHorizon;
uniform vec3 uGlowColor;
varying vec2 vUv;
#include <packing>
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  if (uHorizon.z > 0.0001 && uHasDepth > 0.5) {
    float d = texture2D(tDepth, vUv).x;
    float vz = -perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
    float far = max(uNearFar.y * 0.4, 1500.0);
    float sky = smoothstep(far * 0.7, far, vz);
    float dy = (vUv.y * 2.0 - 1.0) - uHorizon.x;
    float band = exp(-max(dy, 0.0) * uHorizon.y) * smoothstep(-0.10, 0.0, dy);
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    c.rgb += uGlowColor * (l * 1.4 + 0.0012) * band * sky * uHorizon.z;
  }
  gl_FragColor = c;
}
`;

const PROBE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec2 uSunUv;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform float uRadius;    // px
uniform float uActive;    // 0 → write 0 (sun off screen / below horizon)
#include <packing>
float lin(vec2 uv) {
  float d = texture2D(tDepth, clamp(uv, vec2(0.001), vec2(0.999))).x;
  return -perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
}
void main() {
  float far = max(uNearFar.y * 0.4, 1500.0);          // sky dome / clear depth are beyond this
  float occ = step(far, lin(uSunUv));
  for (int k = 0; k < 12; k++) {
    float a = float(k) * 0.5235988;
    float r = (k < 6) ? uRadius * 0.5 : uRadius;
    vec2 o = vec2(cos(a), sin(a)) * r * uTexel;
    occ += step(far, lin(uSunUv + o));
  }
  gl_FragColor = vec4(occ / 13.0 * uActive, 0.0, 0.0, 1.0);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class EffectsPass extends Pass {
  /**
   * @param {THREE.Scene} mainScene  the game scene (fog is mirrored from it every frame)
   * @param {THREE.Camera} camera
   */
  constructor(mainScene, camera) {
    super();
    this.name = 'EffectsPass';
    this.needsSwap = true;
    this.mainScene = mainScene;
    this.camera = camera;
    /** Particle scene: index.js adds its group here. */
    this.fxScene = new THREE.Scene();
    this.fxScene.name = 'effects-particles';
    this.fxScene.matrixWorldAutoUpdate = true;
    /** Scene depth of the current frame (set in render, read by the particle uniforms). */
    this.sceneDepth = null;
    /** Optional GroundFXPass: replaces the plain copy step (wet reflections, contact shadows, AO, haze). */
    this.ground = null;
    /** Called right before the particle scene renders: (depthTexture|null, sceneColorTexture, width, height). */
    this.onBeforeParticles = null;
    this.width = 1; this.height = 1;

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, uHasDepth: { value: 0 }, uNearFar: { value: new THREE.Vector2(1, 15000) },
        uHorizon: { value: new THREE.Vector3(0, 9, 0) }, uGlowColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
      }, vertexShader: QUAD_VERT, fragmentShader: COPY_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, name: 'effects-copy',
    });
    this.copyQuad = new FullScreenQuad(this.copyMat);

    this.probeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null }, uSunUv: { value: new THREE.Vector2(0.5, 0.5) }, uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uNearFar: { value: new THREE.Vector2(1, 15000) }, uRadius: { value: 9 }, uActive: { value: 0 },
      },
      vertexShader: QUAD_VERT, fragmentShader: PROBE_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending, name: 'effects-sun-probe',
    });
    this.probeQuad = new FullScreenQuad(this.probeMat);
    this.occRT = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    });
    this.occRT.texture.name = 'effects-sun-occlusion';
    /** Set per frame by index.js: sample the probe this frame? (sun on screen) */
    this.probeActive = false;
  }

  /** The 1×1 occlusion texture (R = fraction of sky around the sun). */
  get occlusionTexture() { return this.occRT.texture; }

  setSize(w, h) {
    this.width = w; this.height = h;
    this.probeMat.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  render(renderer, writeBuffer, readBuffer) {
    // EffectComposer's two targets own SEPARATE depth attachments (renderTarget2 is a clone), so once any
    // pass before this one has swapped, readBuffer.depthTexture is no longer the depth the RenderPass
    // wrote. GroundFXPass runs first, captures the real one and publishes it here.
    const depth = readBuffer.depthTexture || null;
    this.sceneDepth = depth;
    const oldAutoClear = renderer.autoClear;

    // 1. sun occlusion probe (tiny target, samples the read buffer's depth — never the bound one)
    if (depth) {
      this.probeMat.uniforms.tDepth.value = depth;
      this.probeMat.uniforms.uActive.value = this.probeActive ? 1 : 0;
      renderer.setRenderTarget(this.occRT);
      this.probeQuad.render(renderer);
    }

    // 2. copy the scene colour into the write buffer — through the ground-FX shader when one is attached
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    renderer.autoClear = false;
    if (this.ground && this.ground.enabled !== false) {
      this.ground.renderCopy(renderer, readBuffer.texture, depth);
    } else {
      this.copyMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.copyMat.uniforms.tDepth.value = depth;
      this.copyMat.uniforms.uHasDepth.value = depth ? 1 : 0;
      this.copyMat.uniforms.uNearFar.value.set(this.camera.near, this.camera.far);
      this.copyQuad.render(renderer);
    }

    // 3. particles on top, occluded / softened by the sampled scene depth
    if (this.onBeforeParticles) this.onBeforeParticles(depth, readBuffer.texture, readBuffer.width, readBuffer.height);
    this.fxScene.fog = this.mainScene.fog;
    renderer.render(this.fxScene, this.camera);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.copyMat.dispose(); this.copyQuad.dispose();
    this.probeMat.dispose(); this.probeQuad.dispose();
    this.occRT.dispose();
  }
}
