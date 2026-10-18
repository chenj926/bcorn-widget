#!/usr/bin/env bash
# Build from previously restored official Gradle dependencies, without downloading.
# OAuth SDK AAR manifests/resources must be merged by AGP; a hand-assembled APK is unsafe.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--unsigned" ]; }; then
  echo "Usage: $0 [--unsigned]. Signed updates require the original private key and a separately configured release build." >&2
  exit 1
fi
: "${ANDROID_HOME:?Set ANDROID_HOME to the installed Android SDK}"
: "${GRADLE_HOME:?Set GRADLE_HOME to the installed official Gradle distribution}"
"$GRADLE_HOME/bin/gradle" -p "$ROOT" :app:assembleDebug --offline --no-daemon
SOURCE="$ROOT/app/build/outputs/apk/debug/app-debug-unsigned.apk"
[ -f "$SOURCE" ] || { echo "Expected unsigned APK was not produced; refusing to substitute another artifact." >&2; exit 1; }
FINAL="$ROOT/app/build/offline"
mkdir -p "$FINAL"
cp "$SOURCE" "$FINAL/acorn-android-unsigned.apk.tmp"
mv "$FINAL/acorn-android-unsigned.apk.tmp" "$FINAL/acorn-android-unsigned.apk"
sha256sum "$FINAL/acorn-android-unsigned.apk"
