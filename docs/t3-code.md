# T3 Code host adapter (experimental, automatically detected)

## Integration plan: local files first, no changes to T3 (AB-467)

Bridge integrates with T3 Code as far as possible without changing or updating T3. T3 keeps
its state in `<T3CODE_HOME>/userdata/statev2.sqlite` on the same machine, so everything Bridge
reads comes from that store, opened read-only with short connections. Bridge never writes to
it, never runs migrations or checkpoints, and never opens T3's auth tables, `secrets/` or
token files. Every query names its tables and columns.

T3 is a wrapper, not a harness: every T3 chat runs on an ordinary Claude, Codex, opencode,
Antigravity or Muse session that Bridge already sees as a session and indexes from its
transcripts. T3 can also switch a chat to another provider, which starts a new underlying
session. Integration therefore **links** T3 chats to those sessions and transcripts; it never
adds a second entry for the same chat.

| # | Package | Source in the T3 store |
| --- | --- | --- |
| 1 | T3 chat title, status and badge on the existing session entries, across provider switches (done, below) | `orchestration_v2_projection_threads`, `_provider_threads`, `_subagents`, `_runs`, `_runtime_requests` |
| 2 | History: one conversation per T3 chat, linked to the provider transcripts it ran on, without duplicate messages; then tool calls, commands, file changes and attachments | `_turn_items`, `_provider_threads` (run ranges per provider), `_subagents`, `userdata/attachments` |
| 3 | Link chats that share a folder (usually main chats in the project root) by the session's first prompts (below) | `orchestration_v2_projection_messages` plus the CLI's own transcript |
| 4 | T3 details for sessions on paired PCs, each PC reading only its own store | the paired dashboard read |
| 5 | Optional: wake an idle T3 chat for new Bridge mail | the running T3 app over loopback; a database write would start no run and could corrupt T3's state |

Messages and thread metadata already reach history search (next section); until package 2
links them, the same messages can also appear through the provider transcripts. The host
adapter further below stays for hosts that inject T3's scoped transport. T3 itself discards
intermediate message edits when it compacts; those cannot be recovered from any source.

## T3 chats on session entries

T3 gives most chats a folder of their own (`worktreePath`). In `GET /api/state`, a local
session gets a `t3` object (`id`, `title`, `provider`, `model`, `projectRoot`, `status`,
`parentTitle`, `harness`) when it runs in a T3 chat's folder and exactly one candidate chat
there fits its agent. The dashboard keeps the project folder as the session's title: for a T3
worktree chat that is its T3 project's folder (`projectRoot`) instead of the worktree's
generated name. The chat title goes on the second line, with a T3 badge and "waiting for an
answer" while T3 has a pending request for the chat. Every session, T3 or not, also shows a
harness badge for the agent it runs on (Claude, Codex, opencode, Antigravity, Muse). A plain
Claude session without a T3 chat shows its own chat title on the second line: the newest
`ai-title` record in its transcript (`src/core/session-titles.ts`): read from the end, at
most every 30 seconds and only when the file changed; a session without a known title is searched
up to 4 MB back once, since long tool output can push the newest title megabytes back. A plain
Codex session shows the chat's name from Codex's own state database (`threads.name` in the
newest `state_<n>.sqlite`), else the first line of its first prompt (`threads.title`): one
read-only primary-key lookup at most every 30 seconds. Other providers follow (AB-474). Status is `waiting`, else the latest
run's status (`running`, `queued`, `done`, `failed`, `interrupted`, `cancelled`), or `idle`.

- **Agents:** a chat's agent comes from T3's driver kind (`default_provider`, and `driver` in
  `_provider_threads`), not the provider instance name. An unknown driver never links.
- **Candidates in a folder:** the chat that owns it: a top-level chat, or a child whose known
  parent works in another folder or the project root. A T3 delegated task that ran in its
  parent's folder (`app_owned`) is a separate session, so it counts only while it has an
  active run. Provider-native subagents run inside the parent's process and never count. A
  child whose parent is unknown (deleted or unreadable) never owns a folder.
