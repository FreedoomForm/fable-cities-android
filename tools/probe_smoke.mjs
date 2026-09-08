// SmokeSystem golden probe — runs the REAL web smoke stack in Node and emits
// android/app/src/test/java/com/fablecities/android/worldgen/SmokeGoldens.kt
//
// Covers effects/SmokeSystem.js build() + countFor (budget thinning, dust rect spawn, burst
// clustering, tint/opacity jitter) and effects/sprites.js makeSmokeAtlas (the 4x4 cauliflower
// lobe atlas — the same rng/noise call order as the Kotlin Smoke.kt port). The emitter-scan
// rules live in effects/index.js rebuild() (not exported; the whole effects driver cannot run
// headless), so the probe drives build() with a deterministic emitter list whose shapes mirror
// the scan output: recorded industrial stacks, a legacy-guess stack, steam vents, cold chimneys
// and construction dust on a rect footprint.
import { writeFileSync } from 'node:fs';
import { SmokeSystem, PUFF_KINDS } from '../src/modules/effects/SmokeSystem.js';
import { makeSmokeAtlas } from '../src/modules/effects/sprites.js';
import { makeRng } from '../src/shared/random.js';

const seed = 1337;

// --- deterministic synthetic emitters (shapes = effects/index.js rebuild() output) ---------------
const emitters = [
  // recorded industrial stack (r 1.2 -> scale 1.2 * (0.80 + 3 * 0.10) with level 3)
  { kind: 'industrial', x: -120.5, y: 26.4, z: 84.0, scale: 1.2 * (0.80 + 3 * 0.10), density: 1 },
  // second plant, bigger recorded stack
  { kind: 'industrial', x: 40.25, y: 31.15, z: -60.5, scale: 1.9 * (0.80 + 4 * 0.10), density: 1 },
  // rooftop flue on a com tower (level 2, no recorded stacks -> legacy steam guess would need rng;
  // this is the recorded-vent steam variant)
  { kind: 'steam', x: 12.0, y: 46.8, z: 8.4, scale: 0.34, density: 0.45, opacity: 0.20 },
  // cold residential chimney
  { kind: 'chimney', x: -15.6, y: 11.2, z: -42.75, scale: 1.05 + 0.2 },
  { kind: 'chimney', x: 66.1, y: 9.8, z: 30.3, scale: 1.25 },
  // construction dust on a rect footprint (bursts: 5)
  { kind: 'dust', x: 5.0, y: 4.2, z: -8.0, scale: 1.2 * 1.2, rect: { w: 20, d: 16, yaw: 0.3 }, opacity: 0.6 },
];

// --- countFor -----------------------------------------------------------------------------------
const countsFor = emitters.map((e) => SmokeSystem.countFor(e));

// --- build (the site's rebuild rng: makeRng(world.seed ^ 0x3ffec7)) -----------------------------
const MAX = 4096;
const smoke = new SmokeSystem({ atlas: { texture: null, cols: 4, rows: 4 }, maxParticles: MAX });
const count = smoke.build(emitters, makeRng(seed ^ 0x3ffec7));

const sums = (arr) => {
  let s = 0.0;
  for (let i = 0; i < count * (arr.length / Math.max(1, smoke.max)) ; i++) s += arr[i];
  return s;
};
// NOTE: the attribute arrays are max-sized; only the first `count` instances are meaningful.
const sumN = (arr, n) => { let s = 0.0; for (let i = 0; i < n; i++) s += arr[i]; return s; };
const nOrigin = count * 3, nParam = count * 4, nStyle = count * 4, nColor = count * 4, nKind = count * 2, nVel = count * 3;

// first 12 instances verbatim (float hex for exactness)
const head = [];
for (let i = 0; i < 12 * 3; i++) head.push(smoke.origin[i]);
const headParam = [];
for (let i = 0; i < 8 * 4; i++) headParam.push(smoke.param[i]);

// --- atlas --------------------------------------------------------------------------------------
const atlas = makeSmokeAtlas(seed, 128, 4, 4, 1);
const W = 512, H = 512;
const px = atlas.texture.image.data;
let atlasSum = 0, atlasR = 0, atlasG = 0, atlasB = 0, atlasA = 0;
for (let i = 0; i < W * H * 4; i += 4) {
  atlasR += px[i]; atlasG += px[i + 1]; atlasB += px[i + 2]; atlasA += px[i + 3];
  atlasSum += px[i] + px[i + 1] + px[i + 2] + px[i + 3];
}
const atlasHead = [];
for (let i = 0; i < 16; i++) atlasHead.push(px[i]);

// --- emit ---------------------------------------------------------------------------------------
const f = (v) => {
  if (!Number.isFinite(v)) return 'NaN';
  return Number(v).toFixed(9);
};
const out = `package com.fablecities.android.worldgen

/**
 * Goldens produced by tools/probe_smoke.mjs running the REAL web SmokeSystem.build +
 * makeSmokeAtlas in Node (seed 1337, the rebuild rng stream makeRng(1337 ^ 0x3ffec7)).
 */
object SmokeGoldens {
    val kindCounts = listOf(${countsFor.join(', ')})
    const val count = ${count}
    val sumOrigin = ${f(sumN(smoke.origin, nOrigin))}
    val sumVel = ${f(sumN(smoke.vel, nVel))}
    val sumParam = ${f(sumN(smoke.param, nParam))}
    val sumStyle = ${f(sumN(smoke.style, nStyle))}
    val sumColor = ${f(sumN(smoke.color, nColor))}
    val sumKind = ${f(sumN(smoke.kind, nKind))}
    val headOrigin = listOf(${head.map(f).join(', ')})
    val headParam = listOf(${headParam.map(f).join(', ')})
    const val atlasR = ${atlasR}
    const val atlasG = ${atlasG}
    const val atlasB = ${atlasB}
    const val atlasA = ${atlasA}
    const val atlasSum = ${atlasSum}
    val atlasHead = listOf(${atlasHead.join(', ')})
}
`;
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/SmokeGoldens.kt', import.meta.url), out);
console.log(`count=$count kindCounts=${countsFor.join(',')} atlasSum=$atlasSum`);
