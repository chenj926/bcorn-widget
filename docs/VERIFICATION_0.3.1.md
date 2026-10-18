# Android 0.3.1 parallel-install verification

Date: 2026-10-18. Base feature commit: `332d5d84c34bcb2196a64754320f966cf9cf0b70`.

## Verified

- Official Temurin JDK 21, Gradle 8.13, Android Platform 35 / Build Tools 35.0.0.
- `:app:assembleDebug :app:assembleRelease`: passed, 77 tasks.
- Actual AGP APK/classes/resources host runner: 160 cases in each of two independent JVMs (320 executions), all passed. Three new tests exercise installed identity, applied RemoteViews/explicit PendingIntents and synthetic legacy storage roundtrip.
- 175 Node/shared/native-bridge/source-contract tests passed, including six Windows signing source checks.
- All eight DOM integration suites passed, including legacy backup import and edited address preservation. DOM tests do not establish physical screen geometry or live provider behavior.
- Release merged-manifest validator passed: separate installed ID, explicit component classes, package-scoped merged authorities, no shared UID, OAuth disabled, non-debuggable.
- `aapt2 dump badging`: package `com.bcorn.widget`, version 0.3.1 / code 4, label `bcorn`, min SDK 26 / target 35.
- `apksigner verify` correctly rejects the unsigned release. No private signing key has been generated.

## Unsigned release artifact

- File: `app-release-unsigned.apk`
- Bytes: `2940003`
- SHA-256: `79ac682dc18a0610e6fc9c43b07d46f05d3c1fd5eb4e893f32f7a84adf85e908`

This APK is not installable until signed on the owner's persistent computer. The Windows handoff contains official-tool instructions and a local signing script; it contains no tool binaries, private keys or passwords.

## Not verified / remaining gates

- Actual Windows PowerShell parsing, interactive password prompts, filesystem ACL behavior and completed local signing have not run in this Linux environment. Source-contract tests and independent review are not runtime proof.
- No physical Vivo/Android install, two-app coexistence, launcher migration or reminder delivery test has occurred. Keep the old `com.acorn.widget` app and its latest JSON backup.
- Persistent key custody and independent backup must be established locally. Matching backup bytes do not prove durable retention.
- Google OAuth remains unconfigured; new package and eventual certificate require explicit registration. No live grants, original Sheet writes or calendar writes were performed.
- Existing feature limitations in `REQUIREMENTS_STATUS.md` and `SETUP_GATES.md` still apply.
