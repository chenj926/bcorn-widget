# bcorn: local calendar, cross-platform work in progress

This branch starts from **LoganZ2/bcorn-widget `5d5ac94206e88f161d0ea5caefb5a18590b8dccc`**, the original Electron app. It extends the original HTML/CSS/JavaScript renderer; it does **not** use the unrelated stock `flutter_app` demo as a replacement. The shared renderer now uses navigable Day / Week views, with the original Grades view, navy/warm-gray palette, course overlap lanes and date exceptions retained in `src/renderer`.

**This is a partial cross-platform implementation, not a verified Windows/Vivo release.** See [verification and remaining gates](docs/VERIFICATION.md) and [architecture](docs/ARCHITECTURE.md). [Current synthetic mobile UI](docs/MOBILE_UX.md) shows the calendar-first interaction revision; the [earlier visual comparison](docs/VISUAL_PARITY.md) records the original baseline.

## Three hosts, one original renderer

- **Windows lightweight target: Tauri 2 + system WebView2.** Resizable ordinary desktop window, optional always-on-top, remembered size/position/pin, local JSON cache and native export dialogs. ACORN authentication and manual refresh are **not migrated** to this host; buttons explicitly explain that limitation. It can show imported transcript data using the original Grades view. Windows-target Rust compile/type-check is distinct from a linked Windows installer or Windows runtime test.
- **Android: native Kotlin app + system WebView + real AppWidgetProvider.** Packages the same renderer, local JSON import/edit/export, and a resizable launcher widget targeting 5×7 cells (actual cell sizes depend on launcher). Native widget draws the current dated week with overlap lanes, one-off events, compact sizing and dashed waitlist labels. Android may batch its daily local redraw; no exact-midnight guarantee is made. Tapping the widget opens the app; meeting details and long-press menu are inside the app. Launcher long-press remains the launcher's resize/remove UI. ACORN authentication/refresh is **not migrated** here either.
- **Electron reference host:** retains the original ACORN login and user-triggered refresh implementation, plus local features. It is the parity/authentication reference, **not** the low-footprint target. Original ACORN private endpoints were not exercised against a real account.

All hosts start from local data. No automatic data refresh, hidden login, session keepalive, cloud sync, analytics or recurring network polling is added. The Electron reference's original startup refresh, cookie lifetime extension, periodic refresh, keepalive and wake-triggered requests have been removed. Its login remains explicitly user initiated.

## Calendar and course tools

- Navigate any day or week with previous/next and a date picker. Grades is unchanged.
- Create a course or one-off/weekly event through normal forms. Compact detail screens lead to focused editors; advanced fields are folded away.
- Collapse the course list to prioritize the timetable. Export is contextual to selection.
- Android Back closes the current level first, warns before discarding edits, and requires a second Back within two seconds only at the root.
- Tap a course/meeting for details; edit course title, status, credits, room, address, meetings and exceptions.
- A waitlisted course has a dashed outline and explicit label. Waitlisted meetings are excluded from calendar export by default.
- TBA courses remain in the course list without fabricated times.
- Choose Google Maps or AMap and open an external map link. No embedded map SDK. Opening a map sends the chosen location/address to that provider; it is never automatic.
- Import local JSON with validation and a replacement preview. Export selected courses or the whole term as JSON/ICS. A confirmed local-data clear removes the app cache, including grades, but leaves exported files and account sessions alone.
- Electron asks before an ACORN refresh replaces imported/manual local changes; cancel and export a JSON backup first if those changes matter.
- Calendar ICS uses finite, expanded UTC occurrences, with the selected term's IANA timezone applied for each occurrence. This preserves DST and excluded dates without relying on a calendar client's RRULE/TZID implementation. Untimed courses are omitted. These are independent events, not one editable recurring series. Review your calendar app's import preview before adding events.
- Term holidays alone do not determine every tutorial/practical exception. Confirm course-specific cancellations and optional makeup classes with the instructor before export. The app does not guess makeup dates.

[Import schema and synthetic examples](docs/import-format.md). **Do not put real schedules, grades, sessions, screenshots or imported files in this repository.** No private data is included in test fixtures or binaries.

## Development

Node 22+ (tested with Node 24):

```sh
npm ci
npm test
```

Original Electron reference:

```sh
npm start
# Reference Windows package; requires downloading Electron for Windows:
npm run package:windows:reference
```

Tauri Windows target (Windows, Rust stable, Microsoft C++ build tools, WebView2):

```sh
npm run tauri:build
```

`npm run tauri:prepare` stages only `src/renderer` and `src/shared`, keeping private files and unrelated directories out. The NSIS configuration uses system WebView2; if it is absent, the installer bootstrapper requires an Internet download. No Windows installer is represented as tested by source/type checks alone.

Android build and installation details: [android/README.md](android/README.md). Build requires Java 17+, Android SDK/platform 35, Gradle 8.13 and acceptance of the relevant tool licenses. Do not add credentials to Gradle files.

Browser preview uses explicitly synthetic upstream demo data and a browser-local cache, never a real ACORN session. Start a local server at repository root, then open `/src/renderer/index.html`. The preview's pin/auth buttons cannot exercise native hosts.

## Privacy and provenance

Native hosts store data in their app-local storage. Android disables cloud/device backup and requests no Internet or calendar-provider permission. The Tauri cache is **local plaintext**, protected by the OS account rather than app-specific encryption. Electron uses `safeStorage` when available, otherwise its original plaintext fallback; do not assume all hosts encrypt course data at rest. Exports are plaintext files the user explicitly chooses to save.

The original source has **no LICENSE file**. Attribution is preserved, but general redistribution rights have not been verified. Do not publish installers, APKs, releases or redistribute the original code outside the existing authorized fork workflow until licensing is clarified. No claim of a new license is made. [Original README](docs/UPSTREAM_README.md) is retained for provenance; its auto-refresh and cookie-retention descriptions no longer apply to this branch.
