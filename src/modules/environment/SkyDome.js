/**
 * Sky dome mesh: analytic atmosphere + stars + moon + sun disc. One material is shared between
 * the main-scene dome (centred on the camera) and the reflection-probe dome.
 */
import * as THREE from 'three';
import { SKY_VERTEX, SKY_FRAGMENT } from './shaders.js';
import { ATMOS } from './atmosphere.js';
import { buildStarCubeTexture, buildMoonTexture } from './StarField.js';

export class SkyDome {
  constructor({ seed }) {
    this.stars = buildStarCubeTexture(seed);
    this.moonTex = buildMoonTexture(seed);
    this.uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: new THREE.Vector3(ATMOS.sunE, ATMOS.sunE, ATMOS.sunE) },
      uMoonE: { value: 0 },
      uTurbidity: { value: 2.2 },
      uEnvMode: { value: 0 },
      uHorizonColor: { value: new THREE.Color(0.6, 0.7, 0.85) },
      uGroundRadiance: { value: new THREE.Color(0.2, 0.2, 0.17) },
      uNightGlow: { value: new THREE.Color(0.0011, 0.0031, 0.0125) }, // deep saturated blue, not slate
      uNightAmount: { value: 0 },
      uStarRot: { value: new THREE.Matrix3() },
      uStars: { value: this.stars },
      uStarIntensity: { value: 0.4 },
      uStarSeed: { value: (seed % 1000) * 0.37 },
      uMoonTex: { value: this.moonTex },
      uMoonRadius: { value: ATMOS.moonAngularRadius },
      uMoonBright: { value: 1.1 },
      uSunRadius: { value: ATMOS.sunAngularRadius },
      uSunDisc: { value: ATMOS.sunDiscRadiance },
      uCloudCover: { value: 0.3 },
      uTime: { value: 0 },
      uSkyFog: { value: 0 },
      uFogSun: { value: new THREE.Vector4(0, 1, 0, 0) },
      uGlowKnee: { value: 1.4 },
      uSkySat: { value: 1.35 },
      uTwilight: { value: 0 },
      uScatterBoost: { value: ATMOS.scatterBoost },
      uSunTint: { value: new THREE.Color(1, 1, 1) },
      uMilkyWay: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'env-sky',
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      lights: false,
    });
    const geo = new THREE.SphereGeometry(1, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'env-sky';
    this.mesh.scale.setScalar(9000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900; // last opaque: depth test skips covered pixels
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.probeMesh = new THREE.Mesh(geo, this.material);
    this.probeMesh.name = 'env-sky-probe';
    this.probeMesh.scale.setScalar(9000);
    this.probeMesh.frustumCulled = false;
  }

  /** Rotation world → celestial frame for the star cube. */
  setStarRotation(latitudeRad, siderealAngle) {
    // celestial pole in the local frame: north (−Z) tilted up by latitude
    const pole = new THREE.Vector3(0, Math.sin(latitudeRad), -Math.cos(latitudeRad));
    const qSpin = new THREE.Quaternion().setFromAxisAngle(pole, -siderealAngle);
    const qTilt = new THREE.Quaternion().setFromUnitVectors(pole, new THREE.Vector3(0, 1, 0));
    const q = qTilt.multiply(qSpin);
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q);
    this.uniforms.uStarRot.value.setFromMatrix4(m4);
  }

  dispose() {
    this.stars.dispose();
    this.moonTex.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
