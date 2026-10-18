'use strict';
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { create } = require('../src/renderer/cloud-calendar-ui.js');
const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
const doc = dom.window.document, calls = [], notices = [], builtReminders = [];
const preferences = new Map(), storage = { getItem: key => preferences.get(key) || null, setItem: (key, value) => preferences.set(key, value) };
let hidden = false, data = { version: 1 }, failSync = false, pendingDeletes = 0, syncGate = null;
Object.defineProperty(doc, 'hidden', { get: () => hidden });
const status = Object.fromEntries(['google', 'microsoft'].map(provider => [provider, { provider, state: 'disconnected', accountLabel: null, target: null, enabled: false }]));
const controller = create({ document: doc, storage, getData: () => data,
  openDialog: (title, html) => { doc.querySelector('main').innerHTML = html; },
  notify: text => notices.push(text), buildSeries: (value, reminder) => { builtReminders.push(reminder); return [{ id: `v${value.version}` }]; },
  invoke: async (action, args) => {
    calls.push({ action, ...args });
    const s = status[args.provider];
    if (action === 'status') return { ...s };
    if (action === 'connect') { s.accountLabel = '<account@test>'; s.state = 'connected'; }
    if (action === 'targets') return [{ id: 'target-1', name: '<My calendar>' }];
    if (action === 'bind') { s.enabled = true; s.target = { id: args.calendarId, name: 'My calendar' }; }
    if (action === 'disconnect') { s.enabled = false; s.state = 'authorization-required'; }
    if (action === 'sync') { if (syncGate) await syncGate; if (failSync) throw new Error('Synthetic offline'); return { pendingDeleteCount: args.allowDelete ? 0 : pendingDeletes }; }
    return { ok: true };
  }
});
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const q = selector => { const node = doc.querySelector(selector); assert.ok(node, selector); return node; };
const click = async action => { q(`[data-cloud-calendar="${action}"]`).click(); await tick(); };
const choose = async p => { q('#cloud-calendar-provider').value = p; q('#cloud-calendar-provider').dispatchEvent(new dom.window.Event('change', { bubbles: true })); await tick(); };
(async () => {
  await controller.ready;
  await controller.openSettings();
  assert.equal(calls.filter(x => x.action === 'connect').length, 0);
  await choose('google'); assert.match(doc.body.textContent, /calendar.app.created/);
  await click('connect'); assert.equal(calls.filter(x => x.action === 'sync').length, 0);
  assert.match(doc.body.textContent, /<account@test>/); assert.equal(doc.querySelector('account'), null);
  await click('bind'); assert.match(q('#cloud-calendar-error').textContent, /勾选/);
  q('#cloud-calendar-target').value = 'target-1'; q('#cloud-calendar-consent').checked = true;
  await click('bind'); assert.ok(calls.find(x => x.action === 'bind' && x.confirmed === true));
  assert.equal(calls.filter(x => x.action === 'sync').length, 1);
  assert.equal(calls.find(x => x.action === 'sync').allowDelete, false);
  assert.match(doc.body.textContent, /1,000/); assert.match(doc.body.textContent, /通知设置/);
  q('#cloud-calendar-reminder').value = 'none';
  q('#cloud-calendar-reminder').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await click('sync'); assert.equal(builtReminders.at(-1), null);
  assert.equal(JSON.parse(storage.getItem('bcorn-cloud-calendar-reminders-v1')).google, null);
  failSync = true; await controller.onTimetableSaved(data); assert.match(notices.at(-1), /保存在本地/); failSync = false;
  hidden = true; doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  const count = calls.filter(x => x.action === 'sync').length;
  await controller.onTimetableSaved(data); assert.equal(calls.filter(x => x.action === 'sync').length, count);
  hidden = false; doc.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
  assert.equal(calls.filter(x => x.action === 'sync').length, count + 1, 'foreground return reconciles enabled connection once');
  await tick(); assert.equal(calls.filter(x => x.action === 'sync').length, count + 1, 'no timer polling');
  pendingDeletes = 2; await click('sync'); await click('review-delete');
  assert.equal(calls.filter(x => x.allowDelete).length, 0);
  await click('delete'); assert.equal(calls.filter(x => x.allowDelete).length, 1);
  await click('sync'); await click('review-delete');
  data = { version: 2 }; await controller.onTimetableSaved(data); await click('delete');
  assert.equal(calls.filter(x => x.allowDelete).length, 1, 'stale confirmation never deletes newly saved data');
  let release; syncGate = new Promise(resolve => { release = resolve; });
  q('[data-cloud-calendar=sync]').click(); await tick();
  hidden = true; data = { version: 3 }; await controller.onTimetableSaved(data);
  release(); syncGate = null; await tick(); hidden = false;
  assert.equal(doc.querySelector('[data-cloud-calendar=review-delete]'), null, 'old in-flight response cannot install stale delete plan');
  await click('disconnect'); assert.equal(status.google.enabled, false); assert.ok(q('[data-cloud-calendar=connect]'), 'retained account label does not imply usable credentials');
  await choose('microsoft'); assert.match(doc.body.textContent, /Calendars.ReadWrite/);
  assert.equal(calls.filter(x => x.action === 'connect' && x.provider === 'microsoft').length, 0);
  await click('connect');
  q('#cloud-calendar-target').value = 'target-1'; q('#cloud-calendar-consent').checked = true;
  await click('bind'); assert.ok(calls.find(x => x.action === 'sync' && x.provider === 'microsoft'));
  await click('disconnect'); status.microsoft.state = 'not-configured';
  await controller.openSettings(); assert.equal(q('[data-cloud-calendar=connect]').disabled, true);
  assert.match(doc.body.textContent, /尚未配置/);
  status.microsoft.state = 'storage-unavailable';
  await controller.openSettings(); assert.equal(q('[data-cloud-calendar=connect]').disabled, true);
  assert.match(doc.body.textContent, /凭据存储不可用/);
  assert.doesNotMatch(doc.body.textContent, /尚未配置/);
controller.dispose(); await tick();
  const resumed = [];
  const second = create({ document: doc, storage, getData: () => data, openDialog() {},
    buildSeries: (value, reminder) => [{ id: `v${value.version}`, reminder }],
    invoke: async (action, args) => {
      if (action === 'status') return { enabled: args.provider === 'google', target: { id: 'target-1', name: 'Calendar' } };
      if (action === 'sync') resumed.push(args);
      return {};
    }
  });
  await second.ready;
  assert.equal(resumed.length, 1, 'startup reconciles previously enabled provider only');
  assert.equal(resumed[0].series[0].reminder, null, 'reminder preference survives controller recreation');
  assert.equal(resumed[0].series[0].id, 'v3', 'startup uses latest local data');
  second.dispose(); dom.window.close();
  console.log('Cloud calendar DOM passed: explicit provider/account/target, escaping, failure isolation, foreground-only, confirmed deletion, stale-confirmation protection. Native APIs simulated.');
})().catch(error => { console.error(error); controller.dispose(); dom.window.close(); process.exitCode = 1; });
