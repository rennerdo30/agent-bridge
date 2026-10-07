---
title: "History search"
slug: history-search
---

Complete raw conversation retention, project mirrors and paged MCP context access
are documented in [conversation-storage.md](../conversation-storage/). The index
combines bounded preview documents with durable raw records, which extend its
coverage beyond preview limits.


`search_history` searches local bridge messages, cold `archive.db` messages, owner questions and exact answers, all decision
revisions, delegated run logs and metadata (including `runs/archive`), and the CLI transcript
readers for Claude Code, Codex and opencode. Ordinary searches only query the local index:
they do not start a CLI, read usage limits, or call a model. Returned text still occupies
the calling agent's context, like every MCP result.

The elected broker owns a background worker for indexing. Bridge migration **v4**
introduced derived search tables; **v8** adds append-only conversations and source checkpoints.
AB-167 moves these tables and conversations into independently versioned
`history.db` v1 using a protected backup, bounded copy, row counts and SHA-256
verification. Legacy tables remain intact; readers fall back until verification
finishes. See [migration and kill switches](../conversation-storage/).
The shared migration executor takes a SQLite backup before
changing an existing database. The archive database remains **v1**. Source files and cold
databases are opened read-only; malformed metadata is skipped without renaming or repairing it.
Indexing does not acknowledge messages, alter decisions, or rewrite CLI transcripts/run logs.

The migration probes `node:sqlite` by creating an in-memory FTS5 table. When supported, it creates
an external-content FTS5 index with `unicode61` tokenization and ranks hits with `bm25`.
When unavailable, v4 creates ordinary tables only and uses a documented **plain** fallback:
case/diacritic-folded literal substring AND matching, newest first. It is slower and has
substring semantics rather than FTS word semantics. The `engine` response identifies the mode.
An existing v4 schema retains its chosen engine until the split; `history.db` v1
probes the current runtime when it creates its independent index. Reindex changes data, never schema.
Changing the engine/schema requires a future backed-up migration.

