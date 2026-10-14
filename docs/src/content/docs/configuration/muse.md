---
title: "Muse"
---

```bash
npx -y github:rennerdo30/agent-bridge install muse --yes
# Later:
npx -y github:rennerdo30/agent-bridge update muse --yes
```

Requires installed, authenticated `muse` (verified with 1.4.7). The installer
runs Muse's own plugin manager (`muse plugins install`, then
`muse plugins approve agent-bridge` to trust the bundle's capabilities) and
shows both steps in its plan before running them. Start a new Muse session
after initial installation. The plugin includes the bridge MCP server, a
coordination skill and peer commands. It exposes the same peer, delegation,
history and job tools as the existing plugins. Other peers get `ask_muse` and
`spawn_muse`, with `model`, `effort`
(none/minimal/low/medium/high/xhigh/max/ultra), `session_id`, `access`,
`permission_profile` and `worktree`. Continue with `message_subagent` or
cancel with `cancel_subagent`; these use the existing durable job lifecycle.

Delegated runs use `muse exec --json`; the prompt is passed as a file, never
on the command line. `read` runs with workspace writes and shell disabled and
never approves prompts. `edit` disables approval prompts while Muse's OS
sandbox stays on. `ask` behaves as `read` for Muse in this version: no
external approval relay is implemented. `list_models` reads Muse's catalog
from a short-lived `muse serve` host (MSP `model/list`) and falls back to
pass-through model ids when no catalog answers. Account limits are reported
as unknown: MSP `usage/read` answers only for sessions of a running host.

The plugin's lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse,
Stop) bind the live session and inject unread mail at turn boundaries; Stop
can continue a turn that has waiting mail, and the dashboard sees the session
as busy while it works. **Waking an idle Muse session is still not
implemented**: a session that never starts a turn runs no hooks, so mail to an
idle session waits for its next turn or an explicit `inbox` call. The bridge
therefore does not advertise wake for Muse.

Native chats are read from Muse session logs
(`~/.local/share/muse/sessions`) without modifying them, including retained
frames and explicit native subagent session links. Uninstall runs
`muse plugins remove agent-bridge`. No bridge data format changes are
required for this additive agent kind.
