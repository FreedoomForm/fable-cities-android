/**
 * Continuous ambience layers. Each layer owns a sub-graph feeding `this.out` (layer-controlled
 * GainNode) → `this.post` (MIXER-controlled: mute/solo, never touched by the layer) → destination.
 * Meters tap `post`, so solo/mute verification measures exactly what reaches the bus.
 *
 * `state` (computeMixState, once per tick):
 *   hour, night, rain (falling rain 0..1), wet (surface wetness), snowfall, snowCover, snow (muffle),
 *   fog, weather, storm, wind, gust, temp, altitude, altN, forest, water,
 *   population, vehicles, urban, traffic, trafficHour
 */
import { loopSource } from './buffers.js';
import { clamp01, lerp, smoothstep } from '../../shared/math.js';
import { setT, setV, expRamp, linRamp, setCurve, setVal, cancelAt } from './params.js';


/** Run `fn` once the context clock has passed `endTime` (wall-clock timers are unreliable for offline contexts). */
export function cleanupAfter(ctx, endTime, fn) {
  const check = () => {
    if (ctx.state === 'closed') { try { fn(); } catch (_) { /* ignore */ } return; }
    if (ctx.currentTime >= endTime) { try { fn(); } catch (_) { /* ignore */ } }
    else setTimeout(check, Math.max(60, (endTime - ctx.currentTime) * 1000 + 40));
  };
  setTimeout(check, Math.max(60, (endTime - ctx.currentTime) * 1000 + 40));
}

export class Layer {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.post = ctx.createGain();
    this.out.connect(this.post);
    this.post.connect(dest);
    this.muted = false;
    this.targets = {};
    this.level = 0;
  }
  /** Mixer-side mute (solo tests). Layers never write `post`, so this always holds. */
  setMuted(m) { this.muted = !!m; setVal(this.post.gain, this.muted ? 0 : 1); }
}

// ------------------------------------------------------------------------------------------ WIND
export class WindLayer extends Layer {
  constructor(ctx, buffers, rng, dest) {
    super(ctx, dest);
    this.rng = rng;
    setVal(this.out.gain, 1);
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; setVal(b.frequency, f); setVal(b.Q, q); return b; };
    const g0 = () => { const g = ctx.createGain(); setVal(g.gain, 0); return g; };

    // Body: baked wind texture (wandering resonance + gust swells), lowpassed by altitude.
    this.bodySrc = loopSource(ctx, buffers.windTexture, rng, 1.0);
    this.bodyLP = mk('lowpass', 420, 0.8);
    this.bodyGain = g0();
    this.bodySrc.connect(this.bodyLP); this.bodyLP.connect(this.bodyGain); this.bodyGain.connect(this.out);
    // second decorrelated copy at a slightly different rate → wider, less loop-like
    this.bodySrc2 = loopSource(ctx, buffers.windTexture, rng, 0.91);
    this.bodySrc2.connect(this.bodyLP);

    // Low-mid weight: at altitude the wind gets a chesty 120–250 Hz body (air moving past the listener).
    this.lowSrc = loopSource(ctx, buffers.brown, rng, 1.0);
    this.lowBP = mk('bandpass', 170, 0.9);
    this.lowGain = g0();
    this.lowSrc.connect(this.lowBP); this.lowBP.connect(this.lowGain); this.lowGain.connect(this.out);

    // Gust band: brown noise through a moving bandpass — the swelling "whoosh".
    this.gustSrc = loopSource(ctx, buffers.brown, rng, 1.0);
    this.gustBP = mk('bandpass', 420, 0.8);
    this.gustGain = g0();
    this.gustSrc.connect(this.gustBP); this.gustBP.connect(this.gustGain); this.gustGain.connect(this.out);

    // Whistle: two broad-ish bands (Q ≈ 7) whose centres wander independently (edges, wires, antennas).
    this.whistle = [];
    for (let i = 0; i < 2; i++) {
      const src = loopSource(ctx, buffers.pink, rng, 1.04 + 0.07 * i);
      const bp = mk('bandpass', 1400 + 600 * i, 7);
      const gain = g0();
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; setVal(lfo.frequency, 0.11 + 0.08 * i + rng() * 0.05);
      const lfoG = ctx.createGain(); setVal(lfoG.gain, 160 + 90 * i);
      lfo.connect(lfoG); lfoG.connect(bp.frequency); lfo.start();
      src.connect(bp); bp.connect(gain); gain.connect(this.out);
      this.whistle.push({ src, bp, gain, lfo, base: 1300 + 700 * i, target: 1300 + 700 * i, next: 0 });
    }

