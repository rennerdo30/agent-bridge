---
title: "First steps"
---

Just ask in plain language, for example:

> Ask Codex to review the diff in `src/auth` and wait for its answer.

> Send the Codex session a summary of the API we agreed on.

> Get a second opinion from Claude on this migration plan. *(from Codex)*

Open the dashboard with `agent-bridge ui`. Ask your agent to use `peers`, then send a question with `send`. For longer work, start a titled `spawn_*` job with explicit access and a worktree. See the [tool reference](../../reference/tools/).

`/agent-bridge:dashboard`, `/agent-bridge:peers`, `/agent-bridge:inbox`, `/agent-bridge:send <to> <message>` and `/agent-bridge:delegate <codex|opencode> [model=<id>] [edit] [worktree] <task>`.
