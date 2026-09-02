/**
 * environment module — physically based sky & lighting for Fable Cities.
 *
 *  - analytic single-scattering atmosphere (Rayleigh + Mie + ozone) driven by world.time (hour,
 *    day-of-year) and latitude; sun *and* moon are light sources of the sky integral
 *  - stars + Milky Way (baked cube map rotating with sidereal time), phase-correct moon disc
 *  - volumetric clouds (ray-marched shell, wind-driven, weather coverage)
 *  - weather: clear / cloudy / rain / fog / snow → sky, fog, sun, wetness (world.env.rain), snow
 *  - drives engine.setSun / setHemisphere / setFog / setEnvironment (PMREM from the live sky) /
 *    setExposure and fills world.env for every other module (see ARCHITECTURE.md §4)
 *  - core hooks: engine.addMaterialHook (height fog, cloud shadows, wetness on every lit material),
 *    engine.setFogHeight, engine.setSunModulation (drifting cloud-shadow map), globalUniforms.uWetness
 */
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, DEG2RAD, RAD2DEG } from '../../shared/math.js';
import { SkyDome } from './SkyDome.js';
import { CloudLayer } from './Clouds.js';
import { CloudShadowMap } from './CloudShadow.js';
import { Weather, WEATHER_PRESETS } from './Weather.js';
import { EnvProbe } from './EnvProbe.js';
import { createEnvironmentMaterialHook } from './MaterialHook.js';
import {
  ATMOS, skyRadiance, transmittanceToLight, celestial, dayOfYear, exposureForSun, nightFactorForSun, luminance,
} from './atmosphere.js';

export const name = 'environment';

const MOON_COLOR = new THREE.Color(0.62, 0.72, 1.0);
const MOON_LIGHT = 0.26;        // directional intensity of a full moon at zenith (renderer units)
const MOON_SKY_E = 0.065;        // moon irradiance used in the sky scattering integral
const GROUND_ALBEDO = new THREE.Color(0.30, 0.29, 0.24);
const SNOW_ALBEDO = new THREE.Color(0.78, 0.80, 0.86);
const TWILIGHT_SKY = new THREE.Color(0.36, 0.47, 0.85); // hemisphere tint while the twilight floor carries the ambient
/** Zenith blue the hemisphere sky term is pushed toward at golden hour: the skylight that fills shadows at sunset is
 *  the *blue* upper sky, not the amber belt — without this the whole frame collapses to khaki (r2 critic). */
const GOLDEN_SKY = new THREE.Color(0.40, 0.50, 0.78);
/** Ground-bounce tint at golden hour / night: cool and desaturated so shadowed ground keeps b > r. */
const COOL_BOUNCE = new THREE.Color(0.62, 0.70, 0.92);
const NIGHT_FLOOR = new THREE.Color(0.0159, 0.0226, 0.0398); // starlight / airglow / city glow hemisphere floor (moonless), in sky-radiance units (x AMBIENT_K)
const MIN_SHADOW_ELEV = 2.5 * DEG2RAD;
const CLOUD_SHADOW_ALT = 1700;  // representative cloud altitude for the shadow offset (m)
/** Display-referred ambient key (hemisphere intensity × exposure) at astronomical night: the twilight floor never lets
 *  the ground fall below this before the sun reaches -10 deg, so dusk is monotonic (r0 critic: 19:19 darker than midnight). */
const NIGHT_KEY = 0.104 * 3.15;
/** Daylight sky-fill gain: hemisphere intensity = hemiMax x AMBIENT_K. This single number sets the sun:sky key
 *  ratio of every sunny frame. LOOK_TARGET row 3 wants a ground shadow ratio near 19:1 (CS2); at 0.80 we measured
 *  13:1 with a *hard floor* (see floorKey below) that pinned daytime ambient at ~1.2 and made every frame overcast. */
const AMBIENT_K = 3.3;
/** Warm tint of the direct key at mid altitudes (~5000 K). CS2 lit surfaces sit at hue 34-47 deg while the sky fill
 *  is 214 deg; that warm/cool split is what makes a surface read three-dimensional (LOOK_TARGET row 13). */
const KEY_WARM = new THREE.Color(1.0, 0.935, 0.80);

let S = null; // module state

