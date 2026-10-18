# Historical verification and feature parity (0.2.0)

> This report describes the previously delivered 0.2.0 build. It does not certify the current 0.3.0 source, its OAuth configuration, signing continuity or new native widget modes. Current architecture and verification limitations are tracked in [COMPACT_WIDGET.md](COMPACT_WIDGET.md).

This branch is a tested **partial implementation**, not full platform parity. No real ACORN account, private schedule, transcript, credential or calendar account was used in testing.

## Feature matrix

| Capability | Electron reference | Tauri Windows target | Native Android target |
|---|---|---|---|
| Day / Week navigation + unchanged Grades | Shared renderer | Same source staged | Same source bundled |
| Actual ACORN login / MFA | Original implementation retained, not live-tested | **Not implemented** | **Not implemented** |
| Manual ACORN schedule + grades fetch | Original implementation retained, not live-tested | **Not implemented** | **Not implemented** |
| Display imported/cached transcript | Original Grades renderer | Original Grades renderer | Original Grades renderer |
| Confirmed local cache clear (exports and account sessions untouched) | Implemented | Implemented | Implemented |
| Offline local cache | Original safeStorage/fallback + new local import | Local app-data JSON | Private app files, backup disabled |
| Course editing, room/address, waitlist, TBA | Shared renderer | Shared renderer | Shared renderer |
| External Google/AMap links | Native bridge | Native bridge | Android intent |
| Selected/term JSON and ICS export | Native save dialog | Native save dialog | Android document-save picker |
| Persistent resizable desktop + pin | Reference implementation | Native implementation, Windows runtime pending | Not applicable |
| Resizable home-screen widget | Not applicable | Not applicable | Real AppWidgetProvider, Vivo launcher runtime pending |
| Background network polling/refresh/keepalive | Removed | None | None; no Internet permission |
| Native calendar integration | ICS fallback | ICS fallback | Explicit insert-intent preview plus ICS fallback; never auto-saves |

Preserving the Grades tab is not the same as porting authenticated grade fetching. The missing authentication rows above prevent claiming full original feature parity on Tauri/Android.

## Checks

Source/type checks, executable builds, browser UI tests and target-device runtime tests are distinct.

- `npm test`: 52/52 synthetic Node tests passed (model/calendar/DST/provenance plus Electron startup, refresh confirmation and cache clear policy).
- `npm run test:bridges`: 8/8 test entries passed (7 Tauri bridge/config cases and Android bridge/static manifest suite).
- `npm run test:renderer`: real headless Chromium interaction suite passed with no page errors: original tabs, malformed/BOM import, edit round trips, room vs building, waitlist/TBA, overlaps, map arguments, JSON/ICS, DST/exclusions, Shanghai device and New York DST-gap civil clocks, long holds, cancellation, cache failure recovery, native calendar-preview contract, offline onboarding, visible refresh failures and confirmed cache clear. Native transports are test doubles.
- `npm run test:android-renderer`: actual Android JS adapter in mobile Chromium with simulated native replies passed; import previews before confirmation, export routes natively, canceled clear retains data, confirmed clear removes simulated state.
- `npm run test:mobile`: synthetic mobile regressions passed for date navigation/exclusions, once/weekly events, unique event IDs, outside-term personal event creation, exact clicked occurrence detail/native preview, collapsed lists, selection-only export, dirty Back keep/discard, 360/390/900px overflow and primary touch targets. Fake-clock checks also verify no periodic or visibility-triggered repaint while a date input is focused or an editor is open, no periodic repaint while the document is hidden, and resumed periodic repaint after blur/close/visibility restoration. These are local repaint-logic checks, not measurements of battery use or power consumption.
- Android native host suite: **20 tests in each of two separate JVMs, 40 passes total**. Production Kotlin and aapt2-linked resources execute in Robolectric Android 15, including real RemoteViews apply/reapply and Canvas, disk cache reload, mixed-calendar/timezone events, DST gaps, tiny/5×7/landscape sizes and visibility recovery. Eight of each run exercise native MainActivity Back policy with a simulated WebView callback. This is stronger than compilation but **not a real launcher, Vivo, or system WebView execution test**. See [host test scope and commands](../android/tests/native-host/README.md).
- Pure Rust native cache/data harness: 8/8 tests passed, including atomic replacement and scoped cache deletion.
- A real Windows GNU release executable was linked for 0.2.0 with embedded runtime assets. The earlier baseline also passed an MSVC-target check; that is not a Windows execution test.
- Android official-tool offline build passed Kotlin compilation, aapt2 resource link, D8 conversion, zipalign and APK v2/v3 signature validation. Standard Gradle Android build was blocked by JVM network access; the included fallback uses installed official tools and is reproducible.
- Packaged/staged runtime assets byte-compared with source. Browser demo mock, real inputs, caches and signing keys are excluded from native artifacts.

