# 0.3.0 verification record

Date: 2026-10-18. All fixtures are synthetic. No personal timetable, grade spreadsheet, OAuth grant or live calendar was used for these tests.

## Completed source tests

- `node --test tests/*.test.js src-tauri/tests/*.test.cjs android/tests/bridge.test.cjs`: **164 passed**.
- `npm run test:integration`: **eight DOM suites passed**, executing the actual renderer modules and bridge contracts with simulated native providers. Covers compact navigation, nested Back/dirty drafts, course-contained events, calendar selection/removal, grade editing, automatic bidirectional synchronization, cloud calendar races, and complete backup/restore.
- `cargo test --manifest-path src-tauri/tests/native-grade-auth/Cargo.toml`: **56 passed**.
- `cargo test --manifest-path src-tauri/tests/calendar-harness/Cargo.toml`: **38 passed**.
- `cargo test --manifest-path src-tauri/tests/data-harness/Cargo.toml`: **11 passed**.

The Rust harnesses include some of the same production data/storage module tests. Their counts must not be summed as unique cases. A compilation or DOM test does not establish visual layout, account authorization or physical-device behavior.

## Build and actual-package checks

- Official Android Gradle Plugin `:app:assembleDebug`: passed. Version 0.3.0 / code 3, original application ID, **unsigned** APK, 3,781,038 bytes. SHA-256: `c0553011c44bd13da742f74e1046e0e4b9641d78b82fabf43379ec427028e756`.
- The exact production APK resources, merged manifest, compiled classes, resolved runtime dependencies and packaged assets were consumed by the Android host runner: **157 tests passed in each of two independent JVMs**. These are 157 cases run twice, not 314 distinct cases.
- All 23 packaged renderer/shared/bridge assets matched the frozen source bytes. DEX includes the actual Google authorization SDK, OkHttp and native Picker/account/mapping/template modules.
- Merged manifest: only INTERNET, READ_CALENDAR and WRITE_CALENDAR. The sole SDK service is Google's permission-protected revocation callback; there is no app foreground service, push receiver, boot hook or periodic network worker. Backup/cleartext remain disabled and OAuth configuration remains false.
- Windows x64 GNU release compilation/link passed with all OAuth client configuration explicitly empty. EXE: 4,612,608 bytes, SHA-256 `410beea7cb22e77f67850cea3b05cd1227d7fa9e3102a246b2781b20542b3dfe`. Real Windows execution is still unverified.

## Important regression boundaries

- Mapping transitions drain old materialization, isolate connection journals, and retain a durable blocked state after stale preview, failed confirmation or interrupted import. Restart cannot activate a rejected mapping.
- Android verifies an opaque account fingerprint for each newly obtained SDK token before accessing the bound spreadsheet. This uses the existing `drive.file` scope; identity and tokens stay native.
- New human-readable templates verify initialized score/weight values before binding. Existing templates require explicit bounded cell mapping; formula/protection/anchor checks and RAW writes are enforced natively.
- Sheets has no atomic compare-and-swap for these writes. Concurrent edits between preflight and write remain a documented limitation, despite conflict detection and readback.
- Backup envelopes preserve edited timetable/history and the separate assessment book, exclude credentials/remote ownership, validate before writes and compensate ordinary write failures. They are not crash-atomic across multiple local files.
- Native widget buttons are actual PendingIntents with per-instance Day/Week/date state. Widget images are simulated Android-host rendering, not screenshots from a Vivo launcher.

## Remaining acceptance gates

Real Windows/WebView2 execution, real Vivo launcher/insets/IME behavior, live Google/Microsoft authorization, device calendar propagation and reminder delivery remain unverified. The cloud browser cannot start Chromium because its process-singleton socket is rejected before app loading; DOM tests are not a substitute for that visual acceptance.

OAuth client configuration remains deliberately absent. No live account access has been established. The previous Android signing key is unavailable; an unsigned APK cannot replace the installed version. See [configuration and migration gates](SETUP_GATES.md). Keep the old application and its latest exported backup intact.
