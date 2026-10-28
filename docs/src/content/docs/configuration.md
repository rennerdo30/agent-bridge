---
title: "Configuration"
---

`~/.agent-bridge/config.json` (all keys optional; per-agent sections override the top level; env vars override both). Running sessions pick up changes within a few seconds; `name`, `delivery`, daemon activation and the dashboard port need a restart; use the connect wizard to reload `network` settings live:

```json
{
  "autoWake": false,
  "wakeOnDirect": true,
  "maxHops": 6,
  "maxJobs": 8,
  "maxDelegateDepth": 2,
  "autoApproveTools": ["pair-desk.get_*", "pair-desk.list_*"],
  "jobs": { "defaultAllowTools": ["pair-desk:worker"], "reuseIdenticalApprovals": true },
  "codexApprovalsReviewer": "auto_review",
  "codexSubagents": 6,
  "lingerSec": 300,
  "codex": { "name": "codex-main", "claudeBin": "claude", "claudePermissionMode": "default", "claudeModel": "opus" },
  "claude": { "delivery": "auto", "codexBin": "codex", "codexSandbox": "read-only", "codexModel": "gpt-6-sol" },
  "opencodeModel": "anthropic/claude-sonnet-5",
  "opencodeAutoApprove": false
}
```

`jobs.defaultAllowTools` is the `allow_tools` of every `spawn` / `ask` job whose call
passes none (default `["pair-desk:worker"]`: Pair Desk reads, comments, progress, plans,
steps, issue edits and review locations; it does not create issues and never writes status,
builds or the handoff). It applies in every access mode, so `read` and `ask` jobs may write
those desk entries without asking too. A list passed on the call replaces it;
`allow_tools: []` turns it off for one job, and `"defaultAllowTools": []` turns it off for all.
Home config only; a project config cannot set it. The section that applies is the one of the
session that spawns the job (its agent section, else the top level); for a job on a paired PC,
the receiving PC's section for the target agent. It covers the bridge job and what runs inside it
(for example Task subagents of a Claude job), not the session itself or its own native children.
Tool descriptions show the value from when the session started. See
[delegation](../concepts/delegation/).

`codexSubagents` sets the default native Codex child-thread budget per delegated job
(6 by default, integers 0–32; 0 disables). Override it with `native_subagents` on
`spawn` with `agent="codex"`, `ask` with `agent="codex"` or `message_subagent`. This is separate from bridge job
concurrency and delegation depth. See [native subagent settings and dashboard APIs](../codex-subagents/).

`jobs.reuseIdenticalApprovals` (default `true`, home config only; a project config can change
it in neither direction) lets a job reuse an approval that the supervisor (`decide`) or the
owner (dashboard or a native dialog) already **allowed** in the same turn of the same job, when
the new request is provably the same action. Its identity is the exact request as its source
encodes it, bound to the asking agent, the tool, the folder and the text the question showed;
nothing is normalized:

- Claude and Codex `PermissionRequest` hooks: the tool name and every field of its tool input
  (a different `dangerouslyDisableSandbox`, `run_in_background`, `timeout`, `workdir`,
  `sandbox_permissions` or `justification` makes it a different request);
- Codex app-server commands: the raw command line with its shell wrapper, the `cwd` Codex
  names (else the job's folder) and every other approval field (network context, proposed
  policy amendments, reason), without the per-request ids;
- opencode: the whole `permission.asked` event without its per-request ids.

The job gets no second question. The first reuse of each grant reaches the supervisor like a
question would; later ones are quiet notes. All name the original approval id, and the job's
step log, run report and approvals history (`reused` event) show them.

Limits that keep it safe:

- **File changes are always asked** (Claude `Write`, `Edit`, `MultiEdit`, `NotebookEdit`; Codex
  file changes; opencode edits): their paths say where, not what.
