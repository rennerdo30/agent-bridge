---
title: How it works
description: The broker daemon, local pipes, storage and approval reuse.
---

Each agent session starts its own small agent-bridge server. The first one that finds no broker starts one background broker process (the daemon) on a local pipe (a Windows named pipe or a Unix socket); every session is a client of it, and the broker and its dashboard keep running when that session exits. If the daemon dies, the next session starts a new one. After an update, the first session of the newer release makes the running daemon hand over: it finishes admitted requests and exits, and the newer release's daemon takes over the same store. A daemon with no connected session exits after 10 minutes. To keep the older behavior, where the first session hosts the broker itself and another takes over when it exits, set `AGENT_BRIDGE_DAEMON=0` or `"daemon": { "enabled": false }` (see [configuration](../../configuration/)). Data lives in SQLite under `~/.agent-bridge`. Subagents run in detached job runners, so they survive plugin reloads.

A job that asks its supervisor again for an approval identical to one the supervisor or the owner already allowed in the same turn of the job (the exact request, every tool input field included, in the same folder, under the same access, sandbox and supervisor) reuses that grant and logs it with the original approval id. File changes are always asked, command approvals are unavailable for Codex/opencode (CLI-run MCP write safety is unverified), and otherwise reused only in read-only jobs that cannot spawn subagents and have no MCP server but the Pair Desk allowed (and only until a file change, another command, a write-capable MCP call, a sibling send or a spawn is allowed), and denials are never reused. Turn it off with `"jobs": { "reuseIdenticalApprovals": false }` (see [configuration](../../configuration/)).

The daemon has no stop or restart command: `agent-bridge core status` is read-only, and handover, idle exit or `SIGTERM` end it. It does not claim full state authority (no lifetime-held lock or receiver fencing); see the [daemon launcher notes](https://github.com/rennerdo30/agent-bridge/blob/main/docs/runtime/DAEMON-LAUNCHER.md) and the [lifecycle contract](https://github.com/rennerdo30/agent-bridge/blob/main/docs/runtime/DAEMON-LIFECYCLE-PREREQUISITE.md) for the remaining limits.

```
 Claude Code session                          Codex session
┌───────────────────────┐                    ┌───────────────────────┐
│ agent-bridge server   │◄── local pipe ────►│ agent-bridge server   │
│ hooks · channels      │                    │ hooks · app-server    │
└───────────────────────┘         │          └───────────────────────┘
          first server to start is the broker · messages in SQLite
```

