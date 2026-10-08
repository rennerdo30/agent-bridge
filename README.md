<img src="assets/logo.svg" alt="" width="72" height="72">

# agent-bridge

**Let Claude Code, OpenAI Codex, opencode and Google Antigravity CLI work together.**

agent-bridge connects the coding agents on your machine, and on PCs you pair, into one team. They message each other, hand each other work as subagents, and share history. You follow and steer everything from one local dashboard.

**[Documentation](https://rennerdo30.github.io/agent-bridge/)** · [Install](#install) · [Update](#update) · [Changelog](CHANGELOG.md)

![The agent-bridge dashboard: sessions grouped by project, a subagent tree and a live conversation](docs/images/dashboard-session-dark.png)

## What it does

- **Messaging between agents.** Sessions send each other questions, reviews and results. Messages to an offline or idle agent wait and wake it when possible.
- **Subagents across CLIs.** Any agent can run another one headlessly (`ask_codex`, `ask_claude`, …) or start it in the background (`spawn_*`). You can talk to a running subagent, continue a finished one with its full context, cancel it, or hand all of them to another session. Edits can run in their own git worktree.
- **Projects with a main and a secondary.** A Claude and a Codex session in the same folder share their project's jobs. The main session is the first contact. If it closes or runs out of usage, the secondary takes over and nothing is lost.
- **Questions to you.** Agents ask you decisions in one place. You hear a chime in the dashboard, or get a Windows notification that opens the question. Your answer goes straight back to the agent that asked.
- **A dashboard for everything.** Sessions, subagent trees, chats, progress with ETA, approvals, pinned decisions, full history search and paired PCs, at `http://127.0.0.1:4777`.
- **Paired PCs.** Two PCs pair once over TLS. Their agents then message each other, transfer files and start jobs on the other PC.
- **Nothing gets lost.** Every message, job, chat and decision is stored and searchable. History is archived, never deleted, and upgrades migrate your data with a backup first.

## Install

Requires **Node.js 22.16+**. Install for every supported CLI it finds on your machine:

```bash
npx -y github:rennerdo30/agent-bridge install
```

It shows its plan per tool and asks first; add `--yes` to skip the questions, or name tools: `install claude codex opencode antigravity`. In Codex, open `/hooks` once and trust the agent-bridge hooks. Per-CLI details: [Installation](https://rennerdo30.github.io/agent-bridge/getting-started/install/).

## Update

```bash
npx -y github:rennerdo30/agent-bridge update
npx -y github:rennerdo30/agent-bridge status   # which sessions still run an older version
```

You can update while sessions run. New sessions start on the new version, and running ones switch at their next plugin reload. Mixed versions keep working together. See [Updating](https://rennerdo30.github.io/agent-bridge/getting-started/update/).

## First steps

Just ask your agent in plain language:

> Ask Codex to review the diff in `src/auth` and tell me what it finds.

> Start two Codex subagents in worktrees: one writes the tests, one fixes the bug.

> Hand all your subagents to codex-myproject, I'm closing this session.

> Open the agent-bridge dashboard.

All tools, parameters and behavior are in the [MCP tools reference](https://rennerdo30.github.io/agent-bridge/reference/tools/).

## How it works

There is no daemon. Each agent session starts its own small agent-bridge server. The first one becomes the broker on a local pipe (a Windows named pipe or a Unix socket), and if it exits another takes over. Data lives in SQLite under `~/.agent-bridge`. Subagents run in detached job runners, so they survive plugin reloads.

```
 Claude Code session                          Codex session
┌───────────────────────┐                    ┌───────────────────────┐
│ agent-bridge server   │◄── local pipe ────►│ agent-bridge server   │
│ hooks · channels      │                    │ hooks · app-server    │
└───────────────────────┘         │          └───────────────────────┘
          first server to start is the broker · messages in SQLite
```

## Security

- Only your own agent-bridge processes can connect: every connection presents a secret from `~/.agent-bridge/token`.
- The dashboard listens on `127.0.0.1` only and needs its access key.
- Subagents are **read-only by default**. You raise access per job, and edits can be isolated in worktrees.
- Messages from other agents are marked as such, and agents are told not to act destructively only because a peer asked.
- Pairing uses TLS 1.3 with a one-time code; discovery never connects on its own.

Details: [Security](https://rennerdo30.github.io/agent-bridge/reference/security/).

## Development

```bash
npm install
npm run check   # typecheck, tests and build
```

`npm run build` bundles `src/` into `plugins/*/dist`, which is committed so the plugins install straight from Git. The documentation site lives in `docs/` (Astro Starlight).

## License

MIT
