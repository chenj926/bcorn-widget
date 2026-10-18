/* Synthetic local-only renderer regression. No student data, native permission or cloud account. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const CalendarUI = require('../src/renderer/calendar-ui');
const fixture = { source: 'local', terms: [{ id: 'synthetic', name: 'Synthetic term', start: '2026-10-01', end: '2026-11-30', timezone: 'America/Toronto', courses: [
  { code: 'SYN101', title: 'Synthetic lecture', color: '#3976C6' },
  { code: 'SYN102', title: 'Synthetic overlap', color: '#278767' }
], meetings: [
  { id: 'weekly-a', code: 'SYN101', title: 'Synthetic lecture', section: 'LEC01', kind: 'LEC', day: 1, start: '09:00', end: '10:00' },
  { id: 'weekly-b', code: 'SYN102', title: 'Synthetic overlap', section: 'TUT01', kind: 'TUT', day: 1, start: '09:15', end: '10:15' },
  { id: 'quiz-a', code: 'SYN101', title: 'Synthetic quiz A', kind: 'EVENT', recurrence: 'once', date: '2026-10-19', start: '09:30', end: '09:45', color: '#BC5547' },
  { id: 'quiz-b', code: 'SYN101', title: 'Synthetic quiz B', kind: 'EVENT', recurrence: 'once', date: '2026-10-24', start: '10:00', end: '10:15' },
  { id: 'weekend', code: 'SYN102', title: 'Synthetic Sunday presentation', kind: 'EVENT', recurrence: 'once', date: '2026-10-25', start: '11:00', end: '11:15' }
], holidays: [{ id: 'mark-a', title: 'Synthetic school closure', kind: 'school-break', start: '2026-10-19', end: '2026-10-20' }] }] };
// Pure geometry checks can also be reused without a browser.
const lanes = CalendarUI.layoutLanes([{ s: 540, e: 600 }, { s: 555, e: 615 }, { s: 570, e: 585 }]);
assert.equal(lanes.length, 3); assert.ok(lanes.every((item) => item.lanes === 3));
assert.deepEqual(lanes.map((item) => item.lane), [0, 1, 2]);
const brief = CalendarUI.layoutLanes([{ s: 540, e: 545 }, { s: 550, e: 555 }]);
assert.equal(brief[0].lanes, 2, 'visual minimum height must participate in collision layout');
assert.equal(CalendarUI.colorFor(fixture.terms[0], 'SYN101', fixture.terms[0].meetings[2]), '#BC5547');
assert.equal(CalendarUI.colorFor(fixture.terms[0], 'SYN101'), '#3976C6');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-19T13:30:00Z') });
    await page.addInitScript((data) => {
      localStorage.setItem('tab', 'term'); window.__saved = [];
      window.acorn = { platform: 'android', capabilities: { login: false, refresh: false, pin: false }, getState: async () => ({ data, status: { state: 'unsupported' } }), onUpdate() {}, onPinned() {}, saveData: async (next) => { window.__saved.push(JSON.parse(JSON.stringify(next))); return { ok: true }; } };
    }, fixture);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.waitForSelector('.week');
    for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 900, height: 700 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.locator('#calendar-date').count(), 1, 'one date picker only');
      assert.equal(await page.locator('.week-head [data-day-date]').count(), 7, 'all seven days always visible');
      assert.equal(await page.locator('.chips').count(), 0, 'no duplicate term-chip stack');
      assert.equal(await page.locator('.brand').isVisible(), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const sizes = await page.locator('#btn-add,[data-action="menu"],.nav-arrow,.tabs button,.today-btn').evaluateAll((els) => els.map((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      sizes.forEach((size) => assert.ok(size.width >= 48 && size.height >= 48, JSON.stringify(size)));
      const headerHeight = await page.locator('.week').evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(headerHeight <= 125, `calendar starts too low: ${headerHeight}`);
      const days = await page.locator('.week-head [data-day-date]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      assert.ok(days[0].left >= 0 && days[6].right <= viewport.width, 'Saturday and Sunday fit without horizontal scroll');
      await fs.mkdir('/tmp/bcorn-compact-qa', { recursive: true });
      await page.screenshot({ path: `/tmp/bcorn-compact-qa/week-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const short = page.locator('.block[data-meeting="2"]');
    assert.match(await short.getAttribute('aria-label'), /Synthetic quiz A.*9:30–9:45/);
    assert.ok((await short.boundingBox()).height >= 23, '15-minute item has readable line height');
    const overlaps = await page.locator('.day[data-grid-date="2026-10-19"] .block').evaluateAll((els) => els.map((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, lanes: el.style.getPropertyValue('--lanes') })));
    assert.equal(overlaps.length, 3); assert.ok(overlaps.every((item) => item.lanes === '3'));
    const ordered = overlaps.sort((a, b) => a.left - b.left);
    assert.ok(ordered.every((item, index) => !index || ordered[index - 1].right <= item.left + .5), 'overlap lanes are physically distinct');
    assert.equal(await page.locator('.day.has-annotation').count(), 2);
    assert.equal(await page.locator('.block[data-course="SYN101"]').count(), 3, 'annotation does not suppress teaching');
    assert.equal(await short.evaluate((el) => el.style.getPropertyValue('--event-color')), '#BC5547');
    // A narrow short/overlap item is also available as a full-width accessible agenda row.
    assert.equal(await page.locator('.week-agenda .slot').count(), 3);
    await page.locator('.week-agenda .slot[data-meeting="2"]').click();
    assert.match(await page.locator('.detail-title').textContent(), /Synthetic quiz A/);
    await page.locator('.detail-footer [data-action="edit-course-event"]').click();
    await page.fill('#event-form [name="title"]', 'Unsaved quiz edit');
    await page.evaluate(() => window.acornHandleBack());
    assert.equal(await page.locator('#discard-dialog').evaluate((el) => el.open), true);
    await page.click('[data-action="keep-editing"]');
    assert.equal(await page.locator('#event-form [name="title"]').inputValue(), 'Unsaved quiz edit');
    await page.evaluate(() => window.acornHandleBack()); await page.click('[data-action="discard-changes"]');
    assert.equal(await page.evaluate(() => window.__saved.length), 0);
    await page.evaluate(() => window.acornHandleBack());
    // A new item starts from the tapped occurrence, even when the week anchor differs.
    await page.locator('.block[data-meeting="4"]').click(); await page.click('[data-action="add-course-event"]');
    assert.equal(await page.locator('#event-form [name="date"]').inputValue(), '2026-10-25');
    assert.equal(await page.locator('#event-form [name="start"]').inputValue(), '11:00');
    assert.equal(await page.locator('#event-form [name="end"]').inputValue(), '11:15');
    await page.evaluate(() => window.acornHandleBack()); await page.evaluate(() => window.acornHandleBack());
    // A home-screen week link waits for dirty editors rather than throwing work away.
    await page.locator('.week-agenda .slot[data-meeting="2"]').click();
    await page.locator('.detail-footer [data-action="edit-course-event"]').click();
    await page.fill('#event-form [name="title"]', 'Dirty before widget link');
    assert.equal(await page.evaluate(() => window.acornOpenWidgetWeek('2026-11-02')), false);
    assert.equal(await page.locator('#event-form [name="title"]').inputValue(), 'Dirty before widget link');
    assert.equal(await page.locator('#calendar-date').inputValue(), '2026-10-19');
    await page.evaluate(() => window.acornHandleBack()); await page.click('[data-action="discard-changes"]');
    await page.evaluate(() => window.acornHandleBack());
    assert.equal(await page.locator('#calendar-date').inputValue(), '2026-11-02');
    assert.equal(await page.locator('[data-tab="term"]').getAttribute('aria-selected'), 'true');
    await page.locator('#calendar-date').fill('2026-10-19'); await page.locator('#calendar-date').dispatchEvent('change');
    // Add two independent 15-minute items inside one existing course.
    const openCourse = async () => {
      if (await page.locator('[data-action="toggle-course-list"]').getAttribute('aria-expanded') === 'false') await page.click('[data-action="toggle-course-list"]');
      await page.locator('.course-open[data-course="SYN101"]').click();
    };
    for (const [title, date] of [['Synthetic quiz C', '2026-10-22'], ['Synthetic quiz D', '2026-12-12']]) {
      await openCourse(); await page.click('[data-action="add-course-event"]');
      await page.fill('#event-form [name="title"]', title); await page.fill('#event-form [name="date"]', date);
      assert.equal(await page.locator('#event-form [name="end"]').inputValue(), '09:15');
      await page.check('#event-form [name="color"][value="#8161B4"]');
      await page.click('.header-save');
      await page.waitForFunction((name) => window.__saved.at(-1)?.terms[0].meetings.some((m) => m.title === name), title);
    }
    let saved = await page.evaluate(() => window.__saved.at(-1));
    assert.equal(saved.terms.length, 1); assert.equal(saved.terms[0].courses.length, 2);
    assert.equal(saved.terms[0].end, '2026-11-30', 'one-off outside term does not widen weekly course bounds');
    assert.equal(saved.terms[0].meetings.length, 7);
    const siblingIds = saved.terms[0].meetings.map((m) => m.id);
    assert.equal(new Set(siblingIds).size, 7, 'one-offs have independent stable IDs');
    assert.equal(await page.locator('.block').count(), 1, 'out-of-term one-off still visible');
    // Editing the course preserves every one-off and its title, ID and explicit color.
    await openCourse(); await page.click('[data-action="edit-course"]');
    assert.equal(await page.locator('.meeting-fields').count(), 1, 'weekly editor excludes independent one-offs');
    await page.fill('#course-form [name="title"]', 'Renamed synthetic lecture');
    await page.check('#course-form [name="color"][value="#B9712C"]');
    await page.click('.header-save');
    await page.waitForFunction(() => window.__saved.at(-1)?.terms[0].courses[0].title === 'Renamed synthetic lecture');
    saved = await page.evaluate(() => window.__saved.at(-1));
    assert.deepEqual([...saved.terms[0].meetings.map((m) => m.id)].sort(), [...siblingIds].sort());
    assert.equal(saved.terms[0].courses[0].color, '#B9712C');
    const quizC = saved.terms[0].meetings.find((m) => m.title === 'Synthetic quiz C');
    assert.equal(quizC.color, '#8161B4'); assert.equal(quizC.end, '09:15');
    // Edit and delete exactly the selected event, retaining siblings and weekly meetings.
    await page.locator('#calendar-date').fill('2026-10-22'); await page.locator('#calendar-date').dispatchEvent('change');
    await page.locator('.week-agenda .slot').filter({ hasText: 'Synthetic quiz C' }).click();
    await page.locator('.detail-footer [data-action="edit-course-event"]').click();
    await page.fill('#event-form [name="title"]', 'Synthetic quiz C revised'); await page.fill('#event-form [name="end"]', '09:30');
    await page.click('.header-save'); await page.waitForFunction(() => window.__saved.at(-1)?.terms[0].meetings.some((m) => m.title === 'Synthetic quiz C revised'));
    saved = await page.evaluate(() => window.__saved.at(-1));
    assert.equal(saved.terms[0].meetings.find((m) => m.title === 'Synthetic quiz C revised').id, quizC.id);
    await page.locator('.week-agenda .slot').filter({ hasText: 'Synthetic quiz C revised' }).click();
    await page.click('[data-action="remove-course-event"]'); await page.click('[data-action="confirm-remove-course-event"]');
    await page.waitForFunction((id) => !window.__saved.at(-1).terms[0].meetings.some((m) => m.id === id), quizC.id);
    saved = await page.evaluate(() => window.__saved.at(-1));
    assert.equal(saved.terms[0].meetings.length, 6); assert.ok(saved.terms[0].meetings.some((m) => m.id === 'quiz-a'));
    assert.ok(saved.terms[0].meetings.some((m) => m.id === 'quiz-b')); assert.ok(saved.terms[0].meetings.some((m) => m.id === 'weekly-a'));
    // Empty weekends stay in the following week and date focus survives periodic repaint.
    await page.locator('#calendar-date').fill('2026-11-02'); await page.locator('#calendar-date').dispatchEvent('change');
    assert.equal(await page.locator('.week-head [data-day-date]').count(), 7);
    await page.evaluate(() => { window.__picker = document.querySelector('#calendar-date'); window.__picker.focus(); });
    await page.clock.runFor(61000);
    assert.equal(await page.evaluate(() => document.querySelector('#calendar-date') === window.__picker && document.activeElement === window.__picker), true);
    await page.evaluate(() => window.__picker.blur());
    await page.click('[data-action="menu"]'); await page.click('[data-action="add-holiday"]');
    await page.fill('#holiday-form [name="title"]', 'Synthetic local break');
    await page.fill('#holiday-form [name="start"]', '2026-11-02'); await page.fill('#holiday-form [name="end"]', '2026-11-08');
    await page.click('.header-save'); await page.waitForFunction(() => window.__saved.at(-1).terms[0].holidays.length === 2);
    assert.equal(await page.locator('.day.has-annotation').count(), 7);
    assert.equal(await page.locator('.block').count(), 2, 'background mark never deletes recurring events');
    // Imported standalone event courses may contain several independent meetings.
    // Moving one to a new timezone/calendar or widening its weekly range preserves siblings.
    const migration = await context.newPage(); migration.setDefaultTimeout(8000);
    const migrationData = { source: 'local', terms: [{ id: 'imported-events', name: 'Synthetic imported events', start: '2026-10-01', end: '2026-11-30', timezone: 'America/Toronto', courses: [{ code: 'EVTSET', title: 'Synthetic event collection', type: 'event' }], meetings: [
      { id: 'move-zone', code: 'EVTSET', title: 'Synthetic timezone item', kind: 'EVENT', recurrence: 'once', date: '2026-10-19', start: '09:00', end: '09:15' },
      { id: 'move-range', code: 'EVTSET', title: 'Synthetic range item', kind: 'EVENT', recurrence: 'weekly', day: 2, start: '11:00', end: '12:00' },
      { id: 'keep-sibling', code: 'EVTSET', title: 'Synthetic retained sibling', kind: 'EVENT', recurrence: 'weekly', day: 3, start: '13:00', end: '14:00' }
    ] }] };
    await migration.clock.install({ time: new Date('2026-10-19T13:30:00Z') });
    await migration.addInitScript((data) => { localStorage.setItem('tab', 'term'); window.__saved = []; window.acorn = { platform: 'android', capabilities: { login: false, refresh: false, pin: false }, getState: async () => ({ data, status: { state: 'unsupported' } }), onUpdate() {}, onPinned() {}, saveData: async (next) => { window.__saved.push(JSON.parse(JSON.stringify(next))); return { ok: true }; } }; }, migrationData);
    await migration.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href); await migration.waitForSelector('.week');
    await migration.locator('.block').filter({ hasText: 'Synthetic timezone item' }).click(); await migration.click('[data-action="edit-course"]');
    await migration.locator('.advanced-fields').evaluateAll((rows) => rows.forEach((row) => row.open = true));
    await migration.fill('#event-form [name="timezone"]', 'America/Vancouver'); await migration.click('.header-save');
    await migration.waitForFunction(() => window.__saved.length === 1);
    let migrated = await migration.evaluate(() => window.__saved.at(-1));
    assert.deepEqual(migrated.terms.find((term) => term.id === 'imported-events').meetings.map((m) => m.id), ['move-range', 'keep-sibling']);
    assert.equal(migrated.terms.find((term) => term.id === 'imported-events').courses.length, 1);
    assert.equal(migrated.terms.find((term) => term.meetings.some((m) => m.id === 'move-zone')).timezone, 'America/Vancouver');
    await migration.locator('.block').filter({ hasText: 'Synthetic range item' }).click(); await migration.click('[data-action="edit-course"]');
    await migration.fill('#event-form [name="from"]', '2027-02-02'); await migration.fill('#event-form [name="until"]', '2027-02-16'); await migration.click('.header-save');
    await migration.waitForFunction(() => window.__saved.length === 2); migrated = await migration.evaluate(() => window.__saved.at(-1));
    assert.deepEqual(migrated.terms.find((term) => term.id === 'imported-events').meetings.map((m) => m.id), ['keep-sibling']);
    assert.equal(migrated.terms.find((term) => term.id === 'imported-events').courses.length, 1);
    assert.equal(migrated.terms.flatMap((term) => term.meetings).length, 3);
    assert.equal(migrated.terms.flatMap((term) => term.meetings).filter((m) => m.id === 'move-zone').length, 1);
    assert.equal(migrated.terms.flatMap((term) => term.meetings).find((m) => m.id === 'move-range').from, '2027-02-02');
    await migration.close();
    assert.deepEqual(errors, []);
    console.log('Compact header, seven days, short/overlap geometry, course-event independence, colors and holiday interactions passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
