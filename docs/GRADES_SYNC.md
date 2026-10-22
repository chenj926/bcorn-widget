# Assessment grades and automatic two-way synchronization

## What is implemented

- `src/shared/grade-book.js`: pure grade input, validation, immutable edits, metrics and whitelist persistence normalization. Independent of the ACORN transcript and timetable.
- `src/renderer/grades-ui.js` / `grades.css`: local course/assessment editor, actual graded zero versus ungraded, fractional/decimal scores, explicit rule confirmation, storage error handling and unsaved-input guard.
- `src/shared/sync-coordinator.js`: durable intent before outbound writes, automatic outbound edits, automatic inbound notification/resume/reconnect handlers, three-way object merge, conflict preservation, explicit tombstones, readback verification, transient retry backoff, authorization revocation and restart recovery. No background polling; mode A adds bounded visible-only polling.
- `src/shared/sync-adapters/sheet-mapping.js` / `src/renderer/sheet-mapping-ui.js`: explicit existing-template preview/mapping, compact single-open assessment editor, mapped-grade/weight-only writes, label/formula/protection checks and version caching.
- `src/shared/sync-adapters/google-sheets.js`: legacy dedicated-tab request/response Sheets adapter against one explicitly confirmed tab; exact schema, bounded reads, RAW cell writes and readback. Authorized native transport is injected, never a token in renderer JS.
- `src/shared/sync-adapters/foreground-sync.js`: user-selected mode A, 15–120 second adaptive foreground checks, no concurrent requests, hidden/offline/revoked suspension and resume/reconnect catch-up.
- `src/shared/sync-adapters/native-client.js`: safe connection-scoped native binding and lifecycle events; credentials remain native.
- `src/shared/sync-adapters/grade-sync.js`: book-to-record mapping including empty courses, private recovery journal, local-save-first flow, remote materialization and event subscription.

A passing simulated transport test is **not** a successful Google OAuth or production push test. Until native authorization, a chosen/new Sheet, and foreground reconciliation are configured, the UI must say "not configured". Local grades remain fully usable.

## Domain contract

`GradeBook.normalizeBook(book)` returns a whitelist-only version-1 book or throws. Persist:

```js
{ schemaVersion: 1, courses: [{
  id, title, termId,
  rules: { kind: 'weighted' /* or 'unconfirmed' */ },
  assessments: [{ id, title, weight: 0.1,
    status: 'graded', // ungraded | graded | exempt
    score: { mode: 'points', earned: 40.5, possible: 50 }
    // or { mode: 'ratio', value: 0.81 }; null for ungraded/exempt
  }]
}] }
```

IDs are stable, never course display names or row numbers. An assessment ID is unique within its course. Course IDs are unique within the book. Native envelope limit: 2 MiB, 500 courses and 1000 assessments per course. The legacy dedicated-tab adapter additionally bounds its selected tab to 1000 data rows (course metadata rows count). Existing-template mappings use an explicitly disclosed A1:Z200 region; new readable templates allow up to 190 assessments.

Plain grade input `0.8` means 80%; `80%` and `40/50` are also accepted. The UI has a separate percentage-weight input. No arbitrary formulas are evaluated. Stored numbers preserve precision; presentation alone is rounded. Nonfinite values, zero denominators, negative scores, implicit bonus marks and unknown score modes are rejected.

For ordinary weighted grading, weights are fractions of total course grade:

- `earnedContribution = sum(weight * scoreRatio)` for graded items.
- `gradedWeight = sum(weight)` for graded items, **including graded zeroes**.
- `currentAverage = earnedContribution / gradedWeight`, or null when none is graded.
- `pendingWeight = sum(weight)` for ungraded items.
- With a confirmed ordinary scheme totaling 100%, `maximumFinal = earnedContribution + pendingWeight`.

Synthetic example: a 10%-weight assignment scored 80%, a 20%-weight exam scored zero, and 70% ungraded produce 26.67% graded-to-date, 8 percentage points earned toward the final grade, and 70% awaiting grades. Never count unknown work as a graded zero.

Drop-lowest, bonus, replacement, minimum-exam requirements, category-level averaging and exemptions are **not inferred**. Unsupported/unknown rules stay unconfirmed. Incomplete/excess total weights are not normalized; final projections are unavailable. Exempt nonzero weights require explicit syllabus-directed redistribution. These calculated grades never replace an official transcript or infer institution-specific GPA policy.

## Sheet ownership and schema

The user-provided historical/reference workbook is read-only. No ID, actual grades, copied personal data, credentials or account identifiers are in repository fixtures. The app supports explicitly selecting an existing human-readable template with the native Google Picker, or creating a new readable course template from user-entered syllabus weights and grades. It never rewrites a workbook into the legacy machine schema. The particular reference workbook supplied for development remains read-only; this is distinct from generic future files the user explicitly selects and confirms for synchronization.

