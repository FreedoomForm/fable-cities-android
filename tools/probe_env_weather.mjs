// Weather-environment golden probe — the FULL weather branch of environment/index.js
// computeFrame transcribed (extending scripts/probe_env.mjs) and driven by the REAL web
// Weather.js presets, with atmosphere.js providing the real sky primitives in Node.
// Emits android/app/src/test/java/com/fablecities/android/worldgen/EnvWeatherGoldens.kt.
// The Kotlin port (worldgen/Environment.kt + Weather.kt) must reproduce these bit-exactly.
import { writeFileSync } from 'node:fs';
import {
  ATMOS, skyRadiance, transmittanceToLight, celestial, dayOfYear,
  exposureForSun, nightFactorForSun, luminance,
} from '../src/modules/environment/atmosphere.js';
import { clamp, clamp01, lerp, smoothstep, DEG2RAD, RAD2DEG } from '../src/shared/math.js';
import { Vector3, Color as ShimColor } from '../node_modules/three/index.js';
import { Weather, WEATHER_PRESETS } from '../src/modules/environment/Weather.js';

const MOON_COLOR = { r: 0.62, g: 0.72, b: 1.0 };
const MOON_LIGHT = 0.26;
const MOON_SKY_E = 0.065;
const GROUND_ALBEDO = { r: 0.30, g: 0.29, b: 0.24 };
const SNOW_ALBEDO = { r: 0.78, g: 0.80, b: 0.86 };
const TWILIGHT_SKY = { r: 0.36, g: 0.47, b: 0.85 };
const GOLDEN_SKY = { r: 0.40, g: 0.50, b: 0.78 };
const COOL_BOUNCE = { r: 0.62, g: 0.70, b: 0.92 };
const NIGHT_FLOOR = { r: 0.0159, g: 0.0226, b: 0.0398 };
const NIGHT_KEY = 0.104 * 3.15;
const AMBIENT_K = 3.3;
const KEY_WARM = { r: 1.0, g: 0.935, b: 0.80 };
const NIGHT_GLOW = { r: 0.0011, g: 0.0031, b: 0.0125 };

const C = (r = 0, g = 0, b = 0) => ({ r, g, b });
const copy = (a) => C(a.r, a.g, a.b);
const mulS = (c, s) => { c.r *= s; c.g *= s; c.b *= s; return c; };
const lerpC = (c, o, t) => { c.r += (o.r - c.r) * t; c.g += (o.g - c.g) * t; c.b += (o.b - c.b) * t; return c; };
const greyC = (l) => C(l, l, l);
const clampLum = (c, maxLum) => { const l = luminance(c); if (l > maxLum) mulS(c, maxLum / l); return c; };

const out = { radiance: new ShimColor(), transmittance: new ShimColor() };
const params = { sunDir: null, moonDir: null, sunE: 0, moonE: 0, turbidity: 2.0, scatterBoost: ATMOS.scatterBoost };
let S_SCATTER = ATMOS.scatterBoost;