export async function init(ctx) {
  const { engine, scene, world, events, config, renderer } = ctx;
  const seed = world.seed;

  const sky = new SkyDome({ seed });
  const clouds = new CloudLayer({ seed, quality: engine.quality });
  const weather = new Weather(seed, config.weather);
  const probe = new EnvProbe(renderer, sky, clouds);
  const cloudShadow = new CloudShadowMap(clouds.weather, clouds.noise, clouds.uniforms.uWeatherScale.value);
  scene.add(sky.mesh);
  scene.add(clouds.compositeMesh);

  S = {
    ctx, engine, scene, world, events, sky, clouds, weather, probe, cloudShadow,
    latitude: 47.3,
    lastHour: NaN,
    elapsed: 0,
    sampleTimer: 0,
    probeDirtyUntil: -1,
    lastWeatherName: weather.name,
    cel: {},
    // smoothed CPU sky samples (radiance)
    skyAvg: new THREE.Color(0.3, 0.45, 0.8),
    horizonAvg: new THREE.Color(0.7, 0.8, 0.95),
    sunSideAvg: new THREE.Color(0, 0, 0),
    skyAvgTarget: new THREE.Color(0.3, 0.45, 0.8),
    horizonAvgTarget: new THREE.Color(0.7, 0.8, 0.95),
    sunSideAvgTarget: new THREE.Color(0, 0, 0),
    sunT: new THREE.Color(1, 1, 1),
    sunTHigh: new THREE.Color(1, 1, 1),
    moonT: new THREE.Color(1, 1, 1),
    tmpC: new THREE.Color(),
    tmpC2: new THREE.Color(),
    tmpC3: new THREE.Color(),
    sunColor: new THREE.Color(),
    moonColor: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiCol: new THREE.Color(),      // hemisphere sky colour actually handed to the engine (published as env.skyColor)
    hemiGround: new THREE.Color(),
    milk: new THREE.Color(),
    sunTint: new THREE.Color(1, 1, 1),
    fogWarm: new THREE.Color(1, 1, 1),
    fogCool: new THREE.Color(1, 1, 1),
    groundRad: new THREE.Color(),
    fogColor: new THREE.Color(),
    diffuseCol: new THREE.Color(),
    grey: new THREE.Color(),
    tmpV: new THREE.Vector3(),
    tmpV2: new THREE.Vector3(),
    lightDir: new THREE.Vector3(0, -1, 0),
    forward: new THREE.Vector3(0, 0, -1),
    sunModXf: new THREE.Vector4(1 / 22000, 1 / 22000, 0, 0),
    cloudsEnabled: true,
    cloudShadowsEnabled: true,
    scatterBoost: ATMOS.scatterBoost,
    envIntensity: 0.75,
    cloudOffsetExtra: new THREE.Vector3(),
    sampleOut: { radiance: new THREE.Color(), transmittance: new THREE.Color() },
    // module-owned uniform shared by the material hook: x = uniform-haze floor, y = sun glow through fog
    hookUniforms: {
      uFcFogParams: { value: new THREE.Vector3(0.7, 0, 0.78) },
      uFcSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFcFogWarm: { value: new THREE.Color(1, 1, 1) },
      uFcFogCool: { value: new THREE.Color(1, 1, 1) },
    },
    removeHook: null,
  };

  // --- global material hook: height fog + cloud shadows + wetness on every lit material ---
  S.hook = createEnvironmentMaterialHook(engine, S.hookUniforms);
  S.removeHook = engine.addMaterialHook(S.hook);
  engine.setSunModulation(cloudShadow.texture, S.sunModXf);
  engine.setFogHeight((world.terrain && world.terrain.waterLevel) || 0, 150);

  // --- world.env extensions (contract fields already exist on World) ---
  const env = world.env;
  env.weather = weather.name;
  env.moonDirection = new THREE.Vector3(0, 1, 0);
  env.lightDirection = new THREE.Vector3(0, -1, 0);
  env.horizonColor = new THREE.Color();
  env.moonColor = MOON_COLOR.clone();
  env.sunAltitude = 0;
  env.sunAzimuth = 0;
  env.moonAltitude = 0;
  env.moonPhase = 0;
  env.moonIllumination = 0;
  env.exposure = 1;
  env.precipitation = 0;
  env.wetness = 0;
  env.latitude = S.latitude;
  env.dayOfYear = dayOfYear(world.time);
  env.cloudsVisible = true;
  env.fogHeight = { y0: 0, H: 150 };
  env.api = {
    /** Change weather: 'clear' | 'cloudy' | 'rain' | 'fog' | 'snow'. */
    setWeather: (w, { instant = false } = {}) => setWeather(w, instant),
    getWeather: () => weather.name,
    weatherTypes: Object.keys(WEATHER_PRESETS),
    setLatitude: (deg) => { S.latitude = clamp(deg, -80, 80); env.latitude = S.latitude; forceUpdate(); },
    setWind: (x, z, strength) => { weather.wind.set(x, z).normalize(); if (strength != null) weather.windStrength = strength; },
    /** Direction toward the sun for an arbitrary hour (today). */
    sunDirection: (hour = world.time.hour, out = new THREE.Vector3()) => out.copy(celestial(hour, dayOfYear(world.time), S.latitude, {}).sunDir),
    /** Direction toward the moon for an arbitrary hour (today). */
    moonDirection: (hour = world.time.hour, out = new THREE.Vector3()) => out.copy(celestial(hour, dayOfYear(world.time), S.latitude, {}).moonDir),
    /** Sky radiance (linear, renderer units) toward a world direction — CPU model. */
    sampleSky: (dir, out = new THREE.Color()) => sampleSkyDir(dir, out),
    /** Force the reflection probe & all smoothed values to update now. */
    refresh: () => forceUpdate(),
    setCloudsVisible: (v) => { S.cloudsEnabled = !!v; clouds.setVisible(!!v); env.cloudsVisible = !!v; },
    /** Frames the probe rendered so far (debug). */
    probeCount: () => probe.count,
    weatherState: () => ({ ...weather.state, wetness: weather.wetness, snowCover: weather.snowCover }),
    /** The R8 cloud-shadow texture handed to engine.setSunModulation (debug / other modules). */
    cloudShadowTexture: () => cloudShadow.texture,
    /** Fraction of the ground currently under cloud shadow (debug). */
    cloudShadowFraction: () => cloudShadow.shadowFraction,
    /** Sun modulation (1 = full sun, <1 under cloud) at a world position — exactly what the material hook samples. */
    cloudShadowAt: (x, z) => cloudShadowAt(x, z),
    setCloudShadows: (v) => { S.cloudShadowsEnabled = !!v; },
    setCloudHistory: (w) => { clouds.historyWeight = clamp(w, 0, 0.99); },
    /** Material-hook patch statistics (debug): shaders seen / patched / fog / sun-modulation anchors. */
    hookStats: () => ({ ...S.hook.stats }),
    /** Debug / tests: set the cloud field drift offset (metres) — moves clouds and their ground shadows together. */
    setCloudOffset: (x, z) => { S.cloudOffsetExtra.set(x, 0, z); clouds.resetHistory(); },
    /** Ground shadows follow the cloud-field offset at this fraction: cloudShadowAt(x + k·dx) predicts the
     *  shadow at x after setCloudOffset(dx, dz). Lets a caller drift the deck until a subject is in full sun. */
    cloudOffsetGain: () => 0.35,
    /** Debug: the world-XZ → cloud-shadow-UV transform handed to engine.setSunModulation. */
    sunModXf: () => S.sunModXf.toArray(),
    /** Debug: 1 fixed jitter, 2 no detail erosion, 3 flat base / full column tops. */
    setCloudDebug: (n) => { clouds.uniforms.uDebug.value = n | 0; },
    /** Volumetric-cloud renderer state (debug). */
    cloudState: () => ({
      historyValid: clouds.historyValid, historyWeight: clouds.uniforms.uHistoryWeight.value, frame: clouds.uniforms.uFrame.value,
      rt: clouds.targetSize.toArray(), prevViewProj: clouds.uniforms.uPrevViewProj.value.toArray(), visible: clouds.compositeMesh.visible,
    }),
    /** Lighting key values for tests (display-referred ambient key = hemisphere intensity × exposure). */
    lightingState: () => ({
      sunAltitude: env.sunAltitude, exposure: env.exposure, sunIntensity: env.sunIntensity, ambientIntensity: env.ambientIntensity,
      ambientKey: env.ambientIntensity * env.exposure, nightFactor: env.nightFactor, hemiRaw: S.dbgHemiRaw, floor: S.dbgFloor, envIntensity: S.envIntensity, fogDensity: env.fogDensity,
      hemiSky: S.engine.hemi ? S.engine.hemi.color.toArray() : null, hemiGround: S.engine.hemi ? S.engine.hemi.groundColor.toArray() : null,
      sunColor: env.sunColor.toArray(), skyAvg: S.skyAvg.toArray(), horizonAvg: S.horizonAvg.toArray(), sunSide: S.sunSideAvg.toArray(),
    }),
  };

  events.on('time:set', () => forceUpdate());
  events.on('weather:set', (w) => setWeather(w, false));

  // first frame: everything snapped, probe rendered
  forceUpdate();
}

