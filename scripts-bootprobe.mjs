#!/usr/bin/env node
/** Minimal boot-time probe: page → ready → 1 frame → PNG. Prints elapsed timings. */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  throw new Error('set CHROME_PATH');
}
const CHROME = resolveChrome();
const url = process.argv[2] || 'http://127.0.0.1:5180/';
const out = process.argv[3] || '/tmp/probe.png';
const w = +(process.argv[4] || 960), h = +(process.argv[5] || 540);
const t0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 560000,
  defaultViewport: { width: w, height: h },
  args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'],
});
const logs = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/error|failed|Shader/i.test(t)) logs.push(t.slice(0, 200)); });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log('domcontentloaded @', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 480000, polling: 1000 });
  console.log('game ready @', ((Date.now() - t0) / 1000).toFixed(1), 's');
  // wait for at least ~8 engine frames so the camera/post chain has produced real output
  const f0 = await page.evaluate(() => window.__game.engine.frame);
  let f = f0;
  while (f - f0 < 8 && Date.now() - t0 < 540000) {
    await new Promise((r) => setTimeout(r, 1500));
    f = await page.evaluate(() => window.__game.engine.frame);
  }
  console.log('frames', f - f0, '@', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const b64 = await page.screenshot({ type: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(out, b64);
  console.log('shot saved', out, ((Date.now() - t0) / 1000).toFixed(1), 's');
  if (logs.length) console.log('LOGS:\n' + logs.slice(0, 10).join('\n'));
} finally { await browser.close(); }