    // Leaves/foliage rustle: high hiss near the ground, stronger inside forests/parks.
    this.leafSrc = loopSource(ctx, buffers.white, rng, 1.0);
    this.leafBP = mk('bandpass', 3200, 0.7);
    this.leafGain = g0();
    this.leafSrc.connect(this.leafBP); this.leafBP.connect(this.leafGain); this.leafGain.connect(this.out);
  }

  update(t, s) {
    const wind = clamp01(s.wind), gust = clamp01(s.gust), altN = s.altN;
    const snowCalm = 1 - 0.3 * s.snowCover;
    const amount = (0.06 + 0.9 * wind) * snowCalm;
    const heightMix = 0.28 + 0.72 * Math.pow(altN, 0.7);
    const body = amount * heightMix * (0.6 + 0.7 * gust) * 0.5;
    const low = amount * Math.pow(altN, 0.8) * (0.5 + 0.5 * gust) * 0.34;
    const gustG = amount * (0.25 + 0.75 * heightMix) * Math.pow(gust, 1.4) * 0.5;
    const whistle = Math.min(0.06, wind * Math.pow(altN, 1.2) * Math.pow(gust, 2.2) * 0.12);
    const leaf = amount * (1 - altN) * (0.12 + 0.88 * s.forest) * (1 - 0.6 * s.urban) * (0.3 + 0.7 * gust) * 0.13 * (1 - s.snowCover);

    setT(this.bodyLP.frequency, 260 + 900 * altN + 500 * gust * wind, t, 0.6);
    setT(this.bodyGain.gain, body, t, 0.5);
    setT(this.lowGain.gain, low, t, 0.7);
    setT(this.gustBP.frequency, 300 + 520 * gust + 300 * altN, t, 0.35);
    setT(this.gustGain.gain, gustG, t, 0.3);
    for (let i = 0; i < this.whistle.length; i++) {
      const w = this.whistle[i];
      if (t >= w.next) { w.target = (1000 + 600 * i) + this.rng() * 1100 + 500 * wind; w.next = t + 0.7 + this.rng() * 1.4; }
      w.base += (w.target - w.base) * 0.18;
      setT(w.bp.frequency, w.base + 300 * gust, t, 0.12);
      setT(w.gain.gain, whistle * (i === 0 ? 0.6 : 0.4), t, 0.2);
    }
    setT(this.leafGain.gain, leaf, t, 0.4);
    this.targets = { body, low, gust: gustG, whistle, leaf };
    return (this.level = body + low + gustG + whistle + leaf);
  }
}

// ------------------------------------------------------------------------------------- CITY HUM
export class CityLayer extends Layer {
  constructor(ctx, buffers, rng, dest) {
    super(ctx, dest);
    setVal(this.out.gain, 1);
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; setVal(b.frequency, f); setVal(b.Q, q); return b; };
    const g0 = () => { const g = ctx.createGain(); setVal(g.gain, 0); return g; };

    // Deep rumble of a living city (HVAC, distant engines, subways) — scales with population.
    this.rumbleSrc = loopSource(ctx, buffers.brown, rng, 0.86);
    this.rumbleLP = mk('lowpass', 150, 0.7);
    this.rumbleGain = g0();
    this.rumbleSrc.connect(this.rumbleLP); this.rumbleLP.connect(this.rumbleGain); this.rumbleGain.connect(this.out);

    // Traffic wash: the baked "sea of pass-bys" texture, brightness depends on altitude.
    this.washSrc = loopSource(ctx, buffers.cityWash, rng, 1.0);
    this.washSrc2 = loopSource(ctx, buffers.cityWash, rng, 0.87);
    this.washLP = mk('lowpass', 1500, 0.6);
    this.washGain = g0();
    this.washSrc.connect(this.washLP); this.washSrc2.connect(this.washLP); this.washLP.connect(this.washGain); this.washGain.connect(this.out);
    this.washLFO = ctx.createOscillator(); this.washLFO.type = 'sine'; setVal(this.washLFO.frequency, 0.09);
    this.washLFOGain = g0();
    this.washLFO.connect(this.washLFOGain); this.washLFOGain.connect(this.washGain.gain); this.washLFO.start();

    // Tyre hiss detail — street level only (positional traffic voices carry the individual cars).
    this.detailSrc = loopSource(ctx, buffers.pink, rng, 1.12);
    this.detailHP = mk('highpass', 1800, 0.6);
    this.detailGain = g0();
    this.detailSrc.connect(this.detailHP); this.detailHP.connect(this.detailGain); this.detailGain.connect(this.out);