`BcornSheets.templateRequest(title, tab)` constructs a creation request; merely calling it does not send anything. The native setup action must obtain permission and execute the request using the app's own grant.

### Legacy dedicated-tab compatibility

The older dedicated tab remains supported and has exact headers:

```
recordId | type | courseId | courseTitle | term | assessmentId | assessment | weight | status | scoreMode | ratio | earned | possible | rule
```

- `type=course`: course metadata including explicit grading rule. One row per course, even without assessments.
- `type=assessment`: score/weight/status. Stable recordId is derived from course and assessment IDs.
- `type=deleted`: retained tombstone, enabling safe eventual deletion on other devices.
- `weight` and `ratio` are numeric fractions. Sheets may display them as percentages; RAW writes prevent text beginning with `=` from becoming a formula.
- Do not edit stable IDs, change headers, physically delete rows, or move rows out of the bounded tab. Such changes are rejected or flagged for relinking, never silently treated as a destructive user request.
- A genuinely missing remote row blocks its pending update. The app cannot infer whether it was deleted, moved, hidden by a different mapping, or omitted by a faulty adapter.

The adapter reads the row again before writing and checks expected content, then reads back afterward. **Sheets values API has no atomic compare-and-swap**. An edit racing between preflight and write can still be overwritten. Strict multi-writer serializability requires a broker/locking or append-only protocol, and must not be claimed here. Deterministic stable-row writes avoid duplication when a response is lost; arbitrary concurrent row insertion/moves are not supported. Surface conflicts and retain local/remote/base snapshots.

### Existing and newly created readable templates

See [existing-sheet-mapping.md](existing-sheet-mapping.md) for exact schemas and safeguards. Select a file through the native Picker, select a tab, inspect the read-only A1:Z200 preview, and explicitly map assessment labels, grade cells, weight cells and units. Unknown layouts are not guessed. Formula/merged/protected destinations are rejected. Confirm ordinary weighted rules separately. Import confirmation identifies local course-ID collisions; unrelated local courses are preserved.

For a new file, first enter a course and its syllabus weights locally, then choose “为当前课程新建易读成绩表” and confirm creation. Native code builds fixed Assessment / Weight / Grade / Contribution columns and trusted summary formulas; formula destinations are never mapped for subsequent writes. Unsupported exemptions must be resolved before creating this template. The existing blank/zero/fraction distinction is retained.

A failed/stale connection confirmation remains blocked across restart. Selection drains the old service before changing account/file; only verified import or verified new-template content clears the transition block. During an incomplete mapping transition, legacy creation is disabled; recover by reselecting/confirming a mapping or creating a readable course template. Sheets lacks atomic compare-and-swap: avoid simultaneous editing of mapped cells and do not claim absolute multi-writer protection.

## Private stores and native bridge

Keep these stores separate:

1. `grades-v1.json`: normalized local gradebook; clearing timetable data must not erase it.
2. Connection-scoped synchronization journal: `{schemaVersion:1, coordinator, publishedBook}`. Contains grades, base snapshots, pending intents and conflicts. Treat as private data; never include in timetable export, logs, analytics or repository.
3. Native secure credential store: access/refresh credentials; never renderer storage or journal.
4. Explicit connection metadata: opaque connectionId, chosen account/file/tab, push subscription state. Switching account/file/tab requires a new connection ID and isolated journal, not replaying an old outbox against a new target.

Native bridge contract (implementation owners must agree on exact binding):

```js
loadGradeBook() -> book | null
saveGradeBook(book) -> { ok: true }
getGradeSyncStatus() -> {
  state: 'not-configured' | 'authorization-required' | 'ready' | 'revoked',
  connectionId, deviceId,
  binding: { spreadsheetId, tab, confirmed: true }
    | { kind: 'mapped', mapping, tab, confirmed: true } | null,
  automaticInbound: boolean
}
loadGradeSyncState(connectionId) -> envelope | null
saveGradeSyncState(connectionId, envelope) -> { ok: true }
gradeSheetsRequest({ method, path, body }) -> { status, body, retryAfterMs? }
gradeSheetVersion() -> { version, modifiedTime? } // bound Drive file metadata, no renderer file ID
pickGradeSheet({}) -> { selectionId, title, sheets: [{ sheetId, tab }] }
previewGradeSheet({selectionId,sheetId}) -> boundedSnapshot
confirmGradeSheetMapping({selectionId,mapping}) -> nativeStatus
readMappedGradeSnapshot({connectionId}) -> boundedSnapshot
commitMappedGradeCells({connectionId,expectedSnapshot,writes}) -> {ok:true}
createMappedGradeSheet({course}) -> nativeStatus
onGradeRemoteChange(callback) -> unsubscribe // optional, not needed in selected mode A
```

