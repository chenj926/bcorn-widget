'use strict';
// Synthetic records only: no real student, account, transcript or timetable data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tools = require('../src/shared/course-tools');
const fixture = () => ({
  fetchedAt: '2026-09-01T12:00:00Z',
  terms: [{ id: '20269', name: 'Synthetic Fall', start: '2026-09-08', end: '2026-12-15', courses: [{ code: 'SYN101', title: 'Synthetic Systems', credits: 0.5 }, { code: 'TBA200', title: 'Unscheduled Study', credits: '0.5' }, { code: 'WAIT300', title: 'Waitlisted Study', credits: 0.5, status: 'waitlisted' }], meetings: [
    { code: 'SYN101', title: 'Synthetic Systems', section: 'LEC0101', kind: 'LEC', day: 1, start: '09:00', end: '10:00', location: 'Example Hall', room: '101', address: '100 Example Street, Toronto', from: '2026-09-08', until: '2026-12-15', exdates: ['2026-10-12'] },
    { code: 'WAIT300', title: 'Waitlisted Study', section: 'LEC0101', kind: 'LEC', day: 2, start: '11:00', end: '12:00', location: '', from: '2026-09-08', until: '2026-12-15', exdates: [] }
  ] }], transcript: null
});
const unfolded = ics => ics.replace(/\r\n[ \t]/g, '');
const events = ics => unfolded(ics).split('BEGIN:VEVENT\r\n').slice(1).map(s => s.split('END:VEVENT')[0]);
const properties = (ics, key) => [...unfolded(ics).matchAll(new RegExp('^' + key + ':(.*)$', 'gm'))].map(m => m[1].replace(/\r$/, ''));

