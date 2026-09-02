/**
 * Tiny DOM helpers for the HUD. No framework — plain elements, explicit updates.
 */

/**
 * h('div.cls#id', { attr, onClick, style:{}, data:{} }, ...children)
 * Children: Element | string | number | null | false | array.
 */
export function h(spec, attrs, ...children) {
  if (attrs && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  const [tag, ...parts] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const p of parts) {
    if (p[0] === '.') el.classList.add(p.slice(1));
    else if (p[0] === '#') el.id = p.slice(1);
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'data' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

/** Inline SVG element from markup string. */
export function svg(markup, cls) {
  const wrap = document.createElement('span');
  wrap.className = 'fc-icon' + (cls ? ' ' + cls : '');
  wrap.innerHTML = markup;
  return wrap;
}

/** Set text only when it changed (avoids layout churn every frame). */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
export function setClass(el, cls, on) {
  if (!el) return;
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------- formatting ----------
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtInt = (n) => intFmt.format(Math.round(n || 0));

/** Money with the Cities-style colón sign. Compact above 10 M. */
export function fmtMoney(n, { compact = false, sign = false } = {}) {
  const v = Math.round(n || 0);
  const abs = Math.abs(v);
  let body;
  if (compact && abs >= 1e6) body = (abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  else body = intFmt.format(abs);
  const s = v < 0 ? '−' : sign ? '+' : '';
  // U+2060 WORD JOINER keeps the sign glued to the currency sign when the string wraps inside prose.
  return s ? `${s}\u2060₡${body}` : `₡${body}`;
}
/** Money regex (with optional sign / compact suffix / per-unit) used to keep amounts on one line in prose. */
export const MONEY_RE = /[+−-]?\u2060?₡[\d,.]+[MK]?(?:\s?\/\s?\w+)?/g;
/** Text → children where every monetary amount sits in a `white-space:nowrap` span. */
export function moneyNodes(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(MONEY_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span.nw', m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export const fmtPct = (f) => `${Math.round((f || 0) * 100)}%`;
export const fmtSigned = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + intFmt.format(Math.abs(Math.round(n || 0)));

export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function fmtDate(time) {
  const y = time.year || 2026, m = (time.month || 1) - 1, d = time.day || 1;
  const dt = new Date(Date.UTC(y, m, d));
  return { weekday: DAYS[dt.getUTCDay()], month: MONTHS[m] || '', short: `${DAYS[dt.getUTCDay()].slice(0, 3)} ${d} ${(MONTHS[m] || '').slice(0, 3)} ${y}`, long: `${DAYS[dt.getUTCDay()]}, ${d} ${MONTHS[m] || ''} ${y}` };
}
export function fmtClock(hour) {
  const hh = Math.floor(hour) % 24;
  const mm = Math.floor((hour - Math.floor(hour)) * 60);
  return `${pad2(hh)}:${pad2(mm)}`;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Effective CSS `zoom` of the HUD root (screen px per HUD px). Measured, not parsed, so it is right under both the
 * standardised zoom behaviour (client rects in screen px) and the legacy one (rects already in local px → 1).
 */
export function hudZoom(root) {
  if (!root) return 1;
  const w = root.offsetWidth;
  if (!w) return 1;
  const z = root.getBoundingClientRect().width / w;
  return z > 0.05 && Number.isFinite(z) ? z : 1;
}
/** Client rect → HUD-local px. */
export function zoomRect(r, z) {
  if (z === 1) return r;
  return { left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
}
