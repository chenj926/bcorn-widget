/* Transport-independent automatic two-way synchronization. No credentials or timers. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BcornSync = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  function canonical(value) {
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  const safeId = id => typeof id === 'string' && id.length > 0 && id.length <= 1000 && !['__proto__', 'prototype', 'constructor'].includes(id);
  function merge(base, local, remote, path) {
    path = path || '';
    if (equal(local, remote)) return { value: copy(local), conflicts: [] };
    if (equal(local, base)) return { value: copy(remote), conflicts: [] };
    if (equal(remote, base)) return { value: copy(local), conflicts: [] };
    if (plain(base) && plain(local) && plain(remote)) {
      const value = {}, conflicts = [];
      for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (!safeId(key)) return { value: copy(local), conflicts: [path || '/'] };
        const result = merge(base[key], local[key], remote[key], path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'));
        if (result.value !== undefined) value[key] = result.value;
        conflicts.push(...result.conflicts);
      }
      return { value, conflicts };
    }
    // Arrays and deletion/edit races are atomic: never infer assessment ordering or deletion intent.
    return { value: copy(local), conflicts: [path || '/'] };
  }
  function validJSON(value, depth) {
    if ((depth || 0) > 30) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 10000 && value.every(v => validJSON(v, (depth || 0) + 1));
    return plain(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => safeId(k) && validJSON(value[k], (depth || 0) + 1));
  }
  function syncError(code, message, retryAfterMs) {
    const error = new Error(message || code); error.code = code;
    if (retryAfterMs) error.retryAfterMs = retryAfterMs;
    return error;
  }
  function recordsById(records) {
    if (!Array.isArray(records) || records.length > 10000) throw syncError('invalid-remote', 'Invalid record collection.');
    const result = {};
    for (const record of records) {
      if (!record || !safeId(record.id) || Object.prototype.hasOwnProperty.call(result, record.id) || !validJSON(record.value)) throw syncError('invalid-remote', 'Missing or duplicate stable record ID.');
      result[record.id] = copy(record.value);
    }
    return result;
  }
  /**
   * store.load()/save(state) must atomically persist a private JSON snapshot.
   * adapter.status(): {state:'ready'|'not-configured'|'authorization-required'|'revoked', automaticInbound:boolean}
   * adapter.read(): [{id,value}]; adapter.write({id,value,expected,mutationId}): canonical saved value.
   * value:null denotes a tombstone, never an inferred delete from a partial response.
   * All adapter calls are native/authorized injected dependencies; this module never grants access.
   */
  function createCoordinator(options) {
    const { store, adapter } = options || {};
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || !adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function' || typeof adapter.status !== 'function') throw new TypeError('A durable store and explicit adapter are required.');
    const now = options.now || Date.now;
    const onChange = options.onChange || (() => {});
    let runtimeActive = true;
    let queued = null, requested = false, retryTimer = null;
    const schedule = options.scheduleRetry || ((fn, ms) => { const timer = setTimeout(fn, ms); if (timer.unref) timer.unref(); return timer; });
    const cancel = options.cancelRetry || clearTimeout;
    let state, committed, locallyRevoked = false, chain = Promise.resolve(), disposed = false, generation = 0;
    function emit() { try { onChange(copy(state)); } catch (_) { /* UI observers cannot invalidate a committed save. */ } }
    async function persist() {
      try { await store.save(copy(state)); committed = copy(state); emit(); }
      catch (error) { state = copy(committed); throw error; }
    }
    function serial(task) { const result = chain.then(task); chain = result.catch(() => {}); return result; }
    async function ready() {
      if (state) return;
      const saved = await store.load();
      if (saved && (saved.schemaVersion !== 1 || !plain(saved.records) || !plain(saved.base) || !plain(saved.outbox) || !plain(saved.conflicts))) throw syncError('invalid-storage', 'Unsupported synchronization storage; original data retained.');
      state = saved ? copy(saved) : { schemaVersion: 1, records: {}, base: {}, outbox: {}, conflicts: {}, sequence: 0, status: 'not-configured', lastSyncedAt: null, retryAt: null };
      try {
      for (const key of [...Object.keys(state.records), ...Object.keys(state.base), ...Object.keys(state.outbox), ...Object.keys(state.conflicts)]) if (!safeId(key)) throw syncError('invalid-storage', 'Unsafe record ID.');
      for (const value of [...Object.values(state.records), ...Object.values(state.base)]) if (!validJSON(value)) throw syncError('invalid-storage', 'Invalid stored record.');
      for (const pending of Object.values(state.outbox)) if (!plain(pending) || !validJSON(pending.local) || (pending.base !== undefined && !validJSON(pending.base)) || typeof pending.mutationId !== 'string') throw syncError('invalid-storage', 'Invalid pending mutation.');
      committed = copy(state);
      if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) throw syncError('invalid-storage', 'Invalid sequence.');
      } catch (error) { state = undefined; committed = undefined; throw error; }
    }
    async function synchronize() {
      await ready();
      if (disposed || !runtimeActive || locallyRevoked || state.authorizationBlocked) return copy(state);
      const currentGeneration = generation;
      const capability = await adapter.status();
      state.automaticInbound = capability.automaticInbound === true;
      if (capability.state !== 'ready') { state.status = capability.state; await persist(); return copy(state); }
      if (state.retryAt && now() < state.retryAt) return copy(state);
      state.status = 'syncing'; emit();
      try {
        const remote = recordsById(await adapter.read());
        if (disposed || !runtimeActive || generation !== currentGeneration) return copy(state);
        // Adapter must explicitly supply tombstones. Absence never deletes a local record.
        for (const id of new Set([...Object.keys(remote), ...Object.keys(state.outbox)])) {
          if (disposed || !runtimeActive || generation !== currentGeneration) break;
          const pending = state.outbox[id];
          if (!Object.prototype.hasOwnProperty.call(remote, id) && Object.prototype.hasOwnProperty.call(state.base, id)) {
            state.conflicts[id] = { code: 'remote-missing', base: copy(state.base[id]), local: copy(state.records[id]), remote: undefined, paths: ['/'] };
            continue;
          }
          const remoteValue = remote[id];
          if (!pending) {
            state.records[id] = copy(remoteValue); state.base[id] = copy(remoteValue); delete state.conflicts[id]; continue;
          }
          const result = merge(pending.base, pending.local, remoteValue);
          if (result.conflicts.length) { state.conflicts[id] = { code: 'concurrent-edit', base: copy(pending.base), local: copy(pending.local), remote: copy(remoteValue), paths: result.conflicts }; continue; }
          delete state.conflicts[id];
          state.records[id] = copy(result.value);
          if (!equal(result.value, remoteValue)) {
            // Save pending intent before every side effect. Replays use the same mutation ID.
            pending.local = copy(result.value); pending.base = copy(remoteValue);
            await persist();
            const saved = await adapter.write({ id, value: copy(result.value), expected: copy(remoteValue), mutationId: pending.mutationId });
            if (disposed || !runtimeActive || generation !== currentGeneration) break;
            if (!equal(saved, result.value)) throw syncError('verification-failed', 'Remote write was not verified.');
          }
          state.base[id] = copy(result.value); delete state.outbox[id];
          await persist();
        }
        if (!disposed && runtimeActive && generation === currentGeneration) {
          state.lastSyncedAt = now(); state.retryAt = null; state.retryAttempts = 0; delete state.error;
          if (retryTimer !== null) { cancel(retryTimer); retryTimer = null; }
          state.status = Object.keys(state.conflicts).length ? 'conflict' : Object.keys(state.outbox).length ? 'pending' : 'synced';
          await persist();
        }
      } catch (error) {
        if (disposed || !runtimeActive || generation !== currentGeneration) return copy(state);
        const code = error.code || 'network-error';
        state.status = ['authorization-required', 'revoked', 'not-configured', 'conflict', 'offline'].includes(code) ? code : 'error';
        state.error = { code }; // Do not persist HTTP bodies, tokens, or transport error strings.
        const retryable = ['network-error', 'rate-limited'].includes(code);
        state.retryAttempts = retryable ? (state.retryAttempts || 0) + 1 : 0;
        const delay = retryable ? (error.retryAfterMs || Math.min(60000, 1000 * Math.pow(2, Math.min(state.retryAttempts, 6)))) : 0;
        state.retryAt = delay ? now() + delay : null;
        await persist();
        if (retryable && runtimeActive && !disposed && !locallyRevoked) {
          if (retryTimer !== null) cancel(retryTimer);
          retryTimer = schedule(() => { retryTimer = null; trigger().catch(() => {}); }, delay);
        }
      }
      return copy(state);
    }
    function trigger() {
      requested = true;
      if (queued) return queued;
      queued = serial(async () => {
        let result;
        do { requested = false; result = await synchronize(); } while (requested && runtimeActive && !disposed && !locallyRevoked);
        return result;
      }).finally(() => { queued = null; });
      return queued;
    }
    return Object.freeze({
      async load() { return serial(async () => { await ready(); return copy(state); }); },
      async editMany(records) {
        const changes = recordsById(records);
        const result = await serial(async () => {
          await ready(); if (disposed) throw syncError('disposed', 'Coordinator is disposed.');
          let changed = false;
          for (const [id, value] of Object.entries(changes)) {
            if (equal(state.records[id], value)) continue;
            changed = true; const local = copy(value); state.sequence += 1;
            const prior = state.outbox[id];
            state.outbox[id] = { base: copy(prior ? prior.base : state.base[id]), local, mutationId: `${options.deviceId || 'local'}:${state.sequence}` };
            state.records[id] = local; delete state.conflicts[id];
          }
          state.status = Object.keys(state.outbox).length ? 'pending' : state.status;
          if (changed) await persist(); return copy(state);
        });
        trigger().catch(() => {}); return result;
      },
      async edit(id, value) {
        if (!safeId(id) || !validJSON(value)) throw syncError('invalid-edit', 'A stable ID and JSON value or explicit null tombstone are required.');
        return this.editMany([{ id, value }]);
      },
      async resolve(id, value) {
        await serial(async () => {
          await ready(); const conflict = state.conflicts[id];
          if (!conflict) throw syncError('not-found', 'No conflict for this record.');
          if (conflict.code === 'remote-missing') throw syncError('relink-required', 'Verify the deleted/moved remote row before relinking.');
          state.base[id] = copy(conflict.remote); delete state.outbox[id]; delete state.conflicts[id]; await persist();
        });
        return this.edit(id, value);
      },
      notifyRemoteChange: trigger, onResume: trigger, onOnline: trigger, syncNow: trigger,
      async revoke() {
        generation += 1; locallyRevoked = true; if (retryTimer !== null) { cancel(retryTimer); retryTimer = null; }
        return serial(async () => { await ready(); state.status = 'revoked'; state.authorizationBlocked = true; state.automaticInbound = false; await persist(); return copy(state); });
      },
      async resumeAfterAuthorization() {
        await serial(async () => { await ready(); if ((await adapter.status()).state !== 'ready') throw syncError('authorization-required'); locallyRevoked = false; state.authorizationBlocked = false; await persist(); });
        return trigger();
      },
      setActive(value) { runtimeActive = Boolean(value); if (!runtimeActive && retryTimer !== null) { cancel(retryTimer); retryTimer = null; } },
      idle() { return chain.then(() => copy(state)); },
      dispose() { disposed = true; generation += 1; if (retryTimer !== null) cancel(retryTimer); }
    });
  }
  return Object.freeze({ createCoordinator, merge, canonical, syncError, recordsById });
}));
