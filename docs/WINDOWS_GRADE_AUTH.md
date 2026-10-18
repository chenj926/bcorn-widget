# Windows grade-sheet authorization and private storage

## Implemented boundary

`src-tauri/src/grade_auth.rs` owns the Windows authorization and API session. The renderer receives connection status, the confirmed workbook/tab, an opaque connection ID, and sanitized grade values. It never receives access tokens, refresh tokens, OAuth codes, a credential-export operation, or a general HTTP proxy.

The current product mode is **foreground automatic two-way sync, with catch-up on next open/resume**. No relay, server-side grant, OpenID scope, Firebase configuration, or background service is required. Native authorization status and foreground scheduler state are separate: `state: "ready"` means the dedicated workbook was created, its headers were read back, and the native grant was saved. The shared client owns foreground scheduling. Native `automaticInbound: false` / `automaticInboundMode: "none"` does not imply that the shared foreground scheduler is unavailable; `foregroundSyncAvailable: true` explicitly reports that capability.

This code has not completed a live Google consent flow or a physical Windows runtime test. A build with no Desktop OAuth client configured remains `not-configured` and never opens a browser implicitly. Local grades work independently.

## Public native API

Network work runs outside Tauri's UI thread. The host wraps network operations in `spawn_blocking`; status and bounded journal commands remain local and never start network work.

- `GradeAuth::new(app_data_dir)` opens the user-bound private vault. Initialization errors must be exposed as an unavailable connection, without breaking local grade editing.
- `status()` returns `{state, binding, connectionId, deviceId, automaticInbound, automaticInboundMode, foregroundSyncAvailable}`.
- `connect_new_sheet(title, tab, open_system_browser)` starts a user-initiated connection and creates a **new** workbook. The opener callback must call the OS browser, not an embedded WebView.
- `request(SheetsRequest {method, path, body})` performs only the exact routes below.
- `sheet_version()` returns `{version: string, modifiedTime?: string}` for the already-bound workbook. It accepts no renderer file ID or URL.
- `set_foreground(false)` rejects queued sync work and cancels an in-flight Sheets/version/refresh HTTP future; `true` permits resume. The host derives visibility from the native window and renderer lifecycle. There is no idle native polling.
- `cancel_authorization()` cancels the browser callback wait and its separate exchange/create/readback HTTP futures. Ordinary loss of focus to the system browser does not cancel consent.
- `disconnect(true)` stops native use and clears local credentials before trying Google's token revocation endpoint. It returns `{ok, googleRevocationConfirmed}`; `false` must not be described as successful Google-side revocation. The user can inspect [Google account connections](https://myaccount.google.com/connections).
- `validate_connection(connectionId)` rejects stale and invented connection identifiers.
- `GradeSyncStore::load(connectionId)` / `save(connectionId, envelope)` load/save only the private journal for that ID. The host also checks it against the current `GradeAuth` connection.

All errors are fixed codes or short app-authored messages. OAuth provider bodies, HTTP error text, authorization headers, and credentials are never forwarded to the renderer.

## Browser authorization

1. The explicit Connect/Create action validates the title/tab and acquires a single-operation gate. Repeated clicks cannot spawn a second flow or create duplicate workbooks concurrently.
2. Native code opens an ephemeral listener on `127.0.0.1` only and generates independent cryptographically random 256-bit state and PKCE verifier values. The verifier uses S256, never `plain`.
3. The OS browser opens Google's fixed HTTPS authorization endpoint. The only scope is `https://www.googleapis.com/auth/drive.file`; `openid`, identity/profile, Calendar, and full-Drive/Sheets scopes are not included. Offline access is requested and the browser explicitly lets the user choose an account.
4. The callback accepts only `GET /oauth/callback`, the exact loopback Host/port, unique query parameters, and constant-time matching state. It bounds header bytes, socket read duration, and the overall 180-second authorization window. Invalid unrelated callbacks cannot complete authorization. A valid denial exits without making API calls.
5. The code exchange uses the same native redirect and PKCE verifier, with fixed Google's token endpoint. Refresh credentials must be present before proceeding.
6. Native code creates one new workbook with the shared adapter's exact 14 headers and a 1002 × 14 grid. It then reads the header row back before committing the connection.
7. A fresh random connection ID is assigned for every new grant/workbook/tab. This intentionally does not reuse an earlier connection's journal when the browser chooses a different account. The ID is an isolation key, not an asserted Google account identity.

Cancellation during an already-sent create request cannot undo that Google-side request. If cancellation happens then, the operation does not become ready and its error explicitly warns that a new Sheet may exist. Similarly, if Google creates a Sheet but a subsequent read/storage step fails, the Sheet can remain in Drive; the app does not delete files to hide a partial setup failure. An earlier working connection remains unchanged until the new one commits.

## Request allowlist and limits

JavaScript can request only:

- `GET /v4/spreadsheets/{boundId}/values/{encodedBoundTab!A1:N1002}?valueRenderOption=UNFORMATTED_VALUE`
- `PUT /v4/spreadsheets/{boundId}/values/{encodedBoundTab!Arow:Nrow}?valueInputOption=RAW`, where `row` is 2–1001, the body contains exactly `range`, `majorDimension: "ROWS"`, and one 14-cell row

Native creation is separate from this IPC transport. Renderer calls cannot create a workbook, change bindings, overwrite headers, access other tabs/files, append/clear/delete, invoke batchUpdate, request formulas, or select an arbitrary URL. RAW prevents grade titles beginning with `=` from being interpreted as a formula.

