# Existing human-readable grade templates

## Scope and actual status

Shared mapping, compact renderer mapping dialog, grade-page entry points and mapped native-client integration are implemented with synthetic tests. They do not grant access, activate a native account, create a live spreadsheet, or perform a network request by themselves. The original user-provided personal spreadsheet is strictly read-only for this development task and is neither included in fixtures nor accessed here. Native/platform owners implement the explicit methods below; deployment still needs OAuth configuration and real-device verification. Missing native capability remains `not-configured`.

No generic spreadsheet URL establishes authorization. No renderer token, client secret, OAuth grant, deployment, or API key is added by this change.

## Official minimal-permission file selection

Google now documents a native/system-browser Picker OAuth flow, eliminating the need to put `setOAuthToken` in the main renderer:

- https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker (updated 2026-10-12, checked 2026-10-18)
- Native desktop: OAuth authorization-code flow with `scope=https://www.googleapis.com/auth/drive.file`, `prompt=consent`, `trigger_onepick=true`, optional spreadsheet MIME filter. This Picker flow permits only `drive.file`, without combining other scopes. Standard native PKCE/state/redirect validation still applies. Validate returned `picked_file_ids`, exchange code and retain tokens natively; verify selected file type/access via authenticated metadata.
- Android: `AuthorizationRequest.ResourceParameter.PICKER_OAUTH_TRIGGER`, `setOptOutIncludingGrantedScopes(true)`, consent prompt and `drive.file`. Obtain selected IDs from `AuthorizationResult.getTokenResponseParams()`.
- Platform SDK support/configuration must be verified by the native implementation. If unavailable, disable selection honestly; do not silently request broader Drive/Sheets access or substitute a pasted URL.
- Pause the old connection before account selection. Cancelled/failed selection must not repoint its pending journal. A preview is only a staged candidate.

## Renderer/native contract

All objects contain data only, never tokens. Native validates every input against its private selected account/file, connection generation and stored mapping.

1. `pickGradeSheet({})` -> `{selectionId, title, sheets:[{sheetId,tab}], readOnly:true}`. UI also accepts `tabs:[{sheetId,title}]`. `selectionId` is opaque and short-lived.
2. `previewGradeSheet({selectionId,sheetId})` -> `{sheetId,tab,complete:true,cells:{A1:{value,formula,protected}}}`. Read-only grid preview bounded to A1:Z200 of the explicitly selected tab. Use actual user-entered formula metadata, not text guesses. Values are unformatted effective scalars; mark merged/protected targets. `complete` means the requested bounded preview succeeded, not that the workbook has no data outside this region. Do not scan other tabs. Clearly disclose bounds in UI.
3. `confirmGradeSheetMapping({selectionId,mapping})` -> fresh native connection status with `binding:{kind:'mapped',mapping}`, connectionId and deviceId. Store/validate mapping natively. Confirmation only follows explicit user mapping. It does not imply replacing an unrelated local gradebook.
4. `readMappedGradeSnapshot({connectionId})` -> current snapshot as above.
5. `commitMappedGradeCells({connectionId,expectedSnapshot,writes:[{cell,value}]})` -> success after verification. Derive destination file, sheet and allowlist exclusively from stored binding. Reject unbound cells and non-RAW types. Both mapped grade and weight cells are writable; labels, formulas, notes, totals and other tabs are not.

Mapping version 1:

```json
{"schemaVersion":1,"confirmed":true,"sheetId":7,"tab":"Synthetic","courses":[{"id":"synthetic","title":"Synthetic course","termId":"","rules":{"kind":"weighted"},"assessments":[{"id":"quiz","title":"Quiz","gradeCell":"D4","weightCell":"C4","gradeMode":"ratio","weightMode":"percentage","anchor":{"cell":"B4","text":"Quiz"}}]}]}
```

Grade modes: ratio, percentage, fraction. Weight modes: ratio, percentage. Every assessment needs an explicit label anchor to detect row moves; target cells must be unique, in the bounded tab, and never anchors. Unknown layouts require user entry; no header-based guesses. Ordinary weighted rules require separate user confirmation; otherwise metrics remain provisional. Score zero is graded; empty grade is ungraded. Literal fractions use RAW strings so `40/50` cannot become a date. Existing summary formulas are never used as authoritative grade calculations.

## Write invariants and concurrency limitation

Shared `writePlan` rejects structural edits, deletion, exemption without a status mapping, changed anchors, tab changes, stale expected records, formulas and protected cells. Plans contain only changed single-cell grade/weight destinations. No row replacement, tab clear, overwrite of unrelated cells, or inferred deletion is allowed.

