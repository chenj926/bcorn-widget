const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/tauri-bridge.js'), 'utf8');

function shell({ existing, failCommand } = {}) {
  const calls = [], listeners = new Map();
  const window = { acorn: existing, __TAURI__: {
    core: { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === failCommand) throw new Error('Expected test error');
      return command === 'get_state' ? { data: null, status: { state: 'unsupported' }, pinned: false } : { ok: true };
    } },
    event: { listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); } },
  } };
  vm.runInNewContext(source, { window });
  return { window, calls, listeners };
}

test('bridge remains inert in browsers and never replaces Electron preload', () => {
  const window = {};
  vm.runInNewContext(source, { window });
  assert.equal(window.acorn, undefined);
  const existing = { platform: 'electron' };
  const s = shell({ existing });
  assert.equal(s.window.acorn, existing);
  assert.equal(s.listeners.size, 0);
});

test('startup only registers events: no refresh, login, network or cache writes', async () => {
  const s = shell();
  await Promise.resolve();
  assert.deepEqual(s.calls, []);
  assert.equal(s.listeners.size, 2);
  assert.equal(s.window.acorn.capabilities.login, false);
  assert.equal(s.window.acorn.capabilities.refresh, false);
  assert.equal(Object.isFrozen(s.window.acorn), true);
  const state = await s.window.acorn.getState();
  assert.equal(state.status.state, 'unsupported');
  assert.deepEqual(s.calls.map(c => c.command), ['get_state']);
});

test('native state and pin events forward payloads and support unsubscribe', () => {
  const s = shell(); const updates = [], pins = [];
  const off = s.window.acorn.onUpdate(v => updates.push(v));
  s.window.acorn.onPinned(v => pins.push(v));
  const payload = { data: { terms: [] } };
  s.listeners.get('acorn:update')({ payload });
  s.listeners.get('widget:pinned')({ payload: true });
  off(); s.listeners.get('acorn:update')({ payload: { data: null } });
  assert.deepEqual(updates, [payload]); assert.deepEqual(pins, [true]);
});

test('explicit save/export/map calls preserve their narrow arguments', async () => {
  const s = shell(); const bridge = s.window.acorn;
  const data = { terms: [] };
  await bridge.saveData(data);
  await bridge.exportCalendar({ filename: 'classes.ics', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
  await bridge.openExternal('https://www.google.com/maps/search/?api=1&query=Campus');
  await bridge.hide();
  assert.deepEqual(s.calls.map(c => c.command), ['save_data', 'export_calendar', 'open_external', 'minimize']);
  assert.equal(s.calls[0].args.data, data);
  assert.equal(s.calls[1].args.filename, 'classes.ics');
  assert.equal(s.calls[2].args.url.startsWith('https://www.google.com/'), true);
});

test('clearData is explicit, pathless and never invoked during startup', async () => {
  const s = shell();
  assert.equal(s.calls.length, 0);
  await s.window.acorn.clearData();
  assert.deepEqual(s.calls.map(c => c.command), ['clear_data']);
  assert.equal(s.calls[0].args, undefined);
});

test('button failure emits a visible error instead of an unhandled rejection', async () => {
  const s = shell({ failCommand: 'toggle_pin' }); const updates = [];
  s.window.acorn.onUpdate(v => updates.push(v));
  const result = await s.window.acorn.togglePin();
  assert.equal(result.error, 'Expected test error');
  assert.equal(updates[0].status.state, 'error');
});

test('native configuration has no development server or broad network permission', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json')));
  assert.equal(config.build.devUrl, undefined);
  assert.equal(config.app.withGlobalTauri, true);
  assert.equal(config.app.windows[0].resizable, true);
  assert.equal(config.app.windows[0].minWidth, 260);
  assert.equal(config.app.windows[0].minHeight, 280);
  assert.equal(config.app.windows[0].url, 'renderer/index.html');
  assert.match(config.app.security.csp, /connect-src ipc: http:\/\/ipc\.localhost;/);
  const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/capabilities/main.json')));
  assert.deepEqual(capabilities.windows, ['main']);
  assert.deepEqual(capabilities.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten']);
});

test('gradebook bridge uses independent storage commands and never timetable save', async () => {
  const s=shell(),book={schemaVersion:1,courses:[]};
  await s.window.acorn.loadGradeBook();await s.window.acorn.saveGradeBook(book);
  assert.deepEqual(s.calls.map(c=>c.command),['load_grade_book','save_grade_book']);
  assert.equal(s.calls[1].args.book,book);
});

test('grade sync exposes narrow native commands, isolates journals by connection and never requests tokens', async () => {
  const s = shell(), b = s.window.acorn;
  await b.getGradeSyncStatus();
  await b.connectGradeSheet({ title: 'Synthetic grades', tab: 'Assessments' });
  const request = { method: 'GET', path: '/v4/spreadsheets/synthetic/values/Assessments!A:N' };
  await b.gradeSheetsRequest(request);
  await b.gradeSheetVersion();
  await b.loadGradeSyncState('synthetic-connection');
  await b.saveGradeSyncState('synthetic-connection', { schemaVersion: 1 });
  assert.deepEqual(s.calls.map(c => c.command), ['get_grade_sync_status', 'connect_grade_sheet', 'grade_sheets_request', 'grade_sheet_version', 'load_grade_sync_state', 'save_grade_sync_state']);
  assert.equal(s.calls[2].args.request, request);
  assert.equal(s.calls[4].args.connectionId, 'synthetic-connection');
  assert.equal(s.calls[5].args.envelope.schemaVersion, 1);
  assert.equal(b.getAccessToken, undefined);
});
