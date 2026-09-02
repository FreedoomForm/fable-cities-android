#!/usr/bin/env node
/**
 * Download a CC0 PBR texture set from ambientCG into public/assets/ambientcg/<id>/.
 *   node tools/assets/ambientcg.mjs Asphalt012 [1K|2K] [JPG|PNG]
 * Browse: https://ambientcg.com/list?type=Material   (ids like Grass004, Asphalt012, Concrete034, RoofingTiles003, Facade018, Bricks075)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const [id, res = '1K', fmt = 'JPG'] = process.argv.slice(2);
if (!id) { console.error('usage: ambientcg.mjs <AssetId> [1K] [JPG]'); process.exit(1); }
const outDir = path.join('public/assets/ambientcg', id);
fs.mkdirSync(outDir, { recursive: true });
const zipName = `${id}_${res}-${fmt}.zip`;
const zipPath = path.join(outDir, zipName);
const url = `https://ambientcg.com/get?file=${zipName}`;
const r = await fetch(url, { headers: { 'User-Agent': 'fable-cities-asset-fetcher' } });
if (!r.ok) throw new Error(`download failed ${url}: ${r.status}`);
fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
execSync(`unzip -o -q "${zipPath}" -d "${outDir}"`);
fs.unlinkSync(zipPath);
const filesOut = fs.readdirSync(outDir);
fs.writeFileSync(path.join(outDir, 'info.json'), JSON.stringify({ id, res, fmt, license: 'CC0', source: `https://ambientcg.com/view?id=${id}`, files: filesOut }, null, 2));
fs.appendFileSync('public/assets/CREDITS.md', `- ambientCG: ${id} — CC0 — https://ambientcg.com/view?id=${id}\n`);
console.log('done:', outDir, filesOut.join(', '));