    // Downtown crowd murmur — the baked babble texture, street level by day/evening.
    this.crowdSrc = loopSource(ctx, buffers.babble, rng, 1.0);
    this.crowdBP = mk('bandpass', 620, 0.8);
    this.crowdGain = g0();
    this.crowdSrc.connect(this.crowdBP); this.crowdBP.connect(this.crowdGain); this.crowdGain.connect(this.out);
  }

  update(t, s) {
    const altN = s.altN;
    const altFade = 1 - 0.86 * altN;                // at max zoom the city sits 10–12 dB under the wind
    const nightDuck = 1 - 0.45 * s.night;
    const rumble = (0.02 + 0.5 * s.urban) * altFade * nightDuck * 0.5;
    const traffic = s.traffic * s.trafficHour;
    const wash = traffic * altFade * 0.55;
    const detail = traffic * Math.pow(1 - altN, 2.2) * 0.07 * (1 + 0.6 * s.wet);
    const evening = smoothstep(9, 12, s.hour) * (1 - smoothstep(21.5, 23.5, s.hour));
    const crowd = s.urban * s.urban * Math.pow(1 - altN, 2.5) * evening * (1 - 0.7 * s.rain) * 0.09;

    setT(this.rumbleGain.gain, rumble, t, 0.8);
    setT(this.rumbleLP.frequency, 95 + 105 * (1 - altN), t, 0.8);
    setT(this.washLP.frequency, lerp(2600, 250, Math.pow(altN, 0.8)), t, 0.7);
    setT(this.washGain.gain, wash, t, 0.7);
    setT(this.washLFOGain.gain, wash * 0.3, t, 0.7);
    setT(this.detailGain.gain, detail, t, 0.5);
    setT(this.crowdGain.gain, crowd, t, 0.8);
    this.targets = { rumble, wash, detail, crowd };
    return (this.level = rumble + wash + detail + crowd);
  }
}

// ----------------------------------------------------------------------------------------- RAIN
export class RainLayer extends Layer {
  constructor(ctx, buffers, rng, dest) {
    super(ctx, dest);
    setVal(this.out.gain, 1);
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; setVal(b.frequency, f); setVal(b.Q, q); return b; };
    const g0 = () => { const g = ctx.createGain(); setVal(g.gain, 0); return g; };

    this.hissSrc = loopSource(ctx, buffers.white, rng, 1.0);
    this.hissHP = mk('highpass', 700, 0.5);
    this.hissLP = mk('lowpass', 6000, 0.4);
    this.hissGain = g0();
    this.hissSrc.connect(this.hissHP); this.hissHP.connect(this.hissLP); this.hissLP.connect(this.hissGain); this.hissGain.connect(this.out);

    this.dropSrc = loopSource(ctx, buffers.rainDrops, rng, 1.0);
    this.dropSrc2 = loopSource(ctx, buffers.rainDrops, rng, 0.83);
    this.dropGain = g0();
    this.dropSrc.connect(this.dropGain); this.dropSrc2.connect(this.dropGain); this.dropGain.connect(this.out);

    // Gutter / roof runoff: low bubbling band — needs wet surfaces, keeps running a little after the rain stops.
    this.runoffSrc = loopSource(ctx, buffers.brown, rng, 1.3);
    this.runoffBP = mk('bandpass', 900, 2.5);
    this.runoffGain = g0();
    this.runoffSrc.connect(this.runoffBP); this.runoffBP.connect(this.runoffGain); this.runoffGain.connect(this.out);
  }

  update(t, s) {
    const rain = clamp01(s.rain);                    // FALLING rain (env.precipitation), not wetness
    const altN = s.altN;
    const hiss = Math.pow(rain, 0.85) * (0.6 + 0.4 * (1 - altN)) * (1 + 0.25 * s.gust) * 0.32;
    const drops = rain * Math.pow(1 - altN, 1.6) * 0.38;
    const runoff = smoothstep(0.4, 1, s.wet) * (0.3 + 0.7 * smoothstep(0.05, 0.6, rain)) * Math.pow(1 - altN, 2) * 0.12;
    setT(this.hissGain.gain, hiss, t, 0.5);
    setT(this.hissLP.frequency, 3500 + 4500 * rain, t, 0.8);
    setT(this.dropGain.gain, drops, t, 0.5);
    setT(this.runoffGain.gain, runoff, t, 1.2);
    this.targets = { hiss, drops, runoff };
    return (this.level = hiss + drops + runoff);
  }
}

