---
title: "Dashboard"
---

The dashboard starts automatically: whichever agent session hosts the bridge also hosts the dashboard at `http://127.0.0.1:4777`, and if that session ends, another one takes it over. To open it:

- `/agent-bridge:dashboard` in Claude Code (or ask any agent to "open the agent-bridge dashboard"), or
- from any terminal:

  ```bash
  npx -y github:rennerdo30/agent-bridge ui     # opens the running dashboard, or starts one if no agent runs
  ```

Turn the automatic start off with `"dashboard": false` in `~/.agent-bridge/config.json` (or `AGENT_BRIDGE_DASHBOARD=off`); change the port with `"dashboardPort"`.

The dashboard has a **sessions sidebar**, grouped by PC, with search and folding:

- **Overview:** connected sessions, usage left, working and finished jobs, and message history with a box to send a message yourself (as "you"). Finished jobs show merge/review outcomes.
- **Session page:** its own chat with an owner-message composer for local sessions, and a subagent tree with nested bridge jobs and the CLIs' own subagents. Native children offer supported direct input or a note to their parent. Conversations use chat bubbles; commands fold into rows, and follow-ups stay in the same job. Progress and ETA appear in the job row and conversation header. Older finished runs fold into an archive and remain readable.
- **Search history:** search messages, subagent runs, Decisions and CLI chats, including archived history; filter by kind or agent, inspect sources, or opt into a model-generated summary.
- **Decisions:** pinned owner choices with scope and revision history.
- **Waiting for you:** pending approvals with countdowns and allow/deny controls, plus optional browser notifications.
- **Network:** pairing, discovery details, connection checks, firewall guidance and file-transfer progress. Paired sessions appear in the sidebar, with their chats and subagents readable over the authenticated link.

These screenshots use synthetic demo data only.

| Overview · dark | Overview · light |
|---|---|
| <img src="../images/dashboard-overview-dark.png" alt="Dashboard overview in dark theme" loading="lazy"> | <img src="../images/dashboard-overview-light.png" alt="Dashboard overview in light theme" loading="lazy"> |

| Session · dark | Session · light |
|---|---|
| <img src="../images/dashboard-session-dark.png" alt="Session conversation, nested jobs, native subagents and ETA in dark theme" loading="lazy"> | <img src="../images/dashboard-session-light.png" alt="Session conversation, nested jobs, native subagents and ETA in light theme" loading="lazy"> |

| Network | Search history |
|---|---|
| <img src="../images/dashboard-network.png" alt="Network page with a connected demo PC" loading="lazy"> | <img src="../images/dashboard-search.png" alt="Search history with synthetic checkout results" loading="lazy"> |

It only listens on 127.0.0.1. Its link contains a secret (stored in `~/.agent-bridge/dashboard.json`, readable only by you on Unix); without it the dashboard refuses every request, also from other local programs and web pages. `ui` options: `--port=N`, `--no-open`.

Local sessions also have read-only transcript APIs for their normal chat and their CLI's native subagents: Claude Code JSONL, Codex rollout JSONL, and OpenCode SQLite. They use the peer's session id, the same dashboard cookie, and bounded incremental reads. CLI files are never edited. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and OpenCode's `XDG_DATA_HOME` storage override are respected. Paired-PC reads use the existing TLS link; update and restart hosting sessions on both PCs. See [the transcript API](../transcripts/) and [paired dashboard reads](../remote-dashboard/).

### Run logs

Every run also writes a step-by-step log to `~/.agent-bridge/runs/`, whose path is in the result. Follow a run live from any terminal:

```bash
npx -y github:rennerdo30/agent-bridge watch            # the newest run
npx -y github:rennerdo30/agent-bridge watch opencode   # the newest opencode run
```

opencode subagents keep opencode's full tool set on purpose, because opencode's free tier rejects subagents with a restricted tool list. Their prompt tells them to only relay.
