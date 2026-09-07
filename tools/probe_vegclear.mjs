// Vegetation clearing + undergrowth golden probe — drives the REAL web Vegetation.js
// (clearRect / clearCircle / clearOriented / clearPolyline / isCleared + _updateUndergrowth)
// on a bare prototype instance over the real heightmap + control maps, and emits
// android/app/src/test/java/com/fablecities/android/worldgen/VegClearGoldens.kt
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
// groundTint with the default layer means (the JPEGs are not decoded in Node; the Kotlin test
// reproduces this with the same 0.5 defaults — the production renderer feeds the REAL avgs)
const LAYER_TINT = [[0.46, 0.55, 0.40], [0.50, 0.51, 0.38], [0.55, 0.49, 0.38], [0.90, 0.88, 0.90], [0.51, 0.47, 0.38], [0.52, 0.48, 0.40], [0.90, 0.88, 0.90], [0.32, 0.30, 0.22]];
const AVG = Array.from({ length: 8 }, () => [0.5, 0.5, 0.5]);
const groundTint = (x, z, out = [0, 0, 0]) => {
  const g = groundInfo(x, z);
  const w = [g.grass, g.dry, g.dirt, g.rock, g.sand, g.wet * 0.35, 0, g.forest * 0.5 * g.grass];
  let sw = 0; out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < 8; i++) {
    const wi = w[i]; if (wi <= 0.001) continue;
    const a = AVG[i], t = LAYER_TINT[i];
    out[0] += wi * a[0] * t[0]; out[1] += wi * a[1] * t[1]; out[2] += wi * a[2] * t[2]; sw += wi;
  }
  if (sw > 0) { out[0] /= sw; out[1] /= sw; out[2] /= sw; } else { out[0] = 0.3; out[1] = 0.38; out[2] = 0.18; }
  return out;
};