- **Command approvals are reused only in read-only jobs.** A command (a shell command, or any
  tool that is not an MCP tool) runs whatever the job's files say, so its grant is kept and
  reused only while the job cannot change files without asking. The job's settings are
  checked when the grant is made (both when the question is asked and when it is answered)
  and again at each reuse; if either is not read-only, the command is asked. Read-only means:
  - The job cannot start or continue subagents of its own: its delegation depth reached
    the effective `maxDelegateDepth` captured at launch (later config edits cannot change this), so its bridge server has no `spawn`, `ask`, `message_subagent`
    or `decide`. A job that has them could start a child job with edit access in the same
    folder and answer that child's approvals itself.
  - No MCP server other than the Pair Desk was allowed for the rest of the job (one "allow"
    of a server covers its later calls, also in follow-ups).
  - Codex and opencode command reuse is unavailable. Their CLIs may run configured MCP
    tools without forwarding an approval here, and the current launch paths provide no
    trustworthy evidence that those servers cannot write. A `read-only` shell sandbox,
    `user` reviewer, empty bridge allowance or auto-approve being off cannot prove it.
    Codex exec-relay is also excluded: it can select `auto_review` despite the requested
    reviewer. Explicit per-request approvals and exact MCP-call reuse still work.
  - Claude: permission mode `default`, `manual` or `plan` (agent-bridge denies `Write`,
    `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` and `PowerShell` in these). `acceptEdits`,
    `auto`, `dontAsk` and `bypassPermissions` are not.
  - Antigravity: `access` `read` or `ask` without `bypass_permissions`. Muse: `access` `read`
    or `ask` without a `permission_profile`.
  - Every auto-approved MCP pattern (`autoApproveTools`, `allow_tools` or the default
    allowance) names only the Pair Desk server (`pair-desk`, `pair-desk.<tool>` or
    `pair-desk:worker`). Any other pattern could let the job write files without asking.
  - Anything else, including an unknown agent, permission or pattern, is not read-only.
- **A read-only job changes files only through what it is allowed**, so an allowed file
  change request (dropped already when it is asked), an allowed different command, an
  allowed request without an exact identity or any allowed MCP call to a server other than
  the Pair Desk (whether through an earlier "allow" of its server, an allow pattern, a
  question or a reused grant) ends the job's command grants. A call to the job's own
  agent-bridge server other than an exact send to the parent/supervisor or a read or status tool (`report_progress`, `peers`,
  `health`, `search_history`, `get_conversation`, `inbox`, `wait_for_message`, `decisions`,
  `list_models`, `usage_limits`, `network_status`, `resource_slots`), such as `spawn`,
  `ask`, `message_subagent` or `decide`, ends them and keeps none for the rest of the turn.
  A `send` to a sibling or peer does the same; an inexact send or unknown recipient is
  treated conservatively because a recipient could change the job's files.
- **No Git, no file reads**: the approval path runs no Git command and reads none of the
  job's files. A job-controlled repository could run code through Git (`core.fsmonitor`,
  filters) and hide files from it (`.git/info/exclude`, `assume-unchanged`).
- **MCP tool calls** that are identical are reused at every access level. MCP requests
  without an exact identity (see below) are always asked.
- **No grant at all** is kept or reused when the job store exists but cannot be read or does
  not have the job: its supervisor is then unknown.
- A grant never widens and never crosses jobs: it ends with the job's turn, when the job's
  access, sandbox, permission settings or Codex approvals reviewer change, and when its
  supervisor changes. The
  supervisor is read from the job store, so a `handoff_subagents` from another process ends
  the grants at once.
- A deny is never reused (the job asks again) and revokes a grant of the same request, also
  one allowed while the denied question waited.
- Allows from `autoApproveTools`, `allow_tools`, a per-server MCP allow, a timeout or a paired
  PC's supervisor (`remote supervisor`) create no grants.
- Requests without an exact identity are always asked: Codex MCP elicitations (their text is a
  summary), Codex automatic-review refusals and sandbox permission requests, Antigravity and
  Muse approvals, and cut requests.

Grants live in the memory of the process that runs the job (at most 64 per job). Set it to
`false` to ask every time.

The standalone broker daemon is **on by default**. When no broker is running, the
first MCP server, CLI command or CLI dashboard starts one background broker process
(which also hosts the dashboard) instead of hosting the broker inside the session, so
the broker survives that session's exit. To opt out and keep the embedded broker
behavior, set `"daemon": { "enabled": false }` in the home config (or its per-agent
section), or set `AGENT_BRIDGE_DAEMON=0` in the host's environment.
The precedence is exact: **`AGENT_BRIDGE_DAEMON=1` / `0` > `daemon.enabled`
(`true` / `false`) > on**. Environment `0` overrides config `true`; environment
`1` overrides config `false`. Other environment values and non-boolean config
values are ignored. Project config cannot change daemon activation. Restart the
hosting session or CLI to apply a change.

An already running embedded broker of an older release keeps serving after an
update: new sessions connect to it and never start a second broker. The daemon takes
over the same `~/.agent-bridge` store, with its queued mail, once that broker exits.

