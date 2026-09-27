# agent-bridge

**Let Claude Code and OpenAI Codex talk to each other.**

agent-bridge is a pair of plugins, one for Claude Code and one for Codex, built on a shared core. Agents on the same machine can:

- **Message each other live.** A Claude Code session and a Codex session send each other questions, reviews and results. Replies are threaded, and messages to an agent that is offline wait for it.
- **Delegate.** `ask_codex` (from Claude) and `ask_claude` (from Codex) run the other agent headlessly for a one-off task and return its answer. You can continue that session later.

```
 Claude Code session                               Codex session
┌─────────────────────────┐                      ┌─────────────────────────┐
│ agent-bridge MCP server │◄──── local pipe ────►│ agent-bridge MCP server │
│ + channel push / hooks  │  \\.\pipe\… or .sock │ + hooks / codex queue   │
└─────────────────────────┘          │           └─────────────────────────┘
               the first server to start is the broker; messages persist in SQLite
```

There is no daemon to install. Each agent starts its own MCP server. The first one to start binds a Windows named pipe (or a Unix domain socket on macOS/Linux) and acts as the broker. If that process exits, another server takes over automatically. All messages are stored in SQLite under `~/.agent-bridge`, so nothing is lost when a peer is offline or the broker changes.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- Claude Code (with plugin support) and/or Codex CLI (with plugin support; tested with 0.156)

## Install

### Claude Code

```bash
claude plugin marketplace add rennerdo30/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

### Codex

```bash
codex plugin marketplace add rennerdo30/agent-bridge
codex plugin add agent-bridge@agent-bridge
```

Codex does not run plugin hooks until you trust them. Open `/hooks` in a Codex session once and trust the agent-bridge hooks. Without them, messages are only visible when Codex calls the `inbox` tool.

## Usage

Just ask in plain language, for example:

> Ask Codex to review the diff in `src/auth` and wait for its answer.

> Send the Codex session a summary of the API we agreed on.

> Get a second opinion from Claude on this migration plan. *(from Codex)*

### Tools (both agents)

| Tool | What it does |
|---|---|
| `peers` | Who is online, your own name, delivery mode and auto-wake status |
| `send` | Message a peer: `to` = peer name, `claude`/`codex` (if exactly one is online) or `*`; `reply_to` threads answers |
| `wait_for_message` | Block until a (matching) message arrives, e.g. the answer to your question |
| `inbox` | Read unread messages |
| `ask_codex` / `ask_claude` | Headless delegation to the other CLI; returns the answer and a `session_id` to continue |
| `auto_wake` | Let incoming messages make this session keep working (see below) |

Peer names default to `<agent>-<project folder>`, for example `codex-myrepo`. Set `AGENT_BRIDGE_NAME` or the `name` option in the config file to choose your own.

## How messages reach a session

| | Claude Code | Codex |
|---|---|---|
| While the agent is working | injected after each tool call (`PostToolUse` hook) | same |
| On your next prompt | injected (`UserPromptSubmit` hook) | same |
| When the agent finishes a turn (auto-wake on) | `Stop` hook keeps it going | same |
| While the session is idle | **live push via channel** (see below) | auto-wake runs `codex queue`, which starts a turn |

### Live push into Claude Code (channels)

Claude Code [channels](https://code.claude.com/docs/en/channels) let the agent-bridge MCP server push peer messages straight into a running session, even an idle one. Channels are a research preview, and custom channels must currently be loaded with the development flag:

```bash
claude --dangerously-load-development-channels plugin:agent-bridge@agent-bridge
```

agent-bridge detects this flag on its parent process and switches to channel delivery automatically. You can force a mode with `AGENT_BRIDGE_DELIVERY=channel|hooks`.

### Auto-wake and loop protection

Auto-wake is **off by default**. Turn it on per session by asking the agent ("turn on agent-bridge auto-wake"), or globally with `"autoWake": true` in the config.

Every reply increments a conversation's hop count. Messages at or above `maxHops` (default 6) never wake an agent; they are still shown on the next prompt. Delegated headless sessions cannot delegate again.

## Configuration

`~/.agent-bridge/config.json` (all keys optional; per-agent sections override the top level; env vars override both):

```json
{
  "autoWake": false,
  "maxHops": 6,
  "codex": { "name": "codex-main", "claudeBin": "claude", "claudePermissionMode": "default" },
  "claude": { "delivery": "auto", "codexBin": "codex", "codexSandbox": "read-only" }
}
```

| Env var | Meaning |
|---|---|
| `AGENT_BRIDGE_HOME` | Data directory (default `~/.agent-bridge`) |
| `AGENT_BRIDGE_NAME` | Peer name |
| `AGENT_BRIDGE_AUTO_WAKE` | `on` / `off` |
| `AGENT_BRIDGE_MAX_HOPS` | Loop limit |
| `AGENT_BRIDGE_DELIVERY` | Claude only: `auto`, `channel`, `hooks` |
| `AGENT_BRIDGE_CLAUDE_BIN` / `AGENT_BRIDGE_CODEX_BIN` | Paths of the CLIs used for delegation |
| `AGENT_BRIDGE_LOG_LEVEL` | File log level: `debug`, `info` (default), `warn`, `error`, `silent` |
| `AGENT_BRIDGE_LOG_CONSOLE` | stderr log level (default `warn`) |
| `AGENT_BRIDGE_PIPE` | Override the pipe / socket path |

Logs are written to `~/.agent-bridge/logs/agent-bridge.log`.

## CLI

The plugins bundle a small CLI for debugging:

```bash
node <plugin>/dist/cli.mjs status          # broker and connected peers
node <plugin>/dist/cli.mjs send codex "hi" # send as peer "cli"
node <plugin>/dist/cli.mjs tail            # print messages addressed to "cli"
node <plugin>/dist/cli.mjs paths
```

## Security notes

- The pipe and socket are local to your user account. On Unix the socket lives in your home directory; on Windows the named pipe name is derived from your data directory.
- Peer messages are presented to the model as coming from another agent, not from you. The model is told not to take destructive actions only because a peer asked.
- Delegated Codex runs are `read-only` by default. Delegated Claude runs use the `default` permission mode, which cannot approve anything in headless mode. Raise these only if you trust the task.

## Development

```bash
npm install
npm run check   # typecheck + tests + build
```

`npm run build` bundles `src/` into `plugins/*/dist` (committed, so plugins work straight from git).

## License

MIT
