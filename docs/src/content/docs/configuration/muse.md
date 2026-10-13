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
external approval relay is implemented. Muse cannot list its models, so any
model id is passed through verbatim (`list_models` explains this), and account
limits are reported as unknown because Muse exposes no machine-readable
quota command.

**Idle Muse sessions receive mail on their next turn or through `inbox`;
waking an idle session is not implemented.** Muse's hook payloads have not
been verified against the bridge's wake delivery, so the bridge does not
advertise wake for Muse.

Native chats are read from Muse session logs
(`~/.local/share/muse/sessions`) without modifying them, including retained
frames and explicit native subagent session links. Uninstall runs
`muse plugins remove agent-bridge`. No bridge data format changes are
required for this additive agent kind.
