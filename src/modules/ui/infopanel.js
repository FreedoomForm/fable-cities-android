import { h, svg, setText, clear, fmtInt, fmtPct, fmtMoney } from './dom.js';
import { icon } from './icons.js';
import { ZONE_COLORS, ZONE_LABELS, ZONE_SHORT, ROAD_TYPES, SERVICES } from './catalog.js';
import { periodOf } from './tooltip.js';
import { thumb } from './thumbs.js';
import { streetName, districtName, buildingName, debugId } from './names.js';

const ZONE_ICON = { 'res-low': 'house', 'res-high': 'apartments', 'com-low': 'shop', 'com-high': 'tower', ind: 'industry', office: 'office' };
const SERVICE_ALIAS = { 'power-plant': 'power', 'water-tower': 'water', clinic: 'health', school: 'education', landfill: 'garbage' };
const SERVICE_ORDER = ['power', 'water', 'sewage', 'garbage', 'police', 'fire', 'health', 'education'];

/**
 * Selected-entity info panel (left side). `show(selectionOrEntity)`, `hide()`.
 * Accepts `{ kind, id }` (looked up in world), a raw building / segment / lot / service record, or a
 * pre-described view model. Every value shown is read from the record or the live simulation — a field
 * the simulation has not produced yet renders as '—' (or is omitted), never as a plausible sample.
 */
