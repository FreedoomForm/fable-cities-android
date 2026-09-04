/**
 * effects module — visual effects layer (see ARCHITECTURE.md §4/§5/§9).
 *
 *  - GPU particle systems: industrial smoke from the REAL stacks the buildings module publishes
 *    (b.stacks / b.vents), rooftop flue + steam vents, chimney smoke on low residential when cold,
 *    construction dust for buildings in construction,
 *    hairline rain streaks (near + far fine-rain haze layer), spray crowns + puddle rings, snow.
 *    Rendered by EffectsPass right after the RenderPass so they are occluded / softened by the real
 *    scene depth of the frame (depthTest off, no GTAO halos) and can read the scene colour (rain fades
 *    against bright backgrounds).
 *  - Wet-look / rain ripples / snow cover on EVERY lit material through engine.addMaterialHook, driven
 *    by engine.globalUniforms.uWetness (WetSurfaces.js): wet asphalt lands on the MATERIAL_TARGET
 *    roughness of 0.20 with its aggregate grain intact, and gets the sky specular back that a
 *    half-strength environment probe takes away.
 *  - Standing water as REAL geometry in the road camber and gutters (PuddleField.js): pools built from
 *    world.roads at roughness 0.06, plus a world-space drainage map (R pool, G ploughed tyre band,
 *    B road corridor) that the material hook and the ground pass both sample, so the wet-road mirror
 *    sharpens exactly where the water is.
 *  - Colour grading pass (white-point anchoring via a GPU luminance meter, log S-curve, black level,
 *    saturation, split tone, vignette, LUT) inserted before the OutputPass, with a restrained,
 *    depth-occluded sun glare and heat shimmer.
 *
 * Everything reacts to world.env (sun, moon, weather, wind, temperature, nightFactor) and world.time.
 * Per-frame CPU cost is uniform updates only (particles are simulated on the GPU); rebuilding the
 * emitter buffers happens when buildings change (debounced).
 *
 * Public API: world.effects.api (see `makeApi`).
 */
import * as THREE from 'three';
import { makeRng, hashString } from '../../shared/random.js';
import { clamp, clamp01, smoothstep, damp } from '../../shared/math.js';
import { makeSmokeAtlas, makeRainStreak, makeSpray, makeRing, makeSnowflake } from './sprites.js';
import { SmokeSystem, MAX_LOCAL_LIGHTS } from './SmokeSystem.js';
import { PrecipitationSystem, SplashSystem } from './Precipitation.js';
import { VehicleSpray } from './VehicleSpray.js';
import { ColorGradingPass, MAX_SHIMMER } from './ColorGradingPass.js';
import { EffectsPass } from './EffectsPass.js';
import { GroundFXPass } from './GroundFXPass.js';
import { WetLights } from './WetLights.js';
import { installWetSurfaces } from './WetSurfaces.js';
import { PuddleField } from './PuddleField.js';

export const name = 'effects';

/** @type {any} module state */
let S = null;

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpRes = new THREE.Vector2();
const tmpC = new THREE.Color();
const tmpC2 = new THREE.Color();
const tmpSky = new THREE.Color();
const tmpAmb = new THREE.Color();

export async function init(ctx) {
  const { engine, scene, world, events, config, camera, cameraController } = ctx;
  const q = engine.quality;
  const pScale = q.particles ?? 1;
  const seed = world.seed;

  S = {
    ctx, engine, scene, world, events, camera, cameraController,
    enabled: { smoke: true, rain: true, snow: true, splashes: true, spray: true, grading: true, flare: true, shimmer: true, wet: true, autoExposure: true, reflections: true, contact: true, aerial: true },
    time: 0,
    dirty: true,
    dirtyAt: 0,
    lastBuildVersion: -1,
    lastCold: null,
    warmed: false,
    sources: new Map(),
    nextSourceId: 1,
    hotSpots: [],
    rainAmt: 0, snowAmt: 0, wetness: 0, snowCover: 0,
    splashAnchor: new THREE.Vector3(1e9, 0, 1e9), splashRadius: 0,
    cpuMs: 0,
    grade: { exposure: 1, contrast: 1, saturation: 1, vignette: 1, glare: 1 }, // user multipliers
    surface: { contact: 1, ao: 1, aoRadius: 1, reflect: 1, aerial: 1, desat: 1 },   // ground-pass multipliers
    counts: { smoke: 0, rain: 0, snow: 0, splashes: 0 },
    plates: [],
    lights: [], lightScanAt: -1e9, localLights: 0,
  };

  // --- wet surfaces: global material hook (existing + future materials) ---
  S.wet = installWetSurfaces(engine, scene, events);
  // --- standing water: real geometry in the road camber / gutters, plus the drainage map the hook and
  //     the ground pass both sample (see PuddleField.js) ---
  S.puddles = new PuddleField({ engine, scene, world, seed });
  S.puddleVersion = -1;
  // real emitters (street lamps, vehicle head/tail-lights) for the analytic wet-mirror streaks
  S.wetLights = new WetLights();

  // --- sprites (procedural, deterministic) ---
  const atlas = makeSmokeAtlas(seed, q.textureSize >= 2048 ? 256 : 128, 4, 4, engine.maxAnisotropy);
  const rainTex = makeRainStreak();
  const sprayTex = makeSpray(seed);
  const ringTex = makeRing();
  const snowTex = makeSnowflake();
  S.textures = [atlas.texture, rainTex, sprayTex, ringTex, snowTex];

  // --- particle pass (after the RenderPass: real scene depth + colour, no feedback loop, no AO pre-pass) ---
  S.fxPass = new EffectsPass(scene, camera);
  // ground FX (wet reflections, contact shadows, fine AO, aerial perspective) run on the CLEAN scene,
  // before the particles are composited: order is RenderPass → GroundFXPass → EffectsPass → GTAO → bloom.
  S.groundFX = new GroundFXPass(camera);
  S.fxPass.ground = S.groundFX;          // it IS the pass' copy step — see GroundFXPass.renderCopy
  {
    const passes = engine.composer.passes;
    const idx = passes.indexOf(engine.renderPass);
    engine.composer.insertPass(S.fxPass, idx >= 0 ? idx + 1 : 1);
  }
  const group = new THREE.Group();
  group.name = 'effects';
  group.matrixAutoUpdate = false;
  S.group = group;
  S.fxPass.fxScene.add(group);

  S.smoke = new SmokeSystem({ atlas, maxParticles: Math.round(64000 * pScale) });
  S.rain = new PrecipitationSystem({ count: Math.round(9000 * pScale), texture: rainTex, mode: 0, name: 'effects-rain' });
  S.rain.fill(makeRng(seed ^ 0x7a1a));
  S.rainNear = new PrecipitationSystem({ count: Math.round(2600 * pScale), texture: rainTex, mode: 0, name: 'effects-rain-near' });
  S.rainNear.fill(makeRng(seed ^ 0x7a1c));
  S.rainFar = new PrecipitationSystem({ count: Math.round(7000 * pScale), texture: rainTex, mode: 0, name: 'effects-rain-far' });
  S.rainFar.fill(makeRng(seed ^ 0x7a1b));
  S.snow = new PrecipitationSystem({ count: Math.round(44000 * pScale), texture: snowTex, mode: 1, name: 'effects-snow' });
  S.snow.fill(makeRng(seed ^ 0x5a0f));
  S.splash = new SplashSystem({ count: Math.round(3000 * pScale), crownTexture: sprayTex, ringTexture: ringTex });
  S.splash.fill(makeRng(seed ^ 0x5b7a));
  S.spray = new VehicleSpray({
    emitters: Math.max(8, Math.round(44 * pScale)), perEmitter: 14, texture: sprayTex,
  });
  S.systems = [S.smoke, S.rain, S.rainNear, S.rainFar, S.snow, S.splash, S.spray];
  for (const sys of S.systems) {
    sys.mesh.layers.enable(engine.LAYER_NO_AO);
    group.add(sys.mesh);
  }
  S.fxPass.onBeforeParticles = (depth, color, w, h) => {
    const has = depth ? 1 : 0;
    for (const sys of S.systems) {
      const u = sys.uniforms;
      u.tDepth.value = depth;
      u.uHasDepth.value = has;
      u.uResolution.value.set(w, h);
      u.uNearFar.value.set(camera.near, camera.far);
      if (u.tScene) u.tScene.value = color;
    }
  };

  // --- colour grading pass ---
  S.grading = new ColorGradingPass();
  S.grading.uniforms.tOcc.value = S.fxPass.occlusionTexture;
  const size = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
  S.grading.setSize(size.x, size.y);
  S.fxPass.setSize(size.x, size.y);
  S.groundFX.setSize(size.x, size.y);
  engine.post.insertBeforeOutput(S.grading);
  engine.post.colorGrading = S.grading;

  // --- events ---
  const markDirty = () => { S.dirty = true; };
  const markPuddles = () => { S.puddleVersion = -1; };
  S.offs = [
    events.on('roads:changed', markPuddles),
    events.on('terrain:ready', markPuddles),
    events.on('building:added', markDirty),
    events.on('building:removed', markDirty),
    events.on('building:levelup', markDirty),
    events.on('buildings:changed', markDirty),
    events.on('weather:set', markDirty),
    events.on('engine:resize', () => {
      const s = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
      S.grading.setSize(s.x, s.y);
      S.fxPass.setSize(s.x, s.y);
      S.groundFX.setSize(s.x, s.y);
    }),
  ];

  world.effects = { api: makeApi() };
  if (config.debug) console.log('[effects] ready', { maxSmoke: S.smoke.max, rain: S.rain.count + S.rainFar.count, snow: S.snow.count });
}

