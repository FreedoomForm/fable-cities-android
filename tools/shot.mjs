#!/usr/bin/env node
/**
 * Screenshot tool for visual verification.
 *
 *   node tools/shot.mjs --out shots/terrain/a.png                       # default city preset, current defaults
 *   node tools/shot.mjs --out shots/x.png --preset city,street --time 14,20.5
 *   node tools/shot.mjs --url "http://127.0.0.1:5180/?seed=7&quality=ultra" --preset aerial --out shots/y.png
 *   node tools/shot.mjs --eval "__game.setTool('zone')" --out shots/z.png
 *
 * Options: --w 1920 --h 1080 --frames 60 --timeout 120000 --headed --quality high --weather rain --demo 0
 *          --view '{"target":{"x":100,"z":-50},"distance":120,"yaw":0.5,"pitch":0.3}'  (raw camera view)
 * Writes <out>.log.json with console errors, GPU renderer string, stats and module status.
 * Multiple presets/times produce <out-basename>_<preset>_<time>.png
 */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';

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


const args = parseArgs(process.argv.slice(2));
const CHROME = resolveChrome();
const width = +args.w || 1920;
const height = +args.h || 1080;
const frames = +args.frames || 60;
const timeout = +args.timeout || 150000;
const out = args.out || 'shots/shot.png';
const presets = String(args.preset || args.cam || '').split(',').filter(Boolean);
const times = String(args.time ?? '').split(',').filter(Boolean);
const headed = args.headed === true || args.headed === '1';

const url = new URL(args.url || 'http://127.0.0.1:5180/');
if (!url.searchParams.has('headless')) url.searchParams.set('headless', '1');
for (const k of ['quality', 'weather', 'demo', 'seed', 'focus', 'map']) if (args[k] != null) url.searchParams.set(k, String(args[k]));
if (presets[0]) url.searchParams.set('cam', presets[0]);
if (times[0]) url.searchParams.set('time', times[0]);

fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  protocolTimeout: timeout,
  executablePath: CHROME,
  headless: !headed,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: [
    `--window-size=${width},${height + 90}`,
    `--use-angle=${process.platform === 'darwin' ? 'metal' : (process.env.CHOOSE_ANGLE || 'swiftshader')}`,
    '--ignore-gpu-blocklist',
    // '--enable-gpu-rasterization' removed (p7): under SwiftShader the raster cache doubles GPU
    // memory and the renderer OOM-crashes ("Target closed") on street-level presets; check.mjs
    // never passes it and boots the same scenes reliably.
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    ...(headed ? ['--window-position=0,0'] : []),
  ],
});