// ---------------------------------------------------------------------------------------- WATER
/** Shore / open water near the camera: slow lapping waves (LFO-modulated pink noise) + fine spray hiss. */
export class WaterLayer extends Layer {
  constructor(ctx, buffers, rng, dest) {
    super(ctx, dest);
    setVal(this.out.gain, 1);
    this.src = loopSource(ctx, buffers.pink, rng, 0.9);
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; setVal(this.bp.frequency, 420); setVal(this.bp.Q, 0.7);
    this.gain = ctx.createGain(); setVal(this.gain.gain, 0);
    this.src.connect(this.bp); this.bp.connect(this.gain); this.gain.connect(this.out);
    this.lfo = ctx.createOscillator(); this.lfo.type = 'sine'; setVal(this.lfo.frequency, 0.16);
    this.lfoG = ctx.createGain(); setVal(this.lfoG.gain, 0);
    this.lfo.connect(this.lfoG); this.lfoG.connect(this.gain.gain);
    this.lfoF = ctx.createGain(); setVal(this.lfoF.gain, 220);
    this.lfo.connect(this.lfoF); this.lfoF.connect(this.bp.frequency);
    this.lfo.start();
    this.sprSrc = loopSource(ctx, buffers.white, rng, 1);
    this.sprHP = ctx.createBiquadFilter(); this.sprHP.type = 'highpass'; setVal(this.sprHP.frequency, 2500); setVal(this.sprHP.Q, 0.5);
    this.sprGain = ctx.createGain(); setVal(this.sprGain.gain, 0);
    this.sprSrc.connect(this.sprHP); this.sprHP.connect(this.sprGain); this.sprGain.connect(this.out);
  }
  update(t, s) {
    const w = clamp01(s.water);
    const near = Math.pow(1 - s.altN, 1.5);
    const level = w * near * (0.5 + 0.5 * s.wind) * 0.42;
    const spray = w * near * s.wind * s.gust * 0.05;
    setT(this.gain.gain, level, t, 0.9);
    setT(this.lfoG.gain, level * 0.55, t, 0.9);
    setT(this.sprGain.gain, spray, t, 0.6);
    this.targets = { level, spray };
    return (this.level = level + spray);
  }
}

// ---------------------------------------------------------------------------------------- BIRDS
/**
 * Bird calls synthesised per syllable: a sine carrier following an arbitrary frequency contour
 * (setValueCurveAtTime) with trill FM, amplitude micro-modulation, a quiet second partial and a
 * "breath" noise component through a resonant bandpass that TRACKS the contour — then distance
 * lowpass, stereo pan and a send into a short outdoor early-reflection reverb. Crows/gulls use a
 * pulse-train through two formant filters plus noise instead. Eight species with their own grammar.
 */
export class BirdLayer extends Layer {
  constructor(ctx, buffers, rng, dest) {
    super(ctx, dest);
    this.rng = rng;
    this.buffers = buffers;
    setVal(this.out.gain, 0.5);
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; setVal(this.hp.frequency, 500); setVal(this.hp.Q, 0.5);
    this.dry = ctx.createGain(); setVal(this.dry.gain, 1);
    this.dry.connect(this.hp); this.hp.connect(this.out);
    // outdoor space: early reflections off facades / trees
    this.rev = ctx.createConvolver(); this.rev.buffer = buffers.outdoorIR; this.rev.normalize = true;
    this.revSend = ctx.createGain(); setVal(this.revSend.gain, 1);
    this.revReturn = ctx.createGain(); setVal(this.revReturn.gain, 0.55);
    this.revSend.connect(this.rev); this.rev.connect(this.revReturn); this.revReturn.connect(this.hp);
    this.nextTime = 0;
    this.activity = 0;
    this.lastCall = null;
    this.calls = 0;
    this.voices = [];      // in-flight calls, so a time jump can silence them (see flush)
  }

