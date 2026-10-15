# iOS app bridge and timetable widgets

Native source implementation for **Flutter 3.41+**, an **iOS 14+** app, iOS 14+ Home Screen widgets, and an **iOS 16+** rectangular iPhone Lock Screen widget. iPad Lock Screen widgets require iPadOS 17+. The labels are Chinese. No account, server, location permission, push service, background audio, or continuous background process is required.

**Build status:** these sources were prepared on Linux without Flutter, Swift, Xcode or an Apple signing team. Plist parsing, identifier consistency and shell syntax were checked. A simulator/device build, Swift model-test run, widget rendering, signing and App Store validation have **not** been performed. A generated `Runner.xcodeproj` is intentionally not fabricated. Use the setup below on a Mac.

## Setup on a Mac

Install Flutter 3.41 or later, Xcode and its iOS SDK, then run `flutter doctor`. The supplied AppDelegate uses the current UIScene lifecycle described in [Flutter's migration guide](https://docs.flutter.dev/release/breaking-changes/uiscenedelegate).

From the Flutter project root:

```sh
# xcodeproj is commonly already installed with CocoaPods.
# If missing, install it in the same Ruby used by the setup script:
gem install --user-install xcodeproj
bash ios/scripts/bootstrap_ios.sh
flutter pub get
open ios/Runner.xcworkspace
```

The bootstrap script generates a temporary, ordinary Flutter host when needed, copies **only** its `ios/` scaffold into this project, restores the supplied native Runner files, and invokes `configure_xcode.rb`. It does not overwrite Dart/Android files. The Ruby step adds shared sources, creates and embeds `TimetableWidgets`, sets iOS 14 deployment targets, adds privacy manifests and entitlements, and preserves a one-time `project.pbxproj.before-timetable` backup. It is intended to be repeatable, but has not been executed against Xcode on this machine. If a newer Xcode project format is unsupported by your xcodeproj gem, update the gem or follow the manual steps below.

In Xcode, finish these required account-specific steps:

1. Select the **same Apple development team** for **Runner** and **TimetableWidgets** under Signing & Capabilities. Enable automatic signing or supply your own provisioning profiles.
2. Choose bundle IDs you own. Defaults are `io.bcorn.mobile` and `io.bcorn.mobile.TimetableWidgets`. You can set `BCORN_BUNDLE_ID=com.yourteam.timetable` when invoking the script. The extension ID must remain under the app's ID.
3. Add the **App Groups** capability to **both** targets. Register/select a group owned by your team. The placeholder is `group.io.bcorn.mobile`. Change it in **Shared/TimetableData.swift**, **Runner/Runner.entitlements**, and **TimetableWidgets/TimetableWidgets.entitlements**. All three must match exactly. Merely editing a file does not register the group or authorize a provisioning profile.
4. Confirm Runner embeds `TimetableWidgets.appex` and depends on the widget target. Keep its Embed App Extensions phase **before** Flutter's Thin Binary phase if Xcode reports an assembly dependency cycle.
5. Keep the extension's marketing/build versions equal to Runner's `pubspec.yaml` version. Rerun `configure_xcode.rb` after changing versions, or update both targets in Xcode. The script does not change your team selection.
6. Run Runner once, create/save courses, then add the widget through the system widget gallery. A successful App Group save is required before widgets can read courses. iOS does not allow an app to programmatically pin a widget.

Then compile and test:

```sh
flutter build ios --simulator
swiftc ios/Shared/TimetableData.swift ios/Tests/main.swift -o /tmp/bcorn-ios-tests
/tmp/bcorn-ios-tests
# A signed device build is separate and requires your team/profiles:
flutter build ios
```

If Flutter reports that CocoaPods is required, install/configure CocoaPods as recommended by `flutter doctor`, then rerun the build. Do not add Flutter/CocoaPods dependencies to the WidgetKit extension; it uses only Foundation, SwiftUI and WidgetKit.

## Manual Xcode integration (alternative to the scripts)

If you already have a generated Flutter iOS project, make a backup before merging these files. For a missing host, generate a **separate temporary** Flutter project with `flutter create --platforms=ios --org io.bcorn --project-name bcorn_mobile /tmp/bcorn_host`, then copy its iOS scaffold while preserving the supplied native sources.

1. Open `Runner.xcworkspace`. Add `AppDelegate.swift`, `BcornSceneDelegate.swift` and `TimetableBridge.swift` to **Runner only**. Use the supplied `Runner/Info.plist`, or merge its URL scheme, `FlutterDeepLinkingEnabled=false`, and scene-delegate configuration into your own plist. Preserve your generated bridging header and Flutter configuration files.
2. File → New → Target → **Widget Extension**, name **TimetableWidgets**, embedded in Runner. Disable configuration intent and Live Activity options. Delete the extension template's generated Swift entry points so there is exactly one `@main` in that target. Add `TimetableWidgets.swift` to the extension only.
3. Add `Shared/TimetableData.swift` to **both** Runner and TimetableWidgets. Never add AppDelegate, BcornSceneDelegate or TimetableBridge to the extension.
4. Set minimum iOS deployment to **14.0** for both targets. Build with an SDK that includes iOS 17 APIs; availability checks keep iOS 14–16 supported. Set extension Swift language version to Swift 5 and **Require Only App-Extension-Safe API = Yes**.
5. Set each target's Info.plist and Code Signing Entitlements to its own supplied files. Disable automatic Info.plist generation for the extension if using its provided plist. Copy each target's `PrivacyInfo.xcprivacy` through that target's **Copy Bundle Resources** phase.
6. Complete the team, App Groups, embedding and version steps above. No Background Modes capability is needed.

For a pre-3.41 Flutter host, upgrade Flutter if possible. Otherwise remove `FlutterImplicitEngineDelegate` and `BcornSceneDelegate`/scene-manifest integration, register `GeneratedPluginRegistrant` and `TimetableBridge` from `application(_:didFinishLaunchingWithOptions:)` using `registrar(forPlugin:)`, and retain the URL-open and activation handlers. That older lifecycle variant is not supplied or verified; do not mix it with a UIScene host.

## Implemented behavior

- Small/medium widgets show the current class, otherwise the next active weekly occurrence, including future semester start dates. Tapping a course opens its enlarged detail view in the app; the medium widget also labels this action explicitly.
- Large widgets also show up to **five** courses for the current local day, with an explicit remaining count. This is a glanceable day overview, not a complete weekly grid or an iOS full-screen widget.
- The rectangular Lock Screen widget shows current/next class, date/time and location. It opens that course’s detail view in the app. It is offered only on supported OS versions.
- All course taps use `bcorn://course/<percent-encoded-id>`. The native bridge queues the ID for Flutter’s enlarged course detail view, preserving it until Flutter consumes it. Empty widgets use `bcorn://timetable`. Widgets never launch maps automatically. To navigate, long-press the app’s course card or enlarged detail, choose “导航到上课地点”, then use the Google/AMap/custom-link chooser. There are no visible map buttons on course cards or details. Holding a native widget is reserved for the system’s widget menu, so first tap it to enter the app. Cold and warm launches are handled through UIScene; the legacy AppDelegate callback is also retained.
- Weekly recurrence uses Monday = 1 through Sunday = 7 in the device's current timezone. Semester endpoints are inclusive. Start time is inclusive; end time is exclusive. `endMinutes=1440` means next midnight. Overnight courses are rejected. Overlapping courses use stable start-time, end-time, ID ordering.
- Local wall-clock construction accounts for DST. Nonexistent spring-forward times move forward to the next valid local time, and repeated autumn times use the first occurrence. Changing the system timezone changes local course interpretation.
- The provider supplies entries at class starts/ends and local midnight over the next two days, with a 128-entry cap for pathological imports. Saving data or foregrounding the app requests a widget reload. This is a request, not a synchronous paint guarantee.

## Real Lock Screen / Always-On limitations

**The app cannot enable, force or extend the device's Always-On Display.** The rectangular widget may remain visible when iOS displays the Lock Screen on compatible hardware and the user has enabled the relevant settings. It cannot show a whole weekly timetable over the locked screen or keep an unsupported phone's display lit. Low Power Mode, Sleep Focus, device orientation and other system conditions can turn the display off. See [Apple's Always-On explanation](https://support.apple.com/guide/iphone/keep-the-iphone-display-on-longer-iph7117338a8/27/ios/27).

WidgetKit schedules rendering and applies refresh budgets; boundary entries are not alarms and exact-minute updates cannot be guaranteed. There is no polling timer or guaranteed second-by-second countdown. The OS may delay, coalesce or redact content. See [Keeping a widget up to date](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date).

Course content is marked privacy-sensitive where supported, so system privacy settings can hide it. Test both the visible and redacted states. Map links may need an installed map app; HTTPS map links are the most portable. The native channel returns `false` if iOS cannot open a link.

## Method channel and data contract

Channel: `io.bcorn.mobile/timetable`.

- `load` → the exact saved JSON string, or `null` for a new timetable.
- `save`, arguments `{"json":"..."}` → validates and saves the string, requests a widget reload, returns `true`.
- `openUrl`, arguments `{"url":"..."}` → allows only `http`, `https`, `geo`, `google.navigation`, `amapuri`, `iosamap`, `androidamap`, `maps`; returns whether iOS opened it.
- `requestPinWidget` → `false` on iOS.
- `getPendingCourseId` → queued course ID or `null`; returns and clears it.
- Native → Dart `courseLinkAvailable` event → a queued ID is available. This event does not consume it. Flutter should query `getPendingCourseId` after data loading, on resume, and when receiving this event. Resolve IDs against loaded courses and handle deleted/missing courses gracefully. If several taps arrive before consumption, the newest wins.
- `getPlatformInfo` → platform capability flags and `appGroupAvailable` (no claim that a widget has already been installed).

App Group: `group.io.bcorn.mobile`; UserDefaults key: `timetable_json`.

```json
{
  "version": 1,
  "updatedAt": "2026-10-15T05:00:00.000Z",
  "courses": [{
    "id": "math-mon", "title": "高等数学", "weekday": 1,
    "startMinutes": 540, "endMinutes": 630,
    "location": "教学楼 A · 302", "mapUrl": "https://maps.apple.com/?q=School",
    "notes": "", "color": 4285884143,
    "startDate": "2026-09-01", "endDate": "2027-01-31"
  }]
}
```

Dates may be `null`; timestamps must include a timezone. Color is an unsigned 32-bit ARGB integer. Imports are limited to 1 MB / 500 courses. Invalid documents return a Flutter error without overwriting the old data; no missing/invalid App Group is silently treated as a successful save.

UserDefaults access is declared with App Group reason `1C8F.1` in both privacy manifests, matching [Apple's required-reason API documentation](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). Review the final aggregate privacy report when you add plugins or distribute the app; these manifests cover this implementation, not every possible future dependency.

## Acceptance checks before calling the iOS build ready

- Run model checks, then build Runner and extension in a simulator and on a signed device.
- Save, quit/relaunch, edit and delete a class; ensure the app and each widget agree.
- Exercise no courses, all courses expired, tomorrow/next week, a future semester, overlapping classes, Sunday→Monday, midnight, DST and timezone changes.
- Verify small/medium/large layout with long Chinese/English titles, long locations, large text, light/dark/tinted appearance, and more than five daily courses.
- Add the Lock Screen widget on iOS 16+ (iPadOS 17+ on iPad); test privacy redaction and supported hardware's dimmed Always-On state.
- Tap course widgets with the app closed and open; confirm the enlarged detail appears first, including when the native URL arrives before Flutter listens. Verify title, location and time, then long-press the detail, choose “导航到上课地点”, and select Google/AMap/custom map. Delete that course and confirm an old widget tap handles the missing ID gracefully without opening any map.
- Confirm unsafe schemes, embedded credentials, invalid dates, duplicate IDs, reversed/overnight times and malformed JSON are rejected without data loss.
- Check that both signed targets contain the same registered App Group entitlement and their own bundled privacy manifest.

Official widget setup reference: [Creating a widget extension](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension).
