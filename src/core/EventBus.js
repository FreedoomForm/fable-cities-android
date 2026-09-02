/** Minimal synchronous event bus shared by all modules. */
export class EventBus {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }
  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
  }
  listenerCount(event) {
    const set = this._listeners.get(event);
    return set ? set.size : 0;
  }
  /**
   * Temporarily drop one or more event names (e.g. the demo city fabricating nine weeks of
   * history should not fire nine weeks of `notification` toasts). Returns an unmute fn.
   * Muting is a blunt instrument — use it around a scripted build, never in steady state.
   */
  mute(events) {
    const names = Array.isArray(events) ? events : [events];
    if (!this._muted) this._muted = new Map();
    for (const n of names) this._muted.set(n, (this._muted.get(n) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const n of names) {
        const c = (this._muted.get(n) || 1) - 1;
        if (c > 0) this._muted.set(n, c); else this._muted.delete(n);
      }
    };
  }
  isMuted(event) { return !!(this._muted && this._muted.has(event)); }
  emit(event, ...args) {
    if (this._muted && this._muted.has(event)) return;
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[events] listener for "${event}" threw`, err);
      }
    }
  }
}