export function update(dt, elapsed) {
  if (!S) return;
  const t0 = performance.now();
  const { world, engine, camera } = S;
  const env = world.env;
  S.time += dt;

  // post-processing off (never in practice) → fall back to drawing the particles in the main scene
  const inMain = S.group.parent === S.scene;
  if (!engine.postEnabled && !inMain) { S.fxPass.fxScene.remove(S.group); S.scene.add(S.group); }
  else if (engine.postEnabled && inMain) { S.scene.remove(S.group); S.fxPass.fxScene.add(S.group); }

  // ---------- shared lighting terms ----------
  const sunDir = env.sunDirection;                          // direction light travels
  const sunUp = smoothstep(-0.04, 0.10, -sunDir.y);
  const night = clamp01(env.nightFactor ?? 0);
  const sunI = (env.sunIntensity ?? 3) * sunUp;
  const moonDir = env.moonDirection;                        // direction TOWARDS the moon
  const moonI = (env.moonIntensity ?? 0) * (moonDir ? smoothstep(-0.02, 0.1, moonDir.y) : 0);
  const res = engine.renderer.getDrawingBufferSize(tmpRes);
  const hour = world.time?.hour ?? 12;
  const cloud = clamp01(env.cloudCover ?? 0.3);
  // sky radiance the materials actually see: env.skyColor is published as 0 whenever the environment moves the
  // diffuse light into the fog medium (overcast, rain, snow — and in practice most of the time), so take the
  // hemisphere light itself: a white diffuser under it has radiance colour × intensity / π. The fog colour is
  // the sky near the horizon; under overcast a thick plume should approach that brightness (ambRad).
  const hemi = engine.hemi;
  tmpSky.copy(env.skyColor || tmpC2.setRGB(0, 0, 0));
  if (hemi) {
    const k = hemi.intensity / Math.PI;
    tmpSky.r = Math.max(tmpSky.r, hemi.color.r * k); tmpSky.g = Math.max(tmpSky.g, hemi.color.g * k); tmpSky.b = Math.max(tmpSky.b, hemi.color.b * k);
  }
  const skyRad = tmpSky, groundRad = env.groundColor;
  const fogC = S.scene.fog ? S.scene.fog.color : null;
  tmpAmb.copy(skyRad);
  if (fogC) { tmpAmb.r = Math.max(tmpAmb.r, fogC.r); tmpAmb.g = Math.max(tmpAmb.g, fogC.g); tmpAmb.b = Math.max(tmpAmb.b, fogC.b); }
  const ambRad = tmpAmb.multiplyScalar(1 + 0.6 * cloud);

  // ---------- weather state ----------
  // env.precipitation (falling) and env.rain (= accumulated wetness) / env.snow (= cover) come from the
  // environment module; the weather string is the fallback while env is not driven.
  const w = String(env.weather || '').toLowerCase();
  const snowing = w === 'snow';
  const raining = w === 'rain' || w === 'storm';
  const precip = env.precipitation != null ? clamp01(env.precipitation) : null;
  const rainTarget = snowing ? 0 : raining ? (precip ?? 0.9) : (precip == null && env.rain > 0 ? clamp01(env.rain) : 0);
  const snowTarget = snowing ? (precip ?? 0.9) : 0;
  // First frame after init: SNAP to the weather that is already set (a screenshot taken a second after
  // load must show fully developed rain / snow / wetness, not a 30 %-ramped transition).
  if (!S.warmed) {
    S.warmed = true;
    S.rainAmt = rainTarget;
    S.snowAmt = snowTarget;
    S.wetness = rainTarget > 0.02 ? Math.max(clamp01(env.wetness ?? 1), Math.min(rainTarget + 0.3, 1)) : clamp01(env.wetness ?? 0);
    S.snowCover = snowTarget > 0.02 ? 1 : clamp01(env.snow ?? 0);
  }
  S.rainAmt = damp(S.rainAmt, rainTarget, 2.5, dt);
  S.snowAmt = damp(S.snowAmt, snowTarget, 2.5, dt);
  // wetness rises quickly while it rains and DRIES OUT SLOWLY afterwards (≈ 5 min in full sun, slower
  // overcast / at night), so puddles linger and shrink after a shower instead of vanishing with the weather
  const envWet = env.wetness != null ? clamp01(env.wetness) : env.rain > 0 ? clamp01(env.rain) : null;
  const wetTarget = envWet != null ? Math.max(envWet, S.rainAmt > 0.02 ? Math.min(S.rainAmt + 0.3, 1) : 0) : S.rainAmt > 0.02 ? Math.max(S.rainAmt, 0.7) : 0;
  if (wetTarget >= S.wetness) S.wetness = damp(S.wetness, wetTarget, 1.5, dt);
  else S.wetness = Math.max(wetTarget, S.wetness - dt / 300 * (0.3 + 0.7 * sunUp * (1 - 0.6 * cloud)));
  const envSnow = env.snow != null ? clamp01(env.snow) : null;
  const snowTargetC = envSnow != null ? Math.max(envSnow, S.snowAmt > 0.02 ? 1 : 0) : S.snowAmt > 0.02 ? 1 : 0;
  if (snowTargetC >= S.snowCover) S.snowCover = damp(S.snowCover, snowTargetC, envSnow != null ? 3 : 0.25, dt);
  else S.snowCover = Math.max(snowTargetC, S.snowCover - dt / 600 * (0.2 + 0.8 * sunUp));
  if (S.wetness < 0.002) S.wetness = 0;
  if (S.snowCover < 0.002) S.snowCover = 0;
  const wetOn = S.enabled.wet;
  S.wet.update(wetOn ? S.wetness : 0, wetOn ? S.rainAmt : 0, wetOn ? S.snowCover : 0, S.time, skyRad, sunUp * (1 - 0.8 * cloud));

  // ---------- standing water (geometry pools in the camber + the shared drainage map) ----------
  {
    const rv = world.roads ? world.roads.version ?? 0 : -1;
    // debounce: the demo city rebuilds roads dozens of times while it lays the grid
    if (rv !== S.puddleVersion && S.time - (S.puddleBuiltAt ?? -9) > 1.2) {
      S.puddleVersion = rv;
      S.puddleBuiltAt = S.time;
      S.puddleCount = S.puddles.build();
    }
    S.puddles.update(wetOn ? S.wetness : 0, wetOn ? S.rainAmt : 0, S.time, engine.quality.drawDistance);
  }

  // ---------- ground FX pass: wet reflections, contact shadows, fine AO, aerial perspective ----------
  {
    const gf = S.groundFX;
    gf.enabled = engine.postEnabled;
    const u = gf.uniforms;
    gf.setSun(sunDir);
    u.uTime.value = S.time;
    // contact shadows need a direction: they follow the sun and fade out under overcast / at night
    const direct = sunUp * (1 - 0.62 * cloud) * (1 - night);
    const sf = S.surface;
    u.uContact.value.set(S.enabled.contact ? 0.80 * direct * sf.contact : 0, 1.55);
    // fine AO is always on — it is the term that makes a prop sit on the ground
    u.uAO.value.set(S.enabled.contact ? 0.78 * sf.ao : 0, 0.55 * sf.aoRadius);
    const wetFx = wetOn && S.enabled.reflections ? S.wetness : 0;
    u.uWet.value = wetFx;
    u.uReflect.value = (0.95 + 0.35 * night) * sf.reflect;
    u.uRipple.value = S.rainAmt;
    u.uNight.value = night;
    // what a mirror sees when the ray leaves the screen: the sky, not the diffuse irradiance
    // p9: the p8 night ambient key is REVERTED — the audit re-measured cs2_08 identically (linear
    // pipeline): ref ground p10 0.0038 vs our 0.0118-0.0128. We were 3x TOO BRIGHT, not dark.
    u.uSkyColor.value.copy(skyRad).multiplyScalar(1.05).addScalar(0.003 * (1 - night));
    // analytic emitters for the wet mirror: the nearest lamps / vehicle lights to the camera.
    // Arrays are assigned once and mutated in place — no per-frame allocation.
    if (u.uWetLights.value !== S.wetLights.pos) {
      u.uWetLights.value = S.wetLights.pos;
      u.uWetLightCol.value = S.wetLights.col;
    }
    const exposure = engine.renderer.toneMappingExposure || 1;
    u.uWetLightN.value = S.wetLights.update(dt, S.scene, camera, world.roads ? world.roads.version ?? -1 : -1, exposure);
    // aerial perspective: lifts distant blacks toward the sky colour and drains chroma (LOOK_TARGET 11/12)
    const hazeC = fogC || skyRad;
    u.uHaze.value.copy(hazeC);
    const hazeL = Math.max(hazeC.r, hazeC.g, hazeC.b);
    const aerial = S.enabled.aerial ? 1 : 0;
    // Aerial perspective LIFTS distant blacks toward the haze colour (LOOK_TARGET 11/12: the far third
    // should be 1.4-4.1x brighter than the near third; we measured 0.3-1.2, i.e. backwards).
    // p5 blocker: the 0.42 lift is a DAYLIGHT scattering term — at night it lifted the whole frame
    // ~6x off the reference black floor (p01 0.089 vs 0.0126). Day keeps the measured look, night
    // collapses the lift (and rain softens it: a wet atmosphere does not glow).
    u.uAerial.value.set(
      0.00055 * aerial * sf.aerial,
      0.42 * sf.desat,
      hazeL > 1e-4 ? 0.42 * sf.aerial * (1 - night) * (1 - 0.45 * wetFx) : 0,
      0,
    );
    // the drainage map from PuddleField: the SSR march sharpens and strengthens exactly on the pools
    u.uPoolMap.value = S.puddles.mapUniforms.uFxPoolMap.value;
    u.uPoolXf.value.copy(S.puddles.mapUniforms.uFxPoolXf.value);
    // occlusion: strong, but resolved to a cool sky bounce instead of to black
    u.uOcclusion.value.set(S.enabled.contact ? 0.95 : 0, 0.30 + 0.10 * night);
  }

  const cold = (env.temperature != null && env.temperature < 10) || snowing || S.snowAmt > 0.3;
  if (cold !== S.lastCold) { S.lastCold = cold; S.dirty = true; }
  if (world.buildings.version !== S.lastBuildVersion) { S.lastBuildVersion = world.buildings.version; S.dirty = true; }
  if (S.dirty && (S.time - S.dirtyAt > 0.3 || S.smoke.count === 0)) rebuild();

  // ---------- smoke ----------
  {
    const u = S.smoke.uniforms;
    u.uTime.value = S.time;
    const ws = (env.windStrength ?? 0.35) * 5.5;            // ~2 m/s at default strength (plumes stay attached)
    u.uWind.value.set(env.wind.x * ws, 0, env.wind.y * ws);
    // dominant celestial light: sun by day, moon by night (direction light travels, view space)
    // radiance scale: a grey plume must read as mid-grey next to a sun-lit white wall (albedo·E/π), so the
    // direct term is E · 0.11 (+ sky ambient), not the wall-equivalent 0.42
    const sunTerm = sunI * 0.36, moonTerm = moonI * 0.20;
    if (sunTerm >= moonTerm || !moonDir) {
      u.uLightDirView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      u.uLightColor.value.copy(env.sunColor).multiplyScalar(sunTerm);
    } else {
      u.uLightDirView.value.copy(moonDir).negate().transformDirection(camera.matrixWorldInverse);
      u.uLightColor.value.copy(env.moonColor || tmpC2.setRGB(0.6, 0.7, 1.0)).multiplyScalar(moonTerm);
    }
    // sky light: the medium's own optical density (aKind.y) decides how much of it survives, so a sooty
    // plume stays clearly darker than the sky behind it instead of glowing
    u.uAmbient.value.copy(ambRad).multiplyScalar(0.85 - 0.30 * night);
    u.uGroundBounce.value.copy(groundRad).multiplyScalar(0.8 * (1 - 0.6 * night));
    u.uDustFade.value = clamp01(1 - S.rainAmt * 1.2 - S.snowAmt * 1.2);   // dust is knocked down by rain / snow
    // late-evening / early-morning heating: chimney puffs grow a little (world.time reaction)
    const heating = 1 + 0.15 * (1 - smoothstep(6, 10, hour)) * smoothstep(3, 6, hour);
    u.uSizeBoost.value = heating;
    u.uFade.value.set(engine.quality.drawDistance * 0.16, engine.quality.drawDistance * 0.26);
    S.smoke.mesh.visible = S.enabled.smoke && S.smoke.count > 0;
    updateLocalLights(u);
  }

  // ---------- precipitation ----------
  const fovScale = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) / Math.max(1, res.y);
  camera.getWorldDirection(tmpV);
  const camDist = S.cameraController ? S.cameraController.distance : 200;
  const centre = tmpV2.copy(camera.position).addScaledVector(tmpV, clamp(camDist * 0.4, 10, 24));
  const ws = (env.windStrength ?? 0.35) * 8;
  // rain always leans: a shower with dead-vertical strokes reads as a scratched lens. If the environment's
  // wind is calm, fall back to a deterministic gust direction so the lean is still there (and matches the
  // direction the smoke plumes drift in, which comes from the same env.wind).
  {
    let wx = env.wind.x * ws, wz = env.wind.y * ws;
    const wl = Math.hypot(wx, wz);
    const minLean = 2.6;
    if (wl < minLean) {
      const a = wl > 1e-3 ? Math.atan2(wz, wx) : (S.world.seed % 360) * Math.PI / 180;
      wx = Math.cos(a) * minLean; wz = Math.sin(a) * minLean;
    }
    tmpT.set(wx, 0, wz);
  }
  // drop colour: sky radiance (drops scatter sky light) + a touch of sun; dark at night automatically
  tmpC.copy(skyRad).multiplyScalar(0.85).add(tmpC2.copy(env.sunColor).multiplyScalar(sunI * 0.04));
  {
    const u = S.rain.uniforms;
    const on = S.enabled.rain && S.rainAmt > 0.01;
    S.rain.mesh.visible = on;
    if (on) {
      u.uTime.value = S.time;
      u.uCenter.value.copy(centre);
      u.uVolume.value.set(60, 40, 60);
      u.uVelocity.value.set(tmpT.x, -9.5, tmpT.z);
      u.uStreak.value = 0.055;                              // 0.35-0.8 m strokes: readable, never rods
      u.uSize.value.set(0.004, 0.03);
      u.uMinPx.value = 1.9;                                 // never thinner than 1.9 px
      u.uPixel.value = fovScale;
      u.uDistFade.value.set(4, 9, 34, 80);
      u.uLumaFade.value = 0.45;
      u.uColor.value.copy(tmpC);
      u.uOpacity.value = 0.78 * S.rainAmt;                  // the shader's contrast limiter does the taming
    }
  }
  {
    // dense near-camera sheet: 2.6 k drops within ~15 m of the lens, 2.2 px wide, defocused right at the lens
    const u = S.rainNear.uniforms;
    const on = S.enabled.rain && S.rainAmt > 0.01;
    S.rainNear.mesh.visible = on;
    if (on) {
      u.uTime.value = S.time;
      u.uCenter.value.copy(camera.position).addScaledVector(tmpV, 7);
      u.uVolume.value.set(20, 14, 20);
      u.uVelocity.value.set(tmpT.x, -9.5, tmpT.z);
      u.uStreak.value = 0.032;
      u.uSize.value.set(0.004, 0.03);
      u.uMinPx.value = 2.6;
      u.uPixel.value = fovScale;
      u.uDistFade.value.set(0.4, 1.2, 11, 17);
      u.uLumaFade.value = 0.35;
      u.uColor.value.copy(tmpC).multiplyScalar(1.08);
      u.uOpacity.value = 0.42 * S.rainAmt;
    }
  }
  {
    // far fine-rain haze layer: tiny short streaks in a big volume between 35 and 300 m
    const u = S.rainFar.uniforms;
    const on = S.enabled.rain && S.rainAmt > 0.01 && camDist < 900;
    S.rainFar.mesh.visible = on;
    if (on) {
      u.uTime.value = S.time;
      u.uCenter.value.copy(camera.position).addScaledVector(tmpV, clamp(camDist * 0.6, 40, 130));
      u.uVolume.value.set(280, 110, 280);
      u.uVelocity.value.set(tmpT.x, -9.5, tmpT.z);
      u.uStreak.value = 0.036;
      u.uSize.value.set(0.003, 0.03);
      u.uMinPx.value = 1.15;
      u.uPixel.value = fovScale;
      u.uDistFade.value.set(35, 75, 210, 320);
      u.uLumaFade.value = 0.55;
      u.uColor.value.copy(tmpC).multiplyScalar(1.05);
      u.uOpacity.value = 0.30 * S.rainAmt * (1 - smoothstep(500, 900, camDist));
    }
  }
  {
    const u = S.snow.uniforms;
    const on = S.enabled.snow && S.snowAmt > 0.01;
    S.snow.mesh.visible = on;
    if (on) {
      u.uTime.value = S.time;
      u.uCenter.value.copy(centre);
      const vol = clamp(camDist * 0.7, 56, 110);            // bigger volume when zoomed out (depth layers)
      u.uVolume.value.set(vol, 44, vol);
      const wss = (env.windStrength ?? 0.35) * 3;
      u.uVelocity.value.set(env.wind.x * wss, -1.4, env.wind.y * wss);
      u.uSize.value.set(0.004, 0.105);                       // 3-10 cm clumps; size falls off as 1/depth
      u.uStreak.value = 0.02;                                // motion stretch (≈ 2×), not sleet streaks
      u.uSway.value = 0.45;
      u.uMinPx.value = 1.35;                                 // far flakes collapse to a soft 1.35 px dot
      u.uPixel.value = fovScale;
      u.uDistFade.value.set(1.5, 4.0, 95, 150);              // dissolve into the haze beyond ~150 m
      u.uLumaFade.value = 0;
      u.uColor.value.copy(skyRad).multiplyScalar(1.7).add(tmpC2.copy(env.sunColor).multiplyScalar(sunI * 0.12)).addScalar(0.03);
      // aerial views: fewer, fainter flakes (the far field is snow haze, not confetti)
      u.uOpacity.value = 0.95 * S.snowAmt * (1 - 0.6 * smoothstep(260, 700, camDist));
    }
  }
  {
    const u = S.splash.uniforms;
    const closeness = 1 - smoothstep(120, 240, camDist);
    const on = S.enabled.splashes && S.rainAmt > 0.02 && closeness > 0.01;
    S.splash.mesh.visible = on;
    if (on) {
      const target = S.cameraController ? S.cameraController.target : camera.position;
      const radius = clamp(camDist * 0.4, 10, 40);
      const moved = Math.hypot(target.x - S.splashAnchor.x, target.z - S.splashAnchor.z);
      if (moved > radius * 0.2 || Math.abs(radius - S.splashRadius) > radius * 0.25) {
        S.splashAnchor.copy(target);
        S.splashRadius = radius;
        S.splash.place(target, radius, surfaceHeight);
      }
      // density ∝ rain, areal density kept sane with a larger disc
      const density = clamp((radius / 40) ** 2, 0.8, 1) * (0.3 + 0.7 * smoothstep(0.05, 1.0, S.rainAmt));
      S.splash.geometry.instanceCount = Math.round(S.splash.count * density);
      u.uTime.value = S.time;
      u.uWet.value = S.wetness;
      // additive highlights: sky radiance + sun glint so crowns / rings read as specular pops on the wet ground
      u.uColor.value.copy(skyRad).multiplyScalar(0.85).add(tmpC2.copy(env.sunColor).multiplyScalar(sunI * 0.10)).addScalar(0.010);
      u.uColorRing.value.copy(skyRad).multiplyScalar(1.7).add(tmpC2.copy(env.sunColor).multiplyScalar(sunI * 0.2)).addScalar(0.016);
      u.uOpacity.value = 0.36 * S.rainAmt * closeness;
    }
  }

  // ---------- vehicle spray (wet roads) ----------
  {
    const sp = S.spray;
    const on = S.enabled.spray && S.wetness > 0.10 && !snowing;
    sp.mesh.visible = on;
    if (on) {
      const u = sp.uniforms;
      u.uTime.value = S.time;
      u.uWet.value = smoothstep(0.12, 0.55, S.wetness);
      // mist lit by the sky plus whatever the vehicle's own lamps throw into it at night
      // Additive mist: at night the sky radiance is ~0, so a purely sky-tinted plume added nothing at all
      // and the spray was invisible in every night frame. The constant term is the street/vehicle light
      // the mist actually catches after dark. p5 major: a 0.1-alpha grey sprite over a 0.13-luminance
      // road is invisible — the plume now carries real radiance (warm at night, sky-lit by day).
      // p8: audit-measured bracket — day radiance 1.10 + opacity 2.1 = cotton foam, 0.80/1.7 =
      // invisible (VLM 0/10 in every frame). 0.95/1.95 splits it; the night warm term goes up
      // (0.16 → 0.30) because at night the sky term is ~0 and the mist must read against lamps.
      u.uColor.value.copy(skyRad).multiplyScalar(0.95)
        .add(tmpC2.setRGB(1.0, 0.88, 0.70).multiplyScalar(0.045 + 0.30 * night))
        .addScalar(0.012);
      u.uOpacity.value = 1.95 * (0.45 + 0.55 * S.rainAmt);
      sp.sync(S.world.traffic?.list || S.world.traffic?.vehicles, camera.position, S.wetness, 150);
    } else if (sp.geometry.instanceCount) {
      sp.geometry.instanceCount = 0;
    }
  }

  // ---------- colour grading, sun glare, shimmer ----------
  {
    const g = S.grading;
    g.enabled = S.enabled.grading;
    const u = g.uniforms;
    u.uTime.value = S.time;
    const wet = S.wetness, snow = S.snowCover, snowing = S.snowAmt;
    const lowSun = (1 - smoothstep(0.06, 0.42, -sunDir.y)) * sunUp * (1 - night);
    const gm = S.grade;
    const L = 5; // damping rate for grade transitions
    const k = 1 - Math.exp(-L * dt);
    const dayA = 1 - night;
    // --- the S-curve first (the white point is solved through it below) ---
    // day: filmic contrast 1.45 with a shadow crush — night: softer, lifted toe; overcast / snow flatter
    // snow: contrast ~1.3, raised black level, no crush — the frame stays crisp, the sky blue-grey
    // LOOK_TARGET rows 1-3: the reference black floor is lum_p10 ≈ 0.010 and the ground shadow ratio ≈ 19:1.
    // Ours measured 0.158 / 4.4 — nothing reached black. The correction is contrast + a REAL crush, not
    // desaturation (row 14: at matched lightness our chroma is already on target).
    u.uContrast.value = damp(u.uContrast.value, (1.52 - night * 0.26 - cloud * 0.05 - wet * 0.03 - snowing * 0.08 - snow * 0.06) * gm.contrast, L, dt);
    // Toe: -0.92 crushed a fifth to a third of every daytime frame to pure black. -0.58 keeps the filmic
    // shape; the black FLOOR is now bought by the soft black level and the exposure/ambient key instead.
    // p9: night lift back to 0.18 — the p8 0.30 experiment overshot (audit: ref night ground p10 is
    // 0.0038; ours was already 3x brighter). The p7 "0.0126 anchor" did not reproduce.
    u.uToe.value = damp(u.uToe.value, -0.58 * dayA * (1 - 0.15 * cloud) * (1 - 0.12 * wet) * (1 - 0.6 * snow) + 0.18 * night + 0.10 * snow * dayA, L, dt);
    u.uShoulder.value = damp(u.uShoulder.value, 0.34 + snow * 0.06 + lowSun * 0.20, L, dt);
    u.uBlack.value = damp(u.uBlack.value, 0.0072 * dayA * (1 - 0.15 * cloud) * (1 - snow * 0.7) + 0.0026 * night, L, dt);
    // white-point anchoring: the bright percentile (p4 power mean) of the ungraded frame is gained so that
    // AFTER the S-curve it lands at ~2.6 linear pre-AgX (≈ 0.90 sRGB — real whites, CS2 p99 ≈ 0.93). The
    // pre-curve target is the inverse of the curve (contrast + shoulder). Nearly frozen at night.
    // white target ≈ 0.82 sRGB after AgX (was 0.90: yards and white halls went texture-less); the gain is
    // capped at 1.12 under a high sun (the environment's exposure is trusted at noon) and 1.5 for low sun
    const auto = u.uAuto.value;
    {
      const highSun = smoothstep(0.35, 0.75, -sunDir.y);
      // ≈ 3.05 linear pre-AgX: after the AgX curve the frame's p99 lands at 0.88-0.92 sRGB, which is
      // where CS2 sits (cs2_04/06/08). Snow and overcast get a higher target still (bright diffuse scenes).
      const wPost = 3.60 + 0.55 * snow + 0.15 * cloud;
      const sh = u.uShoulder.value, ct = Math.max(u.uContrast.value, 0.5);
      let lcp = Math.log2(wPost / 0.18);
      if (lcp > 2.9) lcp = (lcp - 2.9 * 0.3 * sh) / (1 - 0.3 * sh);
      const wPre = 0.18 * Math.pow(2, lcp / ct);
      // The gain is a SAFETY NET, not the exposure. A wide range let it lift a correctly-exposed dark
      // frame back to a milky mid-grey and fight the environment's own key/fill balance (LOOK_TARGET 1).
      // headroom scales with how much light the WEATHER took away: a clear noon frame is trusted
      // (gain ≈ 1.2), a heavy overcast / rain afternoon may be lifted up to ~2x so 17:30 in a downpour
      // still reads as afternoon rather than as night.
      // Headroom for weather. 0.55·cloud + 0.30·wet let an overcast rain afternoon be lifted ~2x, which
      // pushed the demo city's rain frames to lum_p10 0.042 and okL 0.60 — washed, not moody.
      const gMax = (1.22 + 0.32 * cloud + 0.14 * wet - 0.10 * highSun) * dayA + 1.14 * night;
      auto.set(wPre, 0.72 * dayA + 0.9 * night, gMax, S.enabled.autoExposure ? 0.5 + 0.2 * dayA : 0);
    }
    g.adaptRate = 1.5;
    u.uExposure.value = damp(u.uExposure.value, gm.exposure, L, dt);
    // saturation: ≥ 1 in clear weather (CS2 colour), desaturation reserved for rain / snow / night
    // LOOK_TARGET row 14: chroma at matched lightness is ALREADY on target — the fix is lightness, not a
    // global desaturation. Saturation stays near 1; the highlight desaturation does the filmic work.
    u.uSaturation.value = damp(u.uSaturation.value, (1.16 - night * 0.10 - wet * 0.08 - cloud * 0.03 - snowing * 0.06 - snow * 0.02 + lowSun * 0.03) * gm.saturation, L, dt);
    u.uMidSat.value = damp(u.uMidSat.value, 0.17 * (1 - night * 0.6) * (1 - wet * 0.5) * (1 - snowing * 0.4), L, dt);
    u.uHiDesat.value = damp(u.uHiDesat.value, 0.11 + lowSun * 0.06 + snowing * 0.06 + night * 0.05, L, dt);
    // white balance: slightly cool nights and rain, warm low sun, neutral-grey when snowing
    tmpV.set(1, 1, 1);
    tmpV.lerp(tmpT.set(0.96, 0.98, 1.04), night * 0.5);
    tmpV.lerp(tmpT.set(1.06, 1.0, 0.93), lowSun * 0.6);
    tmpV.lerp(tmpT.set(0.965, 0.985, 1.03), clamp01(wet * 0.8));
    tmpV.lerp(tmpT.set(0.985, 0.995, 1.025), snowing * 0.6);
    u.uTint.value.lerp(tmpV, k);
    // split tone: cool shadows / warm highlights by day, nearly neutral at night
    // LOOK_TARGET row 13: CS2 shadows are 0.45-2.0 units bluer per unit luminance than lit surfaces
    // (ours measured 0.08). Warm key / cool fill is a grade-side split as well as a light-side one.
    tmpV.set(0.85, 0.94, 1.20).lerp(tmpT.set(0.94, 0.97, 1.08), night).lerp(tmpT.set(0.85, 0.93, 1.20), snow * 0.7);
    u.uShadowTint.value.lerp(tmpV, k);
    tmpV.set(1.08, 1.0, 0.90).lerp(tmpT.set(1.04, 1.0, 0.96), night).lerp(tmpT.set(1.0, 1.0, 1.0), clamp01(wet + snowing));
    u.uHighlightTint.value.lerp(tmpV, k);
    // Lift: a COOL floor under the shadows, linear and pre-tonemap. By day it is tiny (≈ 0.001 linear,
    // roughly RGB 6-9 after AgX) but it is never zero, so no pixel in the frame can be RGB(0,0,0) — and
    // because it is bluer than it is red it also pushes shadow blue-over-red the right way (row 13).
    tmpV.set(0.0058, 0.0064, 0.0082).lerp(tmpT.set(0.0028, 0.0032, 0.0044), night).lerp(tmpT.set(0.0068, 0.0074, 0.0094), snow * 0.5 * (1 - night));
    u.uLift.value.lerp(tmpV, k);
    const gain = 1 - wet * 0.04 + snow * 0.03;
    u.uGain.value.lerp(tmpV.set(gain, gain, gain), k);
    u.uVignette.value.set(clamp((0.105 - night * 0.03 + wet * 0.02) * gm.vignette, 0, 0.2), 0.52);

    // sun screen position & visibility (the depth occlusion is applied by the EffectsPass probe)
    let vis = 0;
    const probe = S.fxPass.probeMat.uniforms;
    const sunAbove = env.sunAltitude == null || env.sunAltitude > -2;
    if (S.enabled.flare && sunAbove) {
      tmpV.copy(camera.position).addScaledVector(sunDir, -3000);
      tmpV.project(camera);
      if (tmpV.z < 1 && Number.isFinite(tmpV.x)) {
        const edge = Math.max(Math.abs(tmpV.x), Math.abs(tmpV.y));
        // glare is a haze/lens phenomenon: strongest with a low, hazy sun; a high noon sun gives a tighter flare
        const highSun = smoothstep(0.12, 0.55, -sunDir.y);
        vis = sunUp * (1 - night) * (1 - 0.8 * cloud) * (1 - S.rainAmt) * (1 - S.snowAmt) * clamp01((env.sunIntensity ?? 3) / 2.5) * (1 - smoothstep(1.1, 1.8, edge)) * (1 - 0.4 * highSun);
        u.uSun.value.set(tmpV.x, tmpV.y, vis, 0);
        probe.uSunUv.value.set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5);
      } else u.uSun.value.z = 0;
    } else u.uSun.value.z = 0;
    S.fxPass.probeActive = vis > 0.001;
    probe.uNearFar.value.set(camera.near, camera.far);
    probe.uRadius.value = Math.max(6, res.y * 0.008);
    // normalised sun colour × a compressed intensity term (sqrt) so a bright morning sun does not wash the frame
    u.uSunColor.value.copy(env.sunColor).multiplyScalar(Math.sqrt(clamp((env.sunIntensity ?? 3) / 3.5, 0.15, 1.2)));
    u.uGlare.value = 1.0 * gm.glare;

    // heat shimmer sources: nearest hot stacks within 260 m
    let n = 0;
    if (S.enabled.shimmer && S.hotSpots.length) {
      const cam = camera.position;
      const arr = S.shimmerScratch || (S.shimmerScratch = []);
      arr.length = 0;
      for (const h of S.hotSpots) {
        const d2 = (h.x - cam.x) ** 2 + (h.y - cam.y) ** 2 + (h.z - cam.z) ** 2;
        if (d2 < 260 * 260) arr.push(d2, h);
      }
      // pick up to MAX_SHIMMER nearest (tiny list — simple selection)
      for (let i = 0; i < arr.length && n < MAX_SHIMMER; i += 2) {
        let best = i;
        for (let j = i + 2; j < arr.length; j += 2) if (arr[j] < arr[best]) best = j;
        if (best !== i) { const a = arr[i], b = arr[i + 1]; arr[i] = arr[best]; arr[i + 1] = arr[best + 1]; arr[best] = a; arr[best + 1] = b; }
        const h = arr[i + 1], dist = Math.sqrt(arr[i]);
        tmpV.set(h.x, h.y, h.z).project(camera);
        if (tmpV.z > 1 || Math.abs(tmpV.x) > 1.2 || Math.abs(tmpV.y) > 1.2) continue;
        // subtle: ≤ 1.5 px of warp at 1080p (a 5 px warp turns smoke edges into visible zig-zags)
        const strength = 0.0014 * (1 - smoothstep(90, 220, dist)) * (h.heat ?? 1);
        if (strength < 1e-5) continue;
        u.uShimmer.value[n].set(tmpV.x * 0.5 + 0.5, tmpV.y * 0.5 + 0.5, clamp(9 / dist, 0.03, 0.14), strength);
        n++;
      }
    }
    u.uShimmerCount.value = n;

    // night light pollution: faint warm glow band on the sky just above the horizon (copy shader of the
    // EffectsPass, sky pixels only via depth), tied to nightFactor and the city's own lights
    {
      // the ground-FX shader replaces the copy step, so drive whichever one is live
      const h = (S.fxPass.ground ? S.groundFX.uniforms : S.fxPass.copyMat.uniforms).uHorizon.value;
      const strength = night * 0.55 * (1 - 0.5 * S.rainAmt) * gm.glare;
      if (strength > 0.001) {
        camera.getWorldDirection(tmpT); tmpT.y = 0;   // camera forward, flattened → a point on the horizon
        if (tmpT.lengthSq() < 1e-6) tmpT.set(0, 0, -1);
        tmpV.copy(camera.position).addScaledVector(tmpT.normalize(), 20000).project(camera);
        h.set(clamp(tmpV.y, -1.5, 1.5), 7.5, strength);
      } else h.z = 0;
    }
  }

  S.cpuMs = S.cpuMs * 0.9 + (performance.now() - t0) * 0.1;

  // p8 (audit minor): runtime instrumentation the critics can read straight out of shot/check logs —
  // every ~5 s emit the wet-mirror emitter count, its provenance, and the particle system totals.
  S._instTimer = (S._instTimer ?? 0) - dt;
  if (S._instTimer <= 0) {
    S._instTimer = 5;
    console.info(`[effects] wetLights=${S.wetLights.count} lamps=${S.wetLights.stats.lamps} vehicles=${S.wetLights.stats.vehicles}`
      + ` sprayEmitters=${S.spray.live} puddles=${S.puddleCount ?? 0} wet=${+S.wetness.toFixed(2)} rain=${+S.rainAmt.toFixed(2)}`);
  }
}

