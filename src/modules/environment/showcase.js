/**
 * environment showcase — a look-development set that exposes what the sky & lighting do:
 * a curtain-wall skyline (glass ribbons + concrete spandrels, lit windows at night), a concrete
 * plaza with a reflecting pool, a PBR material arc and lamp posts. Everything is honest geometry
 * lit only by the environment module (sun/moon, hemisphere, PMREM sky, height fog, exposure).
 *
 *   http://127.0.0.1:5180/?showcase=environment&seed=7&time=18.5&cam=environment_hero
 */
import * as THREE from 'three';
import { DEG2RAD } from '../../shared/math.js';
import { makeRng } from '../../shared/random.js';

/** Default hour for the showcase and the hero preset: a low afternoon sun (LOOK_TARGET's 22-34 deg band). */
export const HERO_HOUR = 17.5;

const CONCRETE = '/assets/shared/concrete_wall_008/';
const PAVING = '/assets/shared/paving_slabs/';

export async function showcase(ctx) {
  const { engine, scene, world, assets, events } = ctx;
  const rng = makeRng(world.seed ^ 0xe11f);
  const group = new THREE.Group();
  group.name = 'environment-showcase';
  scene.add(group);
  const h = (x, z) => world.terrain.getHeight(x, z);
  // pick the flattest dry site near the map centre so the set sits on the real terrain
  // Sun lines that MUST be clear: the hero hour and the golden hour after it. A flat pad in the shade of the
  // ridge behind it is worthless for a lighting showcase — it was why every evening frame went flat and khaki.
  const sunLines = (world.env.api
    ? [16.4, HERO_HOUR, 18.6].map((h) => world.env.api.sunDirection(h))
    : []).filter((d) => d.y > 0.02);
  const site = findFlatSite(world, 700, 110, sunLines);
  const cx = site.x, cz = site.z;
  const y0 = site.y;

  // --- textures (CC0, Poly Haven) ---
  const concrete = await assets.loadPBR({ map: CONCRETE + 'Diffuse.jpg', normalMap: CONCRETE + 'nor_gl.jpg', aoMap: CONCRETE + 'arm.jpg', roughnessMap: CONCRETE + 'arm.jpg', metalnessMap: CONCRETE + 'arm.jpg' });
  const paving = await assets.loadPBR({ map: PAVING + 'albedo.jpg', normalMap: PAVING + 'normal.jpg', roughnessMap: PAVING + 'roughness.jpg', aoMap: PAVING + 'ao.jpg' });

  // --- paved plaza (0.4 m slab) — real slab micro-detail for the raking light to catch ---
  const plazaW = 220, plazaD = 150;
  const concreteMat = new THREE.MeshStandardMaterial({ ...paving, color: new THREE.Color(0.86, 0.85, 0.82), roughness: 0.95, metalness: 0 });
  concreteMat.normalScale.set(0.9, 0.9);
  for (const t of Object.values(concrete)) { t.repeat.set(6, 6); t.anisotropy = engine.maxAnisotropy; }
  for (const t of Object.values(paving)) { t.repeat.set(28, 19); t.anisotropy = engine.maxAnisotropy; }
  engine.registerMaterial(concreteMat);
  {
    const geo = new THREE.BoxGeometry(plazaW, 6, plazaD);
    const mesh = new THREE.Mesh(geo, concreteMat);
    mesh.position.set(cx, y0 + 0.5 - 3, cz);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.layers.enable(engine.LAYER_REFLECTED);
    mesh.name = 'showcase-plaza';
    group.add(mesh);
  }
  const plazaTop = y0 + 0.5;

  // darker granite banding inside the plaza: something for the raking light to graze and for shadows to read against
  const graniteMat = engine.registerMaterial(new THREE.MeshStandardMaterial({
    map: paving.map, normalMap: paving.normalMap, roughnessMap: paving.roughnessMap, aoMap: paving.aoMap,
    color: new THREE.Color(0.30, 0.30, 0.315), roughness: 0.78, metalness: 0,
  }));
  for (const [bx, bz, bw, bd] of [[0, -58, plazaW - 20, 4], [0, 58, plazaW - 20, 4], [-96, 0, 4, plazaD - 20], [96, 0, 4, plazaD - 20]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.35, bd), graniteMat);
    b.position.set(cx + bx, plazaTop + 0.16, cz + bz);
    b.receiveShadow = true; b.castShadow = true;
    b.layers.enable(engine.LAYER_REFLECTED);
    group.add(b);
  }

  // --- PBR material arc: dielectric roughness ramp (front) and metal ramp (back) on low plinths ---
  const ballGeo = new THREE.SphereGeometry(2.2, 48, 32);
  const pedGeo = new THREE.CylinderGeometry(1.5, 1.8, 1.4, 24);
  const pedMat = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0x74777a, roughness: 0.75, metalness: 0 }));
  const N = 6;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const mat = row === 0
        ? new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.58 - t * 0.06, 0.30, 0.36), roughness: 0.06 + t * 0.9, metalness: 0 })
        // warm alloy: a neutral metal ramp is indistinguishable from the dielectric row under a white noon sky
        : new THREE.MeshStandardMaterial({ color: new THREE.Color(0.95, 0.76, 0.50), roughness: 0.05 + t * 0.85, metalness: 1 });
      engine.registerMaterial(mat);
      const x = cx - 34 + i * 13.6, z = cz + 26 + row * 11;
      const ped = new THREE.Mesh(pedGeo, pedMat);
      ped.position.set(x, plazaTop + 0.7, z);
      ped.castShadow = ped.receiveShadow = true;
      const ball = new THREE.Mesh(ballGeo, mat);
      ball.position.set(x, plazaTop + 1.4 + 2.2, z);
      ball.castShadow = ball.receiveShadow = true;
      group.add(ped, ball);
    }
  }
  // glass and clear-coat samples at the ends
  {
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, transmission: 0.95, thickness: 2.5, ior: 1.5, transparent: true });
    const carPaint = new THREE.MeshPhysicalMaterial({ color: 0x141b33, roughness: 0.36, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.06 });
    engine.registerMaterial([glass, carPaint]);
    for (const [mat, x] of [[glass, cx - 50], [carPaint, cx + 50]]) {
      const ped = new THREE.Mesh(pedGeo, pedMat);
      ped.position.set(x, plazaTop + 0.7, cz + 31.5);
      ped.castShadow = ped.receiveShadow = true;
      const ball = new THREE.Mesh(ballGeo, mat);
      ball.position.set(x, plazaTop + 3.6, cz + 31.5);
      ball.castShadow = mat !== glass;
      ball.receiveShadow = true;
      group.add(ped, ball);
    }
  }

  // --- reflecting pool: a shallow sheet of water in a stone coping ---
  {
    const geo = new THREE.PlaneGeometry(120, 34, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // a real water sheet: near-black body colour, low roughness — what you see is almost entirely the sky it mirrors,
    // so the pool is the module's own honest test of the PMREM probe under every weather
    const ripple = makeRippleNormal(world.seed);
    ripple.repeat.set(5, 1.6);
    ripple.anisotropy = engine.maxAnisotropy;
    const water = new THREE.MeshPhysicalMaterial({
      color: 0x070d12, roughness: 0.075, metalness: 0, reflectivity: 1, ior: 1.333, envMapIntensity: 1.3,
      normalMap: ripple,
    });
    water.normalScale.set(0.16, 0.16);
    engine.registerMaterial(water);
    // the sheet drifts with the module's own wind, so the pool answers world.env.wind like everything else
    engine.onUpdate(function showcasePoolRipple(dt) {
      const w = world.env.wind, k = 0.011 * (0.4 + world.env.windStrength);
      ripple.offset.x = (ripple.offset.x + w.x * k * dt * 60) % 1;
      ripple.offset.y = (ripple.offset.y + w.y * k * dt * 60) % 1;
    });
    const mesh = new THREE.Mesh(geo, water);
    mesh.position.set(cx, plazaTop + 0.14, cz - 10);
    mesh.receiveShadow = true;
    mesh.layers.enable(engine.LAYER_REFLECTED);
    mesh.name = 'showcase-pool';
    group.add(mesh);
    // coping: a stone lip standing 0.34 m proud AROUND the sheet (four bars, never over it), so the pool has an
    // edge that casts a shadow line and the water is never hidden by its own frame
    for (const [ox, oz, bw, bd] of [[0, -19, 128, 4], [0, 19, 128, 4], [-62, 0, 4, 34], [62, 0, 4, 34]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.9, bd), graniteMat);
      bar.position.set(cx + ox, plazaTop + 0.1, cz - 10 + oz);
      bar.receiveShadow = true; bar.castShadow = true;
      bar.layers.enable(engine.LAYER_REFLECTED);
      group.add(bar);
    }
  }

  // --- planters along the north edge: cast long shadows across the plaza at golden hour ---
  {
    const planterMat = graniteMat;
    for (let i = 0; i < 7; i++) {
      const x = cx - 78 + i * 26;
      const p = new THREE.Mesh(new THREE.BoxGeometry(9, 1.1, 9), planterMat);
      p.position.set(x, plazaTop + 0.55, cz - 62);
      p.castShadow = p.receiveShadow = true;
      group.add(p);
    }
  }

  // --- curtain-wall towers: two clusters flanking a clear afternoon-sun corridor ------------------------
  const towerMats = [];
  const towerPhase = [];
  // The sun sweeps azimuth 260 deg (16:24, the hero hour) to 292 deg (19:00) here, so the corridor between the
  // clusters is held open from 246 to 304 deg: a tower inside it puts an 8x-height shadow across the whole set
  // at golden hour, which is exactly how the r3 evening frames lost their key. Footprints, heights, rotations
  // and setbacks are drawn per tower from the seeded rng — the reference frames never repeat a silhouette.
  const heroSunEarly = world.env.api ? world.env.api.sunDirection(HERO_HOUR) : new THREE.Vector3(-1, 0.5, 0.2);
  const sunAz = Math.atan2(heroSunEarly.x, -heroSunEarly.z);
  const moonEarly = world.env.api ? world.env.api.moonDirection(22) : null;
  const moonAz = moonEarly ? Math.atan2(moonEarly.x, -moonEarly.z) : 134 * DEG2RAD;
  // the hero camera stands at this target-relative azimuth: nothing may be planted on top of it
  const heroCamAz = sunAz + 79 * DEG2RAD + Math.PI, heroCamR = 275;
  const camPX = Math.sin(heroCamAz) * heroCamR, camPZ = -Math.cos(heroCamAz) * heroCamR;
  const layout = [];
  const addCluster = (a0, a1, r0, r1, n, h0, h1) => {
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * ((i + 0.15 + 0.7 * rng()) / n);
      const r = r0 + (r1 - r0) * rng();
      const w = 18 + rng() * 18, d = 17 + rng() * 15;
      const ht = h0 + (h1 - h0) * Math.pow(rng(), 1.5);
      const px = Math.sin(a) * r, pz = -Math.cos(a) * r;
      if (Math.hypot(px - camPX, pz - camPZ) < 170) continue;   // never in the hero camera's lap
      layout.push([px, pz, w, d, ht]);
    }
  };
  // south-west of the corridor, north-west of it, and the south-east cluster the night preset frames
  addCluster(sunAz - 78 * DEG2RAD, sunAz - 28 * DEG2RAD, 250, 560, 9, 34, 150);
  addCluster(sunAz + 34 * DEG2RAD, sunAz + 112 * DEG2RAD, 230, 560, 9, 40, 172);
  addCluster(moonAz - 52 * DEG2RAD, moonAz - 8 * DEG2RAD, 270, 540, 7, 52, 140);
  const parapetMat = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0x6e6f70, roughness: 0.9, metalness: 0 }));
  for (const [x, z, w, d, ht] of layout) {
    const base = h(cx + x, cz + z);
    const floors = Math.max(6, Math.round(ht / 3.6));
    const fac = makeFacadeTextures(rng, w, d, floors);
    const mat = new THREE.MeshStandardMaterial({
      map: fac.albedo, roughnessMap: fac.arm, metalnessMap: fac.arm, aoMap: fac.arm,
      normalMap: concrete.normalMap,
      roughness: 1, metalness: 1,
      emissiveMap: fac.emissive, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0,
    });
    mat.normalScale.set(0.25, 0.25);
    towerPhase.push(rng());
    engine.registerMaterial(mat);
    const geo = new THREE.BoxGeometry(w, ht, d);
    geo.translate(0, ht / 2, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx + x, base - 2.5, cz + z);
    mesh.rotation.y = (rng() - 0.5) * 0.12;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.layers.enable(engine.LAYER_REFLECTED);
    mesh.name = 'showcase-tower';
    group.add(mesh);
    towerMats.push(mat);
    // parapet + roof plant: a hard rim that catches the last light and breaks the flat box silhouette
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 1.6, d + 1.2), parapetMat);
    cap.position.set(0, ht + 0.2, 0);
    cap.castShadow = cap.receiveShadow = true;
    const plantW = w * (0.3 + rng() * 0.22), plantD = d * (0.3 + rng() * 0.22), plantH = 3 + rng() * 5;
    const plant = new THREE.Mesh(new THREE.BoxGeometry(plantW, plantH, plantD), parapetMat);
    plant.position.set((rng() - 0.5) * w * 0.3, ht + plantH / 2, (rng() - 0.5) * d * 0.3);
    plant.castShadow = plant.receiveShadow = true;
    const roof = new THREE.Group();
    roof.add(cap, plant);
    roof.position.copy(mesh.position);
    roof.rotation.y = mesh.rotation.y;
    roof.children.forEach((c) => c.layers.enable(engine.LAYER_REFLECTED));
    group.add(roof);
  }

  // --- lamp posts around the plaza (emissive heads + point lights at night) ---
  const lamps = [];
  const poleMat = engine.registerMaterial(new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.55, metalness: 0.8 }));
  const headMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2d, emissive: new THREE.Color(1.0, 0.83, 0.58), emissiveIntensity: 0, roughness: 0.35, metalness: 0.4 });
  engine.registerMaterial(headMat);
  const poleGeo = new THREE.CylinderGeometry(0.11, 0.15, 7, 10);
  const headGeo = new THREE.CylinderGeometry(0.55, 0.36, 0.42, 14);
  for (let i = 0; i < 10; i++) {
    const x = cx - plazaW / 2 + 12 + (i % 5) * ((plazaW - 24) / 4);
    const z = cz + (i < 5 ? -plazaD / 2 + 6 : plazaD / 2 - 6);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, plazaTop + 3.5, z);
    pole.castShadow = true;
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(x, plazaTop + 7.05, z);
    head.castShadow = true;
    const light = new THREE.PointLight(0xffd2a0, 0, 30, 2);
    light.position.set(x, plazaTop + 6.7, z);
    light.castShadow = false;
    group.add(pole, head, light);
    lamps.push(light);
  }

  // --- night reaction: windows + lamps follow world.env.nightFactor ---
  engine.onUpdate(function environmentShowcase() {
    const nf = world.env.nightFactor;
    // towers switch on one after another through dusk (per-tower phase), never all at once nor all the same
    for (let i = 0; i < towerMats.length; i++) {
      const ph = towerPhase[i];
      const on = smooth01((nf - 0.25 - ph * 0.3) / 0.35);
      towerMats[i].emissiveIntensity = on * (0.55 + ph * 0.45);
    }
    headMat.emissiveIntensity = nf * 1.15;
    for (const l of lamps) l.intensity = nf * 30;
  });

  // --- default time: a LOW SUN, never noon -------------------------------------------------------------
  // LOOK_TARGET: no CS2 beauty frame is shot at noon. Cast shadows in the reference frames run 1.5-2.5x
  // object height, i.e. sun elevation 22-34 deg, which at latitude 47.3 on 30 Apr is hour 15.6-16.6.
  // Only override when the URL did not ask for a time, so ?time= and --time still win.
  if (!new URLSearchParams(window.location.search).has('time')) {
    world.time.hour = HERO_HOUR;
    events.emit('time:set', HERO_HOUR);
  }

  // --- keep the set out of a cloud shadow at the hero hour ---------------------------------------------
  // A fair-weather cell casts a ~600 m shadow — wider than the whole set — so an unlucky seed parks one over
  // everything and the frame loses its key entirely (measured: sun modulation 0.32-0.51 across the plaza, i.e.
  // half the direct light gone before a single object shadow is drawn). Drifting the cloud FIELD is the same
  // sky, moved: deterministic per seed, and it keeps a shadow in the middle distance where it gives scale.
  // Each candidate is applied and re-measured (api.refresh() rebuilds the sun-modulation transform), so this
  // never relies on a model of the projection.
  {
    const A = world.env.api;
    if (A && A.setCloudOffset && A.cloudShadowAt && A.refresh) {
      const litAt = () => Math.min(
        A.cloudShadowAt(cx, cz), A.cloudShadowAt(cx + 150, cz), A.cloudShadowAt(cx - 150, cz),
        A.cloudShadowAt(cx, cz + 150), A.cloudShadowAt(cx, cz - 150), A.cloudShadowAt(cx - 260, cz - 120));
      let best = { lit: litAt(), ox: 0, oz: 0 };
      // deterministic spiral over the 22 km weather tile, 1.1 km per step (about two cell widths)
      for (let i = 1; i <= 26 && best.lit < 0.97; i++) {
        const a = i * 2.399963, r = 1100 * Math.sqrt(i); // golden-angle spiral: even coverage, no repeats
        const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
        A.setCloudOffset(ox, oz);
        A.refresh();
        const lit = litAt();
        if (lit > best.lit) best = { lit, ox, oz };
      }
      A.setCloudOffset(best.ox, best.oz);
      A.refresh();
      group.userData.cloudSearch = best;
    }
  }

  // --- camera presets (yaw: camera sits at target + (sin yaw, ·, cos yaw)·d, i.e. looks toward −(sin yaw, cos yaw)) ---
  const P = window.__game.presets;
  const tgt = { x: cx, z: cz };
  // Both day presets are composed FROM the sun, not from the set: the view azimuth is held ~80 deg off the sun so
  // the key rakes across the frame and every shadow runs left across the picture plane instead of hiding behind
  // its own object. (view azimuth = -yaw; sun azimuth from the ephemeris, so this holds at any latitude/date.)
  // hero: the plaza mid-frame, the west skyline on the sun side, long tower shadows sweeping in from the right
  // Pitch matters as much as yaw: at 9 deg the ground is edge-on and a 10 m shadow collapses to a few pixels
  // behind its own object. CS2 beauty frames sit at 20-35 deg, where the shadow lies open across the picture.
  P.environment_hero = { target: { x: cx + 12, z: cz + 26 }, distance: 275, yaw: -(sunAz + 79 * DEG2RAD), pitch: 13 * DEG2RAD };
  // detail: the material arc across the near third — contact shadows under every plinth, the ramp of sphere
  // shadows raking left over the paving, the pool and the skyline behind
  P.environment_detail = { target: { x: cx - 2, z: cz + 26 }, distance: 56, yaw: -(sunAz + 92 * DEG2RAD), pitch: 31 * DEG2RAD };
  // night (best at --time 21-22): the moon over the plaza. View azimuth is the moon's, offset 12 deg so the disc
  // sits left of centre clear of the HUD clock; the target is pushed 120 m up-frame so the lit plaza, the lamp
  // pools and the tower cluster occupy the lower half instead of an empty sea.
  {
    const viewAz = moonAz - 12 * DEG2RAD;
    P.environment_night = {
      target: { x: cx + Math.sin(viewAz) * 130, z: cz - Math.cos(viewAz) * 130 },
      distance: 215, yaw: -viewAz, pitch: 7 * DEG2RAD,
    };
  }
  P.environment_sky = { target: { x: cx - 60, z: cz - 40 }, distance: 780, yaw: 118 * DEG2RAD, pitch: 16 * DEG2RAD };
  P.environment_aerial = { target: tgt, distance: 1400, yaw: 35 * DEG2RAD, pitch: 40 * DEG2RAD };
  P.environment_pool = { target: { x: cx, z: cz - 10 }, distance: 90, yaw: 150 * DEG2RAD, pitch: 12 * DEG2RAD };

  // (no notification toast: it would sit in the corner of every verification screenshot)
  return group;
}

