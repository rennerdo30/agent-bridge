---
description: Send a message to another agent session via agent-bridge
argument-hint: <peer or agent kind> <message>
---

Send a message over agent-bridge. Arguments: `$ARGUMENTS`

- The first word is the recipient: a peer name, an agent kind (`claude`, `codex`, `opencode`, `antigravity`) or `*` for everyone. The rest is the message, sent as written.
- If no recipient or no message was given, call `peers` and ask the user whom to message and what to say.
- Call the agent-bridge `send` tool once, then tell the user in one line whom it was delivered to (or that it is queued).
