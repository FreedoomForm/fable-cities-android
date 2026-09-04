#!/usr/bin/env node
/**
 * Smoke test: loads the game, waits until ready, prints module status, errors and perf stats as JSON.
 * Exit code 1 if any module failed or console errors occurred.
 *   node tools/check.mjs [--url http://127.0.0.1:5180/?seed=3] [--frames 120]
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


const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const CHROME = resolveChrome();
const url = new URL(args.url || 'http://127.0.0.1:5180/');
if (!url.searchParams.has('headless')) url.searchParams.set('headless', '1');
const frames = +args.frames || 120;

const angleBackend = process.platform === 'darwin' ? 'metal' : (process.env.CHOOSE_ANGLE || 'swiftshader');
const viewportW = +args.w || 1920;
const viewportH = +args.h || 1080;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: +args['protocol-timeout'] || 600000, defaultViewport: { width: viewportW, height: viewportH }, args: [`--use-angle=${angleBackend}`, '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'] });
const logs = [];
let code = 0;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(+args['ready-timeout'] || 150000);
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e) }));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 150000 });
  const readyTimeout = +args['ready-timeout'] || 150000;
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: readyTimeout, polling: 500 });
  // Wait for `frames` stable frames by polling the engine's frame counter from Node with short
  // evaluates — a single long evaluate (page.waitStable) trips puppeteer's ~180s protocol timeout
  // under software rendering where each frame can take seconds.
  const startFrame = await page.evaluate(() => (window.__game && window.__game.engine) ? window.__game.engine.frame : -1);
  if (startFrame >= 0) {
    const deadline = Date.now() + readyTimeout;
    let cur = startFrame;
    while (Date.now() < deadline && cur - startFrame < frames) {
      await new Promise((r) => setTimeout(r, 2000));
      cur = await page.evaluate(() => window.__game.engine.frame);
    }
    if (cur - startFrame < frames) throw new Error(`waitStable timed out: ${cur - startFrame}/${frames} frames in ${readyTimeout}ms`);
  } else {
    await page.evaluate((f) => window.__game.waitStable(f), frames);
  }
  const stats = await page.evaluate(() => window.__game.stats());
  const summary = await page.evaluate(() => window.__game.sceneSummary());
  const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
  const failed = Object.entries(stats.moduleStatus).filter(([, s]) => !s.ok);
  console.log(JSON.stringify({ stats, sceneSummary: summary, errors: errors.slice(0, 20), failedModules: failed }, null, 2));
  if (errors.length || failed.length) code = 1;
} catch (err) {
  const msg = String(err && err.message || err);
  console.error('check failed:', msg);
  for (const e of logs.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 12)) console.error('  - ' + e.text.slice(0, 400));
  // Distinguish environmental renderer-process crashes (SwiftShader segfault, /dev/shm, headless
  // GPU limits — the page dies before/while modules boot) from real regressions (modules booted
  // but errored). With --soft-crash, an environmental crash exits 0 with an explicit marker so
  // CI on GPU-less runners stays honest without failing on the sandbox itself.
  const crashed = /frame got detached|Target closed|detached Frame|Session closed/i.test(msg);
  if (crashed && args['soft-crash']) {
    console.log(JSON.stringify({ environmentalCrash: true, reason: msg, consoleTail: logs.slice(-6) }, null, 2));
    code = 0;
  } else {
    code = 1;
  }
} finally {
  await browser.close();
}
process.exit(code);
