// Vegetation golden probe — drives the REAL web Vegetation class placement in Node and emits
// android/app/src/test/java/com/fablecities/android/worldgen/VegetationGoldens.kt
//
// The placement half of Vegetation.js (_distribute / _worley / _clump / canopyCoverage) is pure
// CPU: it never touches geometry, materials or GL. So the probe builds a BARE instance via
// Object.create(Vegetation.prototype), feeds it the REAL heightmap, REAL GroundControl rules and
// the REAL groundInfo closure (terrain/index.js), and runs the actual _distribute with the real
// RNG chain (makeRng(hash2(1337, 777)), cluster noise hash2(1337, 909), clump seed hash2(1337, 5151)).
// Quality is the engine default 'high' → density 1.0.
import { writeFileSync } from 'node:fs';
import { Heightmap } from '../src/modules/terrain/Heightmap.js';
import { makeGroundControl } from '../src/modules/terrain/GroundControl.js';
import { Vegetation } from '../src/modules/terrain/Vegetation.js';
import { makeRng, hash2 } from '../src/shared/random.js';
import { clamp, smoothstep, lerp } from '../src/shared/math.js';
import { SimplexNoise } from '../src/shared/noise.js';

const SEED = 1337;
const RES = 512;
const hm = new Heightmap({ size: 2048, spacing: 4, seed: SEED }).generate();
const ground = makeGroundControl(hm, SEED);
const shoreData = hm.computeShoreDistance();
const N = hm.N, half = hm.half, sp = hm.spacing;
const shoreAt = (x, z) => {
  const i = clamp(Math.round((x + half) / sp), 0, N - 1);
  const j = clamp(Math.round((z + half) / sp), 0, N - 1);
  return (shoreData[j * N + i] - 128) * 0.25;
};

// bake ctrl/ctrl2 exactly like terrain/index.js (BEFORE the canopy overwrite — groundInfo reads
// the initial forest channel)
const ctrlStep = hm.size / RES;
const ctrlData = new Uint8Array(RES * RES * 4);
const ctrl2Data = new Uint8Array(RES * RES * 4);
for (let j = 0; j < RES; j++) {
  const z = -half + (j + 0.5) * ctrlStep;
  for (let i = 0; i < RES; i++) {
    const x = -half + (i + 0.5) * ctrlStep;
    const k = (j * RES + i) * 4;
    const h = hm.getHeight(x, z);
    const slope = hm.getSlope(x, z);
    const c = ground.controlAt(x, z, h, slope, shoreAt(x, z));
    ctrlData[k] = 255 * c.dry; ctrlData[k + 1] = 255 * c.dirt; ctrlData[k + 2] = 255 * c.sand; ctrlData[k + 3] = 255 * c.rock;
    ctrl2Data[k] = 255 * c.forest; ctrl2Data[k + 1] = 255 * clamp(c.field, 0, 1); ctrl2Data[k + 2] = 0;
    const e = 8;
    const lap = (hm.getHeight(x + e, z) + hm.getHeight(x - e, z) + hm.getHeight(x, z + e) + hm.getHeight(x, z - e) - 4 * h) / (e * e);
    ctrl2Data[k + 3] = 255 * clamp(0.5 - lap * 45, 0.05, 0.95);
  }
}

// the terrain/index.js groundInfo closure over the control maps
const groundInfo = (x, z) => {
  const i = clamp(Math.floor((x + half) / ctrlStep), 0, RES - 1), j = clamp(Math.floor((z + half) / ctrlStep), 0, RES - 1);
  const k = (j * RES + i) * 4;
  const h = hm.getHeight(x, z), slope = hm.getSlope(x, z);
  const dry = ctrlData[k] / 255, dirt = ctrlData[k + 1] / 255, sand0 = ctrlData[k + 2] / 255, rockB = ctrlData[k + 3] / 255, forest = ctrl2Data[k] / 255;
  const hA = h - hm.waterLevel;
  const shoreD = shoreAt(x, z);
  const highland = smoothstep(14, 42, hA);
  const cut = smoothstep(0.24, 0.40, slope) * (1 - highland);
  const rockSlope = smoothstep(0.19, 0.40, slope);
  const rock = Math.max(rockSlope * lerp(0.62, 1, highland), rockB * smoothstep(0.06, 0.2, slope + rockB * 0.3), cut * 0.7);
  const dirtW = Math.max(dirt, cut * 0.45 + smoothstep(0.12, 0.24, slope) * (1 - rockSlope) * 0.28);
  const wet = (1 - smoothstep(0.3, 2.0, shoreD)) * smoothstep(-6, -1, shoreD);
  const sandW = Math.max(sand0, smoothstep(0.2, -1.6, shoreD) * 0.6) * (1 - smoothstep(0.10, 0.22, slope));
  const rest = Math.max(0, 1 - wet * 0.55 - sandW * (1 - wet) - rock * (1 - wet - sandW * (1 - wet)));
  return { h, slope, grass: rest * (1 - dirtW) * (1 - dry * 0.4), dry: rest * dry, dirt: rest * dirtW, sand: sandW, rock, wet, forest, shoreD };
};

