/**
 * Simulation inspector panel (DOM), shown only with `?simhud=1` (the game HUD belongs to the ui
 * module). Collapsible: click the header to fold it down to a one-line read-out.
 */
import { SERVICE_IDS, SERVICE_TYPES } from './services.js';
import { fmt } from './economy.js';

const CSS = `
#sim-hud { position: absolute; left: 18px; top: 92px; width: 332px; max-height: calc(100vh - 220px); overflow-y: auto; scrollbar-width: none; color: #e8edf2; font: 12px/1.35 'Inter', 'Segoe UI', system-ui, sans-serif;
  background: linear-gradient(160deg, rgba(14,20,28,.86), rgba(10,14,20,.78)); border: 1px solid rgba(255,255,255,.09); border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); overflow: hidden; }
#sim-hud * { box-sizing: border-box; }
#sim-hud .hd { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 14px 8px; border-bottom: 1px solid rgba(255,255,255,.07); cursor: pointer; user-select: none; }
#sim-hud.collapsed .hd { border-bottom: 0; padding-bottom: 10px; }
#sim-hud.collapsed .body { display: none; }
#sim-hud .hd .name { font-size: 15px; font-weight: 600; letter-spacing: .02em; }
#sim-hud .hd .date { color: #9fb1c4; font-variant-numeric: tabular-nums; font-size: 11px; text-align: right; }
#sim-hud .hd .speed { display: inline-flex; gap: 2px; margin-left: 6px; vertical-align: middle; }
#sim-hud .hd .speed i { width: 5px; height: 9px; background: rgba(255,255,255,.14); border-radius: 1px; display: inline-block; }
#sim-hud .hd .speed i.on { background: #4fc3f7; }
#sim-hud .hd .caret { color: #8da0b3; font-size: 10px; margin-left: 8px; }
#sim-hud .sec { padding: 9px 14px; border-bottom: 1px solid rgba(255,255,255,.06); }
#sim-hud .sec:last-child { border-bottom: 0; }
#sim-hud .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
#sim-hud .money { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
#sim-hud .net { font-variant-numeric: tabular-nums; font-weight: 600; }
#sim-hud .pos { color: #6fe3a1; } #sim-hud .neg { color: #ff7b6b; }
#sim-hud .lbl { color: #8da0b3; font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; }
#sim-hud .big { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
#sim-hud .bar { height: 5px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; margin-top: 5px; }
#sim-hud .bar > i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #4fc3f7, #81d4fa); transition: width .4s ease; }
#sim-hud .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }
#sim-hud .stat { background: rgba(255,255,255,.04); border-radius: 8px; padding: 7px 8px; }
#sim-hud .stat .v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
#sim-hud .stat .k { color: #8da0b3; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-top: 1px; }
#sim-hud .rci { display: flex; gap: 10px; align-items: flex-end; height: 58px; margin-top: 8px; }
#sim-hud .rci .col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
#sim-hud .rci .col b { width: 100%; border-radius: 4px 4px 2px 2px; background: #4fc3f7; transition: height .4s ease; min-height: 2px; }
#sim-hud .rci .col span { font-size: 10px; color: #8da0b3; margin-top: 4px; letter-spacing: .08em; }
#sim-hud .svc { display: grid; grid-template-columns: 18px 1fr 92px 34px; gap: 6px 8px; align-items: center; margin-top: 6px; }
#sim-hud .svc .ic { font-size: 12px; text-align: center; }
#sim-hud .svc .n { color: #cfd9e3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#sim-hud .svc .b { height: 6px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; }
#sim-hud .svc .b i { display: block; height: 100%; border-radius: 3px; }
#sim-hud .svc .c { text-align: right; color: #8da0b3; font-variant-numeric: tabular-nums; font-size: 11px; }
#sim-hud .bud { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; font-variant-numeric: tabular-nums; margin-top: 6px; }
#sim-hud .bud .k { color: #9fb1c4; } #sim-hud .bud .v { text-align: right; }
#sim-hud .bud .tot { border-top: 1px solid rgba(255,255,255,.1); padding-top: 3px; margin-top: 2px; font-weight: 600; }
#sim-hud .feed { margin-top: 6px; display: flex; flex-direction: column; gap: 5px; }
#sim-hud .note { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.04); border-left: 3px solid #4fc3f7; }
#sim-hud .note.milestone { border-left-color: #ffd54f; background: rgba(255,213,79,.08); }
#sim-hud .note.warning { border-left-color: #ffab5e; } #sim-hud .note.alert { border-left-color: #ff6b5e; } #sim-hud .note.budget { border-left-color: #6fe3a1; }
#sim-hud .note b { display: block; font-size: 11.5px; } #sim-hud .note span { color: #9fb1c4; font-size: 11px; }
`;

