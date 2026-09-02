/**
 * Game clock. Advances world.time (hour / day / month / year) from real dt and the speed step,
 * emits `time:tick` every frame and reports how many whole game minutes elapsed so the
 * simulation can run its per-minute tick deterministically. Minutes that cannot be processed in
 * one frame (dt spikes, low frame rates) are carried over to the next frames so the economy's
 * hourly bookkeeping never drifts from world.time.
 */
export const SPEED_MULTIPLIER = [0, 1, 2, 4];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0 = Monday … 6 = Sunday, from the real calendar. */
export function weekdayOf(year, month, day) {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

export function daysInMonth(month, year) {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month - 1] || 30;
}

export class GameClock {
  constructor(world, events) {
    this.world = world;
    this.events = events;
    const t = world.time;
    t.speed = Math.max(0, Math.min(3, Math.round(t.speed ?? 1)));
    t.paused = t.speed === 0;
    t.secondsPerHour = t.secondsPerHour || 20;
    t.elapsedGameSeconds = t.elapsedGameSeconds || 0;
    t.totalDays = 0;
    t.weekday = weekdayOf(t.year, t.month, t.day);
    t.minute = Math.floor((t.hour % 1) * 60);
    this._minuteAcc = 0;
    this._pending = 0; // whole minutes not yet handed to the simulation
    this.maxTicksPerFrame = 8;
  }

  /** speed step 0..3 (0 = paused). Emits `time:speed`. */
  setSpeed(step) {
    const t = this.world.time;
    const s = Math.max(0, Math.min(3, Math.round(Number(step) || 0)));
    if (s === t.speed && t.paused === (s === 0)) return s;
    t.speed = s;
    t.paused = s === 0;
    this.events.emit('time:speed', s);
    return s;
  }

  /** Real-time multiplier: game seconds per real second at the current speed. */
  rate() {
    const t = this.world.time;
    return (t.paused ? 0 : SPEED_MULTIPLIER[t.speed] || 0) * 3600 / t.secondsPerHour;
  }

  /**
   * Advance by `gameSeconds`; rolls days / months / years. Returns the number of whole game
   * minutes that passed (the caller runs one sim tick for each).
   */
  advance(gameSeconds) {
    const t = this.world.time;
    if (gameSeconds <= 0) return 0;
    t.elapsedGameSeconds += gameSeconds;
    t.hour += gameSeconds / 3600;
    while (t.hour >= 24) {
      t.hour -= 24;
      this._nextDay();
    }
    t.minute = Math.floor((t.hour % 1) * 60);
    this._minuteAcc += gameSeconds / 60;
    const minutes = Math.floor(this._minuteAcc);
    this._minuteAcc -= minutes;
    return minutes;
  }

  _nextDay() {
    const t = this.world.time;
    t.day++;
    t.totalDays++;
    if (t.day > daysInMonth(t.month, t.year)) {
      t.day = 1;
      t.month++;
      if (t.month > 12) { t.month = 1; t.year++; this.events.emit('time:year', t.year); }
      this.events.emit('time:month', { month: t.month, year: t.year });
    }
    t.weekday = weekdayOf(t.year, t.month, t.day);
    this.events.emit('time:day', { day: t.day, month: t.month, year: t.year, weekday: t.weekday, totalDays: t.totalDays });
    if (t.totalDays % 7 === 0) this.events.emit('time:week', { week: t.totalDays / 7 });
  }

  /** Per-frame update: advances the clock, emits `time:tick`, returns sim minutes to process now. */
  update(dt) {
    const t = this.world.time;
    // an external setTime() may have moved the hour; keep our minute bookkeeping in sync
    if (t.hour < 0 || t.hour >= 24) t.hour = ((t.hour % 24) + 24) % 24;
    this._pending += this.advance(dt * this.rate());
    this.events.emit('time:tick', {
      hour: t.hour, minute: t.minute, day: t.day, month: t.month, year: t.year,
      weekday: t.weekday, totalDays: t.totalDays, speed: t.speed, paused: t.paused,
    });
    // spread a backlog over the following frames instead of dropping minutes
    const n = Math.min(this._pending, this.maxTicksPerFrame);
    this._pending -= n;
    return n;
  }

  /** Drop any carried-over minutes (after an explicit fast-forward handled them itself). */
  resetPending() { this._pending = 0; this._minuteAcc = 0; }

  /** "Tue 14 May 2026, 13:42" */
  format() {
    const t = this.world.time;
    const hh = String(Math.floor(t.hour)).padStart(2, '0');
    const mm = String(Math.floor((t.hour % 1) * 60)).padStart(2, '0');
    return `${WEEKDAYS[t.weekday]} ${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${hh}:${mm}`;
  }
}
