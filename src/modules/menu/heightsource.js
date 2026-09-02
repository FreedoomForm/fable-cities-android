/**
 * Height source for the start-screen backdrop and the seed preview.
 *
 * Preferred path: the REAL generator — `src/modules/terrain/Heightmap.js` is pure JS (no three.js)
 * and its analytic `sampleGen(x, z, lod)` is the same function the world is built from, so what the
 * player sees on the menu is the land they get. It is imported dynamically and read-only; the menu
 * never touches the terrain module.
 *
 * Fallback path: if that import fails (another builder mid-edit), a compact stand-in with the same
 * composition — coastal plain, meandering river, mountains to the north — keeps the menu alive.
 */
import { SimplexNoise } from '../../shared/noise.js';
import { clamp, smoothstep, lerp } from '../../shared/math.js';

/**
 * @returns {Promise<{ sample(x,z,lod):number, waterLevel:number, real:boolean }>}
 */
export async function makeHeightSource(seed) {
  try {
    const mod = await import('../terrain/Heightmap.js');
    const hm = new mod.Heightmap({ size: 2048, spacing: 2, seed: seed >>> 0 });
    const probe = hm.sampleGen(0, 0, 1);
    if (Number.isFinite(probe)) {
      return {
        sample: (x, z, lod) => hm.sampleGen(x, z, lod),
        waterLevel: Number.isFinite(hm.waterLevel) ? hm.waterLevel : 0,
        real: true,
      };
    }
  } catch (err) {
    if (typeof console !== 'undefined' && console.info) {
      console.info('[menu] terrain generator unavailable, using preview stand-in', err && err.message);
    }
  }
  return fallbackSource(seed);
}

function fallbackSource(seed) {
  const s = seed >>> 0;
  const nBase = new SimplexNoise(s * 7 + 1);
  const nMid = new SimplexNoise(s * 7 + 2);
  const nMount = new SimplexNoise(s * 7 + 4);
  const nRiver = new SimplexNoise(s * 7 + 5);
  const nCoast = new SimplexNoise(s * 7 + 7);
  const r = (k, a, b) => a + (b - a) * (0.5 + 0.5 * nMount.noise2D(k * 13.7, -k * 3.1));
  const riv = { x0: r(1, -420, -180), amp: r(2, 140, 220), wave: r(3, 380, 520), phase: r(4, 0, 6.283), width: r(5, 26, 38) };
  const cst = { z0: r(6, 560, 700), amp: r(7, 90, 160), wave: r(8, 420, 620), phase: r(9, 0, 6.283) };

  const riverX = (z) => riv.x0 + riv.amp * Math.sin(z / riv.wave + riv.phase) + 70 * nRiver.noise2D(z / 260, 3.3);
  const coastZ = (x) => cst.z0 + cst.amp * Math.sin(x / cst.wave + cst.phase) + 60 * nCoast.noise2D(x / 300, 1.5);

  const sample = (x, z, lod = 0) => {
    const oct = lod === 0 ? 4 : lod === 1 ? 3 : 2;
    const low = nBase.fbm2D(x / 1150, z / 1150, 3);
    const mid = nMid.fbm2D(x / 300, z / 300, oct);
    const upland = smoothstep(-0.05, 0.55, low + 0.15 * mid);
    let h = 7.5 + 1.6 * mid + (1 - upland) * (5 * nMid.fbm2D(x / 230, z / 230, 3)) + upland * (34 + 26 * mid);

    const mMask = nMount.fbm2D(x / 1500 + 4.2, z / 1500 - 1.7, 3) + 0.7 * (-clamp(z, -1024, 1024) / 1024) - 0.05;
    let mount = smoothstep(0.22, 0.7, mMask) * smoothstep(120, 520, Math.hypot(x, z));
    const ridge = nMount.ridged2D(x / 360 + 9, z / 360 - 5, oct + 1, 2.1, 0.5);
    const mh = 60 + 150 * ridge;

    const dc = z - coastZ(x);
    const d = Math.abs(x - riverX(z));
    const w = riv.width * (1 + 0.9 * smoothstep(-420, 60, dc));
    mount *= smoothstep(120, 460, d) * smoothstep(-80, -520, dc);
    h = lerp(h, 4.6 + 1.4 * mid, smoothstep(260, 90, d));
    h += mount * mh;
    h = lerp(h, 3.8 + 1.2 * mid, smoothstep(-460, -140, dc) * (1 - mount) * 0.92);
    h = lerp(h, 1.4 - 2.6 * (dc + 80) / 80, smoothstep(-80, 0, dc) * 0.95);
    if (d < w) h = Math.min(h, 0.7 - 9 * Math.pow(1 - (d / w) * (d / w), 1.15));
    if (dc > 0) h = Math.min(h, lerp(h, -2.5 - 20 * smoothstep(0, 900, dc), smoothstep(0, 40, dc)));
    return h;
  };
  return { sample, waterLevel: 0, real: false };
}
