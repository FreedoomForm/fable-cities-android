/**
 * Module registry. Order = initialisation order. Each module directory exports:
 *   export const name = 'terrain';
 *   export async function init(ctx) {}
 *   export function update(dt, elapsed) {}     // optional, per frame
 *   export function dispose() {}                // optional
 * Modules are loaded with dynamic import inside try/catch — a broken module never takes
 * the whole game down; its status is recorded in window.__game.moduleStatus.
 */
export const MODULES = [
  // The menu is imported directly by main.js BEFORE this list runs, so its start screen can pick the
  // seed. It is listed here only so it appears in moduleStatus and gets its update() registered.
  { name: 'menu', order: 5, load: () => import('./menu/index.js') },
  { name: 'terrain', order: 10, load: () => import('./terrain/index.js') },
  { name: 'environment', order: 20, load: () => import('./environment/index.js') },
  { name: 'roads', order: 30, load: () => import('./roads/index.js') },
  { name: 'zoning', order: 40, load: () => import('./zoning/index.js') },
  { name: 'buildings', order: 50, load: () => import('./buildings/index.js') },
  { name: 'props', order: 60, load: () => import('./props/index.js') },
  { name: 'traffic', order: 70, load: () => import('./traffic/index.js') },
  { name: 'effects', order: 80, load: () => import('./effects/index.js') },
  { name: 'simulation', order: 90, load: () => import('./simulation/index.js') },
  { name: 'tools', order: 100, load: () => import('./tools/index.js') },
  { name: 'ui', order: 110, load: () => import('./ui/index.js') },
  { name: 'audio', order: 120, load: () => import('./audio/index.js') },
];
