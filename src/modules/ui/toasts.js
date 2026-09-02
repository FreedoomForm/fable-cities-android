import { h, svg, moneyNodes, setText, setClass, clear, fmtClock, fmtDate } from './dom.js';
import { icon } from './icons.js';

const TONE_ICON = { info: 'info', success: 'check', warning: 'warning', error: 'warning', money: 'coin', milestone: 'sparkle' };
const TONE_LIFE = { info: 6000, success: 5000, warning: 8000, error: 9000, money: 6000, milestone: 8000 };
/** At most this many chirps on screen; older ones slide into the bell. */
const MAX_VISIBLE = 3;
const LOG_MAX = 40;

/**
 * Notifications (Cities: Skylines II style): compact chirps in the top-right that auto-dismiss into a
 * top-bar bell with an unread badge; the bell opens a notification centre listing the recent history.
 * `push({ kind, title, text, life })`; life 0 = sticky (stays until clicked, still capped at MAX_VISIBLE).
 */
export function createToasts(hud) {
  const { world } = hud;
  const el = h('div.fc-toasts', { 'aria-live': 'polite' });
  hud.root.appendChild(el);
  const live = [];
  const log = [];
  let unread = 0;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn({ unread, total: log.length }); };

  function dismiss(t) {
    if (t.dead) return;
    t.dead = true;
    clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    setTimeout(() => t.el.remove(), 260);
    const i = live.indexOf(t);
    if (i >= 0) live.splice(i, 1);
  }

  function push(n) {
    if (!n) return null;
    const kind = TONE_ICON[n.kind] ? n.kind : 'info';
    const life = n.life != null ? n.life : TONE_LIFE[kind];
    // stamp with the in-game calendar date ('1 May · 16:03'), not an engine day counter
    const date = fmtDate(world.time);
    const entry = { kind, icon: n.icon || TONE_ICON[kind], title: n.title || '', text: n.text || '', when: `${world.time.day || 1} ${(date.month || '').slice(0, 3)}`, hour: world.time.hour, read: false };
    log.unshift(entry);
    if (log.length > LOG_MAX) log.length = LOG_MAX;
    unread++;
    const t = { el: null, timer: 0, dead: false, entry };
    t.el = h('div', { class: `fc-toast fc-panel tone-${kind}`, style: life ? { '--life': `${life}ms` } : null, onClick: () => dismiss(t) },
      h('div.fc-toast-icon', svg(icon(entry.icon))),
      h('div.fc-toast-body', h('div.fc-toast-title', entry.title), entry.text ? h('div.fc-toast-text', moneyNodes(entry.text)) : null),
      h('button.fc-toast-close', { title: 'Dismiss', onClick: (e) => { e.stopPropagation(); dismiss(t); } }, svg(icon('close'))),
      life ? h('div.fc-toast-bar') : null,
    );
    el.appendChild(t.el);
    live.push(t);
    while (live.length > MAX_VISIBLE) dismiss(live[0]);
    if (life) t.timer = setTimeout(() => dismiss(t), life);
    notify();
    if (centre.isOpen) renderCentre();
    return t;
  }

  // ---------- notification centre (dropdown under the bell) ----------
  const list = h('div.fc-notif-list');
  const empty = h('div.fc-notif-empty', svg(icon('check')), h('span', 'All quiet — no notifications yet.'));
  const countEl = h('span.fc-notif-count');
  const clearBtn = h('button.fc-btn', { onClick: () => { log.length = 0; unread = 0; notify(); renderCentre(); } }, svg(icon('close')), 'Clear all');
  const closeBtn = h('button.fc-info-close', { 'aria-label': 'Close notifications', onClick: () => centre.close() }, svg(icon('close')));
  const centreEl = h('div.fc-panel.fc-notif', { role: 'dialog', 'aria-label': 'Notifications' },
    h('div.fc-set-head', svg(icon('bell')), h('h3', 'Notifications'), countEl, closeBtn),
    list, empty,
    h('div.fc-notif-foot', clearBtn),
  );
  hud.root.appendChild(centreEl);

  function renderCentre() {
    clear(list);
    setText(countEl, log.length ? `${log.length}` : '');
    empty.style.display = log.length ? 'none' : '';
    clearBtn.disabled = !log.length;
    for (const e of log) {
      const when = e.when ? `${e.when} · ${fmtClock(e.hour || 0)}` : fmtClock(e.hour || 0);
      list.appendChild(h('div', { class: `fc-notif-item tone-${e.kind}${e.read ? '' : ' is-unread'}` },
        h('div.fc-toast-icon', svg(icon(e.icon))),
        h('div.fc-notif-body', h('div.fc-notif-title', h('span', e.title), h('time', when)), e.text ? h('div.fc-notif-text', moneyNodes(e.text)) : null),
      ));
    }
  }

  const centre = {
    el: centreEl,
    get isOpen() { return centreEl.classList.contains('is-open'); },
    open() {
      hud.tooltip.pin(null); hud.tooltip.hide(true);
      if (hud.settings && hud.settings.isOpen) hud.settings.close();
      renderCentre();
      centreEl.classList.add('is-open');
      hud.root.classList.add('notif-open');
      setClass(hud.top && hud.top.bellBtn, 'is-on', true);
      unread = 0;
      for (const e of log) e.read = true;
      notify();
    },
    close() {
      centreEl.classList.remove('is-open');
      hud.root.classList.remove('notif-open');
      setClass(hud.top && hud.top.bellBtn, 'is-on', false);
    },
    toggle() { centre.isOpen ? centre.close() : centre.open(); },
  };

  return {
    el, push, dismiss, centre, log,
    get unread() { return unread; },
    onChange(fn) { listeners.add(fn); fn({ unread, total: log.length }); return () => listeners.delete(fn); },
    clear() { for (const t of [...live]) dismiss(t); },
  };
}
