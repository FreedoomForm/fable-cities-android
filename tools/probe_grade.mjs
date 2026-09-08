// Grade-driver golden probe — the effects/index.js post-chain driver (weather-state damp
// chains + colour-grade uniform transitions + sun glare/auto-exposure) transcribed from
// src/modules/effects/index.js and driven by the REAL web Weather.js + the REAL atmosphere
// primitives (the same computeFrame transcription probe_env_weather.mjs uses, which
// EnvWeatherParityTest already pins against the Kotlin port).
// Emits android/app/src/test/java/com/fablecities/android/worldgen/GradeGoldens.kt.
// The Kotlin port (GradeFx.kt) must reproduce these bit-exactly.
import { writeFileSync } from 'node:fs';
import {
  ATMOS, transmittanceToLight, celestial,
  exposureForSun, nightFactorForSun, luminance,
} from '../src/modules/environment/atmosphere.js';
import { clamp, clamp01, lerp, smoothstep, DEG2RAD, RAD2DEG } from '../src/shared/math.js';
import { Weather, WEATHER_PRESETS } from '../src/modules/environment/Weather.js';

const MOON_COLOR = { r: 0.62, g: 0.72, b: 1.0 };
const MOON_LIGHT = 0.26;
const MOON_SKY_E = 0.065;
const GROUND_ALBEDO = { r: 0.30, g: 0.29, b: 0.24 };
const SNOW_ALBEDO = { r: 0.78, g: 0.80, b: 0.86 };
const KEY_WARM = { r: 1.0, g: 0.935, b: 0.80 };

const C = (r = 0, g = 0, b = 0) => ({ r, g, b });
const copy = (a) => C(a.r, a.g, a.b);
const mulS = (c, s) => { c.r *= s; c.g *= s; c.b *= s; return c; };
const lerpC = (c, o, t) => { c.r += (o.r - c.r) * t; c.g += (o.g - c.g) * t; c.b += (o.b - c.b) * t; return c; };
const greyC = (l) => C(l, l, l);
const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

let S_SCATTER = ATMOS.scatterBoost;

function clampLum(c, maxLum) { const l = luminance(c); if (l > maxLum) mulS(c, maxLum / l); return c; }

/** The computeFrame transcription (the fields the grade driver consumes). Matches
 *  probe_env_weather.mjs computeLighting — pinned to Kotlin by EnvWeatherParityTest. */
function frame(hour, wst) {
  const doy = 121, latDeg = 47.3, camAlt = 24;
  const fwd = { x: 0.7071, y: 0, z: -0.7071 };
  const cel = celestial(hour, doy, latDeg, {});
  const sunAltDeg = cel.sunAltitude * RAD2DEG;
  const moonAltDeg = cel.moonAltitude * RAD2DEG;
  const turb = wst.turbidity;
  const lowSun = 1 - smoothstep(4, 20, sunAltDeg);
  S_SCATTER = lerp(1.95, ATMOS.scatterBoost, smoothstep(2, 22, sunAltDeg));
  const nightAmount = clamp01(1 - smoothstep(-13, -1, sunAltDeg));
  const sunT = copy(transmittanceToLight(cel.sunDir, camAlt, turb));
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
  const snow = wst.snowCover;
  return {
    sunIntensity, moonIntensity, sunColor, nightFactor, nightAmount, exposure,
    sunDir: cel.sunDir, moonDir: cel.moonDir, sunAltDeg,
    precipitation: wst.precipitation, wetness: wst.wetness, snow: wst.snowCover,
    cloudCover: wst.cloudCover, skyFog: wst.skyFog,
  };
}

// ---------- effects/index.js weather-state + grade driver (transcribed) ----------
const MAX_SHIMMER = 6;

function makeFx() {
  return {
    warmed: false, rainAmt: 0, snowAmt: 0, wetness: 0, snowCover: 0, time: 0,
    // grade uniform chain (constructor defaults = ColorGradingPass uniforms)
    uContrast: 1.35, uToe: 0.2, uShoulder: 0.34, uBlack: 0.0012,
    uSaturation: 1.0, uMidSat: 0.18, uHiDesat: 0.15,
    uTint: [1, 1, 1], uShadowTint: [0.93, 0.965, 1.07], uHighlightTint: [1.06, 1.0, 0.93],
    uLift: [0, 0, 0], uGain: [1, 1, 1],
    uExposure: 1.0, adaptBlend: 1.0,
    uSun: [0, 0, 0, 0], uSunColor: [1, 0.95, 0.85], uGlare: 1.0,
    probeActive: false, uAuto: [2.5, 0.9, 1.85, 0], uVignette: [0.14, 0.52],
  };
}

