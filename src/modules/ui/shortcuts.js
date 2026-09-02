import { h, svg } from './dom.js';
import { icon } from './icons.js';
import { SHORTCUTS } from './catalog.js';

/** Full-screen keyboard shortcut reference (toggle with ? / F1). */
export function createShortcuts(hud) {
  const groups = new Map();
  for (const s of SHORTCUTS) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const grid = h('div.fc-sc-grid');
  for (const [name, rows] of groups) {
    const g = h('div.fc-sc-group', h('h4', name));
    for (const r of rows) {
      const keys = h('div.fc-sc-keys');
      r.keys.forEach((combo, i) => {
        if (i > 0) keys.appendChild(h('span.or', 'or'));
        combo.forEach((k, j) => {
          // '+' only inside a real chord (Alt + LMB); a plain group like W A S D is a set of keys
          if (j > 0 && r.chord) keys.appendChild(h('span.or', '+'));
          keys.appendChild(h('kbd.fc-kbd', k));
        });
      });
      g.appendChild(h('div.fc-sc-row', h('span', r.desc), keys));
    }
    grid.appendChild(g);
  }
  const panel = h('div.fc-panel.fc-sc-panel', { role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div.fc-sc-head', svg(icon('keyboard')), h('h2', 'Keyboard shortcuts'), h('span', 'Press ? or Esc to close'),
      h('button.fc-info-close', { 'aria-label': 'Close', onClick: () => close() }, svg(icon('close')))),
    grid,
  );
  const el = h('div.fc-shortcuts', panel);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  hud.root.appendChild(el);

  function open() { hud.tooltip.suspend(true); el.classList.add('is-open'); hud.top.keysBtn.classList.add('is-on'); }
  function close() { el.classList.remove('is-open'); hud.top.keysBtn.classList.remove('is-on'); hud.tooltip.suspend(false); }
  function toggle() { el.classList.contains('is-open') ? close() : open(); }
  return { el, open, close, toggle, get isOpen() { return el.classList.contains('is-open'); } };
}
