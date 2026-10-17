# Native widget host tests

This is a JVM Android host test using Robolectric 4.14.1 and its Android 15/API 35 instrumented framework. It executes the production Kotlin provider/cache classes and aapt2-linked binary resources, applies/reapplies actual `RemoteViews`, renders with Robolectric's native Android graphics, and writes PNG evidence. It is **not** an emulator/device/launcher test.

All data is synthetic. The suite currently contains 12 widget tests and 8 native back-policy tests, each executed in two separate JVMs. Tests cover:

- Empty-data provider update, hidden loading placeholder, bitmap and click-to-open intent.
- Small 180×180 and nominal 5×7-sized 350×490 logical host bounds, update/reapply, reconstruction.
- Enrolled/waitlisted and TBA accessibility text; overlapping and Sunday meetings.
- Once-only dates, excluded dates, term/date bounds, and week advancing without falsely classifying excluded courses as TBA.
- Shanghai events overlaid in a Toronto academic week, weekday conversion, midnight splitting, and omission of nonexistent DST wall times.
- Landscape-specific host bounds, corrupted-cache recovery, and successful reapply restoring a previously hidden grid.
- High-density bitmap allocation below 1 MiB.
- Fresh provider/views observing an updated or cleared disk cache.
- Two **separate JVM executions**, with the second provider reading a synthetic cache saved by the first.
- Native `MainActivity` back policy: consumed overlays, first-back toast, second-back task-background, two-second timeout, changed interaction serial, pending callback deduplication, typing reset, and destroyed-activity safety. The JavaScript response is supplied at the WebView callback boundary; this does not run a real Chromium renderer.

## Run

1. Build production Android classes/resources with `android/scripts/build-offline.sh` first, setting `ANDROID_HOME` and `GRADLE_HOME` as its instructions require. The normal APK alone is not enough: `app/build/offline-work` contains the JVM class files and binary resource APK used here.
2. From the repository root, prepare host dependencies:

   ```sh
   "$GRADLE_HOME/bin/gradle" -p android/tests/native-host prepareDependencies
   ```

3. Download the official Maven Central artifact `org.robolectric:android-all-instrumented:15-robolectric-12650502-i7` into a local directory as `android-all-instrumented-15-robolectric-12650502-i7.jar`, then set `ROBOLECTRIC_SDK_DIR` to that directory.
4. Run `android/tests/native-host/run.sh`.

`run.sh` uses the JDK's `com.sun.tools.javac.Main` entry point, so it also works with this environment's Java distribution where the compiler module is present but a `javac` executable is not. Gradle 8.13 supplies Kotlin stdlib 2.0.21, matching the offline production build.

The runner snapshots the production JVM jar, resources and assets before running so a concurrent later APK rebuild cannot erase inputs between the two JVMs. Input hashes are recorded in `build/production-inputs-sha256.txt`.

Results are in ignored `build/results-seed.txt` and `build/results-reload.txt`. Native PNGs are in ignored `build/screenshots/`. A temporary synthetic persistence directory is cleaned after both JVMs finish. Optional `ROBOLECTRIC_MAVEN_PROXY` selects a local Maven mirror with `/central` and `/google` paths for restricted-network environments.

## Remaining device checks

A real launcher is still needed to verify picker preview, pin flow, actual 5×7 cell sizing, long-press resize affordances, OEM-specific behavior, refresh after system process death/reboot, and daily update scheduling. Host tests cannot establish those properties.
