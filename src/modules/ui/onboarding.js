/**
 * Guided start — the first four minutes of an empty map.
 *
 * A stranger who opens a link lands on grass with no idea that roads come first, that zoning only
 * works beside a road, or that the clock is what builds the city. This is a four-step objective card
 * that lives in the HUD, points at the control each step needs and completes on a real world event
 * (`roads:changed`, `zones:changed`, `time:speed`, `building:added`) — never on a timer.
 *
 * It is absent entirely when the demo city is loaded (`config.demo`), for a showcase, and for the rest
 * of the session once dismissed.
 */
import { h, svg, setText, setClass, clear, hudZoom, zoomRect } from './dom.js';
import { icon } from './icons.js';

const DISMISS_KEY = 'fc-guide-dismissed';
/** Session-scoped so a reload of the same tab does not nag; wrapped because storage can throw. */
const readDismissed = () => { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; } };
const writeDismissed = () => { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_) { /* private mode */ } };

/**
 * Each step: what it asks, which HUD control it rings, and the world state that finishes it.
 * `armed` swaps the body text once the tool is in hand, so the card answers "…and now what?".
 */
const STEPS = [
  {
    id: 'road', icon: 'road', color: '#7fd4ff',
    title: 'Draw your first road',
    text: () => [h('b', 'Roads'), ' is the first button below. Open it, then drag across the ground — everything in a city grows along a street.'],
    armedText: () => ['Road tool ready. ', h('b', 'Drag across the ground'), ' to lay it, and release to build.'],
    armed: (w) => w.tool.active === 'road',
    target: (hud) => hud.toolbar.catBtns.get('roads'),
    done: (w) => w.roads.segments.size > 0,
    on: ['roads:changed'],
  },
  {
    id: 'zone', icon: 'zone', color: '#8ce99a',
    title: 'Zone homes beside it',
    text: () => ['Open ', h('b', 'Zoning'), ', take ', h('b', 'Low Density Residential'), ', and drag over the ground next to your road.'],
    armedText: () => ['Now drag over the grass ', h('b', 'within about 30 m of the road'), ' — plots only appear where a street reaches them.'],
    armed: (w) => w.tool.active === 'zone',
    target: (hud) => hud.toolbar.catBtns.get('zoning'),
    done: (w) => w.zones.lots.length > 0,
    on: ['zones:changed'],
  },
  {
    id: 'speed', icon: 'fast3', color: '#ffd66b',
    title: 'Let the clock run',
    text: () => ['Nothing is built while time crawls. Push the speed to ', h('b', '4×'), ' up in the clock — the plots start building straight away.'],
    target: (hud) => hud.top.speedBtns[3],
    done: (w) => !w.time.paused && (w.time.speed || 0) >= 2,
    on: ['time:speed'],
  },
  {
    id: 'grow', icon: 'house', color: '#ffa8c5',
    title: 'Watch them move in',
    text: () => ['Scaffolding goes up on each plot, then residents arrive. The ', h('b', 'demand bars'), ' bottom-left tell you what to zone next.'],
    target: (hud) => hud.toolbar.demand,
    done: (w) => w.buildings.list.length > 0,
    on: ['building:added'],
  },
];

