/* Shared local-only model, calendar and map helpers. No DOM, Electron or network APIs. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CourseTools = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TIMEZONE = 'America/Toronto';
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const DAY_MS = 86400000;
  const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const pad = value => String(value).padStart(2, '0');
  function utf8Length(value) {
    let bytes = 0;
    for (const char of value) {
      const n = char.codePointAt(0);
      bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
    }
    return bytes;
  }
  function validDate(value) {
    if (typeof value !== 'string' || !DATE.test(value) || value < '1900-01-01' || value > '9998-12-31') return false;
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
  }
  function validTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  }
  function validTimezone(value) {
    if (typeof value !== 'string' || value.length > 100 || /[\r\n]/.test(value)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch (_) { return false; }
  }
  function isWaitlisted(value) {
    const status = object(value) ? value.status : value;
    return typeof status === 'string' && /wait[\s_-]*list|waiting|候补|候補/i.test(status);
  }
  function isUnscheduled(value) {
    return value === undefined || value === null || value === '' || (typeof value === 'string' && /^(tba|tbd|arranged|asynchronous|n\/a)$/i.test(value.trim()));
  }
  function validateImport(input) {
    const errors = [], warnings = [];
    let raw;
    try {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      if (typeof text !== 'string' || utf8Length(text) > MAX_IMPORT_BYTES) throw new Error('JSON must be at most 2 MiB.');
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      return { ok: false, data: null, errors: ['Invalid JSON: ' + error.message], warnings };
    }
    const fail = (path, message) => errors.push(path + ': ' + message);
    function str(value, path, fallback, required) {
      if (value === undefined || value === null) {
        if (required) fail(path, 'a nonempty string is required');
        return fallback === undefined ? '' : fallback;
      }
      if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        fail(path, 'must be a string of at most 4000 characters without control characters'); return '';
      }
      if (required && !value.trim()) fail(path, 'must not be empty');
      return value.trim();
    }
    function date(value, path, fallback) {
      if (value === undefined || value === null || value === '') return fallback;
      if (!validDate(value)) { fail(path, 'must be a real YYYY-MM-DD date (1900–9998)'); return fallback; }
      return value;
    }
    function list(value, path, limit, fallback) {
      if (value === undefined && fallback) return [];
      if (!Array.isArray(value)) { fail(path, 'must be an array'); return []; }
      if (value.length > limit) { fail(path, 'has too many entries (maximum ' + limit + ')'); return []; }
      return value;
    }
    function optionalStrings(source, target, fields, path) {
      for (const field of fields) if (source[field] !== undefined && source[field] !== null) target[field] = str(source[field], path + '.' + field);
    }
    if (!object(raw)) return { ok: false, data: null, errors: ['Root must be a JSON object.'], warnings };
    const data = { fetchedAt: null, terms: [], transcript: null };
    if (raw.fetchedAt != null) {
      if (!validTimestamp(raw.fetchedAt)) fail('fetchedAt', 'must be an ISO timestamp with timezone');
      else data.fetchedAt = raw.fetchedAt;
    }
    if (raw.source !== undefined) {
      if (!['local', 'acorn'].includes(raw.source)) fail('source', 'must be local or acorn');
      else data.source = raw.source;
    }
    if (raw.modifiedAt !== undefined) {
      if (!validTimestamp(raw.modifiedAt)) fail('modifiedAt', 'must be an ISO timestamp with timezone');
      else data.modifiedAt = raw.modifiedAt;
    }
    const termIds = new Set();
    list(raw.terms, 'terms', 100).forEach((source, ti) => {
      const p = 'terms[' + ti + ']';
      if (!object(source)) { fail(p, 'must be an object'); return; }
      const term = {
        id: str(source.id, p + '.id', '', true),
        name: str(source.name, p + '.name', '', true),
        start: date(source.start, p + '.start', null),
        end: date(source.end, p + '.end', null),
        timezone: source.timezone == null ? DEFAULT_TIMEZONE : source.timezone,
        courses: [], meetings: []
      };
      if (termIds.has(term.id)) fail(p + '.id', 'duplicate term id');
      termIds.add(term.id);
      if (!term.start || !term.end) fail(p, 'start and end dates are required');
      if (term.start && term.end && (term.start > term.end || Date.parse(term.end) - Date.parse(term.start) > 730 * DAY_MS)) fail(p, 'date range must be ordered and no longer than 730 days');
      if (!validTimezone(term.timezone)) fail(p + '.timezone', 'must be a timezone supported by Intl, e.g. America/Toronto');
      if (source.bounds !== undefined) {
        if (!Array.isArray(source.bounds) || source.bounds.length !== 2 || !source.bounds.every(validDate) || source.bounds[0] > source.bounds[1]) fail(p + '.bounds', 'must be an ordered pair of real YYYY-MM-DD dates');
        else term.bounds = source.bounds.slice();
      }
      const codes = new Set();
      list(source.courses, p + '.courses', 1000).forEach((c, ci) => {
        const cp = p + '.courses[' + ci + ']';
        if (!object(c)) { fail(cp, 'must be an object'); return; }
        const course = { code: str(c.code, cp + '.code', '', true), title: str(c.title, cp + '.title', ''), credits: '' };
        if (codes.has(course.code)) fail(cp + '.code', 'duplicate course code within term');
        codes.add(course.code);
        if (c.credits != null) {
          if (typeof c.credits === 'number' && Number.isFinite(c.credits) && c.credits >= 0) course.credits = c.credits;
          else if (typeof c.credits === 'string') course.credits = str(c.credits, cp + '.credits');
          else fail(cp + '.credits', 'must be a nonnegative number or string');
        }
        optionalStrings(c, course, ['status', 'room', 'address', 'building', 'location', 'delivery'], cp);
        term.courses.push(course);
      });
      const ids = new Set();
      list(source.meetings, p + '.meetings', 3000, true).forEach((m, mi) => {
        const mp = p + '.meetings[' + mi + ']';
        if (!object(m)) { fail(mp, 'must be an object'); return; }
        const meeting = { code: str(m.code, mp + '.code', '', true), title: str(m.title, mp + '.title', ''), section: str(m.section, mp + '.section', ''), kind: str(m.kind, mp + '.kind', ''), day: m.day, start: m.start, end: m.end, location: str(m.location, mp + '.location', ''), from: date(m.from, mp + '.from', term.start), until: date(m.until, mp + '.until', term.end), exdates: [] };
        optionalStrings(m, meeting, ['id', 'room', 'address', 'building', 'delivery', 'status'], mp);
        if (meeting.id) {
          if (ids.has(meeting.id)) fail(mp + '.id', 'duplicate meeting id within term');
          ids.add(meeting.id);
        }
        if (!codes.has(meeting.code)) fail(mp + '.code', 'must match a course in this term');
        meeting.exdates = [...new Set(list(m.exdates, mp + '.exdates', 2000, true).map((d, i) => {
          if (!validDate(d)) { fail(mp + '.exdates[' + i + ']', 'must be a real YYYY-MM-DD date'); return null; }
          return d;
        }))].filter(Boolean).sort();
        if (meeting.from && meeting.until && meeting.from > meeting.until) fail(mp, 'from must be on or before until');
        if (isUnscheduled(m.start) && isUnscheduled(m.end)) {
          warnings.push(mp + ': untimed/TBA meeting omitted; course remains in course list.'); return;
        }
        if (!Number.isInteger(m.day) || m.day < 1 || m.day > 7) fail(mp + '.day', 'must be an integer from 1 (Monday) to 7 (Sunday)');
        if (typeof m.start !== 'string' || !TIME.test(m.start)) fail(mp + '.start', 'must be a 24-hour HH:mm time');
        if (typeof m.end !== 'string' || !TIME.test(m.end)) fail(mp + '.end', 'must be a 24-hour HH:mm time');
        if (TIME.test(m.start) && TIME.test(m.end) && m.end <= m.start) fail(mp, 'end must be later than start on the same day; split overnight meetings');
        if (!meeting.title) meeting.title = term.courses.find(c => c.code === meeting.code)?.title || '';
        term.meetings.push(meeting);
      });
      data.terms.push(term);
    });
    if (raw.transcript != null) {
      if (!object(raw.transcript)) fail('transcript', 'must be null or an object');
      else {
        data.transcript = { sessions: [], cgpa: null };
        if (raw.transcript.cgpa != null) data.transcript.cgpa = str(String(raw.transcript.cgpa), 'transcript.cgpa');
        list(raw.transcript.sessions, 'transcript.sessions', 100).forEach((s, si) => {
          const p = 'transcript.sessions[' + si + ']';
          if (!object(s)) { fail(p, 'must be an object'); return; }
          const session = { name: str(s.name, p + '.name', '', true), courses: [], notes: [] };
          optionalStrings(s, session, ['sessionalGpa', 'annualGpa', 'cumulativeGpa', 'average'], p);
          session.notes = list(s.notes, p + '.notes', 1000, true).map((n, i) => str(n, p + '.notes[' + i + ']'));
          list(s.courses, p + '.courses', 1000).forEach((c, ci) => {
            const cp = p + '.courses[' + ci + ']';
            if (!object(c)) { fail(cp, 'must be an object'); return; }
            const course = { code: str(c.code, cp + '.code', '', true), title: str(c.title, cp + '.title', '') };
            for (const field of ['weight', 'mark', 'grade', 'avg']) course[field] = str(c[field], cp + '.' + field, '');
            session.courses.push(course);
          });
          data.transcript.sessions.push(session);
        });
      }
    }
    return { ok: errors.length === 0, data: errors.length ? null : data, errors, warnings };
  }
  function select(data, options) {
    options = options || {};
    const result = validateImport(data);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const term = options.termId == null && result.data.terms.length === 1 ? result.data.terms[0] : result.data.terms.find(t => t.id === options.termId);
    if (!term) throw new Error('Choose a valid termId.');
    if (options.includeWaitlisted !== undefined && typeof options.includeWaitlisted !== 'boolean') throw new Error('includeWaitlisted must be boolean.');
    let codes;
    if (options.courseCodes !== undefined) {
      if (!Array.isArray(options.courseCodes) || options.courseCodes.some(code => typeof code !== 'string' || !term.courses.some(c => c.code === code))) throw new Error('courseCodes must contain only course codes from the selected term.');
      codes = new Set(options.courseCodes);
    }
    const waitlist = new Set(term.courses.filter(isWaitlisted).map(c => c.code));
    const meetings = term.meetings.filter(m => (!codes || codes.has(m.code)) && (options.includeWaitlisted || (!isWaitlisted(m) && !waitlist.has(m.code))));
    return { data: result.data, term, meetings };
  }
  function getExportableMeetings(data, options) { return select(data, options).meetings; }
  function addDays(date, days) { return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10); }
  function occurrenceDates(term, meeting) {
    const start = [term.start, meeting.from].filter(Boolean).sort().pop();
    const end = [term.end, meeting.until].filter(Boolean).sort()[0];
    if (start > end) return [];
    const weekday = ((new Date(start + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
    const excluded = new Set(meeting.exdates || []), dates = [];
    for (let d = addDays(start, (meeting.day - weekday + 7) % 7); d <= end; d = addDays(d, 7)) if (!excluded.has(d)) dates.push(d);
    return dates;
  }
  function timezoneFormatter(timezone) {
    return new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  function localParts(formatter, timestamp) {
    const parts = {};
    for (const p of formatter.formatToParts(timestamp)) if (p.type !== 'literal') parts[p.type] = +p.value;
    return parts;
  }
  function wallTimestamp(parts) { return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0); }
  function localToUtc(date, time, timezone, formatter) {
    if (!validDate(date) || !TIME.test(time) || !validTimezone(timezone)) throw new Error('Invalid date, time or timezone.');
    formatter = formatter || timezoneFormatter(timezone);
    const wall = Date.parse(date + 'T' + time + ':00Z');
    // Probe both sides of a transition, then verify candidates by round trip.
    // Ambiguous fall-back times choose the earlier instant. Spring gaps fail loudly.
    const offsets = new Set();
    for (const hours of [-36, -12, 0, 12, 36]) {
      const probe = wall + hours * 3600000;
      offsets.add(wallTimestamp(localParts(formatter, probe)) - probe);
    }
    const matches = [...offsets].map(offset => wall - offset).filter(t => wallTimestamp(localParts(formatter, t)) === wall).sort((a, b) => a - b);
    if (!matches.length) throw new Error('Local time does not exist during a timezone transition: ' + date + ' ' + time + ' ' + timezone);
    return new Date(matches[0]);
  }
  function escapeICSText(value) { return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
  function foldICSLine(line) {
    let result = '', current = '', length = 0;
    for (const char of line) {
      const bytes = utf8Length(char);
      if (length + bytes > 75) { result += current + '\r\n'; current = ' '; length = 1; }
      current += char; length += bytes;
    }
    return result + current;
  }
  function hash(value) {
    // Two independent 32-bit FNV streams; stable across Node and browsers.
    let a = 2166136261, b = 3339675911;
    for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function stamp(date) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function exportICS(input, options) {
    options = options || {};
    const { data, term, meetings } = select(input, options);
    const now = options.now == null ? new Date(data.fetchedAt || '2000-01-01T00:00:00Z') : new Date(options.now);
    if (!Number.isFinite(+now)) throw new Error('now must be a valid date.');
    const name = options.calendarName == null ? term.name : options.calendarName;
    if (typeof name !== 'string' || name.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name)) throw new Error('calendarName must be plain text of at most 4000 characters.');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BCorn Widget//Local Timetable//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + escapeICSText(name)];
    const formatter = timezoneFormatter(term.timezone), seen = new Set();
    let count = 0;
    for (const m of meetings) {
      const key = m.id ? JSON.stringify([term.id, m.id]) : JSON.stringify([term.id, m.code, m.section, m.kind, m.day, m.start, m.end, term.timezone]);
      for (const day of occurrenceDates(term, m)) {
        const uid = hash(key) + '-' + day.replace(/-/g, '') + '@bcorn-widget.local';
        if (seen.has(uid)) continue;
        seen.add(uid);
        if (++count > 25000) throw new Error('Calendar contains more than 25,000 occurrences. Export fewer courses.');
        const start = localToUtc(day, m.start, term.timezone, formatter), end = localToUtc(day, m.end, term.timezone, formatter);
        if (end <= start) throw new Error('Meeting ends before its start after timezone conversion.');
        const waitlisted = isWaitlisted(m) || term.courses.some(c => c.code === m.code && isWaitlisted(c));
        const summary = [m.code, m.section, m.title].filter(Boolean).join(' · ');
        const location = [...new Set([m.location, m.room, m.address].filter(Boolean))].join(', ');
        const description = [m.title, m.kind, 'Timezone: ' + term.timezone, waitlisted ? 'Waitlisted: enrollment is not confirmed.' : ''].filter(Boolean).join('\n');
        lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(now), 'DTSTART:' + stamp(start), 'DTEND:' + stamp(end), 'SUMMARY:' + escapeICSText(summary), 'DESCRIPTION:' + escapeICSText(description));
        if (location) lines.push('LOCATION:' + escapeICSText(location));
        lines.push('STATUS:' + (waitlisted ? 'TENTATIVE' : 'CONFIRMED'), 'TRANSP:' + (waitlisted ? 'TRANSPARENT' : 'OPAQUE'), 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldICSLine).join('\r\n') + '\r\n';
  }
  function buildMapUrl(meeting, options) {
    options = options || {};
    if (!['google', 'amap'].includes(options.provider)) throw new Error('Map provider must be google or amap.');
    if (!object(meeting)) return null;
    const fields = ['address', 'building', 'location'];
    const place = fields.map(k => meeting[k]).find(v => typeof v === 'string' && v.trim() && !/^(tba|tbd|online|remote|virtual|zoom|n\/a)$/i.test(v.trim()));
    if (!place) return null;
    if (place.length > 2000 || /[\u0000-\u001f\u007f]/.test(place)) throw new Error('Map location must be plain text of at most 2000 characters.');
    // A remote meeting URL is not a physical address and must never be opened as-is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(place.trim())) return null;
    const query = encodeURIComponent(place.trim());
    return options.provider === 'google' ? 'https://www.google.com/maps/search/?api=1&query=' + query : 'https://uri.amap.com/search?keyword=' + query + '&src=bcorn-widget&callnative=0';
  }
  return Object.freeze({ DEFAULT_TIMEZONE, MAX_IMPORT_BYTES, validateImport, isWaitlisted, getExportableMeetings, occurrenceDates, localToUtc, exportICS, buildMapUrl, escapeICSText, foldICSLine });
}));
