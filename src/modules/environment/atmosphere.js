/**
 * CPU side of the physically based sky: single-scattering atmosphere (Rayleigh + Mie + ozone)
 * that mirrors the GLSL in shaders.js, plus sun / moon ephemeris and the exposure curve.
 * Units: metres, radiance in renderer units (a DirectionalLight of intensity ~3.5 == noon sun).
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, DEG2RAD } from '../../shared/math.js';

export const ATMOS = {
  planetRadius: 6371e3,
  atmosphereRadius: 6471e3,
  betaR: [5.802e-6, 13.558e-6, 33.1e-6],
  betaM: 3.996e-6,      // Mie scattering at turbidity 1
  betaMA: 4.4e-6,       // Mie absorption at turbidity 1
  betaO: [1.95e-6, 5.64e-6, 0.25e-6], // Chappuis band ×3: keeps the zenith blue at sunset and the twilight sky blue-violet
  HR: 8000,
  HM: 1200,
  mieG: 0.80,
  /** Sun irradiance at the top of the atmosphere in renderer units. */
  sunE: 4.0,
  /** Multiple-scattering compensation applied to Rayleigh single scattering. */
  scatterBoost: 2.3,
  /** Explicit multiple-scattering term: sky-lit in-scatter along the view path (white-blue, not sun-coloured) — keeps the
   *  anti-solar horizon and shadows cool at sunset instead of a sepia wash. */
  msK: 0.04,
  msSpectrum: [0.6, 0.82, 1.35],
  msSunAtten: 0.45,
  /** Boost for the Mie (haze) term — kept low so the sun glow stays a glow, not a wall. */
  mieBoost: 0.75,
  /** Radiance of the visible sun disc (times transmittance). */
  sunDiscRadiance: 5, // white after AgX at any daytime exposure, but a bounded bloom source
  sunAngularRadius: 0.00465 * 1.15,
  moonAngularRadius: 0.0046 * 2.7,   // 2.7x life size: at 42 deg FOV a life-size disc is 9 px and reads as a dot
};

const _tmp = new THREE.Vector3();

function raySphere(ro, rd, R) {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - R * R;
  let h = b * b - c;
  if (h < 0) return [-1, -1];
  h = Math.sqrt(h);
  return [-b - h, -b + h];
}

function densities(h, out) {
  out[0] = Math.exp(-h / ATMOS.HR);
  out[1] = Math.exp(-h / ATMOS.HM);
  out[2] = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
  return out;
}

const _dens = [0, 0, 0];
const _od = [0, 0, 0];
const _p = new THREE.Vector3();

/** Optical depth [R, M, O] from point p toward the light and soft planet occlusion factor. */
function opticalDepthToLight(p, L, steps, out) {
  const [, tFar] = raySphere(p, L, ATMOS.atmosphereRadius);
  // closest approach to planet centre along the light ray
  const b = -p.dot(L);
  let occl = 1;
  if (b > 0) {
    _tmp.copy(p).addScaledVector(L, b);
    const hmin = _tmp.length() - ATMOS.planetRadius;
    occl = smoothstep(-6000, 800, hmin);
  }
  out[0] = out[1] = out[2] = 0;
  if (occl <= 0) return 0;
  const ds = tFar / steps;
  for (let i = 0; i < steps; i++) {
    _tmp.copy(p).addScaledVector(L, (i + 0.5) * ds);
    const h = Math.max(0, _tmp.length() - ATMOS.planetRadius);
    densities(h, _dens);
    out[0] += _dens[0] * ds;
    out[1] += _dens[1] * ds;
    out[2] += _dens[2] * ds;
  }
  return occl;
}

function hg(mu, g) {
  const g2 = g * g;
  return ((1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * mu, 1.5)));
}

/**
 * Sky radiance for view direction `rd` from altitude `alt` (m). Adds sun and moon as light sources.
 * `params`: { sunDir (toward sun), moonDir, sunE, moonE, turbidity }
 * Returns { radiance: Color, transmittance: Color, hitsGround: bool }
 */
