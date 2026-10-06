# User data retention regression guard

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
| `mcp/jobs.ts` | Job-store `.lock` files, including stale locks. |
| `core/storage-lock.ts` | Maintenance lock and empty per-process lease files. |
| `core/notifications.ts` | Empty notification lock directory. |
| `core/node.ts` | Abandoned Unix-domain socket path. |
| `mcp/rewake.ts` | Socket endpoint registrations containing only port, secret and PID. No conversations or prompts. |
| `core/resource-slots.ts` | Expired/released process concurrency leases in `slots`, not messages. |
| `network/files.ts` | Unpublished `.partial-*` transfer staging directory after a failed receive. The sender's original is retained. |
| `cli/smoke.ts`, `cli/reliability.ts`, `cli/reliability-live.ts` | Explicitly created temporary test homes/repositories only. |
| `core/worktree-links.ts` | Symlink/junction itself only; never its destination. Shared by normal cleanup and failed-checkout removal; traversal through a linked root/container or linked components inside that boundary is refused; leaf link entries are detached without traversal. System/home aliases above that boundary are resolved before removal. The private `ab-cache-ignore-*` mkdtemp view contains only empty directories and copies of ignore rules; its exact removal is permitted and never reaches linked caches. |
| `core/worktree.ts` | A disposable worktree copy after its callers verify clean, merged Git content, or an unpublished failed checkout. Git retains tracked content. Uncommitted, unmerged and ignored real files are retained. Ignored links and empty folders contain no unique file bytes. |
| `core/sqlite-maintenance.ts` | Exact archived row selection, after archive commit; copy failure rolls the source transaction back. |
| `core/sqlite-migrations.ts` | Backup recovery under the migration writer lock, after reading original rows from the durable pre-migration snapshot. Failure rolls back and retains the snapshot. |

Approvals and completed wait records are not exceptions: they are archived.
Run pruning and job overflow are not exceptions: they are archived. No removal
or mutation is allowed in `src/core/transcripts/` or the history inspector.

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
