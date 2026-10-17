# Mobile calendar interaction revision (0.2)

Synthetic demonstration screenshots accompany the private build delivery. No new
UI screenshots, private schedules, addresses, grades, or imported files are
published with this change. The widget picker preview is generated from the
fictional data in its checked-in generator.

## Calendar first

- Day and Week share a civil date in the calendar's timezone, independent of the
  device timezone. Previous/next move by one day or seven days; the date picker
  accepts dates outside teaching terms. Today returns to the current calendar date.
- Week shows actual occurrences, including exclusions and one-off events. Empty
  weekend columns are hidden, and appear when a weekend has an event.
- A visible header **+** opens Course / Event creation. The course list is folded
  by default. Selection mode reveals checkboxes; selected export appears only
  when at least one entry is selected. A specific detail's export acts on that entry.
- Tapping an occurrence preserves its date in the detail view. A next-occurrence
  hint is explicitly separate; a past occurrence does not offer an unrelated
  future native-calendar preview.


## Details and focused editing

Time, occurrence date and location lead the detail. Recurrence boundaries,
exceptions and alternate map providers live under More details. The default
navigation action remembers the chosen Google/AMap provider locally.


The full-height editor keeps Back and Save reachable, shows basic information
first, and folds meeting schedules into summary rows. Only one meeting editor
is expanded at a time. Exceptions use a date picker and removable chips rather
than comma-separated manual input. Back preserves edits unless discard is
confirmed; it returns to the previous detail level.


Events have a title, date or weekly weekday/date range, time, and optional
location/address. No course code or JSON is required. Events outside academic
terms receive a personal calendar and remain visible on Day/Week. Weekly events
currently support one weekday per entry; overnight events must be split into two.


## Native Android surface

The launcher widget uses production RemoteViews and a bounded local bitmap, not
an embedded WebView. Large widgets show a dated weekly grid; small widgets show
an agenda. Picker previews are synthetic metadata and are separate from actual
cache-backed runtime rendering. The provider's host-test evidence and remaining
Vivo/launcher checks are documented in [verification](VERIFICATION.md) and
[the native host suite](../android/tests/native-host/README.md).

Android Back first closes current menus, dialogs, editors or selection mode.
Only the root requires a second Back within two seconds to return to the launcher;
intervening interaction or a consumed Back resets that sequence. Native Back
policy is tested with actual MainActivity and a simulated WebView response;
renderer dirty-state behavior is tested independently in Chromium.

## Design references

- [Android date pickers](https://developer.android.com/develop/ui/compose/components/datepickers)
- [Android navigation principles](https://developer.android.com/guide/navigation/principles)
- [Accessible touch targets](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)
- [App widget design and constraints](https://developer.android.com/develop/ui/views/appwidgets/overview)

These references guided hierarchy and interaction. The implementation is shared
HTML/CSS/JavaScript inside the native hosts, not Jetpack Compose.
