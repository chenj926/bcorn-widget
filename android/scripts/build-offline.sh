#!/usr/bin/env bash
# Dependency-free fallback using official Android build-tools and the Kotlin compiler shipped with Gradle.
# Tools must already be installed and their licenses accepted. Never downloads or accepts terms.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ANDROID_HOME:?Set ANDROID_HOME to an installed SDK with platform 35 and build-tools 35.0.0}"
: "${GRADLE_HOME:?Set GRADLE_HOME to the official Gradle 8.13 distribution (bundles Kotlin 2.0.21)}"
BT="$ANDROID_HOME/build-tools/35.0.0"
JAR="$ANDROID_HOME/platforms/android-35/android.jar"
FINAL="$ROOT/app/build/offline"
OUT="$ROOT/app/build/offline-work"
rm -rf "$OUT"
mkdir -p "$OUT"/{gen,classes,assets/src/renderer,assets/src/shared,dex}
cp "$ROOT"/../src/renderer/* "$OUT/assets/src/renderer/"
rm -f "$OUT/assets/src/renderer/mock.js"
cp "$ROOT"/../src/shared/*.js "$OUT/assets/src/shared/"
cp "$ROOT/app/src/main/assets/"* "$OUT/assets/"
sed 's/<manifest /<manifest package="com.acorn.widget" /' "$ROOT/app/src/main/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BT/aapt2" compile --dir "$ROOT/app/src/main/res" -o "$OUT/resources.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$OUT/AndroidManifest.xml" --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 0.1.0 --java "$OUT/gen" -A "$OUT/assets" -o "$OUT/resources.ap_" "$OUT/resources.zip"
java com.sun.tools.javac.Main -source 17 -target 17 -classpath "$JAR" -d "$OUT/classes" "$OUT/gen/com/acorn/widget/R.java"
java -cp "$GRADLE_HOME/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath "$JAR:$GRADLE_HOME/lib/kotlin-stdlib-2.0.21.jar:$OUT/classes" -d "$OUT/classes" "$ROOT"/app/src/main/java/com/acorn/widget/*.kt
(cd "$OUT/classes" && zip -q -r "$OUT/app.jar" .)
"$BT/d8" --min-api 26 --lib "$JAR" --output "$OUT/dex" "$OUT/app.jar" "$GRADLE_HOME/lib/kotlin-stdlib-2.0.21.jar"
cp "$OUT/resources.ap_" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -u "$OUT/unsigned.apk" classes*.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
# Debug-only local key. Not a release identity and never checked into version control.
KEY="$ROOT/app/build/local-debug.keystore"
if [ ! -f "$KEY" ]; then
  keytool -genkeypair -keystore "$KEY" -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KEY" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$OUT/acorn-android-debug.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --verbose "$OUT/acorn-android-debug.apk"
# Replace the final artifact only after the new package is built and verified.
mkdir -p "$FINAL"
cp "$OUT/acorn-android-debug.apk" "$FINAL/acorn-android-debug.apk.tmp"
mv -f "$FINAL/acorn-android-debug.apk.tmp" "$FINAL/acorn-android-debug.apk"
sha256sum "$FINAL/acorn-android-debug.apk"
