---
title: "User data retention regression guard"
slug: data-retention
---

Owner rule: never lose user data. Durable bridge messages, job records, run logs,
metadata, approvals, completed wait records and CLI transcripts must survive
maintenance and overflow. Archive destinations have unique names or refuse an
existing destination. A rename to an archive preserves the same file; SQL removal
requires a committed archive copy first. Archive failures leave originals intact.
OpenCode uninstall archives installed files and directories to preserve local edits.

`test/data-retention.test.ts` scans every production TypeScript file for filesystem
removals and destructive SQL. Its exact-expression allowlist counts each reviewed
call, so new calls, changed arguments and aliases fail the guard. This is a static
regression check for the APIs in use, not a proof about arbitrary computed code or
shell commands. Existing storage tests exercise run pruning, job overflow,
migration rollback and archive failure. Recovery HTTP tests use temporary homes
and CLI fixtures, including a temporary OpenCode database, and compare original
transcript bytes after reads. No automated test uses the owner's actual data roots.

## Reviewed removal exceptions

| Source | Permitted removal and why it contains no unique user data |
| --- | --- |
| `core/json-store.ts` | Unpublished atomic-write `.tmp` file only. |
| `core/storage-lock.ts` | Maintenance lock and empty per-process lease files. |
| `core/migration-lock.ts` | Exclusive migration lock (PID and nonce only) on release, failed lock publication or confirmed exited owner; empty recovery coordination file. Never the database or snapshot. |
| `core/notifications.ts` | Empty notification lock directory. |
| `core/node.ts` | Abandoned Unix-domain socket path. |
| `mcp/rewake.ts` | Socket endpoint registrations containing only port, secret and PID. No conversations or prompts. |
| `core/resource-slots.ts` | Expired/released process concurrency leases in `slots`, not messages. |
| `network/files.ts` | Unpublished `.partial-*` transfer staging directory after a failed receive. The sender's original is retained. |
| `cli/smoke.ts`, `cli/reliability.ts`, `cli/reliability-live.ts` | Explicitly created temporary test homes/repositories only. |
| `cli/dashboard-key.ts` | Only the random staging file successfully created by this call with exclusive creation. It is an unpublished credential or a duplicate hard link after atomic publication. The active `dashboard-key` is never removed; replacement requires the owner's explicit `ui --reset-key` command. |
| `core/worktree-links.ts` | Symlink/junction itself only; never its destination. Used by explicitly authorized cleanup; traversal through a linked root/container or linked components inside that boundary is refused; leaf link entries are detached without traversal. System/home aliases above that boundary are resolved before removal. The private `ab-cache-ignore-*` mkdtemp view contains only empty directories and copies of ignore rules; its exact removal is permitted and never reaches linked caches. |
| `core/worktree.ts` | A disposable worktree copy after its callers verify clean, merged Git content. Failed creation retains existing branches and partial checkout data. The opt-in job-close caller additionally verifies all checkout/reflog commits on remote branches before non-force Git removal. Its only cache-removal call covers physical, untracked Unity Libraries proven absent at job creation; these are job-created regenerable caches. Linked/shared caches, unknown ignored files, uncommitted work, unknown provenance and unproven process shutdown are retained. See `docs/worktree-lifecycle.md`. No new removal expression is allowlisted. |
| `core/sqlite-maintenance.ts` | Exact archived row selection, after archive commit; copy failure rolls the source transaction back. |
| `core/sqlite-migrations.ts` | Backup recovery under the migration writer lock, after reading original rows from the durable pre-migration snapshot. Failure rolls back and retains the snapshot. |

Approvals and completed wait records are not exceptions: they are archived.
Run pruning and job overflow are not exceptions: they are archived. No removal
or mutation is allowed in `src/core/transcripts/` or the history inspector.