A separate native-only revision probe uses `GET https://www.googleapis.com/drive/v3/files/{boundId}?fields=version,modifiedTime`. `drive.file` permits that metadata read for the app-created workbook. The 64-bit Drive version stays a decimal string, avoiding JavaScript precision loss. The renderer cannot broaden its fields or use `alt=media`.

The HTTP client uses Windows Schannel through `native-tls`, normal certificate validation, TLS 1.2 minimum, HTTPS only, no redirects, a 10-second connection timeout, and a 30-second request timeout. Responses are capped at 4 MiB and row updates at 128 KiB. Returned successful bodies are whitelisted to values or update counts; error bodies contain only stable app codes.

Refresh and API operations are serialized. Tokens refresh when near expiry, with at most one refresh/retry on a 401 response. Refresh-token rotation is persisted before another operation can use it. `invalid_grant` marks the grant revoked and removes stored credentials. Known Google quota-related HTTP 403 reasons are normalized to 429 with a bounded native cooldown; they preserve the grant and binding. Other permission 403 responses pause the connection as authorization-required while retaining credentials for explicit recovery/disconnect. A repeated 401 after refresh removes unusable credentials. Network failures do not erase a still-valid grant.

The Sheets values API has no atomic compare-and-swap. Native serialization prevents races inside one process, but does not make cross-device/manual Sheet edits serializable; the shared coordinator's preflight/readback/conflict handling remains necessary.

## Protected stores and recovery

Both native authorization and sync journals are encrypted and integrity-protected with Windows DPAPI for the **current user**, not the whole machine. `CRYPTPROTECT_UI_FORBIDDEN` prevents unexpected credential prompts. The implementation never weakens OS/network security settings.

- `grade-native/grade-authorization-v1.bin`: encrypted device ID, connection binding/status, access and refresh credentials; plaintext envelope capped at 128 KiB
- `grade-sync/{opaqueConnectionId}.bin`: encrypted `{schemaVersion:1, coordinator, publishedBook}` recovery envelope; plaintext capped at 4 MiB
- `grades-v1.json`: separate normalized local gradebook owned by the host; no credentials or sync journal

File writes use unpredictable `create_new` temporary files, complete write + flush, then an atomic Windows replacement with write-through. A failed write preserves the previous file. Reads enforce a streaming bound even if a file grows after it is opened. Journal identifiers are exactly 64 lowercase hexadecimal characters and cannot become paths. Journal shape/depth/record keys are validated, unknown credential fields are rejected, and the public gradebook validator is reused.

Neither private directory participates in timetable or gradebook export. Clearing timetable data must preserve these stores. DPAPI ciphertext is tied to the Windows user/machine context; copying an installation's private files is not a supported account-linking or backup workflow.

Bytes already sent to Google cannot be unsent. Cancellation therefore preserves the durable outbox and relies on foreground/resume reconciliation to establish whether an interrupted write applied. It does not promise zero bytes already in flight or automatic Google-side rollback.

The pure Rust modules expose an injectable protector/HTTP transport only to internal tests. Non-Windows production code fails closed rather than falling back to plaintext storage. Tests use only temporary synthetic credentials and a clearly test-only fake protector.

## Build configuration (not performed here)

The owner must supply a Desktop OAuth client from the intended Google Cloud project and enable Sheets and Drive APIs under that project's consent/audience settings. No Cloud project, grant, credential, billing plan, or permission setting is created by this implementation.

Build-time variables:

- `BCORN_GOOGLE_DESKTOP_CLIENT_ID`: the registered Desktop client ID; a missing/invalid value is `not-configured`
- `BCORN_GOOGLE_DESKTOP_CLIENT_SECRET`: optional issued Desktop client value when required by the client's token exchange; never a user token and never loaded from renderer settings

Desktop apps are public OAuth clients and cannot keep their distributed client metadata confidential; PKCE protects the authorization exchange. Do not use a server/web client secret in this desktop build. Changing the build-time configuration requires rebuilding. Use a separate desktop client from unrelated Calendar or relay sign-in integrations, so broader prior consent is not accidentally reused.

No production client ID is checked into the repository. No live grant or existing credential vault was read during implementation/testing.

## Repeatable checks

From the repository root:

```sh
cargo test --manifest-path src-tauri/tests/native-grade-auth/Cargo.toml
cargo check --manifest-path src-tauri/tests/native-grade-auth/Cargo.toml --target x86_64-pc-windows-msvc
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

The standalone harness compiles the actual production modules without a GUI. Host tests use mock Google responses plus actual loopback TCP callbacks. They cover scope/PKCE/state, callback host/path/duplicates, cancellation/timeout/repeated clicks, hidden no-new-request gates and dropped in-flight futures, verified creation, preserved prior binding on failed setup, bounded routes, exact metadata access, response redaction, concurrent refresh, retry limits, revocation, private-file bounds/atomic replacement and connection isolation.

Windows-target `cargo check` verifies the DPAPI and atomic-replacement Windows API signatures but does not execute them. A full Windows release still needs real-device tests of DPAPI persistence, OS-browser callback routing, OAuth cancellation, token refresh/revocation, account switch/new connection, foreground/hidden/resume behavior, and app-to-Sheet/Sheet-to-app edits. A passing mock transport test is not a production authorization or synchronization claim.

## Official references

- [Google Desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)
- [Drive files.get and accepted scopes](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Drive error classification](https://developers.google.com/workspace/drive/api/guides/handle-errors)
- [Drive File revision metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [Microsoft MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
