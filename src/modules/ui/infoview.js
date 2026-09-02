import { h, svg, setText, setClass, clear, fmtPct, fmtInt } from './dom.js';
import { icon } from './icons.js';
import { INFO_VIEWS, ZONE_LABELS } from './catalog.js';
import { viewThumb } from './thumbs.js';

/**
 * Info-view legend panel (left column, CS2 style). Opens while the `info` tool is armed:
 * title + description, Low→High gradient with the city average marked, or categorical chips for zoning,
 * a statistics block read live from the simulation (facility counts, capacity vs demand, vehicles,
 * unemployment…), "Colour buildings / terrain" toggles and a live city-average read-out.
 * Statistics only appear when the owning module has written them — nothing is estimated here.
 *
 * Emits `infoview:changed { view, buildings, terrain }` for the overlay renderers and, for service
 * coverage views, drives the simulation's coverage overlay via world.services.api.setInfoView().
 */
export function createInfoView(hud) {
  const { world, events, tooltip } = hud;
  const opts = { buildings: true, terrain: true };
  let view = null;

  const iconEl = h('div.fc-legend-icon');
  const titleEl = h('div.fc-legend-title');
  const descEl = h('div.fc-legend-desc');
  const closeBtn = h('button.fc-info-close', { 'aria-label': 'Close info view', onClick: () => hud.selectTool('select', {}) }, svg(icon('close')));
  tooltip.attach(closeBtn, { icon: 'close', title: 'Close info view', key: 'Esc' });
  const head = h('div.fc-legend-head', iconEl, h('div.fc-info-titles', h('div.fc-info-kind', h('span.txt', 'Info view')), titleEl), closeBtn);

  const gradBar = h('div.fc-legend-grad');
  const marker = h('i.fc-legend-marker');
  const gradLow = h('span.lo'), gradHigh = h('span.hi');
  const gradWrap = h('div.fc-legend-scale', h('div.fc-legend-bar', gradBar, marker), h('div.fc-legend-labels', gradLow, gradHigh));
  const chips = h('div.fc-legend-chips');

  const avgV = h('b');
  const avgRow = h('div.fc-legend-avg', h('span', 'City average'), avgV);
  const stats = h('div.fc-legend-stats');

  const toggles = h('div.fc-legend-toggles');
  const tBuildings = toggleBtn('buildingsView', 'Colour buildings', 'buildings');
  const tTerrain = toggleBtn('terrain', 'Colour terrain', 'terrain');
  toggles.append(tBuildings, tTerrain);
  function toggleBtn(ic, label, key) {
    const b = h('button.fc-check', { role: 'checkbox', 'aria-checked': 'true' }, h('span.box', svg(icon('check'))), svg(icon(ic)), h('span', label));
    b.addEventListener('click', () => { opts[key] = !opts[key]; refreshToggles(); emit(); });
    return b;
  }
  function refreshToggles() {
    setClass(tBuildings, 'is-on', opts.buildings); tBuildings.setAttribute('aria-checked', String(opts.buildings));
    setClass(tTerrain, 'is-on', opts.terrain); tTerrain.setAttribute('aria-checked', String(opts.terrain));
  }

  const foot = h('div.fc-legend-foot', h('span', h('kbd.fc-kbd', 'Tab'), ' next view'), h('span', h('kbd.fc-kbd', 'Esc'), ' close'));
  const el = h('div.fc-panel.fc-legend', { role: 'region', 'aria-label': 'Info view legend' }, head, descEl, gradWrap, chips, avgRow, stats, toggles, foot);
  hud.leftStack.prepend(el); // the armed tool's legend sits above the selection panel

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  function statValue(def) {
    if (!def.stat) return null;
    const parts = def.stat.split('.');
    let v = world.economy;
    for (const p of parts) v = v == null ? undefined : v[p];
    return num(v) ? Math.max(0, Math.min(1, v)) : null;
  }
  function meanCoverage() {
    const c = world.economy.coverage;
    if (!c || typeof c !== 'object') return null;
    const vals = Object.values(c).filter(num);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function serviceStats(id) {
    const api = world.services && world.services.api;
    if (!api || typeof api.stats !== 'function') return null;
    try { const s = api.stats(); return s && s[id] ? s[id] : null; } catch { return null; }
  }
  const pctCls = (v, invert) => { const good = invert ? v < 0.35 : v > 0.65, bad = invert ? v > 0.7 : v < 0.4; return good ? 'is-good' : bad ? 'is-bad' : 'is-warn'; };

  /** Live rows for the current view: [{ k, v, cls? }] — only values the simulation actually produced. */
  function statRows(id, def) {
    const eco = world.economy || {};
    const cov = eco.coverage || {};
    const rows = [];
    const push = (k, v, cls, cond = true) => { if (cond && v != null) rows.push({ k, v, cls }); };
    if (def.service) {
      const s = serviceStats(def.service);
      if (s) {
        const noun = def.service === 'power' ? 'Power plants' : def.service === 'water' ? 'Water towers' : 'Facilities';
        push(noun, fmtInt(s.count), s.count > 0 ? '' : 'is-bad', num(s.count));
        push('Capacity', num(s.capacity) ? `${fmtInt(s.capacity)} citizens` : null);
        push('Demand', num(s.demand) ? `${fmtInt(s.demand)} citizens` : null);
        if (num(s.strain) && num(s.count) && s.count > 0) push('Supply', fmtPct(s.strain), s.strain >= 0.95 ? 'is-good' : s.strain >= 0.7 ? 'is-warn' : 'is-bad');
      }
      if (def.service === 'water' && num(cov.sewage)) push('Sewage coverage', fmtPct(cov.sewage), pctCls(cov.sewage));
    } else if (id === 'traffic') {
      const tr = world.traffic || {};
      const veh = num(tr.vehicles) ? tr.vehicles : Array.isArray(tr.vehicles) ? tr.vehicles.length : num(tr.vehicleCount) ? tr.vehicleCount : null;
      push('Vehicles', veh != null ? fmtInt(veh) : null);
      const segs = world.roads && world.roads.segments;
      if (segs && typeof segs.size === 'number') {
        let km = 0; for (const s of segs.values()) km += num(s.length) ? s.length : 0;
        push('Road network', `${fmtInt(segs.size)} segments · ${(km / 1000).toFixed(1)} km`);
      }
      push('Congestion', num(eco.congestion) ? fmtPct(eco.congestion) : null, num(eco.congestion) ? pctCls(eco.congestion, true) : '');
    } else if (id === 'landvalue') {
      push('Happiness', num(eco.happiness) ? fmtPct(eco.happiness) : null, num(eco.happiness) ? pctCls(eco.happiness) : '');
      const mc = meanCoverage(); push('Service coverage', mc != null ? fmtPct(mc) : null, mc != null ? pctCls(mc) : '');
      push('Pollution', num(eco.pollution) ? fmtPct(eco.pollution) : null, num(eco.pollution) ? pctCls(eco.pollution, true) : '');
    } else if (id === 'pollution') {
      const lots = (world.zones && world.zones.lots) || [];
      if (lots.length) push('Industrial lots', fmtInt(lots.filter((l) => l.type === 'ind').length));
      push('Garbage coverage', num(cov.garbage) ? fmtPct(cov.garbage) : null, num(cov.garbage) ? pctCls(cov.garbage) : '');
      push('Sewage coverage', num(cov.sewage) ? fmtPct(cov.sewage) : null, num(cov.sewage) ? pctCls(cov.sewage) : '');
    } else if (id === 'happiness') {
      push('Unemployment', num(eco.unemployment) ? fmtPct(eco.unemployment) : null, num(eco.unemployment) ? pctCls(eco.unemployment, true) : '');
      push('Education', num(eco.education) ? fmtPct(eco.education) : null, num(eco.education) ? pctCls(eco.education) : '');
      const mc = meanCoverage(); push('Service coverage', mc != null ? fmtPct(mc) : null, mc != null ? pctCls(mc) : '');
    } else if (id === 'zoning') {
      const lots = (world.zones && world.zones.lots) || [];
      push('Zoned lots', fmtInt(lots.length));
      if (lots.length) push('Built', `${fmtInt(lots.filter((l) => l.buildingId != null).length)} of ${fmtInt(lots.length)}`);
      const bl = (world.buildings && world.buildings.list) || [];
      if (bl.length) push('Buildings', fmtInt(bl.length));
    }
    return rows;
  }

  function render() {
    const def = INFO_VIEWS[view];
    if (!def) return;
    el.style.setProperty('--cat', def.color || 'var(--fc-accent)');
    const pic = viewThumb(view);
    iconEl.classList.toggle('has-thumb', !!pic);
    iconEl.innerHTML = pic || `<span class="fc-icon">${icon(def.icon)}</span>`;
    setText(titleEl, def.label);
    setText(descEl, def.desc);
    const lg = def.legend || {};
    if (lg.stops) {
      gradWrap.style.display = '';
      chips.style.display = 'none';
      gradBar.style.background = `linear-gradient(90deg, ${lg.stops.join(', ')})`;
      setText(gradLow, lg.low || 'Low');
      setText(gradHigh, lg.high || 'High');
    } else {
      gradWrap.style.display = 'none';
      chips.style.display = '';
      renderChips(lg);
    }
    refreshStat();
    refreshToggles();
  }
  function renderChips(lg) {
    clear(chips);
    const lots = (world.zones && world.zones.lots) || [];
    for (const c of lg.chips || []) {
      const n = lots.length ? lots.filter((l) => l.type === c.id).length : null;
      chips.appendChild(h('span.fc-legend-chip', h('i.fc-chip', { style: { '--chip': c.color } }), h('span.txt', (ZONE_LABELS[c.id] || c.label).replace('Low Density ', 'Low ').replace('High Density ', 'High ')), n != null ? h('b', fmtInt(n)) : null));
    }
  }
  let lastRowsKey = '';
  function refreshStat() {
    const def = INFO_VIEWS[view];
    if (!def) return;
    const v = statValue(def);
    if (v == null) { avgRow.style.display = 'none'; marker.style.display = 'none'; }
    else {
      avgRow.style.display = '';
      marker.style.display = '';
      marker.style.left = `${Math.round(v * 100)}%`;
      setText(avgV, fmtPct(v));
      const good = def.invert ? v < 0.35 : v > 0.65;
      const bad = def.invert ? v > 0.7 : v < 0.4;
      setClass(avgV, 'is-good', good); setClass(avgV, 'is-bad', bad); setClass(avgV, 'is-warn', !good && !bad);
    }
    const rows = statRows(view, def);
    const key = rows.map((r) => `${r.k}=${r.v}|${r.cls || ''}`).join(';');
    if (key !== lastRowsKey) {
      lastRowsKey = key;
      clear(stats);
      for (const r of rows) stats.appendChild(h('div.row', h('span.k', r.k), h('b', { class: 'v ' + (r.cls || '') }, r.v)));
      stats.style.display = rows.length ? '' : 'none';
    }
    if (!def.legend || !def.legend.stops) renderChips(def.legend || {});
  }

  function emit() {
    events.emit('infoview:changed', { view, buildings: opts.buildings, terrain: opts.terrain });
  }
  function driveSimulation(id) {
    const api = world.services && world.services.api;
    if (!api || typeof api.setInfoView !== 'function') return;
    try { api.setInfoView(id); } catch (err) { console.warn('[ui] services.setInfoView failed', err && err.message); }
  }

  function show(id) {
    if (!INFO_VIEWS[id]) return hide();
    view = id;
    lastRowsKey = '';
    render();
    el.classList.add('is-open');
    const def = INFO_VIEWS[id];
    driveSimulation(def.service || null);
    emit();
  }
  function hide() {
    if (!view) return;
    view = null;
    el.classList.remove('is-open');
    driveSimulation(null);
    emit();
  }

  return { el, show, hide, refresh: refreshStat, get isOpen() { return !!view; }, get view() { return view; } };
}
