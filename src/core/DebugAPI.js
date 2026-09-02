import * as THREE from 'three';
import { DEG2RAD } from '../shared/math.js';

/**
 * window.__game — inspection & automation surface used by tools/shot.mjs and the critics.
 */
export function installDebugAPI(ctx) {
  const { engine, world, cameraController, events, config } = ctx;
  const half = world.half;
  const api = {
    ready: false,
    ctx,
    engine,
    world,
    scene: engine.scene,
    camera: engine.camera,
    cameraController,
    events,
    config,
    modules: ctx.modules,
    moduleStatus: ctx.moduleStatus,
    THREE,
    /** Camera presets: name → view. Demo/city code may add or override entries. */
    presets: {
      aerial: { target: { x: 0, z: 0 }, distance: 1500, yaw: 35 * DEG2RAD, pitch: 58 * DEG2RAD },
      city: { target: { x: 0, z: 0 }, distance: 420, yaw: 30 * DEG2RAD, pitch: 40 * DEG2RAD },
      street: { target: { x: 0, z: 0 }, distance: 70, yaw: -50 * DEG2RAD, pitch: 16 * DEG2RAD },
      skyline: { target: { x: 0, z: 0 }, distance: 950, yaw: 120 * DEG2RAD, pitch: 11 * DEG2RAD },
      closeup: { target: { x: 0, z: 0 }, distance: 32, yaw: 20 * DEG2RAD, pitch: 24 * DEG2RAD },
      top: { target: { x: 0, z: 0 }, distance: 900, yaw: 0, pitch: 87 * DEG2RAD },
      edge: { target: { x: half * 0.6, z: half * 0.6 }, distance: 700, yaw: 200 * DEG2RAD, pitch: 25 * DEG2RAD },
    },
    setCamera(nameOrView, immediate = true) {
      const view = typeof nameOrView === 'string' ? api.presets[nameOrView] : nameOrView;
      if (!view) { console.warn('[debug] unknown camera preset', nameOrView); return false; }
      cameraController.setView(view, immediate);
      // A beauty preset may carry its own hour (`{ …, time: 16.2 }`); applying it here is what makes
      // `--preset traffic_hero` without `--time` land on the sun the preset was composed for.
      // An explicit `--time` still wins: shot.mjs sets the time after the camera.
      if (typeof view.time === 'number') api.setTime(view.time);
      return true;
    },
    getCamera() {
      return cameraController.getView();
    },
    setTime(hour) {
      world.time.hour = ((hour % 24) + 24) % 24;
      events.emit('time:set', world.time.hour);
    },
    setSpeed(speed) {
      world.time.speed = speed;
      world.time.paused = speed === 0;
      events.emit('time:speed', speed);
    },
    setWeather(weather) {
      world.env.weather = weather;
      events.emit('weather:set', weather);
    },
    setTool(tool, options = {}) {
      world.tool.active = tool;
      world.tool.options = options;
      events.emit('tool:changed', tool, options);
    },
    /** Resolves after `frames` rendered frames. */
    waitStable(frames = 30) {
      return new Promise((resolve) => {
        const start = engine.frame;
        const check = () => (engine.frame - start >= frames ? resolve(engine.frame) : requestAnimationFrame(check));
        check();
      });
    },
    stats() {
      return { ...engine.stats(), moduleStatus: { ...ctx.moduleStatus }, errors: [...engine.errors, ...api.errors], time: world.time.hour, population: world.economy.population, money: Math.round(world.economy.money || 0), happiness: +(world.economy.happiness || 0).toFixed(3), buildings: world.buildings.list.length, roads: world.roads.segments.size, vehicles: world.traffic.vehicles };
    },
    errors: [],
    /** Count objects in the scene by type — quick sanity check for critics. */
    sceneSummary() {
      const counts = {};
      engine.scene.traverse((o) => { counts[o.type] = (counts[o.type] || 0) + 1; });
      return counts;
    },
  };
  window.addEventListener('error', (e) => api.errors.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => api.errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));
  window.__game = api;
  return api;
}
