/**
 * Weather state: presets per weather type, smooth transitions, wetness / snow accumulation and
 * a slowly wandering wind. Everything is driven by real seconds and is deterministic per seed.
 */
import * as THREE from 'three';
import { SimplexNoise } from '../../shared/noise.js';
import { clamp01, damp, lerp } from '../../shared/math.js';

export const WEATHER_PRESETS = {
  //  cover    cumulus coverage 0..1          type     0 stratus .. 1 cumulus
  //  cirrus   high-altitude veil coverage    fog      exp2 density (1/m)        fogH  height-fog scale (m)
  //  fogFloor uniform-haze floor 0..1        turbidity aerosol load             sun   direct-sun fraction between the clouds (the
  //  cloud-shadow map carves the local blocking, so broken skies keep a strong sun in the gaps)
  //  diffuse  fraction of the blocked sunlight re-emitted downward as diffuse skylight (bright overcast / fog)
  //  milk     how much the fog medium is the luminous overcast diffuser (1 = daytime fog: high-key, near-white)
  //  skyFog   how much the sky dome dissolves into the fog colour (dense fog hides the sky)
  // AERIAL PERSPECTIVE (LOOK_TARGET rows 11/12): CS2 daytime frames carry a far third 2.15x BRIGHTER than the near
  // third at 35-52 % of its local contrast. That needs ~50 % extinction at 1.5 km — an exp2 density near 6e-4, six
  // times the r3 value — and a height scale (fogH) tall enough to cover the mountains instead of stopping at 150 m.
  clear:  { cover: 0.30, type: 0.88, cirrus: 0.26, fog: 0.000560, fogH: 620, fogFloor: 0.38, turbidity: 2.0, sun: 1.00, diffuse: 0.55, milk: 0.00, skyFog: 0.00, wind: 0.35, rain: 0, snow: 0, temp: 22, density: 0.04 },
  cloudy: { cover: 0.60, type: 0.72, cirrus: 0.45, fog: 0.000720, fogH: 560, fogFloor: 0.42, turbidity: 3.0, sun: 0.72, diffuse: 0.55, milk: 0.35, skyFog: 0.18, wind: 0.55, rain: 0, snow: 0, temp: 16, density: 0.042 },
  rain:   { cover: 0.96, type: 0.30, cirrus: 0.20, fog: 0.001050, fogH: 420, fogFloor: 0.46, turbidity: 5.0, sun: 0.08, diffuse: 0.38, milk: 0.60, skyFog: 0.55, wind: 0.85, rain: 1, snow: 0, temp: 12, density: 0.045 },
  fog:    { cover: 0.55, type: 0.35, cirrus: 0.00, fog: 0.002300, fogH: 150, fogFloor: 0.42, turbidity: 5.5, sun: 0.26, diffuse: 0.62, milk: 1.00, skyFog: 0.92, wind: 0.10, rain: 0, snow: 0, temp: 9,  density: 0.035 },
  snow:   { cover: 0.93, type: 0.35, cirrus: 0.10, fog: 0.001150, fogH: 400, fogFloor: 0.46, turbidity: 5.5, sun: 0.13, diffuse: 0.50, milk: 0.80, skyFog: 0.65, wind: 0.50, rain: 0, snow: 1, temp: -3, density: 0.040 },
};

const SMOOTHED = ['cover', 'type', 'cirrus', 'fog', 'fogH', 'fogFloor', 'turbidity', 'sun', 'diffuse', 'milk', 'skyFog', 'density'];

export class Weather {
  constructor(seed, initial = 'clear') {
    this.noise = new SimplexNoise(seed ^ 0x77ea);
    this.name = WEATHER_PRESETS[initial] ? initial : 'clear';
    const p = WEATHER_PRESETS[this.name];
    /** Smoothed current values. */
    this.state = { ...p, precipitation: p.rain || p.snow };
    /** Accumulated surface wetness / snow cover (0..1). */
    this.wetness = p.rain ? 1 : 0;
    this.snowCover = p.snow ? 1 : 0;
    this.wind = new THREE.Vector2(0.7, 0.3).normalize();
    this.windStrength = p.wind;
    this.time = 0;
    this._windAngleBase = this.noise.noise2D(0.5, 0.5) * Math.PI;
  }

  /** Switch weather. `instant` snaps all smoothed values. */
  set(name, instant = false) {
    if (!WEATHER_PRESETS[name]) return false;
    this.name = name;
    if (instant) this.snap();
    return true;
  }

  snap() {
    const p = WEATHER_PRESETS[this.name];
    Object.assign(this.state, p, { precipitation: p.rain || p.snow });
    this.wetness = p.rain ? 1 : 0;
    this.snowCover = p.snow ? 1 : 0;
    this.windStrength = p.wind;
  }

  /** dt: real seconds (transitions); gameSeconds: game clock for the deterministic wind wander. */
  update(dt, gameSeconds = null) {
    this.time = gameSeconds != null ? gameSeconds / 180 : this.time + dt; // 180 game-s per real-s at speed 1
    const p = WEATHER_PRESETS[this.name];
    const s = this.state;
    const k = 0.32; // ~10 s transitions
    for (const key of SMOOTHED) s[key] = damp(s[key], p[key], k, dt);
    s.temp = damp(s.temp, p.temp, 0.1, dt);
    s.precipitation = damp(s.precipitation, p.rain || p.snow, k, dt);
    // wetness rises fast in rain, dries slowly afterwards
    const rainTarget = p.rain;
    this.wetness = rainTarget > this.wetness ? Math.min(1, this.wetness + dt / 18) : Math.max(0, this.wetness - dt / 120);
    const snowTarget = p.snow;
    this.snowCover = snowTarget > this.snowCover ? Math.min(1, this.snowCover + dt / 45) : Math.max(0, this.snowCover - dt / 240);
    // wind wanders slowly
    this.windStrength = damp(this.windStrength, p.wind * (0.85 + 0.3 * (0.5 + 0.5 * this.noise.noise2D(this.time * 0.02, 3.7))), 0.2, dt);
    const ang = this._windAngleBase + this.noise.noise2D(this.time * 0.004, 11.3) * 1.2;
    this.wind.set(Math.cos(ang), Math.sin(ang));
  }

  /** Deterministic cloud-drift speed: the preset's nominal wind, never the per-frame wander. `windStrength`
   *  is damped frame by frame, so using it made the cloud field's position depend on how many frames had been
   *  rendered — a 0.01 change moved the deck (and its ground shadows) by ~100 m, which broke both the
   *  seed+time reproducibility the contract requires and any attempt to compose a frame around the clouds. */
  get driftWind() {
    return WEATHER_PRESETS[this.name].wind;
  }

  /** Cloud-cover fraction 0..1 (smoothed). */
  get cloudCover() {
    return clamp01(this.state.cover);
  }
  /** Fraction of direct sunlight passing the cloud deck (smoothed). */
  get sunFactor() {
    return lerp(1, this.state.sun, 1);
  }
}
