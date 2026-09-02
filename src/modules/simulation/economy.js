/**
 * Economy, population and demand model.
 *
 *  - Occupancy is per building and counted in **whole households**: every game hour each finished
 *    home draws for arrivals at a rate proportional to its *empty* homes, scaled by residential
 *    demand, happiness and local utilities. A finished house takes its first household within a game
 *    hour or two and is full in half a game day, so "the house is finished" and "someone lives there"
 *    are never far apart. Households leave again when the city is unhappy or jobless.
 *  - Vacancy (which drives residential demand down) is measured only over homes that have already had
 *    SETTLE_HOURS to fill. Without that, a street of freshly finished houses reads as 100 % oversupply,
 *    demand collapses to 0, the move-in rate collapses with it and the city never populates.
 *  - Jobs come from commercial / industrial / office buildings plus service-building staff.
 *  - Happiness blends service coverage, tax pressure, unemployment, traffic and pollution — held
 *    at its seed value until the first residents arrive.
 *  - RCI demand reacts to the balance of jobs vs. workers, customers vs. shops and education.
 *  - Money flows continuously (per game minute); income / expenses are quoted **per game week**
 *    (`economy.period === 'week'`, ARCHITECTURE §4; the HUD labels flows from `economy.period`) and
 *    a budget report closes every Monday 00:00 from the same hourly loop that accumulates it.
 *
 * Everything here is O(buildings) once per game hour and O(1) per minute.
 */
import { clamp, clamp01, lerp, damp } from '../../shared/math.js';
import { SERVICE_IDS, UTILITY_IDS } from './services.js';
import { MONTHS } from './clock.js';

export const ZONE_CLASSES = ['residential', 'commercial', 'industrial', 'office'];

/** Map a building / zone type id to its economic class. */
export function zoneClass(type) {
  if (!type) return null;
  const t = String(type).toLowerCase();
  if (t.startsWith('res')) return 'residential';
  if (t.startsWith('com')) return 'commercial';
  if (t.startsWith('ind')) return 'industrial';
  if (t.startsWith('off')) return 'office';
  return null;
}

/** Estimate capacity when the building record does not carry it. */
function estimateCapacity(b, cls) {
  const floors = b.floors || Math.max(1, Math.round((b.height || 10) / 3.4));
  const area = (b.w || 16) * (b.d || 16) * floors;
  switch (cls) {
    case 'residential': return Math.max(2, Math.round(area / (String(b.type).includes('high') ? 34 : 48)));
    case 'commercial': return Math.max(2, Math.round(area / 55));
    case 'industrial': return Math.max(3, Math.round(area / 80));
    case 'office': return Math.max(4, Math.round(area / 22));
    default: return 0;
  }
}

// weekly taxable base per capita / per job, in ¤ (at a 10 % rate → ¤1.7 per resident per week)
const TAX_BASE = { residential: 19.1, commercial: 45.5, industrial: 38.1, office: 57.7 };
// road maintenance per metre per week
const ROAD_COST = { local: 0.30, avenue: 0.64, highway: 1.01, path: 0.07, default: 0.30 };
const ADMIN_COST = 550; // city hall & administration per week
const HOURS_PER_WEEK = 24 * 7;
const WORKING_SHARE = 0.62; // share of residents in the labour force
const HOUSEHOLD_SIZE = 2.4; // average people per household (capacity → homes)
const HOURS_PER_DAY = 24;

// --- occupancy model -----------------------------------------------------------------------------
const FILL_PER_HOUR = 0.22;        // share of a building's EMPTY homes that fill in one game hour at full demand
const MAX_MOVE_IN_PER_HOUR = 2;    // households per building per hour (a tower fills over days, not seconds)
const SETTLE_HOURS = 18;           // a just-finished home counts as pipeline, not oversupply, for its first day
const TARGET_OCCUPANCY = 0.94;     // natural vacancy: a healthy city is never 100 % full
const HOUSEHOLD_SIZES = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 5]; // drawn per move-in, mean 2.38 ≈ HOUSEHOLD_SIZE
// A founding village is self-employed (shops, farms, trades). Without this floor a residential-only
// start is 100 % unemployed, happiness falls to the clamp and the first residents move straight out.
function informalJobs(pop) { return Math.min(45, 10 + pop * 0.08); }

