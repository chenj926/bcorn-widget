/* Reproducible, synthetic DOM fallback. This intentionally does not claim layout,
 * browser/WebView, native permission, OAuth, or screenshot coverage. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
// Use the browser suite's synthetic fixture without starting its Chromium runner.
const test = fs.readFileSync(path.join(__dirname, 'compact-ui.cjs'), 'utf8');
const fixture = JSON.parse(JSON.stringify(vm.runInNewContext(test.slice(test.indexOf('const fixture ='), test.indexOf('// Pure geometry')) + 'fixture')));
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const scripts = ['shared/course-tools.js', 'renderer/calendar-ui.js', 'shared/grade-book.js', 'renderer/grades-ui.js', 'shared/calendar-link.js', 'renderer/calendar-integration.js', 'renderer/app.js'];
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function setup(data, widgetWeek) {
  const dom = new JSDOM(html, { url: 'https://bcorn.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, saved = [], errors = [];
  w.addEventListener('error', (event) => errors.push(event.error?.message || event.message));
  const ticks = new Map();
  const nativeTimeout = w.setTimeout.bind(w), nativeClear = w.clearTimeout.bind(w);
  w.setTimeout = (callback, delay, ...args) => { const id = nativeTimeout(callback, delay, ...args); if (delay === 30000) ticks.set(id, callback); return id; };
  w.clearTimeout = (id) => { ticks.delete(id); return nativeClear(id); };
  w.TextEncoder = TextEncoder;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.localStorage.setItem('tab', 'term'); if (widgetWeek) w.__acornWidgetWeek = widgetWeek;
  w.acorn = { platform: 'android', capabilities: { login: false, pin: false, refresh: false }, getState: async () => ({ data, status: { state: 'unsupported' } }), onUpdate() {}, onPinned() {}, saveData: async (next) => { saved.push(JSON.parse(JSON.stringify(next))); return { ok: true }; } };
  for (const file of scripts) w.eval(fs.readFileSync(path.join(root, 'src', file), 'utf8'));
  const q = (selector) => { const element = w.document.querySelector(selector); assert.ok(element, selector); return element; };
  const all = (selector) => [...w.document.querySelectorAll(selector)];
  const change = (selector, value) => { q(selector).value = value; q(selector).dispatchEvent(new w.Event('change', { bubbles: true })); };
  const fill = (selector, value) => { q(selector).value = value; q(selector).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = async (selector) => { q(selector).click(); await pause(); };
  const submit = async (selector) => {
    q(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await pause();
    assert.equal(q('#app-dialog').open, false, w.document.querySelector('#form-error')?.textContent);
  };
  await pause();
  return { w, saved, errors, q, all, change, fill, click, submit, ticks, close: () => w.close() };
}
(async () => {
  const env = await setup(fixture, '2026-11-02');
  try {
    const { w, saved, errors, q, all, change, fill, click, submit } = env;
    assert.equal(q('#calendar-date').value, '2026-11-02', 'startup consumes widget destination after data loads');
    assert.equal(w.__acornWidgetWeek, undefined);
    assert.equal(env.ticks.size, 1, 'one foreground calendar clock');
    Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    assert.equal(env.ticks.size, 0, 'hidden calendar cancels its wakeup');
    Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    assert.equal(env.ticks.size, 1, 'resume rearms one clock without duplicate timers');
    change('#calendar-date', '2026-10-19');
    assert.equal(all('.week-head button').length, 7); assert.equal(all('.block').length, 5);
    assert.equal(all('#calendar-date').length, 1); assert.equal(all('.chips').length, 0);
    // A tapped Sunday event seeds its own date/time, not the Monday week anchor.
    await click('.block[data-meeting="4"]'); await click('[data-action="add-course-event"]');
    assert.equal(q('#event-form [name="date"]').value, '2026-10-25');
    assert.equal(q('#event-form [name="start"]').value, '11:00');
    assert.equal(q('#event-form [name="end"]').value, '11:15');
    w.acornHandleBack(); w.acornHandleBack();
    // Deep links queue while the editor is dirty and do not bypass discard confirmation.
    await click('.week-agenda .slot[data-meeting="2"]'); await click('.detail-footer [data-action="edit-course-event"]');
    fill('#event-form [name="title"]', 'Unsaved quiz');
    assert.equal(w.acornOpenWidgetWeek('2026-11-09'), false);
    assert.equal(q('#calendar-date').value, '2026-10-19');
    w.acornHandleBack(); assert.equal(q('#discard-dialog').open, true);
    await click('[data-action="keep-editing"]'); assert.equal(q('#event-form [name="title"]').value, 'Unsaved quiz');
    w.acornHandleBack(); await click('[data-action="discard-changes"]'); w.acornHandleBack();
    assert.equal(q('#calendar-date').value, '2026-11-09'); assert.equal(saved.length, 0);
    assert.equal(w.acornOpenWidgetWeek({ date: '2026-11-11', mode: 'day' }), true);
    assert.equal(q('#calendar-date').value, '2026-11-11');
    assert.equal(q('[data-tab="today"]').getAttribute('aria-selected'), 'true');
    assert.equal(w.acornOpenWidgetWeek({ date: 'not-a-date', mode: 'day' }), false);
    assert.equal(w.acornOpenWidgetWeek('2026-10-19'), true);
    assert.equal(q('[data-tab="term"]').getAttribute('aria-selected'), 'true');
    change('#calendar-date', '2026-10-19');
    assert.match(q('.week-agenda .slot-title').textContent, /SYN101/);
    assert.ok(!q('.week-agenda .slot').textContent.includes('Synthetic lecture'), 'compact agenda uses course code; full name stays in detail');
    assert.ok(q('.week-agenda .slot-place').textContent.length, 'location has its own visible line');
    await click('[data-action="toggle-course-list"]');
    for (const [title, date] of [['Quiz C', '2026-10-22'], ['Quiz D', '2026-12-12']]) {
      await click('.course-open[data-course="SYN101"]'); await click('[data-action="add-course-event"]');
      assert.equal(q('#event-form [name="start"]').value, '09:00'); assert.equal(q('#event-form [name="end"]').value, '09:15');
      fill('#event-form [name="title"]', title); fill('#event-form [name="date"]', date);
      q('#event-form [name="color"][value="#8161B4"]').checked = true;
      await submit('#event-form');
    }
    assert.equal(saved.at(-1).terms[0].meetings.length, 7); assert.equal(saved.at(-1).terms[0].end, '2026-11-30');
    assert.equal(all('.block').length, 1, 'one-off after term remains visible');
    const ids = saved.at(-1).terms[0].meetings.map((m) => m.id).sort();
    await click('.course-open[data-course="SYN101"]'); await click('[data-action="edit-course"]');
    assert.equal(all('.meeting-fields').length, 1);
    fill('#course-form [name="title"]', 'Renamed course'); q('#course-form [name="color"][value="#B9712C"]').checked = true;
    await submit('#course-form');
    assert.deepEqual(saved.at(-1).terms[0].meetings.map((m) => m.id).sort(), ids);
    assert.equal(saved.at(-1).terms[0].courses[0].color, '#B9712C');
    assert.equal(saved.at(-1).terms[0].meetings.find((m) => m.title === 'Quiz C').color, '#8161B4');
    await click('.week-agenda .slot'); await click('.detail-footer [data-action="edit-course-event"]');
    const selectedId = saved.at(-1).terms[0].meetings.find((m) => m.title === 'Quiz D').id;
    fill('#event-form [name="title"]', 'Quiz D revised'); await submit('#event-form');
    assert.equal(saved.at(-1).terms[0].meetings.find((m) => m.title === 'Quiz D revised').id, selectedId);
    await click('.week-agenda .slot'); await click('[data-action="remove-course-event"]'); await click('[data-action="confirm-remove-course-event"]');
    assert.equal(saved.at(-1).terms[0].meetings.length, 6);
    for (const id of ['weekly-a', 'quiz-a', 'quiz-b']) assert.ok(saved.at(-1).terms[0].meetings.some((m) => m.id === id));
    await click('[data-action="menu"]'); await click('[data-action="add-holiday"]'); fill('#holiday-form [name="title"]', 'Local closure'); await submit('#holiday-form');
    assert.equal(saved.at(-1).terms[0].holidays.length, 2);
    await click('[data-action="menu"]'); await click('[data-action="add-holiday"]');
    assert.equal(q('[data-action="toggle-holiday-preset"]').dataset.enabled, 'false', 'official preset is optional');
    assert.match(q('.calendar-preset').textContent, /Engineering 本科/);
    assert.match(q('.calendar-source').textContent, /engineering.calendar.utoronto.ca/);
    await click('[data-action="toggle-holiday-preset"]'); assert.equal(saved.at(-1).terms[0].holidays.length, 9);
    await click('[data-action="toggle-holiday-preset"]'); assert.equal(saved.at(-1).terms[0].holidays.length, 2, 'removing preset preserves custom annotations');
    w.acornHandleBack();
    // Independent grade forms survive an incoming widget link until explicit discard.
    await click('[data-tab="grades"]'); await pause(); assert.match(q('#grade-book-panel').textContent, /作业/);
    fill('[data-gb-form="course"] [name="title"]', 'Unsaved grade course');
    assert.equal(w.acornOpenWidgetWeek('2026-11-16'), false);
    w.confirm = () => false; await click('[data-tab="term"]'); assert.equal(q('[data-tab="grades"]').getAttribute('aria-selected'), 'true');
    w.confirm = () => true; await click('[data-tab="term"]'); assert.equal(q('#calendar-date').value, '2026-11-16');
    assert.deepEqual(errors, []);
  } finally { env.close(); }
  const migrationData = { source: 'local', terms: [{ id: 'imported-events', name: 'Synthetic imported events', start: '2026-10-01', end: '2026-11-30', timezone: 'America/Toronto', courses: [{ code: 'EVTSET', title: 'Synthetic event collection', type: 'event' }], meetings: [
    { id: 'move-zone', code: 'EVTSET', title: 'Synthetic timezone item', kind: 'EVENT', recurrence: 'once', date: '2026-10-19', start: '09:00', end: '09:15' },
    { id: 'move-range', code: 'EVTSET', title: 'Synthetic range item', kind: 'EVENT', recurrence: 'weekly', day: 2, start: '11:00', end: '12:00' },
    { id: 'keep-sibling', code: 'EVTSET', title: 'Synthetic retained sibling', kind: 'EVENT', recurrence: 'weekly', day: 3, start: '13:00', end: '14:00' }
  ] }] };
  const migration = await setup(migrationData);
  try {
    const { saved, errors, all, change, fill, click, submit } = migration;
    change('#calendar-date', '2026-10-19');
    await click('.block[data-meeting="0"]'); await click('[data-action="edit-course"]'); fill('#event-form [name="timezone"]', 'America/Vancouver'); await submit('#event-form');
    let data = saved.at(-1), original = data.terms.find((term) => term.id === 'imported-events');
    assert.deepEqual(original.meetings.map((m) => m.id), ['move-range', 'keep-sibling']); assert.equal(original.courses.length, 1);
    assert.equal(data.terms.find((term) => term.meetings.some((m) => m.id === 'move-zone')).timezone, 'America/Vancouver');
    all('.block').find((element) => element.textContent.includes('Synthetic range item')).click(); await pause(); await click('[data-action="edit-course"]');
    fill('#event-form [name="from"]', '2027-02-02'); fill('#event-form [name="until"]', '2027-02-16'); await submit('#event-form');
    data = saved.at(-1); original = data.terms.find((term) => term.id === 'imported-events');
    assert.deepEqual(original.meetings.map((m) => m.id), ['keep-sibling']); assert.equal(original.courses.length, 1);
    assert.equal(data.terms.flatMap((term) => term.meetings).length, 3);
    assert.equal(data.terms.flatMap((term) => term.meetings).filter((m) => m.id === 'move-zone').length, 1);
    assert.equal(data.terms.flatMap((term) => term.meetings).find((m) => m.id === 'move-range').from, '2027-02-02');
    assert.deepEqual(errors, []);
  } finally { migration.close(); }
  console.log('Synthetic DOM fallback passed: compact structure, 7 days, event defaults/identity/sibling preservation, timezone/range migration, colors, annotations, widget startup/dirty queue and grade guard. Browser layout and native runtime remain separate checks.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
