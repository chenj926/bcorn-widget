# Windows native Google Calendar and Microsoft Graph

## Integration boundary

Register `mod cloud_calendar;` and a managed `Arc<cloud_calendar::CloudCalendar>` from `CloudCalendar::new(app_data_directory)`. All browser/network operations must execute on Tauri `spawn_blocking`; the module owns a bounded async HTTP runtime. The system browser callback must use the OS opener, never the WebView. Register only these typed commands, not a generic HTTP/token command:

| UI action | Arguments | Native call / result |
| --- | --- | --- |
| `status` | `{provider}` | `status(Provider)` → `{provider,state,accountLabel,target,enabled,ownedCount}` |
| `connect` | `{provider}` | `connect(Provider, open_system_browser)` → status |
| `targets` | `{provider}` | `targets(Provider)` → `[{id,name}]` |
| `create_target` | `{provider,name}` | `create_target(Provider,String)` → target; Google only |
| `bind` | `{provider,calendarId,confirmed:true}` | `bind(Provider,String,bool)` → status |
| `sync` | `{provider,series,allowDelete:false}` | `sync(Provider,Vec<Series>,bool)` → `{written,unchanged,deleted,pendingDeleteCount}` |
| `disconnect` | `{provider}` | `disconnect(Provider)` → status |
| `cancel` | `{provider}` | `cancel(Provider)` |
| `set_foreground` | `{foreground}` | `set_foreground(bool)` |

Provider serialized values are `google` and `microsoft`. Read `docs/WINDOWS_CLOUD_CALENDAR_UI.md` for renderer mounting. Start the controller after loading local data or call its save callback after the load. Only successfully persisted canonical data is passed to `onTimetableSaved`; never await cloud work before committing local changes.

Native host window hidden/minimized/closing lifecycle must also set foreground false. Renderer visibility provides a second gate. Backgrounding cancels in-flight HTTP futures and loopback waiting; showing the window does not revive an interrupted operation. A new serialized operation may begin after returning foreground. No process, service, relay, timer, webhook, or idle network poll is created.

## Build-time configuration and actual permissions

These independent build-time variables deliberately do not reuse the grade `BCORN_GOOGLE_DESKTOP_CLIENT_ID` or its `drive.file` grant:

- `BCORN_GOOGLE_CALENDAR_CLIENT_ID`: Google OAuth Desktop client ID, with Calendar API enabled and the correct consent/test-user configuration.
- `BCORN_GOOGLE_CALENDAR_CLIENT_SECRET`: desktop client secret if required by that registered client (desktop software cannot keep a client secret confidential).
- `BCORN_MICROSOFT_CALENDAR_CLIENT_ID`: Microsoft Entra public desktop client application UUID. Configure the intended organizational/personal account types and loopback redirect `http://127.0.0.1/oauth/callback` for desktop authorization; the OS-selected listener port is dynamic. Registration and tenant consent policies must allow that flow.

Missing client IDs yield `not-configured`, disable sync and do not start browser authorization. Protected-vault initialization failure is separately reported as storage unavailable, disables both calendar connections, and does not prevent local timetable use. No credentials, grant, real account write, live consent screen, tenant policy, provider notification delivery, or Windows runtime/DPAPI roundtrip was tested in this development environment. Windows source compilation is tested separately from runtime execution.

Google requests `openid email https://www.googleapis.com/auth/calendar.app.created`. Identity comes from the fixed Google OIDC userinfo endpoint. Only explicitly created secondary calendars from this local app's encrypted account journal appear as Google targets; the app never calls `calendarList.list` or expands to all-calendar scope. Creating a calendar is a separate explicit button. A lost creation response is not automatically retried: the user must inspect Google Calendar first, because calendar creation has no idempotency key and an orphan calendar may exist.

Microsoft requests `openid profile offline_access User.Read Calendars.ReadWrite`. Identity comes from fixed `/v1.0/me`; writable targets from `/v1.0/me/calendars` with `canEdit`. Delegated Calendar permission is account-wide at Microsoft's consent boundary. The app additionally restricts its own writes to the explicitly confirmed target and its own journaled events. More than 100 calendars is an explicit unsupported-list error rather than following arbitrary pagination URLs or silently truncating targets.

