/**
 * Terrain showcase — registers representative camera presets over the generated landscape:
 * river valley, coast, mountains, forest detail, the horizon ring and a night view. Uses only the
 * terrain api (no cherry-picked angles: the hero looks across the valley towards the hills).
 */
import { DEG2RAD } from '../../shared/math.js';

export async function showcase(ctx) {
  const { world } = ctx;
  const api = world.terrain.api;
  const hm = api.heightmap;
  const presets = window.__game.presets;

  // find a river bend near the map centre and a coast spot
  const zBend = -120;
  const riverX = hm.riverX(zBend);
  const coastX = 220;
  const coastZ = hm.coastZ(coastX);
  // a forested hill: scan for the highest forest probability on the eastern uplands
  let best = { x: 500, z: -250, s: -1 };
  for (let z = -800; z <= 400; z += 40) for (let x = 100; x <= 900; x += 40) {
    const h = hm.getHeight(x, z);
    const s = api.forestMask(x, z) * (h > 25 && h < 90 ? 1 : 0.2);
    if (s > best.s) best = { x, z, s };
  }
  // mountain viewpoint: the highest point in the northern third
  let peak = { x: 0, z: -800, h: -1 };
  for (let z = -1000; z <= -300; z += 32) for (let x = -1000; x <= 1000; x += 32) {
    const h = hm.getHeight(x, z);
    if (h > peak.h) peak = { x, z, h };
  }

  // LOOK_TARGET: no CS2 beauty frame is shot at noon — cast shadows there run 1.5-2.5x object height
  // (sun elevation 22-34 deg), which at this latitude is hour 16.0-16.5. The hero defaults there.
  presets.terrain_hero = { target: { x: riverX + 40, z: zBend + 60 }, distance: 520, yaw: 205 * DEG2RAD, pitch: 24 * DEG2RAD, time: 16.2 };
  // unless the URL asked for a specific hour, put the showcase at the hero's low sun
  if (!new URLSearchParams(location.search).has('time')) window.__game.setTime(16.2);
  // bank close-up: meadow + undergrowth in the foreground, the river and its far bank behind
  const rw = hm.riverHalfWidth(zBend);
  // camera stands 34 m inland on the meadow and looks across the bank to the river: near turf and
  // undergrowth in the foreground, shoreline in the middle, water and the far bank behind
  presets.terrain_detail = { target: { x: riverX + rw + 20, z: zBend + 6 }, distance: 34, yaw: 228 * DEG2RAD, pitch: 16 * DEG2RAD, time: 16.2 };
  presets.terrain_night = { target: { x: coastX, z: coastZ - 110 }, distance: 300, yaw: 168 * DEG2RAD, pitch: 27 * DEG2RAD, time: 21 };
  presets.terrain_coast = { target: { x: coastX, z: coastZ - 40 }, distance: 300, yaw: 150 * DEG2RAD, pitch: 24 * DEG2RAD };
  presets.terrain_forest = { target: { x: best.x, z: best.z }, distance: 110, yaw: 40 * DEG2RAD, pitch: 22 * DEG2RAD };
  presets.terrain_mountain = { target: { x: peak.x, z: peak.z + 120 }, distance: 760, yaw: 12 * DEG2RAD, pitch: 17 * DEG2RAD };
  // looking north across the map edge onto the horizon ring (seam / mountain range check)
  presets.terrain_horizon = { target: { x: 200, z: -900 }, distance: 900, yaw: 0, pitch: 12 * DEG2RAD };
  presets.terrain_aerial = { target: { x: 0, z: 0 }, distance: 2300, yaw: 20 * DEG2RAD, pitch: 55 * DEG2RAD };
  presets.terrain_valley = { target: { x: 60, z: 120 }, distance: 700, yaw: -35 * DEG2RAD, pitch: 30 * DEG2RAD };
}