The native HTTP transport must enforce an allowlist of supported Sheets routes, the authorized connection's spreadsheet ID, bounded request/response sizes, timeouts, HTTPS and secure token refresh. JavaScript cannot choose arbitrary URLs or accounts. A `ready` authorization state does not itself establish that automatic inbound push is configured.

## Selected delivery mode A: foreground automatic two-way sync

The user explicitly selected **A**: automatic synchronization while the app is open, with background/offline changes reconciled automatically at the next opening. This mode does not need a relay, FCM, an ID-token server login, a server-side credential vault or any hosted service.

- Local edits are stored immediately and queued for outbound synchronization automatically.
- When visible and online, `foreground-sync.js` checks at 15 seconds initially, then 30, 60 and at most 120 seconds after unchanged reads. User activity resets the interval to 15 seconds without postponing an already-nearer check. Changed data returns the cadence to 15 seconds.
- Each scheduled check uses the native bound Drive file version. An unchanged version reuses the in-memory snapshot without reading all grade rows. Changed versions and write preflight/readback perform bounded sheet reads.
- Remote edits normally appear within the next scheduled check (15–120 seconds plus network/processing time). This is an estimated cadence, not a provider latency guarantee.
- Visibility hidden, offline, revocation and disposal stop scheduled checks. The coordinator also suspends queued transport work and retry timers while inactive. A request already in flight may finish; no next request is started while inactive.
- Resume and reconnect request immediate reconciliation, subject to any server `Retry-After`. No manual refresh is required.
- Only one request cycle runs at a time; bursts coalesce. Network failures back off; quota retry times are honored. There is no permanent background service or idle background timer.
- Closed/force-stopped apps cannot synchronize until reopened. Local pending work survives process restart through private grade storage and the synchronization journal. Display actual last-sync and conflict/error states.

An optional future mode B can use Drive watch → HTTPS relay → FCM/desktop notification hints, but **it is not a dependency of mode A and is not enabled or deployed**. Any optional relay implementation has its own authorization, renewal, hosting and secret-storage obligations. Do not request those grants or deploy those components to finish mode A.

## Minimum production setup (no setup is performed by these modules)

1. Choose ownership/billing for a Google Cloud project. Enable Sheets, Drive and Google Picker APIs for the supported creation/selection flows. Configure OAuth consent, supported audience/test users and required privacy information. Use `drive.file`, not full Drive or all-spreadsheets scope.
2. Register Windows Desktop OAuth client; use external browser, PKCE, state validation and supported loopback redirect. Register Android client for the actual package name and signing-certificate SHA-1; verify Google Play services on the target OriginOS build. OAuth is performed by bcorn itself; assistant connectors do not grant bcorn access.
3. Request only `drive.file`. Existing-file selection uses the official native Picker flow: desktop system-browser OAuth adds `prompt=consent` and `trigger_onepick=true`; Android uses the supported Picker authorization resource parameter and excludes previously granted scopes. Validate selected file IDs and retain tokens natively. Do not mix Calendar or broad Drive/Sheets scopes into this flow. Request Calendar separately when needed.
4. Configure the native secure token store and connection-scoped private journal. No server credentials, FCM configuration, relay deployment or hosting spend is necessary for selected mode A.
5. In the app, either explicitly select an existing file/tab and confirm its manual mapping/import, or create a new readable course template after entering syllabus weights locally. Native setup verifies the selected file and mapping. Preview alone never authorizes writes or activates synchronization. The old 14-column dedicated-sheet action remains a compatibility route, not a required template format.
6. Verify both directions while visible: app edit → Sheet; Sheet edit → app within the adaptive cadence; concurrent edits → conflict; true zero/blank status; hidden/offline/restart/reconnect; revoke access; and account/file isolation. Verify the actual phone's foreground/visibility behavior, not only browser simulations.

Only actual OAuth client registration and the user's app grant require setup. Code implementation does not authorize creating live credentials or changing existing workbook permissions. Google receives explicitly synchronized grade data in the selected or newly created spreadsheet; no relay or third-party server receives grades in mode A.

## Official references

- Google Sheets scopes: https://developers.google.com/workspace/sheets/api/scopes
- Native Picker: https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
- Desktop OAuth: https://developers.google.com/identity/protocols/oauth2/native-app
- Android authorization: https://developer.android.com/identity/authorization
- Drive notifications/expiry: https://developers.google.com/workspace/drive/api/guides/push
- Android FCM receive behavior: https://firebase.google.com/docs/cloud-messaging/android/receive-messages

