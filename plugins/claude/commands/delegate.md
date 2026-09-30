---
description: Hand a task to Codex or opencode as a background subagent via agent-bridge
argument-hint: <codex|opencode> [model=<id>] [edit] [worktree] <task>
allowed-tools: mcp__plugin_agent-bridge_bridge__spawn_codex, mcp__plugin_agent-bridge_bridge__spawn_opencode
---

Start a background subagent with agent-bridge. Arguments: `$ARGUMENTS`

1. The first word picks the agent: `codex` → `spawn_codex`, `opencode` → `spawn_opencode`. If it is missing, ask the user.
2. Optional flags before the task:
   - `model=<id>` → pass it as `model` unchanged.
   - `edit` → `access: "edit"`.
   - `worktree` → `worktree: true`, which runs in a separate git worktree and implies edit.
3. Everything else is the task. Pass it as `prompt`, verbatim, adding any file paths or context from this conversation that the subagent needs, because it cannot see this conversation. Also pass a `title`: 3-7 words naming the job, like a chat title.
4. Tell the user the job name in one line. The result will arrive later as a message.
