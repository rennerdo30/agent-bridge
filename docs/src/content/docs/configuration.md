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
  "codexApprovalsReviewer": "auto_review",
  "codexSubagents": 6,
  "lingerSec": 300,
  "codex": { "name": "codex-main", "claudeBin": "claude", "claudePermissionMode": "default", "claudeModel": "opus" },
  "claude": { "delivery": "auto", "codexBin": "codex", "codexSandbox": "read-only", "codexModel": "gpt-6-sol" },
  "opencodeModel": "anthropic/claude-sonnet-5",
  "opencodeAutoApprove": false
}
```

`codexSubagents` sets the default native Codex child-thread budget per delegated job
(6 by default, integers 0–32; 0 disables). Override it with `native_subagents` on
`spawn_codex`, `ask_codex` or `message_subagent`. This is separate from bridge job
concurrency and delegation depth. See [native subagent settings and dashboard APIs](../codex-subagents/).

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
