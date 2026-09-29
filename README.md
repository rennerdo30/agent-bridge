# agent-bridge

**Let Claude Code, OpenAI Codex and opencode talk to each other.**

agent-bridge is a set of plugins for Claude Code, Codex and opencode, built on a shared core. Agents on the same machine can:

- **Message each other live.** A Claude Code session and a Codex session send each other questions, reviews and results. Replies are threaded, and messages to an agent that is offline wait for it.
- **Delegate.** `ask_<agent>` runs another agent headlessly for a one-off task and returns its answer; for example `ask_codex` and `ask_opencode` from Claude, or `ask_claude` from Codex. You can continue that session later.
- **Spawn each other as subagents.** `spawn_codex` / `spawn_claude` start the other agent in the background and return immediately. The result arrives later as a message, and several subagents can run in parallel.
- **Pick any model.** `ask_*` and `spawn_*` accept any model id or alias the target CLI accepts, for example `gpt-6-sol`, `opus`, or a full Claude model id. Ids are passed through verbatim, so new models work without a plugin update.

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

### All at once

```bash
npx -y github:rennerdo30/agent-bridge install        # or: install claude codex opencode
```

The installer finds which of the three tools you have. For each one it shows the exact commands it will run and asks before running them (`--yes` skips the questions). It only runs the tools' official plugin commands, listed below; for opencode it copies the plugin files into opencode's plugin folder. Nothing is patched. `uninstall` works the same way; for updates see [Updating](#updating).

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

### opencode

```bash
npx -y github:rennerdo30/agent-bridge install-opencode
```

This copies the plugin into opencode's global config (`~/.config/opencode/plugins/`), plus a skill and the `codex` / `claude` subagents. Existing files you created yourself are never overwritten. Restart opencode afterwards. It needs Node.js 22.13+ on `PATH`. Remove it with `npx -y github:rennerdo30/agent-bridge uninstall-opencode`.

In opencode the tools are called `bridge_peers`, `bridge_send`, `bridge_ask_claude`, `bridge_spawn_codex`, and so on. Because opencode plugins can start turns themselves, opencode receives peer messages live, even while idle, whenever its listen window or auto-wake applies.

## Updating

```bash
npx -y github:rennerdo30/agent-bridge update     # or: update claude codex opencode
npx -y github:rennerdo30/agent-bridge status     # which sessions still run an old version
```

1. **Close all Codex sessions first.** Codex keeps the plugin folder in use while it runs, and its update fails with "Access is denied".
2. `update` runs the same official commands as `install` (`claude plugin update …`, `codex plugin marketplace upgrade …` plus `codex plugin add …`) and copies the new opencode plugin. It asks per tool; `--yes` skips the questions.
3. **Restart your agent sessions** to load the new version. There is deliberately no command for this: the sessions are your own windows, often with work in progress. `status` lists every connected session with its agent-bridge version and marks old ones `OUTDATED`:

   ```
   claude-myrepo  [claude, busy, v0.5.0 OUTDATED]  since …  E:\work\myrepo
   codex-myrepo   [codex, idle, v0.5.4]            since …  E:\work\myrepo
   1 session(s) run an older agent-bridge than 0.5.4. Restart them (after finishing their current work) to load the update.
   ```
4. In Codex, check `/hooks` after an update. Newly added agent-bridge hooks, such as the `PermissionRequest` hook in 0.5.0, must be trusted once.

All sessions should run the same version. Since 0.10.0 the bridge's pipe name includes the wire protocol, so sessions of incompatible versions run separate bridges instead of locking each other out. They don't see each other until they are restarted. The same applies to sessions from before 0.10.0.

## Usage

Just ask in plain language, for example:

> Ask Codex to review the diff in `src/auth` and wait for its answer.

> Send the Codex session a summary of the API we agreed on.

> Get a second opinion from Claude on this migration plan. *(from Codex)*

### Tools (both agents)

| Tool | What it does |
|---|---|
| `peers` | Who is online (busy or idle, uptime, session id), your own name and settings, and every running delegation (background jobs and blocking `ask_*` calls) with its runtime and current step |
| `send` | Message a peer: `to` = peer name, `claude`/`codex` (if exactly one is online) or `*`; `reply_to` threads answers |
| `wait_for_message` | Block until a (matching) message arrives, e.g. the answer to your question |
| `inbox` | Read unread messages |
| `ask_claude` / `ask_codex` / `ask_opencode` | Headless delegation to another agent (every agent gets the other two); waits and returns the answer and a `session_id` to continue |
| `spawn_claude` / `spawn_codex` / `spawn_opencode` | Same, but as a background subagent: returns a job name at once; the result arrives as a message from `<agent>-job-<id>`; `peers` shows each job's current step |
| `message_subagent` | Talk to a subagent started with `ask_*` or `spawn_*`: a running one gets the message while it works and answers right away; a finished or failed one continues in its own session with its full context (see below) |
| `usage_limits` | How much of each agent's account limits is used (Codex and Claude: 5-hour and weekly windows with reset times; opencode: today's spend and which models are free), so the driving agent can pick who gets large work |
| `cancel_subagent` | Stop a running subagent (background job or blocking `ask_*` run) by its job name |
| `auto_wake` | Let incoming messages make this session keep working (see below) |

