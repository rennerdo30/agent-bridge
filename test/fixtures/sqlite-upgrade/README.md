These are synthetic data captures produced by **executing the actual tagged code**,
not schemas reconstructed from current source. The generator extracts each Git
tag's complete `src`, bundles its `MessageStore` and `openArchive` (where present)
with the checkout's existing esbuild dependency, then opens a fresh local store.
No installer, owner store or external writable link is used.

Run `node scripts/generate-sqlite-upgrade-fixtures.mjs` from the checkout to
reproduce the captures. Extracted code and runnable bundles stay in its ignored
`.agent-bridge-test` directory. The committed `store.ts.txt` and optional
`sqlite-maintenance.ts.txt` record the exact released source. `manifest.json`
records tag commits, source/file SHA-256, table counts and canonical row hashes
(including BLOB bytes and FTS shadow tables).

All released 0.27.x and 0.28.x tags are covered, plus 0.29.0, 0.29.10, 0.29.13
and 0.29.14. Before 0.29.0, archives lived in `bridge.db.archived_messages`;
separate `archive.db` captures honestly begin with 0.29.0. Rows cover all three
agents, direct/sibling/broadcast messages, prior archive timestamps/reasons,
decision revisions, index/cursor/session/name/delivery metadata where that
release supported it, and an unknown table with binary user data.

The matrix checks pure schema migration, backup fidelity, repeat migration,
failure rollback and downgrade refusal. Separate startup cases compare complete
retained messages across the legacy/archive locations and exercise history
backfill. Archive relocation preserves all 14 columns rather than dropping
archival metadata from the comparison.

Before migration the test verifies every captured table, including physical FTS
shadow rows. Failure/downgrade assertions compare all logical records and FTS
matches: SQLite may repack derived FTS segments while making a `VACUUM INTO`
backup, so physical shadow-page hashes are not a user-data identity invariant.