function sampleSkyAverages(cel, camAlt, moonSkyE, nightAmount, fwd, turb) {
  params.sunDir = cel.sunDir; params.moonDir = cel.moonDir;
  params.sunE = ATMOS.sunE; params.moonE = moonSkyE;
  params.turbidity = turb; params.scatterBoost = S_SCATTER;
  const sky = C(), hor = C(), sunSide = C();
  const dir = new Vector3();
  let wSky = 0, wHor = 0;
  const lowSun = 1 - smoothstep(3, 20, cel.sunAltitude * RAD2DEG);
  const rings = [[0.5 * Math.PI, 1, lerp(0.45, 0.6, lowSun)], [50 * DEG2RAD, 6, lerp(0.40, 0.32, lowSun)], [14 * DEG2RAD, 8, lerp(0.15, 0.08, lowSun)]];
  const sunH = { x: cel.sunDir.x, y: 0, z: cel.sunDir.z };
  const hl = Math.hypot(sunH.x, sunH.z) || 1;
  sunH.x /= hl; sunH.z /= hl;
  for (const [elev, n, weight] of rings) {
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + 0.3;
      dir.x = Math.cos(elev) * Math.sin(az); dir.y = Math.sin(elev); dir.z = -Math.cos(elev) * Math.cos(az);
      skyRadiance(dir, camAlt, params, 10, 4, out);
      const w = (weight / n) * (1 - 0.6 * lowSun * Math.max(0, dir.x * sunH.x + dir.y * sunH.y + dir.z * sunH.z));
      clampLum(out.radiance, 0.4);
      sky.r += out.radiance.r * w; sky.g += out.radiance.g * w; sky.b += out.radiance.b * w;
      wSky += w;
    }
  }
  mulS(sky, 1 / wSky);
  const nHor = 10;
  for (let i = 0; i < nHor; i++) {
    const az = (i / nHor) * Math.PI * 2 + 0.15;
    const elev = 1.6 * DEG2RAD;
    dir.x = Math.cos(elev) * Math.sin(az); dir.y = Math.sin(elev); dir.z = -Math.cos(elev) * Math.cos(az);
    skyRadiance(dir, camAlt, params, 10, 4, out);
    clampLum(out.radiance, 0.7);
    const w = 0.55 + 0.45 * Math.max(0, dir.x * fwd.x + dir.z * fwd.z);
    hor.r += out.radiance.r * w; hor.g += out.radiance.g * w; hor.b += out.radiance.b * w;
    wHor += w;
  }
  mulS(hor, 1 / wHor);
  if (Math.hypot(cel.sunDir.x, cel.sunDir.z) > 1e-3) {
    const azS = Math.atan2(sunH.x, -sunH.z);
    const elev = 5 * DEG2RAD;
    for (const dAz of [-30 * DEG2RAD, 0, 30 * DEG2RAD]) {
      const az = azS + dAz;
      dir.x = Math.cos(elev) * Math.sin(az); dir.y = Math.sin(elev); dir.z = -Math.cos(elev) * Math.cos(az);
      skyRadiance(dir, camAlt, params, 10, 4, out);
      clampLum(out.radiance, 1.4);
      sunSide.r += out.radiance.r / 3; sunSide.g += out.radiance.g / 3; sunSide.b += out.radiance.b / 3;
    }
  }
  sky.r += NIGHT_GLOW.r * nightAmount * 1.4; sky.g += NIGHT_GLOW.g * nightAmount * 1.4; sky.b += NIGHT_GLOW.b * nightAmount * 1.4;
  hor.r += NIGHT_GLOW.r * nightAmount * 2.4; hor.g += NIGHT_GLOW.g * nightAmount * 2.4; hor.b += NIGHT_GLOW.b * nightAmount * 2.4;
  return { sky, hor, sunSide };
}

/** Full-weather transcription of computeFrame (index.js 234-460).
 *  wst: the web weather.state object (named keys) + weather.wetness/snowCover/cloudCover/sunFactor. */
