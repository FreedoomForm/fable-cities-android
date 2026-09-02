/**
 * props — street furniture.
 *
 * Scatters trees, benches, bins, hydrants, planters, signs, traffic signals, bus shelters, hedges,
 * fences and kerbside parked cars along the road network (`roads.api.sampleEdge`, `roads:changed`)
 * and along lot boundaries (`zones.api.lotsFor`). Everything is instanced with per-instance distance
 * and frustum culling plus a tree LOD, so the draw-call count stays flat as the city grows.
 *
 * Street lighting: the road asset itself carries the lamp posts (CS2-style, phase-locked to the
 * analytic light pools the asphalt shader paints), so props does not duplicate the poles — it adds
 * what a shader pool cannot do: real PointLights (up to ~14, the ones nearest the camera), warm
 * halos around every luminaire and its own classic lamps on the park paths the road asset leaves
 * unlit. `world.props.api.refresh()` re-scatters after the network changes.
 */
import { PropAssets } from './PropAssets.js';
import { PropRenderer } from './PropRenderer.js';
import { PropScatter } from './PropScatter.js';

export const name = 'props';

let ctxRef = null;
let assets = null;
let renderer = null;
let scatter = null;
let offs = [];
let pending = -1;
let density = 1;
let lastRefreshMs = 0;
let refreshCount = 0;

export async function init(ctx) {
  ctxRef = ctx;
  const { world, events } = ctx;

  assets = new PropAssets(ctx);
  await assets.load();
  renderer = new PropRenderer(ctx, assets);
  scatter = new PropScatter(ctx, assets);

  world.props.api = {
    refresh: () => refresh(),
    setDensity: (f) => { density = Math.max(0, Math.min(2, Number(f) || 0)); schedule(0.05); },
    get density() { return density; },
    stats: () => ({
      ...renderer.stats,
      sources: scatter.sources.length,
      refreshMs: +lastRefreshMs.toFixed(1),
      refreshes: refreshCount,
      counts: { ...scatter.counts },
      models: assets.modelSizes,
    }),
    /** Debug: every placement of one kind (used by the showcase to aim the cameras). */
    itemsOf: (kindId) => {
      const k = assets.kinds.get(kindId);
      return k ? k.items.slice() : [];
    },
  };

  const bump = () => schedule(0.3);
  offs.push(events.on('roads:changed', bump));
  offs.push(events.on('zones:changed', bump));
  offs.push(events.on('building:added', () => schedule(1.2)));
  offs.push(events.on('building:removed', () => schedule(1.2)));
  offs.push(events.on('terrain:ready', () => schedule(0.4)));

  if (world.roads && world.roads.segments && world.roads.segments.size) refresh();
}

function schedule(delay) {
  pending = pending < 0 ? delay : Math.min(pending, delay);
}

function refresh() {
  if (!scatter || !renderer) return;
  const t0 = performance.now();
  scatter.scatter(density);
  renderer.sources = scatter.sources;
  renderer.build();
  lastRefreshMs = performance.now() - t0;
  refreshCount++;
  pending = -1;
}

export function update(dt, elapsed) {
  if (!ctxRef || !renderer) return;
  const { world, camera } = ctxRef;
  if (pending >= 0) {
    pending -= dt;
    if (pending <= 0) refresh();
  }
  const night = world.env && typeof world.env.nightFactor === 'number' ? world.env.nightFactor : 0;
  assets.setNight(night, elapsed, world.env);
  renderer.update(dt, camera);
  renderer.updateLights(camera, night, dt);
}

export function dispose() {
  for (const off of offs) { try { off(); } catch { /* ignore */ } }
  offs = [];
  if (renderer) renderer.dispose();
  if (assets) assets.dispose();
  if (ctxRef) ctxRef.world.props.api = null;
  renderer = null; assets = null; scatter = null; ctxRef = null;
  pending = -1;
}
