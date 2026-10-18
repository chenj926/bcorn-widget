'use strict';
// Real index script order, renderer entrypoint, bridge, canonical builder; native IPC simulated.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..'), renderer = path.join(root, 'src/renderer');
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)].map(match => match[1]);
assert.ok(scripts.includes('cloud-calendar-ui.js'));
assert.match(html, /cloud-calendar\.css/);
const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'https://bcorn.test', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window, calls = [], writes = [], errors = [];
w.TextEncoder = TextEncoder;
w.HTMLElement.prototype.scrollIntoView = function () {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
w.addEventListener('error', event => errors.push(event.message));
let hidden = false, failSync = false;
Object.defineProperty(w.document, 'hidden', { get: () => hidden });
let saved = { terms: [{ id: 'term', name: 'Synthetic', start: '2026-10-01', end: '2026-10-31', timezone: 'UTC', courses: [{ code: 'ABC101', title: 'Synthetic' }], meetings: [{ code: 'ABC101', day: 1, start: '09:00', end: '10:00' }] }] };
const states = {
  google: { provider: 'google', state: 'ready', accountLabel: 'synthetic@example.test', target: { id: 'app-calendar', name: 'Synthetic app calendar' }, enabled: true, ownedCount: 0 },
  microsoft: { provider: 'microsoft', state: 'not-configured', accountLabel: '', target: null, enabled: false, ownedCount: 0 }
};
w.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
  calls.push({ command, args: args && JSON.parse(JSON.stringify(args)) });
  if (command === 'get_state') return { data: saved, status: { state: 'local' } };
  if (command === 'save_data') { saved = JSON.parse(JSON.stringify(args.data)); return { ok: true }; }
  if (command === 'cloud_calendar_call') {
    const request = args.request;
    if (request.action === 'status') return { ...states[request.provider] };
    if (request.action === 'targets') return [states[request.provider].target].filter(Boolean);
    if (request.action === 'sync') {
      if (failSync) throw new Error('Synthetic cloud offline');
      writes.push(JSON.parse(JSON.stringify(request)));
      return { written: request.series.length, unchanged: 0, deleted: 0, pendingDeleteCount: 0 };
    }
    return {};
  }
  if (command === 'load_grade_book') return null;
  if (command === 'get_grade_sync_status') return { state: 'not-configured' };
  return { ok: true };
} } };
for (const script of scripts) w.eval(fs.readFileSync(path.resolve(renderer, script), 'utf8'));
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const q = selector => { const node = w.document.querySelector(selector); assert.ok(node, selector); return node; };
(async () => {
  await tick();
  assert.equal(w.acorn.platform, 'tauri'); assert.equal(typeof w.acorn.cloudCalendar, 'function');
  assert.equal(writes.length, 1, 'startup uses enabled native target');
  assert.ok(saved.terms[0].meetings[0].id, 'prepareData persisted missing stable ID');
  const stableId = writes[0].series[0].id;
  assert.equal(writes[0].series[0].occurrences.length, 4);
  assert.equal(calls.filter(call => call.command === 'save_data').length, 1, 'ID normalization does not recursively save');
  assert.ok(calls.findIndex(call => call.command === 'save_data') < calls.findIndex(call => call.args?.request?.action === 'sync'), 'stable IDs persist before cloud writes');
  q('[data-action=menu]').click(); await tick();
  assert.match(q('[data-action=calendar-settings]').textContent, /Google \/ Outlook/);
  q('[data-action=calendar-settings]').click(); await tick();
  q('#cloud-calendar-provider').value = 'google';
  q('#cloud-calendar-provider').dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.match(q('#cloud-calendar-panel').textContent, /synthetic@example.test/);
  assert.match(q('#cloud-calendar-panel').textContent, /1,000/);
  q('[data-cloud-calendar=sync]').click(); await tick();
  assert.equal(writes.at(-1).series[0].id, stableId, 'menu sync uses same canonical identity');
  q('#app-dialog [data-action=close-dialog]').click(); await tick();
  async function addEvent(title) {
    q('[data-action=add-menu]').click(); await tick(); q('[data-action=add-event]').click(); await tick();
    for (const [name, value] of Object.entries({ title, date: '2026-10-21', start: '14:00', end: '15:00' })) q(`#event-form [name=${name}]`).value = value;
    q('#event-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await tick();
  }
  failSync = true; await addEvent('Changed locally');
  assert.ok(saved.terms.some(term => term.courses.some(course => course.title === 'Changed locally')), 'cloud failure does not reject local save');
  failSync = false; hidden = true; w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  const before = writes.length; await addEvent('Saved while hidden'); assert.equal(writes.length, before);
  hidden = false; w.document.dispatchEvent(new w.Event('visibilitychange')); await tick();
  assert.equal(writes.length, before + 1); assert.ok(writes.at(-1).series.some(series => series.title === 'Saved while hidden'));
  assert.ok(calls.every(call => call.command !== 'cloud_calendar_call' || call.args.request.action), 'all cloud actions use real bridge request envelope');
  assert.deepEqual(errors, []);
  console.log('Cloud calendar app DOM passed: actual index script order, Tauri bridge envelope, menu entrypoint, startup stable-ID persistence, no recursive saves, local save isolation and foreground recovery. Native IPC simulated.');
  w.close();
})().catch(error => { console.error(error); w.close(); process.exitCode = 1; });