const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

/**
 * Procedural curtain-wall facade for one tower: horizontal glass ribbons between concrete spandrels, vertical
 * mullions, a darker plinth and a service core stripe. Returns { albedo (sRGB), arm (linear R=ao G=rough B=metal),
 * emissive (sRGB) }. Roughly 45 % of the panes are lit at night with warm / neutral / cool tenants.
 *
 * The map is UV-tiled over a BoxGeometry, so one texel column is the same width on every face; the floor pitch
 * (rows) is what the eye reads for scale, and it is exact: one row = one 3.6 m storey.
 */
function makeFacadeTextures(rng, w, d, floors) {
  const cols = 16;                    // panes across the widest face
  const PX = 8, PY = 10;              // texels per pane
  const W = cols * PX, H = floors * PY;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const cA = mk(), cR = mk(), cE = mk();
  const gA = cA.getContext('2d'), gR = cR.getContext('2d'), gE = cE.getContext('2d');

  // concrete spandrel base colour, slightly different per tower
  const tint = 118 + Math.round(rng() * 58);
  gA.fillStyle = `rgb(${tint}, ${tint - 2}, ${Math.round(tint * 0.96)})`;
  gA.fillRect(0, 0, W, H);
  gR.fillStyle = 'rgb(255, 230, 0)';   // ao 1, rough 0.90, metal 0
  gR.fillRect(0, 0, W, H);
  gE.fillStyle = '#000';
  gE.fillRect(0, 0, W, H);

  const glassHue = [[26, 34, 40], [22, 32, 34], [30, 33, 44], [24, 30, 36]][Math.floor(rng() * 4)];
  const temps = [[255, 188, 122], [255, 208, 158], [255, 234, 208], [220, 230, 246], [186, 212, 255]];
  const coreCol = 1 + Math.floor(rng() * (cols - 2));   // one service bay: no glass, no lights
  for (let j = 0; j < floors; j++) {
    const y = j * PY;
    const ground = j === 0;
    const darkFloor = rng() < 0.10;
    for (let i = 0; i < cols; i++) {
      const x = i * PX;
      if (i === coreCol) continue;
      // glass ribbon: 6x6 pane inside the 8x10 cell (1 px mullion each side, 2 px spandrel below)
      const gx = x + 1, gy = y + 2, gw = PX - 2, gh = PY - 5;
      const v = 0.82 + rng() * 0.36;
      gA.fillStyle = `rgb(${Math.round(glassHue[0] * v)}, ${Math.round(glassHue[1] * v)}, ${Math.round(glassHue[2] * v)})`;
      gA.fillRect(gx, gy, gw, gh);
      // glass: ao 1, roughness ~0.10, metal 0 (dielectric — the sky reflection comes from the PMREM probe)
      gR.fillStyle = 'rgb(255, 26, 0)';
      gR.fillRect(gx, gy, gw, gh);
      if (ground) {                    // ground floor: taller shopfront glazing
        gA.fillStyle = `rgb(${glassHue[0] - 6}, ${glassHue[1] - 6}, ${glassHue[2] - 6})`;
        gA.fillRect(gx, y + 1, gw, PY - 2);
        gR.fillRect(gx, y + 1, gw, PY - 2);
      }
      if (darkFloor || rng() > 0.45) continue;
      const t = temps[Math.floor(rng() * temps.length)];
      const e = (rng() < 0.34 ? 0.22 : 0.6) + rng() * 0.4;   // curtained / open
      gE.fillStyle = `rgb(${Math.round(t[0] * e)}, ${Math.round(t[1] * e)}, ${Math.round(t[2] * e)})`;
      gE.fillRect(gx, gy, gw, gh);
    }
  }
  // darker plinth band across the bottom two rows
  gA.fillStyle = 'rgba(0, 0, 0, 0.35)';
  gA.fillRect(0, H - PY, W, PY);

  const tex = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, Math.round(w / 22)), 1);
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: tex(cA, true), arm: tex(cR, false), emissive: tex(cE, true) };
}