function computeLighting(hour, doy, latDeg, camAlt, fwd, wst) {
  const cel = celestial(hour, doy, latDeg, {});
  const sunAltDeg = cel.sunAltitude * RAD2DEG;
  const moonAltDeg = cel.moonAltitude * RAD2DEG;
  const turb = wst.turbidity;
  const lowSun = 1 - smoothstep(4, 20, sunAltDeg);
  S_SCATTER = lerp(1.95, ATMOS.scatterBoost, smoothstep(2, 22, sunAltDeg));
  const nightAmount = clamp01(1 - smoothstep(-13, -1, sunAltDeg));

  const sunT = copy(transmittanceToLight(cel.sunDir, camAlt, turb));
  const sunTHigh = copy(transmittanceToLight(cel.sunDir, 2600, turb));
  const moonT = copy(transmittanceToLight(cel.moonDir, camAlt, turb));
  const sunUp = smoothstep(-1.8, 1.2, sunAltDeg);
  const sunMax = Math.max(sunT.r, sunT.g, sunT.b, 1e-4);
  const sunIntensity = ATMOS.sunE * Math.pow(sunMax, lerp(1, 0.6, lowSun)) * sunUp * wst.sunFactor;
  const sunColor = copy(sunT);
  mulS(sunColor, 1 / sunMax);
  {
    const l = luminance(sunColor);
    lerpC(sunColor, greyC(l), lerp(0.28, 0.2, lowSun));
    mulS(sunColor, 1 / Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-4));
    sunColor.r = Math.max(sunColor.r, 1.0);
    sunColor.g = Math.max(sunColor.g, 0.5);
    sunColor.b = Math.max(sunColor.b, 0.2);
  }
  lerpC(sunColor, KEY_WARM, 0.55 * (1 - smoothstep(8, 46, sunAltDeg)));
  if (lowSun > 0) lerpC(sunColor, C(1.0, 0.55, 0.25), 0.55 * lowSun * sunUp);
  const moonUp = smoothstep(-1, 6, moonAltDeg);
  const moonMax = Math.max(moonT.r, moonT.g, moonT.b, 1e-4);
  const moonIntensity = MOON_LIGHT * cel.moonIllumination * moonMax * moonUp * lerp(1, wst.sunFactor, 0.85);
  const moonColor = copy(moonT);
  mulS(moonColor, 1 / moonMax);
  lerpC(moonColor, C(1, 1, 1), 0.6);
  moonColor.r *= MOON_COLOR.r; moonColor.g *= MOON_COLOR.g; moonColor.b *= MOON_COLOR.b;
  const moonSkyE = MOON_SKY_E * cel.moonIllumination * moonUp;

  const baseNight = nightFactorForSun(sunAltDeg);
  const overcastNight = (1 - smoothstep(-2, 10, sunAltDeg)) * clamp01((wst.cloudCover - 0.55) * 2.2) * 0.7;
  const nightFactor = clamp01(Math.max(baseNight, overcastNight));

  let exposure = exposureForSun(sunAltDeg);
  exposure *= 1 + 0.10 * smoothstep(0.45, 0.95, wst.cloudCover) * (1 - nightFactor) + 0.06 * wst.precipitation;
  exposure *= lerp(1.0, 0.93, smoothstep(16, 42, sunAltDeg));
  const moonIrr = moonIntensity * Math.max(0, cel.moonDir.y);
  exposure *= 1 - 0.5 * clamp01(moonIrr / 0.12) * nightAmount;

  const { sky: skyAvg, hor: horizonAvg, sunSide: sunSideAvg } =
    sampleSkyAverages(cel, camAlt, moonSkyE, nightAmount, fwd, turb);

  let lightColor, lightIntensity, lightToward;
  if (sunIntensity >= moonIntensity) {
    lightColor = sunColor; lightIntensity = sunIntensity; lightToward = cel.sunDir;
  } else {
    lightColor = moonColor; lightIntensity = moonIntensity; lightToward = cel.moonDir;
  }
  const lightDir = { x: -lightToward.x, y: -lightToward.y, z: -lightToward.z };
  {
    const MIN_SHADOW_ELEV = 2.5 * DEG2RAD;
    if (lightDir.y > -Math.sin(MIN_SHADOW_ELEV)) {
      const h = Math.hypot(lightDir.x, lightDir.z) || 1;
      const c = Math.cos(MIN_SHADOW_ELEV);
      lightDir.x = (lightDir.x / h) * c;
      lightDir.y = -Math.sin(MIN_SHADOW_ELEV);
      lightDir.z = (lightDir.z / h) * c;
    }
    const ll = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
    lightDir.x /= ll; lightDir.y /= ll; lightDir.z /= ll;
  }

  const skyLum = luminance(skyAvg);
  const sunIrrClear = ATMOS.sunE * sunMax * sunUp * Math.max(0, cel.sunDir.y);
  const diffuseE = sunIrrClear * (1 - wst.sunFactor) * wst.diffuse / Math.PI;
  const diffuseCol = mulS(copy(sunColor), diffuseE);
  { const l = luminance(diffuseCol); lerpC(diffuseCol, greyC(l), 0.6); }
  const overLum = skyLum * 1.15;
  const cover = wst.cloudCover;
  const hemiSky = C(
    lerp(skyAvg.r, overLum, cover * 0.85) + diffuseCol.r,
    lerp(skyAvg.g, overLum, cover * 0.85) + diffuseCol.g,
    lerp(skyAvg.b, overLum, cover * 0.85) + diffuseCol.b);
  hemiSky.r += moonColor.r * moonIntensity * 0.033;
  hemiSky.g += moonColor.g * moonIntensity * 0.033;
  hemiSky.b += moonColor.b * moonIntensity * 0.033;
  const snow = wst.snowCover;
  const groundAlbedo = {
    r: lerp(GROUND_ALBEDO.r, SNOW_ALBEDO.r, snow),
    g: lerp(GROUND_ALBEDO.g, SNOW_ALBEDO.g, snow),
    b: lerp(GROUND_ALBEDO.b, SNOW_ALBEDO.b, snow),
  };
  const sunIrr = sunIntensity * Math.max(0, cel.sunDir.y) + moonIntensity * Math.max(0, cel.moonDir.y) * 0.5;
  const groundRad = C(
    groundAlbedo.r * (sunColor.r * sunIrr / Math.PI + hemiSky.r * 0.9),
    groundAlbedo.g * (sunColor.g * sunIrr / Math.PI + hemiSky.g * 0.9),
    groundAlbedo.b * (sunColor.b * sunIrr / Math.PI + hemiSky.b * 0.9));
  hemiSky.r = Math.max(hemiSky.r, NIGHT_FLOOR.r * nightAmount);
  hemiSky.g = Math.max(hemiSky.g, NIGHT_FLOOR.g * nightAmount);
  hemiSky.b = Math.max(hemiSky.b, NIGHT_FLOOR.b * nightAmount);
  const hemiMax = Math.max(hemiSky.r, hemiSky.g, hemiSky.b, 1e-5);
  const lowSunLift = 1 + 0.45 * lowSun * sunUp;
  const hemiRaw = hemiMax * AMBIENT_K * lowSunLift;
  let hemiIntensity = clamp(hemiRaw, 0.010, 0.95);
  const floorKey = NIGHT_KEY * (1 + 1.05 * smoothstep(-13, -1, sunAltDeg) * (1 - smoothstep(0.5, 4.5, sunAltDeg)));
  const floorIntensity = floorKey * lerp(1.0, 0.88, nightAmount) / exposure;
  let floorMix = 0;
  if (hemiIntensity < floorIntensity) {
    floorMix = 1 - hemiIntensity / floorIntensity;
    hemiIntensity = floorIntensity;
  }
  const hemiCol = copy(hemiSky); mulS(hemiCol, 1 / hemiMax);
  lerpC(hemiCol, TWILIGHT_SKY, floorMix * (1 - nightAmount * 0.5));
  const goldenCool = lowSun * sunUp * (1 - 0.6 * cover);
  lerpC(hemiCol, GOLDEN_SKY, 0.45 * goldenCool);
  const hemiGround = copy(groundRad); mulS(hemiGround, 1 / Math.max(groundRad.r, groundRad.g, groundRad.b, 1e-5));
  {
    const l = luminance(hemiGround);
    lerpC(hemiGround, greyC(l), lerp(0.5, 0.82, Math.max(goldenCool, nightAmount)));
    lerpC(hemiGround, COOL_BOUNCE, 0.42 * Math.max(goldenCool, nightAmount));
    mulS(hemiGround, lerp(0.34, 0.30, Math.max(goldenCool, nightAmount)));
  }
  const lowSunFog = 1 - smoothstep(3, 20, sunAltDeg);
  const fogColor = copy(C(
    lerp(horizonAvg.r, skyAvg.r, lerp(0.45, 0.6, lowSunFog)),
    lerp(horizonAvg.g, skyAvg.g, lerp(0.45, 0.6, lowSunFog)),
    lerp(horizonAvg.b, skyAvg.b, lerp(0.45, 0.6, lowSunFog))));
  {
    const fogLum = luminance(fogColor);
    lerpC(fogColor, greyC(fogLum), cover * 0.45);
  }
  {
    const milk = C(skyAvg.r * 1.05 + diffuseCol.r, skyAvg.g * 1.05 + diffuseCol.g, skyAvg.b * 1.05 + diffuseCol.b);
    const l = luminance(milk); lerpC(milk, greyC(l), 0.35);
    milk.r = Math.max(milk.r, fogColor.r); milk.g = Math.max(milk.g, fogColor.g); milk.b = Math.max(milk.b, fogColor.b);
    lerpC(fogColor, milk, wst.milk);
  }
  fogColor.r = Math.max(fogColor.r, 0.010 * floorMix / exposure);
  fogColor.g = Math.max(fogColor.g, 0.015 * floorMix / exposure);
  fogColor.b = Math.max(fogColor.b, 0.034 * floorMix / exposure);
  const fogDensity = wst.fog * (1 + 0.25 * nightFactor);
  const fogH = wst.fogH * (1 - 0.2 * nightFactor);
  const fogSunGlow = wst.milk * sunUp * 1.6 * smoothstep(0.02, 0.4, wst.sunFactor + 0.2);
  const fogMax = lerp(0.80, 1.0, clamp01(wst.milk * 1.1));
  // directional aerial perspective (warm in the sun hemisphere, cool away)
  const amp = lowSun * sunUp * (1 - 0.55 * wst.milk);
  const fogWarm = C(lerp(1, 1.22, amp), lerp(1, 1.02, amp), lerp(1, 0.80, amp));
  const fogCool = C(lerp(1, 0.84, amp), lerp(1, 0.93, amp), lerp(1, 1.16, amp));
  const wetness = wst.wetness * (1 - wst.snowCover);

  return {
    sunAltDeg, moonAltDeg, moonIllum: cel.moonIllumination,
    sunDir: [cel.sunDir.x, cel.sunDir.y, cel.sunDir.z],
    moonDir: [cel.moonDir.x, cel.moonDir.y, cel.moonDir.z],
    lightDir: [lightDir.x, lightDir.y, lightDir.z],
    sunIntensity, sunColor: [sunColor.r, sunColor.g, sunColor.b],
    moonIntensity, moonColor: [moonColor.r, moonColor.g, moonColor.b],
    exposure, nightFactor, nightAmount,
    skyAvg: [skyAvg.r, skyAvg.g, skyAvg.b],
    horizonAvg: [horizonAvg.r, horizonAvg.g, horizonAvg.b],
    sunSideAvg: [sunSideAvg.r, sunSideAvg.g, sunSideAvg.b],
    hemiIntensity, hemiRaw, floorMix,
    hemiCol: [hemiCol.r, hemiCol.g, hemiCol.b],
    hemiGround: [hemiGround.r, hemiGround.g, hemiGround.b],
    groundRad: [groundRad.r, groundRad.g, groundRad.b],
    fogColor: [fogColor.r, fogColor.g, fogColor.b],
    fogDensity, fogH, fogFloor: wst.fogFloor, fogSunGlow, fogMax,
    fogWarm: [fogWarm.r, fogWarm.g, fogWarm.b],
    fogCool: [fogCool.r, fogCool.g, fogCool.b],
    wetness, snowCover: wst.snowCover, cloudCover: cover, sunFactor: wst.sunFactor, skyFog: wst.skyFog,
  };
}