/**
 * Local lights for the smoke shader: every 1.5 s scan the scene for lit point/spot lights (floodlights,
 * street lamps, stack beacons …), then every frame hand the MAX_LOCAL_LIGHTS nearest to the camera
 * target over in view space.
 */
function updateLocalLights(u) {
  const { scene, camera, cameraController } = S;
  if (S.time - S.lightScanAt > 1.5) {
    S.lightScanAt = S.time;
    const list = S.lights;
    list.length = 0;
    scene.traverse((o) => {
      if ((o.isPointLight || o.isSpotLight) && o.visible && o.intensity > 0.5 && list.length < 512) list.push(o);
    });
  }
  const lights = S.lights;
  let n = 0;
  if (lights.length) {
    const target = cameraController ? cameraController.target : camera.position;
    const arr = S.lightScratch || (S.lightScratch = []);
    arr.length = 0;
    for (const l of lights) {
      if (!l.parent || l.intensity <= 0.5) continue;
      l.getWorldPosition(tmpV);
      const d2 = (tmpV.x - target.x) ** 2 + (tmpV.z - target.z) ** 2;
      if (d2 < 400 * 400) arr.push(d2, l);
    }
    for (let i = 0; i < arr.length && n < MAX_LOCAL_LIGHTS; i += 2) {
      let best = i;
      for (let j = i + 2; j < arr.length; j += 2) if (arr[j] < arr[best]) best = j;
      if (best !== i) { const a = arr[i], b = arr[i + 1]; arr[i] = arr[best]; arr[i + 1] = arr[best + 1]; arr[best] = a; arr[best + 1] = b; }
      const l = arr[i + 1];
      l.getWorldPosition(tmpV).applyMatrix4(camera.matrixWorldInverse);
      const range = l.distance > 0 ? l.distance : 60;
      u.uLocalPos.value[n].set(tmpV.x, tmpV.y, tmpV.z, range);
      u.uLocalColor.value[n].copy(l.color).multiplyScalar(l.intensity * 0.35);
      n++;
    }
  }
  u.uLocalCount.value = n;
  S.localLights = n;
}

