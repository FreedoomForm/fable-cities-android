/**
 * props showcase — a compact district built through the public APIs so the street furniture can be
 * judged in context: a signalised avenue crossing, local streets with kerbside parking, a suburban
 * block with hedges and picket fences, an industrial block with chain-link, and a small park with
 * paths, classic lamps and benches.
 *
 * Run with `?showcase=props&seed=7`. Presets: props_hero, props_detail, props_night
 * (plus props_street, props_park, props_junction, props_suburb, props_industrial, props_top).
 */
import { hashString } from '../../shared/random.js';

const D = Math.PI / 180;
const LINES = [-330, -220, -110, 0, 110, 220, 330];

/** District plan by block centre (block = the square between two grid lines). */
function districtFor(bx, bz) {
  if (bx > 220 && bz < -110) return 'ind';
  const r = Math.max(Math.abs(bx), Math.abs(bz));
  if (r <= 55) return 'com-high';
  if (r <= 165) return bz < 0 ? 'com-low' : 'res-high';
  if (bx < -110 && bz > 110) return 'office';
  return 'res-low';
}

export async function showcase(ctx) {
  const { world } = ctx;
  const roads = world.roads.api;
  const zones = world.zones.api;
  const buildings = world.buildings.api;
  const props = world.props.api;
  if (!props) throw new Error('props api missing');
  const rng = world.rng.fork(hashString('props-showcase'));

  /* ------------------------------------------------------------- 1. roads */
  if (roads && roads.build) {
    for (const x of LINES) roads.build([{ x, z: -330 }, { x, z: 330 }], x === 0 ? 'avenue' : 'local');
    for (const z of LINES) roads.build([{ x: -330, z }, { x: 330, z }], z === 0 ? 'avenue' : 'local');
    // a curved residential loop in the south-west block
    roads.build([{ x: -220, z: 165 }, { x: -165, z: 210 }, { x: -110, z: 165 }], 'local', { curve: 'bezier' });
    // park paths in the block east of the centre (110…220 × 110…220)
    roads.build([{ x: 110, z: 165 }, { x: 152, z: 132 }, { x: 190, z: 150 }, { x: 220, z: 132 }], 'path', { curve: 'catmull' });
    roads.build([{ x: 165, z: 110 }, { x: 158, z: 150 }, { x: 172, z: 190 }, { x: 165, z: 220 }], 'path', { curve: 'catmull' });
    if (roads.flush) roads.flush();
  }

  /* ------------------------------------------------------------ 2. zoning */
  const inset = (line) => (line === 0 ? 14 : 8);
  let lots = [];
  if (zones && zones.paintRect) {
    for (let i = 0; i < LINES.length - 1; i++) {
      for (let j = 0; j < LINES.length - 1; j++) {
        const x0 = LINES[i], x1 = LINES[i + 1], z0 = LINES[j], z1 = LINES[j + 1];
        const bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
        if (bx > 110 && bx < 220 && bz > 110 && bz < 220) continue;   // keep the park green
        zones.paintRect(x0 + inset(x0), z0 + inset(z0), x1 - inset(x1), z1 - inset(z1), districtFor(bx, bz));
      }
    }
    lots = zones.lotsFor();
  } else if (buildings && buildings.autoZone) {
    lots = buildings.autoZone({ typeFor: (seg, x, z) => districtFor(x, z) });
  }

  /* ---------------------------------------------------------- 3. buildings */
  if (buildings && buildings.fastForward) buildings.fastForward(3600 * 24 * 50);
  void rng;

  /* ----------------------------------------------------------- 4. settle */
  if (window.__game && window.__game.waitStable) await window.__game.waitStable(24);
  props.refresh();
  if (window.__game && window.__game.waitStable) await window.__game.waitStable(4);
  console.info('[props:showcase]', lots.length, 'lots,', props.stats().placed, 'props,', props.stats().sources, 'luminaires');

  /* ------------------------------------------------------------- 5. sun */
  // Beauty frames are never shot at noon: the reference frames sit at a 22-34 degree sun, which at
  // this latitude is hour 16.0-16.5 (LOOK_TARGET). Only override when the URL did not ask for a time.
  if (!ctx.config || !ctx.config.params || !ctx.config.params.has('time')) {
    if (window.__game && window.__game.setTime) window.__game.setTime(16.2);
    if (window.__game && window.__game.waitStable) await window.__game.waitStable(3);
  }

  /* ---------------------------------------------------------- 6. cameras */
  // presets aim along the streets (the orbit camera sits at target + dir(yaw,pitch)·distance) and
  // carry an explicit target height, so nothing is framed through a hillside on a hilly seed.
  const terrain = world.terrain;
  const surf = (x, z) => {
    const r = roads && roads.surfaceHeight ? roads.surfaceHeight(x, z) : null;
    return (r != null ? r : terrain.getHeight(x, z));
  };
  const view = (x, z, yaw, pitch, distance, up = 1.8) =>
    ({ target: { x, y: surf(x, z) + up, z }, distance, yaw: yaw * D, pitch: pitch * D });

  const P = window.__game.presets;
  // hero: looking north up the avenue through the signalised crossing
  P.props_hero = view(0, -58, 4, 12, 76, 2.2);
  P.props_hero.time = 16.2;
  // detail: a residential street at eye height — kerbside parking, drives, hedges, fences, street trees
  P.props_detail = view(220, 250, 5, 12, 34, 1.6);
  // night: the same crossing after dark (signals, halos, real point lights)
  P.props_night = view(0, -50, 5, 13, 62, 2.0);
  P.props_junction = view(110, 0, 90, 17, 50, 2.0);
  P.props_park = view(158, 168, 320, 31, 48, 1.7);
  P.props_suburb = view(-165, 196, 6, 13, 50, 1.8);
  P.props_industrial = view(275, -113, 186, 15, 58, 2.0);
  P.props_street = view(112, -62, 192, 14, 31, 1.6);
  P.props_top = { target: { x: 60, y: surf(60, 40), z: 40 }, distance: 470, yaw: 25 * D, pitch: 58 * D };
}