function stepFx(S, dt, env, camPos, vpProject) {
  S.time += dt;
  const sunDir = env.sunDir;                       // effects uses env.sunDirection = travel dir = -toward
  const travelY = -sunDir.y;
  const sunUp = smoothstep(-0.04, 0.10, travelY);
  const night = clamp01(env.nightFactor ?? 0);
  const cloud = clamp01(env.cloudCover ?? 0.3);
  const w = String(env.weather || '').toLowerCase();
  const snowing = w === 'snow';
  const raining = w === 'rain' || w === 'storm';
  const precip = env.precipitation != null ? clamp01(env.precipitation) : null;
  const rainTarget = snowing ? 0 : raining ? (precip ?? 0.9) : 0;
  const snowTarget = snowing ? (precip ?? 0.9) : 0;
  if (!S.warmed) {
    S.warmed = true;
    S.rainAmt = rainTarget; S.snowAmt = snowTarget;
    S.wetness = rainTarget > 0.02 ? Math.max(clamp01(env.wetness ?? 1), Math.min(rainTarget + 0.3, 1)) : clamp01(env.wetness ?? 0);
    S.snowCover = snowTarget > 0.02 ? 1 : clamp01(env.snow ?? 0);
  }
  S.rainAmt = damp(S.rainAmt, rainTarget, 2.5, dt);
  S.snowAmt = damp(S.snowAmt, snowTarget, 2.5, dt);
  const envWet = env.wetness != null ? clamp01(env.wetness) : null;
  const wetTarget = envWet != null ? Math.max(envWet, S.rainAmt > 0.02 ? Math.min(S.rainAmt + 0.3, 1) : 0) : S.rainAmt > 0.02 ? Math.max(S.rainAmt, 0.7) : 0;
  if (wetTarget >= S.wetness) S.wetness = damp(S.wetness, wetTarget, 1.5, dt);
  else S.wetness = Math.max(wetTarget, S.wetness - dt / 300 * (0.3 + 0.7 * sunUp * (1 - 0.6 * cloud)));
  const envSnow = env.snow != null ? clamp01(env.snow) : null;
  const snowTargetC = envSnow != null ? Math.max(envSnow, S.snowAmt > 0.02 ? 1 : 0) : S.snowAmt > 0.02 ? 1 : 0;
  if (snowTargetC >= S.snowCover) S.snowCover = damp(S.snowCover, snowTargetC, envSnow != null ? 3 : 0.25, dt);
  else S.snowCover = Math.max(snowTargetC, S.snowCover - dt / 600 * (0.2 + 0.8 * sunUp));
  if (S.wetness < 0.002) S.wetness = 0;
  if (S.snowCover < 0.002) S.snowCover = 0;

  // ---------- colour grading (effects/index.js, the S.grading block) ----------
  const wet = S.wetness, snow = S.snowCover, snowAmt = S.snowAmt, rainAmt = S.rainAmt;
  const lowSun = (1 - smoothstep(0.06, 0.42, travelY)) * sunUp * (1 - night);
  const L = 5;
  const k = 1 - Math.exp(-L * dt);
  const dayA = 1 - night;
  S.uContrast = damp(S.uContrast, (1.52 - night * 0.26 - cloud * 0.05 - wet * 0.03 - snowAmt * 0.08 - snow * 0.06) * 1.0, L, dt);
  S.uToe = damp(S.uToe, -0.58 * dayA * (1 - 0.15 * cloud) * (1 - 0.12 * wet) * (1 - 0.6 * snow) + 0.18 * night + 0.10 * snow * dayA, L, dt);
  S.uShoulder = damp(S.uShoulder, 0.34 + snow * 0.06 + lowSun * 0.20, L, dt);
  S.uBlack = damp(S.uBlack, 0.0072 * dayA * (1 - 0.15 * cloud) * (1 - snow * 0.7) + 0.0026 * night, L, dt);
  {
    const highSun = smoothstep(0.35, 0.75, travelY);
    const wPost = 3.60 + 0.55 * snow + 0.15 * cloud;
    const sh = S.uShoulder, ct = Math.max(S.uContrast, 0.5);
    let lcp = Math.log2(wPost / 0.18);
    if (lcp > 2.9) lcp = (lcp - 2.9 * 0.3 * sh) / (1 - 0.3 * sh);
    const wPre = 0.18 * Math.pow(2, lcp / ct);
    const gMax = (1.22 + 0.32 * cloud + 0.14 * wet - 0.10 * highSun) * dayA + 1.14 * night;
    S.uAuto = [wPre, 0.72 * dayA + 0.9 * night, gMax, 0.5 + 0.2 * dayA];
  }
  S.adaptBlend = Math.exp(-1.5 * Math.min(dt, 0.1));
  S.uExposure = damp(S.uExposure, 1.0, L, dt);
  S.uSaturation = damp(S.uSaturation, (1.16 - night * 0.10 - wet * 0.08 - cloud * 0.03 - snowAmt * 0.06 - snow * 0.02 + lowSun * 0.03) * 1.0, L, dt);
  S.uMidSat = damp(S.uMidSat, 0.17 * (1 - night * 0.6) * (1 - wet * 0.5) * (1 - snowAmt * 0.4), L, dt);
  S.uHiDesat = damp(S.uHiDesat, 0.11 + lowSun * 0.06 + snowAmt * 0.06 + night * 0.05, L, dt);
  {
    let v = [1, 1, 1];
    const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    v = mix3(v, [0.96, 0.98, 1.04], night * 0.5);
    v = mix3(v, [1.06, 1.0, 0.93], lowSun * 0.6);
    v = mix3(v, [0.965, 0.985, 1.03], clamp01(wet * 0.8));
    v = mix3(v, [0.985, 0.995, 1.025], snowAmt * 0.6);
    S.uTint = [S.uTint[0] + (v[0] - S.uTint[0]) * k, S.uTint[1] + (v[1] - S.uTint[1]) * k, S.uTint[2] + (v[2] - S.uTint[2]) * k];
    let shv = [0.85, 0.94, 1.20];
    shv = mix3(shv, [0.94, 0.97, 1.08], night);
    shv = mix3(shv, [0.85, 0.93, 1.20], snow * 0.7);
    S.uShadowTint = [S.uShadowTint[0] + (shv[0] - S.uShadowTint[0]) * k, S.uShadowTint[1] + (shv[1] - S.uShadowTint[1]) * k, S.uShadowTint[2] + (shv[2] - S.uShadowTint[2]) * k];
    let hiv = [1.08, 1.0, 0.90];
    hiv = mix3(hiv, [1.04, 1.0, 0.96], night);
    hiv = mix3(hiv, [1.0, 1.0, 1.0], clamp01(wet + snowAmt));
    S.uHighlightTint = [S.uHighlightTint[0] + (hiv[0] - S.uHighlightTint[0]) * k, S.uHighlightTint[1] + (hiv[1] - S.uHighlightTint[1]) * k, S.uHighlightTint[2] + (hiv[2] - S.uHighlightTint[2]) * k];
    let lv = [0.0058, 0.0064, 0.0082];
    lv = mix3(lv, [0.0028, 0.0032, 0.0044], night);
    lv = mix3(lv, [0.0068, 0.0074, 0.0094], snow * 0.5 * (1 - night));
    S.uLift = [S.uLift[0] + (lv[0] - S.uLift[0]) * k, S.uLift[1] + (lv[1] - S.uLift[1]) * k, S.uLift[2] + (lv[2] - S.uLift[2]) * k];
    const gain = 1 - wet * 0.04 + snow * 0.03;
    S.uGain = [S.uGain[0] + (gain - S.uGain[0]) * k, S.uGain[1] + (gain - S.uGain[1]) * k, S.uGain[2] + (gain - S.uGain[2]) * k];
  }
  S.uVignette = [Math.min(Math.max((0.105 - night * 0.03 + wet * 0.02) * 1.0, 0), 0.2), 0.52];

  // sun screen position + visibility (camera looks along +x/-z like the native boot camera)
  let vis = 0;
  const sunAbove = true; // (env.sunAltitude > -2 gate in the probe caller)
  {
    const px = camPos[0] - sunDir.x * 3000, py = camPos[1] - sunDir.y * 3000, pz = camPos[2] - sunDir.z * 3000;
    const pr = vpProject(px, py, pz);
    if (pr[2] < 1 && Number.isFinite(pr[0])) {
      const edge = Math.max(Math.abs(pr[0]), Math.abs(pr[1]));
      const highSun = smoothstep(0.12, 0.55, travelY);
      vis = sunUp * (1 - night) * (1 - 0.8 * cloud) * (1 - rainAmt) * (1 - snowAmt)
        * clamp01((env.sunIntensity ?? 3) / 2.5) * (1 - smoothstep(1.1, 1.8, edge)) * (1 - 0.4 * highSun);
      S.uSun = [pr[0], pr[1], vis, 0];
      S.probeActive = vis > 0.001;
    } else { S.uSun = [S.uSun[0], S.uSun[1], 0, 0]; S.probeActive = false; }
  }
  {
    const sc = env.sunColor;
    const s = Math.sqrt(clamp((env.sunIntensity ?? 3) / 3.5, 0.15, 1.2));
    S.uSunColor = [sc.r * s, sc.g * s, sc.b * s];
  }
  S.uGlare = 1.0;
}