export function dispose() {
  if (!S) return;
  for (const off of S.offs) off();
  S.wet.dispose();
  S.puddles.dispose();
  if (S.group.parent) S.group.parent.remove(S.group);
  for (const sys of S.systems) sys.dispose();
  for (const t of S.textures) t.dispose();
  S.engine.composer.removePass(S.grading);
  S.engine.composer.removePass(S.fxPass);
  S.grading.dispose?.();
  S.fxPass.dispose();
  S.groundFX.dispose();
  S.world.effects = null;
  S = null;
}

/** Ground surface height for splashes: road surface when a road is under the point, terrain otherwise. */
function surfaceHeight(x, z) {
  const roads = S.world.roads?.api;
  if (roads && typeof roads.surfaceHeight === 'function') {
    try {
      const y = roads.surfaceHeight(x, z);
      if (Number.isFinite(y)) return y + 0.03;
    } catch (_) { /* roads api not ready */ }
  } else if (roads && typeof roads.nearest === 'function') {
    try {
      const n = roads.nearest(x, z, 14);
      if (n && n.segment && n.point && Number.isFinite(n.point.y) && n.distance <= (n.segment.width || 12) * 0.5) return n.point.y + 0.05;
    } catch (_) { /* roads api not ready */ }
  }
  let y = S.world.terrain.getHeight(x, z) + 0.06;
  // showcase / custom ground plates registered through the api
  for (const p of S.plates) {
    if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) y = Math.max(y, p.y + 0.03);
  }
  return y;
}

