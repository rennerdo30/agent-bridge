---
title: "Paired PCs"
---

Networking is **off by default**. Pair two PCs once, then their agents can message each other, send files and start remote jobs. Your local dashboard can also read the other PC's chats, bridge jobs and native subagents. Start an agent-bridge session (Claude Code, Codex or opencode) on each PC first.

**In the dashboard** (`agent-bridge ui`, page **Network**):

1. On both PCs: name the PC, keep "Other PCs on this network" and press **Turn on**. If the firewall blocks other PCs, the page says so; on Windows **Open the ports…** shows the rules and adds them after you confirm and accept the administrator prompt. macOS and Linux show the commands to run yourself.
2. On one PC: **Create pairing code**. The code is copied to the clipboard and is valid once, for ten minutes. The page shows the address the other PC should use and turns to "Connected" when it pairs.
3. On the other PC: under **Connect to another PC**, pick the PC from the list (or enter its address) and paste the code.

Paired PCs are listed with their status. **Check** asks the other PC which agents are online and how fast it answers. **Unlink** removes the pairing on this PC.

**In a terminal**, `agent-bridge connect` runs the same steps. It suggests the hostname, keeps your other `config.json` settings, shows firewall commands, and reloads the broker without restarting sessions. Choose **create** on one PC and **connect** on the other; the code prompt is hidden, and the wizard ends with a test message there and back. `--yes` never confirms firewall changes.

Networking uses TLS 1.3 with the pairing key; secrets live in the protected `~/.agent-bridge/network/keys.json`. Discovery only lists PCs, it never connects: a PC without your code cannot pair. Keep codes out of chats, logs and shell histories. If a PC's sessions run a version from before the wizard, update and restart them.

For unattended setup, use `agent-bridge connect --non-interactive --yes --create` (waits up to ten minutes), or `agent-bridge connect --non-interactive --yes --address <host:port> --code <code>`. Optional `--name`, `--bind`, `--port` and `--no-discovery` select settings. Passing a secret as an argument can expose it in process listings/history; prefer the interactive code prompt. Review firewall rules separately.

Manual fallback: enable top-level `network: { enabled: true, name: "unique-pc", bind: "0.0.0.0", port: 48148, discovery: true }` in config on each PC, restart all hosting sessions, allow TCP 48148 and UDP 48149 on the trusted LAN, then run `agent-bridge pair` on one PC and `agent-bridge link <host:port> <code>` on the other. `agent-bridge network` shows status; `agent-bridge unlink <instance-id>` on both PCs revokes a pairing.

Remote sessions and job runners appear as `demo-desktop/claude-webshop`; `send` routes to those names and replies across the link. Broadcasts include connected paired PCs; agent-kind targets remain local. `ask_*` and `spawn_*` accept `host` to run on a paired PC, with the remote folder and worktree managed there. The requester retains its job controls and result history; see [remote jobs](../remote-jobs/).

Remote jobs are separately opt-in: the execution PC must enable `network.remoteJobs` and allow the requesting PC, target agents and repository roots. Pairing alone does not permit delegation.

`send_files(to, paths)` streams files/folders to a paired peer's inbox with SHA-256, quiet progress reports, cancellation and persisted restart resume (default maximum 8 GiB, configurable with `network.maxTransferBytes`). `fetch_files(from, paths)` pulls from the other PC's explicitly configured absolute `network.fetchRoots`; fetching is off by default. `cancel_transfer(id)` cancels an active transfer. Local delivery and older brokers keep the one-MiB/128-entry path. Files never overwrite existing targets or execute automatically. See [file transfer and dashboard contracts](../network/#files-and-folders).

See [docs/network.md](../network/) for the protocol, threat model and limits. Discovery metadata is unencrypted; application traffic is encrypted. Real two-PC LAN discovery, firewall policy and clipboard behavior require validation on your machines.
