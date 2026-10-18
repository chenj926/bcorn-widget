# Current implementation and acceptance status

This matrix separates implementation, synthetic verification and device/account acceptance. It is not a claim of a fully configured release.

| Requirement | Implementation | Remaining acceptance |
|---|---|---|
| Compact calendar header and reachable add/more | Compact date navigation, 48px controls, selected-day agenda | Actual narrow-screen browser/WebView geometry; current Chromium launch is blocked before app load |
| Android status bar, cutout and keyboard insets | Native root-container insets, no doubled HTML padding | Robolectric geometry covered; real Vivo/IME check remains |
| Holidays and school breaks | Display-only annotations and explicit Engineering undergraduate 2026–27 preset with source | User chooses applicable preset; no inferred class cancellation |
| All seven days and arbitrary dates | Civil-date Day/Week navigation, one-off events beyond teaching range | Shared model/DOM tests; real touch/layout acceptance remains |
| Native widget navigation and readability | Per-instance Day/Week state, actual previous/next/Today/toggle PendingIntents, day agenda, room suffix formatting | Actual AGP package host tests: 157 cases passed in each of two JVMs, with synthetic Day/Week screenshots; real launcher acceptance remains |
| Course/event colors | Persisted course colors and per-event overrides | Synthetic import/edit/reload tests |
| Multiple course-contained one-off events and overlap | Stable independent IDs, fifteen-minute entries, sibling-preserving edits, collision lanes | Shared model/DOM and native synthetic tests; dense real-launcher layout remains |
| Secondary screens and Back | Focused editors, contextual actions, dirty confirmation, queued widget destination | Actual DOM and native Back tests; physical-device gesture/IME behavior remains |
| Editable grades and automatic Sheets sync | Separate gradebook, explicit ungraded/zero/exempt, weighted metrics, native OAuth, connection-isolated journal, automatic foreground metadata checks and resume reconciliation | Synthetic bidirectional/conflict/pause/native-security tests; real OAuth project/client configuration and user grant still required |
| Link an existing grade spreadsheet/template | Native system-browser Picker, explicit bounded cell mapping, compact preview/import UI and human-readable new-template creation implemented | Synthetic mapping/native tests; final integrated tests and configured real OAuth remain. Supplied personal template remains read-only. Sheets lacks atomic compare-and-swap, so concurrent edits between preflight and write remain a disclosed limitation |
| Android calendar writes and reminders | Explicit writable CalendarProvider selection, canonical occurrences, stable owned IDs, idempotent update/remove | Recording-provider/Activity integration tests; real provider/cloud propagation and notification delivery remain |
| Windows Google/Outlook calendar writes | Separate Google Calendar/Microsoft Graph modules and explicit provider/account/target/reminder UI implemented; grade OAuth does not authorize them | 38 native harness tests and three UI/app suites passed; combined Windows release linked; real Windows/provider acceptance and separate configuration/grants remain |
| Data preservation and installability | Existing application ID/cache paths retained; complete safe backup envelope and rollback tests passed; private data never staged | Original Android signing key unavailable; unsigned build cannot upgrade installed app. Recovery or separately approved migration required |
| Windows executable | Combined GNU x64 EXE linked with WebView2Loader.dll | Real Windows runtime and OAuth still unverified |
| Local-first, low resource use | No ACORN polling/keepalive; widget reads local cache; calendar paint clock stops hidden; grade sync stops hidden/offline/paused | Request/wakeup counts are simulated logic tests, not measured device RAM/battery consumption |

See [configuration and signing gates](SETUP_GATES.md), [interaction architecture](COMPACT_WIDGET.md), and [grade synchronization details](GRADES_SYNC.md). Native calendar routes and cloud-grade routes are distinct. Exporting ICS is not automatic calendar synchronization.
