/**
 * roads module — road network graph, mesh generation and the public `world.roads.api`
 * (see ARCHITECTURE.md §4/§5). Rendering is tile-batched and only rebuilds what changed.
 * Listens to `infoview:changed` (traffic view tints segments by load) and `entity:selected`
 * (highlights the selected road) through the asphalt shader's info texture.
 */
import * as THREE from 'three';
import { RoadNetwork } from './RoadNetwork.js';
import { RoadMaterials } from './RoadMaterials.js';
import { RoadRenderer } from './RoadRenderer.js';
import { publicTypes } from './RoadTypes.js';

export const name = 'roads';

let network = null;
let renderer = null;
let materials = null;
let ctxRef = null;
const offs = [];

// info-view state
let infoView = null;
let selectedRoad = null;
let infoDirty = false;
let infoFrame = 0;
const _c = new THREE.Color();
const SELECT_COLOR = new THREE.Color(1.0, 0.8, 0.28);

export async function init(ctx) {
  ctxRef = ctx;
  const { engine, world, events, assets } = ctx;
  network = new RoadNetwork(world, events);
  materials = new RoadMaterials(engine);
  renderer = new RoadRenderer(ctx, network, materials);

  world.roads.api = {
    types: publicTypes(),
    build: (points, typeId = 'local', opts = {}) => network.build(points, typeId, opts),
    remove: (segmentId) => network.remove(segmentId),
    snap: (x, z, radius = 8) => network.snap(x, z, radius),
    nearest: (x, z, maxDist = 30) => network.nearest(x, z, maxDist),
    sampleEdge: (segmentId, t, side = 1) => network.sampleEdge(segmentId, t, side),
    segmentsInRadius: (x, z, r) => network.segmentsInRadius(x, z, r),
    laneGraph: () => network.laneGraph(),
    /** Extras (not in the contract, safe to ignore). */
    surfaceHeight: (x, z) => network.surfaceHeight(x, z),
    isOnRoad: (x, z) => network.surfaceHeight(x, z) != null,
    getSegment: (id) => network.segments.get(id) || null,
    getNode: (id) => network.nodes.get(id) || null,
    heightAt: (segmentId, s) => { const seg = network.segments.get(segmentId); return seg ? network.heightAt(seg, s) : null; },
    clear: () => network.clear(),
    flush: () => renderer.flush(),
    rebuild: () => { network.refreshAll(); renderer.flush(); },
    conformAll: () => network._conformTerrainFor([...network.segments.keys()], [...network.nodes.keys()]),
    setInfoView: (view) => { infoView = view; infoDirty = true; },
    /** Street lamps are part of the road asset (CS2 style); a props module may switch them off. */
    setStreetLights: (on) => renderer.setStreetLights(on),
    stats: () => ({ segments: network.segments.size, nodes: network.nodes.size, version: world.roads.version, flattenCalls: network.flattenCalls, badFans: network.badFans || 0, ...renderer.stats }),
  };

  // terrain may (re)initialise after us — re-fit heights when it does
  offs.push(events.on('terrain:ready', () => { if (network.segments.size) network.refreshAll(); }));
  offs.push(events.on('infoview:changed', (p) => { infoView = p && p.view ? p.view : null; infoDirty = true; }));
  offs.push(events.on('entity:selected', (p) => {
    const id = p && p.kind === 'road' ? p.id : null;
    if (id !== selectedRoad) { selectedRoad = id; infoDirty = true; }
  }));
  offs.push(events.on('roads:changed', () => { infoDirty = true; }));

  await materials.load(assets);
}

/** Traffic load 0..1 → green / amber / red (sRGB). */
function trafficColor(t, out) {
  t = Math.min(1, Math.max(0, t || 0));
  if (t < 0.5) return out.setRGB(0.25 + 1.4 * t, 0.78, 0.25 - 0.1 * t);
  return out.setRGB(0.95, 0.78 - 1.2 * (t - 0.5), 0.2 - 0.1 * (t - 0.5));
}

function refreshInfo() {
  materials.clearInfo();
  if (infoView === 'traffic') {
    for (const seg of network.segments.values()) {
      const load = seg.traffic != null ? seg.traffic : 0;
      materials.setInfoSlot(seg.slot, trafficColor(load, _c), 0.62);
    }
  }
  if (selectedRoad) {
    const seg = network.segments.get(selectedRoad);
    if (seg) materials.setInfoSlot(seg.slot, SELECT_COLOR, 0.5);
  }
  materials.commitInfo();
  infoDirty = false;
}

export function update() {
  if (!renderer || !ctxRef) return;
  if (renderer.dirty) renderer.flush();
  materials.setNight(ctxRef.world.env.nightFactor || 0);
  // rain: the water film is a clearcoat lobe on top of the tarmac (roughness + albedo are driven inside
  // the shaders straight off the same uniform), so a wet street reflects the lamps above it
  materials.setWetness(ctxRef.engine.globalUniforms.uWetness.value);
  // traffic loads change continuously — refresh the tint a few times per second while the view is up
  infoFrame++;
  if (infoDirty || (infoView === 'traffic' && infoFrame % 20 === 0)) refreshInfo();
}

export function dispose() {
  for (const off of offs) if (typeof off === 'function') off();
  offs.length = 0;
  if (renderer) renderer.dispose();
  if (materials) materials.dispose();
  network = renderer = materials = null;
}
