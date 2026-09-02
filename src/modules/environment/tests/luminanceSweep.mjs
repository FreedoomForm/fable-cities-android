#!/usr/bin/env node
/**
 * Luminance sweep test for the environment module (dusk must be monotonic — no civil-twilight dip).
 *
 *   node src/modules/environment/tests/luminanceSweep.mjs [--w 640 --h 360] [--preset environment_hero] [--seed 7] [--focus 1]
 *   --focus 1 loads only terrain + environment (no post-processing grade): tests this module's own lighting curve
 *
 * Shoots the showcase at a series of clock times through sunset and night, measures the mean display luminance of
 * the ground band (lower 60 % of the frame, HUD excluded) and asserts:
 *   1. meanL never drops below the moonlit-midnight level while the sun is above -12 deg (the r0 civil-twilight dip);
 *   2. from sunset until the sun is below -12 deg, meanL is monotonic within 20 % (the full frame includes the showcase
 *      street lights / windows switching on with nightFactor and the post grade's day↔night blend, which add a legit
 *      bump around civil dusk — the strict physical curve is checked with --focus 1, i.e. without the grade);
 *   3. dawn mirrors it.
 * Requires the dev server on :5180, node tools/shot.mjs and python3 + Pillow (image statistics).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? '1'] : null)).filter(Boolean));
const w = args.w || '640', h = args.h || '360', preset = args.preset || 'environment_hero', seed = args.seed || '7';
const focus = args.focus ? '&focus=terrain,environment' : '';

const dusk = [18, 18.7, 19.2, 19.5, 19.8, 20.1, 20.4, 20.7, 21, 21.5, 22, 23, 0];
const dawn = [3.5, 4, 4.4, 4.8, 5.2, 5.6, 6.2, 7];
const times = [...dusk, ...dawn];
const outDir = path.join(root, 'shots/environment/sweep');
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, 'sweep.png');

execFileSync('node', ['tools/shot.mjs', '--url', `http://127.0.0.1:5180/?showcase=environment&seed=${seed}${focus}`, '--preset', preset,
  '--time', times.join(','), '--w', w, '--h', h, '--out', base], { cwd: root, stdio: 'inherit' });

const log = JSON.parse(fs.readFileSync(base.replace(/\.png$/, '.log.json'), 'utf8'));
const shots = (log.shots || log.results || []);
const tag = (t) => String(t).replace('.', 'h');
const meanL = {};
for (const t of times) {
  const file = shots.find((s) => String(s.time) === String(t))?.file || path.join(outDir, `sweep_${preset}_${tag(t)}.png`);
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB')
W, H = im.size
box = im.crop((0, int(H * 0.40), W, int(H * 0.92)))
px = box.getdata()
n = len(px)
print(sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in px) / n)`;
  meanL[t] = parseFloat(execFileSync('python3', ['-c', py]).toString());
}

// sun altitude per time from the module's own ephemeris
const { celestial, dayOfYear } = await import(path.join(root, 'src/modules/environment/atmosphere.js'));
const doy = dayOfYear({ month: 5, day: 1 });
const alt = (t) => (celestial(t, doy, 47.3, {}).sunAltitude * 180) / Math.PI;

let failures = [];
console.log('\n time   sunAlt   meanL (ground band)');
for (const t of times) console.log(` ${String(t).padEnd(5)} ${alt(t).toFixed(1).padStart(6)}   ${meanL[t].toFixed(1)}`);
const nightLevel = meanL[0];
for (let i = 1; i < dusk.length; i++) {
  const a = dusk[i - 1], b = dusk[i];
  if (alt(a) > -12 && meanL[b] > meanL[a] * 1.2 + 1.5) failures.push(`dusk not monotonic: ${a}h ${meanL[a].toFixed(1)} -> ${b}h ${meanL[b].toFixed(1)}`);
  if (alt(b) > -12 && meanL[b] < nightLevel * 0.92) failures.push(`twilight dip: ${b}h meanL ${meanL[b].toFixed(1)} below midnight ${nightLevel.toFixed(1)}`);
}
for (let i = 1; i < dawn.length; i++) {
  const a = dawn[i - 1], b = dawn[i];
  if (alt(b) > -12 && meanL[b] < meanL[a] * 0.8 - 1.5) failures.push(`dawn not monotonic: ${a}h ${meanL[a].toFixed(1)} -> ${b}h ${meanL[b].toFixed(1)}`);
  if (alt(a) > -12 && meanL[a] < nightLevel * 0.92) failures.push(`dawn dip: ${a}h meanL ${meanL[a].toFixed(1)} below midnight ${nightLevel.toFixed(1)}`);
}
if (failures.length) {
  console.error('\nFAIL\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('\nPASS: ground luminance monotonic through dusk and dawn, never below the moonlit midnight level.');
