import { h, svg, setText, setClass, fmtMoney, clear, hudZoom, zoomRect } from './dom.js';
import { icon } from './icons.js';
import { thumb, hasThumb } from './thumbs.js';
import { CATEGORIES, ZONE_COLORS } from './catalog.js';

const TOOL_TO_CAT = { road: 'roads', zone: 'zoning', service: 'services', bulldoze: 'bulldoze', info: 'info' };

/**
 * Bottom dock: colour-coded category buttons, sub-menu tray, RCI demand bars, active-tool pill and hints.
 */
export function createToolbar(hud) {
  const { world, tooltip } = hud;
  const state = { open: null, suppress: null, lastItem: {}, active: { tool: 'select', options: {} } };
  const catBtns = new Map();
  const itemBtns = new Map();

  // ---------- dock ----------
  const dock = h('div.fc-panel.fc-dock', { role: 'toolbar', 'aria-label': 'Build tools' });
  for (const cat of CATEGORIES) {
    const b = h('button', { class: `fc-cat${cat.hue ? ' hue-' + cat.hue : ''}`, style: { '--cat': cat.color }, 'aria-label': cat.label, onClick: () => toggleCategory(cat.id) },
      h('i.fc-cat-notch'), h('span.fc-cat-plate', svg(icon(cat.icon))), h('span.fc-cat-label', cat.label), h('span.fc-key', cat.key));
    tooltip.attach(b, () => ({ icon: cat.icon, color: cat.color, title: cat.label, key: cat.key, desc: cat.desc, stats: cat.items ? [`${cat.items.length} options`, 'Tab cycles'] : null }));
    catBtns.set(cat.id, b);
    dock.appendChild(b);
  }

  // ---------- tray ----------
  const trayIcon = svg(icon('road'));
  const trayTitle = h('div.fc-tray-title');
  const trayDesc = h('div.fc-tray-desc');
  const trayItems = h('div.fc-tray-items');
  const trayHead = h('div.fc-tray-head', trayIcon, trayTitle, trayDesc, h('span.fc-tray-hint', h('kbd.fc-kbd', 'Tab'), ' next'));
  const tray = h('div.fc-panel.fc-tray', trayHead, trayItems);

  function buildTray(cat) {
    tooltip.pin(null); // the pinned anchor (if any) is about to be destroyed
    clear(trayItems);
    itemBtns.clear();
    tray.style.setProperty('--cat', cat.color);
    trayIcon.innerHTML = icon(cat.icon);
    setText(trayTitle, cat.label);
    setText(trayDesc, cat.desc);
    for (const item of cat.items) {
      const chip = item.color || null;
      // only priced items carry a price chip; zoning (free) and info views (overlays) show a clean illustration
      const costEl = item.cost ? h('div.fc-item-cost', fmtMoney(item.cost, { compact: true }) + (item.unit || '')) : null;
      // CS2-style asset preview: an illustrated 88×50 diorama with the price pinned to its corner; glyph tile as fallback.
      const tid = item.thumbId || item.id; // info views keep their map previews under a 'view:' key
      const pic = hasThumb(tid)
        ? h('div.fc-item-thumb', { html: thumb(tid) }, h('i.fc-item-sheen'), costEl, chip ? h('i.fc-item-chipbar') : null)
        : h('div', { class: 'fc-item-icon' + (chip ? ' has-chip' : '') }, svg(icon(item.icon)), costEl, chip ? h('i.fc-item-chipbar') : null);
      const b = h('button', { class: 'fc-item', style: chip ? { '--chip': chip } : null, 'aria-label': item.label, onClick: () => pickItem(cat, item, { fromClick: true }) },
        pic, h('div.fc-item-label', shortLabel(item.label)));
      tooltip.attach(b, () => ({ icon: item.icon, color: item.color, title: item.label, desc: item.desc, cost: item.cost, unit: item.unit, upkeep: item.upkeep, stats: item.stats, rows: item.rows }));
      itemBtns.set(item.id, b);
      trayItems.appendChild(b);
    }
  }
  function shortLabel(label) {
    return label.replace('Low Density ', 'Low ').replace('High Density ', 'High ').replace('Neighbourhood ', '');
  }

  function positionArrow() {
    const catBtn = catBtns.get(state.open);
    if (!catBtn) return;
    const z = hudZoom(hud.root);
    const tr = zoomRect(tray.getBoundingClientRect(), z), cr = zoomRect(catBtn.getBoundingClientRect(), z);
    const x = cr.left + cr.width / 2 - tr.left;
    tray.style.setProperty('--fc-arrow-x', `${Math.max(20, Math.min(tr.width - 20, x))}px`);
  }

  /** The phone layout stacks the left sheet on top of the tray, so its height has to be a real number. */
  function publishTrayHeight() {
    const hgt = tray.classList.contains('is-open') ? Math.round(tray.offsetHeight) : 0;
    hud.root.style.setProperty('--fc-tray-h', `${hgt}px`);
  }

  function showTray(cat) {
    state.open = cat.id;
    buildTray(cat);
    tray.classList.add('is-open');
    hud.root.classList.add('tray-open');
    for (const [cid, b] of catBtns) setClass(b, 'is-open', cid === cat.id);
    requestAnimationFrame(() => { positionArrow(); publishTrayHeight(); });
  }
  function openCategory(id) {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (!cat) return;
    state.suppress = null; // explicit intent beats any earlier dismissal
    if (!cat.items) { // direct tool (bulldoze)
      closeTray();
      hud.selectTool(cat.tool, cat.options || {});
      return;
    }
    showTray(cat);
    // arm the last used item of this category
    const last = state.lastItem[id] || cat.items[0];
    const already = TOOL_TO_CAT[state.active.tool] === id;
    if (!already) pickItem(cat, last);
    else highlightActive();
  }
  /**
   * `keepArmed` closes the tray while its tool stays in hand (the player has started drawing, or picked
   * an item on a phone). The next `tool:changed` for that same category must then NOT spring it open
   * again, so remember which category was dismissed until the player arms something else.
   */
  function closeTray({ keepArmed = false } = {}) {
    const cat = keepArmed ? TOOL_TO_CAT[state.active.tool] || null : null;
    state.open = null;
    state.suppress = cat;
    tray.classList.remove('is-open');
    hud.root.classList.remove('tray-open');
    for (const b of catBtns.values()) b.classList.remove('is-open');
    tooltip.pin(null);
    tooltip.hide(true);
    publishTrayHeight();
  }
  function toggleCategory(id) {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (cat && !cat.items) { // direct tool toggles
      if (state.active.tool === cat.tool) hud.selectTool('select', {});
      else openCategory(id);
      return;
    }
    if (state.open === id) { closeTray(); hud.selectTool('select', {}); }
    else openCategory(id);
  }
  function pickItem(cat, item, { fromClick = false } = {}) {
    state.lastItem[cat.id] = item;
    hud.selectTool(item.tool, { ...item.options, label: item.label, icon: item.icon, color: item.color, cost: item.cost, unit: item.unit });
    // On a phone the tray, the dock and the tool pill together own half the screen. Once the player has
    // chosen, the choosing UI has no job left — give the map back. (Desktop keeps it open for browsing.)
    if (fromClick && hud.root.classList.contains('is-phone')) closeTray({ keepArmed: true });
  }
  /** Re-open the tray for whatever tool is in hand (Tab after the tray got out of the way). */
  function reopen() {
    if (state.open) return true;
    const cat = CATEGORIES.find((c) => c.id === TOOL_TO_CAT[state.active.tool]);
    if (!cat || !cat.items) return false;
    state.suppress = null;
    showTray(cat);
    highlightActive();
    return true;
  }
  function cycleItem(dir = 1) {
    if (!state.open && !reopen()) return;
    const cat = CATEGORIES.find((c) => c.id === state.open);
    if (!cat) return;
    const cur = cat.items.findIndex((it) => isItemActive(it));
    const next = cat.items[(cur + dir + cat.items.length) % cat.items.length];
    pickItem(cat, next);
  }
  function isItemActive(item) {
    const a = state.active;
    if (a.tool !== item.tool) return false;
    const o = a.options || {};
    if (item.options.type != null) return o.type === item.options.type;
    if (item.options.view != null) return o.view === item.options.view;
    return true;
  }
  function highlightActive() {
    const catId = TOOL_TO_CAT[state.active.tool];
    for (const [cid, b] of catBtns) setClass(b, 'is-active', cid === catId);
    const cat = CATEGORIES.find((c) => c.id === state.open);
    if (cat) for (const item of cat.items) setClass(itemBtns.get(item.id), 'is-active', isItemActive(item));
  }

  // ---------- demand (RCI) ----------
  const demandDefs = [['R', 'residential', ZONE_COLORS['res-low'], 'house', 'Residential demand', 'People want to move in — zone more housing.'], ['C', 'commercial', ZONE_COLORS['com-low'], 'shop', 'Commercial demand', 'Shops wanted — zone commercial near homes.'], ['I', 'industrial', ZONE_COLORS.ind, 'industry', 'Industrial demand', 'Factories wanted — jobs for uneducated workers.'], ['O', 'office', ZONE_COLORS.office, 'office', 'Office demand', 'Offices wanted — jobs for educated citizens.']];
  const dbars = [];
  const demandBars = h('div.fc-demand-bars');
  for (const [letter, key, color, ic, title, desc] of demandDefs) {
    const fill = h('i.fill');
    const bar = h('div.fc-dbar', { style: { '--chip': color } }, h('div.track', fill), h('span.letter', letter));
    tooltip.attach(bar, () => ({ icon: ic, color, title, desc, rows: [{ k: 'Demand', v: `${Math.round(((world.economy.demand || {})[key] || 0) * 100)} %` }] }));
    dbars.push({ key, fill, bar });
    demandBars.appendChild(bar);
  }
  const demand = h('div.fc-panel.fc-demand', h('div.fc-demand-title', 'Demand'), demandBars);
  function refreshDemand() {
    const d = world.economy.demand || {};
    for (const b of dbars) {
      const v = Math.max(0, Math.min(1, d[b.key] || 0));
      b.fill.style.height = `${Math.round(4 + v * 96)}%`;
      setClass(b.bar, 'is-high', v > 0.75);
    }
  }

  // ---------- active-tool pill ----------
  const tsIcon = h('div.fc-ts-icon', svg(icon('select')));
  const tsName = h('div.fc-ts-name');
  const tsSub = h('div.fc-ts-sub');
  const toolstate = h('div.fc-panel.fc-toolstate', tsIcon, h('div.fc-ts-body', tsName, tsSub), h('div.fc-ts-esc', h('kbd.fc-kbd', 'Esc'), 'cancel'));
  toolstate.addEventListener('click', () => hud.selectTool('select', {}));
  tooltip.attach(toolstate, { icon: 'select', title: 'Active tool', desc: 'Click (or press Esc) to return to the selection tool.' });

  function refreshToolState() {
    const { tool, options } = state.active;
    const cat = CATEGORIES.find((c) => c.id === TOOL_TO_CAT[tool]);
    const visible = tool && tool !== 'select';
    setClass(toolstate, 'is-visible', !!visible);
    setClass(toolstate, 'hue-danger', tool === 'bulldoze');
    if (!visible) return;
    const item = cat && cat.items ? cat.items.find((it) => (it.options.type != null && it.options.type === options.type) || (it.options.view != null && it.options.view === options.view)) : null;
    const label = options.label || (item && item.label) || (cat && cat.label) || tool;
    const ic = options.icon || (item && item.icon) || (cat && cat.icon) || 'select';
    toolstate.style.setProperty('--cat', options.color || (item && item.color) || (cat && cat.color) || 'var(--fc-accent-2)');
    tsIcon.innerHTML = `<span class="fc-icon">${icon(ic)}</span>`;
    setText(tsName, label);
    clear(tsSub);
    const cost = options.cost != null ? options.cost : item ? item.cost : null;
    if (cat) tsSub.appendChild(h('span', cat.label));
    if (cost != null) tsSub.appendChild(h('b', cost === 0 ? 'Free' : fmtMoney(cost) + (options.unit || (item && item.unit) || '')));
    else if (tool === 'bulldoze') tsSub.appendChild(h('span', '50 % refund'));
    else if (tool === 'info') tsSub.appendChild(h('span', 'Overlay'));
  }

  // ---------- hints ----------
  const hints = h('div.fc-panel.fc-hints',
    h('span', h('kbd', 'WASD'), ' Pan'), h('i.sep'),
    h('span', h('kbd', 'Wheel'), ' Zoom'), h('i.sep'),
    h('span.opt', h('kbd', 'Space'), ' Pause'), h('i.sep.opt'),
    h('button', { onClick: () => hud.shortcuts.toggle() }, h('kbd', '?'), ' All shortcuts'),
  );

  const el = h('div.fc-bottom', h('div.fc-bottom-left', demand), dock, h('div.fc-bottom-right', toolstate, hints));
  hud.root.appendChild(el);
  hud.root.appendChild(tray);

  function onToolChanged(tool, options) {
    state.active = { tool: tool || 'select', options: options || {} };
    const catId = TOOL_TO_CAT[state.active.tool];
    if (catId !== state.suppress) state.suppress = null;
    if (state.active.tool === 'select' && state.open) closeTray();
    else if (catId && catId !== state.open && catId !== state.suppress) {
      const cat = CATEGORIES.find((c) => c.id === catId);
      if (cat && cat.items) showTray(cat); // tool selected elsewhere (shortcut / debug API) → open its tray without re-selecting
      else if (state.open) closeTray();
    }
    highlightActive();
    refreshToolState();
  }

  // A tray parked over the middle of the map silently swallows the click a player aims at the ground
  // (measured: the audit's junction click landed on .fc-tray-desc and nothing happened, with no feedback).
  // The moment they start working in the world, the chooser gets out of the way; the tool stays armed
  // and the lit dock button plus the tool pill still say what is in hand.
  const canvas = hud.ctx && hud.ctx.renderer && hud.ctx.renderer.domElement;
  if (canvas) canvas.addEventListener('pointerdown', () => { if (state.open && state.active.tool !== 'select') closeTray({ keepArmed: true }); });

  refreshDemand();
  refreshToolState();
  window.addEventListener('resize', () => { positionArrow(); publishTrayHeight(); });
  return { el, tray, dock, demand, toolstate, hints, openCategory, closeTray, toggleCategory, cycleItem, reopen, refreshDemand, onToolChanged, get openId() { return state.open; }, get active() { return state.active; }, itemBtns, catBtns };
}
