/**
 * WetLights — the real light emitters the wet-road mirror has to carry.
 *
 * The p5 critic blocker: at night the street lamps, vehicle head- and tail-lights sit ABOVE the
 * frame the SSR march can reach (or are off-screen entirely), so every ray missed and the wet
 * carriageway fell back to a uniform haze wash — twelve lit lamps over a wet road and not one
 * reflected column. Screen-space reflection fundamentally cannot see an emitter that is not on
 * screen, so this module supplies the analytic term: the nearest N emitters are fed to
 * GroundFXPass as a small uniform array and the shader evaluates a stretched, rippled mirror
 * streak for each one.
 *
 * Sources (read-only, no other module is modified):
 *  - Street lamps: the `roads/lamps` and `roads/masts` InstancedMeshes. Harvested on a timer (the
 *    set only changes when the road network changes). The bulb sits at the centroid of the glow
 *    material group of the lamp geometry, in instance-local space — computed once per geometry
 *    and transformed by each instance matrix.
 *  - Vehicles: the `traffic-lamp-glare` billboards the traffic renderer already positions at every
 *    lit head- and tail-light each frame, with the radiance packed into the custom `aGlare`
 *    instance attribute (p6 audit: the harvester read `instanceColor`, which traffic never sets —
 *    so ZERO vehicle lights reached the mirror; aGlare carries the radiance directly in display
 *    units, no exposure recovery involved).
 */
import * as THREE from 'three';

const MAX_LIGHTS = 12;
const MAX_LAMPS = 512;
const GLARE_NAME = 'traffic-lamp-glare';
const LAMP_NAMES = ['roads/lamps', 'roads/masts'];

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Centroid of the vertices a material group covers — where the bulb is, in local space. */
function glowCentroid(geometry) {
  const groups = geometry.groups || [];
  const g = groups.find((gr) => gr.materialIndex === 1) || groups[groups.length - 1];
  if (!g) return new THREE.Vector3(0, 0, 0);
  const index = geometry.index ? geometry.index.array : null;
  const pos = geometry.attributes.position;
  _c.set(0, 0, 0);
  let n = 0;
  const end = Math.min(g.start + g.count, index ? index.length : pos.count);
  for (let i = g.start; i < end; i += 3) {
    const vi = index ? index[i] : i;
    _c.x += pos.getX(vi); _c.y += pos.getY(vi); _c.z += pos.getZ(vi);
    n++;
  }
  if (n) _c.divideScalar(n);
  return _c.clone();
}

