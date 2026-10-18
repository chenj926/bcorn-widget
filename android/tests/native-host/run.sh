#!/usr/bin/env bash
# Tests actual unsigned AGP production classes/resources and its resolved Google/OkHttp graph.
# No device/emulator or live OAuth claim. Assemble the current source with Gradle first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ANDROID="$(cd "$HERE/../.." && pwd)"
: "${ANDROID_HOME:?Set ANDROID_HOME to Android SDK platform 35}"
: "${GRADLE_HOME:?Set GRADLE_HOME to Gradle 8.13 (Kotlin stdlib 2.0.21)}"
: "${ROBOLECTRIC_SDK_DIR:?Directory containing android-all-instrumented-15-robolectric-12650502-i7.jar}"
OUT="$HERE/build"
PRODUCTION="$OUT/production-inputs"
KOTLIN="$ANDROID/app/build/tmp/kotlin-classes/debug"
APK="$ANDROID/app/build/outputs/apk/debug/app-debug-unsigned.apk"
MANIFEST="$ANDROID/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml"
RJAR="$ANDROID/app/build/intermediates/compile_and_runtime_not_namespaced_r_class_jar/debug/processDebugResources/R.jar"
ASSETS="$ANDROID/app/build/intermediates/assets/debug/mergeDebugAssets"
for PATH_REQUIRED in "$APK" "$MANIFEST" "$RJAR" "$KOTLIN" "$ASSETS/src/shared/sync-adapters/native-client.js"; do
  [ -e "$PATH_REQUIRED" ] || { echo "Missing verified AGP input: $PATH_REQUIRED. Run :app:assembleDebug with current production sources first." >&2; exit 1; }
done
# Repository override/init flags can be supplied only by the caller's existing authorized setup.
# Offline prevents dependency restoration or software/network changes while testing frozen inputs.
INIT=()
if [ -n "${BCORN_GRADLE_INIT:-}" ]; then INIT=(-I "$BCORN_GRADLE_INIT"); fi
"$GRADLE_HOME/bin/gradle" -p "$ANDROID" --offline --no-daemon "${INIT[@]}" -I "$HERE/export-runtime.gradle" :app:exportNativeHostRuntime
mkdir -p "$PRODUCTION"
rm -rf "$PRODUCTION/classes" "$PRODUCTION/assets" "$OUT/classes"
mkdir -p "$PRODUCTION/classes" "$OUT/classes" "$OUT/resources/com/android/tools"
cp -R "$KOTLIN/." "$PRODUCTION/classes/"
JAVA="$ANDROID/app/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes"
if [ -d "$JAVA" ]; then cp -R "$JAVA/." "$PRODUCTION/classes/"; fi
(cd "$PRODUCTION/classes" && java sun.tools.jar.Main xf "$RJAR" && java sun.tools.jar.Main cf "$PRODUCTION/app.jar" .)
cp "$APK" "$PRODUCTION/resources.ap_"
cp "$MANIFEST" "$PRODUCTION/AndroidManifest.xml"
cp -R "$ASSETS" "$PRODUCTION/assets"
sha256sum "$PRODUCTION/app.jar" "$PRODUCTION/resources.ap_" > "$OUT/production-inputs-sha256.txt"
printf 'android_merged_manifest=%s/AndroidManifest.xml\nandroid_merged_resources=%s/app/src/main/res\nandroid_merged_assets=%s/assets\nandroid_resource_apk=%s/resources.ap_\nandroid_custom_package=com.acorn.widget\n' "$PRODUCTION" "$ANDROID" "$PRODUCTION" "$PRODUCTION" > "$OUT/resources/com/android/tools/test_config.properties"
DEPS=$(find "$OUT/production-runtime" "$OUT/deps" "$OUT/aar" -name '*.jar' -printf '%p:' | sed 's/:$//')
CP="$DEPS:$GRADLE_HOME/lib/kotlin-stdlib-2.0.21.jar:$PRODUCTION/app.jar:$OUT/classes:$OUT/resources"
java com.sun.tools.javac.Main -source 17 -target 17 -cp "$CP:$ANDROID_HOME/platforms/android-35/android.jar" -d "$OUT/classes" "$HERE"/src/test/java/com/acorn/widget/*.java
CACHE=$(mktemp -d /tmp/acorn-native-host-cache.XXXXXX)
trap 'rm -rf "$CACHE"' EXIT
TESTS=$(find "$HERE/src/test/java/com/acorn/widget" -name '*Test.java' -printf 'com.acorn.widget.%f\n' | sed 's/\.java$//' | sort | tr '\n' ' ')
for PHASE in seed reload; do
  java -Xmx2g -Drobolectric.offline=true -Drobolectric.dependency.dir="$ROBOLECTRIC_SDK_DIR" -Djava.awt.headless=true -Dtest.phase="$PHASE" -Dprocess.cache.dir="$CACHE" -Devidence.dir="$OUT/screenshots" -cp "$CP:$ANDROID_HOME/platforms/android-35/android.jar" org.junit.runner.JUnitCore $TESTS | tee "$OUT/results-$PHASE.txt"
done