const logs = [];
const results = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e) }));
  page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}` }));

  // Retry once: a Vite full reload (another builder saving) destroys the execution context mid-wait.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout });
      await page.setDefaultTimeout(timeout); page.waitForFunction('window.__game && window.__game.ready === true', { timeout, polling: 500 });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`load attempt ${attempt} failed (${String(err && err.message).slice(0, 80)}), retrying…`);
      logs.length = 0;
    }
  }
  // A vite full reload (config/HMR rollback) re-boots the page AFTER the ready gate resolved, and
  // every screenshot then comes out as a 'LOADING …' overlay. Re-check, right here, that the page
  // is booted: ready flag AND the loading overlay actually hidden.
  await page.waitForFunction(
    'window.__game && window.__game.ready === true && (!document.getElementById("loading") || document.getElementById("loading").classList.contains("hidden"))',
    { timeout, polling: 500 },
  );
  const gpu = await page.evaluate(() => {
    try {
      const gl = window.__game.engine.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { return 'unknown: ' + e; }
  });

  if (args.eval) await page.evaluate(String(args.eval));
  if (args.probe) {
    // --probe "<js expression>" → evaluate after the ready gate and record the JSON result in the
    // log (the console arrays only carry warnings/errors, so info-level dumps never persisted).
    let probe = null, probeErr = null;
    try { probe = await page.evaluate(String(args.probe)); } catch (e) { probeErr = String(e && e.message || e); }
    var probeResult = { probe, probeErr };
  }
  if (args.view) {
    await page.evaluate((v) => window.__game.setCamera(JSON.parse(v), true), String(args.view));
  }

  const combos = [];
  const ps = presets.length ? presets : [null];
  const ts = times.length ? times : [null];
  for (const p of ps) for (const t of ts) combos.push({ preset: p, time: t });
  const multi = combos.length > 1;
  const ext = path.extname(out) || '.png';
  const base = out.slice(0, out.length - (path.extname(out) ? ext.length : 0));

  for (const combo of combos) {
    // per-shot re-gate: if the page reloaded mid-run, wait out the re-boot instead of shooting it
    await page.waitForFunction(
      'window.__game && window.__game.ready === true && (!document.getElementById("loading") || document.getElementById("loading").classList.contains("hidden"))',
      { timeout, polling: 500 },
    );
    if (combo.preset) await page.evaluate((p) => window.__game.setCamera(p, true), combo.preset);
    if (combo.time != null) await page.evaluate((t) => window.__game.setTime(parseFloat(t)), combo.time);
    // Poll the frame counter with short evaluates — one long waitStable evaluate trips the
    // ~180s puppeteer protocol timeout under software rendering.
    const startFrame = await page.evaluate(() => (window.__game && window.__game.engine) ? window.__game.engine.frame : -1);
    if (startFrame >= 0) {
      const deadline = Date.now() + timeout;
      let cur = startFrame;
      while (Date.now() < deadline && cur - startFrame < frames) {
        await new Promise((r) => setTimeout(r, 2000));
        cur = await page.evaluate(() => window.__game.engine.frame);
      }
    } else {
      await page.evaluate((f) => window.__game.waitStable(f), frames);
    }
    const file = multi ? `${base}${combo.preset ? '_' + combo.preset : ''}${combo.time != null ? '_' + String(combo.time).replace('.', 'h') : ''}${ext}` : out;
    await page.screenshot({ path: file, type: ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png' });
    const stats = await page.evaluate(() => window.__game.stats());
    results.push({ file, preset: combo.preset, time: combo.time, stats });
    console.log(`shot: ${file}  fps~${stats.fpsEstimate} cpu ${stats.cpuFrameMs}ms  calls ${stats.drawCalls}  tris ${stats.triangles}  errors ${stats.errors.length}`);
  }

  const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror' || l.type === 'requestfailed');
  const warnings = logs.filter((l) => l.type === 'warning' || l.type === 'warn');
  const moduleStatus = await page.evaluate(() => window.__game.moduleStatus);
  const summary = await page.evaluate(() => window.__game.sceneSummary());
  const report = { url: url.toString(), gpu, moduleStatus, results, errors, warningCount: warnings.length, warnings: warnings.slice(0, 20), sceneSummary: summary };
  if (typeof probeResult !== 'undefined') report.probe = probeResult;
  fs.writeFileSync(`${base}.log.json`, JSON.stringify(report, null, 2));
  console.log(`gpu: ${gpu}`);
  const failed = Object.entries(moduleStatus).filter(([, s]) => !s.ok).map(([n]) => n);
  if (failed.length) console.log(`FAILED MODULES: ${failed.join(', ')}`);
  if (errors.length) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 12)) console.log('  - ' + e.text.slice(0, 400));
  } else console.log('no console errors');
  console.log(`log: ${base}.log.json`);
} catch (err) {
  console.error('shot failed:', err && err.message || err);
  const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
  for (const e of errors.slice(0, 12)) console.error('  - ' + e.text.slice(0, 400));
  process.exitCode = 1;
} finally {
  await browser.close();
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
      else o[a.slice(2)] = true;
    }
  }
  return o;
}
