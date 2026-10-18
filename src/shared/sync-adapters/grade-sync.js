/* Materializes assessment records into the private local gradebook, with a recovery journal. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../grade-book'), require('../sync-coordinator'));
  else root.GradeSync = factory(root.GradeBook, root.BcornSync);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Grades, Sync) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const courseKey = id => 'course:' + encodeURIComponent(id);
  const assessmentKey = (courseId, id) => 'assessment:' + encodeURIComponent(courseId) + ':' + encodeURIComponent(id);
  function recordsFromBook(book) {
    book = Grades.normalizeBook(book);
    const records = [];
    for (const c of book.courses) {
      records.push({ id: courseKey(c.id), value: { kind: 'course', courseId: c.id, title: c.title, termId: c.termId, rule: c.rules.kind } });
      for (const a of c.assessments) records.push({ id: assessmentKey(c.id, a.id), value: { kind: 'assessment', courseId: c.id, assessmentId: a.id, title: a.title, weight: a.weight, status: a.status, score: a.score } });
    }
    return records;
  }
  function bookFromRecords(records) {
    const map = Sync.recordsById(records), courses = new Map();
    for (const [id, v] of Object.entries(map)) {
      if (v === null) continue;
      if (v.kind === 'course') {
        if (id !== courseKey(v.courseId) || courses.has(v.courseId)) throw Sync.syncError('invalid-remote', 'Course row IDs must not be changed.');
        courses.set(v.courseId, { id: v.courseId, title: v.title, termId: v.termId, rules: { kind: v.rule }, assessments: [] });
      } else if (v.kind !== 'assessment') throw Sync.syncError('invalid-remote', 'Unknown grade record type.');
    }
    for (const [id, v] of Object.entries(map)) {
      if (!v || v.kind !== 'assessment') continue;
      const c = courses.get(v.courseId);
      if (!c || id !== assessmentKey(v.courseId, v.assessmentId)) throw Sync.syncError('invalid-remote', 'Assessment references a missing course or changed stable ID.');
      c.assessments.push({ id: v.assessmentId, title: v.title, weight: v.weight, status: v.status, score: v.score });
    }
    return Grades.normalizeBook({ schemaVersion: 1, courses: [...courses.values()] });
  }
  function changesForBook(book, publishedBook) {
    const records = recordsFromBook(book), present = new Set(records.map(r => r.id));
    for (const old of recordsFromBook(publishedBook)) if (!present.has(old.id)) records.push({ id: old.id, value: null });
    return records;
  }
  /**
   * syncStore is private, connection-scoped, atomic storage for the recovery envelope.
   * Never reuse it across another account/file/tab. bookStore saves only normalized grades.
   * Local saves finish before networking. The journal reconciles a crash between the two files.
   */
  function createService(options) {
    const { bookStore, syncStore, adapter, deviceId } = options;
    if (!bookStore || !syncStore || !adapter || !deviceId) throw new TypeError('Private stores, configured adapter and stable device ID are required.');
    let publishedBook = { schemaVersion: 1, courses: [] }, initialized = false, revision = 0, queue = Promise.resolve(), disposed = false;
    let envelopeState = null, lastStatus = { status: 'not-configured' };
    const listeners = new Set();
    const emit = value => { lastStatus = value; for (const listener of listeners) { try { listener(clone(value)); } catch (_) {} } };
    const coordinator = Sync.createCoordinator({
      adapter, deviceId, now: options.now, scheduleRetry: options.scheduleRetry, cancelRetry: options.cancelRetry,
      store: {
        async load() {
          const saved = await syncStore.load();
          if (saved) {
            if (saved.schemaVersion !== 1 || !saved.publishedBook) throw Sync.syncError('invalid-storage', 'Unknown synchronization journal version.');
            publishedBook = Grades.normalizeBook(saved.publishedBook); envelopeState = saved.coordinator;
          }
          return envelopeState;
        },
        async save(state) { await syncStore.save({ schemaVersion: 1, coordinator: state, publishedBook }); envelopeState = state; }
      },
      onChange: state => {
        emit({ status: state.status, automaticInbound: state.automaticInbound === true, pending: Object.keys(state.outbox).length, conflicts: state.conflicts, lastSyncedAt: state.lastSyncedAt, error: state.error || null });
        if (initialized && state.status === 'synced') { const seen = revision; enqueue(() => materialize(seen)).catch(() => {}); }
      }
    });
    function enqueue(task) {
      const result = queue.then(task);
      queue = result.catch(error => emit({ ...lastStatus, status: 'error', error: { code: error.code || 'local-storage-error' } }));
      return result;
    }
    async function init() { if (!initialized) { await coordinator.load(); initialized = true; } }
    async function materialize(expectedRevision) {
      if (disposed || expectedRevision !== revision) return;
      const state = await coordinator.load();
      const next = bookFromRecords(Object.entries(state.records).map(([id, value]) => ({ id, value })));
      // An unconfigured new connection has no remote records; local initialization queues them first.
      const changed = Sync.canonical(next) !== Sync.canonical(publishedBook);
      if (changed) await bookStore.save(next);
      publishedBook = next;
      if (changed) await syncStore.save({ schemaVersion: 1, coordinator: state, publishedBook });
      envelopeState = state;
      if (changed) emit({ ...lastStatus, book: next });
      return { changed, status: state.status, retryAfterMs: state.retryAt ? Math.max(0, state.retryAt - (options.now || Date.now)()) : 0 };
    }
    async function localIntent(book, expectedRevision) {
      await init();
      await coordinator.editMany(changesForBook(book, publishedBook));
      await coordinator.idle();
      await materialize(expectedRevision);
    }
    return Object.freeze({
      async start() {
        return enqueue(async () => { await init(); const local = await bookStore.load(); await localIntent(local || { schemaVersion: 1, courses: [] }, revision); });
      },
      async saveBook(book) {
        const next = Grades.normalizeBook(book), currentRevision = ++revision;
        await bookStore.save(next);
        enqueue(() => localIntent(next, currentRevision)).catch(() => {});
        return next;
      },
      notifyRemoteChange() { return enqueue(async () => { await init(); const seen = revision; await coordinator.notifyRemoteChange(); return materialize(seen); }); },
      onResume() { return this.notifyRemoteChange(); },
      onOnline() { return this.notifyRemoteChange(); },
      async resolve(id, value) { return enqueue(async () => { const seen = revision; await coordinator.resolve(id, value); await coordinator.idle(); await materialize(seen); }); },
      subscribe(listener) { listeners.add(listener); listener(clone(lastStatus)); return () => listeners.delete(listener); },
      async revoke() { return coordinator.revoke(); },
      setActive(value) { coordinator.setActive(value); },
      idle() { return queue.then(() => coordinator.idle()); },
      dispose() { disposed = true; coordinator.dispose(); listeners.clear(); }
    });
  }
  return Object.freeze({ recordsFromBook, bookFromRecords, changesForBook, createService });
}));