Both use system-browser authorization code + S256 PKCE, random state, a short-lived IPv4 loopback listener, exact callback path/Host validation, duplicate-query rejection, constant-time state comparison and cancellation. No token is returned to JS. Starting an account switch clears the previous grant locally and disables its autosync before opening the browser; cancelled authorization cannot silently resume the old account.

## Ownership, safety and limits

- Current-user Windows DPAPI with atomic replacement protects tokens and journals. The already-audited `Protector`, current-user `UserProtection`, bounded-read and atomic-write primitives are reused under separate `calendar-google-v1` and `calendar-microsoft-v1` directories, with calendar-specific schema, filename and 4 MiB limit. The only grade-module change is `UserProtection` crate visibility; grade vault limits and schemas are unchanged. Credential buffers are zeroized; raw provider errors and URLs are not sent to the UI.
- Journals are partitioned by provider, stable provider account ID, calendar ID, and installation owner. Stable event keys include series ID plus civil occurrence key. Confirmed deletions retain a generation tombstone; re-adding that occurrence uses a fresh deterministic provider identity instead of colliding with a provider-retained deleted ID. Reconnection preserves owned-event mappings; disconnect removes only local credentials and disables sync, leaving cloud events and journals intact. It does not revoke unrelated grade grants.
- Google uses deterministic event IDs and private ownership properties. Graph uses a stable `transactionId` plus a named single-value extended ownership property. Intent is durably persisted before POST; returned IDs are persisted before readback. Definitively rejected POSTs (including quota responses and pre-dispatch cancellation) restore the previous intent, allowing a later retry. Ambiguous Graph creation is recovered by exact ownership-property lookup. If no result can be proven, the app reports uncertainty instead of issuing another POST or guessing ownership.
- Every update/delete reads and verifies ownership first and sends `If-Match` with the provider ETag. Only app-owned event fields are patched. Writes are independently read back, including content, instants and reminder configuration. Graph event reads explicitly request plaintext bodies and UTC via the native Prefer header. Unchanged payloads are compared against the server. A partial batch is journaled per event; local timetable data is never changed or rolled back.
- Removal computes `pendingDeleteCount`; no delete happens until `allowDelete:true` from a fresh explicit UI confirmation naming the account/calendar. It never deletes calendars, unowned events, or a whole account. Failed/ambiguous deletion keeps the journal for safe later readback.
- Concrete occurrences preserve canonical DST handling, exclusion dates and make-up classes. Google includes the canonical IANA timezone; Graph stores resolved UTC instants. No lossy provider recurrence translation. Google offset responses and Graph fractional seconds are normalized during readback.
- One optional provider reminder per occurrence. Renderer choices: none/5/10/15/30 minutes. Device/provider notification settings ultimately control delivery; successful API write is not evidence a notification appeared.
- Maximum 1,000 concrete occurrences in a synchronization, 1,000 series, 2 MiB HTTP response and 4 MiB encrypted-vault cleartext budget. Limits produce errors without truncation. Multiple account/target histories consume the same provider vault budget. Already completed remote writes cannot be transactionally rolled back; any partial outcome is preserved in the journal for the next foreground attempt.
- 429 and Google's 403 quota reasons preserve credentials and honor bounded Retry-After; 401 or refresh `invalid_grant` disables the connection and requires authorization. Other 403 is a permission error, not revocation. No automatic retry loop runs while idle.

## Tests

`RUSTUP_HOME=/tmp/bcorn-rustup CARGO_HOME=/tmp/bcorn-cargo /tmp/bcorn-cargo/bin/cargo test --manifest-path src-tauri/tests/calendar-harness/Cargo.toml`

The harness imports the exact production calendar, DPAPI store and data modules. Synthetic HTTP tests exercise Google and Graph creation/no-op/update/confirmed deletion, ownership conflicts, lost POST responses, quota/revocation, failed account switches, stable IDs/DST conversion, cancellation and local encrypted journal persistence. Real loopback TCP tests verify PKCE/state/Host handling. HTTP allowlist tests never contact providers. The non-Windows storage test protector is explicitly synthetic, not a claim of DPAPI runtime validation.

`node tests/cloud-calendar-ui.cjs`

Native source check: `cargo check --manifest-path src-tauri/tests/calendar-harness/Cargo.toml --target x86_64-pc-windows-gnu` with the configured official Windows toolchain. The main app owner runs the integrated Windows release build after registering commands.

## Primary references

- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft event creation and transactionId](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0)
- [Microsoft single-value extended properties](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get?view=graph-rest-1.0)