const LAT = 47.3, DOY = dayOfYear({ month: 5, day: 1 });
const CAM_ALT = 24.0;
const FWD = { x: 0, y: 0, z: -1 };
const HOURS = [8, 14, 19.5, 22];

// run each preset through the REAL Weather class constructor so the state matches the
// native Weather(1337, name) init state exactly (no transition drift in the goldens)
const dump = { lat: LAT, doy: DOY, camAlt: CAM_ALT, presets: {} };
for (const name of Object.keys(WEATHER_PRESETS)) {
  const w = new Weather(1337, name);
  const wst = { ...w.state, cloudCover: w.cloudCover, sunFactor: w.sunFactor, wetness: w.wetness, snowCover: w.snowCover };
  dump.presets[name] = {};
  for (const h of HOURS) dump.presets[name][h] = computeLighting(h, DOY, LAT, CAM_ALT, FWD, wst);
}

// ---- Kotlin emission ----
const P = (v) => {
  if (!Number.isFinite(v)) throw new Error('non-finite golden: ' + v);
  const s = String(v);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
};
const A3 = (a) => [...a].map(P).join(', ');
const rows = [];
for (const [name, hours] of Object.entries(dump.presets)) {
  for (const [h, L] of Object.entries(hours)) {
    rows.push({ tag: `${name}_${h}`, L });
  }
}
const K = [];
K.push('package com.fablecities.android.worldgen');
K.push('');
K.push('/** GENERATED by tools/probe_env_weather.mjs — full-weather computeFrame goldens from the');
K.push(' *  REAL web Weather.js presets + atmosphere.js (lat 47.3, doy 121, camAlt 24, seed 1337');
K.push(' *  preset init states). Do not edit by hand.');
K.push(' *  One row per preset x hour: the Kotlin Environment.compute must reproduce every value. */');
K.push('object EnvWeatherGoldens {');
K.push('    val TAGS = arrayOf(');
for (const r of rows) K.push(`        "${r.tag}",`);
K.push('    )');
K.push('    val ROWS = arrayOf(');
for (const r of rows) {
  const L = r.L;
  K.push('        doubleArrayOf(');
  K.push(`            ${P(L.sunAltDeg)}, ${P(L.moonAltDeg)}, ${P(L.moonIllum)},`);
  K.push(`            ${A3(L.sunDir)}, ${A3(L.moonDir)}, ${A3(L.lightDir)},`);
  K.push(`            ${P(L.sunIntensity)}, ${A3(L.sunColor)}, ${P(L.moonIntensity)}, ${A3(L.moonColor)},`);
  K.push(`            ${P(L.exposure)}, ${P(L.nightFactor)}, ${P(L.nightAmount)},`);
  K.push(`            ${A3(L.skyAvg)}, ${A3(L.horizonAvg)}, ${A3(L.sunSideAvg)},`);
  K.push(`            ${P(L.hemiIntensity)}, ${P(L.hemiRaw)}, ${P(L.floorMix)},`);
  K.push(`            ${A3(L.hemiCol)}, ${A3(L.hemiGround)}, ${A3(L.groundRad)},`);
  K.push(`            ${A3(L.fogColor)}, ${P(L.fogDensity)}, ${P(L.fogH)}, ${P(L.fogFloor)}, ${P(L.fogSunGlow)}, ${P(L.fogMax)},`);
  K.push(`            ${A3(L.fogWarm)}, ${A3(L.fogCool)},`);
  K.push(`            ${P(L.wetness)}, ${P(L.snowCover)}, ${P(L.cloudCover)}, ${P(L.sunFactor)}, ${P(L.skyFog)},`);
  K.push('        ),');
}
K.push('    )');
K.push('    // row layout offsets (each value or triple in order)')
K.push('    const val N_SCALARS = 46')
K.push('}');
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/EnvWeatherGoldens.kt', import.meta.url), K.join('\n') + '\n');
console.log('EnvWeatherGoldens.kt written,', rows.length, 'preset-hour rows');