function setWeather(w, instant) {
  if (!S) return false;
  const ok = S.weather.set(w, instant);
  if (ok) {
    S.world.env.weather = w;
    // the probe must follow the sky through the transition (fog: white dome vs blue reflections otherwise)
    S.probeDirtyUntil = S.elapsed + 14;
    if (instant) forceUpdate();
  }
  return ok;
}

/** Snap smoothing and re-render the probe (time jumps, weather snaps, init). */
function forceUpdate() {
  if (!S) return;
  S.lastHour = NaN;
  computeFrame(0, S.elapsed, true);
}

export function update(dt, elapsed) {
  if (!S) return;
  S.elapsed = elapsed;
  computeFrame(dt, elapsed, false);
}

// ---------------------------------------------------------------------------------------------

function computeFrame(dt, elapsed, force) {
  const { world, engine, sky, clouds, weather, probe, cloudShadow, tmpC, tmpC2, tmpC3 } = S;
  const env = world.env;
  const time = world.time;
  const hour = time.hour;
  const jumped = force || !Number.isFinite(S.lastHour) || Math.abs(hour - S.lastHour) > 0.02;
  S.lastHour = hour;

  // game-clock seconds: cloud drift and the wind wander are functions of the game time, so a screenshot at a given
  // seed + time always shows the same clouds and cloud shadows (real-time dt would make them depend on load time)
  const gameSeconds = ((time.totalDays ?? (time.day || 1)) * 24 + hour) * 3600;
  weather.update(dt, gameSeconds);
  if (jumped && force) weather.snap();

  // --- ephemeris ---
  const doy = dayOfYear(time);
  const cel = celestial(hour, doy, S.latitude, S.cel);
  const sunAltDeg = cel.sunAltitude * RAD2DEG;
  const moonAltDeg = cel.moonAltitude * RAD2DEG;
  const camera = engine.camera;
  const camAlt = Math.max(1, camera.position.y);
  const turbidity = weather.state.turbidity;
  const lowSun = 1 - smoothstep(4, 20, sunAltDeg);      // golden hour weight
  // less multiple-scattering compensation at low sun: the sunset glow stays a saturated gradient, not a cream wall
  S.scatterBoost = lerp(1.95, ATMOS.scatterBoost, smoothstep(2, 22, sunAltDeg));
  const nightAmount = clamp01(1 - smoothstep(-13, -1, sunAltDeg));

  // --- sun & moon transmittance / intensities ---
  transmittanceToLight(cel.sunDir, camAlt, turbidity, S.sunT);
  transmittanceToLight(cel.sunDir, 2600, turbidity, S.sunTHigh);
  transmittanceToLight(cel.moonDir, camAlt, turbidity, S.moonT);
  const sunUp = smoothstep(-1.8, 1.2, sunAltDeg); // refraction keeps the disc visible to about -0.8 deg
  const sunMax = Math.max(S.sunT.r, S.sunT.g, S.sunT.b, 1e-4);
  // low sun: pure Beer-Lambert extinction under-lights the scene (no multiple scattering, no adaptation) — flatten the
  // falloff so the golden-hour key stays strong and warm on facades and towers
  const sunIntensity = ATMOS.sunE * Math.pow(sunMax, lerp(1, 0.6, lowSun)) * sunUp * weather.sunFactor;
  // colour from the transmittance, desaturated a little toward luminance by day (aerosols extinguish grey); at low
  // sun keep it golden (≈2800-3400 K), never brick-red
  const sunColor = S.sunColor.copy(S.sunT).multiplyScalar(1 / sunMax);
  {
    const l = luminance(sunColor);
    sunColor.lerp(S.grey.setRGB(l, l, l), lerp(0.28, 0.2, lowSun));
    sunColor.multiplyScalar(1 / Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4));
    // below the horizon the Beer-Lambert transmittance collapses to (0,0,0) and the normalisation leaves r = 0 —
    // other modules read env.sunColor, so keep a physical 2200 K low-sun colour all the way through the ramp
    sunColor.r = Math.max(sunColor.r, 1.0);
    sunColor.g = Math.max(sunColor.g, 0.5);
    sunColor.b = Math.max(sunColor.b, 0.2);
  }
  // a real sun is warm at every altitude a beauty shot uses: ~5000 K at 40 deg falling to ~2400 K on the horizon.
  // Without this the key is white, the fill is blue, and the frame has no warm/cool split at all (LOOK_TARGET 13).
  sunColor.lerp(S.tmpC3.copy(KEY_WARM), 0.55 * (1 - smoothstep(8, 46, sunAltDeg)));
  // golden hour: clamp the key toward ~2200 K so facades and towers go amber, never pale straw
  if (lowSun > 0) sunColor.lerp(S.tmpC3.setRGB(1.0, 0.55, 0.25), 0.55 * lowSun * sunUp);
  const moonUp = smoothstep(-1, 6, moonAltDeg);
  const moonMax = Math.max(S.moonT.r, S.moonT.g, S.moonT.b, 1e-4);
  const moonIntensity = MOON_LIGHT * cel.moonIllumination * moonMax * moonUp * lerp(1, weather.sunFactor, 0.85);
  // moonlight stays cool (Purkinje): only 40 % of the atmospheric reddening of a low moon is applied
  const moonColor = S.moonColor.copy(S.moonT).multiplyScalar(1 / moonMax).lerp(S.grey.setRGB(1, 1, 1), 0.6).multiply(MOON_COLOR);
  const moonSkyE = MOON_SKY_E * cel.moonIllumination * moonUp;

  const baseNight = nightFactorForSun(sunAltDeg);
  const overcastNight = (1 - smoothstep(-2, 10, sunAltDeg)) * clamp01((weather.cloudCover - 0.55) * 2.2) * 0.7;
  const nightFactor = clamp01(Math.max(baseNight, overcastNight));
  const cover = weather.cloudCover;
  const wst = weather.state;

  // --- exposure (eye adaptation): daylight level is held under overcast / fog (the medium is luminous, not dim) ---
  let exposure = exposureForSun(sunAltDeg);
  exposure *= 1 + 0.10 * smoothstep(0.45, 0.95, cover) * (1 - nightFactor) + 0.06 * wst.precipitation;
  // -0.18 EV around midday: the brightest diffuse surfaces then land just under the white point instead of
  // sitting on the flat shoulder of the tone curve (r2 critic: 'noon frame is slightly washed and flat')
  exposure *= lerp(1.0, 0.93, smoothstep(16, 42, sunAltDeg));
  // moonlit nights: the eye adapts to the moon — a bright high moon must not make midnight brighter than dusk
  const moonIrr = moonIntensity * Math.max(0, cel.moonDir.y);
  exposure *= 1 - 0.5 * clamp01(moonIrr / 0.12) * nightAmount;
  engine.setExposure(exposure);

  // --- CPU sky samples (ambient / horizon / sun-side horizon), a few times per second or on jumps ---
  S.sampleTimer -= dt;
  if (jumped || S.sampleTimer <= 0) {
    S.sampleTimer = 0.15;
    sampleSkyAverages(cel, camAlt, turbidity, moonSkyE, nightAmount);
  }
  const k = jumped ? 1e9 : 5;
  dampColor(S.skyAvg, S.skyAvgTarget, k, dt);
  dampColor(S.horizonAvg, S.horizonAvgTarget, k, dt);
  dampColor(S.sunSideAvg, S.sunSideAvgTarget, k, dt);

  // --- choose the shadow-casting light (sun by day, moon by night) ---
  let lightColor, lightIntensity, lightToward;
  if (sunIntensity >= moonIntensity) {
    lightColor = sunColor; lightIntensity = sunIntensity; lightToward = cel.sunDir;
  } else {
    lightColor = moonColor; lightIntensity = moonIntensity; lightToward = cel.moonDir;
  }
  const lightDir = S.lightDir.copy(lightToward).negate();
  // keep the shadow light at least a few degrees above the horizon (stable cascades)
  if (lightDir.y > -Math.sin(MIN_SHADOW_ELEV)) {
    const h = Math.hypot(lightDir.x, lightDir.z) || 1;
    const c = Math.cos(MIN_SHADOW_ELEV);
    lightDir.set((lightDir.x / h) * c, -Math.sin(MIN_SHADOW_ELEV), (lightDir.z / h) * c);
  }
  lightDir.normalize();
  engine.setSun(lightDir, lightColor, Math.max(0.02, lightIntensity));

  // --- overcast / fog: the deck and the fog medium are a bright diffuser lit by the blocked sunlight ---
  const skyAvg = S.skyAvg, horizonAvg = S.horizonAvg;
  const skyLum = luminance(skyAvg);
  // clear-sky direct irradiance on the horizontal (before the deck) → the fraction the deck blocks comes back as
  // diffuse skylight: radiance of a Lambertian diffuser = E / π, whitened by multiple scattering
  const sunIrrClear = ATMOS.sunE * sunMax * sunUp * Math.max(0, cel.sunDir.y);
  const diffuseE = sunIrrClear * (1 - weather.sunFactor) * wst.diffuse / Math.PI;
  const diffuseCol = S.diffuseCol.copy(sunColor).multiplyScalar(diffuseE);
  { const l = luminance(diffuseCol); diffuseCol.lerp(S.grey.setRGB(l, l, l), 0.6); }
  const overLum = skyLum * 1.15;
  const hemiSky = S.hemiSky.setRGB(
    lerp(skyAvg.r, overLum, cover * 0.85) + diffuseCol.r,
    lerp(skyAvg.g, overLum, cover * 0.85) + diffuseCol.g,
    lerp(skyAvg.b, overLum, cover * 0.85) + diffuseCol.b);
  // moonlit sky: a soft cool ambient so night landscapes read as moonlit, never black
  hemiSky.r += moonColor.r * moonIntensity * 0.033;
  hemiSky.g += moonColor.g * moonIntensity * 0.033;
  hemiSky.b += moonColor.b * moonIntensity * 0.033;
  const snow = weather.snowCover;
  const groundAlbedo = tmpC.lerpColors(GROUND_ALBEDO, SNOW_ALBEDO, snow);
  // ground radiance ≈ albedo × (direct + sky) / π
  const sunIrr = sunIntensity * Math.max(0, cel.sunDir.y) + moonIntensity * Math.max(0, cel.moonDir.y) * 0.5;
  const groundRad = S.groundRad.setRGB(
    groundAlbedo.r * (sunColor.r * sunIrr / Math.PI + hemiSky.r * 0.9),
    groundAlbedo.g * (sunColor.g * sunIrr / Math.PI + hemiSky.g * 0.9),
    groundAlbedo.b * (sunColor.b * sunIrr / Math.PI + hemiSky.b * 0.9));
  // night floor: starlight / airglow / distant city glow keep shadows dark blue instead of black
  hemiSky.r = Math.max(hemiSky.r, NIGHT_FLOOR.r * nightAmount);
  hemiSky.g = Math.max(hemiSky.g, NIGHT_FLOOR.g * nightAmount);
  hemiSky.b = Math.max(hemiSky.b, NIGHT_FLOOR.b * nightAmount);
  const hemiMax = Math.max(hemiSky.r, hemiSky.g, hemiSky.b, 1e-5);
  // single scattering under-estimates skylight at low sun: a lift keeps shadows readable through golden hour
  const lowSunLift = 1 + 0.45 * lowSun * sunUp;
  const hemiRaw = hemiMax * AMBIENT_K * lowSunLift;
  let hemiIntensity = clamp(hemiRaw, 0.010, 0.95);
  // twilight floor: the display-referred ambient key must fall monotonically from sunset to astronomical night —
  // the single-scatter sky collapses faster than the exposure curve rises, so a sky-tinted floor carries the dusk.
  // It MUST vanish in daylight: the previous ramp saturated at +4 deg and therefore *set* the daytime ambient
  // (measured 1.20 at every hour from 08:00 to 17:00, sun:sky pinned at 3:1) — that was the flat-lighting verdict.
  // The bump peaks at sunset (the sun no longer lights a horizontal surface but the sky still glows) and is gone
  // by +4.5 deg, so golden hour is carried by the warm key at ~10:1, not by a sky fill at 2:1.
  const floorKey = NIGHT_KEY * (1 + 1.05 * smoothstep(-13, -1, sunAltDeg) * (1 - smoothstep(0.5, 4.5, sunAltDeg)));
  const floorIntensity = floorKey * lerp(1.0, 0.88, nightAmount) / exposure;
  let floorMix = 0;
  if (hemiIntensity < floorIntensity) {
    floorMix = 1 - hemiIntensity / floorIntensity;
    hemiIntensity = floorIntensity;
  }
  const hemiCol = S.hemiCol.copy(hemiSky).multiplyScalar(1 / hemiMax);
  hemiCol.lerp(TWILIGHT_SKY, floorMix * (1 - nightAmount * 0.5));
  // golden hour: the skylight that fills shadows is the BLUE zenith, not the amber belt — pushing the hemisphere
  // sky term there is what gives an evening frame its warm key / cool shade contrast instead of a khaki wash
  const goldenCool = lowSun * sunUp * (1 - 0.6 * cover);
  hemiCol.lerp(GOLDEN_SKY, 0.45 * goldenCool);
  // ground bounce: desaturated, and cooled at golden hour / night so shadowed ground keeps b > r
  const hemiGround = S.hemiGround.copy(groundRad).multiplyScalar(1 / Math.max(groundRad.r, groundRad.g, groundRad.b, 1e-5));
  {
    const l = luminance(hemiGround);
    hemiGround.lerp(S.grey.setRGB(l, l, l), lerp(0.5, 0.82, Math.max(goldenCool, nightAmount)));
    hemiGround.lerp(COOL_BOUNCE, 0.42 * Math.max(goldenCool, nightAmount));
    // a bright neutral bounce term lights every wall's lower half and is what washed the greens out (r3 critic):
    // real ground bounce off grass/asphalt is ~0.15 albedo, so keep it well under the sky term
    hemiGround.multiplyScalar(lerp(0.34, 0.30, Math.max(goldenCool, nightAmount)));
  }
  S.dbgHemiRaw = hemiRaw; S.dbgFloor = floorIntensity;
  engine.setHemisphere(hemiCol, hemiGround, hemiIntensity);

  // --- fog: clear-air haze is tinted from the sky; the fog/overcast medium is the luminous diffuser itself ---
  // clear air: aerial perspective, cooled toward the sky average (more so at low sun: distant, not near, geometry warms)
  const lowSunFog = 1 - smoothstep(3, 20, sunAltDeg);
  const fogColor = S.fogColor.lerpColors(horizonAvg, skyAvg, lerp(0.45, 0.6, lowSunFog));
  const fogLum = luminance(fogColor);
  fogColor.lerp(S.grey.setRGB(fogLum, fogLum, fogLum), cover * 0.45);
  // milky medium: hemisphere-integrated sky radiance + diffused sunlight (high-key by day, dark at night)
  const milk = S.milk.setRGB(skyAvg.r * 1.05 + diffuseCol.r, skyAvg.g * 1.05 + diffuseCol.g, skyAvg.b * 1.05 + diffuseCol.b);
  { const l = luminance(milk); milk.lerp(S.grey.setRGB(l, l, l), 0.35); }
  milk.r = Math.max(milk.r, fogColor.r); milk.g = Math.max(milk.g, fogColor.g); milk.b = Math.max(milk.b, fogColor.b);
  fogColor.lerp(milk, wst.milk);
  // twilight: the haze band keeps a little of the dusk blue so the horizon does not go grey-black before the sky
  fogColor.r = Math.max(fogColor.r, 0.010 * floorMix / exposure);
  fogColor.g = Math.max(fogColor.g, 0.015 * floorMix / exposure);
  fogColor.b = Math.max(fogColor.b, 0.034 * floorMix / exposure);
  const fogDensity = wst.fog * (1 + 0.25 * nightFactor);
  engine.setFog(fogColor, fogDensity);
  // height fog: mist hugs the water level, settles lower at night; the floor keeps distant peaks hazy
  const waterY = (world.terrain && Number.isFinite(world.terrain.waterLevel)) ? world.terrain.waterLevel : 0;
  const fogH = wst.fogH * (1 - 0.2 * nightFactor);
  engine.setFogHeight(waterY - 4, fogH);
  // sun glow through the fog medium (forward scattering): depth cue in the sun direction
  const fogSunGlow = wst.milk * sunUp * 1.6 * smoothstep(0.02, 0.4, weather.sunFactor + 0.2);
  // fog opacity ceiling: clear air keeps distant silhouettes readable; a real fog bank may close completely
  const fogMax = lerp(0.80, 1.0, clamp01(wst.milk * 1.1));
  S.hookUniforms.uFcFogParams.value.set(wst.fogFloor, fogSunGlow, fogMax);
  S.hookUniforms.uFcSunDir.value.copy(cel.sunDir);
  // directional aerial perspective: warm haze only in the sun-facing hemisphere, cool blue away from it. Amplitude
  // peaks through golden hour and vanishes at midday / under a thick medium (fog is isotropic by definition).
  {
    const amp = lowSun * sunUp * (1 - 0.55 * wst.milk);
    S.fogWarm.setRGB(lerp(1, 1.22, amp), lerp(1, 1.02, amp), lerp(1, 0.80, amp));
    S.fogCool.setRGB(lerp(1, 0.84, amp), lerp(1, 0.93, amp), lerp(1, 1.16, amp));
    S.hookUniforms.uFcFogWarm.value.copy(S.fogWarm);
    S.hookUniforms.uFcFogCool.value.copy(S.fogCool);
  }
  env.fogHeight.y0 = waterY - 4;
  env.fogHeight.H = fogH;

  // --- wetness (rain) for every lit material + effects ---
  const wetness = weather.wetness * (1 - weather.snowCover);
  engine.globalUniforms.uWetness.value = wetness;

  // --- sky dome uniforms ---
  const su = sky.uniforms;
  su.uCamPos.value.copy(camera.position);
  su.uSunDir.value.copy(cel.sunDir);
  su.uMoonDir.value.copy(cel.moonDir);
  su.uMoonE.value = moonSkyE;
  su.uTurbidity.value = turbidity;
  su.uHorizonColor.value.copy(fogColor);
  su.uGroundRadiance.value.copy(groundRad);
  su.uNightAmount.value = nightAmount;
  su.uCloudCover.value = cover;
  su.uTime.value = elapsed;
  su.uMoonBright.value = 2.0 * lerp(1, 0.4, clamp01(cover * 1.1));
  // a moonless sky carries the full field; a full moon washes the faint half out, as the eye sees it
  su.uStarIntensity.value = lerp(0.55, 1.45, nightAmount) * lerp(1, 0.55, clamp01(moonIntensity / 0.14));
  su.uSkyFog.value = wst.skyFog;
  su.uFogSun.value.set(cel.sunDir.x, cel.sunDir.y, cel.sunDir.z, fogSunGlow * 0.8);
  // low sun: the glow knee scales with 1/exposure so the in-scatter around the sun lands just under 1.0 display-linear —
  // AgX then keeps it saturated orange instead of flattening it to white; the disc (added after the knee) stays brighter
  const highSun = smoothstep(2, 14, sunAltDeg);
  su.uGlowKnee.value = lerp(clamp(0.4 / exposure, 0.2, 1.2), 1.15, highSun) * lerp(0.75, 1, smoothstep(-1.5, 1, sunAltDeg));
  // AgX desaturates bright blues hard: without the lift a noon zenith lands a pale grey-blue, not a deep one
  su.uSkySat.value = lerp(1.95, 1.60, smoothstep(0, 14, sunAltDeg));
  su.uScatterBoost.value = S.scatterBoost;
  su.uTwilight.value = smoothstep(-14, -7, sunAltDeg) * (1 - smoothstep(-1, 3, sunAltDeg)) * (1 - 0.7 * wst.skyFog);
  // low sun: a dimmer, explicitly 2200 K disc — a full-radiance disc clips to a white blob through bloom (r2 critic)
  su.uSunDisc.value = ATMOS.sunDiscRadiance * lerp(0.34, 1.0, smoothstep(1, 16, sunAltDeg));
  S.sunTint.setRGB(1, 1, 1).lerp(S.tmpC3.setRGB(1.0, 0.52, 0.20), 0.85 * lowSun * sunUp);
  su.uSunTint.value.copy(S.sunTint);
  // the Milky Way must survive moonlight and cloud, and must not be washed out by the twilight sky
  su.uMilkyWay.value = 3.6 * lerp(1, 0.30, clamp01(moonIntensity / 0.12)) * (1 - 0.75 * cover) * nightAmount;
  sky.setStarRotation(S.latitude * DEG2RAD, cel.siderealAngle);
  sky.mesh.position.copy(camera.position);

  // --- clouds ---
  const cu = clouds.uniforms;
  cu.uCamPos.value.copy(camera.position);
  cu.uLightDir.value.copy(lightToward);
  if (lightToward === cel.sunDir) {
    const lc = cu.uLightColor.value.copy(S.sunTHigh);
    const ll = luminance(lc);
    lc.lerp(S.grey.setRGB(ll, ll, ll), 0.18);
    // cloud altitude sees the sun a little longer than the ground; lift the low-sun falloff like the ground key
    const lcMax = Math.max(lc.r, lc.g, lc.b, 1e-4);
    // the eye adapts to the low sun (exposure rises): keep the lit deck from blowing the frame's white point
    lc.multiplyScalar(Math.pow(lcMax, lerp(1, 0.7, lowSun)) / lcMax * ATMOS.sunE * lerp(1, 0.5, lowSun) * smoothstep(-3.5, 0.2, sunAltDeg));
  } else {
    cu.uLightColor.value.copy(moonColor).multiplyScalar(MOON_LIGHT * cel.moonIllumination * moonUp * 0.85);
  }
  // moonlit / starlit clouds: multiple scattering makes a night deck glow soft dark blue, tops lighter than bases
  const moonAmb = tmpC2.copy(moonColor).multiplyScalar(moonIntensity * 0.16);
  const nightGlow = su.uNightGlow.value;
  cu.uAmbientTop.value.copy(skyAvg).multiplyScalar(0.7).add(tmpC.copy(nightGlow).multiplyScalar(nightAmount * 3.0)).add(moonAmb);
  // cloud undersides: mostly sky-lit (cool) with a little warm ground bounce, so lit and shadowed cloud faces contrast
  // undersides are sky-lit (cool) with only a trace of ground bounce — a strong warm bounce is what turned the
  // r2 evening deck into one dead-flat brown plane
  cu.uAmbientBottom.value.lerpColors(skyAvg, horizonAvg, lerp(0.35, 0.12, lowSun)).multiplyScalar(0.66)
    .add(tmpC.copy(groundRad).multiplyScalar(lerp(0.10, 0.03, lowSun)))
    .add(tmpC.copy(nightGlow).multiplyScalar(nightAmount * 1.3)).add(tmpC.copy(moonAmb).multiplyScalar(0.45));
  // golden hour: the warm sun-side horizon sky lights the bases and sun-facing flanks (orange undersides)
  cu.uAmbientSunSide.value.copy(S.sunSideAvg).multiplyScalar(1.25 * lowSun * sunUp * (1 - 0.6 * cover));
  // in-scatter gain: full by day (sunlit cumulus are the brightest surface in frame), damped at night so a
  // moonlit deck stays a dark silhouette instead of glowing
  cu.uScatterGain.value = lerp(2.9, 1.5, nightAmount);
  // aerial perspective on the clouds: thinner air at cloud altitude and a bluer haze than the ground fog, so a
  // low-sun deck keeps its own lit/shadow colours instead of dissolving into a flat beige band
  cu.uHazeColor.value.lerpColors(fogColor, skyAvg, 0.35);
  cu.uHazeDensity.value = fogDensity * 0.3;
  cu.uCoverage.value = cover;
  cu.uCloudType.value = wst.type;
  cu.uDensity.value = wst.density;
  cu.uPrecip.value = wst.precipitation;
  cu.uCirrusCover.value = wst.cirrus;
  cu.uWindDir.value.set(weather.wind.x, weather.wind.y);
  cu.uTime.value = elapsed;
  // cloud drift: 0.075 m per game-second (≈ 14 m/s of real-time drift at speed 1) along the wind, deterministic in
  // game time; wrapped on the 22 km weather tile so the floats stay precise
  {
    const drift = 0.075 * weather.driftWind * gameSeconds;
    const tile = cu.uWeatherScale.value * 4;
    const wrap = (v) => v - Math.floor(v / tile) * tile;
    cu.uWindOffset.value.x = wrap(weather.wind.x * drift) + S.cloudOffsetExtra.x;
    cu.uWindOffset.value.z = wrap(weather.wind.y * drift) + S.cloudOffsetExtra.z;
  }
  clouds.compositeMesh.position.copy(camera.position);
  const cloudsOn = S.cloudsEnabled && (cover > 0.005 || wst.cirrus > 0.005);
  clouds.compositeMesh.visible = cloudsOn;
  clouds.probeMesh.visible = cloudsOn;
  if (jumped) clouds.resetHistory();
  if (cloudsOn && dt > 0) clouds.renderOffscreen(engine.renderer, camera);

  // --- cloud shadows: same weather field the clouds threshold, projected along the light, drifting with the wind ---
  // shadow darkness: fair-weather cumulus keep a little light in the shade (thin edges), decks block more; at low sun
  // the map is a fixed-offset projection of a 2 km-high layer, so fade it toward the sky's own diffuse loss there
  const shadowStrength = (0.62 + 0.26 * smoothstep(0.3, 0.9, cover)) * lerp(0.35, 1, smoothstep(4, 15, sunAltDeg));
  cloudShadow.update(cloudsOn && S.cloudShadowsEnabled ? cover : 0, shadowStrength);
  {
    const L = lightToward;
    const ly = Math.max(L.y, 0.32); // clamp the projection at low sun (offset would exceed the tile)
    const scale = cu.uWeatherScale.value;
    const ofsX = (L.x / ly) * CLOUD_SHADOW_ALT + cu.uWindOffset.value.x * 0.35;
    const ofsZ = (L.z / ly) * CLOUD_SHADOW_ALT + cu.uWindOffset.value.z * 0.35;
    S.sunModXf.set(1 / scale, 1 / scale, ofsX / scale, ofsZ / scale);
    engine.setSunModulation(cloudShadow.texture, S.sunModXf);
  }

  // --- publish world.env ---
  env.sunDirection.copy(cel.sunDir).negate();
  env.moonDirection.copy(cel.moonDir);
  env.lightDirection.copy(lightDir);
  env.sunColor.copy(sunColor);
  env.sunIntensity = sunIntensity;
  env.moonIntensity = moonIntensity;
  env.moonColor.copy(moonColor);
  // NOTE: hemiCol is a dedicated colour (not a scratch temporary) — other modules read env.skyColor and the
  // contract says it must never be black
  env.skyColor.copy(hemiCol).multiplyScalar(Math.max(hemiIntensity, 0.02) / 0.8);
  env.skyColor.r = Math.max(env.skyColor.r, 0.004);
  env.skyColor.g = Math.max(env.skyColor.g, 0.006);
  env.skyColor.b = Math.max(env.skyColor.b, 0.012);
  env.groundColor.copy(groundRad);
  env.horizonColor.copy(fogColor);
  env.ambientIntensity = hemiIntensity;
  env.nightFactor = nightFactor;
  env.sunAltitude = sunAltDeg;
  env.sunAzimuth = cel.sunAzimuth * RAD2DEG;
  env.moonAltitude = moonAltDeg;
  env.moonPhase = cel.moonPhase;
  env.moonIllumination = cel.moonIllumination;
  env.cloudCover = cover;
  env.cirrusCover = wst.cirrus;
  env.rain = wetness;
  env.wetness = wetness;
  env.snow = weather.snowCover;
  env.precipitation = weather.state.precipitation;
  env.fogDensity = fogDensity;
  env.wind.copy(weather.wind);
  env.windStrength = weather.windStrength;
  env.temperature = weather.state.temp;
  env.exposure = exposure;
  env.dayOfYear = doy;
  env.weather = weather.name;

  // --- reflection probe ---
  if (weather.name !== S.lastWeatherName) { S.lastWeatherName = weather.name; S.probeDirtyUntil = elapsed + 14; }
  const twilight = Math.abs(sunAltDeg) < 12;
  const transitioning = elapsed < S.probeDirtyUntil;
  const interval = transitioning ? 0.5 : (twilight || time.speed > 1 ? 0.8 : 2.0);
  if (jumped || elapsed - probe.lastRefresh >= interval) {
    // IBL weight: lower through golden hour so the hemisphere's blue skylight rules the shadows (the probe's
    // orange horizon band would otherwise wash them beige); full at night (moon / airglow reflections)
    // IBL weight: the probe is the whole sky (warm horizon band included) and it fills shadows on top of the
    // hemisphere, so a high daytime weight is a second ambient light. Keep it low by day (shadows stay cool and
    // deep, LOOK_TARGET rows 3/13), full at night where the probe *is* the light.
    S.envIntensity = lerp(0.40, 0.52, smoothstep(1, 16, sunAltDeg)) * (1 - nightAmount) + 0.85 * nightAmount;
    engine.setEnvironment(probe.refresh(elapsed), S.envIntensity);
  }
}