`ask_*` and `spawn_*` take these optional parameters:

- `model`: any id or alias the target accepts, passed through verbatim. For opencode, short or partial names like `muse-spark` are resolved against `opencode models`. An ambiguous or unknown name fails immediately and lists the candidates.
- `session_id`: continue an earlier run. `cwd`: working folder.
- `timeout_sec`: 60 minutes by default for `ask_*`; background `spawn_*` jobs have no practical limit (24 hours). A run that times out is not lost: the error names its session (`call again with session_id="…"`), so the caller continues it instead of starting over. The relay subagents do that automatically, once.
- `access` and `worktree`, see below.
- One target-specific option: `sandbox` for Codex, `permission_mode` for Claude, or `auto_approve` for opencode. Headless opencode rejects every permission request unless `auto_approve` is set.

Peer names default to `<agent>-<project folder>`, for example `codex-myrepo` (`<agent>-session` until the folder is known; a bare `codex` always means "the codex peer"). Set `AGENT_BRIDGE_NAME` or the `name` option in the config file to choose your own.

### Slash commands (Claude Code)

`/agent-bridge:dashboard`, `/agent-bridge:peers`, `/agent-bridge:inbox`, `/agent-bridge:send <to> <message>` and `/agent-bridge:delegate <codex|opencode> [model=<id>] [edit] [worktree] <task>`.

### Editing subagents: access and worktrees

- `access: "read"` (the default) lets a delegated agent look but not change anything. `access: "ask"` asks you for each change (see below). `access: "edit"` lets it change files.
- A subagent started in an existing agent-bridge worktree (`cwd` inside `~/.agent-bridge/worktrees`) gets `access: "edit"` by default. The spawn result always says which access a job has.
- `worktree: true` runs the subagent in its own git worktree on a branch `agent-bridge/<id>`. Your working copy stays untouched. The result shows a diff summary and the exact commands to review, merge (`git merge agent-bridge/<id>`) or discard the changes. Use it for parallel or risky edits.
- Results also list the files changed in place (for `access: "edit"` without a worktree) and the token usage or cost the CLI reported.

How `read` is enforced per agent:

| Agent | read | edit |
|---|---|---|
| Codex | `read-only` sandbox, with approvals routed to `user` so an `auto_review` setting cannot approve escalations | `workspace-write` sandbox |
| opencode | an extra config layer turns edits and shell commands into "ask", which headless runs reject | `--auto` |
| Claude | editing and shell tools removed (`--disallowedTools`); Read, Grep and Glob stay | `acceptEdits` |

