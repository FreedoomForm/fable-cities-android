/**
 * tools/gfx — the drawing backend every tool overlay uses.
 *
 *  • VectorLayer  one draw call for every overlay *line* (guides, outlines, brackets, arcs, dashes).
 *                 Lines have a constant screen-space width (fat-line style expansion in the vertex
 *                 shader) so they stay crisp from 20 m to 2 km, are anti-aliased with fwidth() and
 *                 carry a dark contrast halo so they read over bright grass and dark asphalt alike.
 *  • FillLayer    one draw call for every overlay *surface* (ghost carriageway, zone cells, coverage
 *                 disc, footprints). Per-vertex colour + a pattern id shaded procedurally.
 *  • Chip         world-anchored HUD chip (canvas texture on a screen-sized sprite) for the
 *                 length / cost / name read-outs. Matches the HUD glass style (ui.css palette).
 *
 * Everything is unlit, additive-free NormalBlending, depthWrite off, and lives on
 * engine.LAYER_NO_AO exclusively so the GTAO pre-pass and shadow cascades ignore it.
 * Bright core colours are pushed above 1.0 so UnrealBloom gives them a soft halo at night.
 */
import * as THREE from 'three';

/** sRGB hex → linear rgb triple (raw ShaderMaterials get no automatic conversion). */
export function lin(hex) {
  const c = new THREE.Color(hex);
  c.convertSRGBToLinear();
  return [c.r, c.g, c.b];
}
export function mulc(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

/** HUD palette (mirrors ui.css so overlays and HUD read as one design). */
export const PAL = {
  accent: lin('#4fc3f7'),
  accentHi: lin('#bdf0ff'),
  good: lin('#6fe08c'),
  goodHi: lin('#c8ffd8'),
  bad: lin('#ff6b6b'),
  badHi: lin('#ffc9c4'),
  warn: lin('#ffc247'),
  white: lin('#eaf4ff'),
  guide: lin('#5b9dd9'),
  snap: lin('#ffd66b'),
};

const VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aSide;
attribute float aDist;
attribute vec3 aColor;
attribute vec4 aData;      // x widthPx  y dashPeriod(m)  z alpha  w glow
uniform float uPxScale;    // 2*tan(fov/2) / viewportHeightPx
uniform float uFar;
varying float vSide, vDist, vAlpha, vGlow, vDash;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.05);
  float w = clamp(aData.x * dist * uPxScale, 0.05, 60.0);
  vec3 off = (viewMatrix * vec4(aOffset, 0.0)).xyz;
  mv.xyz += off * (aSide * w * 0.5);
  gl_Position = projectionMatrix * mv;
  vSide = aSide; vDist = aDist; vColor = aColor; vDash = aData.y;
  vGlow = aData.w;
  vAlpha = aData.z * (1.0 - smoothstep(uFar * 0.55, uFar, dist));
}`;

const FRAG = /* glsl */ `
precision highp float;
varying float vSide, vDist, vAlpha, vGlow, vDash;
varying vec3 vColor;
void main() {
  float a = abs(vSide);
  float core  = 1.0 - smoothstep(0.26, 0.60, a);
  float outer = 1.0 - smoothstep(0.82, 1.00, a);
  float dash = 1.0;
  if (vDash > 0.0) {
    float t = abs(fract(vDist / vDash) - 0.5) * 2.0;
    float w = clamp(fwidth(vDist) / vDash * 2.0, 0.02, 0.6);
    dash = 1.0 - smoothstep(0.52 - w, 0.52 + w, t);
  }
  vec3 c = mix(vec3(0.012, 0.017, 0.025), vColor * (1.0 + vGlow), core);
  float alpha = mix(0.42, 1.0, core) * outer * dash * vAlpha;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(c, alpha);
}`;

/** Dynamic, one-draw-call polyline layer with screen-space-constant width. */
export class VectorLayer {
  constructor(engine, { maxVerts = 40000, renderOrder = 3000, depthTest = true } = {}) {
    this.engine = engine;
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxVerts * 3);
    this.off = new Float32Array(maxVerts * 3);
    this.side = new Float32Array(maxVerts);
    this.dist = new Float32Array(maxVerts);
    this.col = new Float32Array(maxVerts * 3);
    this.data = new Float32Array(maxVerts * 4);
    this.idx = new Uint32Array(maxVerts * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aOffset', new THREE.BufferAttribute(this.off, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDist', new THREE.BufferAttribute(this.dist, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aData', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPxScale: { value: 0.001 }, uFar: { value: 6000 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      side: THREE.DoubleSide,
    });
    this.material.customProgramCacheKey = () => 'tools-vector-v1';
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.layers.set(engine.LAYER_NO_AO);
    this.vi = 0; this.ii = 0;
  }

  begin() { this.vi = 0; this.ii = 0; }

  /**
   * points: [{x,y,z}] world-space centre line.
   * opts:   { color:[r,g,b], width(px), dash(m, 0=solid), alpha, glow, closed }
   */
  polyline(points, opts = {}) {
    const n = points.length;
    if (n < 2) return;
    const closed = !!opts.closed;
    const col = opts.color || PAL.accent;
    const w = opts.width == null ? 2.0 : opts.width;
    const dash = opts.dash || 0;
    const alpha = opts.alpha == null ? 1 : opts.alpha;
    const glow = opts.glow == null ? 0.35 : opts.glow;
    const count = closed ? n + 1 : n;
    if (this.vi + count * 2 > this.max) return;
    let run = 0;
    const P = this.pos, O = this.off, S = this.side, D = this.dist, C = this.col, T = this.data;
    const base = this.vi;
    for (let i = 0; i < count; i++) {
      const p = points[i % n];
      const prev = points[(i - 1 + n) % n];
      const next = points[(i + 1) % n];
      let dx = 0, dz = 0;
      const hasPrev = closed || i > 0;
      const hasNext = closed || i < n - 1;
      if (hasPrev) { const l = Math.hypot(p.x - prev.x, p.z - prev.z) || 1; dx += (p.x - prev.x) / l; dz += (p.z - prev.z) / l; }
      if (hasNext) { const l = Math.hypot(next.x - p.x, next.z - p.z) || 1; dx += (next.x - p.x) / l; dz += (next.z - p.z) / l; }
      const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      // perpendicular in XZ, miter-scaled (clamped so sharp corners do not explode)
      let miter = 1;
      if (hasPrev && hasNext) {
        const l1 = Math.hypot(p.x - prev.x, p.z - prev.z) || 1;
        const t1x = (p.x - prev.x) / l1, t1z = (p.z - prev.z) / l1;
        const cosH = Math.max(0.25, Math.sqrt(Math.max(0.0001, (1 + (t1x * dx + t1z * dz)) * 0.5)));
        miter = Math.min(2.6, 1 / cosH);
      }
      if (i > 0) run += Math.hypot(p.x - points[(i - 1 + n) % n].x, p.z - points[(i - 1 + n) % n].z);
      const nx = dz * miter, nz = -dx * miter;
      for (let s = 0; s < 2; s++) {
        const v = this.vi++;
        P[v * 3] = p.x; P[v * 3 + 1] = p.y; P[v * 3 + 2] = p.z;
        O[v * 3] = nx; O[v * 3 + 1] = 0; O[v * 3 + 2] = nz;
        S[v] = s === 0 ? -1 : 1;
        D[v] = run;
        C[v * 3] = col[0]; C[v * 3 + 1] = col[1]; C[v * 3 + 2] = col[2];
        T[v * 4] = w; T[v * 4 + 1] = dash; T[v * 4 + 2] = alpha; T[v * 4 + 3] = glow;
      }
    }
    for (let i = 0; i < count - 1; i++) {
      const a = base + i * 2;
      this.idx[this.ii++] = a; this.idx[this.ii++] = a + 1; this.idx[this.ii++] = a + 2;
      this.idx[this.ii++] = a + 1; this.idx[this.ii++] = a + 3; this.idx[this.ii++] = a + 2;
    }
  }

  end(camera, viewportHeight) {
    const g = this.geometry;
    const fov = (camera.fov || 42) * Math.PI / 180;
    this.material.uniforms.uPxScale.value = (2 * Math.tan(fov * 0.5)) / Math.max(1, viewportHeight);
    for (const k of ['position', 'aOffset', 'aSide', 'aDist', 'aColor', 'aData']) {
      const a = g.getAttribute(k);
      a.addUpdateRange(0, this.vi * a.itemSize);
      a.needsUpdate = true;
    }
    g.index.addUpdateRange(0, this.ii);
    g.index.needsUpdate = true;
    g.setDrawRange(0, this.ii);
    this.mesh.visible = this.ii > 0;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------

const FILL_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aUv;
attribute vec4 aData;      // x alpha  y pattern  z scale  w glow
varying vec3 vColor; varying vec2 vUv; varying vec4 vData; varying float vFade;
uniform float uFar;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = aColor; vUv = aUv; vData = aData;
  vFade = 1.0 - smoothstep(uFar * 0.6, uFar, max(-mv.z, 0.05));
}`;

