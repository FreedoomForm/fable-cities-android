/**
 * Service placement — holographic footprint + building volume, live coverage radius and a
 * canPlace() validity read-out. The ghost auto-aligns to the nearest road (R rotates by 45°).
 */
import { PAL, lin, arc } from './gfx.js';
import { drawFootprint, drawCage, makeDisc } from './shapes.js';

const FALLBACK = {
  power: { name: 'Coal Power Plant', w: 60, d: 42, height: 22, radius: 640, cost: 120000, color: 0xf4b942 },
  water: { name: 'Water Tower', w: 18, d: 18, height: 27, radius: 480, cost: 32000, color: 0x4fc3f7 },
  police: { name: 'Police Station', w: 30, d: 22, height: 9.5, radius: 400, cost: 50000, color: 0x5c6bc0 },
  fire: { name: 'Fire House', w: 30, d: 24, height: 9.5, radius: 380, cost: 42000, color: 0xef5350 },
};

export function createServiceTool(env) {
  const { world } = env;
  const disc = makeDisc();
  const S = { type: 'police', yawOffset: 0, staged: null, lastReason: null };

  const api = () => (world.services && world.services.api) || null;
  function def(type) {
    const a = api();
    const t = a && a.types && a.types[type];
    return t || FALLBACK[type] || FALLBACK.police;
  }
  function colorOf(d) {
    const hex = '#' + (d.color != null ? d.color : 0x4fc3f7).toString(16).padStart(6, '0');
    return lin(hex);
  }

  /** Yaw that makes the building face the closest road, plus the manual offset. */
  function yawFor(x, z) {
    let base = 0;
    const r = world.roads && world.roads.api;
    if (r && typeof r.nearest === 'function') {
      const hit = r.nearest(x, z, 90);
      if (hit && hit.tangent) base = Math.atan2(hit.tangent.x, hit.tangent.z) + Math.PI / 2;
    }
    return base + S.yawOffset;
  }

  function enter(options = {}) {
    if (options.type) S.type = options.type;
    S.yawOffset = 0;
  }
  function exit() {}
  function cancel() { if (S.yawOffset !== 0) { S.yawOffset = 0; return true; } return false; }

  function update() {
    const g = env.ground();
    if (env.pressed('Period')) S.yawOffset += Math.PI / 4;
    if (env.pressed('Comma')) S.yawOffset -= Math.PI / 4;
    if (!g || !env.click) return;
    const a = api();
    if (!a) return;
    const yaw = yawFor(g.x, g.z);
    const rec = a.place(S.type, g.x, g.z, { yaw });
    if (rec) { env.audio('place'); S.yawOffset = 0; }
    else env.audio('error');
  }

  function draw() {
    const { groundY, vec } = env;
    const staged = S.staged;
    const g = staged ? staged.at : env.ground();
    if (!g) return;
    const type = staged ? staged.type : S.type;
    const d = def(type);
    const yaw = staged && staged.yaw != null ? staged.yaw : yawFor(g.x, g.z);
    const a = api();
    let ok = true, reason = null;
    if (staged && staged.invalid != null) { ok = !staged.invalid; reason = staged.reason || 'blocked'; }
    else if (a && typeof a.canPlace === 'function') {
      const res = a.canPlace(type, g.x, g.z, { yaw });
      ok = !!(res && res.ok);
      reason = res && res.reason;
    }
    const svcCol = colorOf(d);
    const col = ok ? svcCol : PAL.bad;
    const hi = ok ? PAL.goodHi : PAL.badHi;
    const box = { x: g.x, z: g.z, w: d.w || 24, d: d.d || 20, yaw, height: d.height || 10, y: groundY(g.x, g.z) };

    // coverage
    if (d.radius) {
      disc(env, g.x, g.z, d.radius, svcCol, ok ? 0.9 : 0.5);
      vec.polyline(arc(g.x, g.z, d.radius, 0, Math.PI * 2, groundY), { color: svcCol, width: 2.0, alpha: 0.85, glow: 1.3, closed: false });
      vec.polyline(arc(g.x, g.z, d.radius * 0.7, 0, Math.PI * 2, groundY), { color: svcCol, width: 1.2, dash: 8, alpha: 0.35, glow: 0.4 });
    }
    drawFootprint(env, box, ok ? hi : PAL.badHi, { width: 3.2, glow: 1.6, brackets: true, bracketColor: ok ? PAL.goodHi : PAL.badHi, fill: true, fillAlpha: ok ? 0.16 : 0.5, pattern: ok ? 0 : 4 });
    drawCage(env, box, ok ? PAL.accentHi : PAL.bad, { walls: true, wallAlpha: ok ? 0.85 : 0.5, width: 3.0 });
    // facing arrow (front faces −Z in the building's local frame)
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const fl = box.d / 2 + 6;
    const tip = { x: g.x - s * fl, z: g.z + c * fl };
    const bx = { x: g.x - s * (fl - 4), z: g.z + c * (fl - 4) };
    vec.polyline([
      { x: bx.x - c * 3, y: groundY(bx.x - c * 3, bx.z - s * 3), z: bx.z - s * 3 },
      { x: tip.x, y: groundY(tip.x, tip.z), z: tip.z },
      { x: bx.x + c * 3, y: groundY(bx.x + c * 3, bx.z + s * 3), z: bx.z + s * 3 },
    ], { color: hi, width: 2.6, alpha: 0.9, glow: 1.2 });

    const chip = env.nextChip();
    chip.set({
      value: ok ? `₡${(d.cost || 0).toLocaleString('en-US')}` : 'Blocked',
      title: d.name || type,
      sub: ok ? `${Math.round(d.radius || 0)} m coverage · < > to rotate` : reason || 'cannot build here',
      tone: ok ? 'good' : 'bad',
    });
    chip.place(g.x, groundY(g.x, g.z) + (d.height || 10) + 6, g.z);
  }

  function stage(spec) {
    if (!spec) { S.staged = null; return; }
    S.type = spec.type || S.type;
    S.staged = { type: S.type, at: { x: spec.x, z: spec.z }, yaw: spec.yaw, invalid: spec.invalid, reason: spec.reason };
  }

  return { name: 'service', enter, exit, update, draw, cancel, stage, state: S, cursorStyle: () => 'copy' };
}
