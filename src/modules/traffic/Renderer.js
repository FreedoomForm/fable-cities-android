/**
 * traffic — instanced renderer.
 *
 * Two LODs per vehicle type (near casts shadows and carries mirrors, trim and a 12-sided wheel;
 * far drops to a coarse shell) plus one instanced wheel mesh, one instanced pedestrian mesh per
 * LOD and two additive night passes (headlight ground pools + lamp glare). A busy city is ~18 draw
 * calls in the main pass.
 */
import * as THREE from 'three';
import { VEHICLE_SPECS, VEHICLE_IDS, PAINT_COLOURS, BOX_COLOURS, buildVehicleGeometry, buildWheelGeometry, buildShadowProxyGeometry, axlesOf } from './VehicleModels.js';
import { buildPedestrianGeometry } from './PedestrianModel.js';
import { createVehicleMaterial, createPedestrianMaterial, createPedestrianDepthMaterial, createBeamMaterial, createGlareMaterial, createContactShadowMaterial, createSentinelMaterials, lampUniforms, envUniforms } from './materials.js';

const NEAR_LOD = 50;
const MAX_BEAMS = 420;      // headlight cones + the red wash behind braking cars
const MAX_GLARE = 900;
const MAX_CONTACT = 900;    // grounding decals: every visible vehicle and pedestrian gets one

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _off = new THREE.Vector3();
const XAXIS = new THREE.Vector3(1, 0, 0);
const YAXIS = new THREE.Vector3(0, 1, 0);