function cloudShadowAt(x, z) {
  if (!S) return 1;
  const xf = S.sunModXf;
  const tex = S.cloudShadow;
  const N = tex.size;
  let u = x * xf.x + xf.z, v = z * xf.y + xf.w;
  u -= Math.floor(u); v -= Math.floor(v);
  const ix = Math.min(N - 1, Math.floor(u * N)), iy = Math.min(N - 1, Math.floor(v * N));
  return tex.data[iy * N + ix] / 255;
}

function clampLum(c, maxLum) {
  const l = luminance(c);
  if (l > maxLum) c.multiplyScalar(maxLum / l);
  return c;
}

function dampColor(c, target, k, dt) {
  if (k > 1e6) return c.copy(target);
  c.r = damp(c.r, target.r, k, dt);
  c.g = damp(c.g, target.g, k, dt);
  c.b = damp(c.b, target.b, k, dt);
  return c;
}

const _dir = new THREE.Vector3();
const _sunH = new THREE.Vector3();
const _params = { sunDir: null, moonDir: null, sunE: 0, moonE: 0, turbidity: 2, scatterBoost: ATMOS.scatterBoost };

/**
 * Sample the CPU sky model around the hemisphere → skyAvgTarget (ambient), horizonAvgTarget (fog) and
 * sunSideAvgTarget (the warm horizon glow around the sun's azimuth, for cloud bases at golden hour).
 * The ambient is weighted toward the zenith and the sun glow is clamped, so shadows stay cool blue
 * while the direct light goes golden.
 */
