/**
 * In-world visualisation of the soundscape (showcase / ?audiodebug=1 only — audio is invisible).
 *
 * Two elements, both designed to read like an info-view overlay rather than debug scribble:
 *   • a "sound glyph" sprite (dot + two radiating arcs, drawn procedurally into a canvas) over every
 *     live emitter — cyan over each vehicle whose engine you can hear, category-coloured over each
 *     zone-ambience cluster (industry orange, commerce magenta, residential green, office blue,
 *     construction yellow, park teal), red/amber over sirens and horns. Sprites have
 *     sizeAttenuation off, so a marker is ~30 px whether the camera is at the kerb or 300 m up, and
 *     depthTest on, so a building in front hides the marker behind it.
 *   • a ground ripple expanding from every one-shot event at 34 m/s and fading out — a thin ring
 *     whose vertices are lifted onto the terrain, so it runs over the road crown and the kerbs.
 * No shadows, no lit materials, LAYER_NO_AO, opacity ≤ 0.6. Hidden entirely with ?audiodebug=0.
 */
import * as THREE from 'three';

const COLORS = {
  siren: [new THREE.Color(0xff4d4d), new THREE.Color(0x4d9bff)],
  horn: [new THREE.Color(0xffc04a)],
  bell: [new THREE.Color(0xffe9b0)],
  thunder: [new THREE.Color(0xd8e6ff)],
  carpass: [new THREE.Color(0x8fe3ff)],
};
/** Ripple reach in metres per event kind (0 = no ripple). */
const REACH = { siren: 58, horn: 24, bell: 85, thunder: 0, carpass: 0 };
const ZONE_COLORS = {
  ind: new THREE.Color(0xff9433), com: new THREE.Color(0xff63c8), res: new THREE.Color(0x74e896),
  office: new THREE.Color(0x6cb0ff), construction: new THREE.Color(0xffd94f), park: new THREE.Color(0x4bdcc6),
};
const VEHICLE_COLOR = new THREE.Color(0x9fe8ff);
const RIPPLE_SPEED = 34;      // m/s
const SEGMENTS = 64;
const LIFT = 0.3;             // ring height above the terrain: clears road crown, kerb, sidewalk

/** The "this is making a sound" glyph: a dot with two radiating arcs, white on transparent. */
function glyphTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  // a soft dark halo baked into the glyph keeps it readable on white facades and on night asphalt
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = S * 0.07;
  g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.085, 0, Math.PI * 2); g.fill();
  const arc = (r, w, a) => {
    g.globalAlpha = a; g.lineWidth = w;
    g.beginPath(); g.arc(S * 0.5, S * 0.5, r, -Math.PI * 0.42, Math.PI * 0.42); g.stroke();
    g.beginPath(); g.arc(S * 0.5, S * 0.5, r, Math.PI * 0.58, Math.PI * 1.42); g.stroke();
  };
  arc(S * 0.22, S * 0.075, 0.95);
  arc(S * 0.37, S * 0.062, 0.62);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** A ring whose vertices are lifted onto the terrain, so it hugs kerbs and slopes. */