export class Economy {
  constructor(world, events, services, rng) {
    this.world = world;
    this.events = events;
    this.services = services;
    this.rng = rng;
    const e = world.economy;
    Object.assign(e, {
      employed: 0,
      unemployment: 0,
      jobFill: 0,
      net: 0,
      education: 0.1,
      pollution: 0,
      congestion: 0,
      landValue: 0.3,
      residentialCapacity: 0,
      jobsByClass: { commercial: 0, industrial: 0, office: 0, services: 0 },
      coverage: Object.fromEntries(SERVICE_IDS.map((id) => [id, 0])),
      budget: null,
      milestone: null,
      alerts: [],
    });
    if (!e.taxRate) e.taxRate = { residential: 0.1, commercial: 0.1, industrial: 0.1, office: 0.1 };
    this._occ = new Map(); // building id → { occ, cls, cap, cov: Float32Array(8), covVersion, seen }
    this._hourlyNet = 0;
    this._minuteInHour = 0;
    this._period = this._emptyPeriod();
    this._weekKey = null;
    this._weekStart = null;
    this._lastReport = null;
    this._prevReport = null;
    this._demandTarget = { ...e.demand };
    this._happinessTarget = e.happiness;
    this._buildingSource = null;
    this._lastBuildingsVersion = -1;
    this._lastServicesVersion = -1;
    this._sumCov = new Float64Array(SERVICE_IDS.length);
    this._sumCovCap = new Float64Array(SERVICE_IDS.length); // capacity-weighted fallback while pop === 0
    this.hourCount = 0;
    this._newCityBonus = 1;
    this.quiet = false; // set while fast-forwarding: no per-week notifications
    e.period = 'week'; // income / expenses / net are per game week (§4)
  }

  _emptyPeriod() {
    return { income: 0, expenses: 0, taxes: { residential: 0, commercial: 0, industrial: 0, office: 0 }, services: 0, roads: 0, admin: 0, hours: 0 };
  }
  hoursInPeriod() { return HOURS_PER_WEEK; }

  /** Override where buildings come from (showcase fallback). fn() → array of building records. */
  setBuildingSource(fn) { this._buildingSource = fn; }
  buildings() {
    if (this._buildingSource) { const l = this._buildingSource(); if (l && l.length) return l; }
    return this.world.buildings.list || [];
  }

  setTax(type, rate) {
    const cls = ZONE_CLASSES.includes(type) ? type : zoneClass(type);
    if (!cls) return false;
    const r = clamp(Number(rate) || 0, 0, 0.3);
    this.world.economy.taxRate[cls] = r;
    this.recomputeRates();
    this.events.emit('economy:changed', this.world.economy);
    return true;
  }

  /** Called once per game minute: continuous cash flow. */
  minute() {
    const e = this.world.economy;
    e.money += this._hourlyNet / 60;
    if (++this._minuteInHour >= 60) {
      this._minuteInHour = 0;
      this.hour();
      return true;
    }
    return false;
  }