const RCI = [['residential', 'R', '#6fe3a1'], ['commercial', 'C', '#5b9cff'], ['industrial', 'I', '#ffb84d'], ['office', 'O', '#5ee0d8']];

export function createSimHud(ctx, api, opts = {}) {
  const { uiRoot, world } = ctx;
  if (!uiRoot) return null;
  if (!document.getElementById('sim-hud-css')) {
    const st = document.createElement('style');
    st.id = 'sim-hud-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.id = 'sim-hud';
  if (opts.collapsed) el.classList.add('collapsed');
  el.innerHTML = `
    <div class="hd" title="Click to fold / unfold"><div><span class="name"></span><span class="speed"><i></i><i></i><i></i></span></div><div class="date"></div><span class="caret">▾</span></div>
    <div class="body">
    <div class="sec">
      <div class="row"><span class="money"></span><span class="net"></span></div>
      <div class="row" style="margin-top:2px"><span class="lbl">Treasury</span><span class="lbl">per week</span></div>
    </div>
    <div class="sec">
      <div class="row"><span class="big pop"></span><span class="lbl ms"></span></div>
      <div class="bar"><i class="msbar"></i></div>
      <div class="grid4">
        <div class="stat"><div class="v hh"></div><div class="k">Households</div></div>
        <div class="stat"><div class="v jobs"></div><div class="k">Jobs</div></div>
        <div class="stat"><div class="v unemp"></div><div class="k">Jobless</div></div>
        <div class="stat"><div class="v happy"></div><div class="k">Happiness</div></div>
      </div>
    </div>
    <div class="sec"><div class="row"><span class="lbl">Zone demand</span><span class="lbl edu"></span></div><div class="rci"></div></div>
    <div class="sec"><div class="row"><span class="lbl">Services coverage</span><span class="lbl upkeep"></span></div><div class="svc"></div></div>
    <div class="sec"><div class="row"><span class="lbl">Weekly budget</span><span class="lbl month"></span></div><div class="bud"></div></div>
    <div class="sec"><span class="lbl">Notifications</span><div class="feed"></div></div>
    </div>`;
  uiRoot.appendChild(el);
  const $ = (s) => el.querySelector(s);
  $('.hd').addEventListener('click', () => { el.classList.toggle('collapsed'); $('.caret').textContent = el.classList.contains('collapsed') ? '▸' : '▾'; });
  const rci = $('.rci');
  for (const [key, letter, color] of RCI) {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<b style="background:${color}" data-k="${key}"></b><span>${letter}</span>`;
    rci.appendChild(col);
  }
  const svc = $('.svc');
  for (const id of SERVICE_IDS) {
    const d = SERVICE_TYPES[id];
    svc.insertAdjacentHTML('beforeend', `<div class="ic">${d.icon}</div><div class="n">${d.name}</div><div class="b"><i data-k="${id}"></i></div><div class="c" data-c="${id}"></div>`);
  }
  const feed = $('.feed');
  const notes = [];
  const offNote = ctx.events.on('notification', (n) => {
    if (!n) return;
    notes.unshift(n);
    if (notes.length > 4) notes.pop();
    feed.innerHTML = notes.map((x) => `<div class="note ${x.kind || 'info'}"><div><b>${esc(x.title || '')}</b><span>${esc(x.text || '')}</span></div></div>`).join('');
  });

  let acc = 0;
  const render = () => {
    const e = world.economy;
    const t = world.time;
    $('.name').textContent = e.cityName || 'New Fable';
    $('.date').textContent = api.formatTime();
    el.querySelectorAll('.speed i').forEach((i, k) => i.classList.toggle('on', k < t.speed));
    if (el.classList.contains('collapsed')) return;
    $('.money').textContent = '¤' + fmt(e.money);
    const net = $('.net');
    net.textContent = (e.net >= 0 ? '+' : '−') + '¤' + fmt(Math.abs(e.net));
    net.className = 'net ' + (e.net >= 0 ? 'pos' : 'neg');
    $('.pop').textContent = fmt(e.population) + ' residents';
    const ms = e.milestone;
    $('.ms').textContent = ms ? (ms.next ? `${ms.name} → ${ms.next} (${fmt(ms.nextPopulation)})` : ms.name) : '';
    $('.msbar').style.width = ((ms ? ms.progress : 0) * 100).toFixed(1) + '%';
    $('.hh').textContent = fmt(e.households);
    $('.jobs').textContent = fmt(e.jobs);
    $('.unemp').textContent = (e.unemployment * 100).toFixed(1) + '%';
    $('.happy').textContent = Math.round(e.happiness * 100) + '%';
    $('.edu').textContent = `education ${Math.round(e.education * 100)}%`;
    for (const [key] of RCI) rci.querySelector(`[data-k="${key}"]`).style.height = Math.max(3, e.demand[key] * 100).toFixed(0) + '%';
    const st = api.services.stats();
    let upkeep = 0;
    for (const id of SERVICE_IDS) {
      const c = e.coverage[id] || 0;
      const bar = svc.querySelector(`[data-k="${id}"]`);
      bar.style.width = (c * 100).toFixed(0) + '%';
      bar.style.background = c > 0.75 ? '#6fe3a1' : c > 0.4 ? '#ffb84d' : '#ff7b6b';
      const s = st[id];
      upkeep += s.upkeep;
      svc.querySelector(`[data-c="${id}"]`).textContent = s.count ? `${s.count}×${s.strain < 0.999 ? ' ' + Math.round(s.strain * 100) + '%' : ''}` : '—';
    }
    $('.upkeep').textContent = `¤${fmt(upkeep)}/mo`;
    const b = e.budget;
    $('.month').textContent = b ? b.label : 'projected';
    const tx = b ? b.taxes : e.taxes || {};
    const row = (k, v, cls = '') => `<div class="k ${cls}">${k}</div><div class="v ${cls}">${v}</div>`;
    const inc = b ? b.income : e.income, exp = b ? b.expenses : e.expenses;
    $('.bud').innerHTML =
      row('Residential tax', '¤' + fmt(tx.residential || 0)) + row('Commercial tax', '¤' + fmt(tx.commercial || 0)) +
      row('Industrial tax', '¤' + fmt(tx.industrial || 0)) + row('Office tax', '¤' + fmt(tx.office || 0)) +
      row('Services', '−¤' + fmt(b ? b.services : upkeep)) + row('Roads & admin', '−¤' + fmt(b ? b.roads + b.admin : exp - upkeep)) +
      row('Net', (inc - exp >= 0 ? '+' : '−') + '¤' + fmt(Math.abs(inc - exp)), 'tot ' + (inc - exp >= 0 ? 'pos' : 'neg'));
  };
  render();
  return {
    el,
    update(dt) { acc += dt; if (acc > 0.25) { acc = 0; render(); } },
    render,
    dispose() { offNote(); el.remove(); },
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
