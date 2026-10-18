# Architecture decision: preserve the renderer, reduce bundled runtime

## Baseline and scope

Verified fork and upstream main both point to `5d5ac94206e88f161d0ea5caefb5a18590b8dccc` at implementation start. This independent branch starts there, not from the previous Flutter feature branch. Original source files remain the renderer/backend baseline. The pre-existing `flutter_app` stock demo remains untouched and is not built or shipped by the new hosts.

## Why these hosts

Electron preserves the existing session-based ACORN integration with the least migration risk, but bundles a full Chromium/Node runtime. Its downloaded Linux runtime directory measured approximately 283 MiB in this environment, excluding app payload and installer compression. This is **not a Windows install-size or RAM measurement**.

Tauri uses the installed WebView2 on Windows rather than packaging another Chromium. Kotlin uses Android's installed WebView; the launcher widget is native RemoteViews backed by a bounded bitmap and does not keep a WebView running. These choices reduce duplicated runtime payload in principle. Actual low-RAM/low-power acceptance still needs measurement on Windows and Vivo X200 Pro/OriginOS 6. No estimated memory or battery percentage is presented as measured.

A pure native rewrite of all Day/Week/Grades UI would increase parity risk. Reusing the original renderer preserves the source of truth and lets the same synthetic regression tests exercise its behavior. Launcher widgets cannot host arbitrary WebViews, so the native widget is a separate rendering surface, not a claim of pixel-identical interactive HTML.

## Offline and event-driven behavior

- Shared model/calendar helpers have no network dependencies.
- Electron startup reads cache only. Network requests require Refresh or Login; no hidden SSO retry.
- Tauri has no ACORN HTTP client, and native IPC is restricted by CSP. Unsupported login/refresh is visible.
- Android requests Internet permission for explicitly configured foreground grade synchronization. OAuth credentials and HTTP remain in the native host; the WebView cannot obtain tokens. The widget requests a system-batched daily local redraw (`updatePeriodMillis=86400000`); no AlarmManager, WorkManager, foreground service, keepalive or network worker is introduced. It also redraws after local saves, app entry, placement and resize. It shows dated actual weekly occurrences, including one-off events and exclusions. Android/OEM batching can delay rollover; the date header identifies the displayed week and no exact-midnight guarantee is made.
- Foreground app clock redraw is local UI only, suspended when hidden. It is not data refresh.

## Data flow

Native cache -> narrow `window.acorn` bridge -> original renderer. User-selected JSON -> shared validator -> preview/confirmation -> local cache -> widget refresh. Manual changes mark data `source: local` with `modifiedAt`; `fetchedAt` is not fabricated as a live ACORN sync time. Course data is never built into assets.

The local JSON/ICS save picker is not calendar-provider insertion. Android offers a calendar insert intent only where supported; final insertion belongs to the selected calendar app. No real calendar writes were made in tests.

## Deferred migration

ACORN's private endpoints and SSO/session behavior need platform-specific security review and explicit authorized account testing before lightweight hosts can claim full feature parity. Current Electron implementation is preserved as reference. Importing a transcript can render Grades on all hosts; that is not evidence that native hosts fetch grades.

Full Windows linking/installation, resize/pin persistence on real Windows monitors, Vivo launcher cell sizing, accessibility, widget process lifecycle, RAM/PSS, disk and idle energy measurements are separate release gates. Upstream licensing is also unresolved.

## 0.3 domain boundaries

The current extension adds independent gradebook/sync modules and explicit calendar linking, without changing the original ACORN authentication limitation. `CourseTools` owns timetable invariants; `CalendarLink` expands canonical dated occurrences. Native provider modules own credentials, selected targets, private ownership journals and bounded API calls. Local timetable persistence succeeds independently of an optional provider write. Grade and calendar OAuth grants, accounts and files are separate. See [current interaction architecture](COMPACT_WIDGET.md), [grade synchronization](GRADES_SYNC.md), and [configuration gates](SETUP_GATES.md).