  /** Heavy update once per game hour. */
  hour() {
    const world = this.world;
    const e = world.economy;
    const t = world.time;
    const svc = this.services;
    this.hourCount++;

    // ---------- 0. week bookkeeping (same loop that accumulates → a week always sums its own hours) ----------
    const wkey = Math.floor((t.totalDays || 0) / 7);
    if (this._weekKey == null) { this._weekKey = wkey; this._weekStart = { day: t.day, month: t.month, year: t.year }; }
    else if (wkey !== this._weekKey) { this.closeWeek(this._weekKey); this._weekKey = wkey; this._weekStart = { day: t.day, month: t.month, year: t.year }; }

    const buildings = this.buildings();
    const bVersion = world.buildings.version;
    const sVersion = svc.version;
    const servicesDirty = sVersion !== this._lastServicesVersion;

    // ---------- 1. sync buildings & occupancy ----------
    let resCap = 0, pop = 0, households = 0;
    let settledCap = 0, settledPop = 0; // only homes older than SETTLE_HOURS count towards vacancy
    const jobs = { commercial: 0, industrial: 0, office: 0, services: svc.totalWorkers() };
    const pollutionSources = [];
    const seenTag = this.hourCount;
    const sumCov = this._sumCov; sumCov.fill(0);
    const sumCovCap = this._sumCovCap; sumCovCap.fill(0);
    let covWeight = 0, capWeight = 0;
    let industrialNearHomes = 0;

    // move-in / move-out rates for this hour (per empty home / per resident household)
    const happy = e.happiness;
    const demandRes = e.demand.residential;
    const utilities = this._utilityFactor(e);
    const moveInRate = FILL_PER_HOUR * (0.25 + 0.75 * demandRes) * lerp(0.55, 1, happy) * utilities * this._newCityBonus;
    const moveOutRate = (happy < 0.35 ? (0.35 - happy) * 0.3 : 0) / HOURS_PER_DAY;
    const unemploymentOut = (e.unemployment > 0.18 ? (e.unemployment - 0.18) * 0.15 : 0) / HOURS_PER_DAY;
    const leaveRate = moveOutRate + unemploymentOut;

    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (!b || b.state === 'construction' || b.state === 'abandoned') continue;
      const cls = zoneClass(b.type);
      if (!cls) continue;
      let st = this._occ.get(b.id);
      if (!st) {
        st = { occ: 0, hh: 0, homes: 0, cls, cap: 0, cov: new Float32Array(SERVICE_IDS.length), covVersion: -1, seen: 0, since: seenTag, x: b.x, z: b.z };
        this._occ.set(b.id, st);
      }
      st.seen = seenTag;
      st.cls = cls;
      if (st.covVersion !== sVersion || st.x !== b.x || st.z !== b.z) {
        st.x = b.x; st.z = b.z; st.covVersion = sVersion;
        for (let k = 0; k < SERVICE_IDS.length; k++) st.cov[k] = svc.rawCoverageAt(b.x, b.z, SERVICE_IDS[k]);
      }
      if (cls === 'residential') {
        const cap = Number.isFinite(b.residents) && b.residents > 0 ? b.residents : estimateCapacity(b, cls);
        st.cap = cap;
        resCap += cap;
        // how many households the building holds, and how many of them a healthy market fills
        const homes = Math.max(1, Math.round(cap / HOUSEHOLD_SIZE));
        st.homes = homes;
        const wanted = homes <= 2 ? homes : Math.max(2, Math.round(homes * TARGET_OCCUPANCY));
        if (st.hh > homes) { st.occ *= homes / st.hh; st.hh = homes; } // capacity shrank (level change)
        // local desirability: utilities matter most, then safety/health, pollution hurts
        const lp = st.cov[0] * svc.strain.power, lw = st.cov[1] * svc.strain.water;
        const localUtil = 0.25 + 0.75 * Math.min(1, (lp + lw) * 0.5 + 0.15);
        const free = wanted - st.hh;
        if (free > 0) {
          // expected arrivals this hour, resolved into WHOLE households
          const expected = free * moveInRate * localUtil;
          let n = Math.floor(expected);
          if (this.rng() < expected - n) n++;
          if (n > MAX_MOVE_IN_PER_HOUR) n = MAX_MOVE_IN_PER_HOUR;
          if (n > free) n = free;
          for (let k = 0; k < n; k++) {
            // a household never spills past the building's stated capacity (§5: `residents`)
            const size = Math.min(HOUSEHOLD_SIZES[(this.rng() * HOUSEHOLD_SIZES.length) | 0], Math.max(1, cap - st.occ));
            st.hh++;
            st.occ += size;
          }
        }
        if (leaveRate > 0 && st.hh > 0) {
          const expected = st.hh * leaveRate;
          let n = Math.floor(expected);
          if (this.rng() < expected - n) n++;
          if (n > st.hh) n = st.hh;
          for (let k = 0; k < n; k++) {
            const avg = st.occ / st.hh;
            st.hh--;
            st.occ = st.hh > 0 ? Math.max(0, st.occ - avg) : 0;
          }
        }
        pop += st.occ;
        households += st.hh;
        if (seenTag - st.since >= SETTLE_HOURS) { settledCap += cap; settledPop += st.occ; }
        const w = st.occ;
        if (w > 0) {
          covWeight += w;
          for (let k = 0; k < SERVICE_IDS.length; k++) sumCov[k] += st.cov[k] * w;
        }
        if (cap > 0) {
          capWeight += cap;
          for (let k = 0; k < SERVICE_IDS.length; k++) sumCovCap[k] += st.cov[k] * cap;
        }
      } else {
        const cap = Number.isFinite(b.jobs) && b.jobs > 0 ? b.jobs : estimateCapacity(b, cls);
        st.cap = cap;
        jobs[cls] += cap;
        if (cls === 'industrial') pollutionSources.push(b);
      }
    }
    if (bVersion !== this._lastBuildingsVersion || this._buildingSource) {
      for (const [id, st] of this._occ) if (st.seen !== seenTag) this._occ.delete(id);
      this._lastBuildingsVersion = bVersion;
    }