export function createInfoPanel(hud) {
  const { world } = hud;

  const iconEl = h('div.fc-info-icon');
  const kindEl = h('div.fc-info-kind');
  const titleEl = h('div.fc-info-title');
  const subEl = h('div.fc-info-sub');
  const closeBtn = h('button.fc-info-close', { 'aria-label': 'Close', onClick: () => hud.deselect() }, svg(icon('close')));
  const head = h('div.fc-info-head', iconEl, h('div.fc-info-titles', kindEl, titleEl, subEl), closeBtn);
  const levelRow = h('div.fc-level');
  const grid = h('div.fc-info-grid');
  const svcRow = h('div.fc-svc');
  const foot = h('div.fc-info-foot');
  const el = h('div.fc-panel.fc-info', { role: 'dialog', 'aria-label': 'Selection' }, head, levelRow, grid, svcRow, foot);
  (hud.leftStack || hud.root).appendChild(el);
  hud.tooltip.attach(closeBtn, { icon: 'close', title: 'Close', key: 'Esc' });

  let current = null;
  const per = () => periodOf(world);

  function cell(k, v, { icon: ic, cls, small, bar, barColor, span } = {}) {
    return h('div', { class: 'fc-cell' + (span ? ' span2' : '') },
      h('div.fc-cell-k', ic ? svg(icon(ic)) : null, k),
      h('div', { class: 'fc-cell-v' + (cls ? ' ' + cls : '') }, h('span.val', v), small ? h('small', small) : null),
      bar != null ? h('div.fc-bar', { style: barColor ? { '--bar': barColor } : null }, h('i', { style: { width: `${Math.round(Math.max(0, Math.min(1, bar)) * 100)}%` } })) : null,
    );
  }
  const happyCls = (v) => (v >= 0.65 ? 'is-good' : v >= 0.4 ? 'is-warn' : 'is-bad');
  const happyColor = (v) => (v >= 0.65 ? '#6fe08c' : v >= 0.4 ? '#ffc247' : '#ff6b6b');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  /** Normalise anything into a view model. */
  function describe(sel) {
    if (!sel) return null;
    if (sel.__view) return sel;
    let kind = sel.kind, ent = sel.entity || null;
    if (!ent) {
      if (kind && sel.id != null && !('type' in sel) && !('cells' in sel)) {
        if (kind === 'building') ent = (world.buildings.list || []).find((b) => b.id === sel.id) || null;
        else if (kind === 'road') ent = world.roads.segments.get(sel.id) || null;
        else if (kind === 'lot') ent = (world.zones.lots || []).find((l) => l.id === sel.id) || null;
        else if (kind === 'service') ent = ((world.services && world.services.list) || []).find((s) => s.id === sel.id) || null;
        if (!ent) return { __view: true, kind, icon: 'target', title: `${kind[0].toUpperCase() + kind.slice(1)} #${sel.id}`, sub: 'Details unavailable', fields: [] };
      } else {
        ent = sel;
        if (!kind) kind = 'a' in ent && 'b' in ent ? 'road' : 'cells' in ent ? 'lot' : isServiceRecord(ent) ? 'service' : 'lotId' in ent || 'floors' in ent || 'residents' in ent ? 'building' : 'entity';
      }
    }
    if (kind === 'building' && isServiceRecord(ent)) kind = 'service';
    if (kind === 'building') return describeBuilding(ent);
    if (kind === 'service') return describeService(ent);
    if (kind === 'road') return describeRoad(ent);
    if (kind === 'lot') return describeLot(ent);
    return { __view: true, kind, icon: 'target', title: ent.name || ent.label || `${kind} #${ent.id ?? ''}`, sub: ent.desc || '', fields: [], entity: ent };
  }
  function isServiceRecord(b) {
    return !!b && (b.kind === 'service' || (num(b.radius) && num(b.capacity) && (SERVICES[b.type] || SERVICES[SERVICE_ALIAS[b.type]])));
  }

  /** Service coverage at a point — only when the simulation exposes it. → { id: 0..1 } | null */
  function coverageAt(x, z) {
    const api = world.services && world.services.api;
    if (!api || typeof api.coverageAt !== 'function' || !num(x) || !num(z)) return null;
    try {
      const c = api.coverageAt(x, z);
      if (!c || typeof c !== 'object') return null;
      const out = {};
      for (const id of SERVICE_ORDER) if (num(c[id])) out[id] = c[id];
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  function describeBuilding(b) {
    const type = b.type || 'res-low';
    const zoneLabel = ZONE_LABELS[type] || b.typeLabel || b.name || type;
    const level = Math.max(1, Math.min(5, b.level || 1));
    const built = b.state !== 'construction';
    const happiness = num(b.happiness) ? b.happiness : null;
    const isRes = type.startsWith('res');
    const fields = [];
    const res = b.residents || 0, jobs = b.jobs || 0;
    if (isRes) fields.push({ k: 'Residents', v: fmtInt(res), icon: 'people', small: b.households ? `${fmtInt(b.households)} households` : num(b.capacity) ? `/ ${fmtInt(b.capacity)}` : null, bar: num(b.capacity) && b.capacity > 0 ? res / b.capacity : null, barColor: ZONE_COLORS[type] });
    else fields.push({ k: 'Jobs', v: fmtInt(jobs), icon: 'jobs', small: num(b.workers) ? `${fmtInt(b.workers)} filled` : null, bar: jobs && num(b.workers) ? b.workers / jobs : null, barColor: ZONE_COLORS[type] || '#4fc3f7' });
    if (happiness != null) fields.push({ k: 'Happiness', v: fmtPct(happiness), icon: 'happiness', cls: happyCls(happiness), bar: happiness, barColor: happyColor(happiness) });
    if (isRes && jobs) fields.push({ k: 'Jobs', v: fmtInt(jobs), icon: 'jobs' });
    if (!isRes && res) fields.push({ k: 'Residents', v: fmtInt(res), icon: 'people' });
    const floors = num(b.floors) ? b.floors : num(b.height) ? Math.max(1, Math.round(b.height / 3.2)) : null;
    if (floors != null) fields.push({ k: 'Floors', v: fmtInt(floors), icon: 'tower' });
    if (num(b.height)) fields.push({ k: 'Height', v: `${Math.round(b.height)}`, icon: 'ruler', small: 'm' });
    if (num(b.w) && num(b.d)) fields.push({ k: 'Footprint', v: `${Math.round(b.w)} × ${Math.round(b.d)}`, icon: 'grid', small: 'm' });
    if (num(b.landValue)) fields.push({ k: 'Land value', v: fmtMoney(b.landValue), icon: 'landvalue' });
    if (num(b.upkeep)) fields.push({ k: 'Upkeep', v: fmtMoney(-b.upkeep), icon: 'coin', cls: 'is-bad', small: `/ ${per()}` });
    if (num(b.taxes)) fields.push({ k: 'Taxes', v: fmtMoney(b.taxes), icon: 'taxes', cls: 'is-good', small: `/ ${per()}` });
    if (num(b.education)) fields.push({ k: 'Education', v: fmtPct(b.education), icon: 'education', bar: b.education, barColor: '#ffa726' });
    if (!built) fields.push({ k: 'Construction', v: fmtPct(b.progress || 0), icon: 'crane', cls: 'is-warn', bar: b.progress || 0, barColor: '#ffc247', span: true });
    const district = districtName(b.x, b.z);
    return {
      __view: true, kind: 'building', entity: b,
      icon: ZONE_ICON[type] || 'tower', thumb: ZONE_LABELS[type] ? type : null, chip: ZONE_COLORS[type] || '#4fc3f7',
      kindLabel: ZONE_SHORT[type] || zoneLabel,
      title: buildingName(b, zoneLabel),
      sub: (built ? `Level ${level}` : 'Under construction') + (district ? ` · ${district}` : '') + debugId(b.id != null ? `#${b.id}` : null, b.lotId != null ? `lot ${b.lotId}` : null),
      level, levelProgress: num(b.levelProgress) ? b.levelProgress : null, // no progress bar unless the simulation tracks it
      fields, services: coverageAt(b.x, b.z),
      focus: num(b.x) && num(b.z) ? { x: b.x, z: b.z, size: Math.max(b.w || 20, b.d || 20, b.height || 10) } : null,
    };
  }
  /** City service building (world.services.list record). */
  function describeService(s) {
    const id = SERVICES[s.type] ? s.type : SERVICE_ALIAS[s.type] || s.type;
    const def = SERVICES[id] || {};
    const eff = num(s.efficiency) ? Math.max(0, Math.min(1, s.efficiency)) : null;
    const fields = [];
    if (eff != null) fields.push({ k: 'Efficiency', v: fmtPct(eff), icon: 'efficiency', cls: eff >= 0.85 ? 'is-good' : eff >= 0.6 ? 'is-warn' : 'is-bad', bar: eff, barColor: eff >= 0.85 ? '#6fe08c' : eff >= 0.6 ? '#ffc247' : '#ff6b6b' });
    fields.push({ k: 'Capacity', v: num(s.capacity) ? fmtInt(s.capacity) : '—', icon: 'people', small: num(s.capacity) ? 'citizens' : null });
    fields.push({ k: 'Workers', v: num(s.workers) ? fmtInt(s.workers) : '—', icon: 'jobs', small: num(s.staff) ? `${fmtInt(s.staff)} present` : null });
    fields.push({ k: 'Range', v: num(s.radius) ? fmtInt(s.radius) : '—', icon: 'target', small: 'm' });
    if (num(s.upkeep)) fields.push({ k: 'Upkeep', v: fmtMoney(-s.upkeep), icon: 'coin', cls: 'is-bad', small: `/ ${per()}` });
    if (num(def.cost)) fields.push({ k: 'Build cost', v: fmtMoney(def.cost), icon: 'coin' });
    if (s.state && s.state !== 'built' && s.state !== 'active') fields.push({ k: 'Status', v: String(s.state), icon: 'crane', cls: 'is-warn', span: true });
    const district = districtName(s.x, s.z);
    return {
      __view: true, kind: 'service', entity: s, icon: def.icon || 'services', thumb: SERVICES[id] ? id : null, chip: def.color || '#4fc3f7', kindLabel: 'City service',
      title: s.name || def.label || id, sub: `${def.label || id}${district ? ` · ${district}` : ''}${debugId(s.id != null ? `#${s.id}` : null)}`,
      fields, focus: num(s.x) && num(s.z) ? { x: s.x, z: s.z, size: Math.max(s.w || 30, s.d || 30, s.height || 10) } : null,
    };
  }

  function describeRoad(s) {
    const t = ROAD_TYPES[s.type] || {};
    const len = num(s.length) ? s.length : s.points ? polyLength(s.points) : 0;
    const lanes = (s.lanes && s.lanes.length) || t.lanes;
    const speed = s.speed || t.speed;
    const traffic = num(s.traffic) ? Math.max(0, Math.min(1, s.traffic)) : null;
    const fields = [
      { k: 'Length', v: `${Math.round(len)}`, small: 'm', icon: 'ruler' },
      { k: 'Lanes', v: lanes != null ? `${lanes}` : '—', icon: 'traffic', small: speed ? `${speed} km/h` : null },
      { k: 'Width', v: num(s.width) || t.width ? `${Math.round(s.width || t.width)}` : '—', small: 'm', icon: 'avenue' },
    ];
    if (traffic != null) fields.push({ k: 'Traffic', v: fmtPct(traffic), icon: 'traffic', cls: traffic > 0.7 ? 'is-bad' : traffic > 0.4 ? 'is-warn' : 'is-good', bar: traffic, barColor: traffic > 0.7 ? '#ff6b6b' : traffic > 0.4 ? '#ffc247' : '#6fe08c' });
    else if (t.capacity) fields.push({ k: 'Capacity', v: fmtInt(t.capacity), icon: 'traffic', small: 'veh/h' });
    const conn = connections(s);
    if (conn != null) fields.push({ k: 'Junctions', v: `${conn.a} · ${conn.b}`, icon: 'crossroads', small: 'roads per end' });
    if (t.cost) fields.push({ k: 'Build cost', v: fmtMoney(t.cost * len), icon: 'coin', small: `${fmtMoney(t.cost)}/m`, span: conn == null });
    const p = s.points && s.points.length ? s.points[Math.floor(s.points.length / 2)] : null;
    const district = p ? districtName(p.x, p.z) : null;
    return {
      __view: true, kind: 'road', entity: s, icon: t.icon || 'road', thumb: ROAD_TYPES[s.type] ? s.type : null, chip: t.color || '#9fb3c8',
      kindLabel: t.kind || 'Road', title: streetName(s),
      sub: `${t.label || s.type || 'Road'}${district ? ` · ${district}` : ''}${debugId(s.id, s.a != null ? `${s.a} → ${s.b}` : null)}`,
      fields, focus: p ? { x: p.x, z: p.z, size: Math.max(40, len) } : null,
    };
  }
  function connections(s) {
    const nodes = world.roads && world.roads.nodes;
    if (!nodes || typeof nodes.get !== 'function') return null;
    const a = nodes.get(s.a), b = nodes.get(s.b);
    if (!a || !b || !Array.isArray(a.segments) || !Array.isArray(b.segments)) return null;
    return { a: Math.max(0, a.segments.length - 1), b: Math.max(0, b.segments.length - 1) };
  }
  function polyLength(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return l;
  }

  function describeLot(l) {
    const type = l.type || 'res-low';
    const short = (s) => s.replace('Low Density ', 'Low ').replace('High Density ', 'High ');
    const fields = [
      { k: 'Zone', v: ZONE_LABELS[type] ? short(ZONE_LABELS[type]) : type, icon: ZONE_ICON[type] || 'zone' },
      { k: 'Size', v: num(l.w) && num(l.d) ? `${Math.round(l.w)} × ${Math.round(l.d)}` : '—', small: 'm', icon: 'ruler' },
      { k: 'Cells', v: fmtInt(l.cells ? l.cells.length : 0), icon: 'grid' },
      { k: 'Status', v: l.buildingId != null ? 'Occupied' : 'Vacant', icon: 'crane', cls: l.buildingId != null ? 'is-good' : 'is-warn' },
    ];
    const road = l.roadSegmentId != null && world.roads.segments.get(l.roadSegmentId);
    if (road) fields.push({ k: 'Frontage', v: streetName(road), icon: 'road', small: (ROAD_TYPES[road.type] || {}).label || road.type || 'Road', span: true });
    const district = districtName(l.x, l.z);
    return {
      __view: true, kind: 'lot', entity: l, icon: 'zone', thumb: ZONE_LABELS[type] ? type : null, chip: ZONE_COLORS[type] || '#4fc3f7', kindLabel: 'Zoned lot',
      title: `${ZONE_LABELS[type] ? short(ZONE_LABELS[type]) : type} lot`,
      sub: `${road ? streetName(road) : 'No road access'}${district ? ` · ${district}` : ''}${debugId(l.id != null ? `lot ${l.id}` : null, l.roadSegmentId != null ? `road ${l.roadSegmentId}` : null)}`,
      fields, services: coverageAt(l.x, l.z), focus: num(l.x) && num(l.z) ? { x: l.x, z: l.z, size: Math.max(l.w || 16, l.d || 16) * 2 } : null,
    };
  }

  function renderServices(cov) {
    clear(svcRow);
    if (!cov) { svcRow.classList.remove('is-on'); return; }
    const ids = SERVICE_ORDER.filter((id) => id in cov);
    const served = ids.filter((id) => cov[id] >= 0.5).length;
    svcRow.appendChild(h('div.fc-svc-head', h('span', 'Services'), h('b', { class: served === ids.length ? 'is-good' : served >= ids.length / 2 ? 'is-warn' : 'is-bad' }, `${served} / ${ids.length} covered`)));
    const chips = h('div.fc-svc-chips');
    for (const id of ids) {
      const def = SERVICES[id];
      const v = cov[id];
      const state = v >= 0.5 ? 'good' : v >= 0.2 ? 'warn' : 'bad';
      const c = h('div', { class: `fc-svc-chip is-${state}`, style: { '--chip': def.color } }, svg(icon(def.icon)), h('i.dot'));
      hud.tooltip.attach(c, () => ({ icon: def.icon, color: def.color, title: def.label, desc: v >= 0.5 ? 'Within range of a working facility.' : v >= 0.2 ? 'Weak coverage — the nearest facility is far or overloaded.' : 'No coverage here. Build one nearby.', rows: [{ k: 'Coverage', v: fmtPct(v), cls: v >= 0.5 ? 'free' : v >= 0.2 ? '' : 'upkeep' }], progress: v }));
      chips.appendChild(c);
    }
    svcRow.appendChild(chips);
    svcRow.classList.add('is-on');
  }

  function render(v) {
    current = v;
    el.style.setProperty('--chip', v.chip || '#4fc3f7');
    const pic = v.thumb ? thumb(v.thumb) : null;
    iconEl.classList.toggle('has-thumb', !!pic);
    iconEl.innerHTML = pic || `<span class="fc-icon">${icon(v.icon || 'target')}</span>`;
    clear(kindEl);
    if (v.chip) kindEl.appendChild(h('i.fc-chip', { style: { '--chip': v.chip } }));
    kindEl.appendChild(h('span.txt', v.kindLabel || v.kind || ''));
    setText(titleEl, v.title || '');
    setText(subEl, v.sub || '');
    clear(levelRow);
    if (v.level != null) {
      const stars = h('div.fc-stars');
      for (let i = 1; i <= 5; i++) stars.appendChild(svg(icon(i <= v.level ? 'star' : 'starOutline'), i <= v.level ? 'is-on' : ''));
      levelRow.append(h('span.fc-level-label', `Level ${v.level}`), stars);
      if (v.levelProgress != null) levelRow.append(h('div.fc-level-progress', h('i', { style: { width: `${Math.round(Math.max(0, Math.min(1, v.levelProgress)) * 100)}%` } })), h('span.fc-level-pct', v.level >= 5 ? 'MAX' : fmtPct(v.levelProgress)));
      else levelRow.append(h('span.fc-level-pct.is-muted', v.level >= 5 ? 'MAX' : 'of 5'));
      levelRow.style.display = '';
    } else levelRow.style.display = 'none';
    clear(grid);
    const fields = v.fields || [];
    const trailing = fields.length % 2 === 1 && !fields[fields.length - 1].span; // odd count → last cell spans the row
    fields.forEach((f, i) => grid.appendChild(cell(f.k, f.v, trailing && i === fields.length - 1 ? { ...f, span: true } : f)));
    grid.style.display = fields.length ? '' : 'none';
    renderServices(v.services || null);
    clear(foot);
    if (v.focus) {
      const b = h('button.fc-btn', { onClick: () => hud.focusOn(v.focus) }, svg(icon('camera')), 'Focus');
      hud.tooltip.attach(b, { icon: 'camera', title: 'Focus camera', desc: 'Fly the camera to this entity.' });
      foot.appendChild(b);
    }
    if (v.kind === 'building' || v.kind === 'road' || v.kind === 'lot' || v.kind === 'service') {
      const b = h('button.fc-btn.danger', { onClick: () => hud.selectTool('bulldoze', { target: { kind: v.kind, id: v.entity && v.entity.id } }) }, svg(icon('bulldoze')), 'Bulldoze');
      hud.tooltip.attach(b, { icon: 'bulldoze', title: 'Bulldoze', key: '4', desc: 'Arm the bulldozer on this entity. 50 % refund.' });
      foot.appendChild(b);
    }
    foot.style.display = foot.childElementCount ? '' : 'none';
    el.classList.add('is-open');
  }

  function show(sel) {
    const v = describe(sel);
    if (!v) return hide();
    render(v);
  }
  function hide() {
    current = null;
    el.classList.remove('is-open');
  }
  /** Re-read the live entity (called on sim ticks while open). */
  function refresh() {
    if (!current || !current.entity) return;
    const v = describe({ kind: current.kind, entity: current.entity });
    if (v) render(v);
  }

  return { el, show, hide, refresh, describe, get isOpen() { return el.classList.contains('is-open'); }, get current() { return current; } };
}
