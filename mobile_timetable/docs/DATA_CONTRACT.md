# Shared timetable v1

Method channel: `io.bcorn.mobile/timetable`

- `load` → persisted JSON string or `null` for no data. Read failures must fail, never silently overwrite saved data with a new empty timetable.
- `save` arguments `{ "json": "<entire snapshot>" }` → success/error. Native writes the snapshot then asks widgets to refresh. Flutter publishes new UI data only after save succeeds.
- `openUrl` arguments `{ "url": "https://…" }` → Boolean.
- `requestPinWidget` → Boolean (`false` means use OS instructions).
- `getPendingCourseId` → newest pending course ID or `null`; native consumes it once.
- Native event `courseLinkAvailable` → Flutter queries `getPendingCourseId`. Query after load and app resume too, to preserve cold-start intents. Widget taps only route to course details; they never open maps.

Snapshot:

```json
{
  "version": 1,
  "updatedAt": "2026-10-15T05:00:00.000Z",
  "courses": [{
    "id": "unique-stable-id",
    "title": "课程名称",
    "weekday": 1,
    "startMinutes": 540,
    "endMinutes": 630,
    "location": "校园完整地址 · 教室",
    "mapUrl": "https://www.google.com/maps/search/?api=1&query=campus",
    "notes": "备注",
    "color": 4282948208,
    "startDate": "2026-09-01",
    "endDate": "2026-12-31"
  }]
}
```

`weekday` is ISO Monday=1…Sunday=7. Start is inclusive, end is exclusive. End may be 1440; cross-midnight ranges are not supported. Dates are inclusive local calendar dates (`YYYY-MM-DD`) or `null`. Recurrence is weekly and local-device-time, not a named-timezone calendar system. `updatedAt` is UTC for metadata only. `color` is an unsigned 32-bit ARGB integer. IDs are unique. Maximum 500 courses / 1MB input in Flutter import. Unknown snapshot versions are rejected.

URLs may use http, https, geo, google.navigation, amapuri, iosamap, androidamap, maps. Native apps should verify platform support before launching. No javascript, file, intent or arbitrary app schemes. Empty `mapUrl` allows a Google Maps search derived from nonempty `location`. Opening an external course link requires a long-press action followed by a navigation choice. A simple course tap only expands details.

The native implementations parse and validate their inputs independently. All platforms derive current/next from course recurrence and the clock rather than storing stale precomputed current-course labels.
