#!/usr/bin/env node
/**
 * Material response audit. Dumps every PBR material in the live scene with its specular-relevant
 * parameters, so "materials look flat" becomes a number you can check.
 *
 *   node tools/matstats.mjs                      # summary + worst offenders
 *   node tools/matstats.mjs --all                # every material
 *   node tools/matstats.mjs --filter glass       # only materials whose name matches
 *   node tools/matstats.mjs --url "http://127.0.0.1:5180/?seed=7&time=17.5&headless=1"   (headless=1 skips the start screen)
 *
 * Compare the output against docs/MATERIAL_TARGET.md.
 */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Resolve a Chrome/Chromium binary across platforms; override with CHROME_PATH. */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fs = require('node:fs');
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ } }
  throw new Error('No Chrome/Chromium found. Install Google Chrome or set CHROME_PATH to its executable.');
}


const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const url = flag('url', 'http://127.0.0.1:5180/?seed=7&time=17.5&headless=1');
const filter = flag('filter', null);
const showAll = argv.includes('--all');

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: true, defaultViewport: { width: 1280, height: 720 },
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 150000 });
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 150000, polling: 200 });
  await page.evaluate(() => window.__game.waitStable(60));
  const data = await page.evaluate(() => {
    const s = window.__game.scene, e = window.__game.engine, seen = new Set(), list = [];
    s.traverse((o) => {
      const m = o.material; if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((mm) => {
        if (seen.has(mm.uuid) || !(mm.isMeshStandardMaterial || mm.isMeshPhysicalMaterial)) return;
        seen.add(mm.uuid);
        list.push({
          name: mm.name || mm.type,
          roughness: mm.roughness, metalness: mm.metalness,
          envMapIntensity: mm.envMapIntensity,
          clearcoat: mm.clearcoat ?? 0, clearcoatRoughness: mm.clearcoatRoughness ?? 0,
          hasRoughnessMap: !!mm.roughnessMap, hasNormalMap: !!mm.normalMap, hasMap: !!mm.map,
          transmission: mm.transmission ?? 0, ior: mm.ior ?? 1.5, opacity: mm.opacity,
        });
      });
    });
    return {
      scene: {
        environmentSet: !!s.environment, environmentIntensity: s.environmentIntensity,
        exposure: e.renderer.toneMappingExposure, hemisphereIntensity: e.hemi && e.hemi.intensity,
        sunIntensity: e.sunIntensity,
      },
      materials: list,
    };
  });

  const mats = filter ? data.materials.filter((m) => new RegExp(filter, 'i').test(m.name)) : data.materials;
  const rough = mats.map((m) => m.roughness).filter((r) => typeof r === 'number').sort((a, b) => a - b);
  const pct = (p) => rough.length ? rough[Math.min(rough.length - 1, Math.floor(rough.length * p))] : NaN;
  const bucket = (lo, hi) => rough.filter((r) => r >= lo && r < hi).length;

  console.log('scene:', JSON.stringify(data.scene));
  console.log(`materials: ${mats.length}  ·  roughness p10 ${pct(0.1)?.toFixed(2)}  median ${pct(0.5)?.toFixed(2)}  p90 ${pct(0.9)?.toFixed(2)}`);
  console.log(`roughness buckets:  <0.2 (mirror/glass): ${bucket(0, 0.2)}   0.2-0.4 (paint/wet): ${bucket(0.2, 0.4)}   0.4-0.7 (semi-gloss): ${bucket(0.4, 0.7)}   >=0.7 (matte): ${bucket(0.7, 1.01)}`);
  console.log(`with roughnessMap: ${mats.filter((m) => m.hasRoughnessMap).length}   with normalMap: ${mats.filter((m) => m.hasNormalMap).length}   with clearcoat>0: ${mats.filter((m) => m.clearcoat > 0).length}   metalness>0.5: ${mats.filter((m) => m.metalness > 0.5).length}`);
  const rows = showAll ? mats : mats.filter((m) => /glass|window|pane|paint|body|car|veh|asphalt|road|water|metal|chrome/i.test(m.name)).slice(0, 40);
  if (rows.length) {
    console.log('\nname                            rough  metal   env  coat  rMap nMap');
    for (const m of rows) {
      console.log(`${m.name.slice(0, 30).padEnd(30)} ${String(m.roughness?.toFixed(2)).padStart(5)} ${String(m.metalness?.toFixed(2)).padStart(6)} ${String(m.envMapIntensity?.toFixed(2)).padStart(5)} ${String(m.clearcoat?.toFixed(2)).padStart(5)}  ${m.hasRoughnessMap ? ' y' : ' .'}   ${m.hasNormalMap ? 'y' : '.'}`);
    }
  }
} catch (err) {
  console.error('matstats failed:', err && err.message || err);
  process.exitCode = 1;
} finally { await browser.close(); }
