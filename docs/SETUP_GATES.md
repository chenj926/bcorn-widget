# Configuration and installation gates

Source-level tests and synthetic provider tests do not establish a live Google, Microsoft, Windows or Vivo connection.

## Android update identity

The installed 0.2.0 app used package `com.acorn.widget` and a private debug signing key that is currently unavailable. Reusing the package name with a new key cannot update that app. Do not uninstall it or clear its data to make a new build install.

1. Recover the original private signing key from a legitimate backup, if one exists, and verify its signing certificate against the installed/released APK before signing an update.
2. If recovery is impossible, ask the user to approve a separate migration plan. A parallel package can keep the old app intact while the user exports their edited timetable JSON and imports it into the replacement. Do not silently rename the package or generate a substitute key.
3. Verify imported room/address edits, dates, exceptions, status and transcript data before the user considers retiring the old app. Existing launcher widgets belong to the original package and must be recreated for a parallel app.

The user has approved the parallel-install route: Android 0.3.1 uses `com.bcorn.widget`, while the old app remains `com.acorn.widget`. See [parallel migration](ANDROID_PARALLEL_INSTALL.md) and [Windows local signing](WINDOWS_LOCAL_SIGNING.md). No cloud signing key is generated. Current unsigned APKs are compile/test evidence only. No real on-device upgrade or migration has been verified.

Version 0.2.0 already has “备份全部数据…” in its menu, exporting the current timetable/history JSON including subsequent room/address edits. The user must export that current state; an original import file does not contain later changes. Version 0.3.0 adds a versioned full backup with assessment grades and whitelisted display/map preferences. It excludes credentials, cloud bindings, remote owned event IDs and sync journals. Import defaults to preserving current assessment grades unless the user separately opts into replacement. Calendar updates pause; replaced grades also pause their prior synchronization target. Reconfirm connections explicitly after checking the restored data.

Individual local stores use atomic writes; a multi-store restore uses compensating rollback on ordinary errors and reports rollback failure. It is not a cross-file crash-atomic transaction. Keep the exported backup and original app until verification is complete.

For future releases, the signing key must be created only with explicit approval in a user-controlled secure signing environment, retained in encrypted persistent storage with an independent offline backup. Keep passwords and key files out of source control, chat and build artifacts; record only the certificate fingerprint and nonsecret release metadata alongside the source.

## Google grade synchronization

The application requests access only to files it creates or the user explicitly opens through the granted `drive.file` access. The user can create a new human-readable grade spreadsheet for an explicitly chosen course, or use the official system-browser Google Picker to select an existing file. Existing templates require read-only bounded preview and explicit cell mapping; no unrelated file is automatically selected. Legacy dedicated 14-column bindings remain supported.

- A Google Cloud project must enable the Sheets and Drive APIs and configure its OAuth consent/test-user settings.
- Windows requires an installed-desktop OAuth client configured for the build. Its system-browser flow uses PKCE, state and a loopback callback. Configuration must not be committed with private credentials.
- Android requires an Android OAuth client registered to the final application ID and the actual signing certificate, plus working Google Play services. A Vivo device without those services cannot use this Google native authorization path merely because the app compiles.
- Only after that configuration is verified should the Android `GRADE_SYNC_CONFIGURED` build flag be enabled. It is false in this source baseline.
- The user initiates and approves the provider authorization on their own device. Development tests do not create grants or sign in as the user.

While the app is visible, it checks lightweight version metadata adaptively and reads the sheet when changed. Local edits synchronize automatically. Hidden/offline/paused state stops new work; reopening resumes reconciliation. Cancellation cannot recall bytes already sent, so journals and readback handle uncertain writes. No server or always-running background synchronization is required.

## Calendar routes

Android uses the device CalendarProvider after explicit calendar permission and selection of a writable target. Google, Outlook and OEM account availability depends on the actual device provider. A successful provider write is not proof that an account cloud or alarm delivered it.

Windows cloud-calendar integration has separate provider clients and authorization scopes. Grade `drive.file` authorization does not authorize Google Calendar, Microsoft Graph or any calendar write. See the provider-specific implementation documentation for its current configuration and verification status. Never describe a manually exported ICS file as automatic calendar synchronization.

## Device acceptance still required

Actual launcher resizing, system WebView/IME insets, Windows WebView2 behavior, provider authorization, account propagation and notification delivery require a configured device test. Synthetic host/DOM tests are useful evidence for code paths but do not replace these checks.
