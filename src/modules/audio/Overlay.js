/**
 * Audio mix monitor — a HUD panel (spectrum, waterfall spectrogram, per-layer meters, listener
 * state and the recent one-shot log). Shown in the audio showcase, with ?audiodebug=1 or via
 * world.audio.api.setDebug(true). Styles are scoped under #audio-hud and injected once.
 */

const CSS = `
#audio-hud { position: absolute; left: 18px; top: 50%; transform: translateY(-50%); width: 312px; z-index: 30;
  font: 11px/1.35 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif; color: #dbe6f0; letter-spacing: .01em;
  background: linear-gradient(160deg, rgba(14,20,28,.86), rgba(9,13,19,.9)); border: 1px solid rgba(140,180,220,.16);
  border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05); backdrop-filter: blur(10px);
  pointer-events: none; user-select: none; overflow: hidden; }
#audio-hud .hd { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px 7px; border-bottom: 1px solid rgba(140,180,220,.12); }
#audio-hud .hd b { font-weight: 600; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #eaf2fa; }
#audio-hud .hd .sub { color: #7f93a8; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; margin-left: 8px; }
#audio-hud .badge { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; padding: 3px 7px; border-radius: 4px; font-weight: 600; }
#audio-hud .badge.running { background: rgba(70,200,120,.16); color: #7fe0a4; border: 1px solid rgba(70,200,120,.35); }
#audio-hud .badge.waiting, #audio-hud .badge.suspended { background: rgba(255,190,60,.14); color: #ffd27a; border: 1px solid rgba(255,190,60,.35); }
#audio-hud .badge.blocked, #audio-hud .badge.unsupported, #audio-hud .badge.closed { background: rgba(255,90,90,.14); color: #ff9a9a; border: 1px solid rgba(255,90,90,.35); }
#audio-hud canvas { display: block; width: 100%; }
#audio-hud .sec { padding: 8px 12px 6px; }
#audio-hud .sec + .sec { border-top: 1px solid rgba(140,180,220,.1); }
#audio-hud .lbl { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: #7f93a8; margin-bottom: 5px; display: flex; justify-content: space-between; gap: 10px; white-space: nowrap; }
#audio-hud .lbl span:last-child { overflow: hidden; text-overflow: ellipsis; letter-spacing: .08em; }
#audio-hud .row { display: grid; grid-template-columns: 62px 1fr 42px; align-items: center; gap: 8px; height: 15px; }
#audio-hud .row span:first-child { color: #b9c9d8; }
#audio-hud .row .db { text-align: right; font-variant-numeric: tabular-nums; color: #8fa3b8; font-size: 10px; }
#audio-hud .bar { position: relative; height: 6px; background: rgba(255,255,255,.06); border-radius: 3px; overflow: hidden; }
#audio-hud .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px; transition: width .08s linear; }
#audio-hud .bar i.t { background: rgba(120,160,200,.28); }
#audio-hud .bar i.m { background: linear-gradient(90deg, #3aa7e8, #7fe0a4 70%, #ffd27a 92%, #ff7b7b); }
#audio-hud .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 10px; }
#audio-hud .kv div { display: flex; justify-content: space-between; color: #8fa3b8; }
#audio-hud .kv div b { color: #e6eef6; font-weight: 500; font-variant-numeric: tabular-nums; }
#audio-hud .log div { display: flex; justify-content: space-between; color: #a9bccd; height: 15px; }
#audio-hud .log div.live { color: #eaf2fa; }
#audio-hud .log .k { display: inline-flex; align-items: center; gap: 6px; }
#audio-hud .log .k::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--c, #ffb02e); box-shadow: 0 0 6px var(--c, #ffb02e); }
#audio-hud .log .d { color: #7f93a8; font-variant-numeric: tabular-nums; }
#audio-hud .vol { display: flex; align-items: center; gap: 8px; color: #8fa3b8; }
#audio-hud .vol .bar { flex: 1; }
#audio-hud .vol .bar i { background: #9ec5e8; }
#audio-hud .foot { padding: 6px 12px 8px; color: #5f7287; font-size: 9.5px; letter-spacing: .06em; border-top: 1px solid rgba(140,180,220,.1); }
`;

const LAYERS = [
  ['wind', 'Wind'], ['city', 'City hum'], ['traffic', 'Traffic'], ['zones', 'Zones'], ['water', 'Water'], ['rain', 'Rain'], ['birds', 'Birds'], ['crickets', 'Crickets'], ['events', 'Events'], ['ui', 'UI'], ['master', 'Master'],
];
const ZONE_LABEL = { ind: 'industry', com: 'commerce', res: 'residential', office: 'office', construction: 'construction', park: 'park' };
const EVENT_COLORS = { siren: '#ff5d5d', horn: '#ffb02e', bell: '#fff1b8', thunder: '#d8e6ff', carpass: '#8fe3ff' };