class GroundRing {
  constructor(world, color, opacity, thickness = 0.5) {
    this.world = world;
    this.thickness = thickness;
    const pos = new Float32Array(SEGMENTS * 2 * 3);
    const idx = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2, b = a + 1, c = ((i + 1) % SEGMENTS) * 2, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
  }
  place(x, z, r) {
    const w = Math.max(0.25, this.thickness * Math.max(1, Math.sqrt(r)));
    const p = this.geo.attributes.position.array;
    const t = this.world.terrain;
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const xi = x + ca * (r - w * 0.5), zi = z + sa * (r - w * 0.5);
      const xo = x + ca * (r + w * 0.5), zo = z + sa * (r + w * 0.5);
      const yi = t.getHeight(xi, zi), yo = t.getHeight(xo, zo);
      const k = i * 6;
      p[k] = xi; p[k + 1] = (Number.isFinite(yi) ? yi : 0) + LIFT; p[k + 2] = zi;
      p[k + 3] = xo; p[k + 4] = (Number.isFinite(yo) ? yo : 0) + LIFT; p[k + 5] = zo;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeBoundingSphere();
    this.mesh.visible = true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

export class EmitterMarkers {
  constructor(scene, world, engine, camera) {
    this.scene = scene;
    this.world = world;
    this.engine = engine;
    this.camera = camera || null;
    this.group = new THREE.Group();
    this.group.name = 'audio-emitter-markers';
    scene.add(this.group);
    this.enabled = true;
    this.time = 0;
    this.tex = glyphTexture();
    this.vehicleGlyphs = [];
    this.zoneGlyphs = [];
    this.eventGlyphs = [];
    this.ripples = [];
    this.rippleRings = [];
    this.freeRings = [];
    engine.registerObject(this.group);
  }

  _glyph(pool) {
    const mat = new THREE.SpriteMaterial({
      map: this.tex, color: 0xffffff, transparent: true, opacity: 0.9,
      depthTest: true, depthWrite: false, sizeAttenuation: false,
      toneMapped: false, fog: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.castShadow = false; sp.receiveShadow = false;
    sp.renderOrder = 42;
    sp.visible = false;
    if (this.engine.LAYER_NO_AO != null) sp.layers.enable(this.engine.LAYER_NO_AO);
    this.group.add(sp);
    pool.push(sp);
    return sp;
  }

  /**
   * Place `list` on `pool` as constant-screen-size glyphs. `lift` = metres above the emitter; a
   * cluster that carries a roof height (`top`) is lifted above the block it belongs to instead, so
   * the marker clears the towers and is visible from an overview camera.
   */
  _syncGlyphs(list, pool, lift, size, colorOf, levelOf) {
    while (pool.length < list.length) this._glyph(pool);
    const aspect = this.camera && this.camera.aspect ? this.camera.aspect : 1.78;
    for (let i = 0; i < pool.length; i++) {
      const sp = pool[i];
      const v = list[i];
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.z)) { sp.visible = false; continue; }
      const gy = Number.isFinite(v.y) ? v.y : this.world.terrain.getHeight(v.x, v.z);
      const base = (Number.isFinite(gy) ? gy : 0) + lift;
      sp.position.set(v.x, Number.isFinite(v.top) && v.top > 0 ? Math.max(base, v.top + 7) : base, v.z);
      const lvl = Math.min(1, levelOf ? levelOf(v) : 0.5);
      const pulse = 0.86 + 0.14 * Math.sin(this.time * 3.4 + i * 1.9);
      const s = size * (0.85 + 0.25 * lvl) * pulse;
      sp.scale.set(s * aspect, s, 1);
      sp.material.color.copy(colorOf(v));
      sp.material.opacity = (0.62 + 0.33 * lvl) * pulse;
      sp.visible = true;
    }
  }

  /** @param active OneShots events, @param now audio clock, @param vehicles traffic voices, @param zones zone clusters */
  update(dt, active, now, vehicles = [], zones = []) {
    if (!this.enabled) return;
    this.time += dt;
    this._syncGlyphs(vehicles, this.vehicleGlyphs, 2.4, 0.046, () => VEHICLE_COLOR, (v) => (v.level ?? 0.5) * 1.6);
    this._syncGlyphs(zones, this.zoneGlyphs, 11, 0.058, (v) => ZONE_COLORS[v.cat] || VEHICLE_COLOR, (v) => (v.level ?? 0.4) * 2);

    const evs = [];
    for (const ev of active) {
      if (now < ev.start || now > ev.end) continue;
      if (!Number.isFinite(ev.x) || !Number.isFinite(ev.z)) continue;
      const palette = COLORS[ev.kind] || COLORS.horn;
      ev._col = ev.kind === 'siren' ? palette[Math.floor(now * 2.4) % 2] : palette[0];
      evs.push(ev);
      if (!REACH[ev.kind]) continue;
      const acc = (ev._ripAcc || 0) + dt;
      const period = ev.kind === 'siren' ? 0.75 : 1.0;
      if (acc >= period) {
        ev._ripAcc = acc - period;
        this.ripples.push({ ring: null, x: ev.x, z: ev.z, age: 0, life: REACH[ev.kind] / RIPPLE_SPEED, reach: REACH[ev.kind], color: ev._col.clone() });
      } else ev._ripAcc = acc;
    }
    this._syncGlyphs(evs, this.eventGlyphs, 3.6, 0.072, (e) => e._col, (e) => 0.6 + 0.4 * (e.level ?? 0.5));

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const x = r.age / r.life;
      if (x >= 1) { if (r.ring) { r.ring.mesh.visible = false; this.freeRings.push(r.ring); } this.ripples.splice(i, 1); continue; }
      if (!r.ring) r.ring = this.freeRings.pop() || this._ripple(r.color);
      r.ring.place(r.x, r.z, 1.2 + x * r.reach);
      r.ring.mat.color.copy(r.color).multiplyScalar(1.9);
      r.ring.mat.opacity = 0.55 * (1 - x) * (1 - x);
    }
  }

  _ripple(color) {
    const ring = new GroundRing(this.world, color, 0.5, 0.34);
    if (this.engine.LAYER_NO_AO != null) ring.mesh.layers.enable(this.engine.LAYER_NO_AO);
    this.group.add(ring.mesh);
    this.rippleRings.push(ring);
    return ring;
  }

  clear() {
    for (const r of this.ripples) if (r.ring) { r.ring.mesh.visible = false; this.freeRings.push(r.ring); }
    this.ripples.length = 0;
    for (const p of [this.vehicleGlyphs, this.zoneGlyphs, this.eventGlyphs]) for (const s of p) s.visible = false;
  }

  dispose() {
    this.clear();
    for (const p of [this.vehicleGlyphs, this.zoneGlyphs, this.eventGlyphs]) for (const s of p) { this.group.remove(s); s.material.dispose(); }
    for (const r of this.rippleRings) { this.group.remove(r.mesh); r.dispose(); }
    this.tex.dispose();
    this.scene.remove(this.group);
  }
}
