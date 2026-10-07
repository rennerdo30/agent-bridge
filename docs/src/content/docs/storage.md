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

Snapshots use `VACUUM INTO`, verify SQLite integrity, flush files and publish a checksummed
manifest only after capture succeeds. Incomplete attempts remain under `backups/.pending-*`.
SQLite snapshots include committed WAL pages; JSON captures preserve complete file bytes.
Each file is consistent, while separate stores may represent nearby instants during live activity.
Active stores are captured before archives so archive moves cannot remove the only backup copy.
Snapshots cover primary/archive databases and JSON stores/metadata, including archived jobs
and the durable read journal.
Run log text, the bridge authentication token and the dashboard launch secret are not part of the
rotating snapshot. Keep the entire data directory in normal filesystem backups if you need them.
The 0.30.0 split adds independently versioned `history.db` and protected
`.migration-snapshots/`; owner questions use `owner-questions.db`. The rotating
`doctor --backup` database set covers `bridge.db` and `archive.db`, so retain these
additional stores with the full data directory too. See [conversation storage](../conversation-storage/).

| Environment variable | Default | Meaning |
|---|---|---|
| `AGENT_BRIDGE_BACKUP_RETENTION` | `7` | Recent published snapshots; older sets move to `backups/archive/` |
| `AGENT_BRIDGE_BACKUP_INTERVAL_MS` | `86400000` | Automatic snapshots while a message store is open |
| `AGENT_BRIDGE_ARCHIVE_AGE_MS` | `2592000000` | Finished jobs/run logs and explicit `doctor --archive` age (30 days) |

Values are nonnegative integer milliseconds/counts. Zero disables age/interval processing, or
keeps unlimited recent backups. Invalid values use named defaults. Existing message TTL, queue
age and count limits remain supported; see the [retention table](../data-retention/#retention-configuration-and-upgrade-behavior). Jobs without a reliable
`finishedAt`, and running/interrupted jobs, are not aged out. Unfinished logs are never moved.

Restore accepts a published snapshot directory, including cold snapshots. It validates hashes and
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
Completed approval question metadata also moves into `approvals/archive/`; its private expired
capability stays out of the active approval list and rotating snapshots.

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
was added in Node 22.16; `VACUUM INTO` also supports this project's Node 22.13 minimum.
