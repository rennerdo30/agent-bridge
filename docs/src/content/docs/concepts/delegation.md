---
title: "Subagents and delegation"
---

- `access: "read"` (the default) lets a delegated agent look but not change anything. `access: "ask"` asks you for each change (see below). `access: "edit"` lets it change files.
- A subagent started in an existing agent-bridge worktree (`cwd` inside `~/.agent-bridge/worktrees`) gets `access: "edit"` by default. The spawn result always says which access a job has.
- `worktree: true` runs the subagent in its own git worktree on a branch `agent-bridge/<id>`. Your working copy stays untouched. The result shows a diff summary and the exact commands to review, merge (`git merge agent-bridge/<id>`) or discard the changes. Use it for parallel or risky edits. The review diff covers only the job's own work: if the job merged a newer state of its base branch (or of your main checkout's branch) into its branch, the diff starts from there. agent-bridge creates the worktree itself (as you, never inside the agent's sandbox) and leaves it unlocked.
- Finished worktrees stay by default. `agent-bridge cleanup` lists safe removals; optional `jobCloseCleanup` pushes all job commits before reaping a clean, proven checkout. [Checkpoint identity, Windows permission repair and close policy](../../worktree-lifecycle/).
- Delegated jobs report in their final answer; the session that started them owns the project handoff. Their task says so, their calls to handoff tools (any MCP tool named `*set_handoff` or `*update_handoff`, e.g. Pair Desk's) are declined without asking you, even with `allow_tools`, and the result warns when a job changed `HANDOFF.md` or `TODO.md` anyway.
- Results also list the files changed in place (for `access: "edit"` without a worktree) and the token usage or cost the CLI reported.

How `read` is enforced per agent:

| Agent | read | edit |
|---|---|---|
| Codex | `read-only` sandbox, with eligible escalations reviewed by `auto_review` | `workspace-write` sandbox with the same reviewer |
| opencode | an extra config layer turns edits and shell commands into "ask", which headless runs reject | your own opencode rules; what they leave to "ask" goes to the parent (see Approvals below), or `--auto` when no one can answer |
| Claude | editing and shell tools removed (`--disallowedTools`); Read, Grep and Glob stay | `acceptEdits`; permission prompts go to the parent (see Approvals below) |

Codex automatic review can approve an eligible escalation beyond a read-only sandbox. Select `approvals_reviewer: "user"` for direct supervision; use Codex managed requirements for hard restrictions. Headless Claude wrote files and ran commands even in `manual` mode in testing, and opencode's default rules allow everything. `agent-bridge reliability` checks delegated access separately from automatic review.

Read-only also covers MCP tools, which can change things too: a read-only Claude subagent gets every configured MCP server denied (plugins, `~/.claude.json`, the project's `.mcp.json`, claude.ai connectors) except agent-bridge's own, so it can still answer you; read-only opencode subagents keep only `bridge_send` of all MCP tools. Codex automatically reviews eligible MCP approvals, forwarding refusals and remaining client requests to its supervisor.

Codex edit jobs in a linked git worktree may write that worktree's git data in the main repository (`.git/worktrees/<name>` and the shared `.git`), so they can commit on their own branch. Work a subagent leaves uncommitted is committed for it with a subject taken from its answer and a `Co-Authored-By` line naming the agent and model.

Worktree commits use the parent repository's effective `user.name` and `user.email` (local or global Git config). Only missing identity fields fall back to `agent-bridge <agent-bridge@localhost>`.

Codex worktree edit jobs honor `codexWorktreeSandbox` in `~/.agent-bridge/config.json`. When it is unset, they inherit `codexSandbox`, except that its safe `read-only` default becomes `workspace-write` for worktree edits. Explicit `access: "read"` or `"ask"` stays read-only, and an explicit `sandbox` wins. Plain jobs retain their read-only default. The same rules cover continued worktrees and a worktree passed as `cwd`.

Set `codexApprovalsReviewer: "auto_review"` (default) or `"user"` in bridge config. Override it with `approvals_reviewer` on `spawn_codex`, `ask_codex`, or `message_subagent`; continuation settings persist and apply from the next turn. Automatic review changes who reviews eligible requests, while preserving the selected sandbox. Refusals and timeouts pause the job and enter the supervisor/dashboard approval queue. The supervisor decision becomes context for a continuation in the same thread; an allow requests one exact retry, still subject to Codex policy. Tool allowlists and cached MCP allows do not automatically approve these refusals. Without someone to answer, the refusal is reported explicitly. Full access keeps its existing command/edit behavior and MCP approval checks. The legacy `codex exec` fallback retains its existing approval handling because it lacks review notifications. See [delegated access](../../delegated-access/#automatic-approval-review-ab-92) for protocol details and limitations. No owner Codex config is changed.

For dependency downloads with `workspace-write`, set `codexWorkspaceWriteNetworkAccess: true` in bridge config. This forwards Codex's `sandbox_workspace_write.network_access` setting to both app-server and exec. When unset, Codex's own config controls workspace network access; read-only runs remain restricted. Network access alone does not grant access to external build caches or user configuration such as `NuGet.Config`.

For trusted build jobs needing those paths, set `codexWorktreeSandbox: "danger-full-access"` or pass that exact `sandbox` per job. This removes filesystem and network restrictions. On Windows, the elevated sandbox can also delay every command for minutes in worktrees under the user profile; this was observed even for `pwd` and `echo`, and disappeared when the job restarted without the sandbox. Choose full access explicitly for such jobs rather than changing the read-only default.

A read-only Claude subagent therefore cannot run shell commands such as `git diff`. Give it `access: "edit"`, ideally with `worktree: true`, if it needs them.

### Permission requests from subagents: `access: "ask"`

With `access: "ask"` a subagent starts read-only. Whenever it wants to change a file or run a command, you get an Allow / Deny dialog in the session that started it. That dialog is your host's native MCP dialog, in Claude Code or Codex. Your answer goes back to the subagent. Dismissing the dialog, not answering within 10 minutes, or any error counts as Deny. The result lists every request and your decision.

| Subagent | Forwarding | How |
|---|---|---|
| opencode | yes | agent-bridge runs a private `opencode serve` (127.0.0.1, random port and password) and answers its permission events |
| Codex | yes | Codex runs through `codex app-server`, which hands its approval questions to agent-bridge. With `AGENT_BRIDGE_CODEX_EXEC=1` (plain `codex exec`) the agent-bridge `PermissionRequest` hook asks your session instead. Trust it once via `/hooks` in Codex. Without that trust entry, Codex subagents run strictly read-only, so Codex's automatic reviewer never decides on its own. If a Codex run ever changes files without the hook asking, agent-bridge warns and switches that hook version back to read-only (fail closed). |
| Claude | not yet | `ask` runs read-only. A `PermissionRequest` hook only sees what would show a dialog; your allow rules or auto mode approve edits and commands before that, so "every change is asked" could not be guaranteed |

The parent session must support MCP elicitation dialogs; Claude Code and Codex do. If it doesn't, every request is denied.

### Talking to subagents: follow-ups and recovery

Every `ask_*` and `spawn_*` run is a job with a name like `codex-job-1a2b3c4d` or `opencode-ask-9f8e7d6c`, and it keeps its own session. So you can talk to it like a native subagent:

- **Follow up:** `message_subagent(job="codex-job-1a2b3c4d", message="now add tests")` continues the same Codex thread, Claude session or opencode session with its full context, in the same folder or worktree. The answer arrives as a message from the job.
- **While it runs:** the message reaches it at its next step, like with a native subagent, and it answers right away (for example "how far are you?", or "skip the docs, focus on the tests"). Its answer arrives as a message from the job. Codex gets the message as real user input in its running turn (agent-bridge drives Codex through `codex app-server` for this); Claude and opencode get it through agent-bridge's hooks and plugin. A message that arrives just as it finishes is sent as a follow-up instead.
- **Recover:** if a run failed, timed out or was interrupted, `message_subagent(job=...)` without a message tells it to continue where it stopped. The failure message says so and names the job.
- **Change settings:** `message_subagent(job=..., model="...", access="edit", message="continue")` saves the model and permission level for the next turn and later continuations. Exact permissions use `sandbox` for Codex, `permission_mode` for Claude, or `auto_approve` for opencode. Codex reviewer settings use `approvals_reviewer` and persist independently of access. Changing `access` clears an earlier exact override; an exact override takes precedence when supplied together. Settings survive restarts and reach detached runners. The running turn keeps its settings; dashboard model and permission chips reflect the settings of each turn. A live message does not restart that turn. To apply changes immediately, cancel it and continue the same job with the new settings.

- **After a restart:** jobs are saved in `~/.agent-bridge/jobs.json` (the last 200, small), so a restarted session can still continue them with `message_subagent`. Jobs that were running when the session ended show as interrupted; `message_subagent(job=...)` without a message recovers them in their own session, folder and worktree, with the same access.
- **Survive `/reload-plugins`:** each background subagent (spawn_* and its follow-ups) runs in a detached `agent-bridge job-runner` process, not inside the session's MCP server. A reload or restart of the server leaves it running; the next server of the session takes it over (progress, `message_subagent`, approvals, `cancel_subagent`) and gets its result as usual. If the session is gone for good, the result waits for the next session with that name. Only a job whose runner died shows as interrupted. Blocking ask_* runs and access="ask" runs (their questions go to the user through the server) still end with the server. `AGENT_BRIDGE_JOB_RUNNER=0` runs every subagent inside the server instead.
- **Command lifetime:** a native command can fail while its job continues. Codex command failures retain their item ID, exit/status and reported timeout evidence in run progress and logs; an unattributed exit is labelled `termination cause not reported`. Detached tools are not automatically independent of tree cancellation. See [command lifetime and durable tools](../../command-lifetime/).
- **Approvals:** when a background subagent needs approval, the question goes to the agent that started it as a message: "codex-job-… asks for approval: …". Codex automatically reviews eligible approval requests first; refusals and requests left to the client reach the supervisor/dashboard. opencode with `access: "edit"` asks for whatever your opencode rules leave to "ask" (MCP tools you marked, folders outside the project, commands you marked); agent-bridge runs it through a private `opencode serve` for that instead of `opencode run --auto`, which approved all of it. Claude with `access: "edit"` asks for every permission prompt (a command or MCP tool your rules don't allow) through a `PermissionRequest` hook that agent-bridge adds with `--settings`; Claude Code before 2.1.268 does not run that hook in `-p` mode. Claude and opencode read-only runs keep their deny rules; Codex read-only escalation requests can be reviewed or forwarded. The agent answers explicitly with `decide(approval_id=..., decision="allow")` or `decision="deny"` (or in the dashboard). Plain `message_subagent` text, including `allow` or `deny`, never answers an approval and the result mentions any pending approval, so this works in auto mode and while you're away; no answer within 10 minutes counts as deny. One allow covers that MCP server for the rest of the run. A blocking `ask_*` caller can't answer while it waits, so those questions are shown to you instead; if your host can't show dialogs, opencode and Claude keep their old behavior (`--auto`, and Claude's own handling of prompts). For Codex direct user approval, combine `access: "ask"` with `approvals_reviewer: "user"`; the default automatic reviewer still applies to ask jobs.

- **Progress:** subagents report `percent`, a short `note` and optional `eta_minutes` with `report_progress`; `peers` and the dashboard show the progress and time left. Both are the subagent's own estimates.
- **Read-only tools without asking:** list MCP tools that subagents may call without an approval question, as `server.tool` patterns with `*`: `"autoApproveTools": ["pair-desk.get_*", "pair-desk.list_*"]` in the config (or `AGENT_BRIDGE_AUTO_APPROVE_TOOLS`, comma-separated), or `allow_tools=[...]` on a single `spawn_*` / `ask_*`. An "allow" answer covers that MCP server for the rest of the job, follow-ups included.
- **Desk workers:** `allow_tools=["pair-desk:worker"]` allows `get_*`, `list_*`, `comment`, `progress`, `set_plan`, `update_step`, `create_issue`, `update_issue` and `set_location`. It excludes status changes, build publication and handoff writes. Add `"pair-desk.set_build"` separately when a job should publish a build. Read patterns alone do not allow plans or issue edits.
- **Capacity errors:** jobs retry model-capacity failures after 15, 30 and 60 seconds within their original time limit, preserving the session and selected model. No model fallback is used. The step log records each retry.
- **Denial reasons:** supervisor denials identify the supervisor and carry its reason. Claude hooks and opencode replies pass it in their protocol response; Codex approval responses have no reason field, so the running turn receives a live explanation. Bridge policy refusals identify agent-bridge separately.

### Shared resource slots

To limit heavy commands across parallel jobs and projects, opt in with a top-level config entry:

```json
{ "resourceSlots": { "unity": 2, "gpu": 1 } }
```

All jobs using the same `AGENT_BRIDGE_HOME` share these capacities; per-agent sections cannot override them. Jobs receive slot instructions in their preamble and a stable owner identity in their environment. Around a heavy command, use `agent-bridge slot acquire unity` and always `agent-bridge slot release unity` in a `finally` block or shell trap. The preamble gives the bundled CLI path when `agent-bridge` is not on PATH. For example, in PowerShell:

```powershell
agent-bridge slot acquire unity
if ($LASTEXITCODE -ne 0) { throw "Could not acquire Unity slot" }
try { & $unityEditor -batchmode -quit -projectPath $projectPath }
finally { agent-bridge slot release unity }
```

`agent-bridge slot status` prints holders and FIFO waiters as JSON. SQLite file locks in `resource-slots.sqlite` serialize acquisition across processes and recover automatically after a crash; no extra daemon or dependency is needed. Dead owner processes are reclaimed on the next acquire or status call. Runs renew their six-hour leases every minute and release all their slots when the run ends. Outside a delegated job the owner defaults to the calling shell process; keep that shell alive and use `agent-bridge slot renew unity` before its six-hour lease expires. Acquiring twice is idempotent: one job holds one slot per resource. Lowering a capacity leaves current holders in place and blocks new acquisitions until usage falls below the new limit.

Slots are cooperative: commands that skip acquisition remain unrestricted. Queue inspection is available through `slot status`; dashboard and `peers` integration are not included.
- **Nested delegation:** a top session is depth 0. With `maxDelegateDepth: 2` (default, range 1–3), its children can start another generation. Every generation shares the root session's `maxJobs` budget; results return to the direct parent. See [nested delegation](../../nested-delegation/).
- **Results reach the right agent:** messages are not handed to Claude Code's native subagents (Task/Agent tool) through their tool calls; they wait for the main agent. After `/reload-plugins` the new agent-bridge server of a session replaces the old one and keeps its name.
`peers` lists running jobs and the recent finished ones. This works the same whichever agent is the host (Claude Code, Codex or opencode, where the tool is `bridge_message_subagent`) and whichever is the subagent. Cancelling or ending a session stops its subagents with their whole process tree.

### Exact cross-session job messaging

Jobs are isolated from other sessions by default. At spawn, a session can opt in with
`send_to: ["opencode-job-12345678"]` (or an exact local session name). Each direction needs
its own grant: the other job must include the sender's exact name in its `send_to` to reply.
`peers` lists granted jobs alongside siblings with their titles and status. Wildcards,
agent kinds, and paired-PC addresses are rejected; granting a session does not grant its jobs.
Grants persist across continuations, and cross-session job threads keep the sibling hop
limit and durable undelivered-text notices. Both owners retain quiet inbox/dashboard copies;
these copies do not enter their context automatically. Finished jobs return their saved
report immediately: do not wait for a reply or receipt unless their owner continues them.

## Native subagents

Where the host lets plugins define subagents, agent-bridge ships them. Each one is a thin relay that hands the task to the other agent and returns its answer. Because they are the host's own subagents, you get its subagent UI, background runs, parallelism and cancellation.

| Host | Subagents | How to use |
|---|---|---|
| Claude Code | `agent-bridge:codex`, `agent-bridge:opencode` (bundled in the plugin, run on Haiku) | "use the codex subagent to review this diff", or `@agent-agent-bridge:codex` |
| opencode | `codex`, `claude` (installed by `install-opencode`) | "use the codex subagent …", or `@codex` |
| Codex | none: Codex plugins can't ship agent roles, and Codex's current `spawn_agent` has no role parameter | use `spawn_claude` / `spawn_opencode` (background jobs, see below) |

## Following a delegated run

While a delegated run works, agent-bridge streams every step as an MCP progress notification. Each line carries the elapsed time, a step counter with totals, and what the agent is doing or saying:

```
2m · step 14 (6 cmds, 3 edits) · bash: py scripts/run-domain-tests.py
3m · step 14 (6 cmds, 3 edits) · says: Rooms per building type are in, now the furniture kit.
still working, no new step for 4m (last: bash: py scripts/run-domain-tests.py)
```

The "still working" heartbeat comes after every minute without a new step, so long test runs or thinking phases don't look like a hang. Claude Code shows these lines under the running tool call (`Ctrl+O` expands them). Codex currently ignores MCP progress.

## Hand off subagents

Use `handoff_subagents(to="codex-animal-catch-game", jobs="all", note="Review results and continue the unfinished work")` from the session that currently supervises the jobs. Omit `jobs` to move all running and finished jobs, or pass exact job names. Nested children move with their parent. The target must be an exact, live local Claude Code, Codex or opencode session name from `peers`.

The recipient becomes the primary contact and receives a waking inventory with titles, statuses and your note. The former supervisor stays a master and the first fallback; only one live recipient gets each message. Either master can `message_subagent`, cancel and continue inherited jobs. Running work keeps going; results, approvals and notes go to the primary while it is live, otherwise to the next live master. The dashboard's session **⋯ → Hand off subagents…** opens a styled local-session picker. Ownership history and previous owner message history stay retained. Remote jobs and paired-PC targets are rejected without moving any jobs. See [the handoff contract](../../subagent-handoff/).
