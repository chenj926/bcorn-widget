#!/usr/bin/env bash
# Executes production Kotlin and aapt2-linked resources on Robolectric Android 15.
# No device/emulator claim: launcher behavior still needs a real Android host.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ANDROID="$(cd "$HERE/../.." && pwd)"
: "${ANDROID_HOME:?Set ANDROID_HOME to Android SDK platform 35}"
: "${GRADLE_HOME:?Set GRADLE_HOME to Gradle 8.13 (Kotlin stdlib 2.0.21)}"
: "${ROBOLECTRIC_SDK_DIR:?Directory containing android-all-instrumented-15-robolectric-12650502-i7.jar}"
OUT="$HERE/build"
SOURCE="$ANDROID/app/build/offline-work"
PRODUCTION="$OUT/production-inputs"
# Freeze one successful production build so a later rebuild cannot erase classes between JVMs.
mkdir -p "$PRODUCTION"
cp "$SOURCE/app.jar" "$SOURCE/resources.ap_" "$SOURCE/AndroidManifest.xml" "$PRODUCTION/"
rm -rf "$PRODUCTION/assets"
cp -R "$SOURCE/assets" "$PRODUCTION/assets"
sha256sum "$PRODUCTION/app.jar" "$PRODUCTION/resources.ap_" > "$OUT/production-inputs-sha256.txt"
mkdir -p "$OUT/classes" "$OUT/resources/com/android/tools"
printf 'android_merged_manifest=%s/AndroidManifest.xml\nandroid_merged_resources=%s/app/src/main/res\nandroid_merged_assets=%s/assets\nandroid_resource_apk=%s/resources.ap_\nandroid_custom_package=com.acorn.widget\n' "$PRODUCTION" "$ANDROID" "$PRODUCTION" "$PRODUCTION" > "$OUT/resources/com/android/tools/test_config.properties"
DEPS=$(find "$OUT/deps" "$OUT/aar" -name '*.jar' -printf '%p:' | sed 's/:$//')
CP="$DEPS:$GRADLE_HOME/lib/kotlin-stdlib-2.0.21.jar:$PRODUCTION/app.jar:$OUT/classes:$OUT/resources"
java com.sun.tools.javac.Main -source 17 -target 17 -cp "$CP:$ANDROID_HOME/platforms/android-35/android.jar" -d "$OUT/classes" "$HERE"/src/test/java/com/acorn/widget/*.java
CACHE=$(mktemp -d /tmp/acorn-native-host-cache.XXXXXX)
trap 'rm -rf "$CACHE"' EXIT
for PHASE in seed reload; do
  java -Xmx2g -Drobolectric.offline=true -Drobolectric.dependency.dir="$ROBOLECTRIC_SDK_DIR" -Djava.awt.headless=true -Dtest.phase="$PHASE" -Dprocess.cache.dir="$CACHE" -Devidence.dir="$OUT/screenshots" -cp "$CP:$ANDROID_HOME/platforms/android-35/android.jar" org.junit.runner.JUnitCore com.acorn.widget.NativeWidgetHostTest com.acorn.widget.NativeBackPolicyTest | tee "$OUT/results-$PHASE.txt"
done