function sampleSkyAverages(cel, camAlt, turbidity, moonSkyE, nightAmount) {
  _params.sunDir = cel.sunDir;
  _params.moonDir = cel.moonDir;
  _params.sunE = ATMOS.sunE;
  _params.moonE = moonSkyE;
  _params.turbidity = turbidity;
  _params.scatterBoost = S.scatterBoost;
  const out = S.sampleOut;
  const sky = S.skyAvgTarget.setRGB(0, 0, 0);
  const hor = S.horizonAvgTarget.setRGB(0, 0, 0);
  const sunSide = S.sunSideAvgTarget.setRGB(0, 0, 0);
  const cam = S.engine.camera;
  cam.getWorldDirection(S.forward);
  const fwd = S.forward;
  let wSky = 0, wHor = 0;
  // at low sun the ambient is weighted toward the zenith and away from the sun so shadows stay cool blue
  const lowSun = 1 - smoothstep(3, 20, cel.sunAltitude * RAD2DEG);
  const rings = [[0.5 * Math.PI, 1, lerp(0.45, 0.6, lowSun)], [50 * DEG2RAD, 6, lerp(0.40, 0.32, lowSun)], [14 * DEG2RAD, 8, lerp(0.15, 0.08, lowSun)]];
  const sunH = _sunH.set(cel.sunDir.x, 0, cel.sunDir.z).normalize();
  for (const [elev, n, weight] of rings) {
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + 0.3;
      _dir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
      skyRadiance(_dir, camAlt, _params, 10, 4, out);
      const w = (weight / n) * (1 - 0.6 * lowSun * Math.max(0, _dir.dot(sunH)));
      clampLum(out.radiance, 0.4); // keep the sun glow from tinting the whole ambient
      sky.r += out.radiance.r * w; sky.g += out.radiance.g * w; sky.b += out.radiance.b * w;
      wSky += w;
    }
  }
  sky.multiplyScalar(1 / wSky);
  const nHor = 10;
  for (let i = 0; i < nHor; i++) {
    const az = (i / nHor) * Math.PI * 2 + 0.15;
    const elev = 1.6 * DEG2RAD;
    _dir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
    skyRadiance(_dir, camAlt, _params, 10, 4, out);
    clampLum(out.radiance, 0.7);
    // weight toward the view direction so the fog matches what the camera sees
    const w = 0.55 + 0.45 * Math.max(0, _dir.x * fwd.x + _dir.z * fwd.z);
    hor.r += out.radiance.r * w; hor.g += out.radiance.g * w; hor.b += out.radiance.b * w;
    wHor += w;
  }
  hor.multiplyScalar(1 / wHor);
  // sun-side horizon glow: three samples 5 deg up, at the sun's azimuth ± 30 deg (the belt that lights cloud bases)
  if (Math.hypot(cel.sunDir.x, cel.sunDir.z) > 1e-3) {
    const azS = Math.atan2(sunH.x, -sunH.z);
    const elev = 5 * DEG2RAD;
    for (const dAz of [-30 * DEG2RAD, 0, 30 * DEG2RAD]) {
      const az = azS + dAz;
      _dir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
      skyRadiance(_dir, camAlt, _params, 10, 4, out);
      clampLum(out.radiance, 1.4);
      sunSide.r += out.radiance.r / 3; sunSide.g += out.radiance.g / 3; sunSide.b += out.radiance.b / 3;
    }
  }
  // night floor consistent with the shader's airglow term
  const glow = S.sky.uniforms.uNightGlow.value;
  sky.r += glow.r * nightAmount * 1.4; sky.g += glow.g * nightAmount * 1.4; sky.b += glow.b * nightAmount * 1.4;
  hor.r += glow.r * nightAmount * 2.4; hor.g += glow.g * nightAmount * 2.4; hor.b += glow.b * nightAmount * 2.4;
}

function sampleSkyDir(dir, out) {
  if (!S) return out.setRGB(0.3, 0.45, 0.8);
  const cel = S.cel;
  _params.sunDir = cel.sunDir; _params.moonDir = cel.moonDir; _params.sunE = ATMOS.sunE;
  _params.moonE = S.sky.uniforms.uMoonE.value; _params.turbidity = S.weather.state.turbidity; _params.scatterBoost = S.scatterBoost;
  const r = skyRadiance(_dir.copy(dir).normalize(), Math.max(1, S.engine.camera.position.y), _params, 12, 5, S.sampleOut);
  return out.copy(r.radiance);
}

export function dispose() {
  if (!S) return;
  if (S.removeHook) S.removeHook();
  S.engine.setSunModulation(null);
  S.engine.setFogHeight(0, 1e9);
  S.engine.globalUniforms.uWetness.value = 0;
  S.scene.remove(S.sky.mesh);
  S.scene.remove(S.clouds.compositeMesh);
  S.sky.dispose();
  S.clouds.dispose();
  S.probe.dispose();
  S.cloudShadow.dispose();
  S = null;
}