const KIND_WIDTHS = [9.2, 8.4, 10.0, 9.6, 9.0, 9.4, 5.6, 5.0, 6.4];
const veg = Object.create(Vegetation.prototype);
const CAP = 52000;
const grass = {
  mesh: {
    count: 0,
    instanceMatrix: { array: new Float32Array(CAP * 16) },
    instanceColor: { array: new Float32Array(CAP * 3) },
  },
  varAttr: { array: new Float32Array(CAP) },
  uniforms: { uGrassCenter: { value: { set(x, z) { this.x = x; this.z = z; } } } },
  lastCenter: { x: 1e9, y: 1e9, set(x, z) { this.x = x; this.y = z; } },
  cap: CAP,
};
Object.assign(veg, {
  hm, seed: SEED, half, quality: { density: 1.0 },
  forestMask: (x, z, h, slope) => ground.forestMask(x, z, h, slope),
  groundInfo, groundTint, isBlocked: null,
  clumpSeed: hash2(SEED, 5151),
  clusterNoise: new SimplexNoise(hash2(SEED, 909)),
  kindsBySpecies: [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
  kinds: KIND_WIDTHS.map((w) => ({ lod0: { width: w } })),
  trees: [], treeCount: 0, cell: 32, grid: new Map(),
  maskCell: 4, maskN: Math.ceil((half * 2) / 4), clearMask: new Uint8Array(Math.ceil((half * 2) / 4) ** 2),
  grassRadius: 64,
  grass,
});
veg._distribute(makeRng(hash2(SEED, 777)));
const treeTotal = veg.treeCount;
const inMapTrees = veg.trees.filter((t) => !t.horizon);
if (inMapTrees.length < 5000) { console.error('not enough trees'); process.exit(1); }

// ---- the clearing sequence — anchored on REAL tree positions so every op kills trees ----------
const at = (i) => ({ x: inMapTrees[i].x, z: inMapTrees[i].z });
const A = at(1000), B = at(2000), C = at(3000), D = at(4000), E = at(4400);
const nRect = veg.clearRect(A.x - 50, A.z - 40, A.x + 50, A.z + 40);
const nCircle = veg.clearCircle(B.x, B.z, 30);
const nOriented = veg.clearOriented(C.x, C.z, 20, 14, 0.7, 1.5);
const nPoly = veg.clearPolyline([{ x: D.x, z: D.z }, { x: (D.x + E.x) / 2, z: (D.z + E.z) / 2 }, { x: E.x, z: E.z }], 24);
let maskSum = 0, maskW = 0;
for (let i = 0; i < veg.clearMask.length; i++) { maskSum += veg.clearMask[i]; maskW += veg.clearMask[i] * (i % 97 + 1); }
const aliveAfter = veg.aliveCount();
const clearedProbe = [[A.x, A.z], [B.x, B.z], [C.x, C.z], [D.x, D.z], [E.x, E.z], [(D.x + E.x) / 2, (D.z + E.z) / 2]].map(([x, z]) => veg.isCleared(x, z) ? 1 : 0);

// ---- undergrowth patch 1: camera over the cleared oriented footprint (exclusion proof) ---------
const CAM = { x: C.x - 40, y: 42, z: C.z - 40 };
const DIR = { x: 0.57735, y: -0.57735, z: 0.57735 };
const camStub = {
  position: { x: CAM.x, y: CAM.y, z: CAM.z },
  getWorldDirection(v) { v.set(DIR.x, DIR.y, DIR.z); return v; },
};
veg._undergrowthDirty = true;
veg._updateUndergrowth(camStub, true);
const ugCount = grass.mesh.count;
const ugArr = grass.mesh.instanceMatrix.array;
const ugCol = grass.mesh.instanceColor.array;
const ugVars = grass.varAttr.array;
const fx = grass.uniforms.uGrassCenter.value.x, fz = grass.uniforms.uGrassCenter.value.z;
console.log('focus1', fx.toFixed(2), fz.toFixed(2), 'instances', ugCount);

// the web guarantee: every tuft's own 4 m mask cell is unmasked (isCleared at the tuft position
// is false) — cells that merely STRADDLE the cleared footprint still carry tufts on the site
const maskN2 = veg.maskN, h2 = veg.half;
let inCleared = 0;
for (let k = 0; k < ugCount; k++) {
  const x = ugArr[k * 16 + 12], z = ugArr[k * 16 + 14];
  const i = Math.floor((x + h2) / 4), j = Math.floor((z + h2) / 4);
  if (i >= 0 && j >= 0 && i < maskN2 && j < maskN2 && veg.clearMask[j * maskN2 + i]) inCleared++;
}
if (inCleared !== 0) { console.error('FAIL: instances inside cleared mask cells:', inCleared); process.exit(1); }

const ds = (v) => {
  let s = String(v);
  if (s === '-0') s = '0.0';
  if (!s.includes('.') && !s.includes('e') && !s.includes('Infinity')) s += '.0';
  return s;
};
// goldens: instance rows x, z, sx, sy, yaw, variant, r, g, b (yaw from the matrix columns)
const PROBE_N = Math.min(ugCount, 24);
const probes = [];
for (let k = 0; k < PROBE_N; k++) {
  const o = k * 16;
  const cs = ugArr[o], sn = ugArr[o + 8];
  const sx = Math.hypot(cs, sn);
  const yaw = Math.atan2(sn, cs);
  const sy = ugArr[o + 5];
  probes.push([ugArr[o + 12], ugArr[o + 14], sx, sy, yaw, ugVars[k], ugCol[k * 3], ugCol[k * 3 + 1], ugCol[k * 3 + 2]]);
}
let chk = 0;
for (let k = 0; k < ugCount; k++) {
  const o = k * 16;
  chk = (chk + (ugArr[o + 12] * 1.31 + ugArr[o + 14] * 2.17 + ugArr[o + 5] * 3.03 + ugVars[k] * 4.01 + ugCol[k * 3] * 5.07 + ugCol[k * 3 + 1] * 6.11 + ugCol[k * 3 + 2] * 7.02) * (k % 71 + 1)) % 4294967296;
}
let varHist = new Array(8).fill(0);
for (let k = 0; k < ugCount; k++) varHist[ugVars[k]]++;

// ---- undergrowth patch 2: fern-rich forest focus ------------------------------------------------
const CAP2 = 52000;
const grass2 = {
  mesh: {
    count: 0,
    instanceMatrix: { array: new Float32Array(CAP2 * 16) },
    instanceColor: { array: new Float32Array(CAP2 * 3) },
  },
  varAttr: { array: new Float32Array(CAP2) },
  uniforms: { uGrassCenter: { value: { set(x, z) { this.x = x; this.z = z; } } } },
  lastCenter: { x: 1e9, y: 1e9, set(x, z) { this.x = x; this.y = z; } },
  cap: CAP2,
};
const CAM2 = { x: inMapTrees[500].x, y: 42, z: inMapTrees[500].z - 60 };
const camStub2 = {
  position: { x: CAM2.x, y: CAM2.y, z: CAM2.z },
  getWorldDirection(v) { v.set(0.0, -0.70710678, 0.70710678); return v; },
};
veg.grass = grass2;
veg._undergrowthDirty = true;
veg._updateUndergrowth(camStub2, true);
const ug2Count = grass2.mesh.count;
const ug2Arr = grass2.mesh.instanceMatrix.array;
const ug2Col = grass2.mesh.instanceColor.array;
const ug2Vars = grass2.varAttr.array;
const fx2 = grass2.uniforms.uGrassCenter.value.x, fz2 = grass2.uniforms.uGrassCenter.value.z;
console.log('focus2', fx2.toFixed(2), fz2.toFixed(2), 'instances', ug2Count);
let chk2 = 0;
for (let k = 0; k < ug2Count; k++) {
  const o = k * 16;
  chk2 = (chk2 + (ug2Arr[o + 12] * 1.31 + ug2Arr[o + 14] * 2.17 + ug2Arr[o + 5] * 3.03 + ug2Vars[k] * 4.01 + ug2Col[k * 3] * 5.07 + ug2Col[k * 3 + 1] * 6.11 + ug2Col[k * 3 + 2] * 7.02) * (k % 71 + 1)) % 4294967296;
}
let varHist2 = new Array(8).fill(0);
for (let k = 0; k < ug2Count; k++) varHist2[ug2Vars[k]]++;
const PROBE2_N = Math.min(ug2Count, 24);
const probes2 = [];
for (let k = 0; k < PROBE2_N; k++) {
  const o = k * 16;
  const cs = ug2Arr[o], sn = ug2Arr[o + 8];
  const sx = Math.hypot(cs, sn);
  const yaw = Math.atan2(sn, cs);
  const sy = ug2Arr[o + 5];
  probes2.push([ug2Arr[o + 12], ug2Arr[o + 14], sx, sy, yaw, ug2Vars[k], ug2Col[k * 3], ug2Col[k * 3 + 1], ug2Col[k * 3 + 2]]);
}

const kotlin = `// GENERATED by tools/probe_vegclear.mjs — goldens from the REAL web Vegetation.js clearing ops
// (clearRect/clearCircle/clearOriented/clearPolyline/isCleared) and _updateUndergrowth (bare
// prototype instance, real heightmap + control maps + groundInfo + default layer means, seed 1337).
package com.fablecities.android.worldgen

object VegClearGoldens {
    const val treeTotal = ${treeTotal}
    const val clearedRect = ${nRect}
    const val clearedCircle = ${nCircle}
    const val clearedOriented = ${nOriented}
    const val clearedPoly = ${nPoly}
    const val maskSum = ${maskSum}
    const val maskWeighted = ${maskW}
    const val aliveAfter = ${aliveAfter}
    val clearedProbes = listOf(${clearedProbe.join(', ')})
    // undergrowth camera 1: pos (${ds(CAM.x)}, ${ds(CAM.y)}, ${ds(CAM.z)}), dir (${ds(DIR.x)}, ${ds(DIR.y)}, ${ds(DIR.z)})
    const val ugFocusX = ${ds(fx)}
    const val ugFocusZ = ${ds(fz)}
    const val ugCount = ${ugCount}
    const val ugChk = ${chk}
    val ugVarHist = listOf(${varHist.join(', ')})
    /** first ${PROBE_N} tufts: x, z, sx, sy, yaw, variant, r, g, b */
    val ugProbes = listOf(
${probes.map((p) => '        listOf(' + p.map(ds).join(', ') + ')').join(',\n')},
    )
    // undergrowth camera 2 (fern-rich forest): pos (${ds(CAM2.x)}, ${ds(CAM2.y)}, ${ds(CAM2.z)}), dir (0.0, -0.70710678, 0.70710678)
    const val ug2FocusX = ${ds(fx2)}
    const val ug2FocusZ = ${ds(fz2)}
    const val ug2Count = ${ug2Count}
    const val ug2Chk = ${chk2}
    val ug2VarHist = listOf(${varHist2.join(', ')})
    val ug2Probes = listOf(
${probes2.map((p) => '        listOf(' + p.map(ds).join(', ') + ')').join(',\n')},
    )
}
`;
writeFileSync(new URL('../android/app/src/test/java/com/fablecities/android/worldgen/VegClearGoldens.kt', import.meta.url), kotlin);
console.log('clears:', nRect, nCircle, nOriented, nPoly, 'alive', aliveAfter, 'mask', maskSum);
console.log('undergrowth:', ugCount, 'chk', chk, 'varHist', varHist.join(','));
console.log('undergrowth2:', ug2Count, 'chk2', chk2, 'varHist2', varHist2.join(','));
console.log('VegClearGoldens.kt written');