  update(t, s) {
    const dawn = 1 + 1.6 * Math.exp(-Math.pow((s.hour - 6.2) / 1.3, 2));
    const dusk = 1 + 0.5 * Math.exp(-Math.pow((s.hour - 19.5) / 1.0, 2));
    const day = Math.pow(1 - s.night, 1.6);
    const temp = smoothstep(2, 12, s.temp);
    const weather = (1 - 0.92 * s.rain) * (1 - s.snowfall) * (1 - 0.6 * s.snowCover) * (1 - 0.4 * s.fog);
    const habitat = 0.55 + 0.45 * s.forest + 0.25 * s.water;
    // Birds are a GROUND layer: they fall away with real height (a camera 150 m up hears wind and the
    // city, not sparrows) and thin out over dense city. altN saturates at 900 m, far too slow for this.
    const altFade = 1 / (1 + Math.pow(Math.max(0, s.altitude) / 95, 1.7));
    const a = day * dawn * dusk * temp * weather * altFade * (1 - 0.45 * s.urban) * (1 - 0.35 * s.wind) * habitat;
    this.activity = clamp01(a);
    // explicit group amplitude (not just call rate) so the layer sits under the city hum from the air
    setT(this.out.gain, 0.55 * Math.pow(altFade, 0.9) * (1 - 0.55 * clamp01(s.urban)), t, 0.7);
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < t) this.voices.splice(i, 1);
    const rate = this.activity * 2.2; // calls per second
    if (rate < 0.02) { this.nextTime = Math.max(this.nextTime, t + 0.5); return (this.level = 0); }
    if (this.nextTime < t) this.nextTime = t + 0.05;
    let guard = 0;
    while (this.nextTime < t + 0.7 && guard++ < 8) {
      this.scheduleCall(this.nextTime, s);
      this.nextTime += (-Math.log(1 - this.rng()) / rate) * 0.85 + 0.05;
    }
    return (this.level = this.activity * 0.22);
  }

  scheduleCall(t0, s) {
    const rng = this.rng, ctx = this.ctx;
    const r = rng();
    const urbanW = s.urban;
    let species;
    if (s.water > 0.15 && r < 0.3 * s.water) species = 'gull';
    else if (r < 0.10 + 0.16 * urbanW) species = 'pigeon';
    else if (r < 0.18 + 0.2 * urbanW) species = 'crow';
    else if (r < 0.36) species = 'sparrow';
    else if (r < 0.52) species = 'blackbird';
    else if (r < 0.66) species = 'tit';
    else if (r < 0.78) species = 'robin';
    else if (r < 0.9) species = 'chaffinch';
    else species = 'wren';

    const dist = Math.pow(rng(), 0.8);                          // 0 near … 1 far
    const level = lerp(0.85, 0.14, dist) * (0.55 + 0.45 * this.activity);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; setVal(lp.frequency, lerp(9500, 2600, dist)); setVal(lp.Q, 0.5);
    const g = ctx.createGain(); setVal(g.gain, level);
    const send = ctx.createGain(); setVal(send.gain, lerp(0.25, 0.8, dist));
    lp.connect(g);
    let tail = g;
    if (pan) { setVal(pan.pan, rng() * 1.8 - 0.9); g.connect(pan); tail = pan; }
    tail.connect(this.dry); tail.connect(send); send.connect(this.revSend);

    const end = this[`_${species}`](lp, t0);
    this.voices.push({ g, end });
    this.calls++;
    this.lastCall = { species, t: t0, pan: pan ? pan.pan.value : 0, dist };
    cleanupAfter(ctx, end + 0.8, () => { g.disconnect(); lp.disconnect(); send.disconnect(); if (pan) pan.disconnect(); });
  }

  /**
   * Silence every in-flight call within ~120 ms and stop scheduling ahead. Called when the clock
   * jumps (time:set): without this, calls scheduled up to 0.7 s ahead keep singing after nightfall.
   */
  flush(t) {
    for (const v of this.voices) { cancelAt(v.g.gain, t); linRamp(v.g.gain, 0, t + 0.12); }
    this.voices.length = 0;
    this.nextTime = t + 0.25;
  }

  // ---------------------------------------------------------------- syllable primitives
  /**
   * One whistled syllable. `contour` = array of frequencies (Hz) spread evenly over `dur`.
   * opts: trillHz, trillDepth (fraction of f), tremHz, tremDepth (0..1), noise (0..1), harm2 (0..1), attack, release
   */
  whistle(dest, t0, dur, contour, amp, o = {}) {
    const ctx = this.ctx;
    const attack = o.attack ?? 0.008, release = o.release ?? 0.03;
    const curve = Float32Array.from(contour);
    const osc = ctx.createOscillator(); osc.type = 'sine';
    setCurve(osc.frequency, curve, t0, dur);
    const env = ctx.createGain();
    setV(env.gain, 0.0001, t0);
    expRamp(env.gain, amp, t0 + attack);
    setV(env.gain, amp, t0 + Math.max(attack, dur - release));
    expRamp(env.gain, 0.0001, t0 + dur + 0.01);
    osc.connect(env); env.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    const nodes = [osc, env];
    if (o.harm2) {
      const o2 = ctx.createOscillator(); o2.type = 'sine';
      setCurve(o2.frequency, curve.map((f) => f * 2), t0, dur);
      const g2 = ctx.createGain(); setVal(g2.gain, o.harm2);
      o2.connect(g2); g2.connect(env); o2.start(t0); o2.stop(t0 + dur + 0.02);
      nodes.push(o2, g2);
    }
    if (o.trillHz) {
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; setVal(lfo.frequency, o.trillHz);
      const lg = ctx.createGain(); setVal(lg.gain, curve[0] * (o.trillDepth ?? 0.04));
      lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t0); lfo.stop(t0 + dur + 0.02);
      nodes.push(lfo, lg);
    }
    if (o.tremHz) {
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; setVal(lfo.frequency, o.tremHz);
      const lg = ctx.createGain(); setVal(lg.gain, amp * (o.tremDepth ?? 0.3));
      lfo.connect(lg); lg.connect(env.gain); lfo.start(t0); lfo.stop(t0 + dur + 0.02);
      nodes.push(lfo, lg);
    }
    if (o.noise) {
      // breath: white noise through a resonant bandpass tracking the contour
      const src = loopSource(ctx, this.buffers.white, this.rng, 1);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; setVal(bp.Q, 9);
      setCurve(bp.frequency, curve, t0, dur);
      const ng = ctx.createGain(); setVal(ng.gain, o.noise * 0.9);
      src.connect(bp); bp.connect(ng); ng.connect(env);
      src.stop(t0 + dur + 0.02);
      nodes.push(src, bp, ng);
    }
    cleanupAfter(ctx, t0 + dur + 0.3, () => { for (const n of nodes) n.disconnect(); });
    return t0 + dur;
  }

  /** Harsh syllable: sawtooth pulse train through two formant bandpasses + noise (crow, gull). */
  rasp(dest, t0, dur, p0, p1, formants, amp, noise = 0.3) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    setV(osc.frequency, p0, t0);
    linRamp(osc.frequency, p1, t0 + dur);
    const env = ctx.createGain();
    setV(env.gain, 0.0001, t0);
    expRamp(env.gain, amp, t0 + 0.025);
    setV(env.gain, amp, t0 + dur * 0.55);
    expRamp(env.gain, 0.0001, t0 + dur);
    const nodes = [osc, env];
    for (const [f0, f1, q, g] of formants) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; setVal(bp.Q, q);
      setV(bp.frequency, f0, t0); linRamp(bp.frequency, f1, t0 + dur);
      const bg = ctx.createGain(); setVal(bg.gain, g);
      osc.connect(bp); bp.connect(bg); bg.connect(env);
      nodes.push(bp, bg);
    }
    if (noise > 0) {
      const src = loopSource(ctx, this.buffers.white, this.rng, 1);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; setVal(bp.Q, 2.5);
      setV(bp.frequency, formants[0][0], t0); linRamp(bp.frequency, formants[0][1], t0 + dur);
      const ng = ctx.createGain(); setVal(ng.gain, noise);
      src.connect(bp); bp.connect(ng); ng.connect(env); src.stop(t0 + dur + 0.02);
      nodes.push(src, bp, ng);
    }
    env.connect(dest);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    cleanupAfter(ctx, t0 + dur + 0.3, () => { for (const n of nodes) n.disconnect(); });
    return t0 + dur;
  }

  // contours
  _chevron(f, up = 1.25, n = 9) { const c = []; for (let i = 0; i < n; i++) { const u = i / (n - 1); c.push(f * Math.pow(up, Math.sin(Math.PI * u))); } return c; }
  _sweep(f0, f1, n = 9) { const c = []; for (let i = 0; i < n; i++) c.push(f0 * Math.pow(f1 / f0, i / (n - 1))); return c; }
  _dip(f, down = 0.8, n = 9) { return this._chevron(f, down, n); }

  // ---------------------------------------------------------------- species
  _blackbird(dest, t0) {
    const rng = this.rng;
    const n = 3 + Math.floor(rng() * 4);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const f = 1500 + rng() * 1500;
      const kind = rng();
      const dur = 0.11 + rng() * 0.16;
      const contour = kind < 0.35 ? this._chevron(f, 1.2 + rng() * 0.3) : kind < 0.6 ? this._sweep(f, f * (1.2 + rng() * 0.4)) : kind < 0.85 ? this._sweep(f * 1.3, f) : this._dip(f, 0.8);
      const last = i === n - 1;
      this.whistle(dest, tt, dur, last ? this._sweep(f, f * 1.8, 11) : contour, 0.7, { harm2: 0.16, noise: 0.1 + 0.2 * (last ? 1 : 0), trillHz: rng() < 0.4 ? 28 + rng() * 14 : 0, trillDepth: 0.03, attack: 0.015, release: 0.05 });
      tt += dur + 0.05 + rng() * 0.12;
    }
    return tt;
  }
  _robin(dest, t0) {
    const rng = this.rng;
    const n = 4 + Math.floor(rng() * 5);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const f = 2600 + rng() * 2400;
      const dur = 0.05 + rng() * 0.12;
      const trill = rng() < 0.5;
      this.whistle(dest, tt, dur, trill ? this._chevron(f, 1.08, 7) : this._sweep(f, f * (0.7 + rng() * 0.7)), 0.55, { trillHz: trill ? 38 + rng() * 22 : 0, trillDepth: 0.06, harm2: 0.08, noise: 0.14, tremHz: 0, attack: 0.006 });
      tt += dur + 0.02 + rng() * 0.07;
    }
    return tt;
  }
  _tit(dest, t0) {
    const rng = this.rng;
    const n = 3 + Math.floor(rng() * 4);
    const fa = 3300 + rng() * 700, fb = fa * (0.74 + rng() * 0.08);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      this.whistle(dest, tt, 0.085, this._sweep(fa, fa * 1.06), 0.6, { harm2: 0.1, noise: 0.12, attack: 0.005 });
      this.whistle(dest, tt + 0.115, 0.1, this._sweep(fb, fb * 0.95), 0.55, { harm2: 0.1, noise: 0.12, attack: 0.006 });
      tt += 0.27;
    }
    return tt;
  }
  _chaffinch(dest, t0) {
    const rng = this.rng;
    // accelerating descending trill then a flourish
    const n = 7 + Math.floor(rng() * 5);
    let tt = t0;
    let f = 4300 + rng() * 500;
    for (let i = 0; i < n; i++) {
      const dur = 0.06 - i * 0.002;
      this.whistle(dest, tt, dur, this._sweep(f, f * 0.9, 5), 0.5, { noise: 0.15, harm2: 0.06, attack: 0.004 });
      tt += dur + 0.045 - i * 0.002;
      f *= 0.96;
    }
    const ff = 2300 + rng() * 400;
    this.whistle(dest, tt + 0.03, 0.2, [...this._sweep(ff, ff * 1.45, 5), ...this._sweep(ff * 1.45, ff * 0.8, 6)], 0.7, { noise: 0.2, harm2: 0.15, attack: 0.01, release: 0.06 });
    return tt + 0.26;
  }
  _sparrow(dest, t0) {
    const rng = this.rng;
    const n = 2 + Math.floor(rng() * 4);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const f = 3400 + rng() * 1600;
      const dur = 0.04 + rng() * 0.03;
      this.whistle(dest, tt, dur, this._chevron(f, 1.3 + rng() * 0.3, 7), 0.55 + rng() * 0.25, { noise: 0.3, harm2: 0.2, attack: 0.004, release: 0.015 });
      tt += dur + 0.06 + rng() * 0.16;
    }
    return tt;
  }
  _wren(dest, t0) {
    const rng = this.rng;
    // machine-gun trill ~ 0.7 s then 2–3 clear notes
    const f = 4000 + rng() * 900;
    const dur = 0.55 + rng() * 0.4;
    this.whistle(dest, t0, dur, this._chevron(f, 1.05, 9), 0.5, { trillHz: 17 + rng() * 6, trillDepth: 0.12, tremHz: 17 + rng() * 6, tremDepth: 0.7, noise: 0.15, attack: 0.02, release: 0.05 });
    let tt = t0 + dur + 0.04;
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const fn = 3000 + rng() * 1500;
      this.whistle(dest, tt, 0.09, this._sweep(fn, fn * 0.8), 0.55, { noise: 0.15, harm2: 0.1 });
      tt += 0.13;
    }
    return tt;
  }
  _pigeon(dest, t0) {
    const rng = this.rng;
    const n = 2 + Math.floor(rng() * 2);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const f = 320 + rng() * 70;
      const dur = 0.3 + rng() * 0.12;
      this.whistle(dest, tt, dur, [...this._sweep(f * 0.92, f, 4), ...this._sweep(f, f * 0.86, 6)], 0.85, { tremHz: 11 + rng() * 3, tremDepth: 0.55, harm2: 0.45, noise: 0.08, attack: 0.05, release: 0.12 });
      tt += dur + 0.1;
    }
    return tt;
  }
  _crow(dest, t0) {
    const rng = this.rng;
    const n = 1 + Math.floor(rng() * 3);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const dur = 0.22 + rng() * 0.12;
      const f = 1050 + rng() * 300;
      this.rasp(dest, tt, dur, 185, 140, [[f, f * 0.72, 3, 1.0], [f * 1.9, f * 1.5, 4, 0.5]], 0.75, 0.35);
      tt += dur + 0.14 + rng() * 0.15;
    }
    return tt;
  }
  _gull(dest, t0) {
    const rng = this.rng;
    const n = 1 + Math.floor(rng() * 3);
    let tt = t0;
    for (let i = 0; i < n; i++) {
      const dur = 0.3 + rng() * 0.2;
      const f = 1400 + rng() * 400;
      this.rasp(dest, tt, dur, 520, 340, [[f, f * 0.65, 4, 1.0], [f * 2.1, f * 1.4, 5, 0.4]], 0.6, 0.25);
      tt += dur + 0.12 + rng() * 0.15;
    }
    return tt;
  }
}