test('UMD exports identical API in browser without Node globals', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(fs.readFileSync(require.resolve('../src/shared/course-tools'), 'utf8'), context);
  assert.equal(typeof context.CourseTools.validateImport, 'function');
  assert.equal(context.CourseTools.DEFAULT_TIMEZONE, 'America/Toronto');
  assert.ok(context.CourseTools.validateImport(JSON.stringify(fixture())).ok);
});
test('validates original schema with default timezone and no input mutation', () => {
  const input = fixture(), before = JSON.stringify(input), result = tools.validateImport(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.terms[0].timezone, 'America/Toronto');
  assert.equal(result.data.terms[0].courses[0].credits, 0.5);
  assert.equal(result.data.terms[0].meetings[0].room, '101');
  assert.equal(result.data.terms[0].meetings[0].address, '100 Example Street, Toronto');
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result.data, input);
});
test('accepts UTF-8 BOM, empty terms and missing optional root fields', () => {
  assert.ok(tools.validateImport('\uFEFF' + JSON.stringify(fixture())).ok);
  assert.deepEqual(tools.validateImport({ terms: [] }).data, { fetchedAt: null, terms: [], transcript: null });
});
test('rejects invalid JSON, primitive roots, circular objects and excessive size', () => {
  for (const input of ['{', 'null', '[]', '42', undefined, { terms: [], huge: 'x'.repeat(tools.MAX_IMPORT_BYTES) }]) assert.equal(tools.validateImport(input).ok, false);
  const circular = {}; circular.self = circular;
  assert.equal(tools.validateImport(circular).ok, false);
  // Limit uses UTF-8 bytes, not JS UTF-16 code-unit length.
  assert.equal(tools.validateImport({ terms: [], huge: '课'.repeat(800000) }).ok, false);
});
test('drops unexpected/prototype keys without prototype pollution', () => {
  const input = JSON.parse(JSON.stringify(fixture()));
  input.terms[0].extra = { secret: 'discard' };
  const raw = JSON.stringify(input).replace('"terms":', '"__proto__":{"polluted":true},"terms":');
  const result = tools.validateImport(raw);
  assert.ok(result.ok);
  assert.equal(result.data.terms[0].extra, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(result.data, '__proto__'), false);
});
test('preserves TBA courses and drops only wholly untimed meetings with warning', () => {
  const input = fixture();
  input.terms[0].meetings.push({ code: 'TBA200', start: 'TBA', end: null });
  const result = tools.validateImport(input);
  assert.ok(result.ok);
  assert.equal(result.data.terms[0].courses.length, 3);
  assert.equal(result.data.terms[0].meetings.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.equal(events(tools.exportICS(input, { courseCodes: ['TBA200'] })).length, 0);
});
test('missing meetings array is valid for unscheduled courses', () => {
  const input = fixture(); delete input.terms[0].meetings;
  const result = tools.validateImport(input);
  assert.ok(result.ok);
  assert.deepEqual(result.data.terms[0].meetings, []);
});
test('validates term and course identity and container shapes', () => {
  const mutations = [
    d => { d.terms = {}; }, d => { d.terms[0] = null; },
    d => { d.terms[0].courses = {}; }, d => { d.terms[0].courses[0] = null; },
    d => { d.terms[0].meetings = {}; }, d => { d.terms[0].meetings[0] = null; },
    d => { d.terms[0].id = ''; }, d => { d.terms[0].name = 42; },
    d => { d.terms.push(structuredClone(d.terms[0])); },
    d => { d.terms[0].courses.push(structuredClone(d.terms[0].courses[0])); },
    d => { d.terms[0].meetings[0].code = 'MISSING'; },
    d => { d.terms[0].courses[0].credits = -1; },
    d => { d.terms[0].courses[0].status = {}; },
    d => { d.terms[0].courses[0].title = 'bad\u0000text'; },
    d => { d.terms[0].meetings[0].id = 'same'; d.terms[0].meetings[1].id = 'same'; }
  ];
  for (const mutate of mutations) { const d = fixture(); mutate(d); const r = tools.validateImport(d); assert.equal(r.ok, false, mutate.toString()); assert.equal(r.data, null); assert.ok(r.errors.length); }
});
test('validates real dates, ordering and bounded expansion range', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '26-09-01', '2026-9-01', '2026-09-01T00:00:00Z', '1899-01-01']) {
    const d = fixture(); d.terms[0].start = date; assert.equal(tools.validateImport(d).ok, false, date);
  }
  const leap = fixture(); leap.terms[0].start = '2024-02-29'; leap.terms[0].end = '2024-03-01'; assert.ok(tools.validateImport(leap).ok);
  for (const change of [d => delete d.terms[0].end, d => { d.terms[0].end = '2026-01-01'; }, d => { d.terms[0].end = '2030-01-01'; }, d => { d.terms[0].meetings[0].until = '2020-01-01'; }]) {
    const d = fixture(); change(d); assert.equal(tools.validateImport(d).ok, false);
  }
});
test('validates timezone and timestamp, permits explicit UTC', () => {
  for (const timezone of ['Invalid/Zone', '', 123, 'America/Toronto\nX:bad']) { const d = fixture(); d.terms[0].timezone = timezone; assert.equal(tools.validateImport(d).ok, false); }
  const d = fixture(); d.terms[0].timezone = 'UTC'; assert.ok(tools.validateImport(d).ok);
  for (const timestamp of ['now', '2026-09-01', '2026-09-01T12:00:00', '2026-02-30T12:00:00Z', '2026-09-01T99:00:00Z']) { const d = fixture(); d.fetchedAt = timestamp; assert.equal(tools.validateImport(d).ok, false, timestamp); }
});
test('rejects bad weekdays, partial TBA, invalid and overnight clock times', () => {
  for (const day of [0, 8, 1.5, '1', null]) { const d = fixture(); d.terms[0].meetings[0].day = day; assert.equal(tools.validateImport(d).ok, false); }
  for (const [start, end] of [['24:00', '25:00'], ['9:00', '10:00'], ['09:60', '11:00'], ['09:00:00', '10:00'], ['09:00', 'TBA'], ['TBA', '10:00'], ['10:00', '10:00'], ['23:00', '01:00']]) {
    const d = fixture(); Object.assign(d.terms[0].meetings[0], { start, end }); assert.equal(tools.validateImport(d).ok, false, start + '/' + end);
  }
});
test('fills missing meeting date range and title from term/course', () => {
  const d = fixture(), m = d.terms[0].meetings[0]; delete m.from; delete m.until; delete m.title; delete m.exdates;
  const result = tools.validateImport(d).data.terms[0].meetings[0];
  assert.equal(result.from, d.terms[0].start); assert.equal(result.until, d.terms[0].end);
  assert.equal(result.title, 'Synthetic Systems'); assert.deepEqual(result.exdates, []);
});
test('validates and deduplicates exclusion dates', () => {
  const d = fixture(); d.terms[0].meetings[0].exdates = ['2026-10-12', '2026-10-12', '2026-09-14'];
  assert.deepEqual(tools.validateImport(d).data.terms[0].meetings[0].exdates, ['2026-09-14', '2026-10-12']);
  d.terms[0].meetings[0].exdates = ['bad']; assert.equal(tools.validateImport(d).ok, false);
  d.terms[0].meetings[0].exdates = '2026-10-12'; assert.equal(tools.validateImport(d).ok, false);
});
test('keeps validated transcript schema intact without requiring it', () => {
  const d = fixture(); d.transcript = { cgpa: '3.70', sessions: [{ name: 'Synthetic Previous Term', sessionalGpa: '3.70', annualGpa: '3.70', cumulativeGpa: '3.70', average: '85', notes: ['Synthetic note'], courses: [{ code: 'SYN001', title: 'Past Synthetic Course', weight: '0.50', mark: '85', grade: 'A', avg: 'B' }] }] };
  assert.deepEqual(tools.validateImport(d).data.transcript, d.transcript);
  d.transcript.sessions[0].courses[0].mark = {}; assert.equal(tools.validateImport(d).ok, false);
});
test('waitlist variants recognized without treating enrolled as waiting', () => {
  for (const status of ['Waitlisted', 'WAITLIST', 'wait-listed', 'Wait List', 'waiting', '候补', '候補']) { assert.ok(tools.isWaitlisted(status)); assert.ok(tools.isWaitlisted({ status })); }
  for (const status of ['enrolled', 'registered', '', null, undefined]) assert.equal(tools.isWaitlisted(status), false);
});
test('selection filters courses and excludes course- or meeting-level waitlist by default', () => {
  const d = fixture(); assert.equal(tools.getExportableMeetings(d).length, 1);
  assert.equal(tools.getExportableMeetings(d, { includeWaitlisted: true }).length, 2);
  assert.equal(tools.getExportableMeetings(d, { courseCodes: [] }).length, 0);
  assert.equal(tools.getExportableMeetings(d, { courseCodes: ['TBA200'] }).length, 0);
  d.terms[0].meetings[0].status = 'waitlisted'; assert.equal(tools.getExportableMeetings(d).length, 0);
  assert.equal(tools.getExportableMeetings(d, { courseCodes: ['SYN101'], includeWaitlisted: true }).length, 1);
});
test('selection rejects stale/unknown term, unknown courses and malformed options', () => {
  for (const options of [{ termId: 'missing' }, { courseCodes: ['missing'] }, { courseCodes: 'SYN101' }, { includeWaitlisted: 'false' }]) assert.throws(() => tools.exportICS(fixture(), options));
  const d = fixture(); d.terms.push({ ...structuredClone(d.terms[0]), id: 'other' });
  assert.throws(() => tools.exportICS(d), /termId/);
  assert.ok(tools.exportICS(d, { termId: 'other' }).includes('BEGIN:VCALENDAR'));
});
test('weekly date expansion starts at actual weekday, respects inclusive term and meeting bounds and exclusions', () => {
  const term = fixture().terms[0], meeting = term.meetings[0];
  const dates = tools.occurrenceDates(term, meeting);
  assert.equal(dates[0], '2026-09-14'); // Term begins Tuesday, this meeting is Monday.
  assert.equal(dates.at(-1), '2026-12-14');
  assert.equal(dates.length, 13);
  assert.ok(!dates.includes('2026-10-12'));
  assert.deepEqual(tools.occurrenceDates(term, { ...meeting, from: '2026-10-01', until: '2026-10-26' }), ['2026-10-05', '2026-10-19', '2026-10-26']);
  assert.deepEqual(tools.occurrenceDates(term, { ...meeting, from: '2027-01-01', until: '2027-02-01' }), []);
  assert.deepEqual(tools.occurrenceDates(term, { ...meeting, from: '2026-09-14', until: '2026-09-14' }), ['2026-09-14']);
});
test('all weekdays use ISO Monday=1 to Sunday=7 independent of host timezone', () => {
  const term = { start: '2026-09-07', end: '2026-09-13' };
  for (let day = 1; day <= 7; day++) assert.deepEqual(tools.occurrenceDates(term, { day, exdates: [] }), ['2026-09-' + String(day + 6).padStart(2, '0')]);
});
test('Toronto DST autumn and spring conversion is correct', () => {
  assert.equal(tools.localToUtc('2026-10-26', '09:00', 'America/Toronto').toISOString(), '2026-10-26T13:00:00.000Z');
  assert.equal(tools.localToUtc('2026-11-02', '09:00', 'America/Toronto').toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(tools.localToUtc('2026-03-02', '09:00', 'America/Toronto').toISOString(), '2026-03-02T14:00:00.000Z');
  assert.equal(tools.localToUtc('2026-03-09', '09:00', 'America/Toronto').toISOString(), '2026-03-09T13:00:00.000Z');
});
test('UTC, half-hour, quarter-hour and southern DST zones', () => {
  for (const [zone, date, time, expected] of [
    ['UTC', '2026-09-01', '00:00', '2026-09-01T00:00:00.000Z'],
    ['Asia/Kolkata', '2026-09-01', '09:00', '2026-09-01T03:30:00.000Z'],
    ['Asia/Kathmandu', '2026-09-01', '09:00', '2026-09-01T03:15:00.000Z'],
    ['Australia/Sydney', '2026-10-05', '09:00', '2026-10-04T22:00:00.000Z'],
    ['Australia/Sydney', '2026-09-28', '09:00', '2026-09-27T23:00:00.000Z']
  ]) assert.equal(tools.localToUtc(date, time, zone).toISOString(), expected);
});
test('DST gap rejected, ambiguous fall-back chooses earlier instant', () => {
  assert.throws(() => tools.localToUtc('2026-03-08', '02:30', 'America/Toronto'), /does not exist/);
  assert.equal(tools.localToUtc('2026-11-01', '01:30', 'America/Toronto').toISOString(), '2026-11-01T05:30:00.000Z');
  assert.throws(() => tools.localToUtc('invalid', '09:00', 'UTC'));
});
test('ICS output is CRLF framed and finite expanded UTC events preserve DST, boundaries and holidays', () => {
  const ics = tools.exportICS(fixture());
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(events(ics).length, 13);
  assert.ok(properties(ics, 'DTSTART').includes('20261026T130000Z'));
  assert.ok(properties(ics, 'DTSTART').includes('20261102T140000Z'));
  assert.equal(properties(ics, 'DTSTART')[0], '20260914T130000Z');
  assert.ok(!ics.includes('20261012T'));
  assert.equal(properties(ics, 'DTEND').at(-1), '20261214T150000Z');
  assert.ok(!ics.includes('RRULE:')); // UTC expansion, not an incorrect fixed-offset recurring event.
  assert.equal(properties(ics, 'STATUS').every(status => status === 'CONFIRMED'), true);
});
test('ICS excludes waitlist and TBA unless waitlist explicitly selected; tentative events marked', () => {
  const ics = tools.exportICS(fixture(), { includeWaitlisted: true, courseCodes: ['WAIT300'] });
  assert.equal(events(ics).length, 15);
  assert.equal(properties(ics, 'STATUS').every(status => status === 'TENTATIVE'), true);
  assert.equal(properties(ics, 'TRANSP').every(status => status === 'TRANSPARENT'), true);
  assert.ok(unfolded(ics).includes('Waitlisted: enrollment is not confirmed.'));
  assert.equal(events(tools.exportICS(fixture(), { courseCodes: [] })).length, 0);
});
test('UIDs are stable across repeated export, now changes, metadata edits and array reorder', () => {
  const d = fixture(); const original = tools.exportICS(d), originalIds = properties(original, 'UID');
  assert.equal(tools.exportICS(d), original);
  d.terms[0].meetings.reverse(); d.terms[0].courses.reverse(); d.terms[0].meetings[1].title = 'Renamed'; d.terms[0].meetings[1].location = 'New Room';
  assert.deepEqual(properties(tools.exportICS(d, { now: '2026-10-17T12:00:00Z' }), 'UID'), originalIds);
  assert.equal(new Set(originalIds).size, 13);
  assert.throws(() => tools.exportICS(d, { now: 'invalid' }), /now/);
});
test('explicit meeting IDs keep identity even when clock time changes', () => {
  const d = fixture(); d.terms[0].meetings[0].id = 'synthetic-stable-id';
  const ids = properties(tools.exportICS(d), 'UID');
  d.terms[0].meetings[0].start = '08:00';
  assert.deepEqual(properties(tools.exportICS(d), 'UID'), ids);
});
test('duplicate source meetings do not duplicate calendar instances', () => {
  const d = fixture(); d.terms[0].meetings.push(structuredClone(d.terms[0].meetings[0]));
  assert.equal(events(tools.exportICS(d)).length, 13);
});
test('ICS escaping prevents property injection and preserves punctuation, Unicode and locations', () => {
  const d = fixture(); const m = d.terms[0].meetings[0];
  m.title = 'Lab, text; slash\\next\nBEGIN:VALARM\r\nTRIGGER:bad';
  m.location = 'Building, A'; m.room = 'Room; 101'; m.address = 'Street\\Lane';
  const ics = tools.exportICS(d, { calendarName: 'Term\nX-EVIL:value' }), flat = unfolded(ics);
  assert.ok(flat.includes('SUMMARY:SYN101 · LEC0101 · Lab\\, text\\; slash\\\\next\\nBEGIN:VALARM\\nTRIGGER:bad\r\n'));
  assert.ok(flat.includes('LOCATION:Building\\, A\\, Room\\; 101\\, Street\\\\Lane'));
  assert.ok(!flat.includes('\r\nBEGIN:VALARM'));
  assert.ok(!flat.includes('\r\nX-EVIL:'));
});
test('UTF-8 folding never exceeds 75 octets or splits Unicode code points', () => {
  const long = 'SUMMARY:' + '课程📚é𐍈'.repeat(100);
  const folded = tools.foldICSLine(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long);
  assert.ok(!folded.includes('\uFFFD'));
  const d = fixture(); d.terms[0].meetings[0].title = '课程📚'.repeat(100);
  for (const line of tools.exportICS(d).split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
});
test('map links use fixed HTTPS origins and URL-encoded address preference', () => {
  const m = fixture().terms[0].meetings[0];
  const google = new URL(tools.buildMapUrl(m, { provider: 'google' }));
  assert.equal(google.origin, 'https://www.google.com');
  assert.equal(google.searchParams.get('api'), '1');
  assert.equal(google.searchParams.get('query'), m.address);
  const amap = new URL(tools.buildMapUrl(m, { provider: 'amap' }));
  assert.equal(amap.origin, 'https://uri.amap.com');
  assert.equal(amap.searchParams.get('keyword'), m.address);
  assert.equal(amap.searchParams.get('callnative'), '0');
  const hostile = 'A&B #x?z=1 / 课程';
  assert.equal(new URL(tools.buildMapUrl({ location: hostile }, { provider: 'google' })).searchParams.get('query'), hostile);
});
test('map links reject provider injection and skip missing, remote or unsafe location', () => {
  for (const provider of ['javascript:alert(1)', 'Google', '', undefined]) assert.throws(() => tools.buildMapUrl({ location: 'Hall' }, { provider }), /provider/);
  for (const location of ['', 'TBA', 'Online', 'Zoom', 'https://example.test/room', 'javascript:alert(1)']) assert.equal(tools.buildMapUrl({ location }, { provider: 'google' }), null);
  assert.equal(tools.buildMapUrl({ room: '101' }, { provider: 'google' }), null);
  assert.equal(tools.buildMapUrl(null, { provider: 'amap' }), null);
  assert.throws(() => tools.buildMapUrl({ location: 'Hall\nInjected' }, { provider: 'google' }), /plain text/);
  assert.equal(new URL(tools.buildMapUrl({ building: 'Example Hall', location: 'Room 101' }, { provider: 'google' })).searchParams.get('query'), 'Example Hall');
});

test('preserves known delivery/building/course location extensions and optional bounds', () => {
  const d = fixture(), t = d.terms[0];
  t.bounds = ['2026-09-01', '2026-12-31'];
  t.meetings[0].delivery = 'In person'; t.meetings[0].building = 'Example Hall';
  Object.assign(t.courses[0], { delivery: 'Hybrid', room: '101', address: 'Example Address', building: 'Example Hall', location: 'Campus' });
  const r = tools.validateImport(d); assert.ok(r.ok);
  assert.deepEqual(r.data.terms[0].bounds, t.bounds);
  assert.deepEqual(r.data.terms[0].courses[0], t.courses[0]);
  assert.equal(r.data.terms[0].meetings[0].delivery, 'In person');
  assert.equal(r.data.terms[0].meetings[0].building, 'Example Hall');
  t.bounds = ['bad', '2026-12-31']; assert.equal(tools.validateImport(d).ok, false);
});
test('rejects missing/null exclusion dates instead of silently dropping them', () => {
  for (const value of [null, '', false, 123]) {
    const d = fixture(); d.terms[0].meetings[0].exdates = [value];
    assert.equal(tools.validateImport(d).ok, false);
  }
});

test('preserves optional provenance and validates modification timestamps', () => {
  for (const source of ['local', 'acorn']) {
    const d = fixture(); Object.assign(d, { source, modifiedAt: '2026-10-17T08:20:00+02:00' });
    const result = tools.validateImport(d); assert.ok(result.ok);
    assert.equal(result.data.source, source); assert.equal(result.data.modifiedAt, d.modifiedAt);
  }
  for (const change of [{ source: 'other' }, { source: null }, { modifiedAt: 'yesterday' }, { modifiedAt: null }, { modifiedAt: '2026-10-17T24:00:00Z' }]) {
    assert.equal(tools.validateImport(Object.assign(fixture(), change)).ok, false);
  }
});

test('validation enforces collection limits before traversing oversized arrays', () => {
  const cases = [
    d => { d.terms = Array(101).fill(d.terms[0]); },
    d => { d.terms[0].courses = Array(1001).fill(d.terms[0].courses[0]); },
    d => { d.terms[0].meetings = Array(3001).fill({}); },
    d => { d.terms[0].meetings[0].exdates = Array(2001).fill('2026-10-12'); }
  ];
  for (const change of cases) { const d = fixture(); change(d); const r = tools.validateImport(d); assert.equal(r.ok, false); assert.ok(r.errors.some(e => /maximum/.test(e))); }
});
test('an excluded first occurrence starts export on the next actual meeting date', () => {
  const d = fixture(); d.terms[0].meetings[0].exdates.push('2026-09-14');
  assert.equal(properties(tools.exportICS(d), 'DTSTART')[0], '20260921T130000Z');
});
test('a one-date term outside the meeting weekday yields no calendar event', () => {
  const d = fixture(); Object.assign(d.terms[0], { start: '2026-09-08', end: '2026-09-08' });
  assert.equal(events(tools.exportICS(d)).length, 0);
});
test('calendar content excludes root provenance and transcript data', () => {
  const d = fixture(); d.source = 'local'; d.modifiedAt = '2026-10-17T12:00:00Z';
  d.transcript = { cgpa: 'PRIVATE_GRADE_SENTINEL', sessions: [] };
  const ics = tools.exportICS(d);
  assert.ok(!ics.includes('PRIVATE_GRADE_SENTINEL'));
  assert.ok(!ics.includes('modifiedAt'));
  assert.ok(!ics.includes('20261017T120000'));
});
test('export throws for a meeting in a spring-forward gap rather than silently moving it', () => {
  const d = fixture(), t = d.terms[0]; Object.assign(t, { start: '2026-03-08', end: '2026-03-08' });
  Object.assign(t.meetings[0], { day: 7, from: '2026-03-08', until: '2026-03-08', start: '02:15', end: '03:15' });
  assert.throws(() => tools.exportICS(d), /does not exist/);
});
