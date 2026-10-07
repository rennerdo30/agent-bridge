---
title: MCP tools reference
---

Generated from [src/mcp/server.ts](https://github.com/rennerdo30/agent-bridge/blob/main/src/mcp/server.ts). Each registered tool has one row below. Availability depends on the calling agent, enabled targets and whether the caller is a delegated job. opencode prefixes tool names with `bridge_`.

The `ask_*` and `spawn_*` tools are expanded for each supported CLI; a session may offer only the other enabled targets. Delegated jobs receive a restricted tool set and explicit messaging grants. `report_progress` is for delegated jobs; `hook_event` is internal and must never be called by an agent.

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `ask_owner` | `askOwnerSchema` (source schema) | File an owner-only decision for your own project in Waiting for you. Check decisions first. Returns immediately; the exact answer arrives later as a waking direct message with reply_to=question id, also sent to the project main. Jobs must ask their main. Use 2–4 options, one recommendation, and concise context; link a concrete artifact for authorization. Never secrets, status, peer questions, playable checks or routine tool approvals. Answers never bypass native approvals or accept implementation. Same project + issue + topic merges; at most five open per session. Unanswered stays visible; destructive blocking or authorization questions cannot default. |
| `withdraw_owner_question` | `id`, `status`, `reason`, `supersededBy?` | Explicitly dismiss your own open question with a reason. Superseded requires a replacement question id. This never answers or allows a tool. |
| `search_history` | `query`, `filters?`, `limit?`, `answer?` | Search local bridge messages (including archives), decisions, delegated run logs and CLI transcripts. Returns bounded snippets with stable source ids and links. Ordinary search makes no model calls. answer=true explicitly spends model tokens on a configured cheap model chosen by availability and usage_limits. Indexing is incremental; use agent-bridge reindex to rebuild. |
| `get_conversation` | `id`, `after?`, `limit?` | Fetch a complete locally retained conversation by the conversation id returned in search_history. Pages contain exact raw bytes (base64) and text chunks with source offsets. Pass next as after; concatenate chunks per source/generation to reconstruct JSONL or SQLite snapshots. No model calls or network export. |
| `decide` | `approval_id?`, `decision?`, `reason?`, `topic?`, `text?`, `scope?`, `source_message_id?` | Answer a pending approval with approval_id and decision (allow, deny or escalate), or record an owner's decision after researching it. A newer decision on the same topic supersedes the previous revision across scopes; history is always retained. Notifications reach sessions in scope once without waking idle sessions. Scope defaults to this project folder. |
| `decisions` | `query?`, `scope?`, `history?` | List current owner decisions or search topic and text (case-insensitive substring). Scope defaults to this project, including decisions for all sessions and this session. history=true also includes superseded revisions, newest first. |
| `project_main` | `to` | Choose a live local master of this project as its main contact. Project addresses reach all available live project sessions, including secondaries. Exact session addresses stay direct. |
| `coordinator_availability` | `unavailable` | Yield this session's project jobs to an available local master, for example before closing or at a usage limit. Set unavailable=false when ready again. The current primary keeps its jobs until explicitly handed back. Explicitly handed-off jobs are excluded. |
| `peers` | None | List the open agent sessions on this machine (Claude Code, Codex, opencode, Antigravity): name, agent type, busy/idle, uptime, working directory and session id. Also shows your own name and settings, your running subagents and the latest unread file-transfer progress on request. Delegated jobs see their parent and siblings (job name, title, agent and status). Use it to pick whom to message. |
| `send` | `to`, `message`, `reply_to?`, `conversation_id?`, `if_no_newer_than?`, `message_kind?`, `message_id?` | Send a message to another agent. "to" is a peer name from "peers", an agent kind ("claude", "codex") when exactly one is online, or "*" for everyone. Delivery means queued in the recipient inbox, not read. Project addresses include available live secondaries. Broadcasts wake every live session according to its settings and include recently seen offline local sessions or known project masters, connected paired-PC sessions and your running jobs; jobs:* targets only your running jobs through existing links, even when authority RPCs are unavailable. Per-recipient results report queueing, not consumption. Direct messages wake idle Claude, Codex and opencode sessions according to wakeOnDirect and available CLI transport; other recipients may read them on their next turn. Auto-wake is handled on the recipient PC, including paired PCs; it is never enabled by send. Use wait_for_message(read_receipt_of=<sent id>) to wait for consumption. If the recipient is offline the message waits for it. When answering with new information, pass its id as reply_to. Do not send pure acknowledgements or repeat a reply as a status note. Delegated jobs can send to their parent, siblings, or exact local session/job names explicitly granted with send_to at spawn. Sibling messages arrive live or wait for the next turn, with a quiet supervisor copy. Sending to a finished sibling returns its saved final report immediately; it will not answer. Do not wait for finished siblings or for read receipts from them. Other sessions and broadcasts are unavailable. Peers shows grants and the sibling thread limit before composing. |
| `send_status` | `message_id` | Look up your message by its durable UUID directly in broker storage and retained archives, without waiting for history indexing. Stored confirms persistence, not delivery or consumption. Pending/not_stored describe the instant checked; an outstanding send may still store it. Retry send with the same message_id to avoid duplicates. |
| `network_status` | None | List discovered LAN instances and explicitly paired broker links. Discovery is untrusted and never connects automatically. Pair using the local CLI. |
| `send_files` | `to`, `paths` | Deliver files or folders into an online peer's inbox. Paired PCs stream bounded chunks with SHA-256 and restart resume, returning a transfer id immediately; progress stays available in the dashboard and inbox on request; only completed, failed or cancelled results are delivered automatically. Limits come from network.maxTransferBytes (default 8 GiB). Older brokers and local delivery keep the one MiB / 128 entry path. Symlinks and junctions are rejected; received files are never executed. |
| `fetch_files` | `from`, `paths` | Pull files into this PC's inbox over a paired encrypted link. The other PC must explicitly configure network.fetchRoots (off by default). Paths are absolute or relative to the source session's working directory and must stay under an allowed root. Returns a transfer id immediately; progress stays available in the dashboard and inbox on request; only completed, failed or cancelled results are delivered automatically. |
| `cancel_transfer` | `id` | Cancel a paired-PC file transfer by its id. Partial files stay unpublished; cancellation is delivered when the peer reconnects. A completed transfer cannot be cancelled. |
| `inbox` | `include_quiet?`, `mark_read?`, `limit?` | Read unread messages from other agents, with quiet transfer progress, sibling copies and acknowledgements excluded by default. Use include_quiet=true (or a read-only mark_read=false peek) to inspect retained copies. Messages are marked read unless mark_read is false. Peeking with mark_read=false does not produce a read receipt. |
| `wait_for_message` | `mode?`, `timeout_sec?`, `from?`, `reply_to?`, `conversation_id?`, `read_receipt_of?`, `resume_id?` | Default mode="notify": register a durable one-shot wait and return immediately. Call once after sending a question, then keep working or end the turn; do not poll or repeat waits. A matching unread message can be returned now; an active channel owns its delivery. Otherwise it arrives through existing direct/auto-wake paths when supported, or on the next hook/inbox call. Global auto-wake settings stay unchanged. Notification waits survive /reload-plugins and session exit, have no timeout, and complete only when matching mail is consumed. Mail stays queued if wake delivery fails or the session is offline. mode="block" waits and returns a message marked read. For compatibility, timeout_sec without mode selects block; read_receipt_of also defaults to block. Single blocking waits are capped at SINGLE_WAIT_SEC seconds; a message timeout arms notify automatically instead of requiring another turn. Claude Code may background calls after 120 seconds; background calls do not survive session exit. A stdio call cannot survive /reload-plugins: peers and SessionStart show a saved resume_id and filters after reconnect. resume_id preserves saved filters and mode; use mode="notify" to convert an interrupted blocking wait. mode="cancel" with resume_id archives a wait without consuming mail. read_receipt_of supports block only and confirms bridge consumption, not a reply or completed work. Nested child waits support block only. |
| `max_subagents` | `count`, `save?` | Change how many background subagents may run at once in this session, effective immediately (a higher limit starts queued continuations; a lower one stops none). save=true also writes it to ~/.agent-bridge/config.json as the default for new sessions. Only change this when your user asks. |
| `auto_wake` | `enabled` | Turn auto-wake on or off for this session. When on, a peer message that arrives while you finish a turn makes you continue and handle it (up to the configured hop limit agent-to-agent hops per conversation). Only change this when your user asks. |
| `ask_claude` | [Delegation options](#delegation-options) | Run Claude Code headlessly in this project with the given prompt and wait for its final answer. This is one blocking call, not a background job or a polling loop. Return its job id and result as received, including errors; do not automatically start another ask call after a timeout. Good for quick second opinions or reviews. For longer or parallel work use spawn_claude. Pass the returned session_id back to continue the same conversation.  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `ask_codex` | [Delegation options](#delegation-options) | Run Codex headlessly in this project with the given prompt and wait for its final answer. This is one blocking call, not a background job or a polling loop. Return its job id and result as received, including errors; do not automatically start another ask call after a timeout. Good for quick second opinions or reviews. For longer or parallel work use spawn_codex. Pass the returned session_id back to continue the same conversation.  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `ask_opencode` | [Delegation options](#delegation-options) | Run opencode headlessly in this project with the given prompt and wait for its final answer. This is one blocking call, not a background job or a polling loop. Return its job id and result as received, including errors; do not automatically start another ask call after a timeout. Good for quick second opinions or reviews. For longer or parallel work use spawn_opencode. Pass the returned session_id back to continue the same conversation.  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `ask_antigravity` | [Delegation options](#delegation-options) | Run Google Antigravity CLI headlessly in this project with the given prompt and wait for its final answer. This is one blocking call, not a background job or a polling loop. Return its job id and result as received, including errors; do not automatically start another ask call after a timeout. Good for quick second opinions or reviews. For longer or parallel work use spawn_antigravity. Pass the returned session_id back to continue the same conversation.  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `spawn_claude` | [Delegation options](#delegation-options) | Start Claude Code as a background subagent and return immediately with a job id. Keep working meanwhile; the result arrives as a message from "claude-job-<id>" (injected automatically, or use wait_for_message with from=<job name>). Several subagents can run in parallel (max the shared job limit).  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `spawn_codex` | [Delegation options](#delegation-options) | Start Codex as a background subagent and return immediately with a job id. Keep working meanwhile; the result arrives as a message from "codex-job-<id>" (injected automatically, or use wait_for_message with from=<job name>). Several subagents can run in parallel (max the shared job limit).  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `spawn_opencode` | [Delegation options](#delegation-options) | Start opencode as a background subagent and return immediately with a job id. Keep working meanwhile; the result arrives as a message from "opencode-job-<id>" (injected automatically, or use wait_for_message with from=<job name>). Several subagents can run in parallel (max the shared job limit).  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `spawn_antigravity` | [Delegation options](#delegation-options) | Start Google Antigravity CLI as a background subagent and return immediately with a job id. Keep working meanwhile; the result arrives as a message from "antigravity-job-<id>" (injected automatically, or use wait_for_message with from=<job name>). Several subagents can run in parallel (max the shared job limit).  Access defaults to read. Supported access, sandbox and model options depend on the target CLI; see the delegated access guide. |
| `usage_limits` | `agent?` | How much of each installed agent's account limits is used: Codex and Claude Code (5-hour and weekly windows, with reset times), and for opencode today's spend plus which models are free. Use it before handing out large or parallel work, to pick the agent with the most room left, or to decide to stop and save state. Costs no model calls; takes a few seconds. |
| `list_models` | `agent`, `query?` | Which models and reasoning efforts a subagent agent accepts, to pick model= and effort= for ask_*/spawn_*. Codex and opencode list their models; for Claude it gives the aliases and effort levels. query filters by name (opencode can list hundreds). Costs no model calls. |
| `dashboard` | None | Open the agent-bridge web dashboard in the user's browser (sessions, delegated runs with live steps, messages) and return its link. Only call this when the user asks to see the dashboard. |
| `set_job_outcome` | `job`, `state`, `reason?` | Record that your finished job is held with a reason or discarded. With jobCloseCleanup enabled, discarded local worktree jobs push their commits and reap only a proven clean checkout. Held jobs and local branches are retained. Only its owning supervisor can set it. |
| `handoff_subagents` | `to`, `jobs?`, `note?`, `switch_project_main?` | Transfer your running and finished local jobs, including nested jobs, to an exact live local Claude Code, Codex, opencode or Antigravity session. The target becomes their supervisor and receives a waking inheritance message. Remote jobs and paired-PC targets are rejected without moving anything. |
| `message_subagent` | `job`, `message?`, `title?`, `effort?`, `model?`, `access?`, `sandbox?`, `terminal_sandbox?`, `bypass_permissions?`, `native_subagents?`, `approvals_reviewer?`, `permission_mode?`, `auto_approve?` | Send a follow-up to a subagent started with ask_* or spawn_* (running or finished), like messaging a native subagent. It continues in its own session with its full context, in the same folder or worktree. While it is still running it gets the message live, at its next step (after its current tool call), and answers right away, like a native subagent: use that to ask how far it is or to redirect it. The answer arrives as a message from the job. Plain messages never answer pending approvals; use decide or the dashboard. Without a message it is told to continue where it stopped: use that to recover a failed or interrupted subagent. If all subagent slots are taken, a finished subagent's continuation is queued and starts by itself when one frees up (cancel_subagent drops it). |
| `cancel_subagent` | `job` | Stop a background subagent started with spawn_*, or drop a queued continuation (message_subagent while all slots were taken). Pass its job name (e.g. codex-job-1a2b3c4d). |
| `report_progress` | `percent`, `eta_minutes?`, `note?` | Tell your supervisor, which gave you your current task, how far you are: the percent of the whole task done and a few words on the current step. Call it when you start, after each milestone, and at least every few minutes. Give eta_minutes when you can estimate minutes until completion and update it as you go. It does not interrupt your work. |
| `hook_event` | `event`, `session_id?`, `stop_hook_active?`, `cwd?`, `agent_id?`, `prompt?` | Internal endpoint for agent-bridge's own hooks. Do not call this tool. |

## Delegation options

Peer names default to `<agent>-<project folder>` (for example `codex-showcase`), or `<agent>-session` until the folder is known. An agent-kind address such as `codex` selects that local peer when unambiguous. Set `AGENT_BRIDGE_NAME` or `name` in the configuration to choose a peer name.

- `session_id` continues an earlier run; `cwd` selects its working folder.
- `host` runs on a paired PC with separate remote-job permission.
- `native_subagents` sets the Codex child-thread budget (default 6, range 0–32; 0 disables). This differs from bridge delegation depth and concurrency.
- `send_to` grants messaging to exact local sessions or jobs outside the default sibling scope.
- `timeout_sec` defaults to 60 minutes for `ask_*`; background jobs default to the 24-hour ceiling. A timeout reports the session ID so a caller can continue retained context.
- Target options include Codex `sandbox` and `approvals_reviewer`, Claude `permission_mode`, opencode `auto_approve`, and Antigravity `terminal_sandbox` and `bypass_permissions`. Codex defaults to `auto_review`; `user` forwards eligible requests.

Pass a prompt and a short title for a new job. Set `access` deliberately and use `worktree: true` for edits. `host` requires an absolute remote `cwd`; `send_to` grants are local-only. A continuation preserves saved settings unless explicitly overridden. See [delegation](../../concepts/delegation/), [access and approval forwarding](../../delegated-access/) and [remote jobs](../../remote-jobs/).

```ts
schema = {
      host: z.string().regex(NETWORK_NAME_PATTERN).optional().describe("Paired instance name to run on. Requires an absolute cwd on that PC and its explicit remoteJobs allowlist."),
      prompt: z.string().min(1).describe("Complete, self-contained instructions"),
      model: z
        .string()
        .regex(MODEL_NAME_PATTERN)
        .optional()
        .describe(modelParameterDescription(target, cfg, ctx.home, profile.modelExample)),
      effort: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,20}$/)
        .optional()
        .describe(`Thinking level (reasoning effort), e.g. ${profile.effortExample}; list_models shows what each model supports. Default: ${cfg.effort[target] ?? `${target}'s own default`} (config "effort"; shown in the dashboard).`),
      session_id: z.string().optional().describe("Continue a previous delegated session"),
      cwd: z
        .string()
        .optional()
        .describe(`Working directory, and for worktree=true the repository the worktree comes from. Default: ${ctx.cwd()} (where this session started); pass it whenever the work lives elsewhere.`),
      timeout_sec: z
        .number()
        .int()
        .min(10)
        .max(MAX_JOB_TIMEOUT_SEC)
        .optional()
        .describe(`Default ${DEFAULT_DELEGATE_TIMEOUT_SEC} for ask_*, none (${MAX_JOB_TIMEOUT_SEC}) for spawn_*`),
      access: z
        .enum(ACCESS_LEVELS as [Access, ...Access[]])
        .optional()
        .describe(
          '"read" (default): look only. "ask": look, and every change or command the subagent wants is asked of the user in this session (opencode; Codex with its trusted hook). "edit": may change files. Combine edit with worktree=true for parallel or risky work.',
        ),
      worktree: z
        .boolean()
        .optional()
        .describe(
          "Run in a separate git worktree on its own branch (implies access=edit). Your working copy stays untouched; the result explains how to review, merge or discard the changes.",
        ),
      title: z
        .string()
        .min(1)
        .max(MAX_TITLE_CHARS)
        .describe('A short title for this subagent, 3-7 words, like a chat title (e.g. "Fix castle gate alignment"). Required. Shown in peers and the dashboard.'),
      allow_tools: z
        .array(z.string().min(1).max(200))
        .max(50)
        .optional()
        .describe(
          'MCP tools the subagent may call without asking you, as "server.tool" patterns with *, e.g. ["pair-desk.get_*", "pair-desk.list_*"] (reads only), "pair-desk:worker" (reads, comments, progress, plans, issue edits and review locations; excludes status, builds and handoff writes), or "server" for all of its tools. Add "pair-desk.set_build" separately to allow build publication.',
        ),
      send_to: z.array(z.string().refine(isJobSendTarget, "Use an exact local session or job name, not an agent kind, broadcast, wildcard or remote address"))
        .max(MAX_JOB_SEND_TARGETS).optional()
        .describe("Explicitly allow this job to send to these exact local session or job names, including replies to messages received by its supervisor. Default is closed. Cross-session jobs require a separate reciprocal grant to answer; they retain hop limits and quiet copies for both owners. No other external recipients are allowed. Kept across continuations."),
      notes: z.enum(["none", "milestones", "blockers"]).optional().describe("Reporting cadence, default none/final report only. Routine notes always remain dashboard/history-only. Explicit questions, final results and approvals can still request attention."),
      ...profile.schema,
    }
```

```ts
schema: {
      terminal_sandbox: z.boolean().optional().describe("Enable agy's terminal sandbox (separate from read/ask tool permissions)"),
      bypass_permissions: z.boolean().optional().describe("Exact Antigravity permission override: true bypasses native approvals, false retains native policy. Overrides read/ask access; handoff restrictions remain."),
    }
```

```ts
schema: {
      native_subagents: nativeSubagentsSchema,
      sandbox: z.enum(CODEX_SANDBOXES as [string, ...string[]]).optional().describe("Overrides access with an exact Codex sandbox mode"),
      approvals_reviewer: z.enum(CODEX_APPROVALS_REVIEWERS).optional().describe("Codex reviewer: auto_review (approve for me, default) or user (forward approvals). Does not change the sandbox."),
    }
```

```ts
schema: { permission_mode: z.enum(CLAUDE_PERMISSION_MODES as [string, ...string[]]).optional().describe("Overrides access with an exact Claude permission mode") }
```

```ts
schema: { auto_approve: z.boolean().optional().describe("Overrides access: auto-approve every opencode permission request (opencode run --auto)") }
```

## Parameter schemas

The following source excerpts preserve bounds and defaults. A question mark in the table means the schema uses `.optional()`. Named shared schemas are defined in the product source.

### withdraw_owner_question

```ts
id: z.uuid()
status: z.enum(["cancelled","superseded"])
reason: z.string().trim().min(1).max(1000)
supersededBy: z.uuid().optional()
```

### search_history

```ts
query: z.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS)
filters: historyFiltersSchema.optional()
limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional()
answer: z.boolean().optional()
```

### get_conversation

```ts
id: z.string().min(1).max(512)
after: z.number().int().nonnegative().optional()
limit: z.number().int().min(1).max(100).optional()
```

### decide

```ts
approval_id: z.uuid().optional().describe("Pending approval id from the job question or dashboard")
decision: z.enum(["allow", "deny", "escalate"]).optional()
reason: z.string().max(4000).optional()
topic: z.string().trim().min(1).max(MAX_DECISION_TOPIC_CHARS).optional().describe("Stable topic; trimmed and case-insensitive")
text: z.string().trim().min(1).max(MAX_DECISION_TEXT_CHARS).optional().describe("The owner's decision text")
scope: decisionScopeSchema.optional().describe('"all", {project: folder}, or {sessions: [peer names, ids or session ids]}')
source_message_id: z.string().optional().describe("Optional existing bridge message id recording the owner's choice")
```

### decisions

```ts
query: z.string().max(MAX_DECISION_TEXT_CHARS).optional()
scope: decisionScopeSchema.optional().describe('"all" for global decisions, {project: folder}, or {sessions: [names or ids]}; project/session filters include global decisions')
history: z.boolean().optional()
```

### project_main

```ts
to: z.string().min(1).max(64)
```

### coordinator_availability

```ts
unavailable: z.boolean()
```

### send

```ts
to: z.string().min(1).describe('Peer name, project address, agent kind, "*" (sessions and your running jobs), or "jobs:*" (only your running jobs)')
message: z.string().min(1).max(MAX_BODY_CHARS).describe("Message text (Markdown is fine)")
reply_to: z.string().optional().describe("Id of the message you are answering")
conversation_id: z.string().optional().describe("Continue an existing conversation")
if_no_newer_than: z.string().optional().describe("Refuse this reply if newer unread conversation or recipient mail exists after this message id")
message_kind: z.enum(["note", "question"]).optional().describe("note retains FYI/status in history without waking or injecting context; question requests supervisor attention")
message_id: z.uuid().optional().describe("Stable UUID for an idempotent send or recovery retry. Reuse this id only with the same content; requires an updated broker.")
```

### send_status

```ts
message_id: z.uuid()
```

### send_files

```ts
to: z.string().min(1).describe("Peer name, including host/peer for a paired instance")
paths: z.array(z.string().min(1)).min(1).max(MAX_STREAM_ENTRIES).describe("Files or folders relative to this session's working directory, or absolute paths")
```

### fetch_files

```ts
from: z.string().min(1).describe("Paired host/peer to fetch from")
paths: z.array(z.string().min(1)).min(1).max(MAX_STREAM_ENTRIES)
```

### cancel_transfer

```ts
id: z.uuid()
```

### inbox

```ts
include_quiet: z.boolean().optional().describe("Include historical quiet coordination copies (default false)")
mark_read: z.boolean().optional().describe("Mark returned messages as read (default true); false also permits inspecting retained quiet copies")
limit: z.number().int().min(1).max(100).optional()
```

### wait_for_message

```ts
mode: z.enum(["notify", "block", "cancel"]).optional().describe("Default notify; block for a bounded synchronous result; cancel a saved wait with resume_id")
timeout_sec: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Block only: default and single-call cap ${SINGLE_WAIT_SEC}; without mode selects legacy block. Ignored in notify`)
from: z.string().optional().describe("Only accept messages from this peer name or agent kind")
reply_to: z.string().optional().describe("Only accept replies to this message id")
conversation_id: z.string().optional()
read_receipt_of: z.uuid().optional().describe("Wait until all recipients consumed this sent message")
resume_id: z.uuid().optional().describe("Saved wait id shown by peers or SessionStart after a reload")
```

### max_subagents

```ts
count: z.number().int().min(1).max(MAX_JOBS_LIMIT)
save: z.boolean().optional()
```

### auto_wake

```ts
enabled: z.boolean()
```

### spawn_claude

```ts
title: schema.title.optional().describe("A short title, 3-7 words. Optional: if omitted, derived from the prompt's first nonempty line and noted in the result.")
```

### spawn_codex

```ts
title: schema.title.optional().describe("A short title, 3-7 words. Optional: if omitted, derived from the prompt's first nonempty line and noted in the result.")
```

### spawn_opencode

```ts
title: schema.title.optional().describe("A short title, 3-7 words. Optional: if omitted, derived from the prompt's first nonempty line and noted in the result.")
```

### spawn_antigravity

```ts
title: schema.title.optional().describe("A short title, 3-7 words. Optional: if omitted, derived from the prompt's first nonempty line and noted in the result.")
```

### usage_limits

```ts
agent: z.enum(CODING_AGENTS as unknown as [string, ...string[]]).optional().describe("Only this agent (default: all installed)")
```

### list_models

```ts
agent: z.enum(targets as [CodingAgent, ...CodingAgent[]]).describe("The subagent agent")
query: z.string().max(80).optional().describe('Filter, e.g. "sonnet" or "openai/"')
```

### set_job_outcome

```ts
job: z.string().min(1)
state: z.enum(["held", "discarded"])
reason: z.string().max(MAX_HOLD_REASON_CHARS).optional()
```

### handoff_subagents

```ts
to: z.string().min(1).max(64).describe("Exact live local session name from peers")
jobs: z.union([z.literal("all"), z.array(z.string().min(1).max(80)).min(1).max(1000)]).optional().describe("Exact job names, or all (default)")
note: z.string().max(4000).optional().describe("Context for the new supervisor")
switch_project_main: z.boolean().optional().describe("With all jobs, also make the same-project target the main session")
```

### message_subagent

```ts
job: z.string().min(1).describe('Job name, e.g. "codex-job-1a2b3c4d" or "opencode-ask-9f8e7d6c" (see peers)')
message: z.string().optional().describe("The follow-up. Default: continue where you stopped and finish the task.")
title: z.string().min(1).max(MAX_TITLE_CHARS).optional().describe("Give the job a (new) short title, 3-7 words; use it for jobs listed without a title.")
effort: z .string() .regex(/^[A-Za-z0-9_-]{1,20}$/) .optional() .describe("Thinking level for this continuation and the job's later turns (e.g. low, medium, high, xhigh). A turn already running keeps its level: to apply it now, cancel_subagent and continue it with message_subagent.")
model: z.string().regex(MODEL_NAME_PATTERN).optional().describe("Model for this continuation and later turns. A running turn keeps its model.")
access: z.enum(ACCESS_LEVELS as [Access, ...Access[]]).optional().describe("Access for the next turn: read, ask or edit. Replaces earlier exact permission overrides.")
sandbox: z.enum(CODEX_SANDBOXES as [string, ...string[]]).optional().describe("Codex sandbox for the next turn. A running turn keeps its sandbox.")
terminal_sandbox: z.boolean().optional().describe("Antigravity terminal sandbox for the next turn.")
bypass_permissions: z.boolean().optional().describe("Antigravity exact native approval override for the next turn; true bypasses, false retains native policy.")
native_subagents: nativeSubagentsSchema
approvals_reviewer: z.enum(CODEX_APPROVALS_REVIEWERS).optional().describe("Codex reviewer for the next turn: auto_review or user. A running turn keeps its reviewer.")
permission_mode: z.enum(CLAUDE_PERMISSION_MODES as [string, ...string[]]).optional().describe("Claude permission mode for the next turn.")
auto_approve: z.boolean().optional().describe("opencode auto-approval for the next turn.")
```

### cancel_subagent

```ts
job: z.string().min(1)
```

### report_progress

```ts
percent: z.number().min(0).max(100).describe("Percent of the whole task done, 0-100")
eta_minutes: z.number().min(0).max(1440).optional().describe("Estimated minutes until done, 0-1440; update as your estimate changes")
note: z.string().max(200).optional().describe('The current step in a few words, e.g. "tests pass, updating docs"')
```

### hook_event

```ts
event: z.string()
session_id: z.string().optional()
stop_hook_active: z.union([z.boolean(), z.string()]).optional()
cwd: z.string().optional()
agent_id: z.string().optional()
prompt: z.string().optional()
```