- **Provider switches:** a chat matches every agent it has run on. `harness` is `current` for
  its present provider and `earlier` otherwise. All connected sessions of one chat fold into
  one entry in the dashboard lists (the current provider's, else the newest), taking their
  subagent runs and child sessions along; folded sessions stay reachable by their own pages,
  linked from the chat's session page.
- **Shared folders (AB-470):** when the folder alone is not enough (a project root, where main
  chats and plenty of non-T3 sessions work, or a worktree with several candidates), the session's
  first prompts are read from its own CLI transcript (Bridge's transcript readers, first page)
  and compared with the T3 user messages of the candidate chats in that folder: whitespace-
  normalized, first 300 characters, up to 8 prompts from the session's first hour; each prompt
  only matches a T3 message within 10 minutes of it. T3 stores the same prompt text the provider transcript holds;
  injected context (instructions, environment blocks, local commands) is skipped. Exactly one
  matching chat links. A match is kept for the session (and wins over a lone remaining
  candidate); a session without a match is retried after about a minute, or ten once its
  compared prompts can no longer change (eight seen, or its first hour and window are over). An unreadable message table costs only these matches. In a project
  root (or a worktree that is the root) a chat is never linked by being the only candidate.
  **Known limit:** a provider fork or resumed session that copies its parent's first prompts
  matches the parent chat; with both connected the claim guard leaves both unlinked.
- **Never guessed:** no match or several matching chats, two same-agent sessions claiming one
  chat, and deleted chats get nothing and keep their usual entry.

Folders compare by physical location: separators, a trailing separator and (on Windows)
case do not matter, and drive aliases (SUBST, mapped drives, junctions, symlinks) resolve
through Bridge's `physicalPath`; no drive layout is assumed. Only this PC's CLI sessions are
matched: Bridge jobs and subagent sessions running in a chat's folder are not that chat. A
session whose agent no chat in its folder has run on yet (right after a provider switch) also
triggers one early rebuild.

The folder index is rebuilt at most once a minute, or once early (after 10 seconds) when a
session appears in a folder the index did not know; a store that cannot be indexed is retried
after 10 seconds, not on every poll. Per poll only indexed lookups for matched chats run. A
missing, busy, locked or unknown-schema store means no T3 details. Tests:
`test/t3-sessions.test.ts` (synthetic store; no T3 install needed).

## Local history (independent of host transport)

Bridge's existing background history worker can retain local T3 history without OAuth,
an MCP network connection, or an active provider session connected to Bridge. It reads
`<T3CODE_HOME>/userdata/statev2.sqlite` (default `~/.t3/userdata/statev2.sqlite`) and the
nonsecret `userdata/environment-id`. An invalid explicit home refuses that source;
it never falls back to the default. Test workers with `AGENT_BRIDGE_TEST_ROOT` never
discover T3 implicitly; fixtures must supply a synthetic `TranscriptPaths.t3`.

**Default coverage is project/thread metadata only** (including archived threads, title and
recorded parent/fork relation). T3 is a wrapper over ordinary provider sessions whose
transcripts Bridge already indexes, so importing T3's copy of the message text would show
every message twice in search (AB-473). In this default no message payloads are read; only the
event log's last sequence and identity are checked to detect a replaced or rolled-back source.
The message import described below stays available to explicit callers
(`ConversationIngestor` option `t3Messages: true`); it adds surviving v2
`message.updated` events. Linking T3 chats to the provider transcripts they ran on is
tracked separately (AB-469/AB-470). Conversations use
`t3:<environment-id>:<thread-id>`, with agent `other`; these IDs are T3 identities.
If that composed key exceeds the public 256-character session-filter limit, a
stable SHA-256 key is used instead. Exact environment/thread IDs remain in retained
metadata and event provenance; source IDs are never truncated.
Metadata project roots pass through Bridge's normal project mapping. This does not
join provider-native sessions or infer coordinator/main roles.

The reader validates the three allowlisted tables' required columns/keys, opens a
short read-only connection with a 25 ms busy timeout each tick, and scans ordered
primary-key event metadata windows from sequence zero. It fetches supported full
message payloads in 64 KiB byte chunks through the existing compressed retention,
derived search indexing and durable cursors. Metadata uses periodic keyset pages.
Before any whole-value CAST or JSON evaluation, a length-only query admits at most
1 MiB of encoded message JSON. Larger messages receive an explicit
`t3:unavailable-oversized-message` receipt and incomplete coverage, without fetching
their payload. The bound includes JSON overhead, not just message text.
Backlogs participate in the existing worker's discovery state and budget; there is
no extra scheduler. Missing, busy or unsupported sources preserve retained history
and native import cursors. Replacement file/environment identity or a decreasing
highwater refuses that source, preserving its prior checkpoint.
File/environment binding is checked again after SQLite opens and before destination
publication, rather than trusting the pre-open pathname sample alone.

Raw `t3:fragment` records do not certify completeness. A separate `t3:complete`
receipt identifies an entirely retained event by sequence and event ID. If a pending
event disappears during T3 compaction, partial bytes remain with an explicit
`t3:incomplete-compacted-source` receipt; later retained revisions import independently.
Unknown message versions/shapes receive unavailable receipts. Source availability
and coverage are recorded under `durable-t3:*:status` in existing history cursors.
T3 keeps first/latest message revisions during compaction: revisions already removed
before Bridge observes them cannot be recovered. Tools/activity, attachments as
separate assets, and fork-inherited visible timelines are outside this package.

`test/t3-history.test.ts` uses synthetic installed-schema databases to check searchable
imports, archived lineage, append/bootstrap, restart/chunk retention, compaction,
index failure recovery, source replacement/schema/busy isolation, WAL concurrency
and source preservation. Owner history ingestion and installed/live acceptance are
not part of these offline fixtures.

AB-446 adds a scoped MCP HTTP adapter for session messaging and T3-owned tasks. AB-457 automatically detects deliberately injected transport and defaults validated T3 sessions to a reduced MCP surface. It does not install, update or configure T3. Ordinary Bridge sessions without injected transport retain their provider paths and full tool surface.

## Prerequisites

The process starting the Bridge MCP server must deliberately supply:

- `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` from that exact T3 caller's runtime environment.
- The normal underlying provider selection, such as `--agent=opencode`, `--agent=muse`, `--agent=claude` or `--agent=codex`. T3 is a frontend, not a new provider kind.

`AGENT_BRIDGE_HOST` absent or `auto` enables detection only when at least one transport field is present; both must then validate and negotiate successfully. No transport fields means an ordinary session. Partial, malformed, expired, rejected or wrongly scoped automatic transport refuses with a sanitized error before Bridge registration; it never falls back to a native provider route. Node/entrypoint hints alone, process names and tools in the model's inventory are not transport evidence. Explicit `t3` retains the former opt-in behavior and requires transport even when both fields are absent. Explicit `off` or `native` disables host detection. For backward compatibility every other explicit value (including `full`, empty and unknown selectors) also retains the old no-host behavior and is never auto-overridden. To keep host delivery with all tools, use the independent MCP profile selector below.

Never copy a scoped token into command arguments, URLs, Bridge configuration or logs. The adapter reads only these runtime environment variables. It does not inspect provider MCP configuration, credential files, T3 databases or session stores for credentials. Ordinary Bridge children, detached job runners and shared broker daemons strip the host selector, `AGENT_BRIDGE_MCP_PROFILE` and every `T3_ACP_MCP_*` variable, including extra environment overrides. Windows daemon creation also supplies the cleaned environment to its creation helper and the daemon's explicit environment block. An inherited active host transport on a delegated/internal Bridge server is refused before negotiation.

The endpoint must use HTTPS or literal loopback HTTP (`127.0.0.1` or `[::1]`). URL user information, queries, fragments, control characters and redirects are rejected. Each operation has a 15-second total deadline, an eight-page tool-discovery limit and a two-MiB HTTP response limit. Connections close after each operation; shutdown aborts outstanding requests. The MCP client's optional notification GET is disabled locally; there is no host watcher, SSE reconnection loop, polling job or terminal/CLI transport fallback.

Source evidence: upstream pin `67c0fc0cdaf963b103518862dd7b68a9c758ecf2`, `packages/provider-acp/src/server/adapter.ts:629-641,1435-1460` exports the scoped ACP transport into MCP-server and provider process environments. Actual inheritance into the Bridge subprocess is still a prerequisite. The audited app version was `0.1.1-nightly.20261019.3360`; the adapter feature-detects rather than relying on that version string.

**Native Codex is currently unsupported without new, deliberate upstream transport injection.** The AB-446 audited native Codex shell had no `T3_*` environment. Its scoped T3 MCP token existed only in provider MCP configuration; Bridge never extracts it. Native Claude's injected SDK MCP configuration likewise does not establish inherited ACP transport. Having T3 tools in the model's tool list alone is insufficient for a separate Bridge server to call them. Automatic detection does not change this boundary or claim that every native T3 session receives reduced tools. No new live host probe was performed for AB-457.

AB-458's [native injection contract](t3-native-bridge-contract.md) traces upstream T3 commit `968dd51704441138559a3fe9c348719f2b11e0c6`. Native Codex receives inline per-thread `mcp_servers.t3-code` URL/header configuration, rather than the token environment described by that pin's older orchestration document. The proposed integration supplies transport only to an explicitly registered local Bridge stdio server. Its upstream patch artifact is hard-disabled pending proof of native-child isolation and runtime-config non-persistence. Neither gate is satisfied by this documentation or its projection fixtures; native acceptance remains open. No Bridge production code or installed T3 files change in this package.

## MCP profiles

Set `AGENT_BRIDGE_MCP_PROFILE` at server startup:

| Value | Behavior |
| --- | --- |
| absent or `auto` | Reduced only after successful T3 capabilities/current-thread negotiation; full for ordinary sessions. |
| `reduced` | Requires a validated T3 binding; otherwise refuses startup. |
| `full` | Retains the legacy full tool surface, including T3 wrappers when hosted. Host identity, delivery, native-child and permission checks still apply. |

Unknown profile values refuse with a sanitized configuration error. Profile selection happens after the handshake and before Bridge registration; an untrusted environment hint cannot hide core tools. The central registration filter removes tools from MCP inventory and applies matching server instructions and delegation parameter hints, rather than asking the model to ignore tools.

| Reduced surface | Tools and behavior |
| --- | --- |
| Hidden app duplicates | `t3_capabilities`, `t3_delegate`, `t3_task_status`, `t3_task_cancel`, `t3_send`; use T3's native tools. |
| Hidden redundant catalogs | `list_models`, `usage_limits`; use T3's native provider/model tools for local tasks. |
| Remote delegation retained | Existing `spawn` names require a nonempty valid paired-machine `host` in both schema and handler. Locality refusal precedes checklist reads, usage checks and job creation. Remote cwd, remoteJobs allowlists, ownership, depth and permission checks remain; a host request never falls back locally. No remote aliases are added. |
| Existing Bridge jobs retained | `peers` status/results and `message_subagent`, `pause_subagent`, `resume_subagent`, `cancel_subagent`, including remote controls. Pre-existing local jobs remain manageable across reloads with the same ownership checks; reduced spawn cannot start new local jobs. Manager initialization/restoration is unchanged. |
| Bridge-owned job management retained | `job_checklist` approves/rejects child proposals and updates retained local job checklists (`project_checklist` changes the template for future jobs). `set_job_outcome` records hold/discard decisions for finished owned jobs with the existing cleanup policy. `max_subagents` controls the Bridge continuation queue when requested by the user; `resource_slots` exposes Bridge admission holders/waiters; `handoff_subagents` transfers owned local Bridge jobs to an authorized local supervisor (remote jobs stay excluded). These operations have no native-T3 task equivalent. Their existing ownership, registration and child/role guards remain; none enables new local spawn. |
| Unique Bridge functions retained | Peer messaging/inbox/notify waits, quiet-mail controls, health/discovery, history, files/transfers, project main/availability/checklists, owner questions/permissions/decisions, native child grants and internal lifecycle hooks. Native child and mail scopes still restrict these tools. |

## Identity and session delivery

Before the first Bridge registration, the adapter initializes MCP, discovers literal supported tools, reads `orchestrator_capabilities`, and checks that its `parentThreadId` agrees with `t3_thread_list.currentThreadId`. Every subsequent connection repeats negotiation and checks the original binding. A changed thread or provider instance refuses before effects.

Bridge keeps its usual provider `agent` and native `sessionId`. A separate `frontend` binding contains `kind: "t3"`, a digest of the scoped endpoint, the exact T3 thread ID and the inherited provider instance ID. It contains no authorization value or raw endpoint. Native `_meta.threadId` is never used as a T3 ID. `peers`, `health` and `t3_capabilities` expose this distinction. The frontend is present in the initial `helloT3`, and brokers without that operation refuse rather than silently discarding it. Hosted registrations, remembered names and project-main identity are isolated from other T3 threads and ordinary provider sessions, including when native IDs are absent or reused. A reconnect of the same bound frontend can replace its old server while retaining its new provider-native session ID.

Incoming Bridge mail uses the existing quiet-message, hop, direct-wake, auto-wake and awaited-reply policy. Eligible arrivals are coalesced into a pointer sent with `t3_thread_send` to the exact bound T3 thread in `queue` mode. The pointer carries stable Bridge IDs and asks the model to read its existing Bridge inbox; it contains no mail bodies. Its deterministic `clientRequestId` is reused for the same pointer. Native Codex queue, Claude channel/rewake, opencode notification wake and Muse/Antigravity hook delivery are suppressed in host mode.

T3 dispatch receipts describe `queued`, `started`, `steered` or `restarted` delivery. They do **not** prove that the model read Bridge mail. Wake acceptance never marks mail read. Only the existing authenticated inbox consumption path does that. Unknown dispatch outcomes remain explicit and are not retried automatically or sent through another route. Mail stays unread for a later inbox call.

Before dispatch, each coalesced pointer is retained in `t3-wakes-<binding digest>.json` in the explicit Bridge home. A protected metadata file lease serializes admission and the existing JSON writer atomically publishes/fsyncs it. The record retains the exact frontend binding, immutable message membership, payload, mode and request ID; it contains no credentials, raw endpoint or message bodies. Every reload/reconnect consults this journal before batching new arrivals. Accepted, unknown and submitted members are excluded from every later operation, even after partial inbox consumption. A crash after admission, or failure to store the final receipt, leaves a submitted record that is treated as uncertain and never automatically retried. Successful receipts and sanitized failure stages are retained separately from inbox consumption.

Failure to retain admission prevents dispatch. Corrupt, incompatible or wrongly bound journals stay at their original path and block automatic wake delivery. Journal errors stop that waker with an explicit logged reason. Capacity is 2,000 retained message memberships per exact frontend; reaching it refuses additional operations rather than deleting outstanding or accepted history. There is no automatic pruning/reset. Any future retention migration must preserve membership so unread mail cannot acquire a new operation ID. Manual inbox reads remain available while automatic wake is blocked.

Provider-native admission is retained. Codex still requires proven main-thread rollout lineage for Bridge tools; an ACP driver without that metadata is refused. Claude native child metadata and live mail scopes still restrict tools. Where native lifecycle hooks exist, hosted hooks may record the native session and child start/end, but never inject or acknowledge Bridge mail. This feature does not add an authenticated shared-MCP native-child transport: use T3-owned tasks for supported hosted delegation, and do not assume native children can use a parent's Bridge connection without existing caller attestation.

## Explicit host tools

These tools are registered only in the **full** profile with a verified host binding:

| Tool | Contract |
| --- | --- |
| `t3_capabilities` | Re-negotiate the scoped binding, supported tools, inherited settings and live composer provider/model/options catalog, including configured custom models. Optional `search` discovers models omitted from the short default list; `omittedModels` is retained. |
| `t3_delegate` | Supply `task` and a stable `clientRequestId`; optionally select a catalog `target` with `providerInstanceId`, `model` and option `{id,value}` entries. Always async, default `isolation: "worktree"`; optional `shared`, title, role and interaction mode. Runtime permissions inherit; no permission override is exposed. Bridge's local depth gate and T3's own provider/permission/ownership gates remain. |
| `t3_task_status` | Read an app-owned `taskId` when its result is needed mid-turn. Preserve `childThreadId`, original run, descendants, pending questions, original summary, later terminal result and `workState` separately. Reading terminal results acknowledges T3's automatic parent delivery. |
| `t3_task_cancel` | Supply `taskId`, stable `clientRequestId` and optional reason. T3 handles cancellation, including later child turns. A terminal published result may stay terminal. No OS process or Bridge job is stopped. |
| `t3_send` | Supply `message`, stable `clientRequestId`, optional `mode` (`queue` by default; also `auto`, `steer`, `restart`). Omit `taskId` to address the exact bound caller thread. Child sends use only the local task-to-thread map learned by successful explicit `t3_delegate`/`t3_task_status` calls; send never calls upstream task status. Unknown mappings refuse and instruct an explicit `t3_task_status` read, which returns the acknowledged result to the caller. The bounded map may require that explicit read after reload or eviction. Arbitrary thread IDs are not accepted. |

Effects use a six-tool literal upstream allowlist: capabilities, current-thread listing, thread send, delegate, task status and task cancel. There is no anonymous RPC passthrough or top-level thread-launch tool. Result schemas and `isError` are checked; transport/error response text is never passed through. An effect whose result is missing, malformed, rejected or mismatched is reported as **outcome unknown**. Retain its request ID and inspect T3 before deciding on any retry; use a fresh ID only for a new operation. Independent review rounds use a fresh `t3_delegate` operation and ID with full context.

Catalog negotiation accepts bounded current compact option descriptors (`id`, optional `label`, typed `values`, optional `default`) and legacy boolean/select descriptors, preserving their reported shapes and inherited option settings. Options accept `{id,value}` arrays or an object keyed by advertised IDs. Duplicate/unknown IDs, wrong types and unadvertised values refuse before delegation. Settings inherit only for the same provider instance and model; explicit entries override individual settings and `[]`/`{}` clears inheritance. If the requested model is absent from the short catalog, delegation makes one bounded search on that same negotiated connection and rechecks its caller binding/settings. It never substitutes a favorite model. Applied option receipts must match requested/inherited settings; a mismatch is an unknown effect with no retry. Legacy hosts without option receipts remain compatible when no options were requested or inherited.

These tasks belong to T3. They are not `JobManager` jobs, do not occupy Bridge job slots, are not listed as Bridge subagents and do not create Bridge completion/read receipts. T3 supplies its own admission and automatic completion notifications; end the turn rather than polling. For pending child questions use T3's pending-request tools or the owner. Existing `spawn`, `message_subagent` and related tools continue to mean Bridge jobs, with host environment removed from their children; reduced spawn requires a remote host.

## Verification boundary

`test/t3-profile.test.ts` adds mocked automatic detection, handshake-before-registration/refusal, current/legacy catalogs and option receipts/search, reduced/full registration/instructions, remote locality refusal and routing, native child/depth guards and shared environment stripping. Its initial 11-case selection produced 10 behavior failures on unchanged production base `9babf816800e1f70a983b86cddf1814f01d0fbc1`. All subprocess, broker, provider and job execution boundaries are mocked. This file is the AB-457 local verification scope; the existing transport/broker fixtures below were not rerun locally.

The retained-control regression adds reduced re-registration of a full session's fixture context: checklist proposal approve/reject through an explicit mocked broker authority, hold/discard through the real outcome owner/finished-state guards with metadata/cleanup mocked, and queue-limit/admission/handoff handler calls with effect boundaries mocked. These three cases fail on unchanged production head `654c1d45935ee0e8967d7006064caa0ab8274437` because the controls are missing. This simulates retained job context, not production restoration or broker authorization transactions. Startup ordering uses a mocked negotiated result; the Codex child test injects a refusing admission callback and proves wrapper enforcement, not rollout-lineage authentication. Live acceptance remains unrun.

`test/t3-code.test.ts` contains only offline fixtures: SDK HTTP replay, schema and wrong-parent refusals, unknown effects, custom catalogs, T3 task handles, native admission/depth guards, durable wake reload/read receipts, persistence failures/corruption/capacity, child and mocked daemon environment cleanup, explicit child-result reads and isolated broker registration/recovery. The initial identity assertion failed on base `4277dc248013b8bc158ac3166974a6c0b07b464f`; accepted/unknown reload, daemon inheritance and implicit-result-acknowledgment regressions failed on reviewed head `ee1b6144a652ec437140b34d623324c69c97cd08`.

Live host acceptance is **NOT RUN**: no provider/ACP session was launched, no live message was sent, and no T3 task was delegated or cancelled to validate this implementation. The parent owns live ACP inheritance, exact-thread idle/busy wake, permission refusals, restart/reload identity and child completion/question/cancellation acceptance. A focused test or typecheck is not that evidence.
