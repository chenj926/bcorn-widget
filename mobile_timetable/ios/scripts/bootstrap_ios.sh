#!/usr/bin/env bash
# Run from macOS with Flutter 3.41+ and Xcode installed. This does not sign/build.
set -euo pipefail
ios_root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "iOS scaffolding requires macOS. Native sources are present; no iOS build was attempted." >&2
  exit 1
fi
command -v flutter >/dev/null || { echo "Install Flutter 3.41+ and add flutter to PATH." >&2; exit 1; }
command -v ruby >/dev/null || { echo "Ruby is required for Xcode project configuration." >&2; exit 1; }
if ! ruby -e 'require "xcodeproj"' 2>/dev/null; then
  echo "Install the xcodeproj Ruby gem (often present with CocoaPods), then rerun:" >&2
  echo "  gem install --user-install xcodeproj" >&2
  echo "Alternatively use the manual Xcode steps in ios/README.md." >&2
  exit 1
fi

if [[ ! -d "$ios_root/Runner.xcodeproj" ]]; then
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  cp -R "$ios_root/Runner" "$temporary/Runner-custom"
  flutter create --no-pub --platforms=ios --org io.bcorn --project-name bcorn_mobile "$temporary/host"
  cp -R "$temporary/host/ios/." "$ios_root/"
  cp -R "$temporary/Runner-custom/." "$ios_root/Runner/"
fi

ruby "$ios_root/scripts/configure_xcode.rb"
echo "Xcode targets configured. Read ios/README.md to select signing teams and register App Groups."
echo "Next: flutter pub get, then flutter build ios --simulator."