Job-store locks and worktree leases are also archived. Their versioned metadata
records a process creation identity and a unique nonce. Complete metadata is
published with an exclusive hard link, so interrupted publication cannot leave an
empty canonical lock. Confirmed dead owners are claimed by an exact nonce rename
before the canonical lock moves into its owner directory and that directory moves
to a unique archive under `.metadata-leases/`. Original metadata bytes are retained;
worktree contents are untouched. Live, unverifiable, malformed and legacy owners
stay protected. Recovery never expires a live owner by age. Filesystems without
hard-link support fail closed.

## Read-only owner-data audit

`scripts/audit-run-recovery.ts` only reads bridge JSON/logs and uses the existing
read-only CLI transcript readers. It does not start `startUi`, create tokens,
repair malformed JSON, open a CLI database for writing or launch an agent. Build
this script to a temporary `.mjs` outside the owner's data roots with esbuild, then
run it with Node; an optional first argument selects the bridge home. It reports
archived runs, distinct durable jobs, recovered jobs and transcript availability
per agent. Availability means a reader found a supported transcript, even if its
first bounded page has no displayable messages. Reader discovery bounds are in
`docs/transcripts.md`; no run/job history count limit is imposed.

## Retention configuration and upgrade behavior

History is **archived, never automatically deleted**: messages, jobs, run logs, completed
approvals and wait records remain available after maintenance. `agent-bridge doctor` checks
storage; `doctor --backup` creates a verified snapshot. See [storage and recovery](../storage/).

`bridge.db` uses SQLite `PRAGMA user_version` (currently schema 9), with ordered migrations
for messages, decisions, legacy history tables, session identity and durable delivery. In 0.30.0,
history and conversations move into independently versioned `history.db` v1 through a protected,
verified copy; legacy tables remain intact. See [conversation storage](../conversation-storage/).
Unversioned databases upgrade through version 1. Pending
migrations run in order in one transaction, after a consistent SQLite backup (including committed
WAL data). Opening a newer schema fails without changing it. Three recent `.backup-*` copies
stay beside the store; older backups move into `archive/` and are never deleted automatically.

JSON stores use `version: 2`. Legacy config, preferences, jobs and runner state remain readable;
the first upgraded write backs up the old file. `jobs.json` is now `{ "version": 2, "jobs": [...] }`;
`auto-wake.json` keeps preferences under `peers`. Unknown fields survive updates. Writes replace
files atomically and refuse newer versions. Corrupt JSON moves to `.corrupt-<time>-<id>` with a
warning, preserving its original bytes. Other read errors prevent replacement rather than treating
an unreadable file as empty.

Retention controls are environment variables (nonnegative integers; `0` disables pruning):

| Env var | Default | Retention behavior |
|---|---|---|
| `AGENT_BRIDGE_MESSAGE_TTL_MS` | `604800000` (7 days) | Expired messages move into separate `archive.db` before removal from the primary |
| `AGENT_BRIDGE_QUEUED_MAIL_MAX_AGE_MS` | `86400000` (1 day) | Stale queued messages move into `archive.db` before a peer claims mail |
| `AGENT_BRIDGE_JOB_STORE_LIMIT` | `200` | Finished jobs beyond the limit move into `archive/jobs.json.overflow.json-*`; running and interrupted jobs stay active |
| `AGENT_BRIDGE_RUN_LOG_LIMIT` | `50` | Older finished logs and their metadata move into `runs/archive/`; unfinished feeds stay active |
| `AGENT_BRIDGE_RUNNER_KEEP_MS` | `604800000` (7 days) | Old finished runner state/spec files move into `jobs/archive/`; running state stays active |

Archived messages remain visible in history and searchable through the authenticated history API.
Archived jobs remain continuable, and archived run logs stay readable in the dashboard and `watch`.
Legacy `archived_messages` rows move into `archive.db` without changing the primary schema;
the archive has its own versioned migrations. Retain these archives with your normal backups;
they have no automatic size cap. Runner specs are archived
after consumption and earlier runner state is archived before a new turn starts. Stored job prompts
are retained in full; only displayed previews and the in-memory recent-job list are bounded.
