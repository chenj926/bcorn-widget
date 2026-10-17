# Local timetable JSON and calendar export

BCorn can use a local JSON timetable without an ACORN account. The shared helper is dependency-free and does not make network requests. Import only files you trust: local timetables and transcripts can contain private information.

## Minimal example

All records below are fictional. Save as UTF-8 JSON (a UTF-8 BOM is accepted).

```json
{
  "fetchedAt": "2026-09-01T12:00:00Z",
  "terms": [
    {
      "id": "20269",
      "name": "2026 Fall",
      "start": "2026-09-08",
      "end": "2026-12-15",
      "timezone": "America/Toronto",
      "courses": [
        { "code": "SYN101", "title": "Synthetic Systems", "credits": 0.5 },
        { "code": "TBA200", "title": "Independent Study", "credits": 0.5 },
        { "code": "WAIT300", "title": "Waitlisted Seminar", "credits": 0.5, "status": "waitlisted" }
      ],
      "meetings": [
        {
          "id": "syn101-lecture-monday",
          "code": "SYN101",
          "title": "Synthetic Systems",
          "section": "LEC0101",
          "kind": "LEC",
          "day": 1,
          "start": "09:00",
          "end": "10:00",
          "location": "Example Hall",
          "room": "101",
          "address": "100 Example Street, Toronto",
          "from": "2026-09-08",
          "until": "2026-12-15",
          "exdates": ["2026-10-12"]
        }
      ]
    }
  ],
  "transcript": null
}
```

`TBA200` has no timed meetings and remains in the course list. A waitlisted course may also have proposed timed meetings; its course-level status excludes all its meetings from calendar export unless explicitly included.

## Fields and validation

- Root `terms` is required and must be an array. An empty array is valid.
- `fetchedAt` is optional/null or an ISO timestamp with an explicit `Z` or numeric UTC offset. It describes when the source data was fetched, not the import time.
- Optional root `source` is `local` or `acorn`; optional `modifiedAt` is an ISO timestamp with an explicit timezone. These provenance fields distinguish manually imported/edited data from fetched data and are preserved through validation.
- A term requires a unique nonempty string `id`, nonempty string `name`, real `start` and `end` dates, and a `courses` array. IDs are strings, including numeric-looking IDs.
- Dates use exactly `YYYY-MM-DD`, from year 1900 through 9998. Term start/end are inclusive, ordered, and at most 730 days apart.
- `timezone` is optional and defaults to `America/Toronto`. Supply an IANA timezone supported by the runtime, such as `Asia/Shanghai`, or `UTC`. Do not supply a fixed offset for a location with daylight saving time.
- Course `code` must be a unique nonempty string within its term. `title` is optional text. `credits` is an optional nonnegative number or display string; it defaults to an empty string. Optional `status` is text, e.g. `enrolled` or `waitlisted`. Optional course `room`, `address`, `building`, `location` and `delivery` text is preserved.
- `meetings` is optional and defaults to an empty array. Each timed meeting must reference a course in the same term through `code`.
- Meeting `id` is optional; when supplied it must be unique within the term. Use a stable ID to maintain calendar event identity across time changes.
- `day` is an integer from 1 (Monday) to 7 (Sunday).
- Timed `start`/`end` must be exact 24-hour `HH:mm` strings. End must be later than start on the same date. Overnight classes must be split into separate meetings on their respective days.
- A course whose time is unknown needs no meeting. An entirely untimed meeting with both times absent, null, empty, or `TBA`/`TBD`/`arranged`/`asynchronous`/`N/A` is removed with a warning. Its course stays. A partially timed meeting is rejected rather than guessed.
- `from`/`until` are optional inclusive real dates; missing values default to term boundaries. A meeting may span several terms, but export clips it to the selected term. `from` must not be later than `until`.
- `exdates` is an optional array of real local dates on which this meeting does not happen. Duplicate dates are deduplicated. Dates outside the selected term are harmless.
- Optional `title`, `section`, `kind`, `location`, `room`, `address`, `building`, `delivery`, and `status` are plain text. Missing meeting title falls back to the matching course title. `room` and `address` remain separate fields.
- Waitlist status detection is case-insensitive and recognizes `waitlisted`, `waitlist`, `wait list`, `wait-listed`, `waiting`, `候补`, and `候補` as well as longer strings containing these words.
- Optional term `bounds` is preserved when supplied as an ordered pair of real dates; `start`/`end` remain the authoritative export boundaries.
- Unknown fields are discarded. Text is trimmed, limited to 4,000 characters, and cannot contain unsafe ASCII control characters. Newlines and tabs in display text are permitted and escaped during calendar generation.
- Imports are limited to 2 MiB of UTF-8 JSON, 100 terms, 1,000 courses and 3,000 meetings per term, and 2,000 exclusion dates per meeting. A failed import returns no partial data.

### Optional transcript

The existing renderer schema is supported; transcripts are never included in exported calendars or map links.

```json
{
  "cgpa": "3.70",
  "sessions": [
    {
      "name": "Synthetic Previous Term",
      "sessionalGpa": "3.70",
      "annualGpa": "3.70",
      "cumulativeGpa": "3.70",
      "average": "85",
      "notes": ["Synthetic note"],
      "courses": [
        { "code": "SYN001", "title": "Past Synthetic Course", "weight": "0.50", "mark": "85", "grade": "A", "avg": "B" }
      ]
    }
  ]
}
```

