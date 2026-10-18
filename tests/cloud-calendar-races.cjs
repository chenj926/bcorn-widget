'use strict';
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { create } = require('../src/renderer/cloud-calendar-ui');
const dom = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'https://bcorn.test' });
const doc = dom.window.document, calls = [];
let data = null, gate = null, preparedGate = null, hidden = false, renders = 0, pendingDeletes = 0;
Object.defineProperty(doc, 'hidden', { get: () => hidden });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const controller = create({ document: doc, getData: () => data,
  openDialog: (title, body) => { renders++; doc.querySelector('main').innerHTML = `<dialog open>${body}</dialog>`; },
  prepareData: async value => { if (preparedGate) await preparedGate; return value; },
  buildSeries: value => [{ id: String(value.version) }],
  invoke: async (action, args) => {
    if (action === 'status') return { enabled: true, accountLabel: 'account', target: { id: args.provider, name: args.provider } };
    if (action === 'targets') return [{ id: args.provider, name: args.provider }];
    if (action === 'sync') {
      calls.push(args);
      if (gate && args.provider === 'google') await gate;
      return { pendingDeleteCount: args.provider === 'microsoft' && args.series[0].id === '1' ? 1 : pendingDeletes };
    }
    return {};
  }
});
(async () => {
  await controller.ready;
  let release; gate = new Promise(resolve => { release = resolve; });
  data = { version: 1 }; const first = controller.onTimetableSaved(data); await tick();
  data = { version: 2 }; const second = controller.onTimetableSaved(data); release(); gate = null;
  await Promise.all([first, second]);
  assert.equal(calls.some(call => call.provider === 'microsoft' && call.series[0].id === '1'), false, 'old queue snapshot cannot adopt new revision across providers');
  await controller.openSettings();
  assert.equal(doc.querySelector('[data-cloud-calendar=review-delete]'), null);
  const select = doc.querySelector('#cloud-calendar-provider'); select.value = 'google'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await tick();
  pendingDeletes = 1; doc.querySelector('[data-cloud-calendar=sync]').click(); await tick();
  assert.ok(doc.querySelector('[data-cloud-calendar=review-delete]'));
  pendingDeletes = 0; doc.querySelector('[data-cloud-calendar=sync]').click(); await tick();
  assert.equal(doc.querySelector('[data-cloud-calendar=review-delete]'), null, 'fresh zero-removal result clears prior plan');
  gate = new Promise(resolve => { release = resolve; });
  doc.querySelector('[data-cloud-calendar=sync]').click(); await tick();
  doc.querySelector('dialog').open = false; const before = renders;
  release(); gate = null; await tick();
  assert.equal(renders, before, 'async sync completion cannot reopen dismissed dialog');
  assert.equal(doc.querySelector('dialog').open, false);
  let preparedRelease; preparedGate = new Promise(resolve => { preparedRelease = resolve; });
  const beforeCalls = calls.length; data = { version: 3 };
  const preparing = controller.onTimetableSaved(data); await tick();
  hidden = true; preparedRelease(); preparedGate = null; await preparing;
  assert.equal(calls.length, beforeCalls, 'foreground rechecked after stable-ID preparation');
  hidden = false;
  await controller.pauseForImport();
  const pausedCalls = calls.length;
  await controller.onTimetableSaved({ version: 4 });
  assert.equal(calls.length, pausedCalls, 'import pause prevents both providers receiving replacement data');
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem('bcorn-cloud-calendar-import-pause-v1')), ['google', 'microsoft']);
  controller.dispose();
  const restarted = create({ document: doc, getData: () => ({ version: 5 }), openDialog() {}, buildSeries: value => [value], invoke: async action => {
    if (action === 'sync') throw new Error('paused restart must not sync');
    if (action === 'status') return { enabled: true, accountLabel: 'account', target: { id: 'old' } };
    return {};
  } });
  await restarted.ready;
  restarted.dispose(); dom.window.close();
  console.log('Cloud calendar race tests passed: immutable multi-provider revisions, clearing stale deletion plans, dismissed-dialog ownership, foreground recheck after preparation.');
})().catch(error => { console.error(error); controller.dispose(); dom.window.close(); process.exitCode = 1; });