**Updates (handover).** When a session of a newer release that can start a daemon
itself connects to a running daemon (newer `agent-bridge` version or protocol, proven
by the shared token), the daemon hands over: it stops admitting requests (they are refused as "not applied;
retry"), lets requests it already admitted finish for up to 10 seconds, closes the
store and releases the pipe, then exits. The newer session's next election finds no
broker and starts the new release's daemon on the same `~/.agent-bridge` store, so
accepted and queued mail carries over. The pipe bind stays exclusive: the new daemon
waits until the old one has released the pipe and never serves next to it. Older
sessions that are still running wait 15 seconds before starting a daemon themselves,
so the newer release wins; they then reconnect to its daemon if the protocol still
matches (otherwise restart them after the update). Job runners, delegated runs and
status probes such as `agent-bridge core status` never trigger a handover, because
they cannot start a daemon themselves. A daemon records each
handover in `daemon-handover.json` in the bridge home (target release and time). If
that release's daemon did not take over and an older daemon was started again, the
older one does not hand over to the same release for 10 minutes; it logs a warning
and keeps serving, and the newer session registers with it as with any older broker.
An embedded broker (daemon opted out) never hands over; it is replaced when every
session hosting it has restarted.

**Idle exit.** A daemon exits cleanly once nothing has been served for 10 minutes;
the next session starts a new one. `AGENT_BRIDGE_DAEMON_IDLE_EXIT_MS` (1000 to
86400000) changes the period. These keep it serving: any connected session, job
runner or CLI command; a remote-job request or a remote spawn that is still being
admitted or started; a connected (or connecting) paired PC; and dashboard HTTP or
event-stream connections or phone connections to the mobile host that are open or
were open within the period. The daemon's own dashboard sender does not count. While
no daemon runs, paired PCs cannot deliver to this one until a session starts again.

`agent-bridge core status` shows which mode is serving. There is no stop or restart
command; handover and idle exit are the supported ways a daemon ends, besides
`SIGTERM`/`SIGINT` to its process.

| Env var | Meaning |
|---|---|
| `AGENT_BRIDGE_HOME` | Data directory (default `~/.agent-bridge`) |
| `AGENT_BRIDGE_DAEMON` | Standalone broker daemon: exact `1` enables, exact `0` disables (opt-out); overrides `daemon.enabled`; default on |
| `AGENT_BRIDGE_DAEMON_IDLE_EXIT_MS` | Daemon idle exit period in ms with no connected client (default 600000, allowed 1000–86400000; other values keep the default) |
| `AGENT_BRIDGE_NAME` | Peer name |
| `AGENT_BRIDGE_AUTO_WAKE` | `on` / `off` |
| `AGENT_BRIDGE_WAKE_ON_DIRECT` | Wake idle Claude, Codex and opencode for messages addressed to their session name when supported (default `on`); `wakeOnDirect` in config |
| `AGENT_BRIDGE_MAX_HOPS` | Loop limit |
| `AGENT_BRIDGE_MAX_JOBS` | Subagents running at once per top-level session, including blocking asks and every nested generation (default 8, max 50); `maxJobs` in the config file. Continuing a finished subagent while all slots are taken queues it; it starts when one frees up. Mid-session, ask the top supervisor to change it ("allow 10 subagents"): the `max_subagents` tool applies it at once, with `save=true` also for new sessions |
| `AGENT_BRIDGE_MAX_DELEGATE_DEPTH` | Maximum delegation depth (`maxDelegateDepth` in config), default 2, allowed range 1–3. A top session has depth 0; its child has depth 1 and can start depth 2 children. Every generation shares the top session's subagent budget. |
| `AGENT_BRIDGE_LINGER_SEC` | Listen window after sending (0 disables) |
| `AGENT_BRIDGE_DELIVERY` | Claude only: `auto`, `channel`, `hooks` |
| `AGENT_BRIDGE_CLAUDE_BIN` / `AGENT_BRIDGE_CODEX_BIN` / `AGENT_BRIDGE_OPENCODE_BIN` | Paths of the CLIs used for delegation |
| `AGENT_BRIDGE_LOG_LEVEL` | File log level: `debug`, `info` (default), `warn`, `error`, `silent` |
| `AGENT_BRIDGE_LOG_CONSOLE` | stderr log level (default `warn`) |
| `AGENT_BRIDGE_PIPE` | Override the pipe / socket path |

Logs are written to `~/.agent-bridge/logs/agent-bridge.log`.