// ---------- drive ----------
const SEED = 1337;
const HOURS = [2, 8, 14, 20];
const DT = 1 / 60;
const PRECIP_MODE = { clear: 0, cloudy: 0, rain: 0, fog: 0, snow: 1 };
// camera: the native boot camera (pos = target + dist*(sin yaw, sin pitch, cos yaw), pitch 0.85,
// yaw toward the settlement) projected with a 50 deg fov 16:9 matrix — replicated in Kotlin.
const camPos = [-284 + 430 * Math.sin(0) * Math.sin(1.2), 12 + 430 * Math.sin(0.85), -180 + 430 * Math.cos(0) * Math.cos(1.2)];
const FOV = 50 * Math.PI / 180, ASPECT = 16 / 9;
function vpProject(x, y, z) {
  // view space (look at the target = origin-ish: use the direction to (-284,-180))
  const tx = -284 - camPos[0], ty = 8 - camPos[1], tz = -180 - camPos[2];
  const tl = Math.hypot(tx, ty, tz);
  const fz = [tx / tl, ty / tl, tz / tl];
  const up0 = [0, 1, 0];
  const rx = [fz[1] * up0[2] - fz[2] * up0[1], fz[2] * up0[0] - fz[0] * up0[2], fz[0] * up0[1] - fz[1] * up0[0]];
  const rl = Math.hypot(...rx); rx[0] /= rl; rx[1] /= rl; rx[2] /= rl;
  const ux = [rx[1] * fz[2] - rx[2] * fz[1], rx[2] * fz[0] - rx[0] * fz[2], rx[0] * fz[1] - rx[1] * fz[0]];
  const dx = x - camPos[0], dy = y - camPos[1], dz = z - camPos[2];
  const vx = dx * rx[0] + dy * rx[1] + dz * rx[2];
  const vy = dx * ux[0] + dy * ux[1] + dz * ux[2];
  const vz = -(dx * fz[0] + dy * fz[1] + dz * fz[2]);
  const f = 1 / Math.tan(FOV / 2);
  const cw = -vz;
  if (Math.abs(cw) < 1e-9) return [0, 0, 2];
  const ndcX = (f / ASPECT) * vx / cw, ndcY = f * vy / cw;
  return [ndcX, ndcY, vz < 0 ? 0 : 1];
}