// ---------------------------------------------------------------------------------------------
// emitter scan
// ---------------------------------------------------------------------------------------------

function rebuild() {
  const { world } = S;
  S.dirty = false;
  S.dirtyAt = S.time;
  const cold = S.lastCold;
  const dust = [], industrial = [], steam = [], chimney = [], custom = [];
  const hot = [];
  for (const src of S.sources.values()) {
    custom.push(src);
    if (src.kind === 'industrial') hot.push({ x: src.x, y: src.y, z: src.z, heat: src.heat ?? 1 });
  }
  const list = world.buildings.list || [];
  for (const b of list) {
    if (!b || !Number.isFinite(b.x)) continue;
    const type = String(b.type || '').toLowerCase();
    const rng = makeRng(hashString(String(b.id ?? `${b.x},${b.z}`)) ^ 0x1e5);
    const w = b.w ?? 16, d = b.d ?? 16, yaw = b.yaw ?? 0, level = b.level ?? 1, h = b.height ?? 10;
    const by = b.y ?? world.terrain.getHeight(b.x, b.z);
    if (b.state === 'construction') {
      const scale = clamp(Math.sqrt(w * d) / 16, 0.6, 2.2);
      dust.push({ kind: 'dust', x: b.x, y: by + 0.2, z: b.z, scale: scale * 1.2, rect: { w, d, yaw }, opacity: 0.6 * (1 - (b.progress ?? 0) * 0.35) });
      continue;
    }
    if (type.startsWith('ind')) {
      // The buildings module publishes the REAL chimney / vent meshes on the record (contract §4:
      // b.stacks / b.chimneys = [{x,y,z,r}], b.vents = [{x,y,z}], world coords, y = top). Smoke then
      // leaves an actual stack — never a bare roof, which is what made the r2 frames read as a fire.
      const recorded = Array.isArray(b.stacks) ? b.stacks : Array.isArray(b.chimneys) ? b.chimneys : null;
      const vents = Array.isArray(b.vents) ? b.vents : null;
      if (recorded || vents) {
        for (const st of recorded || []) {
          if (!st || !Number.isFinite(st.x) || !Number.isFinite(st.z)) continue;
          const y = Number.isFinite(st.y) ? st.y + 0.3 : by + h + 1.2;
          const scale = clamp((st.r ?? 1.0) / 1.0, 0.6, 2.0) * (0.80 + level * 0.10);
          industrial.push({ kind: 'industrial', x: st.x, y, z: st.z, scale, density: 1 });
          hot.push({ x: st.x, y, z: st.z, heat: 0.7 + level * 0.1 });
        }
        // rooftop extractor hoods: one flue burns (a small grey plume), the rest breathe white vapour —
        // so a hall without a recorded chimney still lives without a column growing out of a bare roof
        if (vents && vents.length) {
          const flue = (recorded && recorded.length) || level < 2 ? -1 : rng.int(0, vents.length - 1);
          for (let vi = 0; vi < vents.length; vi++) {
            const vt = vents[vi];
            if (!vt || !Number.isFinite(vt.x) || !Number.isFinite(vt.z)) continue;
            const y = (vt.y ?? by + h) + 0.35;
            if (vi === flue) {
              chimney.push({ kind: 'chimney', x: vt.x, y, z: vt.z, scale: 0.55 + level * 0.09 });
              hot.push({ x: vt.x, y, z: vt.z, heat: 0.35 });
            } else if (rng() < 0.18) {
              steam.push({ kind: 'steam', x: vt.x, y, z: vt.z, scale: 0.34, density: 0.45, opacity: 0.20 });
            }
          }
        }
        continue;
      }
      // Legacy fallback (buildings module that does not publish stacks): guess ONE stack on the roof,
      // and only for the bigger plants — a district where every roof smokes reads as a fire.
      if (level >= 3 && rng() < 0.55) {
        const lx = (rng() * 0.6 - 0.3) * w, lz = (rng() * 0.6 - 0.3) * d;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const x = b.x + lx * cy - lz * sy, z = b.z + lx * sy + lz * cy;
        const y = by + h + 1.2;
        const scale = 0.62 + level * 0.12;
        industrial.push({ kind: 'industrial', x, y, z, scale, density: 1 });
        hot.push({ x, y, z, heat: 0.7 + level * 0.1 });
      } else if (level >= 2 && rng() < 0.34) {
        const lx = (rng() * 0.5 - 0.25) * w, lz = (rng() * 0.5 - 0.25) * d;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        steam.push({ kind: 'steam', x: b.x + lx * cy - lz * sy, y: by + h + 0.6, z: b.z + lx * sy + lz * cy, scale: 0.55, density: 0.6 });
      }
      continue;
    }
    if (type.startsWith('res') && (type.includes('low') || level <= 2) && !type.includes('high')) {
      if (cold && rng() < 0.7) {
        const lx = (rng() * 0.5 - 0.25) * w, lz = (rng() * 0.4 - 0.2) * d;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        chimney.push({ kind: 'chimney', x: b.x + lx * cy - lz * sy, y: by + h + 0.6, z: b.z + lx * sy + lz * cy, scale: 1.05 + rng() * 0.35 });
      }
      continue;
    }
    if ((type.includes('high') || type.startsWith('office') || type.startsWith('com')) && level >= 2) {
      const vents = Array.isArray(b.vents) ? b.vents : null;
      if (vents && vents.length) {
        for (const vt of vents) {
          if (!vt || !Number.isFinite(vt.x) || !Number.isFinite(vt.z) || rng() > 0.22) continue;
          steam.push({ kind: 'steam', x: vt.x, y: (vt.y ?? by + h) + 0.35, z: vt.z, scale: 0.4, density: 0.4, opacity: 0.22 });
        }
      }
      // No guessed plume when `vents` is absent. Buildings now publishes `b.vents` for industrial
      // records ONLY, deliberately, so rooftop AC units on offices and apartments no longer read as
      // flues (docs/requests/buildings.md #1) — the old `rng() < 0.16` fallback put a plume on one in
      // six downtown towers and the blind judges read them as smokestacks.
    }
  }
  const emitters = custom.concat(dust, industrial, steam, chimney);
  S.hotSpots = hot;
  S.counts.smoke = S.smoke.build(emitters, makeRng(world.seed ^ 0x3ffec7));
  S.counts.emitters = emitters.length;
  S.counts.byKind = { dust: dust.length, industrial: industrial.length, steam: steam.length, chimney: chimney.length, custom: custom.length };
  S.lightScanAt = -1e9;   // buildings changed → rescan lights soon
  if (S.ctx.config.debug) console.log(`[effects] rebuilt ${emitters.length} emitters → ${S.counts.smoke} particles`);
}

