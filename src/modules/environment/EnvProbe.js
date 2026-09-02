/**
 * Reflection probe: renders the sky dome + cloud layer into a PMREM so PBR materials reflect
 * the actual sky of the moment (refreshed periodically and on time jumps).
 */
import * as THREE from 'three';

export class EnvProbe {
  constructor(renderer, sky, clouds, { size = 512 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.sky = sky;
    this.clouds = clouds;
    this.scene = new THREE.Scene();
    this.scene.name = 'env-probe-scene';
    this.scene.add(sky.probeMesh);
    this.scene.add(clouds.probeMesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.target = null;
    this.texture = null;
    this.lastRefresh = -1e9;
    this.count = 0;
  }

  /** Re-render the probe. Returns the PMREM texture. */
  refresh(elapsed = 0) {
    this.sky.uniforms.uEnvMode.value = 1;
    this.clouds.uniforms.uEnvMode.value = 1;
    let rt = null;
    try {
      rt = this.pmrem.fromScene(this.scene, 0, 20, 40000, { size: this.size });
    } finally {
      this.sky.uniforms.uEnvMode.value = 0;
      this.clouds.uniforms.uEnvMode.value = 0;
    }
    if (this.target && this.target !== rt) this.target.dispose();
    this.target = rt;
    this.texture = rt.texture;
    this.lastRefresh = elapsed;
    this.count++;
    return this.texture;
  }

  dispose() {
    if (this.target) this.target.dispose();
    this.pmrem.dispose();
  }
}