    // ---------- 2. population, jobs, employment ----------
    const totalJobs = jobs.commercial + jobs.industrial + jobs.office + jobs.services;
    const workers = pop * WORKING_SHARE;
    // informal work keeps a founding village from reading as 100 % unemployed (see informalJobs)
    const employed = Math.min(workers, totalJobs + informalJobs(pop)) * 0.98;
    e.population = Math.round(pop);
    e.households = households;
    e.residentialCapacity = resCap;
    e.jobs = totalJobs;
    e.jobsByClass = jobs;
    e.workers = Math.round(workers);
    e.employed = Math.round(employed);
    e.unemployment = workers > 1 ? clamp01(1 - employed / workers) : 0;
    e.jobFill = totalJobs > 0 ? clamp01(employed / totalJobs) : 0;
    // pioneers settle a brand-new city fast, then the market normalises
    this._newCityBonus = pop < 60 ? 2.6 : pop < 400 ? 1.6 : pop < 1500 ? 1.25 : 1;
    const inhabited = pop >= 1;

    // ---------- 3. service coverage & strain ----------
    const cov = e.coverage;
    const demandByType = {};
    // weighted by residents; before anyone has moved in, by the capacity that is waiting for them —
    // otherwise a brand-new city reads coverage 0 everywhere and the move-in rate is throttled by the
    // very utilities the player already built.
    const covOf = (k) => (covWeight > 0 ? sumCov[k] / covWeight : capWeight > 0 ? sumCovCap[k] / capWeight : 0);
    for (let k = 0; k < SERVICE_IDS.length; k++) {
      const id = SERVICE_IDS[k];
      const raw = covOf(k);
      let served = id === 'education' ? raw * pop * 0.22 : raw * pop;
      if (UTILITY_IDS.includes(id)) served += raw * totalJobs * 0.6;
      demandByType[id] = Math.max(0, served);
    }
    const efficiency = e.money < 0 ? 0.6 : 1;
    svc.updateStrain(demandByType, efficiency);
    for (let k = 0; k < SERVICE_IDS.length; k++) {
      const id = SERVICE_IDS[k];
      cov[id] = clamp01(covOf(k) * svc.strain[id]);
    }

    // ---------- 4. pollution, congestion, education, land value ----------
    const indShare = pop > 0 ? jobs.industrial / (pop + jobs.industrial) : 0;
    if (pollutionSources.length && pop > 0) {
      let hit = 0, n = 0;
      for (const st of this._occ.values()) {
        if (st.cls !== 'residential' || st.occ < 1) continue;
        n++;
        for (let i = 0; i < pollutionSources.length; i++) {
          const s = pollutionSources[i];
          const dx = s.x - st.x, dz = s.z - st.z;
          if (dx * dx + dz * dz < 120 * 120) { hit += st.occ; break; }
        }
      }
      industrialNearHomes = n ? hit / pop : 0;
    }
    e.pollution = clamp01(indShare * 0.35 + industrialNearHomes * 0.6 + (1 - cov.garbage) * 0.1 * Math.min(1, pop / 500) + (1 - cov.sewage) * 0.1 * Math.min(1, pop / 500));
    const traffic = this.world.traffic;
    if (traffic && typeof traffic.congestion === 'number') e.congestion = clamp01(traffic.congestion);
    else {
      const segs = this.world.roads.segments ? this.world.roads.segments.size : 0;
      const veh = traffic ? traffic.vehicles || 0 : 0;
      e.congestion = segs > 0 ? clamp01(veh / (segs * 14)) : 0;
    }
    if (inhabited) {
      e.education = damp(e.education, 0.1 + 0.85 * cov.education, 0.08, 1);
      e.landValue = clamp01(0.25 + 0.3 * e.happiness + 0.25 * (cov.police * 0.5 + cov.health * 0.3 + cov.education * 0.2) - 0.35 * e.pollution);
    }

