# Upgrading to 0.30.4

0.30.4 contains 0.30.2 and 0.30.3. It moves the bridge's growing state into SQLite and stores history compressed. Each step below runs automatically, in the background, after the update. None of them deletes anything.

## What happens after the update

The steps are independent; each owns its own store and runs once in the elected broker's worker threads. The broker stays responsive while they run.

1. **Metadata and worktree leases** (`bridge.db` metadata tables): leases, capabilities, receipts and read state move into SQLite. Metadata-only migrations back up just the tables they change.
2. **Job copies** (job archive index): every archived `jobs.json` copy is imported per job version. The copies are packed into one verified compressed bundle, and the originals move to `cold-storage/jobs-v1/`.
3. **History store v2** (`history.db`):
   - A consistent snapshot of the legacy history is taken in about a minute.
   - Rows are copied in batches. Each batch is decoded and compared byte for byte before its cursor commits.
   - Every row is verified a second time. Only then do search and transcripts switch to `history.db`.
   - The migration checks free disk space first, can be stopped and resumed at any point, and keeps a failed attempt for inspection.
   - Until it is verified, readers keep using the legacy history in `bridge.db`.
4. **Finished runs**: archived, finished run logs are packed in bounded batches and listed from an index instead of directory scans.

Progress shows in the `health` tool and the dashboard. `agent-bridge doctor --migration-plan` lists every step, its size and anything that needs your decision, without changing anything.

History import must be enabled (`history.ingest`, on by default) for step 3 to run.

## Hotfixed installs

Updates publish each plugin version into its own folder and keep older ones. Locally patched files in an older version folder (for example the 0.30.0 cache hotfix) are left as they are and are no longer used once every session runs the new version.

## Removing the old data

Old-format data stays until you remove it explicitly:

```
agent-bridge storage finalize          # lists the candidates with sizes and reasons (seconds; reads no rows)
agent-bridge storage finalize --check  # proves every candidate, with progress and ETA, and removes nothing
agent-bridge storage finalize --yes    # proves again, then removes exactly what is proven
```

The proof reads sequentially: the snapshot the verified history migration copied from is re-hashed against that migration's manifest, other copies of the history are compared with history.db in rowid order, and only the remaining rows use batched indexed lookups.

`finalize` refuses while any migration is unverified. Before removing anything it proves again, independently of the migration, that every legacy row exists in the new stores. Anything it cannot prove redundant row by row is kept and reported.

Old whole-database backups and migration snapshots often hold rows that exist nowhere else, for example messages that older versions deleted. Import those first, with every bridge process stopped:

```
agent-bridge storage absorb            # counts the rows and files that exist only in old copies, and conflicts
agent-bridge storage absorb --yes      # imports them into archive.db, then run finalize again
```

`absorb` stores each such row exactly in archive.db (`absorbed_rows`), and messages also go into archive.db `messages`. Files that exist only in an unpublished backup are stored byte-exact (`absorbed_files`). It never changes a live row. If a row's key exists live with different content, that is a conflict: nothing is imported for it, and the backup holding it stays. `absorb` works in small batches and can be interrupted and run again.

Before `finalize`, `agent-bridge storage rollback-history` switches search and transcripts back to the legacy history and keeps the new copy. After `finalize`, rollback is no longer possible.

## Inspecting the stores

`agent-bridge db tables`, `agent-bridge db query "<sql>"` and the dashboard's Database page read the stores read-only and decode compressed text. `agent-bridge db export --decompressed <table> <file.sqlite>` writes a plain copy for third-party SQLite viewers.