function palette(list) {
  const c = new THREE.Color();
  return list.map((hex) => { c.setHex(hex, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; });
}
/** 256-entry weighted lookup so a vehicle's paint is a single array index. */
function weightedTable(pairs) {
  const cols = palette(pairs.map((p) => p[1]));
  const table = new Uint8Array(256);
  let acc = 0, k = 0;
  const total = pairs.reduce((s, p) => s + p[0], 0);
  for (let i = 0; i < 256; i++) {
    const t = (i + 0.5) / 256 * total;
    while (k < pairs.length - 1 && t > acc + pairs[k][0]) { acc += pairs[k][0]; k++; }
    table[i] = k;
  }
  return { cols, table };
}

const SHIRTS = palette([0xcfd4d8, 0x3c5a86, 0x8c3a35, 0x2f4438, 0xd8c9a8, 0x4a4f57, 0x1f2a38, 0xb0603a,
  0x6a5b8c, 0x2b6b6b, 0xe0e2e6, 0x7d1f2c, 0x35526b, 0xa8a49a, 0x50331f, 0xd9a441]);
const PANTS = palette([0x2b3340, 0x3c3f45, 0x1c2028, 0x555a60, 0x6e6455, 0x2a3b52, 0x3f3630, 0x1a1d22]);

function lampOffsets(spec) {
  const hw = spec.wid * 0.5, hz = spec.len * 0.5;
  if (spec.kind === 'car') {
    const ly = spec.sill + (spec.belt - spec.sill) * 0.62;
    const ty = spec.sill + (spec.belt - spec.sill) * 0.66;
    return { head: [[-hw * 0.60, ly, hz], [hw * 0.60, ly, hz]],
      tail: [[-hw * 0.66, ty, -hz], [hw * 0.66, ty, -hz]] };
  }
  if (spec.kind === 'box') {
    return { head: [[-hw * 0.66, spec.belt * 0.68, hz], [hw * 0.66, spec.belt * 0.68, hz]],
      tail: [[-hw * 0.78, spec.roof - 1.05, -hz], [hw * 0.78, spec.roof - 1.05, -hz]] };
  }
  if (spec.kind === 'truck') {
    return { head: [[-hw * 0.70, 1.02, spec.cabZ[1]], [hw * 0.70, 1.02, spec.cabZ[1]]],
      tail: [[-hw * 0.78, spec.boxBottom - 0.20, spec.boxZ[0]], [hw * 0.78, spec.boxBottom - 0.20, spec.boxZ[0]]] };
  }
  return { head: [[-hw * 0.68, spec.floor + 0.26, hz], [hw * 0.68, spec.floor + 0.26, hz]],
    tail: [[-hw * 0.72, spec.winLo - 0.42, -hz], [hw * 0.72, spec.winLo - 0.42, -hz]] };
}

function instAttr(geom, name, size, capacity, fill) {
  const arr = new Float32Array(size * capacity);
  if (fill) for (let i = 0; i < arr.length; i++) arr[i] = fill[i % size];
  const a = new THREE.InstancedBufferAttribute(arr, size);
  a.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute(name, a);
  return a;
}

export class TrafficRenderer {
  constructor(ctx, capacity, pedCapacity) {
    const { engine, scene } = ctx;
    this.engine = engine;
    this.capacity = capacity;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);

    this.paint = weightedTable(PAINT_COLOURS);
    this.box = { cols: palette(BOX_COLOURS) };
    this.material = createVehicleMaterial(engine);
    this.pedMaterial = createPedestrianMaterial(engine);
    this.pedDepth = createPedestrianDepthMaterial();

    // --- vehicle bodies
    this.bodies = {};
    for (const id of VEHICLE_IDS) {
      const perType = Math.max(24, Math.ceil(capacity * Math.min(1, VEHICLE_SPECS[id].weight * 2.4 + 0.12)));
      this.bodies[id] = [0, 1].map((lod) => {
        const geom = buildVehicleGeometry(id, lod);
        const mesh = new THREE.InstancedMesh(geom, this.material, perType);
        instAttr(geom, 'aPaint', 3, perType);
        instAttr(geom, 'aPaint2', 3, perType);
        instAttr(geom, 'aState', 3, perType);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // The near shell casts its real silhouette; the far shell hands shadow duty to the box
        // proxy below. Before this pass NOTHING past 50 m cast a sun shadow at all.
        mesh.castShadow = lod === 0;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.name = `traffic-${id}-lod${lod}`;
        this.group.add(mesh);
        return mesh;
      });
    }

    // --- shadow-only proxies for the far LOD.
    //     colorWrite off means these draw nothing in the beauty pass; they exist purely so every
    //     vehicle out to the draw distance lands a shadow on the road for ~0.4% of the triangles
    //     the real shell would cost across four cascades. They share the far LOD's instanceMatrix,
    //     so positioning them is free.
    this.proxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.proxyMat.name = 'traffic/shadow_proxy';
    this.shadowProxy = {};
    for (const id of VEHICLE_IDS) {
      const far = this.bodies[id][1];
      const mesh = new THREE.InstancedMesh(buildShadowProxyGeometry(far.geometry), this.proxyMat, far.instanceMatrix.count);
      mesh.instanceMatrix = far.instanceMatrix;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      mesh.count = 0;
      mesh.name = `traffic-${id}-shadow`;
      this.group.add(mesh);
      this.shadowProxy[id] = mesh;
    }

    // --- wheels (one mesh for the whole fleet per LOD)
    const wheelCap = [Math.min(capacity, 112) * 4, capacity * 4];
    this.wheels = [0, 1].map((lod) => {
      const geom = buildWheelGeometry(lod);
      const mesh = new THREE.InstancedMesh(geom, this.material, wheelCap[lod]);
      instAttr(geom, 'aPaint', 3, wheelCap[lod], [0, 0, 0]);
      instAttr(geom, 'aPaint2', 3, wheelCap[lod], [0, 0, 0]);
      instAttr(geom, 'aState', 3, wheelCap[lod], [0, 0, 0]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = lod === 0;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = `traffic-wheels-lod${lod}`;
      this.group.add(mesh);
      return mesh;
    });

    // --- pedestrians
    this.pedCap = Math.max(64, pedCapacity || Math.ceil(capacity * 1.5));
    this.peds = [0, 1].map((lod) => {
      const geom = buildPedestrianGeometry(lod);
      const mesh = new THREE.InstancedMesh(geom, this.pedMaterial, this.pedCap);
      this[`pedPaint${lod}`] = instAttr(geom, 'aPaint', 3, this.pedCap);
      this[`pedPaint2${lod}`] = instAttr(geom, 'aPaint2', 3, this.pedCap);
      this[`pedWalk${lod}`] = instAttr(geom, 'aWalk', 3, this.pedCap);
      instAttr(geom, 'aState', 3, this.pedCap, [0, 0, 0]);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.customDepthMaterial = this.pedDepth;
      mesh.count = 0;
      mesh.name = `traffic-peds-lod${lod}`;
      this.group.add(mesh);
      return mesh;
    });

    // --- night: headlight pools + lamp glare
    const beamGeom = new THREE.PlaneGeometry(1, 1);
    this.beamMat = createBeamMaterial();
    this.beams = new THREE.InstancedMesh(beamGeom, this.beamMat, MAX_BEAMS);
    this.beamI = instAttr(beamGeom, 'aIntensity', 1, MAX_BEAMS);
    this.beamC = instAttr(beamGeom, 'aBeamCol', 3, MAX_BEAMS, [1, 0.86, 0.66]);
    this.beamSh = instAttr(beamGeom, 'aShape', 1, MAX_BEAMS);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.renderOrder = 12;
    this.beams.layers.set(engine.LAYER_NO_AO);
    this.beams.name = 'traffic-headlight-pools';
    this.group.add(this.beams);

    const glareGeom = new THREE.PlaneGeometry(1, 1);
    this.glareMat = createGlareMaterial();
    this.glare = new THREE.InstancedMesh(glareGeom, this.glareMat, MAX_GLARE);
    this.glareC = instAttr(glareGeom, 'aGlare', 3, MAX_GLARE);
    this.glareS = instAttr(glareGeom, 'aSize', 1, MAX_GLARE);
    this.glare.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glare.frustumCulled = false;
    this.glare.count = 0;
    this.glare.renderOrder = 13;
    this.glare.layers.set(engine.LAYER_NO_AO);
    this.glare.name = 'traffic-lamp-glare';
    this.group.add(this.glare);

    // --- contact shadows: one multiply-blended footprint decal per visible agent
    const contactGeom = new THREE.PlaneGeometry(1, 1);
    this.contactMat = createContactShadowMaterial();
    this.contact = new THREE.InstancedMesh(contactGeom, this.contactMat, MAX_CONTACT);
    this.contactD = instAttr(contactGeom, 'aDark', 1, MAX_CONTACT);
    this.contactS = instAttr(contactGeom, 'aShape', 1, MAX_CONTACT);   // 1 vehicle (axle patches), 0 ped
    this.contact.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.contact.frustumCulled = false;
    this.contact.count = 0;
    this.contact.renderOrder = 8;
    this.contact.layers.set(engine.LAYER_NO_AO);
    this.contact.name = 'traffic-contact-shadows';
    this.group.add(this.contact);

    // p5 major 1: LOD 0 wheels ARE in the shadow map now — four cascades of the ~120 near
    // vehicles' rims cost a fraction of the triangle budget and are what puts darkening under
    // and between the tyres. LOD 1 has no instanced wheels (they are baked into the far shell,
    // which casts through the shadow proxy), so nothing changes past the LOD switch.

    // --- audit sentinels (p5 minor 1): the glass / chrome / tyre / lens response targets live in
    //     the vehicle shader, invisible to matstats.mjs. Hold them on an invisible mesh so the
    //     audit sees the module's real numbers at zero instance / triangle / draw-call cost.
    this.sentinelMesh = new THREE.Mesh(new THREE.BufferGeometry(), createSentinelMaterials(engine));
    this.sentinelMesh.name = 'traffic-material-sentinels';
    this.sentinelMesh.visible = false;
    this.sentinelMesh.frustumCulled = false;
    this.group.add(this.sentinelMesh);

    this._counts = {};
    this._beamList = [];
    this._contactN = 0;
    this._sun = new THREE.Vector3(0.4, -0.7, 0.35);
  }

  paintOf(seed) {
    const t = this.paint;
    return t.cols[t.table[seed & 255]];
  }
  boxOf(seed) { return this.box.cols[(seed >> 3) % this.box.cols.length]; }

  /** Rebuild every instance buffer from the current agent state. */
  sync(vehicles, peds, camera, opts) {
    lampUniforms.uLampExposure.value = this.engine.renderer.toneMappingExposure || 1;
    // The scene probe is dialled to ~0.52, which halves every reflection. Undo it for vehicles so
    // glass and clearcoat see a full-strength sky; collapses to 1.0 if the probe is raised.
    // p5 minor 2: DEFENSIVE CLAMP — uEnvComp never exceeds 1.9. This whole uniform is a
    // workaround for a probe below 1.0; when the environment module raises
    // scene.environmentIntensity toward 1.0 (core IBL split), uEnvComp collapses to 1.0 and the
    // per-class boosts in materials.js (glass 1.05, clearcoat 1.6, chrome 2.0) become the FINAL
    // authored values. If the probe moves, re-tune that set — do not grow this multiplier.
    const envI = this.engine.scene && this.engine.scene.environmentIntensity;
    envUniforms.uEnvComp.value = envI > 0.05 ? Math.min(1.9, 1 / envI) : 1;
    // Analytic sun glint (paint clearcoat) tracks the engine's own shadow-casting sun, and the
    // glass sky floor tracks the scene's published sky radiance — both read-only core state.
    const csm = this.engine.csm;
    if (csm && csm.lightDirection) {
      envUniforms.uSunDir.value.set(-csm.lightDirection.x, -csm.lightDirection.y, -csm.lightDirection.z).normalize();
    }
    const sunGain = (this.engine.sunIntensity || 0) * 0.12;
    envUniforms.uSunRad.value.copy(this.engine.sunColor || envUniforms.uSunRad.value).multiplyScalar(sunGain);
    const gu = this.engine.globalUniforms;
    if (gu && gu.uSkyUpRad && gu.uSkyHzRad) {
      envUniforms.uSkyUp.value.copy(gu.uSkyUpRad.value);
      envUniforms.uSkyHz.value.copy(gu.uSkyHzRad.value);
    }
    const drawDist = opts.drawDistance;
    const lightsOn = opts.lightsOn;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (const id of VEHICLE_IDS) { this._counts[id] = [0, 0]; }
    // Contact shadows lean away from the sun so they merge into the cast shadow rather than
    // fighting it; with the sun overhead they stay centred under the body.
    const sd = opts.sunDir;
    let shx = 0, shz = 0;
    if (sd) {
      const hl = Math.hypot(sd.x, sd.z);
      const lean = Math.min(0.55, (hl / Math.max(0.08, -sd.y)) * 0.16);
      if (hl > 1e-4) { shx = (sd.x / hl) * lean; shz = (sd.z / hl) * lean; }
    }
    const contactDark = opts.contact === undefined ? 1 : opts.contact;
    let ci = 0;
    const contactArr = this.contactD.array;
    let w0 = 0, w1 = 0;
    const wheelMax = [this.wheels[0].instanceMatrix.count, this.wheels[1].instanceMatrix.count];
    this._beamList.length = 0;

    for (let i = 0; i < vehicles.length; i++) {
      const veh = vehicles[i];
      const dx = veh.x - cx, dz = veh.z - cz, dy = veh.y - cy;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > drawDist * drawDist) continue;
      const d = Math.sqrt(d2);
      // Density LOD: past 245 m a vehicle is a dozen pixels wide, so thin the fleet out on a
      // stable per-vehicle key (never a frame counter — that would make distant traffic flicker).
      if (d > 245 && (veh.id & 1)) continue;
      if (d > 400 && (veh.id & 3)) continue;
      const lod = d < NEAR_LOD ? 0 : 1;
      const wheelsInstanced = lod === 0;
      const meshes = this.bodies[veh.type];
      const mesh = meshes[lod];
      const n = this._counts[veh.type][lod];
      if (n >= mesh.instanceMatrix.count) continue;

      _e.set(veh.pitch, veh.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _v.set(veh.x, veh.y, veh.z);
      _sc.set(veh.sw, veh.sh, veh.sl);
      _m.compose(_v, _q, _sc);
      mesh.setMatrixAt(n, _m);
      const paint = this.paintOf(veh.paint);
      const box = this.boxOf(veh.box);
      const ap = mesh.geometry.attributes.aPaint.array;
      ap[n * 3] = paint[0]; ap[n * 3 + 1] = paint[1]; ap[n * 3 + 2] = paint[2];
      const ap2 = mesh.geometry.attributes.aPaint2.array;
      ap2[n * 3] = box[0]; ap2[n * 3 + 1] = box[1]; ap2[n * 3 + 2] = box[2];
      const as = mesh.geometry.attributes.aState.array;
      as[n * 3] = lightsOn;
      as[n * 3 + 1] = veh.brake;
      as[n * 3 + 2] = veh.blink;
      this._counts[veh.type][lod] = n + 1;

      if (ci < MAX_CONTACT && d < 400) {
        const spc = veh.spec;
        const cw = spc.wid * veh.sw * 1.70, cl = spc.len * veh.sl * 1.26;
        _e.set(Math.PI * 0.5, veh.yaw, 0, 'YXZ');
        _q2.setFromEuler(_e);
        _v.set(veh.x + shx * spc.wid, veh.y + 0.030, veh.z + shz * spc.wid);
        _sc.set(cw, cl, 1);
        _m.compose(_v, _q2, _sc);
        this.contact.setMatrixAt(ci, _m);
        // Occlusion under a car is ambient, not direct: it must not fade when the sun drops, or
        // a vehicle standing in building shade reads as pasted onto the road.
        contactArr[ci] = contactDark * 0.95 * (1 - Math.min(1, Math.max(0, (d - 260) / 140)));
        this.contactS.array[ci] = 1;   // vehicle footprint: per-axle wheel patches
        ci++;
      }

      // wheels — only the near LOD gets real spinning wheels; the far LOD has them baked in
      const spec = veh.spec;
      if (!wheelsInstanced) { if (lightsOn > 0.02 && d < 300) this._beamList.push({ veh, d, q: null }); continue; }
      const wheelMesh = this.wheels[lod];
      const axles = spec._axles || (spec._axles = axlesOf(spec));
      const hw = spec.wid * 0.5;
      for (let a = 0; a < axles.length; a++) {
        const ax = axles[a];
        const wide = ax.dual ? 1.95 : 1;
        for (let s = -1; s <= 1; s += 2) {
          let wi;
          if (lod === 0) { wi = w0; if (wi >= wheelMax[0]) continue; w0++; } else { wi = w1; if (wi >= wheelMax[1]) continue; w1++; }
          _off.set(s * (hw - spec.wheelW * 0.5 * wide - 0.012) * veh.sw, spec.wheelR * veh.sh, ax.z * veh.sl);
          _off.applyQuaternion(_q);
          _v.set(veh.x + _off.x, veh.y + _off.y, veh.z + _off.z);
          _q2.copy(_q);
          if (ax.steer && veh.steer) _q2.multiply(_qTemp.setFromAxisAngle(YAXIS, veh.steer));
          _q2.multiply(_qTemp.setFromAxisAngle(XAXIS, veh.spin));
          _sc.set(spec.wheelW * wide * veh.sw, spec.wheelR * veh.sh, spec.wheelR * veh.sh);
          _m.compose(_v, _q2, _sc);
          wheelMesh.setMatrixAt(wi, _m);
        }
      }

      if (lightsOn > 0.02 && d < 300) this._beamList.push({ veh, d, q: null });
    }

    for (const id of VEHICLE_IDS) {
      for (let lod = 0; lod < 2; lod++) {
        const mesh = this.bodies[id][lod];
        const n = this._counts[id][lod];
        mesh.count = n;
        mesh.visible = n > 0;
        if (lod === 1) { const p = this.shadowProxy[id]; p.count = n; p.visible = n > 0; }
        if (n > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.geometry.attributes.aPaint.needsUpdate = true;
          mesh.geometry.attributes.aPaint2.needsUpdate = true;
          mesh.geometry.attributes.aState.needsUpdate = true;
        }
      }
    }
    this.wheels[0].count = w0; this.wheels[0].visible = w0 > 0; if (w0) this.wheels[0].instanceMatrix.needsUpdate = true;
    this.wheels[1].count = w1; this.wheels[1].visible = w1 > 0; if (w1) this.wheels[1].instanceMatrix.needsUpdate = true;

    ci = this._syncPeds(peds, cx, cy, cz, drawDist, ci, contactArr, contactDark, shx, shz);
    this.contact.count = ci;
    this.contact.visible = ci > 0 && contactDark > 0.01;
    if (ci > 0) { this.contact.instanceMatrix.needsUpdate = true; this.contactD.needsUpdate = true; this.contactS.needsUpdate = true; }
    this._syncLights(camera, lightsOn);
  }

  _syncPeds(peds, cx, cy, cz, drawDist, ci, contactArr, contactDark, shx, shz) {
    const counts = [0, 0];
    const dist = Math.min(drawDist, 330);
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const dx = p.x - cx, dz = p.z - cz, dy = p.y - cy;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > dist * dist) continue;
      const lod = d2 < 44 * 44 ? 0 : 1;
      if (d2 > 150 * 150 && (p.id & 1)) continue;
      const mesh = this.peds[lod];
      const n = counts[lod];
      if (n >= this.pedCap) continue;
      _e.set(0, p.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _v.set(p.x, p.y, p.z);
      // stature: 1.58 m to 1.90 m equivalent, with build varying independently of height
      const hs = 0.925 + 0.155 * p.seed;
      const bs = 0.93 + 0.16 * (1 - p.seed) + 0.06 * ((p.shirt & 7) / 7);
      _sc.set(bs, hs, bs);
      _m.compose(_v, _q, _sc);
      mesh.setMatrixAt(n, _m);
      const shirt = SHIRTS[p.shirt % SHIRTS.length];
      const pants = PANTS[(p.pants >> 2) % PANTS.length];
      const a = mesh.geometry.attributes.aPaint.array;
      a[n * 3] = shirt[0]; a[n * 3 + 1] = shirt[1]; a[n * 3 + 2] = shirt[2];
      const b = mesh.geometry.attributes.aPaint2.array;
      b[n * 3] = pants[0]; b[n * 3 + 1] = pants[1]; b[n * 3 + 2] = pants[2];
      const w = mesh.geometry.attributes.aWalk.array;
      w[n * 3] = p.phase;
      w[n * 3 + 1] = Math.min(1, p.v / 1.35);
      w[n * 3 + 2] = p.seed;
      counts[lod] = n + 1;
      if (ci < MAX_CONTACT && d2 < 200 * 200) {
        _e.set(Math.PI * 0.5, p.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _v.set(p.x + shx * 0.35, p.y + 0.026, p.z + shz * 0.35);
        _sc.set(0.74, 0.74, 1);
        _m.compose(_v, _q, _sc);
        this.contact.setMatrixAt(ci, _m);
        contactArr[ci] = contactDark * 0.80;
        this.contactS.array[ci] = 0;     // pedestrian footprint: plain soft ellipse
        ci++;
      }
    }
    for (let lod = 0; lod < 2; lod++) {
      const mesh = this.peds[lod];
      mesh.count = counts[lod];
      mesh.visible = counts[lod] > 0;
      if (counts[lod] > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.aPaint.needsUpdate = true;
        mesh.geometry.attributes.aPaint2.needsUpdate = true;
        mesh.geometry.attributes.aWalk.needsUpdate = true;
      }
    }
    return ci;
  }

  _syncLights(camera, lightsOn) {
    // Ground pools and glare billboards are additive and land in the HDR buffer *before* tone
    // mapping, so their radiance is authored in display units and divided by the current exposure
    // — otherwise the pools blow the asphalt to Y 0.61 (5x the LOOK_TARGET black floor) as soon as
    // the night exposure ramps up, and a red tail light turns into a white blob.
    const gs = 1 / Math.max(0.6, this.engine.renderer.toneMappingExposure || 1);
    const list = this._beamList;
    if (!list.length || lightsOn <= 0.02) {
      this.beams.count = 0; this.beams.visible = false;
      this.glare.count = 0; this.glare.visible = false;
      return;
    }
    list.sort((a, b) => a.d - b.d);
    const cam = camera.position;
    let bi = 0, gi = 0;
    const beamArr = this.beamI.array;
    const beamCol = this.beamC.array, beamShape = this.beamSh.array;
    const glareC = this.glareC.array, glareS = this.glareS.array;
    for (let i = 0; i < list.length; i++) {
      const { veh, d } = list[i];
      const fade = 1 - Math.min(1, Math.max(0, (d - 195) / 165));
      const fx = Math.sin(veh.yaw), fz = Math.cos(veh.yaw);
      // ground pool ahead of the car
      if (bi < MAX_BEAMS && d < 250) {
        const spec = veh.spec;
        const wide = 2.6 + spec.wid * 1.1;
        const long = 13 + spec.len * 1.4;
        const front = spec.len * 0.5;
        _e.set(Math.PI * 0.5, veh.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _v.set(veh.x + fx * (front + long * 0.5), veh.y + 0.055, veh.z + fz * (front + long * 0.5));
        _sc.set(wide, long, 1);
        _m.compose(_v, _q, _sc);
        this.beams.setMatrixAt(bi, _m);
        beamArr[bi] = lightsOn * 0.150 * fade * gs;
        beamCol[bi * 3] = 1.00; beamCol[bi * 3 + 1] = 0.86; beamCol[bi * 3 + 2] = 0.66;
        beamShape[bi] = 0;
        bi++;
      }
      // the red wash a lit / braking car throws onto the tarmac behind it — this is what turns a
      // queue into a readable trail of tail lights in a long exposure of the frame
      const rearI = lightsOn * (0.30 + 0.85 * veh.brake) * fade;
      if (bi < MAX_BEAMS && rearI > 0.03 && d < 185) {
        const spec = veh.spec;
        const back = spec.len * 0.5;
        const wide = 1.4 + spec.wid * 1.00, long = 3.4 + spec.len * 0.55;
        _e.set(Math.PI * 0.5, veh.yaw + Math.PI, 0, 'YXZ');
        _q.setFromEuler(_e);
        _v.set(veh.x - fx * (back + long * 0.28), veh.y + 0.045, veh.z - fz * (back + long * 0.28));
        _sc.set(wide, long, 1);
        _m.compose(_v, _q, _sc);
        this.beams.setMatrixAt(bi, _m);
        beamArr[bi] = rearI * 0.17 * gs;
        beamCol[bi * 3] = 1.00; beamCol[bi * 3 + 1] = 0.065; beamCol[bi * 3 + 2] = 0.030;
        beamShape[bi] = 1;
        bi++;
      }
      // lamp glare billboards
      const lamps = veh.spec._lamps || (veh.spec._lamps = lampOffsets(veh.spec));
      const tox = cam.x - veh.x, toz = cam.z - veh.z;
      const tl = Math.hypot(tox, toz) || 1;
      const facing = (fx * tox + fz * toz) / tl;
      const headI = lightsOn * Math.max(0, (facing - 0.05) / 0.95) * fade;
      const tailI = Math.min(1.30, lightsOn * 0.70 + veh.brake * 0.95) * Math.max(0, (-facing - 0.02) / 0.98) * fade;
      _e.set(veh.pitch, veh.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      for (let k = 0; k < 2; k++) {
        if (headI > 0.02 && gi < MAX_GLARE) {
          const o = lamps.head[k];
          _off.set(o[0] * veh.sw, o[1] * veh.sh, o[2] * veh.sl).applyQuaternion(_q);
          _v.set(veh.x + _off.x, veh.y + _off.y, veh.z + _off.z);
          _m.compose(_v, _q, _sc.set(1, 1, 1));
          this.glare.setMatrixAt(gi, _m);
          const hI = headI * 2.05 * gs;
          glareC[gi * 3] = 1.32 * hI; glareC[gi * 3 + 1] = 1.18 * hI; glareC[gi * 3 + 2] = 0.94 * hI;
          glareS[gi] = 0.34 + 0.42 * headI;
          gi++;
        }
        if (tailI > 0.02 && gi < MAX_GLARE) {
          const o = lamps.tail[k];
          _off.set(o[0] * veh.sw, o[1] * veh.sh, o[2] * veh.sl).applyQuaternion(_q);
          _v.set(veh.x + _off.x, veh.y + _off.y, veh.z + _off.z);
          _m.compose(_v, _q, _sc.set(1, 1, 1));
          this.glare.setMatrixAt(gi, _m);
          const tI = tailI * 1.75 * gs;
          glareC[gi * 3] = 1.00 * tI; glareC[gi * 3 + 1] = 0.075 * tI; glareC[gi * 3 + 2] = 0.030 * tI;
          glareS[gi] = 0.30 + 0.26 * tailI;
          gi++;
        }
      }
      if (gi >= MAX_GLARE && bi >= MAX_BEAMS) break;
    }
    this.beams.count = bi; this.beams.visible = bi > 0;
    this.glare.count = gi; this.glare.visible = gi > 0;
    if (bi) {
      this.beams.instanceMatrix.needsUpdate = true; this.beamI.needsUpdate = true;
      this.beamC.needsUpdate = true; this.beamSh.needsUpdate = true;
    }
    if (gi) { this.glare.instanceMatrix.needsUpdate = true; this.glareC.needsUpdate = true; this.glareS.needsUpdate = true; }
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.material.dispose();
    this.pedMaterial.dispose();
    this.beamMat.dispose();
    this.contactMat.dispose();
    this.proxyMat.dispose();
    this.glareMat.dispose();
    this.pedDepth.dispose();
    if (this.sentinelMesh) {
      (Array.isArray(this.sentinelMesh.material) ? this.sentinelMesh.material : [this.sentinelMesh.material])
        .forEach((m) => m.dispose());
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

const _qTemp = new THREE.Quaternion();
