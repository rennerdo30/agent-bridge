---
title: "Google Antigravity CLI"
---

```bash
npx -y github:rennerdo30/agent-bridge install antigravity --yes
# Later:
npx -y github:rennerdo30/agent-bridge update antigravity --yes
```

Requires installed, authenticated `agy` (verified with 1.2.0 and 1.3.1). Start a new
native session after initial installation. Updates keep running sessions on retained
code and select new code for the next MCP server start. The plugin includes MCP configuration, lifecycle/permission hooks
and a coordination skill. It exposes the same peer, delegation, history and job
tools as the existing plugins. Other peers get `ask_antigravity` and
`spawn_antigravity`, with `model`, `effort` (low/medium/high/xhigh/max), `session_id`,
`access`, `terminal_sandbox`, `bypass_permissions` and `worktree`. Continue with `message_subagent` or
cancel with `cancel_subagent`; these use the existing durable job lifecycle.

`read` denies non-reading tools; `ask` forwards those tool approvals to the
supervisor. Both use the installed bridge gate before every tool, with native
headless prompting bypassed because 1.2.0 otherwise auto-denies approved calls.
`edit` keeps native Antigravity permissions; native headless prompts can deny
commands. Explicit `bypass_permissions: true` runs with native approvals bypassed;
`false` selects native policy. Either exact override replaces read/ask access.
The installer grants only the bridge MCP server and backs up native
settings. Terminal sandboxing is
separate and depends on the installed platform. Active mail arrives at the next
model invocation or stopping boundary. **Idle TUI sessions receive mail on their
next turn or through `inbox`; no public programmatic idle wake API is documented.**
Native Remote Control provides separate desktop/web UI access through a tunnel.
Account quotas are shown by native `/usage` or `/quota`; the bridge reports them
as unknown because no machine-readable quota command is documented.

Native chats and explicit child conversations are read from Antigravity JSONL
logs without modifying them. Updates publish complete immutable runtimes and back up replaced metadata;
uninstall archives the owned plugin, including user additions, and retains
the native MCP allow rule. No bridge data
format changes are required for this additive agent kind.

**Gemini CLI (`gemini`) is separate and is not implemented in this release:** it
was not installed on the verified PC. See [official evidence and CLI differences](../../google-cli-research/).