export class Overlay {
  constructor(uiRoot) {
    if (!document.getElementById('audio-hud-style')) {
      const st = document.createElement('style');
      st.id = 'audio-hud-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'audio-hud';
    el.innerHTML = `
      <div class="hd"><div><b>Audio</b><span class="sub">procedural mix</span></div><span class="badge waiting" data-state>waiting</span></div>
      <canvas data-spec width="312" height="64"></canvas>
      <canvas data-wf width="312" height="56"></canvas>
      <div class="sec"><div class="lbl"><span>Layers</span><span>target · measured</span></div><div data-layers></div></div>
      <div class="sec"><div class="lbl"><span>Listener</span><span data-clock></span></div><div class="kv" data-kv></div></div>
      <div class="sec"><div class="lbl"><span>Emitters</span><span data-emit></span></div><div class="kv" data-emitkv></div></div>
      <div class="sec"><div class="lbl"><span>Events</span><span data-counts></span></div><div class="log" data-log></div></div>
      <div class="foot" data-foot></div>`;
    (uiRoot || document.body).appendChild(el);
    this.el = el;
    this.spec = el.querySelector('[data-spec]');
    this.wf = el.querySelector('[data-wf]');
    this.sctx = this.spec.getContext('2d');
    this.wctx = this.wf.getContext('2d');
    this.layersEl = el.querySelector('[data-layers]');
    this.kvEl = el.querySelector('[data-kv]');
    this.emitEl = el.querySelector('[data-emit]');
    this.emitKvEl = el.querySelector('[data-emitkv]');
    this.logEl = el.querySelector('[data-log]');
    this.stateEl = el.querySelector('[data-state]');
    this.clockEl = el.querySelector('[data-clock]');
    this.countsEl = el.querySelector('[data-counts]');
    this.footEl = el.querySelector('[data-foot]');
    this.rows = {};
    for (const [key, label] of LAYERS) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span>${label}</span><div class="bar"><i class="t"></i><i class="m"></i></div><span class="db">-inf</span>`;
      this.layersEl.appendChild(row);
      this.rows[key] = { t: row.children[1].children[0], m: row.children[1].children[1], db: row.children[2] };
    }
    this.freq = null;
    this._wfCol = 0;
    this._acc = 0;
    this.wctx.fillStyle = '#0a0f15';
    this.wctx.fillRect(0, 0, this.wf.width, this.wf.height);
  }

  setVisible(v) { this.el.style.display = v ? '' : 'none'; }

  /**
   * @param info { state, sampleRate, settings, levels, meters, mixState, analyser, log, active, counts, oneShotLevel, now, uiLast }
   */
  /** True when the next update() call will redraw (lets the caller skip gathering data). */
  due(dt) { this._acc += dt; return this._acc >= 1 / 30; }

  update(info) {
    this._acc = 0;
    this.stateEl.textContent = info.state;
    this.stateEl.className = 'badge ' + info.state;

    const s = info.mixState;
    if (s) {
      const h = s.hour, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
      const extra = (s.snow > 0 ? ` · snow ${pct(s.snow)}` : '') + (s.fog > 0.02 ? ` · fog ${pct(s.fog)}` : '');
      this.clockEl.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${s.weather}${extra}`;
      this.kvEl.innerHTML = kv('altitude', `${Math.round(s.altitude)} m`) + kv('height mix', pct(s.altN)) + kv('night', pct(s.night)) +
        kv('wind', pct(s.wind)) + kv('gust', pct(s.gust)) + kv('rain', pct(s.rain)) +
        kv('wet', pct(s.wet)) + kv('snowfall', pct(s.snowfall)) + kv('forest', pct(s.forest)) +
        kv('population', fmtInt(s.population)) + kv('vehicles', fmtInt(s.vehicles)) + kv('urban', pct(s.urban)) +
        kv('traffic', pct(s.traffic * s.trafficHour)) + kv('water', pct(s.water)) + kv('temp', `${Math.round(s.temp)}°C`);
    }
    // positional emitters
    const tr = info.traffic, zn = info.zones;
    if (tr || zn) {
      this.emitEl.textContent = `${tr ? tr.voices : 0} vehicles · ${zn ? zn.voices : 0} zones`;
      const cats = {};
      for (const v of zn?.live || []) cats[v.cat] = (cats[v.cat] || 0) + 1;
      let html = kv('vehicles near', tr ? String(tr.vehicles) : '—') + kv('zone cells', zn ? String(zn.clusters) : '—') + kv('last bird', info.birds ? info.birds.species : '—');
      for (const c in cats) html += kv(ZONE_LABEL[c] || c, `${cats[c]}×`);
      this.emitKvEl.innerHTML = html;
    }
    // layer bars
    const meters = info.meters || {};
    const levels = info.levels || {};
    for (const [key] of LAYERS) {
      const row = this.rows[key];
      const rms = meters[key] || 0;
      const db = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
      const mW = Math.max(0, Math.min(1, (db + 60) / 60));
      let target = levels[key];
      if (key === 'events') target = info.oneShotLevel;
      if (key === 'ui') target = info.uiLast != null && info.now - info.uiLast < 0.4 ? 1 - (info.now - info.uiLast) / 0.4 : 0;
      if (key === 'master') target = (info.settings?.muted ? 0 : info.settings?.master) ?? 0;
      row.t.style.width = `${Math.round(Math.min(1, target || 0) * 100)}%`;
      row.m.style.width = `${Math.round(mW * 100)}%`;
      row.db.textContent = db <= -99 ? '-inf' : `${db.toFixed(0)} dB`;
    }
    // spectrum + waterfall
    const an = info.analyser;
    if (an) {
      if (!this.freq || this.freq.length !== an.frequencyBinCount) this.freq = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this.freq);
      this.drawSpectrum(info.sampleRate || 48000);
      this.drawWaterfall(info.sampleRate || 48000);
    } else {
      this.sctx.clearRect(0, 0, this.spec.width, this.spec.height);
    }
    // event log
    const log = info.log || [];
    const active = new Set((info.active || []).map((e) => `${e.kind}${e.start}`));
    let html = '';
    for (const e of log.slice(0, 5)) {
      const live = active.has(`${e.kind}${e.start}`) ? ' live' : '';
      html += `<div class="${live.trim()}"><span class="k" style="--c:${EVENT_COLORS[e.kind] || '#fff'}">${e.kind}${e.variant ? ' · ' + e.variant : ''}</span><span class="d">${e.distance} m</span></div>`;
    }
    if (!html) html = '<div><span class="k" style="--c:#4a5a6a">no events yet</span><span class="d">—</span></div>';
    this.logEl.innerHTML = html;
    const c = info.counts || {};
    this.countsEl.textContent = `${c.siren || 0} siren · ${c.horn || 0} horn · ${c.carpass || 0} pass · ${c.thunder || 0} thunder`;
    const st = info.settings || {};
    this.footEl.textContent = `master ${Math.round((st.master ?? 0) * 100)}%${st.muted ? ' · muted' : ''} · ambience ${Math.round((st.ambience ?? 1) * 100)}% · sfx ${Math.round((st.sfx ?? 1) * 100)}% · ui ${Math.round((st.ui ?? 1) * 100)}%${info.sampleRate ? ` · ${(info.sampleRate / 1000).toFixed(1)} kHz` : ''}${info.note ? ' · ' + info.note : ''}`;
  }

  drawSpectrum(sampleRate) {
    const ctx = this.sctx, W = this.spec.width, H = this.spec.height;
    ctx.clearRect(0, 0, W, H);
    const bars = 64;
    const nyq = sampleRate / 2;
    const fMin = 30, fMax = 16000;
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, '#2a7fc4'); grad.addColorStop(0.55, '#4fc3f7'); grad.addColorStop(1, '#b8f0ff');
    ctx.fillStyle = grad;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const f0 = fMin * Math.pow(fMax / fMin, i / bars), f1 = fMin * Math.pow(fMax / fMin, (i + 1) / bars);
      const b0 = Math.floor(f0 / nyq * this.freq.length), b1 = Math.max(b0 + 1, Math.floor(f1 / nyq * this.freq.length));
      let m = 0;
      for (let b = b0; b < b1 && b < this.freq.length; b++) if (this.freq[b] > m) m = this.freq[b];
      const h = Math.max(1, (m / 255) * (H - 4));
      ctx.globalAlpha = 0.35 + 0.65 * (m / 255);
      ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
    ctx.globalAlpha = 1;
    // frequency ticks
    ctx.fillStyle = 'rgba(127,147,168,.7)';
    ctx.font = '8px system-ui, sans-serif';
    for (const f of [100, 1000, 10000]) {
      const x = Math.log(f / fMin) / Math.log(fMax / fMin) * W;
      ctx.fillRect(x, H - 3, 1, 3);
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, 8);
    }
  }

  drawWaterfall(sampleRate) {
    const ctx = this.wctx, W = this.wf.width, H = this.wf.height;
    // scroll left by one column
    ctx.drawImage(this.wf, 1, 0, W - 1, H, 0, 0, W - 1, H);
    const nyq = sampleRate / 2;
    const fMin = 30, fMax = 16000;
    for (let y = 0; y < H; y++) {
      const fr = 1 - y / H;
      const f = fMin * Math.pow(fMax / fMin, fr);
      const b = Math.min(this.freq.length - 1, Math.floor(f / nyq * this.freq.length));
      const v = this.freq[b] / 255;
      ctx.fillStyle = heat(v);
      ctx.fillRect(W - 1, y, 1, 1);
    }
  }
}

function heat(v) {
  // dark navy → teal → amber → white
  const stops = [[0, 10, 15, 21], [0.3, 20, 70, 110], [0.55, 40, 170, 200], [0.78, 255, 190, 80], [1, 255, 245, 230]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const t = (v - a[0]) / (b[0] - a[0]);
      return `rgb(${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)},${Math.round(a[3] + (b[3] - a[3]) * t)})`;
    }
  }
  return 'rgb(255,245,230)';
}
const kv = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
const pct = (v) => `${Math.round((v || 0) * 100)}%`;
const fmtInt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v || 0)));