    // ---------- 5. happiness (held at its seed value until someone lives here) ----------
    const tr = e.taxRate;
    const avgTax = (tr.residential * 2 + tr.commercial + tr.industrial + tr.office) / 5;
    const taxPressure = (avgTax - 0.10) * 2.2; // 15 % → −0.11, 5 % → +0.11
    if (inhabited) {
      const util = (cov.power + cov.water + cov.sewage + cov.garbage) / 4;
      const care = (cov.police + cov.fire + cov.health + cov.education) / 4;
      const target = clamp(
        0.42 + 0.28 * util + 0.18 * care - taxPressure - 0.5 * e.unemployment - 0.15 * e.congestion - 0.22 * e.pollution + 0.08 * (e.landValue - 0.3),
        0.05, 0.98,
      );
      this._happinessTarget = target;
      e.happiness = damp(e.happiness, target, 0.12, 1);
    }

    // ---------- 6. demand ----------
    // vacancy only counts homes that have HAD time to fill: a street of houses finished this morning
    // is a pipeline, not oversupply (measuring it raw collapsed demand to 0 and starved the loop).
    const vacancy = settledCap > 0 ? clamp01(1 - settledPop / settledCap) : 0;
    const openJobs = Math.max(0, totalJobs - employed);
    const idealCom = 0.13 * pop + 20;
    const idealInd = 0.16 * pop * (1 - 0.5 * e.education) + 15;
    const idealOff = 0.10 * pop * (0.3 + e.education) + 5;
    const bootstrap = pop < 600 ? 0.18 : 0;
    const dT = this._demandTarget;
    let res = 0.18 + bootstrap + 0.65 * clamp01(openJobs / (totalJobs * 0.6 + 40)) + 0.35 * (e.happiness - 0.5) - 0.9 * Math.max(0, vacancy - 0.12) - taxPressure * 0.5;
    // a full city reads "demand high", never "100 % forever"
    res = Math.min(res, settledCap > 0 && vacancy < 0.03 ? 0.85 : 0.92);
    dT.residential = clamp01(res);
    dT.commercial = clamp01(Math.min(0.92, 0.1 + bootstrap * 0.5 + 0.9 * clamp01((idealCom - jobs.commercial) / (idealCom + 40)) + 0.35 * e.unemployment - (tr.commercial - 0.1) * 2));
    dT.industrial = clamp01(Math.min(0.92, 0.08 + bootstrap * 0.6 + 0.9 * clamp01((idealInd - jobs.industrial) / (idealInd + 40)) + 0.45 * e.unemployment * (1 - e.education) - (tr.industrial - 0.1) * 2));
    dT.office = clamp01(Math.min(0.92, 0.04 + bootstrap * 0.2 + 0.9 * clamp01((idealOff - jobs.office) / (idealOff + 40)) + 0.35 * e.unemployment * e.education - (tr.office - 0.1) * 2));
    const d = e.demand;
    for (const k of ZONE_CLASSES) d[k] = damp(d[k], dT[k], 0.25, 1);

    // ---------- 7. money ----------
    this.recomputeRates();
    const hpm = this.hoursInPeriod();
    const p = this._period;
    p.income += e.income / hpm; p.expenses += e.expenses / hpm; p.hours++;
    for (const k of ZONE_CLASSES) p.taxes[k] += this._taxes[k] / hpm;
    p.services += this._serviceCost / hpm; p.roads += this._roadCost / hpm; p.admin += ADMIN_COST / hpm;
    if (servicesDirty) this._lastServicesVersion = sVersion;