// ------------------------------------------------------------------------------------- CRICKETS
/** Night insects: pulsed 4–5 kHz tones grouped into chirps, several individuals in stereo; slower katydid voice. */
export class CricketLayer extends Layer {
  constructor(ctx, buffers, rng, dest, voices = 5) {
    super(ctx, dest);
    this.rng = rng;
    setVal(this.out.gain, 0);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; setVal(this.lp.frequency, 7500); setVal(this.lp.Q, 0.4);
    this.out.disconnect(); this.out.connect(this.lp); this.lp.connect(this.post);
    this.voices = [];
    for (let i = 0; i < voices; i++) {
      const katydid = i === voices - 1;
      const f = katydid ? 2600 + rng() * 400 : 3900 + rng() * 900;
      const osc = ctx.createOscillator(); osc.type = 'sine'; setVal(osc.frequency, f);
      const osc2 = ctx.createOscillator(); osc2.type = 'sine'; setVal(osc2.frequency, f * 2.01);
      const overtone = ctx.createGain(); setVal(overtone.gain, katydid ? 0.3 : 0.18);
      const amp = ctx.createGain(); setVal(amp.gain, 0.5);
      const lfo = ctx.createOscillator(); lfo.type = 'square'; setVal(lfo.frequency, katydid ? 9 + rng() * 3 : 24 + rng() * 14);
      const lfoG = ctx.createGain(); setVal(lfoG.gain, 0.5);
      lfo.connect(lfoG); lfoG.connect(amp.gain);
      const gate = ctx.createGain(); setVal(gate.gain, 0);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      osc.connect(amp); osc2.connect(overtone); overtone.connect(amp);
      amp.connect(gate);
      if (pan) { setVal(pan.pan, -0.85 + (i / Math.max(1, voices - 1)) * 1.7 + (rng() - 0.5) * 0.2); gate.connect(pan); pan.connect(this.out); } else gate.connect(this.out);
      osc.start(); osc2.start(); lfo.start();
      this.voices.push({ gate, next: 0, level: (0.5 + rng() * 0.5) * (katydid ? 0.6 : 1), onDur: katydid ? 0.12 : 0.35 + rng() * 0.5, offDur: katydid ? 0.5 : 0.4 + rng() * 1.6 });
    }
    this.activity = 0;
  }

