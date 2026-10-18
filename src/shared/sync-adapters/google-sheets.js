/* A bounded, explicitly linked bcorn tab. Never scans or writes unrelated workbook tabs. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../sync-coordinator'), require('../grade-book'));
  else root.BcornSheets = factory(root.BcornSync, root.GradeBook);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Sync, Grades) {
  'use strict';
  const HEADERS = ['recordId', 'type', 'courseId', 'courseTitle', 'term', 'assessmentId', 'assessment', 'weight', 'status', 'scoreMode', 'ratio', 'earned', 'possible', 'rule'];
  const same = (a, b) => Sync.canonical(a) === Sync.canonical(b);
  const err = Sync.syncError;
  function decodeRow(row, number) {
    const [id, type, courseId, courseTitle, termId, assessmentId, title, weight, status, mode, value, earned, possible, rule] = row;
    if (typeof id !== 'string' || !id.trim()) throw err('invalid-remote', `Row ${number} has no stable ID.`);
    if (type === 'deleted') return { id, value: null };
    if (type === 'course') {
      const check = Grades.validateCourse({ id: courseId, assessments: [], rules: { kind: rule } });
      if (!check.ok || typeof courseTitle !== 'string' || typeof termId !== 'string' || !['weighted', 'unconfirmed'].includes(rule)) throw err('invalid-remote', `Invalid course row ${number}.`);
      return { id, value: { kind: 'course', courseId, title: courseTitle, termId, rule } };
    }
    if (type !== 'assessment') throw err('invalid-remote', `Unknown row type at ${number}.`);
    const score = status !== 'graded' ? null : mode === 'points' ? { mode, earned, possible } : { mode, value };
    const assessment = { id: assessmentId, title, weight, status, score };
    const check = Grades.validateCourse({ id: courseId, assessments: [assessment], rules: { kind: 'weighted' } });
    if (!check.ok) throw err('invalid-remote', `Invalid data in row ${number}; nothing has been overwritten.`);
    return { id, value: { kind: 'assessment', courseId, assessmentId, title, weight, status, score } };
  }
  function encodeRecord(id, value) {
    if (value === null) return [id, 'deleted', '', '', '', '', '', '', '', '', '', '', '', ''];
    let row;
    if (value.kind === 'course') row = [id, 'course', value.courseId, value.title, value.termId, '', '', '', '', '', '', '', '', value.rule];
    else {
      const score = value.score || {};
      row = [id, 'assessment', value.courseId, '', '', value.assessmentId, value.title, value.weight, value.status, score.mode || '', score.mode === 'ratio' ? score.value : '', score.mode === 'points' ? score.earned : '', score.mode === 'points' ? score.possible : '', ''];
    }
    decodeRow(row, 0); return row;
  }
  /** request({method,path,body}) is an authorized native transport, not a bearer token in JS. */
  function createAdapter(options) {
    options = options || {};
    const { request, binding, authorizationStatus } = options;
    const configured = typeof request === 'function' && binding && typeof binding.spreadsheetId === 'string' && /^[A-Za-z0-9_-]+$/.test(binding.spreadsheetId) && typeof binding.tab === 'string' && binding.tab.length > 0 && binding.tab.length <= 100 && binding.confirmed === true;
    const prefix = configured ? '/v4/spreadsheets/' + encodeURIComponent(binding.spreadsheetId) : '';
    const a1 = configured ? "'" + binding.tab.replace(/'/g, "''") + "'" : '';
    async function status() {
      if (!configured) return { state: 'not-configured', automaticInbound: false };
      if (typeof authorizationStatus !== 'function') return { state: 'authorization-required', automaticInbound: false };
      const state = await authorizationStatus();
      const inbound = typeof options.inboundPushConfigured === 'function' ? await options.inboundPushConfigured() : options.inboundPushConfigured;
      return { state, automaticInbound: state === 'ready' && inbound === true };
    }
    async function call(method, path, body) {
      const auth = await status();
      if (auth.state !== 'ready') throw err(auth.state, 'Connect this app and explicitly select a spreadsheet first.');
      const response = await request({ method, path, body });
      if (!response || !Number.isInteger(response.status)) throw err('invalid-response');
      if (response.status === 401) throw err('authorization-required');
      // Native transports normalize recognized quota reasons to 429. A remaining
      // file permission denial does not prove the whole OAuth grant was revoked.
      if (response.status === 403) throw err('authorization-required');
      if (response.status === 404) throw err('relink-required');
      if (response.status === 429) throw err('rate-limited', 'Retry later.', Math.max(1000, Math.min(Number(response.retryAfterMs) || 60000, 3600000)));
      if (response.status < 200 || response.status >= 300) throw err(response.status >= 500 ? 'network-error' : 'request-failed');
      return response.body;
    }
    let cached = null;
    const copyTable = table => ({ records: JSON.parse(JSON.stringify(table.records)), rows: new Map(table.rows), nextRow: table.nextRow });
    async function readTable(force) {
      let version = null;
      if (typeof options.getVersion === 'function') {
        const auth = await status(); if (auth.state !== 'ready') throw err(auth.state);
        const metadata = await options.getVersion();
        if (!metadata || typeof metadata.version !== 'string' || !metadata.version) throw err('invalid-response', 'Remote version could not be verified.');
        version = metadata.version;
        if (!force && cached && cached.version === version) return copyTable(cached.table);
      }
      const body = await call('GET', prefix + '/values/' + encodeURIComponent(a1 + '!A1:N1002') + '?valueRenderOption=UNFORMATTED_VALUE');
      const values = body && body.values;
      if (!Array.isArray(values) || !same(values[0], HEADERS)) throw err('schema-mismatch', 'Select a bcorn assessment tab with the exact documented headers.');
      if (values.length > 1001) throw err('limit-exceeded', 'The tab exceeds 1000 assessment rows.');
      const records = [], rows = new Map();
      for (let i = 1; i < values.length; i++) {
        if (!values[i].some(v => v !== '' && v !== null)) continue;
        const record = decodeRow(values[i], i + 1);
        if (rows.has(record.id)) throw err('invalid-remote', 'Duplicate assessment IDs.');
        rows.set(record.id, i + 1); records.push(record);
      }
      Sync.recordsById(records); const table = { records, rows, nextRow: values.length + 1 };
      if (version !== null) cached = { version, table: copyTable(table) };
      return table;
    }
    return Object.freeze({
      status,
      async read() { return (await readTable()).records; },
      async write({ id, value, expected }) {
        const table = await readTable(true);
        const record = table.records.find(item => item.id === id);
        if (!same(record && record.value, expected)) throw err('conflict', 'The remote row changed since it was read.');
        if (same(record && record.value, value)) return value;
        const row = table.rows.get(id) || table.nextRow;
        if (row > 1001) throw err('limit-exceeded');
        const range = a1 + '!A' + row + ':N' + row;
        cached = null;
        await call('PUT', prefix + '/values/' + encodeURIComponent(range) + '?valueInputOption=RAW', { range, majorDimension: 'ROWS', values: [encodeRecord(id, value)] });
        const verified = (await readTable(true)).records.find(item => item.id === id);
        if (!verified || !same(verified.value, value)) throw err('verification-failed');
        return verified.value;
      }
    });
  }
  function templateRequest(title, tab) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof tab !== 'string' || !tab.trim() || tab.length > 100) throw err('invalid-template');
    return { method: 'POST', path: '/v4/spreadsheets', body: { properties: { title }, sheets: [{ properties: { title: tab, gridProperties: { rowCount: 1002, columnCount: HEADERS.length, frozenRowCount: 1 } }, data: [{ rowData: [{ values: HEADERS.map(stringValue => ({ userEnteredValue: { stringValue } })) }] }] }] } };
  }
  return Object.freeze({ HEADERS: Object.freeze(HEADERS), decodeRow, encodeRecord, createAdapter, templateRequest });
}));