export function skyRadiance(rd, alt, params, N = 12, LSTEPS = 5, out = { radiance: new THREE.Color(), transmittance: new THREE.Color() }) {
  const ro = _p.set(0, ATMOS.planetRadius + Math.max(1, alt), 0);
  const [, tAtm] = raySphere(ro, rd, ATMOS.atmosphereRadius);
  let tmax = tAtm;
  const [tp0] = raySphere(ro, rd, ATMOS.planetRadius);
  const hitsGround = tp0 > 0;
  if (hitsGround) tmax = tp0;
  const bR = ATMOS.betaR, bO = ATMOS.betaO;
  const turb = params.turbidity ?? 2;
  const sBoost = params.scatterBoost ?? ATMOS.scatterBoost;
  const bM = ATMOS.betaM * turb, bME = (ATMOS.betaM + ATMOS.betaMA) * turb;
  const muS = rd.dot(params.sunDir);
  const phaseRS = (3 / (16 * Math.PI)) * (1 + muS * muS);
  const phaseMS = hg(muS, ATMOS.mieG);
  const hasMoon = params.moonE > 1e-5;
  const muM = hasMoon ? rd.dot(params.moonDir) : 0;
  const phaseRM = (3 / (16 * Math.PI)) * (1 + muM * muM);
  const phaseMM = hg(muM, ATMOS.mieG);
  const sumRS = [0, 0, 0], sumMS = [0, 0, 0], sumRM = [0, 0, 0], sumMM = [0, 0, 0], sumMSR = [0, 0, 0];
  const od = [0, 0, 0];
  const odL = _od;
  const pos = new THREE.Vector3();
  const dens = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const s0 = i / N, s1 = (i + 1) / N;
    const t0 = tmax * s0 * s0, t1 = tmax * s1 * s1;
    const ds = t1 - t0;
    const t = 0.5 * (t0 + t1);
    pos.copy(ro).addScaledVector(rd, t);
    const h = Math.max(0, pos.length() - ATMOS.planetRadius);
    densities(h, dens);
    od[0] += dens[0] * ds; od[1] += dens[1] * ds; od[2] += dens[2] * ds;
    // sun
    let occl = opticalDepthToLight(pos, params.sunDir, LSTEPS, odL);
    if (occl > 0) {
      for (let c = 0; c < 3; c++) {
        const tauCam = bR[c] * od[0] + bME * od[1] + bO[c] * od[2];
        const tauSun = bR[c] * odL[0] + bME * odL[1] + bO[c] * odL[2];
        const att = Math.exp(-(tauCam + tauSun)) * occl;
        sumRS[c] += att * dens[0] * ds;
        sumMS[c] += att * dens[1] * ds;
        sumMSR[c] += Math.exp(-tauCam - (bR[c] * odL[0] + bME * odL[1]) * ATMOS.msSunAtten) * occl * dens[0] * ds;
      }
    }
    if (hasMoon) {
      occl = opticalDepthToLight(pos, params.moonDir, LSTEPS, odL);
      if (occl > 0) {
        for (let c = 0; c < 3; c++) {
          const tau = bR[c] * (od[0] + odL[0]) + bME * (od[1] + odL[1]) + bO[c] * (od[2] + odL[2]);
          const att = Math.exp(-tau) * occl;
          sumRM[c] += att * dens[0] * ds;
          sumMM[c] += att * dens[1] * ds;
        }
      }
    }
  }
  const r = out.radiance, tr = out.transmittance;
  const rr = [0, 0, 0], tt = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    tt[c] = Math.exp(-(bR[c] * od[0] + bME * od[1] + bO[c] * od[2]));
    rr[c] = params.sunE * (sumRS[c] * bR[c] * phaseRS * sBoost + sumMS[c] * bM * phaseMS * ATMOS.mieBoost + sumMSR[c] * bR[c] * ATMOS.msSpectrum[c] * ATMOS.msK);
    if (hasMoon) rr[c] += params.moonE * (sumRM[c] * bR[c] * phaseRM * sBoost + sumMM[c] * bM * phaseMM * ATMOS.mieBoost);
  }
  r.setRGB(rr[0], rr[1], rr[2]);
  tr.setRGB(tt[0], tt[1], tt[2]);
  out.hitsGround = hitsGround;
  return out;
}

/** Transmittance from altitude `alt` toward direction L (toward the light). */
export function transmittanceToLight(L, alt, turbidity, out = new THREE.Color()) {
  const p = _p.set(0, ATMOS.planetRadius + Math.max(1, alt), 0);
  const occl = opticalDepthToLight(p, L, 24, _od);
  const bR = ATMOS.betaR, bO = ATMOS.betaO, bME = (ATMOS.betaM + ATMOS.betaMA) * turbidity;
  const r = occl * Math.exp(-(bR[0] * _od[0] + bME * _od[1] + bO[0] * _od[2]));
  const g = occl * Math.exp(-(bR[1] * _od[0] + bME * _od[1] + bO[1] * _od[2]));
  const b = occl * Math.exp(-(bR[2] * _od[0] + bME * _od[1] + bO[2] * _od[2]));
  return out.setRGB(r, g, b);
}

