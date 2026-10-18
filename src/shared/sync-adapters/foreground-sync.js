/* User-selected mode A: visible-only adaptive reconciliation, no background service. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GradeForegroundSync = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createScheduler(options) {
    if (!options || typeof options.reconcile !== 'function') throw new TypeError('A reconciliation callback is required.');
    const now = options.now || Date.now;
    const schedule = options.schedule || ((fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return timer; });
    const cancel = options.cancel || clearTimeout;
    const minimum = Math.max(1000, options.minIntervalMs || 15000);
    const maximum = Math.max(minimum, options.maxIntervalMs || 120000);
    let visible = options.visible !== false, online = options.online !== false, enabled = false, disposed = false;
    let timer = null, deadline = null, running = false, requested = false, interval = minimum, retryNotBefore = 0;
    const allowed = () => enabled && visible && online && !disposed;
    function clear() { if (timer !== null) cancel(timer); timer = null; deadline = null; }
    function arm(delay) {
      if (!allowed()) return;
      const target = Math.max(now() + delay, retryNotBefore);
      if (timer !== null && deadline <= target) return;
      clear(); deadline = target;
      timer = schedule(() => { timer = null; deadline = null; run().catch(() => {}); }, Math.max(0, target - now()));
    }
    async function run() {
      if (!allowed()) return;
      if (running) { requested = true; return; }
      if (now() < retryNotBefore) { arm(retryNotBefore - now()); return; }
      running = true; clear();
      try {
        const result = await options.reconcile() || {};
        if (['revoked', 'authorization-required', 'not-configured'].includes(result.status)) enabled = false;
        if (result.retryAfterMs > 0) retryNotBefore = now() + result.retryAfterMs;
        else retryNotBefore = 0;
        interval = result.changed ? minimum : Math.min(maximum, interval * 2);
      } catch (_) { interval = Math.min(maximum, interval * 2); }
      finally {
        running = false;
        if (requested && allowed()) { requested = false; arm(0); }
        else { requested = false; arm(interval); }
      }
    }
    return Object.freeze({
      start(immediate) { enabled = true; if (immediate === false) arm(interval); else arm(0); },
      stop() { enabled = false; requested = false; clear(); },
      setVisible(value) { const changed = visible !== Boolean(value); visible = Boolean(value); if (!visible) { requested = false; clear(); } else if (changed) { interval = minimum; arm(0); } },
      setOnline(value) { const changed = online !== Boolean(value); online = Boolean(value); if (!online) { requested = false; clear(); } else if (changed) { interval = minimum; arm(0); } },
      activity() { interval = minimum; if (!running) arm(minimum); },
      trigger() { return run(); },
      snapshot() { return { enabled, visible, online, running, nextCheckAt: deadline, intervalMs: interval, retryNotBefore }; },
      dispose() { disposed = true; enabled = false; requested = false; clear(); }
    });
  }
  return Object.freeze({ createScheduler });
}));