`transcript` may be omitted or null. When present it requires a `sessions` array. Each session requires `name` and `courses`; `notes` defaults to an empty array. GPA/average and transcript course display values are strings. `cgpa` may be null. Missing course display fields default to empty strings.

## Shared JavaScript API

Browser: load `src/shared/course-tools.js` before the app; access `window.CourseTools`. Node/Electron: `require('./src/shared/course-tools')`. No DOM, filesystem, network, or Electron dependency is used.

```js
const result = CourseTools.validateImport(jsonTextOrObject);
// { ok: boolean, data: normalizedObjectOrNull, errors: string[], warnings: string[] }

const options = {
  termId: '20269',
  courseCodes: ['SYN101'],
  includeWaitlisted: false
};
const meetings = CourseTools.getExportableMeetings(result.data, options);
const ics = CourseTools.exportICS(result.data, options);
const url = CourseTools.buildMapUrl(meeting, { provider: 'google' });
```

- `termId` can be omitted only when exactly one term exists.
- Omit `courseCodes` to select every course in that term. `[]` deliberately selects none. Unknown course codes throw, preventing stale UI selections from silently exporting the wrong content.
- `includeWaitlisted` defaults to false and must be boolean. Either course-level or meeting-level waitlist status excludes a meeting. Explicitly included waitlist events are tentative and free/transparent, with a warning in their description.
- `getExportableMeetings` returns normalized, selected timed meeting records. It does not expand dates: meetings whose dates lie outside the selected term, or whose every occurrence is excluded, may still be returned. Use `occurrenceDates(term, meeting)` to count actual exported dates.
- `exportICS` returns a string or throws an `Error` on invalid input/options/time conversion. No download or external communication happens inside this helper. Empty selection returns a valid empty calendar.
- Optional export `calendarName` sets the display title; default is the term name. Optional `now` sets `DTSTAMP`; without it the data's `fetchedAt` is used, or `2000-01-01T00:00:00Z` when absent. This makes repeated exports deterministic; callers may supply the export timestamp explicitly.
- Other exports: `DEFAULT_TIMEZONE`, `MAX_IMPORT_BYTES`, `isWaitlisted(stringOrRecord)`, `occurrenceDates(term, meeting)`, `localToUtc(date, time, timezone)`, `escapeICSText(text)`, and `foldICSLine(line)`.

## Calendar behavior and limits

The file uses RFC 5545 iCalendar with CRLF endings, escaped TEXT values, and lines folded at no more than 75 UTF-8 octets without splitting Unicode characters. Calendar text cannot inject new properties or alarms. Each selected weekly occurrence becomes an independent UTC `VEVENT`, so the file does not rely on a receiving calendar understanding a timezone label or an incomplete `VTIMEZONE` definition.

- The first date is the actual meeting weekday on or after the later of term start and meeting start. A Tuesday term start never produces a Monday lecture on Tuesday.
- End boundaries are inclusive. Exclusion dates are omitted entirely; no event is emitted for a holiday/reading-week date.
- Each occurrence is converted in the term's timezone using `Intl`. Toronto 09:00 becomes 13:00 UTC during daylight time and 14:00 UTC during standard time. The calendar app displays those instants in the user's chosen calendar timezone.
- Fall-back ambiguous times choose the earlier instant. Nonexistent spring-forward times throw an explanatory error instead of silently changing the timetable.
- Export is capped at 25,000 occurrences. There are no external dependencies or network lookup requests. Correct timezone conversion depends on the runtime's installed IANA timezone database.
- UIDs are deterministic per term, meeting identity and occurrence date. A supplied meeting ID preserves identity when times or descriptions change. Without an ID, identity includes course, section, kind, weekday, start, end and timezone; changing a time may therefore create a new UID. Repeated duplicate source records without IDs are deduplicated.
- This is a one-time snapshot, not a calendar subscription. Import/update/deduplication behavior depends on the receiving calendar. Re-importing may create duplicates in some clients, and removing a class in BCorn does not delete a previously imported event. Consider importing into a dedicated calendar that can be replaced.
- Independent expanded events deliberately have no `RRULE`, `EXDATE`, or `VTIMEZONE` properties: recurrence and exclusions have already been resolved. Calendar exports do not contain transcript grades, login details, alarms, attendees, or external resources.

Format reference: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), especially sections 3.1, 3.3.5, 3.3.11 and 3.6.1.

## External maps

`buildMapUrl(meeting, {provider})` only allows `google` or `amap`; other choices throw. It returns a fixed HTTPS search URL, never an arbitrary imported URL. The search query prefers `address`, then `building`, then `location`. A room number alone is insufficient. Blank/TBA/online/remote locations and URL-like locations produce null; malformed control characters and excessive location length throw.

- Google: `https://www.google.com/maps/search/?api=1&query=...`
- AMap: `https://uri.amap.com/search?keyword=...&src=bcorn-widget&callnative=0`

No SDK, API key, geolocation permission, or automatic browser request is used. Opening the returned URL sends that place text to the chosen maps provider. A location name is a search query, not a verified geocoded destination. Supply a full street address for better results; the helper does not invent a city or campus. AMap may have limited coverage outside China.

## Run synthetic tests

```sh
node --test tests/course-tools.test.js
```

The tests cover original-schema imports, TBA/waitlists, malformed input and limits, transcript compatibility, boundaries, all weekdays, holidays, daylight saving transitions, several timezone offsets, stable UIDs, hostile text escaping, Unicode line folding, browser UMD loading, and safe map URLs. All test data is synthetic.
