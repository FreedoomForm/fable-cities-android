#!/usr/bin/env node
/* Extended boot probe: same as tools/check.mjs but with a 420 s ready window and
 * periodic loading-status polling, so slow SwiftShader world builds don't time out. */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH;
const url = process.argv[2] || 'http://127.0.0.1:5199/?quality=low&map=1024';
const budgetMs = Number(process.argv[3] || 420000);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader'],
});
const logs = [];
let code = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push({ type: m.type(), text: m.text() }); });
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String((e && e.message) || e) }));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  const t0 = Date.now();
  let lastStatus = '';
  let ready = false;
  while (Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await page.evaluate(() => ({
      hasGame: !!window.__game,
      ready: !!(window.__game && window.__game.ready === true),
      fps: window.__fc ? window.__fc.fps : -1,
      status: (document.getElementById('loading-status') || {}).textContent || '',
      bar: (document.getElementById('loading-bar') || {}).style ? document.getElementById('loading-bar').style.width : '',
    })).catch(() => null);
    if (!s) break;
    if (s.status !== lastStatus) {
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s] game=${s.hasGame} ready=${s.ready} fps=${s.fps} bar=${s.bar} status="${s.status}"`);
      lastStatus = s.status;
    }
    if (s.ready) { ready = true; break; }
  }

  if (!ready) {
    console.error('PROBE FAILED: game not ready within budget');
    for (const e of logs.slice(0, 12)) console.error('  - ' + e.type + ': ' + e.text.slice(0, 300));
    code = 1;
  } else {
    const stats = await page.evaluate(() => window.__game.stats());
    const failed = Object.entries(stats.moduleStatus).filter(([, s]) => !s.ok);
    console.log('READY. failedModules:', JSON.stringify(failed.map(([k]) => k)));
    const errors = logs.filter((l) => l.type === 'error' || l.type === 'pageerror');
    console.log('console errors:', errors.length);
    for (const e of errors.slice(0, 8)) console.log('  - ' + e.text.slice(0, 300));
    const fps = await page.evaluate(() => window.__fc ? window.__fc.fps : -1);
    console.log('shim fps meter:', fps);
    if (failed.length) code = 1;
  }
} catch (err) {
  console.error('probe failed:', (err && err.message) || err);
  for (const e of logs.slice(0, 8)) console.error('  - ' + e.text.slice(0, 300));
  code = 1;
} finally {
  await browser.close();
}
process.exit(code);