The runtime probe and design follow the primary [Node SQLite API](https://nodejs.org/api/sqlite.html)
and [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html).

## Incremental work and rebuilds

Each bounded background index batch reads at most 100 primary message rows, 100 live message queue rows,
100 decision revisions and 100 cold archive rows. A derived insert queue captures new messages
even if SQLite later reuses primary rowids or the broker archives them before the next tick.
Broadcast copies share one message hit; sender and recipient identities remain filterable.
Source cursors and document writes commit in one transaction.

Discovery streams at most 32 filesystem entries plus 32 opencode session rows per tick.
Two registered files are polled fairly per tick. JSONL/run reads are capped at 64 KiB; the
existing opencode reader caps each page at 200 parts / 512 KiB. Existing transcript header
and preview bounds also apply. Incomplete final lines are retried. Oversized JSONL lines
follow the existing preview reader's bounded discard behavior; tool previews are limited by that reader.
The durable ingestor separately retains exact raw chunks, including oversized and unknown
records discarded by previews. Indexing, backfill and project mirrors run off the broker's
message-dispatch path; idle batches use two seconds and backlogs use 100 ms.
Run metadata has its own searchable snapshot, refreshed by a stored content hash even when the log has no new bytes. Unknown metadata fields remain searchable as quoted JSON.
Message text is bounded by the bridge's accepted message size. Run hits are bounded chunks.
New file discovery repeats after 30 seconds; large homes take multiple ticks to discover/index.
This is eventual indexing, not a synchronous freshness guarantee on each search.

`agent-bridge reindex` resets only derived documents, tags, file registrations and cursors, then
authenticates directly to a running broker for bounded batches until discovery and one complete file polling sweep are idle.
When no broker is running it opens the store through the same backed-up migration executor and runs bounded batches locally. It never joins a chat peer or creates decision notification mail.
It retains learned session aliases and pending live-message captures. The broker keeps serving
peers between batches. Continuously growing history can extend completion time. Rebuilds reread
preserved source files/databases and retained conversation records; indexing never deletes
originals. It cannot recover content erased before its first durable capture.

## Exact MCP contract

```ts
search_history({
  query: string,                       // trimmed, 1..1000 characters
  filters?: {
    project?: string,                  // canonical project path
    session?: string,                  // exact CLI session id or known peer identity
    job?: string,                      // exact job name
    agent?: "claude" | "codex" | "opencode" | "other",
    kind?: "message" | "run" | "decision" | "transcript" | "approval" | "progress" | "report",
    since?: number | string,           // epoch milliseconds or ISO8601 with timezone
    until?: number | string            // inclusive bounds; since <= until
  },
  limit?: number,                      // integer 1..50, default 10
  answer?: boolean                     // default false; true permits model tokens
})
```

Query text becomes at most 32 literal Unicode word/number tokens, joined with AND. Raw FTS
operators are not accepted as a query language. Session filtering includes persisted aliases
learned when peers bind their CLI sessions; run metadata connects CLI transcripts to jobs.
Run timestamps mean run start (`jobStartedAt`, UTC filename start, then filesystem birth time).
Messages, decisions and transcripts use their source timestamps.

```ts
{
  engine: "fts5" | "plain",
  hits: [{
    id: string,                        // message:/decision:/run:/transcript: source id
    kind: "message" | "run" | "decision" | "transcript" | "approval" | "progress" | "report",
    agent: string,
    at: number,                        // epoch milliseconds
    snippet: string,                   // at most 320 characters, plain text
    link: string,                      // intended conversation/session/run navigation
    sourceLink: string,                // authenticated /api/history/<encoded id>
    message: string | null,
    job: string | null,
    run: string | null,                 // .log basename
    session: string | null,
    cursor: string | null,             // JSONL byte/opencode cursor or run byte offset
    conversation?: string | null,     // retained context id for get_conversation
    project?: string | null           // canonical project path
  }],
  answer?: {
    text: string,                      // at most 4000 characters; empty on error
    agent: "claude" | "codex" | "opencode" | null,
    model: string | null,
    sources: [{ id: string, link: string }], // authenticated source links
    error?: string
  }
}
```

Message navigation: `/?message=<id>`. Transcript navigation:
`/?session=<id>&agent=<agent>&from=<cursor>[&child=<id>]`. Run navigation:
`/api/runs/<basename-without-.log>?from=<offset>`. Decision navigation:
`/api/decisions/<topic>/history`. The dashboard page owner must handle message/transcript
navigation query keys; this change deliberately does not edit `src/cli/ui-page.ts`.
`sourceLink` works for offline historical CLI sessions too, without a connected peer.

## Dashboard HTTP contract

Authenticated `GET /api/search?q=<query>&project=...&session=...&job=...&agent=...&kind=...&since=...&until=...&limit=...&answer=true`
uses the same response as MCP. Omitted filters/limit/answer have the same defaults. Query parameters
must occur once; unknown or invalid parameters return **400** `{error:string}`. `answer` accepts
only `true` or `false`. Time filters accept decimal epoch milliseconds or timezone-qualified ISO8601.
Requests use the existing dashboard host validation and `ab_ui` HttpOnly/SameSite cookie;
unauthenticated requests return **403** before searching or answering. These are local-only routes.

Authenticated `GET /api/history/<URL-encoded hit.id>` returns an indexed, bounded source document:
`{id,kind,agent,at,body,link,message,job,run,session,cursor}`. Unknown ids return **404** and malformed ids
return **400**. This endpoint reads the derived excerpt; it does not fetch arbitrary paths or repair
the original source. Render bodies/snippets as text, and treat links as local URLs.

The HTTP routes only read the index. The broker's worker and `agent-bridge reindex` initialize it.
Use `get_conversation({id: hit.conversation, limit: 20})` for complete retained context,
then pass each returned `next` as `after`. OpenCode uses `bridge_get_conversation`.
The authenticated HTTP equivalent is `/api/conversations/<encoded id>?after=...&limit=...`.

## Optional answers

`answer=true` sends at most eight top snippets to one cheap model, never the full corpus. Configure
the order and model ids in `config.json` (ordinary delegation model defaults remain unchanged):

```json
{
  "historyAnswer": {
    "preference": ["codex", "claude", "opencode"],
    "codexModel": "gpt-6-luna",
    "claudeModel": "haiku",
    "opencodeModel": null
  }
}
```

Selection checks the CLI binary and the existing `usage_limits` readers. Exhausted limits or
failed/unknown availability skip a provider; answers do not silently switch to paid credits.
Codex requires the configured model in its available model list. Claude uses its configured alias.
opencode requires an available id whose local verbose model catalog reports zero input and output prices; null selects the first such model.
No fallback to a larger default model occurs. Model names alone never establish that a model is free. Catalog prices are provider metadata, so final billing/plan behavior remains a live-provider acceptance check.

Answer prompts label excerpts as untrusted data, request no tools and require `[<hit.id>]` citations.
The runner uses an isolated temporary cwd, explicit model ids and a 60-second generation timeout.
Claude disables tools, MCP config and hooks; opencode disables tools/permissions and external plugins; Codex ignores user configuration (retaining auth) and uses a read-only sandbox with approval requests disabled. Source links accompany the answer. Empty answers, missing
citations, unknown source ids, provider errors and unavailable capacity return `answer.error` while
preserving hits/sources. Empty searches return a fixed no-hits answer without any probes/model run.
Availability/usage probes have their existing CLI timeouts, separate from generation.

Tests use temporary homes and fake model runners. Real provider generation, billing, arbitrary
installation-specific CLI flags, large-home latency and the supervisor's dashboard navigation UI
remain separate acceptance checks.
