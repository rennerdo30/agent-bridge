---
title: "Dashboard transcript API"
slug: transcripts
---

## Durable run and job history

All routes below require the dashboard's `ab_ui` cookie and local Host. They
inspect data only: no broker peer needs to be online to read a historical chat.

| Route | Response |
| --- | --- |
| `/api/state` | Existing state, with newest 50 `runs`, `runsNext: string|null`, `runsTotal: number`. |
| `/api/runs?before=<cursor>&limit=<n>` | `{ runs, next: string|null, total: number }` |
| `/api/runs/<name>?from=<byte offset>` | `{ text, next: number, size: number }` for active or archived logs. |
| `/api/runs/<name>/chat?from=<cursor>` | `{ items, next }`, the same transcript item contract as session chat. |
| `/api/jobs/<job name>/subagents` | `{ subagents: [{ id, title, status, startedAt, updatedAt }] }` |
| `/api/jobs/<job name>/subagents/<id>?from=<cursor>` | `{ items, next }`, with actual native-parent ownership checked. |

Run inventory has no hard cap. The collection defaults to 50 entries per page;
`limit` accepts integers 1 through 500. It sorts by `startedAt` descending, then
name descending. Pass `next` unchanged through `encodeURIComponent` as `before`.
The composite cursor `<startedAt>:<name>` includes every tied timestamp across
pages; a bare millisecond timestamp also works but selects strictly older times.
`total` counts all distinct entries, and `next` is null at the end. `runsNext`
starts paging immediately after the initial live-state page.

Archived logs keep their original public run name even when the archived log and
metadata were independently renamed to `<original>-<timestamp>-<uuid>`. Both
legacy and current archive layouts are supported; active files win duplicates.
Job recovery reads active jobs, legacy arrays, overflow archives, migration
backups, and AB-84 `archive/jobs-*.json` documents. Active jobs win archive copies.
Malformed snapshots are skipped without repairing, moving or overwriting them.

Existing run summary fields remain. Additions are `archived`, `recovered` and
`hasLog`. A job with no matching log is represented once with `name` and `job`
equal to its saved job name and `recovered:true, hasLog:false`. It exposes saved
`agent`, `model`, `title`, full `prompt`, preview `task`, `by`/`owner`, `session`/
`sessionId`, `startedAt`, `finishedAt`, `updatedAt`, `workdir`, `worktree`, `branch`,
and optional `parentJob`/`rootSession`. Finished status remains `done` or `failed`;
an old running snapshot is `interrupted` because it does not prove liveness.
Its log endpoint returns `{ text:"", next:0, size:0, recovered:true, hasLog:false }`.
Use the `/chat` route for its actual CLI conversation. Job-native routes work for
live and recovered jobs, resolving saved `sessionId` or legacy Codex `threadId`,
with logged run metadata as a fallback.

Errors: 400 for invalid collection limit/cursor or transcript cursor; 403 for
missing/invalid authentication or foreign Host; 404 for unknown run/job, invalid
native child, foreign child or missing transcript; 409 when the saved session id
is absent. A missing native-child store gives an empty list. Only GET is accepted.
Existing log byte cursors and transcript cursors remain separate contracts.

## Live session transcripts

These GET-only routes read a local peer's own CLI store. They require the same
`ab_ui` cookie as the dashboard, and resolve the peer by its current broker name:

| Route | Response |
| --- | --- |
| `/api/sessions/<encoded peer name>/chat?from=<cursor>` | `{ items, next }` |
| `/api/sessions/<encoded peer name>/subagents` | `{ subagents: [{ id, title, status, startedAt, updatedAt }] }` |
| `/api/sessions/<encoded peer name>/subagents/<id>?from=<cursor>` | `{ items, next }` |

Encode the peer name and native child id with `encodeURIComponent`. Names with
`host/` refer to another PC and return 404. A child is readable only under its
actual parent. Native child ids allow ASCII letters, digits, underscores and
hyphens, start with a letter or digit, and have at most 128 characters. They are
not paths. Symlinks and junctions outside the CLI store are refused.

Omit `from` on the first read. Pass `next` unchanged on each later read, including
when `items` is empty. Cursors are opaque strings: JSONL uses a byte offset with
an oversized-line discard flag; SQLite uses an update timestamp and part id.
Times in all responses are milliseconds since the Unix epoch. Each item has:

```ts
{
  kind: "user" | "assistant" | "tool" | "subagent";
  at: number;
  text?: string;
  tool?: string;
  summary?: string;
  subagent?: { id: string; title: string; agent: string };
  id?: string;
}
```

