/**
 * Runtime configuration parsed from URL parameters.
 *   ?demo=1        build the demo city on start (default 1)
 *   ?seed=1337     deterministic seed for all procedural generation
 *   ?time=14.5     starting hour of day (0-24)
 *   ?cam=city      camera preset (aerial | city | street | skyline | closeup or a demo-defined preset)
 *   ?quality=high  low | medium | high | ultra
 *   ?paused=1      start with simulation paused
 *   ?focus=a,b     only load the listed modules (for isolated development)
 *   ?weather=clear clear | cloudy | rain | fog | snow
 *   ?headless=1    deterministic fixed timestep for screenshots
 *   ?debug=1       verbose logging
 *   ?menu=0        skip the start screen (implied by ?demo=, ?showcase= or ?headless=)
 *   ?showcase=roads  run src/modules/<name>/showcase.js after init (implies demo=0 unless demo=1 given)
 */
export class Config {
  constructor(search = typeof window !== 'undefined' ? window.location.search : '') {
    const p = new URLSearchParams(search);
    this.params = p;
    this.menuParam = p.get('menu');
    this.showcase = p.get('showcase') ? p.get('showcase').split(',').map((s) => s.trim()).filter(Boolean) : null;
    // demo city is on by default, except when a module showcase is requested explicitly
    this.demo = p.has('demo') ? p.get('demo') !== '0' : !this.showcase;
    this.seed = int(p.get('seed'), 1337);
    this.time = float(p.get('time'), 14.0);
    this.cam = p.get('cam') || 'city';
    this.quality = QUALITY[p.get('quality')] ? p.get('quality') : 'high';
    this.paused = p.get('paused') === '1';
    this.focus = p.get('focus') ? p.get('focus').split(',').map((s) => s.trim()).filter(Boolean) : null;
    this.weather = p.get('weather') || 'clear';
    this.mapSize = int(p.get('map'), 2048);
    this.headless = p.get('headless') === '1';
    /**
     * Start screen. Shown only when the caller has NOT pinned the world with an explicit
     * demo/showcase/headless parameter, so every screenshot and showcase URL keeps working unchanged.
     * Force it on with ?menu=1, off with ?menu=0.
     */
    this.menu = this.menuParam != null
      ? this.menuParam !== '0'
      : (!p.has('demo') && !this.showcase && !this.headless);
    this.debug = p.get('debug') === '1';
    this.timeScale = float(p.get('timescale'), 1);
  }
  get(name, fallback = null) {
    return this.params.has(name) ? this.params.get(name) : fallback;
  }
}

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function float(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Quality presets. Modules read `engine.quality` and scale their own detail accordingly.
 *   density      vegetation / particle / scatter density
 *   propDensity  street furniture only (so "fewer trees" does not also delete benches and lamps)
 *   lightBudget  soft cap on registered point/spot lights across ALL modules (engine.registerLight)
 */
export const QUALITY = {
  low: {
    name: 'low', pixelRatio: 1, shadowMapSize: 1024, cascades: 2, shadowDistance: 600,
    gtao: false, bloom: true, smaa: true, anisotropy: 4, drawDistance: 2500,
    density: 0.4, reflections: false, particles: 0.3, textureSize: 1024,
    propDensity: 0.4, lightBudget: 8,
  },
  medium: {
    name: 'medium', pixelRatio: 1, shadowMapSize: 2048, cascades: 3, shadowDistance: 900,
    gtao: true, bloom: true, smaa: true, anisotropy: 8, drawDistance: 3500,
    density: 0.7, reflections: false, particles: 0.6, textureSize: 1024,
    propDensity: 0.7, lightBudget: 16,
  },
  high: {
    name: 'high', pixelRatio: 1.5, shadowMapSize: 2048, cascades: 4, shadowDistance: 1400,
    gtao: true, bloom: true, smaa: true, anisotropy: 16, drawDistance: 5000,
    density: 1.0, reflections: true, particles: 1.0, textureSize: 2048,
    propDensity: 1.0, lightBudget: 32,
  },
  ultra: {
    name: 'ultra', pixelRatio: 2, shadowMapSize: 4096, cascades: 4, shadowDistance: 2000,
    gtao: true, bloom: true, smaa: true, anisotropy: 16, drawDistance: 8000,
    density: 1.3, reflections: true, particles: 1.3, textureSize: 2048,
    propDensity: 1.4, lightBudget: 48,
  },
};
