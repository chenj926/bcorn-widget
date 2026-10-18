# Native grade authorization and mapped-sheet safety tests

Run offline synthetic fixtures (no credentials, OAuth consent, or live user Sheet):

```sh
RUSTUP_HOME=/tmp/bcorn-rustup CARGO_HOME=/tmp/bcorn-cargo \
  /tmp/bcorn-cargo/bin/cargo test --manifest-path src-tauri/tests/native-grade-auth/Cargo.toml --offline
```

The native Windows implementation uses Google's documented desktop Picker flow:
https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker

A system-browser OAuth request uses PKCE/state/loopback, `drive.file` only,
`prompt=consent select_account`, `trigger_onepick=true`, spreadsheet MIME filtering,
and `include_granted_scopes=false`. Exactly one validated `picked_file_ids` callback
value is staged with native-only tokens. A pasted URL cannot grant access.

The six mapped-sheet commands are:

- `pick_grade_sheet(opener)` → `{selectionId,title,tabs}`
- `preview_grade_sheet(selection_id,sheet_id)` → bounded snapshot
- `confirm_grade_sheet_mapping(selection_id,mapping)` → current status/binding
- `read_mapped_grade_snapshot(connection_id)` → bounded snapshot
- `commit_mapped_grade_cells(connection_id,expected_snapshot,writes)` → verified snapshot
- `create_mapped_grade_sheet(course,opener)` → verified newly-created binding

Snapshots contain `{sheetId,tab,complete,previewRange,cells}`. `complete: true`
means all of the explicitly disclosed `A1:Z200` preview region was read, not the
entire workbook. Unrelated rows, columns and tabs are neither imported nor changed.
The response is capped at 4 MiB, with at most 200 × 26 preview cells. Formula and
protection flags are native-derived; merged cells and unresolved named protections
are conservatively read-only. No formula source text or credentials enter IPC.

Confirmation independently rereads the selected region and checks exact label
anchors, unique bounded grade/weight targets, formula/protection flags, and units.
The DPAPI vault persists the confirmed mapping and a fresh connection identifier.
Picker/create starts pause the prior account's remote synchronization; failure or
cancellation leaves local grades and the previous binding intact but authorization
required. It never reuses an old outbox under a new connection identifier. All
staged tokens disappear on cancellation/disconnect or replacement selection.

Writes validate the current connection inside the serialized native operation,
use only persisted mapping targets, compare a fresh complete-region snapshot,
reject formula/protected/anchor changes, and send RAW single-cell updates only.
Scores support bounded numeric ratios/percentages, blank, and strict literal
`earned/possible` text. Weights are bounded numbers. No caller API routes, workbook
IDs, ranges, arbitrary strings, or formulas are accepted. Independent readback
verifies every changed value. Permission denial pauses synchronization; rate-limit
responses preserve the grant and enforce cooldown; one refresh/retry handles 401.

Google Sheets values writes do not offer documented atomic compare-and-swap.
An external edit between preflight and update cannot be excluded: the UI must
warn against concurrent editing during sync. The implementation prevents known
formula overwrites and detects stale snapshots, but cannot promise atomicity or
race-free preservation against a simultaneous external editor.

New template creation is separate from legacy fourteen-column app-created sheets.
It accepts one validated course (1–190 assessments), rejects exemptions, writes
literal labels, numeric weights and zero-aware scores, and creates only native
Contribution formulas plus Total weight, Earned contribution, Graded weight and
Current average summaries. Blank scores remain ungraded; zero is graded; fractions
are literal text. Formula errors remain visible. Rules remain explicitly weighted
or unconfirmed; the template does not infer syllabus policy.
