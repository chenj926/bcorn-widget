# Compact timetable and linked local calendars

This iteration keeps the original navy/warm-gray visual identity while reducing navigation chrome. Synthetic fixtures only are used in tests. No private course data, grade data, account IDs, screenshots, tokens or signing keys belong in this repository.

## Interaction model

- One compact date/week toolbar with previous/next, date picker, Today and visible add/more controls. Primary targets are at least 48 CSS pixels; native widget controls are 48 dp.
- All seven days are displayed. A readable selected-day agenda accompanies the narrow phone grid. Short overlapping entries retain their own lanes and full accessible labels.
- Course details can create several independent one-off entries (for example a fifteen-minute quiz). Editing or deleting one preserves the weekly pattern and other entries. The clicked occurrence supplies the initial date/time.
- A course chooses a color; an individual event can override it. Colors survive import/save/reload.
- Holiday ranges tint the background only. They never infer an exclusion, cancel a class, or prohibit a personal event. An optional, explicitly selected U of T Engineering undergraduate 2026–27 preset identifies its scope and [official source](https://engineering.calendar.utoronto.ca/sessional-dates). It is not a university-wide or graduate calendar and is not enabled by guessing a user's course codes.
- Widget previous/next/Today and Day/Week toggle are actual RemoteViews PendingIntents. Each widget atomically stores its mode and selected civil date separately from timetable data. Navigation moves one day or seven days; toggling retains the date. Today clears the pinned date while retaining the mode. The native day agenda leads with course code (plus a short label for a course-contained event), followed immediately by a prominent room and a separate time line, with explicit overflow. Full course names remain in details. Week cards pair course code and room, preserving room-number suffixes and the time geometry of genuinely short blocks. Four 48dp targets use two rows at widths below 204dp. Opening the app carries the exact date and mode, with legacy weekStart compatibility; dirty editors retain priority and queue the destination.
- Android window insets belong to a native root container rather than applying extra padding inside the WebView's HTML viewport.

## Domain invariants and information boundaries

`CourseTools` owns civil-date occurrence rules and validation. One-off entries use `recurrence: "once"`, a stable meeting ID and an explicit date. Their date is independent of the parent course's teaching range. Weekly patterns retain their original bounds and exclusions. `upsertCourseEvent` and `removeCourseEvent` return a new term and never ask callers to splice or renumber sibling entries.

`CalendarUI` owns palette selection and collision geometry, not persistence. Android independently renders the validated local model; it does not run a WebView in the widget. Platform painting remains platform-specific rather than introducing a cross-platform drawing framework.

`CalendarLink` assigns persistent meeting identities before linking and expands canonical UTC occurrences. The native provider adapter receives explicit date keys and instants, so it does not independently reinterpret the academic calendar. A civil-date key remains stable when the event's time or title changes.

`CalendarIntegration` owns explicit device-calendar setup, serialized reconciliation and its private connection preference. A successful timetable save never depends on a provider write. Provider failure is reported separately; there is no automatic ACTION_INSERT fallback that could duplicate an already committed write. Settings actions use stable delegated listeners so nested Back/Cancel restoration does not remove behavior.

The native `CalendarBridge` owns permissions checks, selected-calendar identity, provider ownership markers and durable retry journals. Only its own linked events can be updated or removed. Changing the target cannot silently migrate existing links. See [native calendar contract and limits](android-calendar.md).

The editable gradebook is separate from the imported transcript and timetable cache. Clearing a timetable does not delete this gradebook or already-written system calendar events. Grade synchronization uses a separate private, connection-scoped outbox; credentials must stay in native secure storage. See [grade synchronization architecture](GRADES_SYNC.md).

## Verification distinctions

- Node model/bridge tests and Rust native-data tests exercise production modules.
- `npm run test:compact-dom` and `npm run test:calendar-dom` execute the actual renderer against a synthetic DOM/provider. They cover edits, nested navigation, failure preservation and connection behavior. JSDOM does not measure layout, paint, touch geometry or system permissions.
- Playwright suites include `test:renderer`, `test:mobile`, `test:compact`, `test:grades-ui` and `test:android-renderer`. The current cloud environment cannot launch the system Chromium: its process-singleton socket fails with `EPERM` before app load. An attempted official Playwright headless-shell download returned an invalid/truncated archive. These suites must be rerun in a working browser environment before claiming visual acceptance.
- Native Android host tests exercise production RemoteViews, Canvas, registered PendingIntent actions, Activity/JS bridge and recording CalendarProvider adapters under Robolectric. They are simulated Android-host tests, not Vivo launcher or real-account tests.

## Signing and upgrade gate

The previous private Android debug signing key did not survive the cloud workspace reset, and no persisted backup has been found. The historical 0.3.0 source retained `com.acorn.widget`. The approved Android 0.3.1 migration now uses `com.bcorn.widget` for a separate installation, with explicit backup/import; it cannot read the old app’s private storage. The offline builder now refuses to silently create a replacement key and supports explicit unsigned verification. Do not uninstall the user's existing app or clear its data to work around signing. The approved parallel migration is documented in ANDROID_PARALLEL_INSTALL.md. Signing remains local to a user-controlled persistent environment; cloud builds remain unsigned, and real-device migration is unverified.

## Portable backup boundary

`UserBackup` validates and whitelists a versioned envelope containing timetable/history, assessment grades and explicitly allowed display/map preferences. Legacy timetable JSON remains accepted. Independent section limits are 2 MiB and the complete envelope limit is 5 MiB. Credentials, remote ownership IDs, connection bindings and journals are excluded. Import validates everything before any write, pauses existing calendar links, and separately asks before replacing assessment grades. Ordinary write failures trigger compensating rollback; this is not an operating-system transaction across multiple files. See `npm run test:integration` and `tests/user-backup.test.js`.