Why so strict: in testing, permission modes alone did not hold. An `approvals_reviewer = "auto_review"` Codex setting approved writes past the read-only sandbox. Headless Claude wrote files and ran commands even in `manual` mode. opencode's default rules allow everything. `agent-bridge reliability` checks all three.

Read-only also covers MCP tools, which can change things too: a read-only Claude subagent gets every configured MCP server denied (plugins, `~/.claude.json`, the project's `.mcp.json`, claude.ai connectors) except agent-bridge's own, so it can still answer you; read-only opencode subagents keep only `bridge_send` of all MCP tools; Codex asks its parent before any MCP tool call.

Codex edit jobs in a linked git worktree may write that worktree's git data in the main repository (`.git/worktrees/<name>` and the shared `.git`), so they can commit on their own branch. Work a subagent leaves uncommitted is committed for it with a subject taken from its answer and a `Co-Authored-By` line naming the agent and model.

A read-only Claude subagent therefore cannot run shell commands such as `git diff`. Give it `access: "edit"`, ideally with `worktree: true`, if it needs them.

### Permission requests from subagents: `access: "ask"`

With `access: "ask"` a subagent starts read-only. Whenever it wants to change a file or run a command, you get an Allow / Deny dialog in the session that started it. That dialog is your host's native MCP dialog, in Claude Code or Codex. Your answer goes back to the subagent. Dismissing the dialog, not answering within 10 minutes, or any error counts as Deny. The result lists every request and your decision.

| Subagent | Forwarding | How |
|---|---|---|
| opencode | yes | agent-bridge runs a private `opencode serve` (127.0.0.1, random port and password) and answers its permission events |
| Codex | yes | Codex runs through `codex app-server`, which hands its approval questions to agent-bridge. With `AGENT_BRIDGE_CODEX_EXEC=1` (plain `codex exec`) the agent-bridge `PermissionRequest` hook asks your session instead. Trust it once via `/hooks` in Codex. Without that trust entry, Codex subagents run strictly read-only, so Codex's automatic reviewer never decides on its own. If a Codex run ever changes files without the hook asking, agent-bridge warns and switches that hook version back to read-only (fail closed). |
| Claude | not yet | `ask` runs read-only |

The parent session must support MCP elicitation dialogs; Claude Code and Codex do. If it doesn't, every request is denied.

### Talking to subagents: follow-ups and recovery

Every `ask_*` and `spawn_*` run is a job with a name like `codex-job-1a2b3c4d` or `opencode-ask-9f8e7d6c`, and it keeps its own session. So you can talk to it like a native subagent:

- **Follow up:** `message_subagent(job="codex-job-1a2b3c4d", message="now add tests")` continues the same Codex thread, Claude session or opencode session with its full context, in the same folder or worktree. The answer arrives as a message from the job.
- **While it runs:** the message reaches it at its next step, like with a native subagent, and it answers right away (for example "how far are you?", or "skip the docs, focus on the tests"). Its answer arrives as a message from the job. Codex gets the message as real user input in its running turn (agent-bridge drives Codex through `codex app-server` for this); Claude and opencode get it through agent-bridge's hooks and plugin. A message that arrives just as it finishes is sent as a follow-up instead.
- **Recover:** if a run failed, timed out or was interrupted, `message_subagent(job=...)` without a message tells it to continue where it stopped. The failure message says so and names the job.

- **After a restart:** jobs are saved in `~/.agent-bridge/jobs.json` (the last 200, small), so a restarted session can still continue them with `message_subagent`. Jobs that were running when the session ended show as interrupted; `message_subagent(job=...)` without a message recovers them in their own session, folder and worktree, with the same access.
- **Approvals:** when a background Codex subagent needs approval (for example an MCP tool call such as Pair Desk), the question goes to the agent that started it as a message: "codex-job-… asks for approval: …". The agent answers with `message_subagent(job=..., message="allow")` or `"deny"`, so this works in auto mode and while you're away; no answer within 10 minutes counts as deny. One allow covers that MCP server for the rest of the run. A blocking `ask_*` caller can't answer while it waits, so those questions are shown to you instead. With `access: "ask"`, commands and edits are always asked of you.

`peers` lists running jobs and the recent finished ones. This works the same whichever agent is the host (Claude Code, Codex or opencode, where the tool is `bridge_message_subagent`) and whichever is the subagent. Cancelling or ending a session stops its subagents with their whole process tree.

## Native subagents

Where the host lets plugins define subagents, agent-bridge ships them. Each one is a thin relay that hands the task to the other agent and returns its answer. Because they are the host's own subagents, you get its subagent UI, background runs, parallelism and cancellation.

| Host | Subagents | How to use |
|---|---|---|
| Claude Code | `agent-bridge:codex`, `agent-bridge:opencode` (bundled in the plugin, run on Haiku) | "use the codex subagent to review this diff", or `@agent-agent-bridge:codex` |
| opencode | `codex`, `claude` (installed by `install-opencode`) | "use the codex subagent …", or `@codex` |
| Codex | none: Codex plugins can't ship agent roles, and Codex's current `spawn_agent` has no role parameter | use `spawn_claude` / `spawn_opencode` (background jobs, see below) |

### Following a delegated run

While a delegated run works, agent-bridge streams every step as an MCP progress notification. Each line carries the elapsed time, a step counter with totals, and what the agent is doing or saying:

```
2m · step 14 (6 cmds, 3 edits) · bash: py scripts/run-domain-tests.py
3m · step 14 (6 cmds, 3 edits) · says: Rooms per building type are in, now the furniture kit.
still working, no new step for 4m (last: bash: py scripts/run-domain-tests.py)
```

The "still working" heartbeat comes after every minute without a new step, so long test runs or thinking phases don't look like a hang. Claude Code shows these lines under the running tool call (`Ctrl+O` expands them). Codex currently ignores MCP progress.

### Web dashboard

The dashboard starts automatically: whichever agent session hosts the bridge also hosts the dashboard at `http://127.0.0.1:4777`, and if that session ends, another one takes it over. To open it:

- `/agent-bridge:dashboard` in Claude Code (or ask any agent to "open the agent-bridge dashboard"), or
- from any terminal:

  ```bash
  npx -y github:rennerdo30/agent-bridge ui     # opens the running dashboard, or starts one if no agent runs
  ```

Turn the automatic start off with `"dashboard": false` in `~/.agent-bridge/config.json` (or `AGENT_BRIDGE_DASHBOARD=off`); change the port with `"dashboardPort"`.

The dashboard has an **Overview** and a **tab per session**:

- **Overview:** every connected Claude Code, Codex and opencode session as a card (busy or idle, folder, version, how many subagents it started and how many are working), the latest subagents of all sessions, and the message history with a box to send a message yourself (as "you").
- **Session tab:** the subagents this session started (finished ones older than 30 minutes fold into an archive), and for the selected one its whole conversation: the task, what it said, its commands (bursts fold into one row), its answer, and every follow-up as a further turn. Runs are grouped under the session that started them, never shown as sessions of their own.

It only listens on 127.0.0.1. Its link contains a secret (stored in `~/.agent-bridge/dashboard.json`, readable only by you on Unix); without it the dashboard refuses every request, also from other local programs and web pages. `ui` options: `--port=N`, `--no-open`.

### Run logs

Every run also writes a step-by-step log to `~/.agent-bridge/runs/`, whose path is in the result. Follow a run live from any terminal:

```bash
npx -y github:rennerdo30/agent-bridge watch            # the newest run
npx -y github:rennerdo30/agent-bridge watch opencode   # the newest opencode run
```

opencode subagents keep opencode's full tool set on purpose, because opencode's free tier rejects subagents with a restricted tool list. Their prompt tells them to only relay.

## How messages reach a session

| | Claude Code | Codex |
|---|---|---|
| While the agent is working | injected after each tool call (`PostToolUse` hook) | same |
| On your next prompt | injected (`UserPromptSubmit` hook) | same |
| When the agent finishes a turn (auto-wake on) | `Stop` hook keeps it going | same |
| While the session is idle | **live push via channel** (see below) | auto-wake runs `codex queue`, which starts a turn |

opencode receives messages through its plugin: after each model step while it works, and by starting a turn itself when it is idle.

### Live push into Claude Code (channels)

Claude Code [channels](https://code.claude.com/docs/en/channels) let the agent-bridge MCP server push peer messages straight into a running session, even an idle one. Channels are a research preview, and custom channels must currently be loaded with the development flag:

```bash
claude --dangerously-load-development-channels plugin:agent-bridge@agent-bridge
```

agent-bridge detects this flag on its parent process and switches to channel delivery automatically. You can force a mode with `AGENT_BRIDGE_DELIVERY=channel|hooks`.

### Waiting for results and replies

**Claude Code:** a turn never waits. When a Claude session has background subagents running (`spawn_*`), or has asked a peer a question, its turn ends normally and you can keep working. A background hook (Claude Code's `asyncRewake`) waits instead. When a subagent result or the reply arrives, it wakes the session with it. Unrelated peer messages don't wake it, unless auto-wake is on; they are shown on your next prompt.

**Codex and opencode** use a listen window instead. After such a session sends a bridge message or spawns a subagent, its `Stop` hook keeps the turn open for up to `lingerSec` seconds (default 300) waiting for the reply. Press Esc to stop listening early, or set `lingerSec` to `0` to disable it.

### Auto-wake and loop protection

Auto-wake is **off by default**. Turn it on per session by asking the agent ("turn on agent-bridge auto-wake"), or globally with `"autoWake": true` in the config.

Every reply increments a conversation's hop count. Messages at or above `maxHops` (default 6) never wake an agent; they are still shown on the next prompt. Delegated headless sessions cannot delegate again.

## Configuration

`~/.agent-bridge/config.json` (all keys optional; per-agent sections override the top level; env vars override both):

```json
{
  "autoWake": false,
  "maxHops": 6,
  "lingerSec": 300,
  "codex": { "name": "codex-main", "claudeBin": "claude", "claudePermissionMode": "default", "claudeModel": "opus" },
  "claude": { "delivery": "auto", "codexBin": "codex", "codexSandbox": "read-only", "codexModel": "gpt-6-sol" },
  "opencodeModel": "anthropic/claude-sonnet-5",
  "opencodeAutoApprove": false
}
```

| Env var | Meaning |
|---|---|
| `AGENT_BRIDGE_HOME` | Data directory (default `~/.agent-bridge`) |
| `AGENT_BRIDGE_NAME` | Peer name |
| `AGENT_BRIDGE_AUTO_WAKE` | `on` / `off` |
| `AGENT_BRIDGE_MAX_HOPS` | Loop limit |
| `AGENT_BRIDGE_LINGER_SEC` | Listen window after sending (0 disables) |
| `AGENT_BRIDGE_DELIVERY` | Claude only: `auto`, `channel`, `hooks` |
| `AGENT_BRIDGE_CLAUDE_BIN` / `AGENT_BRIDGE_CODEX_BIN` / `AGENT_BRIDGE_OPENCODE_BIN` | Paths of the CLIs used for delegation |
| `AGENT_BRIDGE_LOG_LEVEL` | File log level: `debug`, `info` (default), `warn`, `error`, `silent` |
| `AGENT_BRIDGE_LOG_CONSOLE` | stderr log level (default `warn`) |
| `AGENT_BRIDGE_PIPE` | Override the pipe / socket path |

Logs are written to `~/.agent-bridge/logs/agent-bridge.log`.

## CLI

The plugins bundle a small CLI for debugging:

```bash
node <plugin>/dist/cli.mjs ui              # web dashboard (sessions, runs, messages)
node <plugin>/dist/cli.mjs status          # broker, connected sessions, their versions (OUTDATED marks)
node <plugin>/dist/cli.mjs send codex "hi" # send as peer "cli"
node <plugin>/dist/cli.mjs tail            # print messages addressed to "cli"
node <plugin>/dist/cli.mjs paths
node <plugin>/dist/cli.mjs smoke           # check the installed CLIs still work with agent-bridge (a few tokens)
node <plugin>/dist/cli.mjs reliability     # measured run: answers, read-only, worktree edits, parallel, cancel, subagent features
```

`reliability` takes agent names (`claude codex opencode`, default all installed), `--only=core` (plain delegations) or `--only=live` (subagent features through the bundled MCP server: live messages to a running subagent, follow-ups with context, recovery after a restart, clean exit, Codex app-server approvals), and `--model=<agent>:<model>` per agent, e.g. `--model=claude:haiku`. It costs real tokens.

Run `smoke` after updating Claude Code, Codex or opencode. It exercises the real CLIs (answer, session id, resume) and warns when a CLI version differs from the one this release was tested with.

## Troubleshooting

- **Console windows flash on Windows while Codex works.** This happens when Codex runs your session inside its background app-server daemon: that process has no console, so Windows opens a new window for every `git` or `node` process it starts. Add `daemon_auto_start = false` under `[features]` in `~/.codex/config.toml`, run `codex app-server daemon stop`, and restart Codex.
- **Codex subagents misbehave after an update of Codex.** Since 0.11.0 agent-bridge runs Codex subagents through `codex app-server` (so they can receive messages while they work). Set `AGENT_BRIDGE_CODEX_EXEC=1` to go back to `codex exec`; subagents then only see messages after they finish. Codex versions without `app-server` fall back to `exec` automatically.
- **A peer shows up as plain `codex` with the plugin folder as its cwd.** Codex hasn't reported the project directory yet. It does so on the first hook or tool call; make sure the hooks are trusted in `/hooks`.
- **Messages to an idle agent are not answered.** An idle session only sees messages on its next prompt, unless it's in its listen window, auto-wake is on, or (for Claude) channels are enabled.
- **Claude shows "agent-bridge: listening for replies from peers" for minutes.** That was the listen window holding the turn open while background subagents ran (before 0.9.0). Update and restart the session: the turn now ends immediately and the session is woken when a result arrives.
- **A relay subagent (`agent-bridge:codex`, `agent-bridge:opencode`) does not answer status questions.** It is waiting for its one call and cannot reply until it returns. Call `peers` instead: it shows the delegation's runtime and current step.
- **A delegated task restarts from scratch.** That was the 15-minute limit before 0.5.2. Update, and restart the calling session.
- **"version mismatch" / a session cannot join.** Another session runs a different agent-bridge version. Update all tools and restart the sessions that `status` marks `OUTDATED`.
- **Codex update fails with "Access is denied".** Close all Codex sessions, then run `update codex` again.

## Security notes

- Only your own agent-bridge processes can join: every connection must present the secret in `~/.agent-bridge/token`, which is created on first use and is readable only by you on Unix. Delete the file to rotate it; all sessions then need a restart.
- The pipe and socket are local to your user account. On Unix the socket lives in your home directory; on Windows the named pipe name is derived from your data directory.
- Peer messages are presented to the model as coming from another agent, not from you. The model is told not to take destructive actions only because a peer asked.
- Delegated runs are read-only by default (see *Editing subagents*). Raise `access` only if you trust the task, and prefer `worktree: true` for edits.

## Development

```bash
npm install
npm run check   # typecheck + tests + build
```

`npm run build` bundles `src/` into `plugins/*/dist` (committed, so plugins work straight from git).

## License

MIT