## Verification

`node --test tests/grade-*.test.js tests/sync-*.test.js tests/sheet-mapping*.test.js tests/grades-mapped-dom.test.js` covers pure domain, private storage, durable recovery, row protocol, two-way materialization, conflicts and revocation using synthetic data and injected transports. `CHROME_BIN=... node tests/grades-ui.cjs` exercises browser UI creation/editing/reload/dirty guards. Record actual executed results separately; mocked HTTP, browser UI, Android native host tests and real-device production OAuth/push are distinct evidence.

## Verified synthetic request budget and pause control

A ten-minute visible idle simulation performs eight metadata requests (initial plus seven timer wakeups) and only one full Sheet read. The following ten hidden minutes perform zero requests and timer wakeups. A changed-version resume performs one metadata request and one bounded Sheet read. These are deterministic synthetic counts, not phone power measurements.

The grade panel provides Pause/Resume automatic sync. Pause persists a nonsecret connection-scoped preference in local browser/WebView storage, retains local grades and journal, stops scheduled transport, and does not revoke the Google grant. Resume reconciles automatically. An already in-flight request can finish. Grant revocation is separately handled by native authorization errors or the Google account controls.

Validation commands: `node --test tests/grade-*.test.js tests/sync-*.test.js tests/desktop-grade-store.test.js`, `node tests/grades-dom.cjs`, and `node tests/grades-sync-dom.cjs`. The real renderer entrypoint is checked for executable module ordering. DOM tests execute actual UI and adapters with synthetic native storage/HTTP; they do not verify live OAuth, native build execution, physical device behavior, or browser layout.

## Android 0.3.2 build readiness (not an account connection)

Android defaults to Google sync disabled. Explicitly opt in only for an owner-operated test build:

```sh
./android/gradlew -p android :app:assembleRelease -PbcornGradeSyncConfigured=true
python3 android/scripts/check-release-identity.py android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml --expect-grade-sync true
```

Omit the property (or pass `false`) for the normal disabled build. Other values fail the build. The property sets the manifest metadata flag only; it does not create a Google project, OAuth client, grant, spreadsheet, or network connection. The enabled build still needs working Google Play services, owner-configured APIs/consent and Android OAuth registration for `com.bcorn.widget` plus the actual retained signing certificate SHA-1. This Android AuthorizationClient path does not consume an embedded client ID, client secret, API key or `google-services.json`; do not add them. Enable Google Picker API as well as Drive and Sheets in the project. Request only `drive.file`.

Both builds remain unsigned. Update the existing installed `com.bcorn.widget` using the SAME owner-held keystore, never a new key; 0.3.2 uses version code 5. Keep the historical `com.acorn.widget` and its data intact. Rebuilding or signing does not prove live Google authorization or sync. Test only an explicitly selected test copy, not the historical reference workbook.

Existing-sheet mapping reads only A1:Z200 and does not parse arbitrary review/status columns. Never infer that historical numeric zero means ungraded. Keep ambiguous source values intact in a separate review column/tab and leave those rows unmapped until the owner resolves them. Formula destinations cannot be mapped as editable grades/weights.

### Owner-operated Google Console setup

1. In the owner's Google Cloud project, enable Google Sheets API, Google Drive API, and Google Picker API.
2. Configure Google Auth platform Branding and Audience. For personal testing use External / Testing and add the owner's Google account as a test user. Set Data Access to the `https://www.googleapis.com/auth/drive.file` scope used by this app; do not replace it with full-Drive access.
3. Create an OAuth client of type Android with package `com.bcorn.widget` and SHA-1 from the SAME certificate already used for the installed app. Inspect the locally signed APK with `apksigner verify --print-certs`; share only its public fingerprint if needed, never the keystore or password. No Web client ID or API key is supplied to this native AuthorizationClient implementation.
4. Install the opted-in 0.3.2 APK signed with that retained key as an update. In 成绩 choose 连接现有 Google Sheet, then 选择 Google Sheet. Select the intended test copy and tab; inspect the read-only preview and confirm explicit grade/weight cell mappings. A picker selection and user consent, not a pasted URL, grants this app access to the selected file.
5. Validate with one explicit test-copy change. Registration, build validation and automated tests do not substitute for this owner-operated end-to-end test. If permission is denied or configuration is incomplete, do not broaden scopes or edit a different workbook as a workaround.

Official references: [Android authorization](https://developer.android.com/identity/authorization), [native Google Picker setup](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker), [OAuth consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent), [Google Auth clients](https://console.cloud.google.com/auth/clients).
