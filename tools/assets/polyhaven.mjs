#!/usr/bin/env node
/**
 * Download a CC0 asset from Poly Haven into public/assets/polyhaven/<id>/.
 *   node tools/assets/polyhaven.mjs <asset_id> [--res 1k|2k|4k] [--fmt jpg|png|hdr|exr|gltf]
 * Examples:
 *   node tools/assets/polyhaven.mjs kloofendal_48d_partly_cloudy_puresky --res 2k --fmt hdr
 *   node tools/assets/polyhaven.mjs aerial_asphalt_01 --res 1k --fmt jpg
 *   node tools/assets/polyhaven.mjs street_lamp_01 --res 1k --fmt gltf
 * Search: curl -s "https://api.polyhaven.com/assets?t=models" | node -e "..."  (type: hdris | textures | models)
 */
import fs from 'node:fs';
import path from 'node:path';

const [id, ...rest] = process.argv.slice(2);
if (!id) { console.error('usage: polyhaven.mjs <asset_id> [--res 1k] [--fmt jpg]'); process.exit(1); }
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, '')] = rest[i + 1];
const res = opts.res || '1k';
const outDir = path.join('public/assets/polyhaven', id);
fs.mkdirSync(outDir, { recursive: true });

const info = await (await fetch(`https://api.polyhaven.com/info/${id}`)).json();
const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
const type = ['hdris', 'textures', 'models'][info.type] || 'unknown';
const fmt = opts.fmt || (type === 'hdris' ? 'hdr' : type === 'models' ? 'gltf' : 'jpg');
const downloads = [];

if (type === 'hdris') {
  const entry = files.hdri?.[res]?.[fmt];
  if (!entry) throw new Error(`no hdri ${res} ${fmt}; available: ${Object.keys(files.hdri || {}).join(',')}`);
  downloads.push([entry.url, `${id}_${res}.${fmt}`]);
} else if (type === 'textures') {
  for (const [mapName, resolutions] of Object.entries(files)) {
    if (typeof resolutions !== 'object' || !resolutions[res]) continue;
    const entry = resolutions[res][fmt] || resolutions[res].png || resolutions[res].jpg;
    if (!entry?.url) continue;
    downloads.push([entry.url, `${mapName}.${entry.url.split('.').pop()}`]);
  }
} else if (type === 'models') {
  const entry = files.gltf?.[res]?.gltf;
  if (!entry) throw new Error(`no gltf ${res}; available: ${Object.keys(files.gltf || {}).join(',')}`);
  downloads.push([entry.url, path.basename(entry.url)]);
  for (const [rel, inc] of Object.entries(entry.include || {})) downloads.push([inc.url, rel]);
}

for (const [url, rel] of downloads) {
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) { console.log('exists', dest); continue; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${url}: ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log('saved', dest, `${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}
fs.writeFileSync(path.join(outDir, 'info.json'), JSON.stringify({ id, name: info.name, type, authors: info.authors, license: 'CC0', source: `https://polyhaven.com/a/${id}`, res, fmt }, null, 2));
fs.appendFileSync('public/assets/CREDITS.md', `- Poly Haven: ${info.name} (${id}) — CC0 — https://polyhaven.com/a/${id}\n`);
console.log(`done: ${type} ${id} → ${outDir}`);
