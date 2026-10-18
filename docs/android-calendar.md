# Android linked calendar contract

`com.acorn.widget.calendar.CalendarBridge` is the single native entry point. It performs no networking, background polling, scheduled task or foreground service. Call its synchronous `call(method, args)` on one serial worker, using one facade instance per app process. Deliver the JSON result to the WebView on the UI thread. Local saves must succeed independently of calendar errors. Reconcile only after an enabled user save/import; retry explicitly or on the next enabled save, without tight loops.

## Permission and route

Declare READ_CALENDAR and WRITE_CALENDAR, then request both at runtime only after the user chooses to enable linked calendar updates. The module checks both before every operation and catches revocation/provider errors. It never requests permission itself. Do not silently pick the first account. Enumerate actual writable calendars and let the user choose one. Local account calendars do not imply cloud sync. Google, Outlook/Exchange and Vivo calendars are available **only if their installed account/calendar integration exposes a writable Android CalendarProvider target**. Outlook app installation alone does not establish this. Device integration and account sync state determine delivery beyond the device.

`android-provider` is the exclusive route for selected native events: do not also invoke Google Calendar REST or Microsoft Graph for them. The existing ACTION_INSERT intent is a separate manual-save fallback: it opens the calendar editor, requires the user's Save, and supplies no reliable event binding/update result. Never call that fallback automatically after a failed linked write (the provider may already have committed part of a series).

## Methods

All results contain `ok`. Errors contain `code`, `message`, `localDataPreserved: true`, `retryMayBeNeeded: true`. Codes include permissionRequired, calendarRequired, calendarUnavailable, calendarChanged, targetChanged, unsupportedReminders, invalidEvent, linkConflict and providerError. Do not present a failure as cloud delivery success.

- `calendarStatus {}` -> permissionGranted, selectedCalendarId (-1 if unset), route.
- `listCalendars {}` -> calendars [{id, name, account, accountType, maxReminders, supportsAlerts}]. Permission required; only contributor-or-better calendars are queried. The UI may show account/name locally to disambiguate selection.
- `selectCalendar {calendarId}` -> selected calendarId. Uses actual ID and stores account identity to reject stale/reused IDs.
- `syncCalendarEvent payload` -> written, unchanged, removed, occurrences, calendarId, route. One stable local meeting/event ID. For multiple course meeting patterns, use distinct stable IDs including term/course/meeting identities. Renaming must not change IDs. Exclude waitlisted/unscheduled meetings in the renderer adapter.
- `removeCalendarEvent {id}` -> removed, unlinked. `removed` counts actual provider deletions; `unlinked` also counts missing/ownership-changed rows whose local binding was dropped safely. Explicitly unlink/remove owned remote occurrences. Uses original target even if a new calendar is selected. User intent to delete/unlink must be obtained by the UI. Local data is not touched by this method.

Payload:

```json
{"id":"term/course/meeting","title":"CSC lecture","description":"Notes","location":"BA 1170","timeZone":"America/Toronto","reminders":[10],"start":"2026-10-19T09:00","end":"2026-10-19T10:00"}
```

Preferred shared-model integration: replace `start`/`end` with `occurrences: [{key: "2026-10-19", startMillis: 1792414800000, endMillis: 1792418400000}]`, as expanded by CourseTools. The stable key is the occurrence civil date, not its timestamp. Maximum 1000 unique date keys, integer epoch milliseconds, positive duration up to seven days. `timeZone` remains required. An empty array explicitly reconciles/removes all of this series' owned occurrences; it is not a no-op. This explicit path preserves the shared adapter's authoritative holiday/once/date-bound semantics and does not run native recurrence expansion.

For callers without shared expansion, a bounded course can replace `start`/`end` with:

```json
{"recurrence":{"startDate":"2026-09-01","endDate":"2026-12-10","weekdays":[1,3],"startTime":"09:00","endTime":"10:00","excludedDates":["2026-10-12"]}}
```

`timeZone` is an IANA zone. Date-times are LOCAL ISO wall times, without a UTC/offset suffix. ISO weekdays: Monday=1, Sunday=7. End dates inclusive, maximum range 730 days. The adapter must include every exclusion/holiday applicable to a meeting. Overnight courses end next day. DST gaps are skipped for recurring courses and rejected for a one-off; autumn overlaps use the earlier offset. Occurrences keep their wall time across DST and are materialized as individually linked events rather than relying on OEM recurrence/exception interoperability. This costs at most 731 small rows for the bounded range, and no running process after save.

Reminders are unique integer minutes before the event, 0–40320, sent as native alert reminders. The selected calendar's maximum and allowed methods are enforced; unsupported choices fail **before any writes**, never silently downgraded. The calendar app owns notification delivery; bcorn must not schedule duplicate local notifications. Calendar app notification permission, DND and OEM battery restrictions may still suppress alerts.

## Ownership, retries and privacy

Private SharedPreferences `calendar-links-v1` stores selected identity and per-local-ID occurrence bindings. **Exclude this file from Android backup/device-transfer rules**, and never include it in user JSON exports or sync payloads. App uninstall/cleared storage loses bindings; existing calendar events remain. Imports are local data only, not trusted provider IDs.

Each occurrence gets a random ownership marker in its description. It is journaled before provider insertion. After interruption, marker lookup recovers the existing row, avoiding duplicate creation. Provider event/reminder writes are in one `applyBatch`; updates assert exact ownership in that transaction. A bounded series can partially succeed before a failure: retry reconciles committed occurrences. No all-calendar scan/delete, hidden sync-adapter fields or guessed event IDs are used. Removed/excluded dates delete only the same local series' owned rows. The user-visible marker must remain for linked editing. Missing, moved or ownership-modified linked rows produce conflict instead of overwriting another event. Removing a link never deletes a row whose marker is absent. Changing the target does not silently migrate existing events; explicitly remove old links first.

An unchanged payload performs ownership reads but skips writes. Outside edits to owned event text are not automatically overwritten by an unchanged save; a changed bcorn payload updates its owned event. This is one-way local-to-provider synchronization, not provider-to-local conflict merging.

## Validation and device limitations

`NativeCalendarTest` exercises facade behavior with a fake provider: selection/permission/revocation, persistence/recreation, interruption recovery, idempotency, safe ownership conflicts, reminders, account change, target change, DST/overnight/exclusions and bounded dates. `AndroidCalendarProviderTest` uses a recording ContentProvider under Robolectric to inspect actual adapter queries, batch operations and ownership guards. It does not simulate a remote sync service or prove an OEM's transaction/notification behavior.

Add both classes to `android/tests/native-host/run.sh` JUnitCore list; production build must include the new calendar Kotlin subpackage recursively. Runtime/device checks still needed: permission denial/permanent denial/revocation; account selection and removal; read-only calendars; native reminder delivery; Google/Outlook account sync; real Vivo OriginOS 6 CalendarProvider and launcher operation. No Vivo device or live calendar has been used or mutated.

Reference: [official Android Calendar Provider documentation](https://developer.android.com/identity/providers/calendar-provider) (permissions, writable calendar access, event/reminder batches, manual intents, and no writes to sync-adapter-reserved fields).

Verified in the current cloud workspace: calendar Kotlin compilation succeeded against official API 35, and all 24 calendar tests passed under Robolectric 4.14.1/API 35 using isolated compiled module classes. The isolated run used OS resource fallback, not a device/emulator or the full production manifest. The full production native-host runner should also execute both suites before release.
