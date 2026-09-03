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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1920, height: 1080 }, args: [`--use-angle=${angleBackend}`, '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader'] });
const logs = [];
let code = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e) }));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 150000 });
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 150000, polling: 200 });
  await page.evaluate((f) => window.__game.waitStable(f), frames);
  const stats = await page.evaluate(() => window.__game.stats());
  const summary = await page.evaluate(() => window.__game.sceneSummary());
  const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
  const failed = Object.entries(stats.moduleStatus).filter(([, s]) => !s.ok);
  console.log(JSON.stringify({ stats, sceneSummary: summary, errors: errors.slice(0, 20), failedModules: failed }, null, 2));
  if (errors.length || failed.length) code = 1;
} catch (err) {
  console.error('check failed:', err && err.message || err);
  for (const e of logs.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 12)) console.error('  - ' + e.text.slice(0, 400));
  code = 1;
} finally {
  await browser.close();
}
process.exit(code);