Reproducible commands:

```sh
npm test
node --test src-tauri/tests/*.test.cjs android/tests/*.test.cjs
# Requires Playwright and a suitable installed headless Chromium executable:
CHROME_BIN=/path/to/chrome-headless-shell node tests/renderer-smoke.cjs
CHROME_BIN=/path/to/chrome-headless-shell node tests/mobile-interactions.cjs
CHROME_BIN=/path/to/chrome-headless-shell node android/tests/renderer-smoke.cjs
cargo test --manifest-path src-tauri/tests/data-harness/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --tests
```

Browser UI checks use synthetic data and simulated native capability/bridge inputs; they do **not** prove native save-picker, launcher, pin or calendar behavior on a real target OS. Native bridge tests check the actual adapter source against test doubles; they do not imply a real ACORN login or calendar write.

## Measurements and limits

- Electron Linux runtime directory: approximately 283 MiB, measured by `du`. Not Windows installed size, package compression or process RAM.
- Android debug APK 0.2.0: **841,038 bytes**; SHA-256 `6e00b08e991300ae87e563e377f14807e3a09b4d96fd889d6ab5c27b4f7f588c`. Package `com.acorn.widget`, versionCode `2`; signing certificate matches the prior versionCode 1 APK, preserving update identity. Actual on-device upgrade has not been exercised. APK bytes are not installed footprint, peak RAM/PSS or battery consumption.
- Windows GNU 0.2.0 portable candidate: EXE **3,609,600 bytes** plus required WebView2Loader.dll **160,880 bytes**, excluding installed system WebView2. EXE SHA-256 `dac823114fd9479c141c038079d0ac5a722c1a9695f466f23af0bf7811548c26`. ZIP **1,585,889 bytes**, SHA-256 `db1e16991a0b65c57d49aca264cd0c7062efff92e020b6b031394cd901ac8ac7`. Linked unsigned PE32+ x64 GUI binary, not a runtime-tested installer.
- Shared renderer payload: source/staging bytes only. Does not include OS WebView2/WebView runtime memory.
- No Windows or Vivo process-memory, idle-power, battery, frame-time or real-install measurements have been made. Include all WebView2 child processes in Windows measurements; compare equivalent data, dimensions and idle intervals. Android should be measured with app closed and widget present, then app open, to distinguish launcher bitmap memory from WebView activity memory.

## Widget diagnosis and scheduling

The original picker metadata had no previewImage or previewLayout, and the initial
layout had no useful timetable placeholder. This explains the generic picker
presentation, **not proof that a placed widget was blank**. Both preview paths
and meaningful no-data/error states are now present. Actual provider rendering
is separately verified in the native host tests.

The widget reads local cache after placement, resizing, saving and app entry,
and requests a system-batched daily local redraw so its dated week can advance
without a live app process. No Internet permission, service, keepalive, exact
alarm or recurring network request exists. OEM batching can delay redraw; the
visible date header identifies the rendered week. Real killed-process/reboot
and launcher delivery remain device gates.

## Release gates

1. Full Windows release link/package/install on Windows; monitor changes, resize, pin, focus/reopen and persistence.
2. Vivo X200 Pro / OriginOS 6: add widget from launcher, verify 5×7 sizing and smaller/larger sizes, orientation, overlap/waitlist rendering, text scaling/accessibility, app-closed widget persistence and tap entry. Launcher long-press is reserved for resize/remove; in-app long-press is a separate menu.
3. Native local import/export chooser cancellation, document-provider compatibility, process interruption, and calendar app availability. Test with synthetic data before real imports.
4. Secure ACORN SSO/MFA/session implementation for thin hosts, with explicitly authorized account testing. No credentials copied out of Electron.
5. Actual target-device RAM, installed size and idle-power measurements before calling the product low-memory/low-power.
6. Upstream license/redistribution review before any public binary release.
