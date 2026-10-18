# Android parallel installation and local signing

## Package identity

The migration build is **bcorn 0.3.1 / version code 4**, application ID **`com.bcorn.widget`**. The old application remains **`com.acorn.widget`**. The Kotlin/resource namespace remains `com.acorn.widget`; it is not the installed identity. Release builds are non-debuggable and unsigned until the separate local signing step. No shared UID or cross-package data access is used.

The old app must remain installed. Its latest “备份全部数据…” JSON is the migration source; an original import file does not contain later room/address edits. Import uses the normal preview/confirmation flow, preserves all supported course/event/history fields, and does not transfer OAuth credentials or remote ownership journals. Newer complete backups also support the separate assessment book, with replacement explicitly selected.

After installing the parallel app, import the saved JSON and check course counts, room/address edits, dates, exceptions, status and historical grades. Recreate the launcher widget for the new app. The apps retain the same visible name, so use Android App info's package identifier to distinguish them before retiring anything. Do not uninstall or clear the old app as part of this procedure.

## Build and verify before signing

Use official JDK 17+, Android SDK Platform/Build Tools 35, Gradle 8.13 and the existing accepted SDK licenses:

```sh
gradle -p android :app:assembleDebug :app:assembleRelease
python3 android/scripts/check-release-identity.py android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml
```

The installation candidate is `android/app/build/outputs/apk/release/app-release-unsigned.apk`. Debug builds remain unsigned and are used by the exact-package host test runner. Neither artifact is an installable signed release yet.

## Persistent local signing handoff

The ephemeral cloud workspace is not safe long-term key custody. This repository contains no private key, password or keystore. The owner must use their persistent computer or an explicitly configured secure signing environment. Generating a key here without a durable custody route would repeat the previous lost-key problem.

The Windows handoff uses the built-in PowerShell launcher described in [Windows local signing](WINDOWS_LOCAL_SIGNING.md), with official JDK and Android build tools. It has no Python dependency and does not override execution policy or bypass security warnings. Password creation and entry occur in the owner's local terminal through the official signing tools. No key has been created in this cloud environment.

The handoff package contains only the unsigned APK, its public digest/identity metadata, launch scripts and instructions. The private signing identity and encrypted backup must remain outside that package, temporary folders and the source repository. Record only the public certificate fingerprint alongside release metadata. Two folders on one disk are not an independent backup; local file existence or matching hashes do not prove future recoverability. The owner must verify the actual backup destination.

## Configuration and acceptance gates

Google OAuth remains disabled/unconfigured. The new Android application ID and its eventual signing certificate require their own authorized Google client registration; that is not created by changing the package or signing the APK. No OAuth grants, original Sheet edits or live calendar changes are part of migration packaging.

Synthetic native/renderer tests do not prove physical Vivo coexistence, launcher behavior, notifications or live Google authorization. The final signed APK's package/version/certificate and hash must be verified before installation. Installation itself is not performed by this script.
