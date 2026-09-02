#!/usr/bin/env node
/**
 * Screenshot any local or remote HTML page. For designing static pages.
 *
 *   node tools/shotpage.mjs <file-or-url> <out.png> [--w 1440] [--h 900] [--full] [--dpr 2] [--wait 1200]
 *
 * Examples:
 *   node tools/shotpage.mjs deploy/collections/index.html shots/design/a-full.png --full
 *   node tools/shotpage.mjs deploy/collections/index.html shots/design/a-fold.png --w 1440 --h 900
 *   node tools/shotpage.mjs deploy/collections/index.html shots/design/a-mobile.png --w 390 --h 844 --full
 *
 * Writes <out>.log.json with console errors and failed requests.
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


const argv = process.argv.slice(2);
const [target, out] = argv.filter((a) => !a.startsWith('--'));
if (!target || !out) { console.error('usage: shotpage.mjs <file-or-url> <out.png> [--w 1440] [--h 900] [--full] [--dpr 1] [--wait 1200]'); process.exit(1); }
const flag = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (name) => argv.includes('--' + name);

const width = +flag('w', 1440), height = +flag('h', 900), dpr = +flag('dpr', 1), wait = +flag('wait', 1200);
const url = /^https?:|^file:/.test(target) ? target : 'file://' + path.resolve(target);
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: resolveChrome(),
  headless: true,
  defaultViewport: { width, height, deviceScaleFactor: dpr },
  args: ['--hide-scrollbars', '--mute-audio', '--font-render-hinting=none', '--force-color-profile=srgb'],
});
const logs = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ type: m.type(), text: m.text() }); });
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e) }));
  page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}` }));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: out, fullPage: has('full') });
  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    title: document.title,
  }));
  fs.writeFileSync(out.replace(/\.png$/, '') + '.log.json', JSON.stringify({ url, width, height, dpr, metrics, logs }, null, 2));
  console.log(`shot: ${out}  ${width}x${height}${has('full') ? ' (full page, ' + metrics.scrollHeight + 'px tall)' : ''}  errors:${logs.length}${metrics.horizontalOverflow ? '  ⚠ HORIZONTAL OVERFLOW' : ''}`);
  for (const l of logs.slice(0, 6)) console.log('  - ' + l.type + ': ' + l.text.slice(0, 180));
} catch (err) {
  console.error('shotpage failed:', err && err.message || err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
