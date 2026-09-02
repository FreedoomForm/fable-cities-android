import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

/**
 * Cached asset loading. All paths are relative to /public, e.g. assets.loadTexture('/assets/shared/grass/albedo.jpg').
 */
export class AssetLoader {
  constructor(renderer, events) {
    this.renderer = renderer;
    this.events = events;
    this.manager = new THREE.LoadingManager();
    this.manager.onProgress = (url, loaded, total) => events?.emit('assets:progress', { url, loaded, total });
    this.manager.onError = (url) => console.warn('[assets] failed to load', url);
    this.textureLoader = new THREE.TextureLoader(this.manager);
    this.gltfLoader = new GLTFLoader(this.manager);
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    this.gltfLoader.setDRACOLoader(draco);
    this.hdrLoader = new HDRLoader(this.manager);
    this.exrLoader = new EXRLoader(this.manager);
    this.cache = new Map();
    this.maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  }

  /**
   * @param {string} url
   * @param {{srgb?:boolean, repeat?:[number,number]|number, anisotropy?:number, flipY?:boolean, wrap?:THREE.Wrapping}} opts
   */
  loadTexture(url, opts = {}) {
    const key = 'tex:' + url + JSON.stringify(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    const p = new Promise((resolve, reject) => {
      this.textureLoader.load(url, (tex) => {
        tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = opts.wrap ?? THREE.RepeatWrapping;
        if (opts.repeat != null) {
          const r = Array.isArray(opts.repeat) ? opts.repeat : [opts.repeat, opts.repeat];
          tex.repeat.set(r[0], r[1]);
        }
        tex.anisotropy = opts.anisotropy ?? this.maxAnisotropy;
        if (opts.flipY != null) tex.flipY = opts.flipY;
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, reject);
    });
    this.cache.set(key, p);
    return p;
  }

  /**
   * Load a PBR texture set. `files` maps material slots to URLs:
   * { map, normalMap, roughnessMap, metalnessMap, aoMap, displacementMap, emissiveMap, alphaMap }
   * Returns an object with loaded textures (missing entries are omitted).
   */
  async loadPBR(files, opts = {}) {
    const entries = Object.entries(files).filter(([, url]) => !!url);
    const results = await Promise.all(entries.map(([slot, url]) => this.loadTexture(url, { ...opts, srgb: slot === 'map' || slot === 'emissiveMap' }).catch(() => null)));
    const out = {};
    entries.forEach(([slot], i) => { if (results[i]) out[slot] = results[i]; });
    return out;
  }

  loadGLTF(url) {
    const key = 'gltf:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    const p = new Promise((resolve, reject) => this.gltfLoader.load(url, resolve, undefined, reject));
    this.cache.set(key, p);
    return p;
  }

  /** Load an equirectangular HDR/EXR. Returns the raw texture (mapping set to equirect). */
  loadHDR(url) {
    const key = 'hdr:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    const loader = url.toLowerCase().endsWith('.exr') ? this.exrLoader : this.hdrLoader;
    const p = new Promise((resolve, reject) => loader.load(url, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      resolve(tex);
    }, undefined, reject));
    this.cache.set(key, p);
    return p;
  }

  /** Build a PMREM environment map from an equirect texture or a scene. */
  pmrem(source) {
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    if (source.isScene) return this._pmrem.fromScene(source, 0, 0.1, 5000).texture;
    return this._pmrem.fromEquirectangular(source).texture;
  }

  async fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return res.json();
  }
}
