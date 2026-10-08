---
title: "Storage maintenance"
slug: storage
---

Run `agent-bridge doctor` for read-only integrity and foreign-key checks, primary/archive schema
versions, JSON parse/shape/version checks, orphan findings, file sizes and recent backup status.
`--json` returns the report as JSON. A report with errors exits 1; warnings remain visible.
The diagnostic never renames corrupt JSON or migrates a database.

Commands:

```text
agent-bridge doctor --backup
agent-bridge doctor --fix
agent-bridge doctor --archive
agent-bridge doctor --restore <snapshot-directory>
```

Fix, archive and restore prompt for confirmation. `--yes` is an explicit confirmation for scripts.
Non-interactive input never implies consent. Fix only quarantines abandoned temporary files,
preserving their exact bytes under `archive/orphaned/`. Missing/corrupt data requires manual
recovery. Repair and restore refuse registered live writers; stop bridge sessions and job runners
first. Writer leases survive crashes and are checked by PID, never expired just by age. A leftover
`.maintenance-lock` after a crash must be inspected and removed manually with all processes stopped.

Manual snapshots use `VACUUM INTO`, verify SQLite integrity, flush files and publish a checksummed
manifest only after capture succeeds. Incomplete attempts remain under `backups/.pending-*`.
SQLite snapshots include committed WAL pages; JSON captures preserve complete file bytes.
Each file is consistent, while separate stores may represent nearby instants during live activity.
Active stores are captured before archives so archive moves cannot remove the only backup copy.
Snapshots cover primary/archive, history, owner-question and compatibility databases, plus JSON stores/metadata, including archived jobs
and the durable read journal.
Run log text, the bridge authentication token and the dashboard launch secret are not part of the
rotating snapshot. Keep the entire data directory in normal filesystem backups if you need them.
Automatic daily backups are opt-in with `AGENT_BRIDGE_AUTO_BACKUP=1`. They run in a separate
process at low OS priority after the broker is listening, and capture only message transport
tables: primary/archived messages and durable job delivery routes. Conversation history,
other database tables and JSON stores are excluded. Incremental row-copy, verification and
checksum windows pause under broker pressure; a cross-process SQLite lock permits one
generation at a time and releases automatically if its process dies. Source files are untouched.
Scoped snapshots are labelled `kind: message-tables`, require a selected-table merge, and live
under `message-backups/messages-*`. Full restore explicitly refuses these partial snapshots;
never replace a whole database with one. Manual snapshots retain the complete five-database
and JSON coverage described above. Failed scoped attempts remain under
`message-backups/.pending-*`; verified older sets move to `message-backups/archive/`.
No automatic copy or checksum runs on the broker's request thread. Protected migration artifacts
under `.migration-snapshots/` remain outside automatic rotation; retain the full data directory
in filesystem backups too. See [conversation storage](../conversation-storage/).

| Environment variable | Default | Meaning |
|---|---|---|
| `AGENT_BRIDGE_AUTO_BACKUP` | disabled | `1` enables the separate-process message-table daily backup |
| `AGENT_BRIDGE_BACKUP_RETENTION` | `7` | Recent published sets in each namespace; older full/scoped sets move to their respective `archive/` directories |
| `AGENT_BRIDGE_BACKUP_INTERVAL_MS` | `86400000` | Opt-in message-table snapshot interval after the broker is listening |
| `AGENT_BRIDGE_ARCHIVE_AGE_MS` | `2592000000` | Finished jobs/run logs and explicit `doctor --archive` age (30 days) |

Values are nonnegative integer milliseconds/counts. Zero disables age/interval processing, or
keeps unlimited recent backups. Invalid values use named defaults. Existing message TTL, queue
age and count limits remain supported; see the [retention table](../data-retention/#retention-configuration-and-upgrade-behavior). Jobs without a reliable
`finishedAt`, and running/interrupted jobs, are not aged out. Unfinished logs are never moved.

Restore accepts a published full snapshot directory, including cold full snapshots. It validates hashes and
the CLI refuses damaged/unsupported stores. Every current managed file, including a damaged
database and its sidecars, is copied to a permanent `backups/recovery-*` directory before replacement.
Displaced originals are retained there too. A caught failure rolls back replaced files and preserves
partial copies. Files absent from a snapshot remain unchanged. No archive or recovery set is deleted.
Before-migration `.backup-*` database files remain separately preserved by the migration system.

Every schema step uses `PRAGMA user_version`. Migrations make a consistent pre-migration backup,
retry if another writer committed before the lock, and hold the writer lock through failure recovery.
A savepoint restores the schema and the backup restores original table contents. If recovery itself
fails, the transaction rolls back and the backup remains available. Message archival commits the
cold copy before primary removal: an interruption can leave duplicates, never neither copy.
Conflicting immutable message identities prevent archival instead of overwriting history.
The additive v8→v9 step retains a specifically labelled schema-and-metadata snapshot of its
inputs, preserving all legacy history rows without copying the whole database at startup.
That scoped artifact is never advertised as a full backup. While older readers defer an
upgrade, a new broker can host the existing schema with retained supplemental metadata.
That listener keeps its compatible schema for its lifetime. A later clean broker election
can upgrade after old readers exit; reader departure does not trigger a synchronous upgrade
inside the running broker.
Completed approval question metadata also moves into `approvals/archive/`; its private expired
capability stays out of the active approval list and rotating snapshots.

Deferred job saves retain owned context and result envelopes in the independent versioned
`pending-job-writes/v1/` namespace. Reader identity refresh and save retries run asynchronously;
old readers' shared JSON bytes stay unchanged until an upgrade is safe. Shutdown retains the
latest pending state without sending results or reconnecting after the node stops.
Recovery follows the ordinary ownership rules. Foreign and transient sessions cannot claim
receipts, and older snapshots cannot replace newer queues, ownership or completed state.
If preparing a continuation fails, accepted queued messages and the native session remain
recorded. A persisted turn-specific failure prevents automatic retries across polling and
restarts. An explicit follow-up retries all retained messages in their original order.
Results are sent only after their complete envelope is durably recorded, using the same message
ID for retries. Verified receipts move intact into the journal's archive with an incorporation
or supersession manifest; conflicting fields are retained and explicitly marked as not executed.
Partial, damaged and unsupported receipts remain untouched. Automatic payload reads are bounded
to 32 MiB per receipt; oversized receipts keep their complete bytes and require manual recovery
if the original writer exits before incorporating them into the main store.

Authenticated dashboard contracts (existing cookie and Host guards):

- `GET /api/storage` returns `DoctorReport`: `checkedAt`, `ok`, `schema[{path,actual,expected}]`,
  `findings[{severity,code,path,detail,fixable}]`, `sizes[{path,bytes}]`, `totalBytes`,
  `backups[{path,createdAt}]`. It performs no repair or migration.
- `GET /api/archive/messages?query=<literal substring>&before=<exclusive epoch ms>&limit=<1..1000>`
  returns `{messages: MessageHistoryRow[]}` across primary, legacy and archive stores. Default limit
  is 100; invalid numbers return 400. Row fields: `id`, `from_name`, `from_agent`, `to_target`,
  `recipients`, `body`, `created_at`, `hop`, `reply_to`.
- `GET /api/runs/:name?from=<byte offset>` retains its existing `{text,next,size}` response and
  can read archived runs. Recent state lists include archived history within existing display limits.

Research: [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html) documents consistent
snapshots and interruption behavior. [Node SQLite backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options)
was added in Node 22.16, the project's minimum supported runtime.
