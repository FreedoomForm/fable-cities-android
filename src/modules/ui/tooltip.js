import { h, svg, clear, fmtMoney, hudZoom, zoomRect } from './dom.js';
import { icon } from './icons.js';

/**
 * Single shared tooltip. `attach(el, content)` where content is an object or a function returning
 * { icon, title, key, desc, cost, unit, upkeep, per, stats:[], rows:[{k,v,cls}], color, progress } or a plain string.
 *
 * Placement rules (Cities: Skylines II): a tooltip never covers sibling UI. Anchors inside the bottom
 * sub-menu tray or the dock are lifted above the whole tray/dock panel; everything else sits above the
 * anchor, or below it when there is no room; while the settings drawer is open a tooltip that would land
 * on it is pushed to the drawer's left. The arrow always points at the anchor's centre.
 *
 * Layering: modal overlays call `suspend(true)` — the tooltip hides, releases any pin and ignores hover
 * until `suspend(false)`. `setEnabled` is the user preference (Settings → Tooltips).
 */
export function createTooltip(hud) {
  const el = h('div.fc-tooltip', { role: 'tooltip' });
  hud.root.appendChild(el);
  let timer = 0, current = null, currentContent = null, pinned = null, lastHide = 0, enabled = true, suspended = false;

  function build(content) {
    clear(el);
    el.style.setProperty('--tt', content && content.color ? content.color : 'var(--fc-accent-2)');
    if (typeof content === 'string') {
      el.appendChild(h('div.fc-tt-simple', content));
      return;
    }
    const head = h('div.fc-tt-head');
    if (content.icon) head.appendChild(h('span.fc-tt-icon', svg(icon(content.icon))));
    head.appendChild(h('div.fc-tt-title', content.title || ''));
    if (content.key) head.appendChild(h('span.fc-tt-key', content.key));
    el.appendChild(head);
    if (content.desc) el.appendChild(h('div.fc-tt-desc', content.desc));
    if (content.stats && content.stats.length) el.appendChild(h('div.fc-tt-stats', content.stats.map((s) => h('span', s))));
    if (content.cost != null) {
      const free = content.cost === 0;
      el.appendChild(h('div.fc-tt-row', h('span.k', 'Cost'), h('span', { class: 'v ' + (free ? 'free' : 'cost') }, free ? 'Free' : fmtMoney(content.cost) + (content.unit || ''))));
    }
    if (content.upkeep) el.appendChild(h('div.fc-tt-row', h('span.k', 'Upkeep'), h('span.v.upkeep', `${fmtMoney(-content.upkeep)} / ${content.per || periodOf(hud.world)}`)));
    // `per` rows already carry their own unit ('−₡4/m'), so the period is joined with a middot, never a second slash.
    if (content.rows) for (const r of content.rows) el.appendChild(h('div.fc-tt-row', h('span.k', r.k), h('span', { class: 'v ' + (r.cls || '') }, r.per ? `${r.v} · ${periodOf(hud.world)}` : r.v)));
    if (content.progress != null) el.appendChild(h('div.fc-tt-progress', h('i', { style: { width: `${Math.round(Math.max(0, Math.min(1, content.progress)) * 100)}%` } })));
  }

  /** True when the anchor is gone or invisible (tray rebuilt / closed, panel hidden). */
  function detached(target) {
    return !target || !target.isConnected || target.offsetParent === null;
  }

  function place(target) {
    // The HUD is scaled with CSS `zoom` (--fc-scale); client rects come back in screen px, our own
    // style px are HUD px → divide every measured rect by the zoom factor.
    const z = hudZoom(hud.root);
    const r = zoomRect(target.getBoundingClientRect(), z);
    const vw = window.innerWidth / z, vh = window.innerHeight / z;
    const w = el.offsetWidth, hgt = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(vw - w - 8, x));
    let y = r.top - hgt - 12;
    let below = false;
    // Lift above the bottom UI so the tray header / the open tray is never occluded.
    const tray = hud.toolbar && hud.toolbar.tray;
    const inTray = target.closest('.fc-tray');
    const inDock = target.closest('.fc-dock');
    if (inTray) y = Math.min(y, inTray.getBoundingClientRect().top / z - hgt - 10);
    else if (inDock && tray && tray.classList.contains('is-open')) y = Math.min(y, tray.getBoundingClientRect().top / z - hgt - 10);
    if (y < 8) { y = r.bottom + 12; below = true; }
    if (below && y + hgt > vh - 8) y = vh - hgt - 8;
    // Never land on the open settings drawer unless the anchor lives inside it.
    const settings = hud.settings && hud.settings.isOpen ? hud.settings.el : null;
    if (settings && !target.closest('.fc-settings')) {
      const s = zoomRect(settings.getBoundingClientRect(), z);
      const overlaps = x < s.right && x + w > s.left && y < s.bottom && y + hgt > s.top;
      if (overlaps) x = Math.max(8, s.left - w - 10);
    }
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.setProperty('--fc-arrow-x', `${Math.round(Math.max(14, Math.min(w - 14, r.left + r.width / 2 - x)))}px`);
    el.classList.toggle('is-below', below);
    el.classList.toggle('is-lifted', !below && r.top - (y + hgt) > 28);
  }

  function show(target, content) {
    if (suspended) return;
    if (!enabled && !pinned) return;
    if (detached(target)) return;
    current = target;
    currentContent = content;
    build(typeof content === 'function' ? content() : content);
    el.classList.add('is-visible');
    place(target);
  }
  function hide(force) {
    if (pinned && !force) return;
    clearTimeout(timer);
    timer = 0;
    current = null;
    currentContent = null;
    el.classList.remove('is-visible');
    lastHide = performance.now();
  }

  function attach(target, content) {
    target.addEventListener('mouseenter', () => {
      if (pinned || suspended) return;
      clearTimeout(timer);
      const quick = performance.now() - lastHide < 350;
      timer = setTimeout(() => show(target, content), quick ? 40 : 320);
    });
    target.addEventListener('mouseleave', () => { if (!pinned) hide(); });
    target.addEventListener('mousedown', () => { if (!pinned) hide(); });
    target.__fcTip = content;
    return target;
  }

  /** Keep a tooltip open (used by the showcase). `pin(null)` releases; a pin auto-releases when its anchor disappears. */
  function pin(target, content) {
    pinned = target || null;
    if (target) show(target, content || target.__fcTip || '');
    else hide(true);
  }

  /** Per-frame guard: release pins whose anchor vanished, keep the visible tooltip glued to its anchor. */
  function tick() {
    if (pinned && detached(pinned)) { pinned = null; hide(true); return; }
    if (current && el.classList.contains('is-visible')) {
      if (detached(current)) hide(true);
      else place(current);
    }
  }

  return {
    el, attach, show, hide, pin, tick,
    get pinned() { return pinned; },
    get suspended() { return suspended; },
    setEnabled(v) { enabled = !!v; if (!v) hide(true); },
    /** Modal overlays: hide, release any pin and ignore hover until resumed. */
    suspend(v) { suspended = !!v; if (suspended) { pinned = null; hide(true); } },
    refresh() { if (current && currentContent && el.classList.contains('is-visible')) show(current, currentContent); },
    reposition() { tick(); },
  };
}

/** Budget period label from the simulation ('week' | 'month'). */
export function periodOf(world) {
  const p = world && world.economy && world.economy.period;
  return p === 'week' || p === 'month' || p === 'day' || p === 'year' ? p : 'month';
}
