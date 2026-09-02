/**
 * Milestones (population thresholds with cash rewards) and city alerts (service shortages,
 * unemployment, deficits). Emits `notification` { kind, title, text } and `milestone`.
 */
import { fmt } from './economy.js';

export const MILESTONES = [
  { name: 'Tiny Village', population: 120, reward: 25000 },
  { name: 'Small Village', population: 400, reward: 40000 },
  { name: 'Large Village', population: 1000, reward: 60000 },
  { name: 'Grand Village', population: 2200, reward: 90000 },
  { name: 'Tiny Town', population: 4000, reward: 120000 },
  { name: 'Boom Town', population: 7000, reward: 160000 },
  { name: 'Busy Town', population: 11000, reward: 200000 },
  { name: 'Big Town', population: 16000, reward: 260000 },
  { name: 'Great Town', population: 24000, reward: 320000 },
  { name: 'Small City', population: 34000, reward: 400000 },
  { name: 'Big City', population: 50000, reward: 500000 },
  { name: 'Large City', population: 70000, reward: 650000 },
  { name: 'Grand City', population: 100000, reward: 800000 },
  { name: 'Metropolis', population: 150000, reward: 1000000 },
  { name: 'Megalopolis', population: 250000, reward: 1500000 },
];

const ALERT_COOLDOWN_HOURS = 24 * 3;

export class Milestones {
  constructor(world, events) {
    this.world = world;
    this.events = events;
    this.index = -1; // last reached milestone
    this.reached = [];
    this._alertTimers = new Map(); // key → hour count when it may fire again
    this._activeAlerts = new Set();
    this.hour = 0;
    this._hadResidents = false;
    this._update();
  }

  _update() {
    const e = this.world.economy;
    const next = MILESTONES[this.index + 1] || null;
    e.milestone = {
      index: this.index,
      name: this.index >= 0 ? MILESTONES[this.index].name : 'Founding',
      next: next ? next.name : null,
      nextPopulation: next ? next.population : null,
      progress: next ? Math.min(1, e.population / next.population) : 1,
      reached: this.reached.slice(),
    };
  }

  /** Call once per game hour after the economy updated. */
  tick() {
    this.hour++;
    const e = this.world.economy;
    const t = this.world.time;

    if (!this._hadResidents && e.population >= 5) {
      this._hadResidents = true;
      this.events.emit('notification', { kind: 'info', title: 'First residents', text: `The first families have moved into ${e.cityName}.` });
    }
    // milestones (only one per hour so the notifications don't flood on fast-forward)
    const next = MILESTONES[this.index + 1];
    if (next && e.population >= next.population) {
      this.index++;
      this.reached.push({ name: next.name, day: t.totalDays, population: e.population });
      e.money += next.reward;
      this.events.emit('milestone', { index: this.index, ...next });
      this.events.emit('notification', {
        kind: 'milestone',
        title: `Milestone: ${next.name}`,
        text: `${e.cityName} reached ${fmt(next.population)} residents. Reward ¤${fmt(next.reward)}.`,
      });
    }
    this._update();

    // alerts
    const pop = e.population;
    const cov = e.coverage;
    const alerts = [];
    const check = (key, cond, kind, title, text) => {
      if (!cond) { this._activeAlerts.delete(key); return; }
      alerts.push({ key, kind, title, text });
      if (this._activeAlerts.has(key)) return;
      const until = this._alertTimers.get(key) || 0;
      if (this.hour < until) return;
      this._activeAlerts.add(key);
      this._alertTimers.set(key, this.hour + ALERT_COOLDOWN_HOURS);
      this.events.emit('notification', { kind, title, text });
    };
    const need = pop >= 20; // tell a first-time player about power/water while the village is still tiny
    check('power', need && cov.power < 0.5, 'warning', 'Not enough electricity', 'Homes are without power. Build a power plant within reach.');
    check('water', need && cov.water < 0.5, 'warning', 'Water shortage', 'Residents lack fresh water. Build a water tower nearby.');
    check('sewage', need && cov.sewage < 0.5, 'warning', 'Sewage backing up', 'Waste water has nowhere to go — build a treatment plant.');
    check('garbage', pop >= 250 && cov.garbage < 0.5, 'warning', 'Garbage piling up', 'Add a landfill site to collect the city\'s trash.');
    check('health', pop >= 500 && cov.health < 0.4, 'info', 'No healthcare nearby', 'Citizens ask for a medical clinic.');
    check('education', pop >= 700 && cov.education < 0.4, 'info', 'Schools needed', 'Children have no school in range.');
    check('safety', pop >= 400 && (cov.police < 0.4 || cov.fire < 0.4), 'info', 'Emergency services thin', 'Police or fire coverage is low in parts of the city.');
    check('unemployment', pop >= 200 && e.unemployment > 0.15, 'warning', 'High unemployment', `${Math.round(e.unemployment * 100)} % of the workforce is out of work. Zone commercial or industrial areas.`);
    // structural shortage: more jobs than a fully occupied housing stock could ever staff
    check('jobs', pop >= 200 && e.jobs > 60 && e.unemployment < 0.05 && e.jobs > e.residentialCapacity * 0.62 * 1.25, 'info', 'Businesses need workers', 'Companies cannot find staff — zone more housing.');
    check('happiness', pop >= 100 && e.happiness < 0.4, 'warning', 'Citizens are unhappy', 'Happiness is low. Check services, taxes and traffic.');
    check('deficit', e.net < 0 && e.money < 60000, 'warning', 'Budget deficit', `The city loses ¤${fmt(-e.net)} a ${e.period || 'week'}. Raise taxes or cut services.`);
    check('bankrupt', e.money < 0, 'alert', 'The city is broke', 'Services run at reduced efficiency until the budget recovers.');
    e.alerts = alerts;
  }
}
