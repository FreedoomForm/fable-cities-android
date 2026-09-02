/**
 * simulation module — game clock, economy, population, RCI demand, milestones and city services.
 *
 * World contract (ARCHITECTURE.md §4/§5):
 *   world.time       hour/day/month/year/speed advanced here; `time:tick` every frame
 *   world.economy    money, population, households, jobs, workers, income, expenses, taxRate,
 *                    happiness, demand{…} (+ employed, unemployment, coverage, budget, milestone…)
 *                    income / expenses / net are per game week (economy.period === 'week')
 *   world.services   { api, list, types, version } — place(type,x,z), coverageAt(x,z,type)
 *   simulation.api   setSpeed, setTax, tick, stats (+ fastForward, setInfoView, …)
 * Events: time:tick (frame), sim:tick (game minute), economy:changed (hour), economy:budget (week),
 *         notification, milestone, service:added/removed, services:changed, time:day/week/month/year.
 *
 * Pure logic per frame (O(1)); O(buildings) once per game hour. Service-building visuals and the
 * coverage info-view live in visuals.js and load lazily on first use.
 */
import { hashString } from '../../shared/random.js';
import { GameClock, SPEED_MULTIPLIER } from './clock.js';
import { ServicesModel, SERVICE_TYPES, SERVICE_IDS } from './services.js';
import { Economy } from './economy.js';
import { Milestones, MILESTONES } from './milestones.js';

export const name = 'simulation';

let ctx = null, clock = null, services = null, economy = null, milestones = null, visuals = null, hud = null;
let minuteCounter = 0;
let hourWatch = 0;
const notifications = [];

export const api = {
  types: SERVICE_TYPES,
  serviceIds: SERVICE_IDS,
  milestones: MILESTONES,
  speedMultipliers: SPEED_MULTIPLIER,
  notifications,
  services: null,

  /** 0 paused · 1 normal · 2 double · 3 quadruple */
  setSpeed(step) { return clock.setSpeed(step); },
  getSpeed() { return ctx.world.time.speed; },
  setTax(type, rate) { return economy.setTax(type, rate); },
  getTax(type) { return ctx.world.economy.taxRate[type]; },

  /** Step the simulation by whole game minutes (deterministic, no rendering involved). */
  tick(minutes = 1) {
    const n = Math.max(0, Math.floor(minutes));
    if (n === 0) return;
    clock.resetPending();
    const reportBefore = economy.lastBudget();
    const bulk = n > 60; // long fast-forwards: one summary sim:tick instead of thousands
    economy.quiet = bulk;
    for (let i = 0; i < n; i++) { clock.advance(60); simMinute(bulk); }
    economy.quiet = false;
    clock.resetPending();
    if (bulk) {
      // one summary instead of a budget notification per skipped week
      const report = economy.lastBudget();
      if (report && report !== reportBefore) economy.notifyBudget(report);
      emitSimTick(true);
    }
  },
  /** Advance the world by `gameSeconds` instantly (demo start, showcase). */
  fastForward(gameSeconds) { api.tick(Math.round(gameSeconds / 60)); },

  /** Snapshot of everything the HUD / critics want to know. */
  stats() {
    const w = ctx.world, e = w.economy, t = w.time;
    return {
      time: { hour: +t.hour.toFixed(3), day: t.day, month: t.month, year: t.year, weekday: t.weekday, totalDays: t.totalDays, speed: t.speed, paused: t.paused, text: clock.format() },
      money: Math.round(e.money), income: e.income, expenses: e.expenses, net: e.net, period: e.period,
      population: e.population, households: e.households, jobs: e.jobs, workers: e.workers, employed: e.employed,
      residentialCapacity: e.residentialCapacity,
      unemployment: +e.unemployment.toFixed(3), jobFill: +e.jobFill.toFixed(3), happiness: +e.happiness.toFixed(3),
      education: +e.education.toFixed(3), pollution: +e.pollution.toFixed(3), congestion: +e.congestion.toFixed(3), landValue: +e.landValue.toFixed(3),
      demand: { ...e.demand }, taxRate: { ...e.taxRate }, jobsByClass: { ...e.jobsByClass },
      coverage: { ...e.coverage }, services: services.stats(), serviceBuildings: services.list.length,
      milestone: e.milestone, budget: e.budget, alerts: e.alerts.map((a) => a.key),
      minuteTicks: minuteCounter,
    };
  },
  formatTime() { return clock.format(); },
  setInfoView(type) { return services.setInfoView(type); },
  getInfoView() { return services.infoView; },
  setBuildingSource(fn) { economy.setBuildingSource(fn); },
  showHud(on = true) {
    if (on && !hud) import('./hud.js').then(({ createSimHud }) => { if (!hud) hud = createSimHud(ctx, api); });
    else if (!on && hud) { hud.dispose(); hud = null; }
  },
  notify(kind, title, text) { ctx.events.emit('notification', { kind, title, text }); },
  /** Internals for the showcase / debugging. */
  internals() { return { clock, services, economy, milestones, visuals, hud }; },
};

function simMinute(quiet) {
  minuteCounter++;
  const ranHour = economy.minute();
  if (ranHour) {
    hourWatch++;
    milestones.tick();
  }
  if (!quiet) emitSimTick(false);
}
function emitSimTick(fastForward) {
  const t = ctx.world.time;
  ctx.events.emit('sim:tick', { minute: minuteCounter, hour: t.hour, day: t.day, month: t.month, year: t.year, fastForward });
}

export async function init(c) {
  ctx = c;
  const { world, events, config } = ctx;
  const rng = world.rng.fork(hashString('simulation'));

  clock = new GameClock(world, events);
  services = new ServicesModel(world, events, world.economy);
  world.services.api = services.api;
  world.services.list = services.list;
  world.services.types = SERVICE_TYPES;
  world.services.version = 0;
  world.services.infoView = null;
  economy = new Economy(world, events, services, rng);
  milestones = new Milestones(world, events);
  api.services = services.api;
  world.simulation = { api };

  events.on('notification', (n) => {
    if (!n) return;
    notifications.unshift({ ...n, day: world.time.totalDays, hour: world.time.hour });
    if (notifications.length > 50) notifications.length = 50;
  });
  // keep the projected income/expenses fresh when the road network changes
  events.on('roads:changed', () => economy.recomputeRates());

  if (config.get('services_visuals', '1') !== '0') {
    const { ServiceVisuals } = await import('./visuals.js');
    visuals = new ServiceVisuals(ctx, services);
  }
  if (config.get('simhud') === '1') api.showHud(true);

  economy.recomputeRates();
  events.emit('economy:changed', world.economy);
}

export function update(dt) {
  const n = clock.update(dt);
  for (let i = 0; i < n; i++) simMinute(false);
  if (visuals) visuals.update(dt);
  if (hud) hud.update(dt);
}

export function dispose() {
  if (visuals) visuals.dispose();
  if (hud) hud.dispose();
}