const J = (v) => { if (!Number.isFinite(v)) throw new Error('non-finite golden'); return v; };
const K = (v) => { const s = String(J(v)); return /^-?\d+$/.test(s) ? `${s}.0` : s; };
const A = (arr) => `doubleArrayOf(${arr.map(K).join(', ')})`;

const rows = [];
for (const preset of Object.keys(WEATHER_PRESETS)) {
  const w = new Weather(SEED, preset);
  // settle the weather chain on the site's game clock (2 h at speed 1 = 7200 game-s = 360 real-s)
  for (let i = 0; i < 360; i++) w.update(DT, i * DT * 20);
  for (const hour of HOURS) {
    const wst = { ...w.state, cloudCover: w.cloudCover, sunFactor: w.sunFactor, wetness: w.wetness, snowCover: w.snowCover };
    const env = frame(hour, wst);
    env.weather = preset;
    const S = makeFx();
    // warm snap + 240 frames (4 s) of the damp chains at dt = 1/60
    for (let i = 0; i < 240; i++) stepFx(S, DT, env, camPos, vpProject);
    rows.push({ preset, hour, env, S });
  }
}

// ---------- emit Kotlin ----------
const L = [];
L.push('package com.fablecities.android.worldgen');
L.push('');
L.push('// GENERATED by tools/probe_grade.mjs — the effects/index.js post-chain driver (weather-state');
L.push('// damp chains + colour-grade uniforms + sun glare/auto-exposure) from the REAL web modules.');
L.push('// Do not edit. The Kotlin port (worldgen/GradeFx.kt) must reproduce these bit-exactly.');
L.push('object GradeGoldens {');
L.push('    const val DT = ' + K(DT));
L.push('    val CAM_POS = ' + A(camPos));
L.push('    class Row(');
L.push('        val preset: String, val hour: Double,');
L.push('        // env frame inputs (from the pinned computeFrame transcription)')
L.push('        val sunIntensity: Double, val sunColor: DoubleArray, val nightFactor: Double,')
L.push('        val sunDir: DoubleArray, val precipitation: Double, val wetness: Double,')
L.push('        val snow: Double, val cloudCover: Double,')
L.push('        // effects weather-state chain output')
L.push('        val rainAmt: Double, val snowAmt: Double, val fxWetness: Double, val fxCover: Double,')
L.push('        // grade uniforms after 240 frames of dt = 1/60')
L.push('        val uContrast: Double, val uToe: Double, val uShoulder: Double, val uBlack: Double,')
L.push('        val uSaturation: Double, val uMidSat: Double, val uHiDesat: Double, val uExposure: Double,')
L.push('        val uTint: DoubleArray, val uShadowTint: DoubleArray, val uHighlightTint: DoubleArray,')
L.push('        val uLift: DoubleArray, val uGain: DoubleArray, val uVignette: DoubleArray,')
L.push('        val uAuto: DoubleArray, val uSun: DoubleArray, val uSunColor: DoubleArray,')
L.push('        val adaptBlend: Double,')
L.push('    )');
L.push('    val rows = mapOf(');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const e = r.env, S = r.S;
  const sep = i < rows.length - 1 ? ',' : ',';
  L.push(`        "${r.preset}:${r.hour}" to Row(`);
  L.push(`            "${r.preset}", ${K(r.hour)},`);
  L.push(`            ${K(e.sunIntensity)}, ${A([e.sunColor.r, e.sunColor.g, e.sunColor.b])}, ${K(e.nightFactor)},`);
  L.push(`            ${A([e.sunDir.x, e.sunDir.y, e.sunDir.z])}, ${K(e.precipitation)}, ${K(e.wetness)},`);
  L.push(`            ${K(e.snow)}, ${K(e.cloudCover)},`);
  L.push(`            ${K(S.rainAmt)}, ${K(S.snowAmt)}, ${K(S.wetness)}, ${K(S.snowCover)},`);
  L.push(`            ${K(S.uContrast)}, ${K(S.uToe)}, ${K(S.uShoulder)}, ${K(S.uBlack)},`);
  L.push(`            ${K(S.uSaturation)}, ${K(S.uMidSat)}, ${K(S.uHiDesat)}, ${K(S.uExposure)},`);
  L.push(`            ${A(S.uTint)}, ${A(S.uShadowTint)}, ${A(S.uHighlightTint)},`);
  L.push(`            ${A(S.uLift)}, ${A(S.uGain)}, ${A(S.uVignette)},`);
  L.push(`            ${A(S.uAuto)}, ${A(S.uSun)}, ${A(S.uSunColor)},`);
  L.push(`            ${K(S.adaptBlend)}),`);
}
L.push('    )');
L.push('}');
writeFileSync('android/app/src/test/java/com/fablecities/android/worldgen/GradeGoldens.kt', L.join('\n') + '\n');
console.log('GradeGoldens.kt written:', rows.length, 'rows');
