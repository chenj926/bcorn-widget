'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const calls = [];
const listeners = {};
const context = { window: { addEventListener: (event, listener) => { listeners[event] = listener; } }, AcornNative: { call(...args) { calls.push(args); } } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'app/src/main/assets/android-bridge.js'), 'utf8'), context);
const bridge = context.window.acorn;
(async () => {
  assert.equal(bridge.platform, 'android');
  context.window.acornHandleBack = () => true;
  assert.equal(context.window.__acornNativeBackState().consumed, true);
  context.window.acornHandleBack = () => false;
  assert.equal(context.window.__acornNativeBackState().interaction, 0);
  listeners.click(); listeners.input(); listeners.change(); listeners.scroll();
  assert.equal(context.window.__acornNativeBackState().consumed, false);
  assert.equal(context.window.__acornNativeBackState().interaction, 4);
  assert.equal(listeners.pointerdown, undefined, 'cancelled system edge gesture must not reset double-back');
  assert.equal(bridge.capabilities.refresh, false);
  assert.equal(bridge.capabilities.login, false);
  const state = bridge.getState();
  assert.deepEqual(calls.shift(), ['1', 'getState', 'null']);
  context.window.__acornNativeReply('1', { data: null }, null);
  assert.deepEqual(await state, { data: null });
  let update;
  const unsubscribe = bridge.onUpdate(value => update = value);
  context.window.__acornNativeUpdate({ data: 'local' });
  assert.deepEqual(update, { data: 'local' });
  unsubscribe();
  context.window.__acornNativeUpdate({ data: 'ignored' });
  assert.deepEqual(update, { data: 'local' });
  const save = bridge.saveData({ terms: [] });
  assert.deepEqual(calls.shift(), ['2', 'saveData', '{"terms":[]}']);
  context.window.__acornNativeReply('2', null, 'Invalid input');
  await assert.rejects(save, /Invalid input/);
  const exp = bridge.exportCalendar({ filename: 'test.ics', content: 'BEGIN:VCALENDAR' });
  assert.equal(calls.shift()[1], 'exportCalendar');
  context.window.__acornNativeReply('3', { canceled: true }, null);
  assert.deepEqual(await exp, { canceled: true });
  const clear = bridge.clearData();
  assert.deepEqual(calls.shift(), ['4', 'clearData', 'null']);
  const cleared = { data: null, status: { state: 'unsupported' } };
  context.window.__acornNativeReply('4', cleared, null);
  assert.deepEqual(await clear, cleared);
  for (const method of ['calendarStatus', 'requestCalendarPermission', 'listCalendars', 'selectCalendar', 'syncCalendarEvent', 'removeCalendarEvent', 'loadGradeBook', 'saveGradeBook']) {
    const operation = bridge[method]({ synthetic: true });
    const call = calls.shift(); assert.equal(call[1], method);
    context.window.__acornNativeReply(call[0], { ok: true }, null);
    assert.deepEqual(await operation, { ok: true });
  }
  for (const method of ['getGradeSyncStatus', 'connectGradeSheet', 'gradeSheetsRequest', 'gradeSheetVersion']) {
    const operation = bridge[method]({ synthetic: true });
    const call = calls.shift(); assert.equal(call[1], method);
    context.window.__acornNativeReply(call[0], { ok: true }, null);
    assert.deepEqual(await operation, { ok: true });
  }
  for (const [method, args, expected] of [
    ['loadGradeSyncState', ['synthetic-connection'], { connectionId: 'synthetic-connection' }],
    ['saveGradeSyncState', ['synthetic-connection', { schemaVersion: 1 }], { connectionId: 'synthetic-connection', envelope: { schemaVersion: 1 } }]
  ]) {
    const operation = bridge[method](...args), call = calls.shift();
    assert.equal(call[1], method); assert.deepEqual(JSON.parse(call[2]), expected);
    context.window.__acornNativeReply(call[0], { ok: true }, null); await operation;
  }
  assert.equal(bridge.getAccessToken, undefined);
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert(manifest.includes('com.acorn.widget.GRADE_SYNC_CONFIGURED'));
  assert(manifest.includes('android:value="false"'));
  const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(permissions.sort(), ['android.permission.INTERNET', 'android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR']);
  assert(!manifest.includes('<service'));
  assert(manifest.includes('android:allowBackup="false"'));
  assert(manifest.includes('android:exported="false"'));
  const widget = fs.readFileSync(path.join(root, 'app/src/main/res/xml/timetable_widget_info.xml'), 'utf8');
  assert(widget.includes('android:updatePeriodMillis="86400000"'));
  assert(widget.includes('android:previewImage="@drawable/widget_preview"'));
  assert(widget.includes('android:previewLayout="@layout/timetable_widget_preview"'));
  assert(widget.includes('android:targetCellWidth="5"'));
  assert(widget.includes('android:targetCellHeight="7"'));
  assert(widget.includes('android:resizeMode="horizontal|vertical"'));
  console.log('PASS Android bridge state/update/save/export and static opt-in-calendar/foreground-grade-network/no-service daily local widget contract');
})().catch(error => { console.error(error); process.exitCode = 1; });