export class WetLights {
  constructor() {
    /** Uniform-side storage: vec4(x, y, z, intensity) + radiance colour, MAX_LIGHTS entries. */
    this.pos = [];
    this.col = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      this.pos.push(new THREE.Vector4(0, -1e4, 0, 0));
      this.col.push(new THREE.Color(1, 1, 1));
    }
    this.count = 0;
    this.stats = { lamps: 0, vehicles: 0 };
    this._lamps = [];                 // { x, y, z, g } static lamp heads
    this._lampTimer = -1;             // < 0 → harvest on the first update
    this._lampGeo = new WeakMap();    // geometry → bulb centroid
    this._glare = null;
    this._candidates = [];
  }

  /** Re-read the street-lamp instances. Only called when the network may have changed. */
  _harvestLamps(scene) {
    this._lamps.length = 0;
    scene.traverse((o) => {
      if (!o.isInstancedMesh || LAMP_NAMES.indexOf(o.name) < 0 || !o.visible) return;
      let bulb = this._lampGeo.get(o.geometry);
      if (!bulb) { bulb = glowCentroid(o.geometry); this._lampGeo.set(o.geometry, bulb); }
      const n = Math.min(o.count || 0, MAX_LAMPS);
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, _m);
        _m.decompose(_p, _q, _s);
        if (_p.y < -5000) continue;
        // bulb = instance position + the local centroid rotated/scaled by the instance transform
        _c.copy(bulb).multiply(_s).applyQuaternion(_q);
        this._lamps.push({ x: _p.x + _c.x, y: _p.y + _c.y, z: _p.z + _c.z });
      }
    });
    this.stats.lamps = this._lamps.length;
  }

  /**
   * Refresh the uniform array. `glareExposure` is the tone-mapping exposure the traffic renderer
   * divided its glare radiance by when it wrote the instance colours.
   * @returns {number} how many emitters were published
   */
  update(dt, scene, camera, roadsVersion, glareExposure) {
    // lamps only change with the network; re-scan at most ~2x/s and on version bumps
    this._lampTimer -= dt;
    if (this._lampTimer < 0 || roadsVersion !== this._lampVersion) {
      this._lampVersion = roadsVersion;
      this._lampTimer = 0.5;
      this._harvestLamps(scene);
    }
    if (!this._glare || !this._glare.parent) {
      this._glare = null;
      scene.traverse((o) => { if (!this._glare && o.isInstancedMesh && o.name === GLARE_NAME) this._glare = o; });
    }

    camera.getWorldPosition(_cam);
    // p10 ROOT CAUSE (why vehicle rivers/columns starve at night): the traffic writer scales aGlare
    // by gs = 1/max(0.6, toneMappingExposure) — DISPLAY-REFERRED so the billboards look right at the
    // current eye adaptation. Night exposure is 3.15 (atmosphere.exposureForSun), so every vehicle
    // emitter reached the mirror at 0.317x of its authored radiance — the p9 probe measured a live
    // tail slot at i=1.1 where the authored value is ~3.4. The wet mirror is a LIGHT-TRANSPORT term:
    // it needs the physical radiance, so undo the writer's division here. Lamps stay absolute.
    const rec = Math.max(0.6, glareExposure || 1);
    // p9 root cause 3: "nearest 12" is fundamentally wrong for any camera above the rooftops. What
    // matters is whether the emitter's REFLECTION LOCUS lands inside the view frustum — and the locus
    // of a lamp 8 m from a 20 m-high camera is ~5 m from the camera footprint, i.e. BEHIND the frame
    // (a 16° pitch frustum first touches ground ~4·camY out). Rank by the angular deviation of the
    // emitter seen from the camera MIRRORED about the road plane: that is exactly the direction the
    // reflected view ray travels, so in-frustum emitters win no matter the camera height.
    _fwd.setFromMatrixColumn(camera.matrixWorld, 2).negate();   // camera looks down -Z
    const mcY = -_cam.y;                                        // mirrored camera height
    const cand = this._candidates;
    cand.length = 0;
    for (const l of this._lamps) {
      const dx = l.x - _cam.x, dy = l.y - _cam.y, dz = l.z - _cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 62500) continue;                       // 250 m: past that the smear is sub-pixel
      // direction from the MIRRORED camera to the emitter (the reflected ray's world direction)
      const rx = l.x - _cam.x, ry = l.y - mcY, rz = l.z - _cam.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
      const cosA = (rx * _fwd.x + ry * _fwd.y + rz * _fwd.z) / rl;   // 1 = dead-centre of the view
      // p7: 2.1 → 3.2 — the p6 audit measured the lamp columns visibly dimmer than the CS2
      // reference; the pool column has to read at a glance.
      cand.push({ x: l.x, y: l.y, z: l.z, r: 1.00, g: 0.80, b: 0.58, i: 3.2, d2, cosA });
    }
    const glare = this._glare;
    // p6 audit root cause: traffic writes radiance into the CUSTOM `aGlare` InstancedBufferAttribute
    // (Renderer.js: `this.glareC = instAttr(glareGeom, 'aGlare', 3, MAX_GLARE)`) — `instanceColor`
    // is never allocated on that mesh, so the old read always saw zeros and no vehicle light ever
    // reached the wet mirror. Read aGlare; its values are already display-unit radiance
    // (head 1.32·hI / tail 1.0·tI), so no exposure recovery is applied.
    const glareAttr = glare ? glare.geometry.getAttribute('aGlare') : null;
    if (glare && glare.visible && glare.count > 0 && glareAttr) {
      // p9 root cause 2: the cap was 260 of up to 900 instances — the writer fills glares in traffic
      // iteration order (mostly FAR vehicles), so the camera-near queue was never even read and the
      // 12 slots went to 200 m tails (att ≈ 0.03 → invisible). Read them all; the d2 sort below
      // already picks the nearest.
      const n = Math.min(glare.count, 900);
      for (let i = 0; i < n; i++) {
        glare.getMatrixAt(i, _m);
        // the glare quads face the camera and carry no scale in a fixed 1x1 plane — the position
        // column is what we need; decompose to be safe against future compose() changes
        _m.decompose(_p, _q, _s);
        const r = glareAttr.array[i * 3] || 0;
        const g = glareAttr.array[i * 3 + 1] || 0;
        const b = glareAttr.array[i * 3 + 2] || 0;
        const maxC = Math.max(r, g, b);
        if (maxC < 0.02) continue;
        const dxv = _p.x - _cam.x, dyv = _p.y - _cam.y, dzv = _p.z - _cam.z;
        const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
        if (d2 > 40000) continue;                     // 200 m
        const rx = _p.x - _cam.x, ry = _p.y - mcY, rz = _p.z - _cam.z;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        const cosA = (rx * _fwd.x + ry * _fwd.y + rz * _fwd.z) / rl;
        // p9: red-dominant (tail) emitters carry a higher mirror intensity — their radiance is
        // genuinely dimmer than headlamps, and the shader stretches rather than brightens the smear.
        const redDom = r > 2.5 * Math.max(g, 0.02);
        cand.push({ x: _p.x, y: _p.y, z: _p.z, r: r / maxC, g: g / maxC, b: b / maxC, i: maxC * (redDom ? 2.6 : 1.5) * rec, d2, cosA, redDom });
      }
    }
    this.stats.vehicles = cand.length - this.stats.lamps;

    // p9: in-frustum wins — rank by angular deviation from the mirrored-camera view direction, then
    // by distance as a tie-break. cosA < 0.2 (~78° off-axis) is outside any of our framings.
    cand.sort((a, b) => (b.cosA - a.cosA) || (a.d2 - b.d2));
    for (let i = cand.length - 1; i >= 0; i--) if (cand[i].cosA < 0.2) cand.splice(i, 1);
    // p10: the 12 slots are pure cosA, and a corridor full of on-axis headlamps + high masts evicts
    // every tail light — the p9 probe showed exactly 1 tail in 12 slots while red_ground stayed at
    // 0.1-0.26 % of the reference's 12.8 %. Reserve the last 4 slots for red-dominant (tail) emitters:
    // promote the best-ranked tails that did not make the cut. Lamps and heads keep competing for 8.
    let tailsIn = 0;
    for (let i = 0; i < Math.min(cand.length, MAX_LIGHTS); i++) if (cand[i].redDom) tailsIn++;
    if (tailsIn < 4) {
      const promoted = [];
      for (let i = MAX_LIGHTS; i < cand.length && promoted.length < 4 - tailsIn; i++) {
        if (cand[i].redDom) promoted.push(cand[i]);
      }
      for (const p of promoted) {
        // evict from the back of the top-12, preferring non-tail slots
        let ev = -1;
        for (let i = MAX_LIGHTS - 1; i >= 0; i--) if (!cand[i].redDom) { ev = i; break; }
        if (ev < 0) ev = MAX_LIGHTS - 1;
        cand.splice(ev, 0, p);
        cand.splice(MAX_LIGHTS, 1);
      }
    }
    this.count = Math.min(cand.length, MAX_LIGHTS);
    for (let i = 0; i < this.count; i++) {
      const s = cand[i];
      this.pos[i].set(s.x, s.y, s.z, s.i);
      this.col[i].setRGB(s.r, s.g, s.b);
    }
    for (let i = this.count; i < MAX_LIGHTS; i++) this.pos[i].w = 0;
    return this.count;
  }

  dispose() { this._lamps.length = 0; this._candidates.length = 0; }
}
