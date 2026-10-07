# Local conversation storage

The authoritative store remains `~/.agent-bridge/bridge.db`. The backed-up,
transactional SQLite migration adds durable conversation metadata, source
checkpoints and append-only raw records. `archive.db` and existing JSON files
keep their own versions and layouts. An older binary refuses an unsupported
SQLite version before writing. Failed migrations roll back and retain backups.

## What is retained

- Claude Code main transcripts, separate native children, and inline sidechains.
- Codex main and native rollout files, including archived sessions and inherited
  records actually present in a rollout. Explicit CLI parent metadata identifies
  native ancestry; ordinary forks are not guessed to be native children.
- OpenCode sessions, message data and part data from its local SQLite database,
  including bridge jobs and native children at every depth. Observed revisions
  append snapshots, so later updates do not replace already captured data.
- Every bridge message envelope: direct, sibling, broadcast, job reports, and
  quiet observer copies. Small durable envelope keys survive primary rowid
  reuse, claiming, archival and forwarding. Message bodies remain in the
  existing live/archive stores until the worker copies them.
- Every decision revision, complete run logs and run metadata, saved job
  snapshots, archived approval requests, and new progress/approval events.
  Approval capabilities (tokens and listening ports) are excluded.

Raw JSONL chunks include system/developer/reasoning records, unknown records,
tool payloads and large lines omitted by dashboard previews. The source bytes
are stored as SQLite blobs; text is indexed by the existing FTS5 index, with
the existing literal-search fallback where FTS5 is unavailable. Full raw content
is distinct from the deliberately bounded dashboard preview readers.

No source is deleted, truncated, resumed or modified by ingestion. A replaced
or shortened JSONL file creates a new retained generation. Stable source ids,
generation numbers and byte offsets make retries and restarts idempotent.
Deletion of a CLI source cannot delete bytes already captured in the central
store. Reindex resets derived search data and reconstructs it from retained
records as well as available sources.

This is eventual capture, not a promise to recover files erased before capture
or every intermediate token revision rewritten by a CLI between observations.
OpenCode updates are detected by its `(time_updated, id)` cursor. Concurrently
changing large parts retain the observed chunks and restart at the new revision;
the settled revision is copied completely. Concatenate raw chunks by source and
generation to reconstruct the exact captured bytes.

## Bounded background work

The elected broker starts one `history-worker.mjs`. Source discovery, parsing,
FTS writes, backfill and mirrors run in that worker, away from message dispatch.
Each source chunk is at most 64 KiB; two file sources run per batch. Bridge
envelopes, decisions, archive messages and job snapshots each copy one chunk per
batch. Derived message batches also stop at a 512 KiB body budget, allowing one
record to cross the budget. Headers are cached by file identity rather than
rereading the beginning of every rollout on every poll.
Queued job snapshots stop at 100 entries or 8 MiB, allowing the final snapshot
to cross that byte budget. Uncaptured jobs are reconsidered on the next sweep.

Watch notifications prioritize changed registered CLI files; bounded polling
is the portable fallback. Discovery revisits roots every 30 seconds and streams
32 filesystem entries and 32 OpenCode sessions at a time, without depth or total
inventory truncation. Backlogs run batches at 100 ms; idle polling uses two
seconds. SQLite contention defers and retries batches without advancing their
transactional cursors. This bounds individual batches; a large existing corpus
takes multiple batches to finish. It does not establish zero contention or a
measured throughput claim for every owner workload. See [performance.md](performance.md).

## Search and context retrieval

```json
{"query":"terrain scheduler","filters":{"project":"D:/projects/game","agent":"codex","kind":"transcript"},"limit":10}
```

Call `search_history` with project, session, job, agent, kind, since and until
filters. Kinds include `message`, `run`, `decision`, `transcript`, `approval`,
`progress` and `report`. Learned session aliases and native ancestry connect
job filters to historical CLI records. A handoff changes authority, not history
identity; the saved job name remains searchable by its new coordinator.

Retained hits include `conversation`, the full conversation id. Call:

```json
{"id":"opencode:ses_example","limit":20}
```

with `get_conversation`. Pass its `next` as `after` until `next` is null. Pages
use monotonically increasing record ids and a 512 KiB raw-byte response budget.
Each record has source, generation, offset, timestamp, text, exact base64 `raw`,
and optional SQLite part/message id. JSONL can span records; concatenate decoded
raw chunks by source/generation/offset. SQLite sources identify individual
message/part revisions. Streaming text chunks can split UTF-8 code points, so
use `raw` when exact reconstruction matters.

OpenCode exposes `bridge_search_history` and `bridge_get_conversation` through
its normal tool prefix. Main sessions and delegated jobs can read this context.
The authenticated dashboard also has `/api/conversations/<encoded id>` with
`after` and `limit`, and its existing `/api/search` accepts `project`.

## Project folder and settings

Project identity is the canonical Git project root: linked worktrees and drive
aliases share the main project's identity. Non-Git projects use the physical
directory. That project's `.agent-bridge/` holds a SQLite replica named
`conversations-<project hash>.db` and optional `config.json`. Only conversations
belonging to that project are copied. Replica consumers open SQLite read-only.
Shared bridge threads associated with a project are copied in full. Session
aliases and job tags follow late bindings without rereading unchanged bodies.
Synchronization copies at most eight raw records and checks 32 metadata ids per
batch; unchanged bodies are not reread. Late ownership associations are copied
on subsequent bounded sweeps.

The folder is excluded through Git's local `.git/info/exclude`, including the
common Git directory for linked worktrees. Agent-bridge never changes the user's
`.gitignore`. Writable replicas, backup folders and exclude files refuse links
in their paths. A Git project whose local exclusion cannot be ensured defers
mirroring until that exclusion is available.

Settings precedence is environment, project agent section, project top level,
global agent section, global top level, defaults. Shared machine resource-slot
capacities remain global. For example:

```json
{
  "codexModel": "gpt-6.1-sol",
  "effort": {"codex": "high"},
  "native_subagents": 4,
  "projectGroups": true,
  "opencode": {"opencodeModel": "provider/model"}
}
```

`native_subagents` aliases the project's `codexSubagents` default; false disables
it. Model/effort defaults and permission options use the existing validated
config fields. Project settings are read without migrating or rewriting either
the local or global config. A watcher reloads changes.

Agent-bridge never deletes the folder. If the owner deletes a replica or the
folder, it rebuilds from central retained records on the next sync. Settings
deleted by the owner fall back to global defaults. Moving a folder to another
project creates a replica with that project's hash; existing replicas remain
untouched. Moving the entire project changes its path identity: historical
records remain searchable under the old project path, and newly observed session
bindings associate those sessions with the new path. Old local files are kept.

All data stays local. Indexing and ordinary context search make no model calls
and do not advertise or export conversation content to other PCs. Existing
explicit paired read operations retain their authentication and permissions.

## Validation

`test/conversations.test.ts` verifies exact oversized-byte retention, cursor
restart/deduplication, replacement generations, OpenCode messages/parts/native
grandchildren, old revisions, paging, mirrors and settings. The context tests
cover envelope copies, decisions/events, OpenCode delegated MCP access and a
complete sanitized 0.29.10 disk-layout upgrade. Retention tests still reject
unreviewed production deletion or truncation.