// ---- the REAL placement on a bare instance ----------------------------------------------------
// kind crown widths (canopyCoverage only): shared pinned constants (see worldgen/Vegetation.kt)
const KIND_WIDTHS = [9.2, 8.4, 10.0, 9.6, 9.0, 9.4, 5.6, 5.0, 6.4];
const veg = Object.create(Vegetation.prototype);
Object.assign(veg, {
  hm, seed: SEED, half, quality: { density: 1.0 },
  forestMask: (x, z, h, slope) => ground.forestMask(x, z, h, slope),
  groundInfo,
  clumpSeed: hash2(SEED, 5151),
  clusterNoise: new SimplexNoise(hash2(SEED, 909)), // exactly what the constructor builds
  kindsBySpecies: [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
  kinds: KIND_WIDTHS.map((w) => ({ lod0: { width: w } })),
  trees: [], treeCount: 0, cell: 32, grid: new Map(),
});

const t0 = performance.now();
veg._distribute(makeRng(hash2(SEED, 777)));
const ms = performance.now() - t0;
console.log('trees:', veg.treeCount, 'in', ms.toFixed(0), 'ms');

const canopy = veg.canopyCoverage(RES);
const trees = veg.trees;

// ---- goldens ----------------------------------------------------------------------------------
const ds = (v) => {
  let s = String(v);
  if (s === '-0') s = '0.0';
  if (!s.includes('.') && !s.includes('e') && !s.includes('Infinity')) s += '.0';
  return s;
};
const f = (v) => {
  let s = String(v);
  if (s === '-0') s = '0.0';
  if (!s.includes('.') && !s.includes('e') && !s.includes('Infinity')) s += '.0';
  return s;
};
const inMap = trees.filter((t) => !t.horizon);
const horizon = trees.filter((t) => t.horizon);
const treeProbes = trees.slice(0, 40).map((t) => [t.x, t.y, t.z, t.sxz, t.sy, t.yaw, t.kind, t.species, t.horizon ? 1 : 0, t.r, t.g, t.b]);
// deterministic weighted checksums over ALL trees
let chk = 0;
for (let i = 0; i < trees.length; i++) {
  const t = trees[i];
  chk = (chk + (t.x * 1.13 + t.y * 2.07 + t.z * 3.11 + t.sxz * 4.07 + t.sy * 5.09 + t.yaw * 6.01 + t.r * 7.03 + t.g * 8.01 + t.b * 9.77) * (i % 89 + 1)) % 4294967296;
}
let kindCount = new Array(9).fill(0);
for (const t of trees) kindCount[t.kind]++;
let canopySum = 0, canopyW = 0;
for (let i = 0; i < canopy.length; i++) { canopySum += canopy[i]; canopyW += canopy[i] * (i % 61 + 1); }
let canopyProbes = [];
for (const k of [3, 130, 1000, 4093, 12000, 65536, 131071, 200000, 262143]) canopyProbes.push(f(canopy[k]));

const kotlin = `// GENERATED by tools/probe_vegetation.mjs — golden values from the REAL web Vegetation.js
// placement (_distribute/_worley/_clump/canopyCoverage on a bare prototype instance with the
// real heightmap + GroundControl + groundInfo, seed 1337, quality high density 1.0). Do not edit.
package com.fablecities.android.worldgen

object VegetationGoldens {
    const val treeCount = ${trees.length}
    const val inMapCount = ${inMap.length}
    const val horizonCount = ${horizon.length}
    val kindCounts = listOf(${kindCount.join(', ')})
    const val treeChk = ${chk}
    /** first 40 trees: x, y, z, sxz, sy, yaw, kind, species, horizon, r, g, b */
    val treeProbes = listOf(
${treeProbes.map((p) => '        listOf(' + p.map(ds).join(', ') + ')').join(',\n')},
    )
    const val canopySum = ${f(canopySum)}
    const val canopyWeighted = ${f(canopyW)}
    val canopyProbes = listOf(${canopyProbes.join(', ')})
}
`;
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/VegetationGoldens.kt', import.meta.url), kotlin);
console.log('VegetationGoldens.kt written');
console.log(JSON.stringify({ treeCount: trees.length, inMap: inMap.length, horizon: horizon.length, kindCount, chk, canopySum }, null, 1));