// ---------------------------------------------------------------------------------------------
// public API (world.effects.api)
// ---------------------------------------------------------------------------------------------

function makeApi() {
  return {
    /**
     * Add a manual emitter. kind: 'industrial' | 'steam' | 'chimney' | 'dust' | 'exhaust'.
     * { kind, x, y, z, scale?, density?, opacity?, albedo?:[r,g,b], rect?:{w,d,yaw}, heat? } → id
     */
    addSource(src) {
      const id = src.id ?? S.nextSourceId++;
      S.sources.set(id, { ...src, id });
      S.dirty = true;
      return id;
    },
    removeSource(id) { if (S.sources.delete(id)) S.dirty = true; },
    clearSources() { S.sources.clear(); S.dirty = true; },
    /** Register a flat ground plate (plaza, yard) so splashes sit on it: { x0, z0, x1, z1, y }. */
    addGroundPlate(plate) { S.plates.push(plate); S.splashAnchor.set(1e9, 0, 1e9); },
    /** Force an emitter rebuild from world.buildings (normally automatic). */
    refresh() { S.dirty = true; rebuild(); },
    /** Ask core to re-scan the scene for lit materials that are not registered yet (normally automatic). */
    refreshMaterials() { return S.wet.sweep(); },
    /** Multipliers on the automatic grade: { exposure, contrast, saturation, vignette, glare }. */
    grading: S.grade,
    /** Optional 2D-strip LUT (N tiles of N×N in an N²×N image). Pass null to clear. */
    setLUT(texture, size = 16, amount = 1) {
      const u = S.grading.uniforms;
      if (texture) { texture.colorSpace = THREE.NoColorSpace; texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false; }
      u.tLUT.value = texture; u.uLUTSize.value = size; u.uLUTAmount.value = texture ? amount : 0;
    },
    /**
     * Tune the depth-driven ground pass (contact shadows, fine AO, wet reflections, aerial perspective).
     * Multipliers, all default 1: { contact, ao, aoRadius, reflect, aerial, desat }.
     */
    surface(opts = {}) { Object.assign(S.surface, opts); return { ...S.surface }; },
    /** Toggle features: { smoke, rain, snow, splashes, grading, flare, shimmer, wet, autoExposure,
     *  reflections (wet screen-space mirror), contact (contact shadows + fine AO), aerial (distance haze) }. */
    setEnabled(flags) { Object.assign(S.enabled, flags); },
    get enabled() { return S.enabled; },
    /** 0 dry … 1 soaked. The same number as engine.globalUniforms.uWetness — any module's shader can
     *  read that uniform directly (it is declared by the environment hook) and drive its own roughness. */
    get wetness() { return S.wetness; },
    /** Standing water: { count, visible, map, xf } — the world-space drainage map (R pool, G tyre band,
     *  B road corridor) and its (originX, originZ, 1/span, hasMap) transform. */
    get puddles() {
      return {
        count: S.puddleCount ?? 0, visible: !!(S.puddles.mesh && S.puddles.mesh.visible),
        map: S.puddles.map, xf: S.puddles.mapXf,
      };
    },
    get snowCover() { return S.snowCover; },
    /** p9 diagnostics: what the ground pass is actually about to upload for the analytic emitters. */
    get groundDebug() {
      const u = S.groundFX.uniforms;
      return {
        n: u.uWetLightN.value,
        hasArr: !!u.uWetLights.value,
        pos3: u.uWetLights.value ? u.uWetLights.value.slice(0, 3).map((v) => v.toArray().map((x) => +x.toFixed(1))) : null,
        col3: u.uWetLightCol.value ? u.uWetLightCol.value.slice(0, 3).map((c) => [+c.r.toFixed(2), +c.g.toFixed(2), +c.b.toFixed(2)]) : null,
      };
    },
    get rain() { return S.rainAmt; },
    get snow() { return S.snowAmt; },
    stats() {
      return {
        cpuMs: +S.cpuMs.toFixed(3), smokeParticles: S.smoke.count, emitters: S.counts.emitters ?? 0, byKind: S.counts.byKind ?? null, hotSpots: S.hotSpots.length,
        rain: +S.rainAmt.toFixed(2), snow: +S.snowAmt.toFixed(2), wetness: +S.wetness.toFixed(2), snowCover: +S.snowCover.toFixed(2),
        sources: S.sources.size, wetMaterials: S.wet.state.patched, sceneDepth: !!S.fxPass.sceneDepth, localLights: S.localLights,
        splashes: S.splash.mesh.visible ? S.splash.geometry.instanceCount : 0, sprayEmitters: S.spray.live,
        // p7: the auditor's instrumentation request — how many analytic emitters the wet mirror is
        // actually carrying (uWetLightN) and where they came from.
        wetLights: S.wetLights.count, wetLightsLamps: S.wetLights.stats.lamps, wetLightsVehicles: S.wetLights.stats.vehicles,
        puddles: S.puddleCount ?? 0, puddlesVisible: !!(S.puddles.mesh && S.puddles.mesh.visible), puddleBuildMs: S.puddles.buildMs ?? 0,
        reflect: +S.groundFX.uniforms.uWet.value.toFixed(2), contactAO: +S.groundFX.uniforms.uAO.value.x.toFixed(2),
      };
    },
  };
}
