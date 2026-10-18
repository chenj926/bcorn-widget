# Native widget host tests

This is a JVM Android host test using Robolectric 4.14.1 and its Android 15/API 35 instrumented framework. It executes the actual AGP production app classes, resolved SDK runtime and aapt2-linked binary resources, applies/reapplies actual `RemoteViews`, renders with Robolectric's native Android graphics, and writes PNG evidence. It is **not** an emulator/device/launcher test.

The verified 2026-10-18 frozen production run passed 157 tests in each of two independent JVMs (314 executions).

All data is synthetic. The runner discovers all `*Test.java` classes, including 20 widget/cache and 4 widget deep-link cases plus the calendar, back/insets, grade-storage, and grade-sync tests. It runs the suite in two separate JVMs. Consult the current result files for actual pass counts; newly written tests and earlier builds are not current production verification. Tests cover:

- Empty-data provider update, hidden loading placeholder, bitmap and click-to-open intent.
- Small 180×180 and nominal 5×7-sized 350×490 logical host bounds, update/reapply, reconstruction.
- Enrolled/waitlisted and TBA accessibility text; overlapping and Sunday meetings.
- Once-only dates, excluded dates, term/date bounds, and week advancing without falsely classifying excluded courses as TBA.
- Shanghai events overlaid in a Toronto academic week, weekday conversion, midnight splitting, and omission of nonexistent DST wall times.
- Landscape-specific host bounds, corrupted-cache recovery, and successful reapply restoring a previously hidden grid.
- High-density bitmap allocation below 1 MiB.
- Fresh provider/views observing an updated or cleared disk cache.
- Actual previous/next/today/day-week PendingIntent broadcasts delivered through the registered receiver queue, independent per-widget persisted mode and selected date, one/seven-day stepping, Today retaining mode, migration from legacy Monday strings, overlapping restored IDs, four non-overlapping 48dp targets, and exact selected-date/mode Activity deep links. Narrow widths use two control rows; the day agenda renders room/time and explicit overflow without a WebView.
- Seven-day compact agenda, Sunday event / custom color / holiday background and a one-off outside its teaching term.
- Root system-bar/cutout/IME inset geometry without WebView padding; a plain match-parent sibling checks the root geometry because Robolectric's dummy WebView provider does not implement Chromium layout.
- Separate gradebook AtomicFile persistence, bounded strict schema/field validation, rejected updates preserving good data, and backup recovery.
- Real MainActivity JS interface → serial native gateway → ContentResolver → synthetic provider, exercising explicit permission/selection, repeated saves, reminders, sibling events, Activity recreation, revocation and calendar removal. No live account is read or written.
- Native Google AuthorizationClient request construction using synthetic SDK tasks, scope restriction, native Picker parameters, deferred/cancelled consent, exact bound-file transport routes, account fingerprint checks, sticky cancellation, quota/permission/401 handling, mapped-cell preflight/readback, exact new-template initialization, connection isolation, encrypted private journal integrity and disk-executor dispatch. There are no live accounts, tokens or network requests.
- Two **separate JVM executions**, with the second provider reading a synthetic cache saved by the first.
- Native `MainActivity` back policy: consumed overlays, first-back toast, second-back task-background, two-second timeout, changed interaction serial, pending callback deduplication, typing reset, and destroyed-activity safety. The JavaScript response is supplied at the WebView callback boundary; this does not run a real Chromium renderer.

## Run

1. Build the current production sources with standard AGP `:app:assembleDebug` first, setting `ANDROID_HOME`, `GRADLE_HOME` and the writable Android/Java user homes required by your environment. Debug signing is disabled; the expected artifact is `app/build/outputs/apk/debug/app-debug-unsigned.apk`. The runner uses that APK, the AGP Kotlin/Java class directories, the generated R jar, merged manifest and merged recursive assets. It fails rather than substituting the retired manual/offline class build.
2. From the repository root, prepare host dependencies:

   ```sh
   "$GRADLE_HOME/bin/gradle" -p android/tests/native-host prepareDependencies
   ```

3. Download the official Maven Central artifact `org.robolectric:android-all-instrumented:15-robolectric-12650502-i7` into a local directory as `android-all-instrumented-15-robolectric-12650502-i7.jar`, then set `ROBOLECTRIC_SDK_DIR` to that directory.
4. Run `android/tests/native-host/run.sh` with the same Gradle user home used by the successful app build. If that build used an already-authorized repository init script, pass its path in `BCORN_GRADLE_INIT`. The runner exports the exact resolved `debugRuntimeClasspath` using an offline Gradle task; it never restores missing production dependencies or uses SDK stubs.

`run.sh` uses the JDK's `com.sun.tools.javac.Main` entry point, so it also works with this environment's Java distribution where the compiler module is present but a `javac` executable is not. Gradle 8.13 supplies Kotlin stdlib 2.0.21, matching the production Kotlin plugin. AGP still requires a complete JDK with real `java` and `javac` executables; a runtime image that contains compiler modules but omits the executable does not pass Gradle toolchain validation. Set `JAVA_HOME` and `PATH` to the same full JDK used for the app build.

The runner snapshots the production JVM jar, resources and assets before running so a concurrent later APK rebuild cannot erase inputs between the two JVMs. Input hashes are recorded in `build/production-inputs-sha256.txt`.

Results are in ignored `build/results-seed.txt` and `build/results-reload.txt`. Native PNGs are in ignored `build/screenshots/`. A temporary synthetic persistence directory is cleaned after both JVMs finish. Optional `ROBOLECTRIC_MAVEN_PROXY` selects a local Maven mirror with `/central` and `/google` paths for restricted-network environments.

## Remaining device checks

A real launcher is still needed to verify picker preview, pin flow, actual 5×7 cell sizing, long-press resize affordances, OEM-specific behavior, refresh after system process death/reboot, and daily update scheduling. Host tests cannot establish those properties.