  update(t, s) {
    const temp = smoothstep(9, 17, s.temp);
    const a = Math.pow(s.night, 1.3) * (1 - 0.95 * s.rain) * (1 - s.snowCover) * temp * Math.pow(1 - s.altN, 1.8) * (1 - 0.6 * s.urban) * (1 - 0.3 * s.wind) * (0.6 + 0.4 * s.forest);
    this.activity = clamp01(a);
    setT(this.out.gain, this.activity * 0.17, t, 0.8);
    if (this.activity < 0.02) return (this.level = 0);
    for (const v of this.voices) {
      if (v.next < t) v.next = t + 0.05;
      let guard = 0;
      while (v.next < t + 0.6 && guard++ < 4) {
        const on = v.onDur * (0.7 + this.rng() * 0.6);
        const off = v.offDur * (0.5 + this.rng() * 1.0) / (0.4 + this.activity);
        const g = v.gate.gain;
        setV(g, 0.0001, v.next);
        expRamp(g, v.level, v.next + 0.03);
        setV(g, v.level, v.next + on - 0.03);
        expRamp(g, 0.0001, v.next + on);
        v.next += on + off;
      }
    }
    return (this.level = this.activity * 0.17);
  }

  /** Cut the scheduled chirp train (clock jump to daytime). */
  flush(t) {
    for (const v of this.voices) { cancelAt(v.gate.gain, t); linRamp(v.gate.gain, 0, t + 0.1); v.next = t + 0.3; }
  }
}
