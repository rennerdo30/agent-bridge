---
title: "Security"
---

- Only your own agent-bridge processes can join: every connection must present the secret in `~/.agent-bridge/token`, which is created on first use and is readable only by you on Unix. Delete the file to rotate it; all sessions then need a restart.
- The pipe and socket are local to your user account. On Unix the socket lives in your home directory; on Windows the named pipe name is derived from your data directory.
- Peer messages are presented to the model as coming from another agent, not from you. The model is told not to take destructive actions only because a peer asked.
- Delegated runs are read-only by default (see [delegated access](../../delegated-access/)). Raise `access` only if you trust the task, and prefer `worktree: true` for edits.

## Dashboard and pairing

The dashboard uses a long-lived owner-only key and an HttpOnly cookie. It binds to loopback and rejects foreign Host headers. Writes require `x-agent-bridge: 1`. Paired PCs use TLS 1.3 and explicit pairing; discovery metadata is untrusted and never connects automatically. Remote job execution and file fetching need separate opt-in roots. See [network](../../network/) and [delegated access](../../delegated-access/).