export function createOnboarding(hud) {
  const { world, events, ctx } = hud;
  const config = ctx.config;

  // Never over a city that already exists: the demo city is built after modules init, so ask the config,
  // not the world (world.buildings.list is still empty here in both modes).
  const eligible = !config.demo && !config.showcase && !readDismissed();

  const state = { i: 0, active: false, busy: false, frozen: false, finished: false, celebrating: false, lastTarget: null };

  // ---------- card ----------
  const badge = h('span.fc-onb-badge');
  const kicker = h('div.fc-onb-kicker', 'Getting started');
  const closeBtn = h('button.fc-onb-close', { 'aria-label': 'Dismiss the guide', title: 'Dismiss the guide' }, svg(icon('close')));
  const iconEl = h('div.fc-onb-icon');
  const titleEl = h('div.fc-onb-title');
  const textEl = h('div.fc-onb-text');
  const dots = h('div.fc-onb-dots');
  const dotEls = STEPS.map(() => h('i'));
  for (const d of dotEls) dots.appendChild(d);
  const el = h('div.fc-panel.fc-onb', { role: 'status', 'aria-live': 'polite', hidden: true },
    h('div.fc-onb-head', badge, kicker, closeBtn),
    h('div.fc-onb-body', iconEl, h('div.fc-onb-copy', titleEl, textEl)),
    dots,
  );
  closeBtn.addEventListener('click', () => dismiss());

  // ---------- pointer ring (follows the control the current step needs) ----------
  const ring = h('div.fc-onb-ring', { 'aria-hidden': 'true' }, h('i.fc-onb-arrow'));
  hud.root.appendChild(ring);
  hud.leftStack.insertBefore(el, hud.leftStack.firstChild);

  function renderStep() {
    const s = STEPS[state.i];
    if (!s) return;
    el.dataset.step = s.id;
    el.style.setProperty('--onb', s.color);
    setText(badge, `${state.i + 1}`);
    iconEl.innerHTML = `<span class="fc-icon">${icon(s.icon)}</span>`;
    setText(titleEl, s.title);
    clear(textEl);
    const armed = s.armed && s.armed(world) && s.armedText;
    for (const n of (armed ? s.armedText() : s.text())) textEl.appendChild(n instanceof Node ? n : document.createTextNode(String(n)));
    for (let i = 0; i < dotEls.length; i++) {
      setClass(dotEls[i], 'is-done', i < state.i);
      setClass(dotEls[i], 'is-now', i === state.i);
    }
    setClass(el, 'is-armed', !!armed);
  }

  /** Completion flash, then the next step (or the closing card). */
  function advance() {
    const s = STEPS[state.i];
    // `check()` runs on every world event AND every frame, so without this guard a single completed
    // step queues one advance per tick and the guide skips straight to the end.
    if (!s || state.busy) return;
    state.busy = true;
    setClass(dotEls[state.i], 'is-done', true);
    el.classList.add('is-done');
    setTimeout(() => {
      el.classList.remove('is-done');
      state.busy = false;
      state.i++;
      // A step whose condition is already satisfied (speed already high, say) should not sit there asking.
      while (state.i < STEPS.length && STEPS[state.i].done(world)) { setClass(dotEls[state.i], 'is-done', true); state.i++; }
      if (state.i >= STEPS.length) finish();
      else { renderStep(); el.classList.add('is-new'); setTimeout(() => el.classList.remove('is-new'), 400); }
    }, 820);
  }

  function finish() {
    state.finished = true;
    state.celebrating = true;
    el.dataset.step = 'done';
    el.style.setProperty('--onb', '#8ce99a');
    setText(badge, '✓');
    setText(kicker, 'You are running a city');
    iconEl.innerHTML = `<span class="fc-icon">${icon('sparkle')}</span>`;
    setText(titleEl, 'That is the whole loop');
    clear(textEl);
    for (const n of ['Road, zone, let time run. Watch the ', h('b', 'demand bars'), ' and add ', h('b', 'Services'), ' as people arrive.']) {
      textEl.appendChild(n instanceof Node ? n : document.createTextNode(String(n)));
    }
    for (const d of dotEls) setClass(d, 'is-done', true);
    setClass(el, 'is-armed', false);
    hideRing();
    setTimeout(() => { if (state.celebrating) dismiss(); }, 11000);
  }

  function dismiss() {
    state.active = false;
    state.celebrating = false;
    writeDismissed();
    el.classList.add('is-leaving');
    hideRing();
    setTimeout(() => { el.hidden = true; el.classList.remove('is-leaving'); }, 260);
    hud.root.classList.remove('guide-on');
  }

  /**
   * `force` + `freeze` are for the module showcase only: they put the card on screen over a staged city
   * and stop it advancing, so a reviewer can see the component without playing a fresh map.
   */
  function start({ force = false, freeze = false, step = 0 } = {}) {
    if (!force && (!eligible || state.active || state.finished || readDismissed())) return;
    // Belt and braces: a world that already has buildings needs no guided start.
    if (!force && (world.buildings.list.length > 0 || world.roads.segments.size > 4)) return;
    if (force) { state.frozen = !!freeze; state.i = Math.max(0, Math.min(STEPS.length - 1, step)); state.finished = false; }
    if (!force) { while (state.i < STEPS.length && STEPS[state.i].done(world)) state.i++; }
    if (state.i >= STEPS.length) return;
    state.active = true;
    el.hidden = false;
    hud.root.classList.add('guide-on');
    renderStep();
    el.classList.add('is-new');
    setTimeout(() => el.classList.remove('is-new'), 500);
  }

  function check() {
    if (!state.active || state.finished || state.frozen) return;
    const s = STEPS[state.i];
    if (s && s.done(world)) advance();
  }

  // Event-driven completion (the contract in §6), with a cheap per-frame re-check as the safety net
  // for a module that mutates the world without emitting.
  const seen = new Set();
  for (const s of STEPS) for (const name of s.on) if (!seen.has(name)) { seen.add(name); events.on(name, () => check()); }
  events.on('tool:changed', () => { if (state.active && !state.finished) renderStep(); });
  events.on('game:ready', () => start());

  let ringT = 0;
  function hideRing() { ring.classList.remove('is-on'); state.lastTarget = null; }

  /** Per-frame: keep the ring glued to the control this step needs, and poll the completion test. */
  function tick(dt) {
    if (!state.active) return;
    ringT += dt || 0;
    if (ringT < 0.12) return;
    ringT = 0;
    check();
    if (state.finished) return;
    const s = STEPS[state.i];
    const t = s && s.target ? s.target(hud) : null;
    if (!t || !t.isConnected || el.hidden) return hideRing();
    const z = hudZoom(hud.root);
    const r = zoomRect(t.getBoundingClientRect(), z);
    if (r.width < 2) return hideRing();
    ring.style.transform = `translate(${Math.round(r.left - 6)}px, ${Math.round(r.top - 6)}px)`;
    ring.style.width = `${Math.round(r.width + 12)}px`;
    ring.style.height = `${Math.round(r.height + 12)}px`;
    ring.style.setProperty('--onb', s.color);
    // the caret sits above the ring by default; against the top bar there is no room, so flip it under
    setClass(ring, 'is-below', r.top < 42);
    if (state.lastTarget !== t) { state.lastTarget = t; ring.classList.add('is-on'); }
  }

  return {
    el, ring, tick, start, dismiss,
    get isActive() { return state.active; },
    get eligible() { return eligible; },
    get step() { return state.finished ? 'done' : (STEPS[state.i] || {}).id || null; },
  };
}