    this.events.emit('economy:changed', e);
  }

  _utilityFactor(e) {
    const c = e.coverage;
    // cities without utilities still grow, just slowly (no building is ever completely dead)
    return 0.3 + 0.7 * clamp01((c.power + c.water) * 0.5 + 0.1);
  }

  /** Weekly income / expense rates from the current state (cheap; called hourly and on setTax). */
  recomputeRates() {
    const e = this.world.economy;
    const tr = e.taxRate;
    const jb = e.jobsByClass;
    const fill = e.jobFill || 0;
    // high taxes shrink the taxable base a little (evasion / businesses leaving)
    const elasticity = (r) => 1 - clamp01((r - 0.12) / 0.18) * 0.45;
    this._taxes = {
      residential: e.population * TAX_BASE.residential * tr.residential * elasticity(tr.residential),
      commercial: jb.commercial * fill * TAX_BASE.commercial * tr.commercial * elasticity(tr.commercial),
      industrial: jb.industrial * fill * TAX_BASE.industrial * tr.industrial * elasticity(tr.industrial),
      office: jb.office * fill * TAX_BASE.office * tr.office * elasticity(tr.office),
    };
    let roadCost = 0;
    const segs = this.world.roads.segments;
    if (segs && segs.size) for (const s of segs.values()) roadCost += (s.length || 0) * (ROAD_COST[s.type] ?? ROAD_COST.default);
    this._roadCost = roadCost;
    this._serviceCost = this.services.weeklyUpkeep();
    const income = this._taxes.residential + this._taxes.commercial + this._taxes.industrial + this._taxes.office;
    const expenses = this._serviceCost + roadCost + ADMIN_COST;
    e.income = Math.round(income);
    e.expenses = Math.round(expenses);
    e.net = e.income - e.expenses;
    e.taxes = this._taxes;
    this._hourlyNet = (income - expenses) / this.hoursInPeriod();
  }

  /** Close the books for week `key` (totalDays / 7) and emit the budget report. */
  closeWeek(key) {
    const e = this.world.economy;
    const p = this._period;
    const st = this._weekStart || { day: 1, month: 1, year: 2026 };
    const label = `Week ${key + 1} (${st.day} ${MONTHS[st.month - 1]} ${st.year})`;
    const prev = this._lastReport;
    const report = {
      week: key + 1, start: st, label,
      income: Math.round(p.income),
      expenses: Math.round(p.expenses),
      net: Math.round(p.income - p.expenses),
      taxes: Object.fromEntries(ZONE_CLASSES.map((k) => [k, Math.round(p.taxes[k])])),
      services: Math.round(p.services),
      roads: Math.round(p.roads),
      admin: Math.round(p.admin),
      hours: p.hours,
      money: Math.round(e.money),
      population: e.population,
      happiness: +e.happiness.toFixed(3),
    };
    report.delta = prev ? report.net - prev.net : null;
    e.budget = report;
    this._prevReport = prev;
    this._lastReport = report;
    this._period = this._emptyPeriod();
    this.events.emit('economy:budget', report);
    if (!this.quiet) this.notifyBudget(report);
    return report;
  }

  notifyBudget(report) {
    const sign = report.net >= 0 ? '+' : '−';
    const d = report.delta;
    const delta = d == null ? '' : d === 0 ? ' · unchanged vs last week' : ` · ${d > 0 ? '▲' : '▼'} ¤${fmt(Math.abs(d))} vs last week`;
    this.events.emit('notification', {
      kind: report.net >= 0 ? 'budget' : 'warning',
      title: `${report.label} budget`,
      text: `Income ¤${fmt(report.income)}, expenses ¤${fmt(report.expenses)} → ${sign}¤${fmt(Math.abs(report.net))} / week${delta}`,
    });
  }

  lastBudget() { return this._lastReport; }
}

export function fmt(n) {
  n = Math.round(n);
  return n.toLocaleString('en-US');
}
