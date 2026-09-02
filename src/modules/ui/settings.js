import { h, svg, setText, setClass, fmtClock } from './dom.js';
import { icon } from './icons.js';
import { WEATHERS, QUALITIES } from './catalog.js';
import { dayPhase } from './topbar.js';
// perfguard is not in src/modules/registry.js (core, not ours to edit — see
// docs/requests/perfguard.md). Importing it here is what starts hardware detection and the
// runtime frame-time guard today; `attach()` is idempotent, so registering the module later
// changes nothing.
import { attach as attachPerfguard } from '../perfguard/index.js';

/** Settings dropdown: time of day, weather, graphics quality, post effects, interface. */
export function createSettings(hud) {
  const { world, events, ctx, tooltip } = hud;
  const engine = ctx.engine;
  let perf = null;
  try { perf = attachPerfguard(ctx); } catch (err) { console.warn('[ui] perfguard unavailable', err); }

  // ---- time of day ----
  const timeLabel = h('b', fmtClock(world.time.hour));
  const range = h('input', { type: 'range', min: '0', max: '23.99', step: '0.05', value: String(world.time.hour), 'aria-label': 'Time of day' });
  let dragging = false;
  range.addEventListener('input', () => { dragging = true; hud.setTime(parseFloat(range.value)); });
  range.addEventListener('change', () => { dragging = false; });
  const timePresets = h('div.fc-set-row');
  for (const [label, hour, ic] of [['Dawn', 6.4, 'sun'], ['Noon', 13, 'sun'], ['Golden', 18.6, 'sun'], ['Night', 22, 'moon']]) {
    const b = h('button.fc-btn', { onClick: () => hud.setTime(hour) }, svg(icon(ic)), label);
    tooltip.attach(b, { icon: 'clock', title: `${label} · ${fmtClock(hour)}`, desc: 'Jump the clock. The simulation keeps running.' });
    timePresets.appendChild(b);
  }
  const timeSection = h('div.fc-set-section',
    h('div.fc-set-label', 'Time of day', timeLabel),
    h('div.fc-slider', h('div.track'), range),
    h('div.fc-slider-ticks', h('span', '00'), h('span', '06'), h('span', '12'), h('span', '18'), h('span', '24')),
    timePresets,
  );

  // ---- weather ----
  const weatherSeg = h('div.fc-seg.icons', { role: 'group', 'aria-label': 'Weather' });
  const weatherBtns = {};
  for (const w of WEATHERS) {
    const b = h('button', { onClick: () => hud.setWeather(w) }, svg(icon(w)), w);
    weatherBtns[w] = b;
    weatherSeg.appendChild(b);
  }
  const weatherSection = h('div.fc-set-section', h('div.fc-set-label', 'Weather'), weatherSeg);

  // ---- graphics ----
  const qualitySeg = h('div.fc-seg', { role: 'group', 'aria-label': 'Graphics quality' });
  const qualityBtns = {};
  for (const q of QUALITIES) {
    const b = h('button', { onClick: () => setQuality(q) }, q);
    tooltip.attach(b, { icon: 'sparkle', title: `${q[0].toUpperCase() + q.slice(1)} quality`, desc: 'Shadow resolution, draw distance, detail density and post effects. Reloads the game.' });
    qualityBtns[q] = b;
    qualitySeg.appendChild(b);
  }
  function setQuality(q) {
    if (q === engine.quality.name) return;
    const url = new URL(window.location.href);
    url.searchParams.set('quality', q);
    hud.toasts.push({ kind: 'info', title: `Switching to ${q} quality`, text: 'Reloading the city…', life: 2500 });
    setTimeout(() => window.location.assign(url.toString()), 350);
  }
  const toggles = h('div.fc-toggles');
  const toggleDefs = [
    ['SSAO', () => !!(engine.post && engine.post.gtao && engine.post.gtao.enabled), (v) => { if (engine.post && engine.post.gtao) engine.post.gtao.enabled = v; }],
    ['Bloom', () => !!(engine.post && engine.post.bloom && engine.post.bloom.enabled), (v) => { if (engine.post && engine.post.bloom) engine.post.bloom.enabled = v; }],
    ['Anti-aliasing', () => !!(engine.post && engine.post.smaa && engine.post.smaa.enabled), (v) => { if (engine.post && engine.post.smaa) engine.post.smaa.enabled = v; }],
    ['Post-processing', () => engine.postEnabled !== false, (v) => { engine.postEnabled = v; }],
  ];
  const toggleEls = [];
  for (const [label, get, set] of toggleDefs) {
    const b = h('button.fc-toggle', { role: 'switch' }, h('span', label), h('span.sw'));
    b.addEventListener('click', () => { set(!get()); refreshToggles(); });
    toggleEls.push([b, get]);
    toggles.appendChild(b);
  }
  const graphicsSection = h('div.fc-set-section', h('div.fc-set-label', 'Graphics'), qualitySeg, h('div.fc-set-hint', 'Quality presets reload the game. Effects toggle instantly.'), toggles);

  // ---- performance (perfguard: hardware detection + the runtime frame-time guard) ----
  // A visitor on unknown hardware needs to see WHY the game picked a preset, and be able to
  // take the wheel back. Everything here reads `window.__game.perf`.
  const perfHw = h('div.fc-set-hint');
  const perfState = h('div.fc-set-hint');
  const autoToggle = h('button.fc-toggle', { role: 'switch' }, h('span', 'Auto quality'), h('span.sw'));
  autoToggle.addEventListener('click', () => { if (perf) { perf.setAuto(!perf.auto); refreshPerf(); } });
  tooltip.attach(autoToggle, {
    icon: 'sparkle', title: 'Auto quality',
    desc: 'Picks a preset from your GPU at startup, then lowers it (at most twice) if the game cannot hold 45 fps. Never raises it, never picks Ultra.',
  });
  const recommendBtn = h('button.fc-btn', { onClick: () => perf && setQuality(perf.recommendation.name) }, svg(icon('sparkle')), 'Use recommended');
  const performanceSection = h('div.fc-set-section',
    h('div.fc-set-label', 'Performance'), perfHw,
    h('div.fc-toggles', autoToggle), perfState,
    h('div.fc-set-row', recommendBtn),
  );
  function refreshPerf() {
    if (!perf) { performanceSection.style.display = 'none'; return; }
    setText(perfHw, `${perf.describe()} — recommended: ${perf.recommendation.name}`);
    setClass(autoToggle, 'is-on', perf.auto);
    const g = perf.guard;
    const built = perf.baseQuality;
    const bits = [];
    if (perf.quality !== built) bits.push(`running ${perf.quality} (world built at ${built})`);
    if (g.steps) bits.push(`lowered ${g.steps}\u00d7 automatically`);
    if (!perf.enabled) bits.push('auto disabled by URL');
    else if (perf.auto && !g.steps) bits.push(`watching for a sustained drop below ${g.targetFps} fps`);
    setText(perfState, bits.join(' · '));
    setClass(recommendBtn, 'is-on', perf.recommendation.name === engine.quality.name);
  }

  // ---- interface ----
  const uiToggles = h('div.fc-toggles');
  const tipsToggle = h('button.fc-toggle.is-on', { role: 'switch' }, h('span', 'Tooltips'), h('span.sw'));
  tipsToggle.addEventListener('click', () => { const on = !tipsToggle.classList.contains('is-on'); setClass(tipsToggle, 'is-on', on); tooltip.setEnabled(on); });
  const hudToggle = h('button.fc-toggle', { role: 'switch' }, h('span', 'Cinematic mode'), h('span.sw'));
  hudToggle.addEventListener('click', () => hud.setHudVisible(false));
  tooltip.attach(hudToggle, { icon: 'eyeOff', title: 'Cinematic mode', key: 'H', desc: 'Hides every panel for clean screenshots. Press H to bring the HUD back.' });
  uiToggles.append(tipsToggle, hudToggle);
  const camRow = h('div.fc-set-row');
  for (const [label, preset] of [['City', 'city'], ['Street', 'street'], ['Skyline', 'skyline'], ['Aerial', 'aerial']]) {
    const b = h('button.fc-btn', { onClick: () => { const p = window.__game && window.__game.presets && window.__game.presets[preset]; if (p) ctx.cameraController.setView(p, false); } }, svg(icon('camera')), label);
    camRow.appendChild(b);
  }
  const interfaceSection = h('div.fc-set-section', h('div.fc-set-label', 'Interface'), uiToggles, h('div.fc-set-label', { style: { marginTop: '4px' } }, 'Camera'), camRow);

  const closeBtn = h('button.fc-info-close', { 'aria-label': 'Close settings', onClick: () => close() }, svg(icon('close')));
  const el = h('div.fc-panel.fc-settings', { role: 'dialog', 'aria-label': 'Settings' },
    h('div.fc-set-head', svg(icon('settings')), h('h3', 'Settings'), closeBtn),
    timeSection, weatherSection, graphicsSection, performanceSection, interfaceSection,
  );
  hud.root.appendChild(el);

  function refreshToggles() { for (const [b, get] of toggleEls) setClass(b, 'is-on', !!get()); }
  function refresh() {
    if (!dragging) range.value = String(((world.time.hour % 24) + 24) % 24);
    setText(timeLabel, `${fmtClock(world.time.hour)} · ${dayPhase(world.time.hour)}`);
    for (const w of WEATHERS) setClass(weatherBtns[w], 'is-on', world.env.weather === w);
    for (const q of QUALITIES) setClass(qualityBtns[q], 'is-on', engine.quality.name === q);
    refreshToggles();
    refreshPerf();
  }
  function open() { tooltip.pin(null); tooltip.hide(true); el.classList.add('is-open'); hud.root.classList.add('settings-open'); hud.top.settingsBtn.classList.add('is-on'); refresh(); }
  function close() { el.classList.remove('is-open'); hud.root.classList.remove('settings-open'); hud.top.settingsBtn.classList.remove('is-on'); }
  function toggle() { el.classList.contains('is-open') ? close() : open(); }

  events.on('weather:set', refresh);
  refresh();
  return { el, open, close, toggle, refresh, get isOpen() { return el.classList.contains('is-open'); } };
}