// ---------------------------------------------------------------------------------------------
// Ephemeris
// ---------------------------------------------------------------------------------------------

/** Day of year (1..365) from the game clock. */
export function dayOfYear(time) {
  const m = clamp((time.month || 6) - 1, 0, 11);
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cum[m] + clamp(time.day || 1, 1, 31);
}

/** Solar declination (rad) for a day of year. */
export function solarDeclination(doy) {
  return 23.44 * DEG2RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
}

/**
 * Direction *toward* a body from local horizontal coordinates.
 * altitude/azimuth in rad, azimuth measured from north (−Z) clockwise (east = +X).
 */
export function horizontalToDirection(altitude, azimuth, out = new THREE.Vector3()) {
  const ca = Math.cos(altitude);
  return out.set(ca * Math.sin(azimuth), Math.sin(altitude), -ca * Math.cos(azimuth));
}

/** Altitude & azimuth of a body with declination `dec` at hour angle `H` (rad) for latitude `lat` (rad). */
export function altAz(dec, H, lat) {
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const cosAlt = Math.max(1e-6, Math.cos(alt));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (cosAlt * Math.cos(lat));
  let az = Math.acos(clamp(cosAz, -1, 1));
  if (Math.sin(H) > 0) az = 2 * Math.PI - az; // afternoon → west
  return { alt, az };
}

/**
 * Sun and moon geometry for a given clock. Returns directions *toward* the bodies.
 * Moon: mean-motion approximation along the ecliptic, phase from the synodic month.
 */
export function celestial(hour, doy, latDeg, out = {}) {
  const lat = latDeg * DEG2RAD;
  const decS = solarDeclination(doy);
  const H = (hour - 12) * 15 * DEG2RAD;
  const sun = altAz(decS, H, lat);
  out.sunAltitude = sun.alt;
  out.sunAzimuth = sun.az;
  out.sunDir = horizontalToDirection(sun.alt, sun.az, out.sunDir || new THREE.Vector3());

  // moon: elongation from the sun grows 12.19°/day (synodic month 29.53 d)
  const ageDays = ((doy + hour / 24) * 1.0 + 12.6) % 29.53;
  const elong = (ageDays / 29.53) * 2 * Math.PI; // 0 new, π full
  out.moonPhase = ageDays / 29.53;
  out.moonIllumination = 0.5 * (1 - Math.cos(elong));
  const decM = 23.44 * DEG2RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365 + elong) * 1.1;
  const moon = altAz(decM, H - elong, lat);
  out.moonAltitude = moon.alt;
  out.moonAzimuth = moon.az;
  out.moonDir = horizontalToDirection(moon.alt, moon.az, out.moonDir || new THREE.Vector3());

  // local sidereal rotation angle of the star sphere (rad)
  out.siderealAngle = ((hour / 24) * 2 * Math.PI + (doy / 365.25) * 2 * Math.PI + 1.7) % (2 * Math.PI);
  return out;
}

/** Tone-mapping exposure as a function of sun altitude (deg) — eye adaptation. */
export function exposureForSun(sunAltDeg) {
  // eye adaptation: +0.5 EV through golden hour (sun 0-6 deg), then a steep rise through civil twilight so the
  // ground luminance stays monotonic as the sky collapses (the r0 dip at 19:19), flat moonlit level from -10 deg
  const keys = [[-90, 3.15], [-14, 3.15], [-10, 3.1], [-8, 3.0], [-6, 2.82], [-5, 2.66], [-4, 2.48], [-3, 2.25], [-2, 2.02], [-1, 1.85],
    [0, 2.14], [2, 2.09], [4, 2.03], [6, 1.93], [10, 1.75], [18, 1.52], [30, 1.37], [90, 1.37]];
  for (let i = 1; i < keys.length; i++) {
    if (sunAltDeg <= keys[i][0]) {
      const t = smoothstep(keys[i - 1][0], keys[i][0], sunAltDeg);
      return lerp(keys[i - 1][1], keys[i][1], t);
    }
  }
  return keys[keys.length - 1][1];
}

/** 0 by day, 1 at night — used by every module to switch lights on. City lights come on through sunset (+3 → -1 deg)
 *  and stay fully on until the sun is up again; the same ramp drives the night colour grade, so the frames around
 *  sunset / sunrise never read darker than the graded night. */
export function nightFactorForSun(sunAltDeg) {
  return clamp01(1 - smoothstep(-1, 3, sunAltDeg));
}

export const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
