#!/usr/bin/env node
/**
 * tools/uishot.mjs — HUD screenshots at a given viewport, optionally with touch/mobile emulation and
 * a real wall-clock dwell, so onboarding and mobile layout can be verified the way a visitor sees them.
 *
 *   node tools/uishot.mjs --out shots/ui/desktop.png --w 1440 --h 900
 *   node tools/uishot.mjs --out shots/ui/phone.png   --w 390 --h 844 --mobile
 *   node tools/uishot.mjs --out shots/ui/onboard60.png --dwell 60000        # 60 s into an empty world
 *
 * Options: --url --w --h --dwell <ms of real time after game:ready> --mobile --dpr --eval "js"
 *          --tap "<selector>"  (comma-separated: taps each in order, 400 ms apart)
 * Writes <out>.log.json with console errors, a HUD DOM audit (visible panels, tap-target sizes,
 * overflow) and window.__game stats.
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
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const CHROME = resolveChrome();
const W = +flag('w', 1440), H = +flag('h', 900), DPR = +flag('dpr', 1);
const MOBILE = has('mobile');
const DWELL = +flag('dwell', 0);
const OUT = path.resolve(flag('out', 'shots/ui/shot.png'));
const URL_ = flag('url', 'http://127.0.0.1:5180/?demo=0&seed=42&headless=1');
const EVAL = flag('eval', '');
const TAPS = String(flag('tap', '')).split(',').filter(Boolean);
const SEQ = String(flag('seq', '')).split(';;').map((x) => x.trim()).filter(Boolean);
const seqLog = [];
/** Which guided-start step the HUD is showing, for the sequence log. */
const guideStep = (pg) => pg.evaluate(() => {
  const o = document.querySelector('.fc-onb');
  if (!o) return 'absent';
  if (o.hidden) return 'hidden';
  return `${o.dataset.step || '?'}: ${(o.querySelector('.fc-onb-title')?.textContent || '').trim()}`;
}).catch(() => 'err');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR, isMobile: MOBILE, hasTouch: MOBILE },
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    ...(MOBILE ? ['--touch-events=enabled'] : [])],
});
const logs = [];
try {
  const page = await browser.newPage();
  if (MOBILE) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  // Six builders share this dev server: a Vite HMR reload mid-shot would reset the city.
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().includes('/@vite/client')) {
      return r.respond({ status: 200, contentType: 'text/javascript', body:
        'export const createHotContext=()=>({on(){},off(){},send(){},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},decline(){},data:{}});'
        + 'export const updateStyle=(id,c)=>{let e=document.querySelector(`style[data-vite-dev-id="${id}"]`);if(!e){e=document.createElement("style");e.setAttribute("type","text/css");e.setAttribute("data-vite-dev-id",id);document.head.appendChild(e);}e.textContent=c;};'
        + 'export const removeStyle=(id)=>{const e=document.querySelector(`style[data-vite-dev-id="${id}"]`);if(e)e.remove();};'
        + 'export const injectQuery=(u)=>u; export class ErrorOverlay extends HTMLElement{constructor(){super();}}' });
    }
    return r.continue();
  });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ type: m.type(), text: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e && e.message || e).slice(0, 300) }));

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__game && window.__game.ready === true', { timeout: 120000, polling: 200 }).catch(() => {});
  await page.evaluate(() => window.__game?.waitStable?.(8)).catch(() => {});
  if (DWELL) await new Promise((r) => setTimeout(r, DWELL));
  if (EVAL) await page.evaluate(EVAL);
  // --seq "js ;; js ;; js": run each snippet, wait for the HUD to settle, shot, and record the guide step.
  for (const [i, src] of SEQ.entries()) {
    const before = await guideStep(page);
    await page.evaluate(src).catch((e) => logs.push({ type: 'seq', text: `${i}: ${e.message}` }));
    await new Promise((r) => setTimeout(r, +flag('seqwait', 1500)));
    await page.evaluate(() => window.__game?.waitStable?.(4)).catch(() => {});
    const after = await guideStep(page);
    const f = OUT.replace(/\.png$/, '') + `-seq${i + 1}.png`;
    await page.screenshot({ path: f });
    seqLog.push({ i: i + 1, js: src.trim().slice(0, 90), guideBefore: before, guideAfter: after, shot: path.relative(process.cwd(), f) });
    console.log(`  seq${i + 1}: ${src.trim().slice(0, 60)} → guide ${before} → ${after}`);
  }
  for (const sel of TAPS) {
    await page.evaluate((s) => { const el = document.querySelector(s.trim()); if (el) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); }, sel).catch(() => {});
    await page.click(sel.trim()).catch((e) => logs.push({ type: 'tap', text: `${sel}: ${e.message}` }));
    await new Promise((r) => setTimeout(r, 450));
  }
  await page.evaluate(() => window.__game?.waitStable?.(4)).catch(() => {});
  await page.screenshot({ path: OUT });

  const audit = await page.evaluate(() => {
    const root = document.querySelector('.fc-hud');
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.02; };
    const z = root ? (root.getBoundingClientRect().width / (root.offsetWidth || 1)) || 1 : 1;
    const panels = [];
    if (root) for (const el of root.querySelectorAll('.fc-panel, .fc-onb')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      panels.push({ cls: el.className.split(' ').filter((c) => c.startsWith('fc-')).slice(0, 2).join(' '), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    // tap targets: every interactive element that is visible
    const small = [];
    let taps = 0;
    if (root) for (const el of root.querySelectorAll('button, [role="button"], input, .fc-cat, .fc-item, .fc-svc-chip')) {
      if (!vis(el)) continue;
      taps++;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) small.push({ cls: el.className.split(' ')[0] || el.tagName, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
    }
    const g = window.__game;
    const covered = panels.reduce((a, p) => a + p.w * p.h, 0) / (innerWidth * innerHeight);
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, hudZoom: +z.toFixed(3),
      panels, tapTargets: taps, smallTargets: small,
      hudCoverage: +covered.toFixed(3),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      onboarding: (() => { const o = document.querySelector('.fc-onb'); if (!o) return null; const r = o.getBoundingClientRect(); return { visible: vis(o), step: o.dataset.step || null, title: (o.querySelector('.fc-onb-title')?.textContent || '').trim(), body: (o.querySelector('.fc-onb-text')?.textContent || '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      speedLabels: [...document.querySelectorAll('.fc-speed button')].map((b) => (b.querySelector('.fc-speed-label')?.textContent || '').trim()),
      world: g ? { buildings: g.world.buildings.list.length, roads: g.world.roads.segments.size, lots: g.world.zones.lots.length, pop: g.world.economy.population, speed: g.world.time.speed, day: g.world.time.totalDays } : null,
      stats: g && g.stats ? g.stats() : null,
      quality: g && g.engine ? g.engine.quality.name : null,
    };
  }).catch((e) => ({ error: String(e && e.message || e) }));

  fs.writeFileSync(OUT.replace(/\.png$/, '') + '.log.json', JSON.stringify({ url: URL_, w: W, h: H, mobile: MOBILE, dwell: DWELL, seq: seqLog, audit, logs }, null, 2));
  console.log(`shot ${path.relative(process.cwd(), OUT)}  ${W}x${H}${MOBILE ? ' mobile' : ''}  errors:${logs.filter((l) => l.type !== 'warning').length}`);
  console.log(JSON.stringify(audit, null, 1).slice(0, 3000));
} catch (err) {
  console.error('uishot failed:', err && err.message || err);
  process.exitCode = 1;
} finally { await browser.close(); }