/** Tileable ripple normal map for the reflecting pool: nine integer-wavevector sine waves at random
 *  orientations, so the interference reads as wind chop instead of a corrugated sheet. Deterministic per seed. */
function makeRippleNormal(seed) {
  const N = 256;
  const rng = makeRng(seed ^ 0x1caf);
  const waves = [];
  for (let k = 0; k < 9; k++) {
    const ang = rng() * Math.PI * 2;
    const n = 4 + Math.floor(rng() * 11);                 // 4..14 periods across the tile
    const nx = Math.round(Math.cos(ang) * n), ny = Math.round(Math.sin(ang) * n);
    if (nx === 0 && ny === 0) continue;
    const mag = Math.hypot(nx, ny);
    waves.push({ nx, ny, ph: rng() * Math.PI * 2, amp: 1 / (mag * mag) });  // amplitude ~ 1/k^2 (capillary chop)
  }
  const height = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      let hgt = 0;
      for (const w of waves) hgt += w.amp * Math.sin((u * w.nx + v * w.ny) * Math.PI * 2 + w.ph);
      height[j * N + i] = hgt;
    }
  }
  let mx = 1e-6;
  for (let i = 0; i < height.length; i++) mx = Math.max(mx, Math.abs(height[i]));
  for (let i = 0; i < height.length; i++) height[i] /= mx;
  const data = new Uint8Array(N * N * 4);
  const at = (i, j) => height[((j % N) + N) % N * N + (((i % N) + N) % N)];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) * 0.5;
      const dy = (at(i, j + 1) - at(i, j - 1)) * 0.5;
      const nx = -dx * 6, ny = -dy * 6, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const o = (j * N + i) * 4;
      data[o] = Math.round((nx / l * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Search a grid of candidate centres for the flattest, driest 240 m patch. */
function findFlatSite(world, range, step, sunLines = []) {
  const t = world.terrain;
  let best = { x: 0, z: 0, y: t.getHeight(0, 0), score: Infinity };
  for (let z = -range; z <= range; z += step) {
    for (let x = -range; x <= range; x += step) {
      let min = Infinity, max = -Infinity, sum = 0, n = 0, wet = 0;
      for (let dz = -120; dz <= 120; dz += 40) {
        for (let dx = -160; dx <= 160; dx += 40) {
          const y = t.getHeight(x + dx, z + dz);
          if (t.isWater(x + dx, z + dz) || y < t.waterLevel + 1) wet++;
          min = Math.min(min, y); max = Math.max(max, y); sum += y; n++;
        }
      }
      const y0 = sum / n;
      let shade = 0;
      for (const d of sunLines) shade += horizonBlock(t, x, z, y0 + 2, d);
      const score = (max - min) * 2.2 + wet * 50 + shade * 150 + Math.hypot(x, z) * 0.01;
      if (score < best.score) best = { x, z, y: y0, score, shade };
    }
  }
  return best;
}

/**
 * How much the terrain blocks the sun along `dir` (a unit vector TOWARD the sun) from (x, z, y):
 * 0 = clear horizon, 1 = a ridge 25 m or more above the sun line. Marched over the heightmap, so a site is
 * only chosen if its low-sun key actually reaches it.
 */
function horizonBlock(t, x, z, y, dir, maxDist = 1500, stepM = 40) {
  const h = Math.hypot(dir.x, dir.z) || 1e-3;
  const ux = dir.x / h, uz = dir.z / h, slope = dir.y / h;
  let worst = 0;
  for (let d = stepM; d <= maxDist; d += stepM) {
    const ray = y + slope * d;
    const g = t.getHeight(x + ux * d, z + uz * d);
    if (g > ray) { const v = Math.min(1, (g - ray) / 25); if (v > worst) worst = v; }
  }
  return worst;
}