const FILL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor; varying vec2 vUv; varying vec4 vData; varying float vFade;
uniform float uTime;
uniform float uNight;   // 0 day … 1 night — large washes are dialled back in the dark
void main() {
  int mode = int(vData.y + 0.5);
  float a = vData.x;
  vec3 c = vColor;
  if (mode == 1) {
    // ghost carriageway: soft body, moving hologram stripes, hot edges
    float across = abs(vUv.y);
    float edge = smoothstep(0.72, 1.0, across);
    float band = 1.0 - smoothstep(0.90, 1.0, across);
    float s = fract((vUv.x * 0.30 + vUv.y * 3.0) - uTime * 0.30);
    float stripe = smoothstep(0.46, 0.50, s) * (1.0 - smoothstep(0.60, 0.64, s));
    a *= band;
    a += stripe * 0.07 * band;
    a += edge * band * 0.55;
    a *= mix(1.0, 0.62, uNight);
    c *= 1.0 + edge * 2.0 + stripe * 0.35;
  } else if (mode == 2) {
    // zone cell: inset squircle with a bright rim
    vec2 p = abs(vUv - 0.5) * 2.0;
    float d = pow(pow(p.x, 6.0) + pow(p.y, 6.0), 1.0 / 6.0);
    float aa = max(fwidth(d), 0.012) * 1.4;
    float fill = 1.0 - smoothstep(0.80 - aa, 0.80 + aa, d);
    float rim = (1.0 - smoothstep(0.80 - aa, 0.80 + aa, d)) - (1.0 - smoothstep(0.60 - aa, 0.60 + aa, d));
    a *= (fill * 0.55 + rim * 0.85) * mix(1.0, 0.55, uNight);
    c *= 1.0 + rim * 1.5;
  } else if (mode == 3) {
    // coverage disc: a whisper of colour inside, a soft halo and a hot rim at the radius
    float r = vUv.x;
    float aa = max(fwidth(r), 0.0012);
    float body = 0.030 * smoothstep(1.02, 0.20, r) * mix(1.0, 0.30, uNight);
    float halo = smoothstep(0.55, 0.995, r) * 0.17 * mix(1.0, 0.45, uNight);
    float rim = 1.0 - smoothstep(0.0, aa * 4.0, abs(r - 0.995));
    float pulse = exp(-pow((r - fract(uTime * 0.20)) * 11.0, 2.0)) * 0.13;
    a *= body + halo + rim * 1.25 + pulse;
    c *= 1.0 + rim * 2.6 + pulse * 1.4;
  } else if (mode == 4) {
    // hatched danger fill (bulldoze / invalid)
    float s = fract((vUv.x + vUv.y) * vData.z - uTime * 0.25);
    float stripe = smoothstep(0.48, 0.52, s) * (1.0 - smoothstep(0.96, 1.0, s));
    a *= (0.20 + stripe * 0.42) * mix(1.0, 0.8, uNight);
    c *= 1.0 + stripe * 1.1;
  } else if (mode == 5) {
    // vertical hologram wall (service ghost / selection cage)
    float up = clamp(vUv.y, 0.0, 1.0);
    float grad = pow(1.0 - up, 1.6);
    float scan = 0.5 + 0.5 * sin((vUv.y * vData.z - uTime * 0.8) * 6.2831);
    a *= 0.16 + grad * 0.55 + scan * 0.10;
    c *= 1.0 + grad * 0.6;
  }
  a *= vFade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c * (1.0 + vData.w), min(a, 1.0));
}`;

/** Dynamic, one-draw-call surface layer (ghost roads, zone cells, coverage, footprints). */
export class FillLayer {
  constructor(engine, { maxVerts = 60000, renderOrder = 2900 } = {}) {
    this.max = maxVerts;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxVerts * 3);
    this.col = new Float32Array(maxVerts * 3);
    this.uv = new Float32Array(maxVerts * 2);
    this.data = new Float32Array(maxVerts * 4);
    this.idx = new Uint32Array(maxVerts * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aUv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aData', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFar: { value: 6000 }, uNight: { value: 0 } },
      vertexShader: FILL_VERT, fragmentShader: FILL_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
    });
    this.material.customProgramCacheKey = () => 'tools-fill-v1';
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.layers.set(engine.LAYER_NO_AO);
    this.vi = 0; this.ii = 0;
  }

  begin() { this.vi = 0; this.ii = 0; }

  vert(p, uvx, uvy, col, d) {
    const v = this.vi++;
    this.pos[v * 3] = p.x; this.pos[v * 3 + 1] = p.y; this.pos[v * 3 + 2] = p.z;
    this.uv[v * 2] = uvx; this.uv[v * 2 + 1] = uvy;
    this.col[v * 3] = col[0]; this.col[v * 3 + 1] = col[1]; this.col[v * 3 + 2] = col[2];
    this.data[v * 4] = d[0]; this.data[v * 4 + 1] = d[1]; this.data[v * 4 + 2] = d[2]; this.data[v * 4 + 3] = d[3];
    return v;
  }

  /** Quad p0→p1→p2→p3 (ccw) with uv corners uv0..uv3. */
  quad(p0, p1, p2, p3, uvs, col, d) {
    if (this.vi + 4 > this.max) return;
    const a = this.vert(p0, uvs[0], uvs[1], col, d);
    const b = this.vert(p1, uvs[2], uvs[3], col, d);
    const c = this.vert(p2, uvs[4], uvs[5], col, d);
    const e = this.vert(p3, uvs[6], uvs[7], col, d);
    this.idx[this.ii++] = a; this.idx[this.ii++] = b; this.idx[this.ii++] = c;
    this.idx[this.ii++] = a; this.idx[this.ii++] = c; this.idx[this.ii++] = e;
  }

  /** Ribbon between two matching edge polylines, uv.x = metres along, uv.y = -1..1 across. */
  strip(left, right, along, col, d) {
    const n = Math.min(left.length, right.length);
    if (n < 2 || this.vi + n * 2 > this.max) return;
    const base = this.vi;
    for (let i = 0; i < n; i++) {
      this.vert(left[i], along[i], -1, col, d);
      this.vert(right[i], along[i], 1, col, d);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx[this.ii++] = a; this.idx[this.ii++] = a + 1; this.idx[this.ii++] = a + 2;
      this.idx[this.ii++] = a + 1; this.idx[this.ii++] = a + 3; this.idx[this.ii++] = a + 2;
    }
  }

  end(time, night = 0) {
    const g = this.geometry;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uNight.value = night;
    for (const k of ['position', 'aColor', 'aUv', 'aData']) {
      const a = g.getAttribute(k);
      a.addUpdateRange(0, this.vi * a.itemSize);
      a.needsUpdate = true;
    }
    g.index.addUpdateRange(0, this.ii);
    g.index.needsUpdate = true;
    g.setDrawRange(0, this.ii);
    this.mesh.visible = this.ii > 0;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------

const FONT = "600 30px Inter, 'SF Pro Text', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";
const FONT_SM = "500 22px Inter, 'SF Pro Text', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";
const FONT_KEY = "600 20px Inter, 'SF Pro Text', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";

/**
 * World-anchored glass HUD chip. Constant screen size, always on top.
 * The canvas keeps a fixed size (resizing a live CanvasTexture triggers a partial-upload GL error);
 * the used sub-rectangle is exposed through the texture offset/repeat instead.
 */
const CW = 768, CH = 192;

export class Chip {
  constructor(engine, { heightFraction = 0.052, renderOrder = 4000 } = {}) {
    this.engine = engine;
    this.hf = heightFraction;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW; this.canvas.height = CH;
    this.ctx2d = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = engine.maxAnisotropy;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = renderOrder;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    this.sprite.layers.set(engine.LAYER_NO_AO);
    this.sprite.center.set(0.5, 0);
    this._key = '';
    this._aspect = 4;
  }

  /** spec: { title, value, sub, tone:'accent'|'good'|'bad'|'warn' } */
  set(spec) {
    const key = JSON.stringify(spec);
    if (key === this._key) return;
    this._key = key;
    const c = this.ctx2d;
    const tone = { accent: '#8fe0ff', good: '#8ff0a8', bad: '#ff9d94', warn: '#ffd27a' }[spec.tone || 'accent'];
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, CW, CH);
    c.font = FONT;
    const vw = spec.value ? c.measureText(spec.value).width : 0;
    c.font = FONT_SM;
    const tw = spec.title ? c.measureText(spec.title).width : 0;
    const sw = spec.sub ? c.measureText(spec.sub).width : 0;
    const padX = 22, padY = 15, gap = 14;
    const W = Math.min(CW, Math.ceil(Math.max(vw + (tw ? tw + gap : 0), sw, 96) + padX * 2));
    const H = Math.min(CH, Math.ceil((spec.value ? 36 : 26) + (spec.sub ? 28 : 0) + padY * 2));
    this._aspect = W / H;
    // glass panel
    const r = 13;
    roundRect(c, 1.5, 1.5, W - 3, H - 3, r);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(24,33,45,0.95)');
    g.addColorStop(1, 'rgba(9,13,19,0.95)');
    c.fillStyle = g; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.17)'; c.stroke();
    c.fillStyle = tone;
    roundRect(c, 2.5, H * 0.26, 3.5, H * 0.48, 2); c.fill();
    // text
    const baseY = padY + (spec.value ? 27 : 20);
    let x = padX;
    c.textBaseline = 'alphabetic';
    if (spec.value) {
      c.font = FONT; c.fillStyle = tone;
      c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 6; c.shadowOffsetY = 1;
      c.fillText(spec.value, x, baseY);
      c.shadowBlur = 0; c.shadowOffsetY = 0;
      x += vw + gap;
    }
    if (spec.title) {
      c.font = FONT_SM; c.fillStyle = spec.value ? 'rgba(216,228,240,0.88)' : '#e9eef4';
      c.fillText(spec.title, x, baseY);
    }
    if (spec.sub) {
      c.font = FONT_SM; c.fillStyle = 'rgba(154,172,190,0.95)';
      c.fillText(spec.sub, padX, baseY + 27);
    }
    // show only the used sub-rectangle (top-left corner of the atlas canvas)
    this.texture.offset.set(0, 1 - H / CH);
    this.texture.repeat.set(W / CW, H / CH);
    this.texture.needsUpdate = true;
  }

  place(x, y, z) { this.sprite.position.set(x, y, z); this.sprite.visible = true; }
  hide() { this.sprite.visible = false; }

  update(camera) {
    if (!this.sprite.visible) return;
    const fov = (camera.fov || 42) * Math.PI / 180;
    const sy = this.hf * 2 * Math.tan(fov * 0.5);
    this.sprite.scale.set(sy * this._aspect, sy, 1);
  }

  dispose() { this.texture.dispose(); this.material.dispose(); }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// --------------------------------------------------------------------------- helpers

/** Rounded-corner rectangle outline (world XZ), conformed to the ground. */
export function rectOutline(cx, cz, w, d, yaw, groundY, inset = 0, corner = 0) {
  const hw = Math.max(0.2, w / 2 - inset), hd = Math.max(0.2, d / 2 - inset);
  const r = Math.max(0, Math.min(corner, hw * 0.5, hd * 0.5));
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const local = (lx, lz) => { const x = cx + lx * cs - lz * sn, z = cz + lx * sn + lz * cs; return { x, y: groundY(x, z), z }; };
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = signs[i];
    if (r < 0.05) { pts.push(local(sx * hw, sz * hd)); continue; }
    const ccx = sx * (hw - r), ccz = sz * (hd - r);
    const t1 = [sx * (hw - r), sz * hd];   // tangent point on the ±z edge
    const t2 = [sx * hw, sz * (hd - r)];   // tangent point on the ±x edge
    const [a, b] = i % 2 === 0 ? [t2, t1] : [t1, t2];
    let a0 = Math.atan2(a[1] - ccz, a[0] - ccx);
    let a1 = Math.atan2(b[1] - ccz, b[0] - ccx);
    let dA = a1 - a0;
    while (dA > Math.PI) dA -= Math.PI * 2;
    while (dA < -Math.PI) dA += Math.PI * 2;
    for (let k = 0; k <= 4; k++) {
      const ang = a0 + dA * (k / 4);
      pts.push(local(ccx + Math.cos(ang) * r, ccz + Math.sin(ang) * r));
    }
  }
  return pts;
}

/** Corner brackets (CS2 selection style): 4 short L shapes at the box corners. */
export function cornerBrackets(cx, cz, w, d, yaw, groundY, frac = 0.28) {
  const hw = w / 2, hd = d / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const lx = Math.min(hw * frac * 2, hw * 0.9), lz = Math.min(hd * frac * 2, hd * 0.9);
  const local = (a, b) => { const x = cx + a * c - b * s, z = cz + a * s + b * c; return { x, y: groundY(x, z), z }; };
  const out = [];
  const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of signs) {
    out.push([local(sx * hw - sx * lx, sz * hd), local(sx * hw, sz * hd), local(sx * hw, sz * hd - sz * lz)]);
  }
  return out;
}

/** Circle / arc polyline conformed to the ground. */
export function arc(cx, cz, r, a0, a1, groundY, segments = 0) {
  const span = a1 - a0;
  const n = segments || Math.max(8, Math.min(160, Math.ceil(Math.abs(span) * r * 0.5)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (span * i) / n;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    pts.push({ x, y: groundY(x, z), z });
  }
  return pts;
}