OpenCode streams by updating existing parts. Its item `id` is stable: replace an
already displayed item with that id when a later page returns it. Other readers
return append-only items. Tool output is a preview, not the complete tool log.
Status is conservative: `unknown` means the store does not prove whether that
agent is currently running. File modification time alone is not a completion
or liveness signal.

Example chat responses (anonymized):

Claude Code:

```json
{"items":[{"kind":"user","at":1791277200000,"text":"Inspect the module."},{"kind":"tool","at":1791277201000,"tool":"Bash","summary":"type module.ts"}],"next":"j:812:0"}
```

Codex:

```json
{"items":[{"kind":"assistant","at":1791277200000,"text":"Checking the module."},{"kind":"tool","at":1791277201000,"tool":"exec","summary":"Read module.ts"}],"next":"j:944:0"}
```

OpenCode:

```json
{"items":[{"kind":"assistant","at":1791277200000,"text":"Module review.","id":"prt_example"}],"next":"o:1791277200500:prt_example"}
```

Errors are JSON `{ error: string }`: 403 for an absent/invalid cookie or foreign
Host, 404 for unknown/remote peers, invalid ids, missing transcripts or foreign
children, 409 when a peer has no session id yet, and 400 for malformed cursors.
Missing native-child storage gives an empty list. Unknown record types and
malformed records are skipped. An incomplete final JSONL line waits for its
newline; an oversized line is discarded over successive pages. File truncation
resets an offset beyond the new file length. Restart a chat at `from=0` if the CLI
replaces a transcript with a different file of the same size.

## Storage and bounds

- Claude Code: `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, with
  `<sessionId>/subagents/agent-<id>.jsonl`. `CLAUDE_CONFIG_DIR` replaces `~/.claude`.
  Session-id lookup covers changed cwd encodings. Older inline `isSidechain`
  entries are separated by `agentId`.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`.
  `CODEX_HOME` replaces `~/.codex`. Discovery matches `payload.id` to the rollout
  filename, then checks explicit native parent metadata. Root `session_id` and
  ordinary `forked_from_id` alone do not identify a native child. A persisted
  `subagent_history_start_ordinal` excludes inherited parent turns.
  When present, the CLI's `state_*.sqlite` thread index supplies candidate paths
  and native parent links, opened read-only; rollout headers still validate each
  candidate. Missing, stale or unsupported indexes fall back to file discovery.
- OpenCode 1.18.34: `~/.local/share/opencode/opencode.db`, opened with SQLite
  `readOnly: true`. `XDG_DATA_HOME` replaces `~/.local/share` on all OSes supported
  by the CLI. `session.parent_id` identifies children; text and tool parts join
  their message roles. This reader targets the observed SQLite format, not the
  older JSON-directory store. CLI config-directory overrides do not move data.

Each chat read consumes at most 512 KiB of JSONL or SQLite part data. SQLite pages
also stop at 200 parts and skip individual parts over 512 KiB. Text is capped at
16,000 characters, tool previews at 1,200, and titles at 160 (with an ellipsis
when truncated). Native lists stop at 200 children. Codex discovery examines at
most 20,000 rollouts, newest dates first, caches metadata for 10 seconds, and
reads at most 512 KiB for each header. Legacy Claude sidechain discovery scans
at most the first 8 MiB of the parent stream. Larger or future formats can
therefore produce incomplete native lists without preventing normal chat reads.
No reasoning blocks, developer/system prompts, images, or unknown entry types
are rendered. These APIs do not launch, resume or modify CLI sessions.

## Format evidence

The implementation was checked read-only against local Claude Code 2.1.283/2.1.291,
Codex 0.160.0 and OpenCode 1.18.34 stores on 2026-10-06. Sanitized excerpts live in
`test/fixtures/transcripts/`; SQLite fixtures rebuild a small database in tests.
Relevant primary sources:

- [Claude hook reference](https://code.claude.com/docs/en/hooks): nested
  `agent_transcript_path` and parent `transcript_path`.
- [Claude settings](https://code.claude.com/docs/en/settings): `CLAUDE_CONFIG_DIR`
  includes session history.
- [Codex protocol source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs):
  `SessionMeta`, root session id, thread id and parent-thread source.
- [Codex configuration](https://developers.openai.com/codex/config-advanced/):
  `CODEX_HOME` state location.
- [Codex thread index](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/threads.rs):
  serialized session source and indexed rollout paths.
- [OpenCode 1.18.34 schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/session/sql.ts)
  and [global paths](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/global.ts):
  message/part/session tables and XDG data location.

Automated readers and HTTP tests verify structure, ownership, cursor behavior and
access controls. Dashboard rendering and interactive review remain separate.
