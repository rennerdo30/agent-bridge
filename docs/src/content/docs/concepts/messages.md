---
title: "Messages and waking"
---

| | Claude Code | Codex |
|---|---|---|
| While the agent is working | injected after each tool call (`PostToolUse` hook) | same |
| On your next prompt | injected (`UserPromptSubmit` hook) | same |
| When the agent finishes a turn (auto-wake on) | `Stop` hook keeps it going | same |
| While the session is idle | **live push via channel** (see below) | auto-wake requests native `codex queue` delivery to the attached session |

opencode receives messages through its plugin: after each model step while it works, and by starting a turn itself when it is idle.

### Live push into Claude Code (channels)

Claude Code [channels](https://code.claude.com/docs/en/channels) let the agent-bridge MCP server push peer messages straight into a running session, even an idle one. Channels are a research preview, and custom channels must currently be loaded with the development flag:

```bash
claude --dangerously-load-development-channels plugin:agent-bridge@agent-bridge
```

agent-bridge detects this flag on its parent process and switches to channel delivery automatically. You can force a mode with `AGENT_BRIDGE_DELIVERY=channel|hooks`.

### Waiting for results and replies

**Claude Code:** a turn never waits. When a Claude session has background subagents running (`spawn_*`), or has asked a peer a question, its turn ends normally and you can keep working. A background hook (Claude Code's `asyncRewake`) waits instead. When a subagent result or the reply arrives, it wakes the session with it. Direct messages from another session and broadcasts wake idle Claude by default, including messages from a paired PC. Set `"wakeOnDirect": false` to queue them for its next turn. Agent-kind targets need auto-wake; quiet status `:note` messages do not wake the session. The hop limit always applies.

**Codex and opencode** return promptly from their `Stop` hooks. Later mail uses notification waits and the available native wake path. Exact direct messages can wake an idle session with `wakeOnDirect` enabled while global auto-wake stays off: Codex uses its native queue and opencode uses its live plugin prompt client. Busy sessions defer delivery without interrupting. This needs the upgraded bridge loaded and a supported live CLI transport; Antigravity uses its installed native hooks and bridge inbox at the next safe step or turn.

`send` reports inbox delivery separately from wake policy. A read receipt is available with
`wait_for_message(read_receipt_of=<sent message id>)`, locally and across paired PCs. It confirms
consumption by the bridge's hook, tool or channel, not that the agent completed the work.
`wait_for_message(mode="notify", reply_to=<sent id>)` registers a durable one-shot wait and
returns immediately. This is the default for incoming messages. Keep working or end the turn;
do not repeat the call. A queued match is returned immediately; a later match uses the existing
wake/channel paths without enabling global auto-wake. If the host cannot wake, the session is
offline, or a quiet/hop guard applies, mail stays queued for the next hook or inbox call.
Subscriptions survive `/reload-plugins` and session exit and finish only when matching mail is
consumed. `peers` and `SessionStart` show armed waits and their `resume_id`.

`mode="block"` retains the 110-second cap below the host's 120-second background threshold.
A blocking message timeout automatically arms notify instead of requesting another wait.
For compatibility, `timeout_sec` without `mode` selects block; `read_receipt_of` and nested
child waits support block only. Existing interrupted blocking waits retain their filters and
can resume as before, or convert with `wait_for_message(resume_id=<id>, mode="notify")`.
Cancel a saved wait with `mode="cancel"` and `resume_id`; its record is archived, mail untouched.
See [notification-wait design and tradeoffs](../../message-waits/) and [delivery guarantees and native wake requirements](../../messaging-delivery/). Queue acceptance alone does not prove a provider turn or inbox consumption.

### Auto-wake and loop protection

Auto-wake is **off by default**. Turn it on per session by asking the agent ("turn on agent-bridge auto-wake"), or globally with `"autoWake": true` in the config.

Every reply increments a conversation's hop count. Messages at or above `maxHops` (default 6) never wake an agent; they are still shown on the next prompt. Delegated sessions retain parent/sibling messaging restrictions and the configured delegation-depth limit.
