---
title: "Local subagent handoff"
slug: subagent-handoff
---

`handoff_subagents` transfers supervision from the calling session to another connected local session, regardless of agent kind.

In opencode, the native plugin exposes the same operation as `bridge_handoff_subagents` and delivers the inheritance message through its normal wake path.

| Parameter | Meaning |
| --- | --- |
| `to` | Exact live local Claude Code, Codex, opencode or Antigravity session name from `peers` |
| `jobs` | Exact job names, or `"all"` (the default) |
| `note` | Optional context for the new supervisor, up to 4,000 characters |

For example, the session `claude-animal-catch-game` calls:

```text
handoff_subagents(to="codex-animal-catch-game", jobs="all", note="Continue the remaining checks")
```

The target receives a waking message listing every inherited job's name, title and status, plus the note. The source gets a short confirmation. The target becomes the primary contact and a master. The former supervisor stays a master with control rights and is the first fallback recipient. While the primary is live, the former supervisor receives no subsequent results, notes, approvals or wake-ups. Each envelope has exactly one current recipient; when the primary is offline it goes to the next live master, without changing the primary. The target can message, cancel and continue the jobs, including jobs using the same agent kind as itself. A handoff changes supervision, not permission settings or worktree contents.

## Scope and rejection

Only the current supervisor can transfer its own top-level jobs. Selecting a parent also selects every descendant; descendants keep their immediate parent while their root identity and sibling group move. Other jobs remain with their supervisor. Empty selections, unknown names, another supervisor's jobs, offline targets, agent-kind shortcuts and self-transfer fail before the registry write.

Paired-PC session names are rejected: handoff is local only. Remote jobs using `remote-jobs-v1`, including a remote descendant, reject the entire request. Select local parents separately in that case. Reload the bridge in participating sessions after updating so the new broker operation and manager refresh handlers are available.

## Durable ownership and delivery

The shared job registry is the authority. One locked, atomic write updates owner, root lineage, sibling supervisor identity and supervisor-specific `send_to` grants. It appends each job's `ownershipHistory` and a registry `handoffs` receipt, retaining named `masters`. The version 3 migration is idempotent and preserves every record and unknown field. Before publication, the writer backs up a version 2 or legacy store; failure leaves the original file intact. Older version 2 binaries can read the additional fields but refuse to write the future format, protecting ownership from stale overwrites. SQLite migration 7 adds a delivery-route ledger with a backup first; it distinguishes a forwarded history row from a consumed envelope so fallback can safely return pending mail to a former master. Archived records remain byte-for-byte intact; a moved archived job gains a current active override.

The journal commits before delivery effects. Broker startup replays pending mail copies, root-lease moves and inheritance notifications with stable message identities. Undelivered job messages are copied to the current owner and their former recipient rows are retained as read history. New runner messages consult durable ownership, so a cached former-parent name cannot misroute results. Transferred inline envelopes are appended to durable `deliveryHistory` before sending. Broker reconnect/startup recovers them using the same delivery ledger, so a failed send remains recoverable and consumed envelopes never replay. Existing run metadata, prompts, branches, permission relay records and job archives are retained.

Detached runners keep running and accept attachment from their new supervisor. Inline runs stay in their original executor until completion; the broker validates new-supervisor controls and forwards them to that executor. Closing the original executor still ends an inline run, as it did before handoff; use detached runners for work that must survive session shutdown. Queued continuations and forwarded messages remain in the job record. Pending approval views project the new root owner while retaining the original relay capability.

Running blocking `ask_*` jobs can move too. Their original tool call returns only a supervision confirmation; the result, subsequent notes and approval requests go to the new primary through the durable delivery path.

Live root concurrency leases move to the target root even if its capacity is already exceeded. Running work is preserved, and further work waits until capacity is free. Existing target jobs determine its stable root identity; otherwise the target's session identity is used. Descendant managers refresh their root from the parent record before spawning. Depth remains the same because the target is a top-level session and immediate parent relationships remain unchanged.

## Dashboard

On a local session page, choose **⋯ → Hand off subagents…**, pick a local session, optionally add a note, and press **Hand off**. The action transfers all jobs and opens the recipient's page. The picker uses the dashboard palette and keyboard-accessible buttons.

`POST /api/subagents/handoff` accepts `{ "from": "claude-example", "to": "codex-example", "jobs": "all", "note": "Optional context" }`. It requires the dashboard authentication cookie and `x-agent-bridge: 1`. The dashboard sends a control request to the source session, which invokes the same broker core as the MCP tool. Invalid requests return 400, cross-site requests 403, and transfer rejection or an offline source returns 409. A source that does not confirm within the control timeout returns 504; inspect the dashboard and ownership history before retrying.