Native must re-read mapped values/anchors/formula and protection metadata immediately before a RAW batch of precisely those cells, validate `expectedSnapshot`, and read back. Use native generation locking so account changes invalidate in-flight work. Readback mismatch is a visible conflict/verification failure; retain local intent.

Google Sheets values updates do **not** provide documented atomic compare-and-swap. Preflight and readback therefore cannot guarantee exclusion of a formula or edit introduced by another editor between checks and the write. Do not market this as transactional or claim arbitrary concurrent edits can never be overwritten. Avoid concurrent editing of the same cells; stop on any detected discrepancy. A stronger absolute guarantee needs an external single-writer protocol or a different backend, not a fabricated request header.

Sources: https://developers.google.com/workspace/sheets/api/guides/values and https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate . RAW prevents interpretation; it does not itself protect formula destinations.

## Coordinator and import integration

Use `SheetMapping.createAdapter({mapping,authorizationStatus,readSnapshot,commitMappedCells})` with native wrappers bound to one connectionId. It emits the existing `GradeSync` course/assessment records and integrates with `BcornSync.createCoordinator` / `GradeSync.createService`. The durable coordinator already provides pending mutations, three-way conflicts, retry and crash journal; do not create a parallel last-write-wins engine.

For first link, show the mapped imported book and ask how to handle existing local courses. Seed/merge only the selected course records with explicit user approval, preserve unrelated local courses, and scope the journal by account/file/tab/mapping fingerprint. Existing `GradeSync.createService` materializes a whole book; native-client now provides a scoped bookStore wrapper that merges only mapped courses into the full local book. Do not feed unrelated local records to a mapped adapter. Route only mapped-course edits into this service; additions/removals require remapping.

The native client uses the existing foreground scheduler for inbound refresh, resume/online checks and backoff. The mapped adapter probes Drive version and reuses the bounded snapshot when unchanged; write preflight and verification always force a fresh read. `automaticInbound:false` truthfully means no background push; foreground polling remains available. Pause on hidden/offline/revoked/connection changes. Never label source implementation as verified live sync without a configured native test.

## Human-readable new-file template

`SheetMapping.template(course)` supplies human-readable assessment/weight/grade rows plus explicit mapping metadata for a separately authorized new-file flow. Inputs come from a user-entered, validated syllabus setup; do not infer weights or normalize incomplete weights. Blank grades remain blank, zero remains zero, fractions remain literal. Native creation must obtain actual returned sheetId and update mapping before confirmation, format weight/ratio columns appropriately, and confirm the new file before binding. It is a source-level builder, not an automatically deployed creation flow. Existing 14-column dedicated-tab format remains backward compatible but is not a substitute for this human template flow.

## Tests

`node --test tests/sheet-mapping*.test.js`

Synthetic sectioned rows, broken unrelated summary formula, zero/ungraded, numeric/fraction writes, stale anchors, blocked formulas/protection, durable conflict/restart/resolution, remote inbound changes, missing configuration, safe DOM preview/manual selection and human-readable template builder. No personal sheet data or live credentials.

## Import and compact UI

The mapping dialog collects course identity once and presents assessment mappings as a single-open accordion with 48 px minimum controls. It explicitly discloses A1:Z200 and uses human-readable error messages. Current dialog maps one course at a time; the core schema supports multiple mapped courses. Imported course-ID collisions require explicit confirmation, and unrelated local courses are retained.

The grade page provides `createMappedGradeSheet({course})` after a separate explicit new-file confirmation. The native platform constructs the fixed template; it must reject exemptions because version 1 has no exemption-status cell. Shared builder rejects these too.

`GradesUI.prepareImport({bridge,storage})` blocks the prior connection before restoring a backup, including when the grade page was never opened. It stores a connection-specific relink requirement and never starts a coordinator just to block it. `reloadAfterImport()` refreshes the page without reactivating that destination. Native connection IDs must be fresh on relink.

### Fail-closed connection transitions

Before selection/account changes, the client blocks refresh activation, stops the prior scheduler, drains in-flight local writes and coordinator materialization, then disposes the prior service. A durable pending-mapping marker is written before native confirmation or new mapped-template creation. Any stale preview, read failure, import failure, or process restart leaves the binding blocked. The marker clears only after verified remote content and successful local import/readback (or verified new-template content). Native error aliases are normalized to conflict, mapping-stale, formula-protected and other actionable categories. Tests cover refresh during drain and module restart with a persisted marker.
