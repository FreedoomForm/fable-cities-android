/**
 * demo — press-kit camera presets.
 *
 * The blind comparison was lost on composition before materials were even considered: three of our
 * four frames were noon wide shots against curated golden-hour, night and street-level references.
 * So every preset here carries its own time of day (a low sun, 22-34 deg elevation, which is what
 * the reference frames measure at), a foreground element, a mid-ground subject and a horizon.
 *
 * `hour` is applied by the wrapper in DemoCity when the camera is selected; an explicit `?time=`
 * or a later `setTime()` always wins, so `tools/shot.mjs --time` is unaffected.
 */
import { DEG2RAD, wrapAngle } from '../shared/math.js';

export function registerPresets(ctx, g) {
  const game = window.__game;
  if (!game) return null;
  const { world } = ctx;
  const roads = world.roads.api;
  const terrain = world.terrain;
  const { L, heightAt, COAST_V, CORE_V, HW_V, shore, site } = g;
  const { cx, cz, ux, uz, vx, vz } = site;

  /** yaw that puts the CAMERA in world direction (dx,dz) from its target */
  const yawTo = (dx, dz) => Math.atan2(dx, dz);
  const SEAWARD = yawTo(vx, vz);        // camera over the water, looking inland
  const INLAND = yawTo(-vx, -vz);       // camera inland, looking out to sea
  const ALONG_P = yawTo(ux, uz);
  const ALONG_N = yawTo(-ux, -uz);
  const T = (u, v, lift = 0) => { const p = L(u, v); return { x: p.x, y: heightAt(u, v) + lift, z: p.z }; };
  /** target on the road surface (never inside a kerb or a tree) */
  const R = (u, v, lift = 0) => {
    const p = L(u, v);
    const sy = roads.surfaceHeight ? roads.surfaceHeight(p.x, p.z) : null;
    return { x: p.x, y: (sy != null ? sy : terrain.getHeight(p.x, p.z)) + lift, z: p.z };
  };
  const promAt = (u) => { const sv = shore.at(u); return Number.isFinite(sv) ? Math.min(sv - 14, COAST_V + 330) : COAST_V + 26; };
  const esplAt = (u) => { const sv = shore.at(u); return Number.isFinite(sv) ? Math.min(sv - 48, COAST_V + 300) : COAST_V + 10; };
  const spot = (name) => (g.landmarks || []).find((s) => s.name === name) || null;

  // ---- sun-aware framing -----------------------------------------------------------------------
  // A frame lit from behind the camera reads flat (every judge said so), and one shot into the sun
  // blows out. Aim for side light: 62-118 deg between the view direction and the sun azimuth.
  // Azimuth TO the sun, measured from +X towards +Z, sampled from the environment module's own solar
  // model at 47.3 deg N on the start date (sunrise 4.9, solar noon 12.0 at 57.6 deg, sunset 19.1).
  const SUN_AZ = [-21, -10, 1, 12, 26, 42, 64, 90, 116, 138, 154, 168, 179, 190, 201];  // hours 5..19
  const sunAz = (hour) => {
    const t = Math.max(0, Math.min(13.999, hour - 5));
    const i = Math.floor(t), f = t - i;
    return (SUN_AZ[i] + (SUN_AZ[i + 1] - SUN_AZ[i]) * f) * DEG2RAD;
  };
  // A camera yaw of Y places the camera at (sin Y, cos Y) from its target, so it looks along
  // -(sin Y, cos Y), whose angle from +X is -(Y + 90 deg).
  const lookAngle = (yaw) => -(yaw + Math.PI / 2);
  const sideLight = (yaw, hour, maxTurn = 45 * DEG2RAD) => {
    if (!(hour > 6.4 && hour < 20.6)) return yaw;      // night: nothing to rake
    const d = wrapAngle(lookAngle(yaw) - sunAz(hour));
    const a = Math.abs(d), s = d < 0 ? -1 : 1;
    // 95-145 deg puts the sun behind the camera but well off-axis: facades stay lit, shadows rake.
    const lo = 95 * DEG2RAD, hi = 145 * DEG2RAD;
    if (a >= lo && a <= hi) return yaw;
    const target = (a < lo ? lo : hi) * s;
    let delta = wrapAngle(target - d);
    if (Math.abs(delta) > maxTurn) delta = Math.sign(delta) * maxTurn;
    return yaw - delta;
  };

  /** How badly lit a given camera yaw is at `hour` (0 = ideal raking light behind the camera). */
  const lightCost = (yaw, hour) => {
    const sep = Math.abs(wrapAngle(lookAngle(yaw) - sunAz(hour)));
    return Math.abs(sep - 142 * DEG2RAD) + (sep < 62 * DEG2RAD ? 100 : 0);
  };

  /** Build a preset from an EYE position and a look direction (keeps cameras out of geometry). */
  const fromEye = (eye, dir, distance, pitch, hour) => {
    const l = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / l, dz = dir.z / l;
    const yaw = Math.atan2(-dx, -dz);
    const h = distance * Math.cos(pitch), drop = distance * Math.sin(pitch);
    return { target: { x: eye.x + dx * h, y: eye.y - drop, z: eye.z + dz * h }, distance, yaw, pitch, hour };
  };

  /**
   * The best street-level stand near a local point: a real crossing (3+ arms, so no median tree and
   * no kerb planting in the eye), on flat ground (downtown sits on a slope in places and a camera on
   * a cut edge stares at a grass berm), with as much building mass around it as possible so the shot
   * is a street canyon rather than a gap.
   */
  const crossing = (u, v, maxR = 340, minWidth = 0) => {
    const p = L(u, v);
    const list = world.buildings.list || [];
    let best = null, bs = -Infinity;
    for (const n of world.roads.nodes.values()) {
      if (!n.segments || n.segments.length < 3) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d > maxR) continue;
      // A camera 6 m up in a 12 m local street has a tower 7 m off each shoulder; on an avenue the
      // building line is 14 m away and the shot reads as a street instead of a wall.
      let width = 0;
      for (const sid of n.segments) { const seg = roads.getSegment && roads.getSegment(sid); if (seg && seg.width > width) width = seg.width; }
      if (width < minWidth) continue;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const h = terrain.getHeight(n.x + Math.cos(a) * 55, n.z + Math.sin(a) * 55);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      let mass = 0;
      for (const b of list) {
        const dd = Math.hypot(b.x - n.x, b.z - n.z);
        if (dd < 120) mass += Math.min(70, b.height || 0) * (1 - dd / 120);
      }
      const score = mass * 0.06 - (hi - lo) * 7 - d * 0.03 + width * 1.2;
      if (score > bs) { bs = score; best = n; }
    }
    return best;
  };

  const obs = spot('observation');
  const arena = spot('arena');
  const hall = spot('concerthall');
  const station = g.rail && g.rail.station;
  const quay = g.port && g.port.quay;

  // ---- the eight the press kit asks for --------------------------------------------------------
  const P = {};

  // Golden hour over the mid-rise ring into the tower cluster, sea and horizon closing the frame.
  P.downtown_golden = {
    target: T(20, CORE_V - 30, 34), distance: 640,
    yaw: sideLight(INLAND + 24 * DEG2RAD, 16.6, 60 * DEG2RAD), pitch: 13 * DEG2RAD, hour: 16.6,
  };

  // Down the avenue spine at night: headlights and taillights converging on the lit tower cluster.
  // Stand over a junction (never inside a tower) a few blocks out and look into the core.
  {
    const core = L(0, CORE_V - 30);
    const node = crossing(0, CORE_V + 210, 300, 18);
    const eye = node ? { x: node.x, y: node.y + 6.2, z: node.z } : { ...T(0, CORE_V + 210, 6.2) };
    // down whichever street out of the junction heads into the tower cluster
    const toCore = { x: core.x - eye.x, z: core.z - eye.z };
    const tl = Math.hypot(toCore.x, toCore.z) || 1;
    let bestD = null, bestDot = -Infinity;
    for (const d of [{ x: ux, z: uz }, { x: -ux, z: -uz }, { x: vx, z: vz }, { x: -vx, z: -vz }]) {
      if (![30, 70, 120].every((m) => roads.surfaceHeight(eye.x + d.x * m, eye.z + d.z * m) != null)) continue;
      const dot = (d.x * toCore.x + d.z * toCore.z) / tl;
      if (dot > bestDot) { bestDot = dot; bestD = d; }
    }
    const nd = bestD || { x: toCore.x / tl, z: toCore.z / tl };
    P.downtown_night = fromEye({ x: eye.x + nd.z * 5.5, y: eye.y, z: eye.z - nd.x * 5.5 }, nd, 190, 3.4 * DEG2RAD, 21.6);
  }

  // Eye height on the boulevard: kerb and traffic in the foreground, facades receding to a vanishing
  // point, sky above. Placed over a road centre line so the camera can never sit inside geometry.
  // Street level. The centre line of an avenue carries the median trees and the kerb carries the
  // street trees, so the only reliably clear eye position is a crossing: stand in the junction and
  // look down the avenue, and pick whichever of the two directions the sun rakes across.
  {
    const HOUR = 17.0;
    const node = crossing(-100, CORE_V + 40, 340, 18);
    const eye = node ? { x: node.x, y: node.y + 5.0, z: node.z } : { ...R(-176, CORE_V, 5.0) };
    // Four possible streets out of the crossing. Keep the ones that actually have carriageway
    // ahead, then take the one the sun rakes across — never the one it shines straight down.
    const dirs = [{ x: ux, z: uz }, { x: -ux, z: -uz }, { x: vx, z: vz }, { x: -vx, z: -vz }];
    const cost = (pp) => lightCost(pp.yaw, HOUR);
    let bestP = null, bestC = Infinity;
    for (const d of dirs) {
      const onStreet = [30, 60, 100].every((m) => roads.surfaceHeight(eye.x + d.x * m, eye.z + d.z * m) != null);
      if (!onStreet) continue;
      // Sit over the near carriageway, not the centre line: the avenue median carries trees and one
      // of them lands squarely in the middle of the frame otherwise.
      const off = { x: eye.x + d.z * 5.5, y: eye.y, z: eye.z - d.x * 5.5 };
      const pp = fromEye(off, d, 130, 3.6 * DEG2RAD, HOUR);
      const c = cost(pp);
      if (c < bestC) { bestC = c; bestP = pp; }
    }
    P.street_level = bestP || fromEye(eye, { x: ux, z: uz }, 130, 3.6 * DEG2RAD, HOUR);
  }

  // Dusk at the working port: containers and cranes in the foreground, ships, city behind.
  // Look ALONG the quay so the cranes and the moored ships recede into the frame with the city
  // skyline closing it behind — the camera stands at the far end of the apron, over the water.
  // Stand on the apron at one end of the quay and look along it: cranes and moored ships recede
  // into the frame, the water fills one side. Which end depends on where the sun is.
  if (quay) {
    const HOUR = 18.3;
    // Four stands: either end of the apron looking along the quay, or out on the water looking back
    // at it with the city behind. The sun decides — an apron in the city's own shadow is a black
    // slab, and at this hour the shadows are 400 m long.
    const cands = [
      { u: quay.u + 330, v: quay.faceV - 60, d: { x: -ux, z: -uz } },
      { u: quay.u - 330, v: quay.faceV - 60, d: { x: ux, z: uz } },
      { u: quay.u + 110, v: quay.faceV + 330, d: { x: -vx * 0.92 - ux * 0.39, z: -vz * 0.92 - uz * 0.39 } },
      { u: quay.u - 110, v: quay.faceV + 330, d: { x: -vx * 0.92 + ux * 0.39, z: -vz * 0.92 + uz * 0.39 } },
    ];
    let best = null, bestC = Infinity;
    for (const c of cands) {
      const p = L(c.u, c.v);
      const pp = fromEye({ x: p.x, y: quay.y + 44, z: p.z }, c.d, 430, 10 * DEG2RAD, HOUR);
      const cost = lightCost(pp.yaw, HOUR);
      if (cost < bestC) { bestC = cost; best = pp; }
    }
    P.waterfront_dusk = best;
  } else {
    P.waterfront_dusk = { target: T(70, esplAt(70) - 18, 4), distance: 330, yaw: sideLight(ALONG_N, 18.6, 60 * DEG2RAD), pitch: 9 * DEG2RAD, hour: 18.6 };
  }

  // Dawn across the bay: water foreground, the whole skyline in silhouette, mountains behind.
  P.skyline_dawn = {
    target: T(60, CORE_V + 130, 44), distance: 620, yaw: SEAWARD + 27 * DEG2RAD, pitch: 3.4 * DEG2RAD, hour: 6.3,
  };

  // Evening in the crescents: long shadows across gardens and driveways, city on the horizon.
  P.suburb_evening = g.subView
    ? { target: g.subView.target, distance: 128, yaw: sideLight(g.subView.yaw + 9 * DEG2RAD, 17.4, 50 * DEG2RAD), pitch: 11 * DEG2RAD, hour: 17.4 }
    : { target: T(g.subU + 20, g.subV + 30, 2), distance: 165, yaw: ALONG_N + 42 * DEG2RAD, pitch: 16 * DEG2RAD, hour: 17.4 };

  // Industry at dusk: sheds, stacks, the freight siding and the motorway embankment in depth.
  P.industrial_dusk = {
    target: T(g.indU + 40, g.indV - 40, 8), distance: 340,
    yaw: sideLight(SEAWARD + 30 * DEG2RAD, 17.9, 70 * DEG2RAD), pitch: 13 * DEG2RAD, hour: 17.9,
  };

  // The whole city: coast, downtown, motorway, rail and port readable in one frame.
  P.aerial = {
    target: T(20, CORE_V - 90, 0), distance: 1020, yaw: SEAWARD + 30 * DEG2RAD, pitch: 42 * DEG2RAD, hour: 16.2,
  };

  // ---- supporting angles ------------------------------------------------------------------------
  Object.assign(P, {
    // generic names other tooling uses, re-pointed at the real town
    downtown: P.downtown_golden,
    night_downtown: P.downtown_night,
    waterfront: P.waterfront_dusk,
    skyline: { target: T(20, CORE_V + 90, 20), distance: 900, yaw: SEAWARD + 17 * DEG2RAD, pitch: 10 * DEG2RAD, hour: 16.6 },
    suburb: P.suburb_evening,
    industrial: P.industrial_dusk,
    industry: P.industrial_dusk,
    city: { target: T(-30, CORE_V - 20, 12), distance: 520, yaw: SEAWARD + 32 * DEG2RAD, pitch: 28 * DEG2RAD, hour: 16.4 },
    street: P.street_level,
    closeup: fromEye(
      (() => { const n = crossing(120, CORE_V - 60, 340, 18); return n ? { x: n.x, y: n.y + 8, z: n.z } : R(-88, CORE_V, 8); })(),
      { x: ux, z: uz }, 78, 9 * DEG2RAD, 17.0,
    ),
    top: { target: T(0, CORE_V - 80), distance: 980, yaw: ALONG_P, pitch: 87 * DEG2RAD, hour: 13 },
    // infrastructure
    highway: { target: T(-40, HW_V + 30, 6), distance: 300, yaw: SEAWARD + 52 * DEG2RAD, pitch: 11 * DEG2RAD, hour: 17.6 },
    ramp: { target: T(120, HW_V + 110, 6), distance: 400, yaw: SEAWARD + 12 * DEG2RAD, pitch: 24 * DEG2RAD, hour: 17.6 },
    junction: { target: R(0, CORE_V, 2), distance: 105, yaw: ALONG_P + 18 * DEG2RAD, pitch: 20 * DEG2RAD, hour: 17.4 },
    civic: { target: T(-3.5 * g.DT, CORE_V - 2 * g.DT, 8), distance: 175, yaw: SEAWARD + 40 * DEG2RAD, pitch: 17 * DEG2RAD, hour: 16.8 },
    park: { target: T(-0.5 * g.DT, COAST_V - 1.5 * g.DT, 4), distance: 135, yaw: SEAWARD + 50 * DEG2RAD, pitch: 15 * DEG2RAD, hour: 17.2 },
    bay: { target: T(-60, promAt(-60) - 8, 3), distance: 420, yaw: ALONG_P + 16 * DEG2RAD, pitch: 8 * DEG2RAD, hour: 18.9 },
  });

  if (station) {
    P.rail = {
      target: { x: station.x, y: station.y + 4, z: station.z },
      distance: 230, yaw: yawTo(-vx * 0.4 + ux, -vz * 0.4 + uz), pitch: 12 * DEG2RAD, hour: 17.5,
    };
  }
  if (obs) P.tower = { target: { x: obs.x, y: obs.y + 60, z: obs.z }, distance: 320, yaw: SEAWARD + 20 * DEG2RAD, pitch: 8 * DEG2RAD, hour: 17.4 };
  if (arena) P.arena = { target: { x: arena.x, y: arena.y + 12, z: arena.z }, distance: 300, yaw: INLAND + 40 * DEG2RAD, pitch: 16 * DEG2RAD, hour: 17.0 };
  if (hall) P.concerthall = { target: { x: hall.x, y: hall.y + 8, z: hall.z }, distance: 190, yaw: SEAWARD + 30 * DEG2RAD, pitch: 10 * DEG2RAD, hour: 18.9 };

  Object.assign(game.presets, P);

  // A preset may carry its own `hour`. An explicit ?time= always wins, and so does any setTime()
  // the caller makes after selecting the camera — tools/shot.mjs does exactly that.
  if (!game.__demoCamPatched) {
    let urlTime = false;
    try { urlTime = new URLSearchParams(window.location.search).has('time'); } catch (err) { void err; }
    const setCamera = game.setCamera.bind(game);
    game.setCamera = (nameOrView, immediate = true) => {
      const ok = setCamera(nameOrView, immediate);
      const view = typeof nameOrView === 'string' ? game.presets[nameOrView] : nameOrView;
      if (ok && !urlTime && view && typeof view.hour === 'number') game.setTime(view.hour);
      return ok;
    };
    game.__demoCamPatched = true;
  }

  game.demo = {
    cx, cz, ux, uz, vx, vz, COAST_V, CORE_V, HW_V, L, STEP: g.DT, HALF: g.GRID_U1,
    landmarks: g.landmarks, rail: g.rail, port: g.port,
  };
  return P;
}
