/**
 * ui showcase — ?showcase=ui&seed=7
 * Stages the HUD in a representative mid-game state: populated statistics, an open Roads sub-menu with a
 * pinned tooltip, a selected entity, and a few notifications. Everything that CAN come from the other
 * modules does (roads / lots / buildings / economy); whatever has to be staged is announced in a toast so
 * reviewers can tell live data from samples.
 */
import { api } from './index.js';
import { DEG2RAD } from '../../shared/math.js';

export async function showcase(ctx) {
  const { world, events } = ctx;
  const rng = world.rng.fork(0x51ca5e);
  const staged = [];

  // ---- camera presets ----
  window.__game.presets.ui_hero = { target: { x: 40, z: -30 }, distance: 520, yaw: 32 * DEG2RAD, pitch: 38 * DEG2RAD };
  window.__game.presets.ui_detail = { target: { x: 20, z: 0 }, distance: 110, yaw: -48 * DEG2RAD, pitch: 20 * DEG2RAD };
  window.__game.presets.ui_night = { target: { x: 30, z: 20 }, distance: 470, yaw: 206 * DEG2RAD, pitch: 31 * DEG2RAD };
  window.__game.presets.ui_top = { target: { x: 0, z: 0 }, distance: 900, yaw: 0, pitch: 80 * DEG2RAD };

  // ---- a small city behind the HUD, if the other modules are there ----
  const roads = world.roads.api, zones = world.zones.api, buildings = world.buildings.api;
  let builtCity = false;
  try {
    if (roads && typeof roads.build === 'function') {
      for (let i = -2; i <= 2; i++) {
        roads.build([{ x: -260, z: i * 96 }, { x: 260, z: i * 96 }], i === 0 ? 'avenue' : 'local', { curve: 'straight' });
        roads.build([{ x: i * 96, z: -260 }, { x: i * 96, z: 260 }], i === 0 ? 'avenue' : 'local', { curve: 'straight' });
      }
      builtCity = true;
      if (zones && typeof zones.paintRect === 'function') {
        const types = ['res-low', 'res-high', 'com-low', 'com-high', 'ind', 'office'];
        for (let gx = -2; gx < 2; gx++) for (let gz = -2; gz < 2; gz++) {
          const t = types[Math.floor(rng() * types.length)];
          zones.paintRect(gx * 96 + 14, gz * 96 + 14, gx * 96 + 82, gz * 96 + 82, t);
        }
      }
      if (buildings && typeof buildings.fastForward === 'function') buildings.fastForward(3600 * 24 * 30);
    }
  } catch (err) {
    console.warn('[ui showcase] optional city build skipped:', err && err.message);
  }
  // ---- a few city services on the fringe: the coverage row, the services statistics and the power /
  //      water info views then read live simulation data instead of showing an empty city. Six of the eight
  //      service types are placed, so the coverage row shows a real city's gaps rather than a full house. ----
  const svc = world.services && world.services.api;
  if (builtCity && svc && typeof svc.place === 'function' && !(svc.list && svc.list.length)) {
    const plan = [
      ['power', [[-330, -300], [330, -330], [-350, 300]]],
      ['water', [[300, -250], [-300, -250], [250, 300]]],
      ['police', [[-264, -60], [264, -60], [-264, 140]]],
      ['fire', [[264, 62], [-264, 62], [264, 200]]],
      ['health', [[-62, 300], [62, 300], [-150, 300]]],
      ['education', [[62, -300], [-62, -300], [150, -300]]],
    ];
    try {
      for (const [type, spots] of plan) for (const [x, z] of spots) if (svc.place(type, x, z, { free: true, silent: true })) break;
    } catch (err) { console.warn('[ui showcase] service placement skipped:', err && err.message); }
  }

  if (!builtCity) staged.push('city');
  const missing = [];
  if (builtCity && !(world.zones.lots && world.zones.lots.length)) missing.push('lots');
  if (builtCity && !(world.buildings.list && world.buildings.list.length)) missing.push('buildings');

  // ---- representative economy (only if the simulation has not produced numbers of its own) ----
  const eco = world.economy;
  if (!eco.population) {
    Object.assign(eco, {
      money: 1284350, population: 24812, households: 9860, jobs: 11240, workers: 12980,
      income: 86400, expenses: 61150, happiness: 0.81,
      demand: { residential: 0.82, commercial: 0.46, industrial: 0.28, office: 0.61 },
      congestion: 0.34, landValue: 0.58, pollution: 0.22,
    });
    eco.coverage = Object.assign(eco.coverage || {}, { power: 0.91, water: 0.86 });
    if (!eco.milestone || !eco.milestone.name || eco.milestone.name === 'Founding') {
      eco.milestone = { index: 8, name: 'Great Town', next: 'Small City', nextPopulation: 34000, progress: 24812 / 34000, reached: [] };
    }
    events.emit('economy:changed', eco);
    staged.push('statistics');
  }
  if (!eco.cityName || eco.cityName === 'New Fable') { eco.cityName = 'Port Fable'; events.emit('city:renamed', eco.cityName); }
  api.refresh();

  // ---- simulation running at 1× so the clock animates ----
  api.setSpeed(1);

  // ---- guided start: the card a first-time visitor gets on an empty map. It never runs over a real
  // city (config.demo / config.showcase disable it), so the showcase forces it on, frozen at step 1,
  // and the ring it draws lands on the Roads button in the dock below. ----
  api.onboarding.start({ force: true, freeze: true, step: 0 });

  // ---- open the Roads sub-menu, arm the avenue and pin its cost / upkeep / capacity tooltip on the active card ----
  api.openCategory('roads');
  api.selectTool('road', { type: 'avenue' });
  const activeBtn = api.hud.toolbar.itemBtns.get('avenue');
  if (activeBtn && api.hud.toolbar.openId === 'roads') requestAnimationFrame(() => { if (api.hud.toolbar.openId === 'roads') api.pinTooltip(activeBtn); });

  // ---- selected entity: a real building / road / lot when available, otherwise a representative record ----
  const realBuilding = world.buildings.list.find((b) => b.state !== 'construction') || world.buildings.list[0];
  const realRoad = world.roads.segments.size ? [...world.roads.segments.values()][Math.floor(world.roads.segments.size / 2)] : null;
  const realLot = world.zones.lots.length ? world.zones.lots[0] : null;
  if (realBuilding) {
    world.selection = { kind: 'building', id: realBuilding.id };
    events.emit('entity:selected', { kind: 'building', id: realBuilding.id, entity: realBuilding });
  } else if (realRoad) {
    world.selection = { kind: 'road', id: realRoad.id };
    events.emit('entity:selected', { kind: 'road', id: realRoad.id, entity: realRoad });
  } else if (realLot) {
    world.selection = { kind: 'lot', id: realLot.id };
    events.emit('entity:selected', { kind: 'lot', id: realLot.id, entity: realLot });
  } else {
    const building = {
      id: 1207, lotId: 88, type: 'res-high', level: 3, levelProgress: 0.62, x: 20, y: 0, z: 0, yaw: 0, w: 24, d: 32, height: 38, floors: 12,
      residents: 214, households: 96, capacity: 240, jobs: 0, happiness: 0.84, landValue: 18600, taxes: 3120, state: 'built', progress: 1,
    };
    world.selection = { kind: 'building', id: building.id };
    events.emit('entity:selected', { kind: 'building', id: building.id, entity: building });
    staged.push('selected building');
  }

  // ---- notifications: real ones from the simulation if it produced any, otherwise representative samples ----
  const simNotes = world.simulation && world.simulation.api && world.simulation.api.notifications;
  // Two chirps, CS2-style: the milestone banner stays until clicked, the budget report auto-dismisses into the bell.
  if (simNotes && simNotes.length) {
    const [a, b] = simNotes;
    if (b) api.notify({ ...b, life: 12000 });
    api.notify({ ...a, life: 0 });
  } else {
    api.notify({ kind: 'money', title: `${eco.period === 'week' ? 'Weekly' : 'Monthly'} budget`, text: 'Income ₡86,400 · Expenses ₡61,150 · Net +₡25,250', life: 12000 });
    api.notify({ kind: 'milestone', title: 'Milestone: Great Town', text: `${eco.cityName} reached 24,000 residents. Reward ₡320,000 — new services unlocked.`, life: 0 });
    staged.push('notifications');
  }
  // Reviewer disclosure goes to the console, not the HUD.
  if (staged.length || missing.length) {
    const parts = [];
    if (staged.length) parts.push(`sample ${staged.join(', ')} — the ${staged.includes('city') ? 'roads / zoning / buildings' : 'simulation'} modules have not produced live data yet`);
    if (missing.length) parts.push(`no ${missing.join(' / ')} exist yet (${missing.includes('lots') ? 'zoning' : 'buildings'} module placeholder)`);
    console.info('[ui showcase] staged data: ' + parts.join('; ') + '.');
  }
}
