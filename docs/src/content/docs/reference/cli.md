---
title: "CLI reference"
---

Run the bundled CLI with `node <plugin>/dist/cli.mjs <command>` or use `npx -y github:rennerdo30/agent-bridge <command>`. The following public commands are registered in [src/cli/main.ts](https://github.com/rennerdo30/agent-bridge/blob/main/src/cli/main.ts).

| Command | Purpose and principal options |
| --- | --- |
| `install [claude codex opencode antigravity] [--yes]` | Show and apply installation plans for installed CLIs. |
| `update [agents] [--yes]` | Select immutable new runtimes while retaining old ones. |
| `uninstall [agents] [--yes]` | Archive owned plugin files; retain user data. |
| `status` | Broker, connected peers, versions and outdated sessions. |
| `ui [--port=N] [--no-open] [--reset-key]` | Open the current dashboard; reset-key invalidates old links and cookies. |
| `send <to> <text>` | Send as the `cli` peer. |
| `tail` | Listen for messages addressed to `cli`. |
| `watch [name]` | Follow the newest matching delegated run. |
| `paths` | Print bridge data, log, store and pipe paths. |
| `connect` | Interactive PC pairing wizard; unattended use requires `--non-interactive --yes` and either `--create` or `--address <host:port> --code <code>`. |
| `network` | Show pairing and discovery status. |
| `pair` | Create a one-time pairing code. |
| `link <host:port> <code>` | Pair with a PC using its code. |
| `unlink <instance-id>` | Revoke a paired instance. |
| `doctor [--json] [--backup \| --fix \| --archive \| --restore <backup>] [--yes]` | Inspect, back up and repair storage. Review the report before applying changes. |
| `reindex` | Rebuild the local history search index. |
| `slot acquire\|release\|renew <resource>` / `slot status` | Coordinate named shared resources. |
| `job-state <job>` | Inspect retained worktree state without modifying stores. |
| `job-close <job> [--yes \| --dry-run]` | Review or apply the configured finished-job close policy. |
| `close-idle-jobs [--yes \| --dry-run]` | Review or apply close policy to idle finished jobs. |
| `repair-permissions <folder> [--yes \| --dry-run]` | Inspect or repair permissions in an eligible managed worktree. |
| `cleanup [--dry-run] [--yes] [--all \| --repo <path>]` | List eligible merged, clean, finished worktrees; remove only with explicit `--yes`. |
| `smoke [agents]` | Exercise installed CLIs, session IDs and resume; spends tokens. |
| `reliability [agents] [--only=core\|live] [--model=<agent>:<model>]` | Exercise delegation and recovery against real CLIs; spends tokens. |
| `install-opencode` / `uninstall-opencode` | Legacy opencode-specific installation/removal entry points. |
| `help`, `--help`, `-h` | Print bundled help. |

`session-start-hook`, `rewake-hook`, `permission-hook`, `antigravity-hook` and `job-runner` are internal plugin entry points. They are not commands to invoke for ordinary use.

For lifecycle and containment details see [worktree lifecycle](../../worktree-lifecycle/), [storage](../../storage/) and [paired PCs](../../paired-pcs/).

The plugins bundle a small CLI for debugging:

```bash
node <plugin>/dist/cli.mjs ui              # web dashboard (sessions, runs, messages)
node <plugin>/dist/cli.mjs ui --reset-key  # explicitly replace the dashboard access key
node <plugin>/dist/cli.mjs status          # broker, connected sessions, their versions (OUTDATED marks)
node <plugin>/dist/cli.mjs send codex "hi" # send as peer "cli"
node <plugin>/dist/cli.mjs tail            # print messages addressed to "cli"
node <plugin>/dist/cli.mjs paths
node <plugin>/dist/cli.mjs cleanup         # list worktrees of finished jobs that are safe to delete; --yes deletes them
node <plugin>/dist/cli.mjs smoke           # check the installed CLIs still work with agent-bridge (a few tokens)
node <plugin>/dist/cli.mjs reliability     # measured run: answers, read-only, worktree edits, parallel, cancel, subagent features
```

Dashboard links use one long-lived key per agent-bridge home, stored in the owner-only
`dashboard-key` file. Restarts, broker handovers and updates preserve it, and browser cookies
last one year. The dashboard prefers its saved port; if another program takes that port,
it selects a fallback that later sessions discover and reuse. Run `/agent-bridge:dashboard`
or `agent-bridge ui` to open the current dashboard and restore the cookie automatically.
`ui --reset-key` deliberately invalidates old links and cookies; reopen the dashboard afterwards.

`reliability` takes agent names (`claude codex opencode`, default all installed), `--only=core` (plain delegations) or `--only=live` (subagent features through the bundled MCP server: live messages to a running subagent, follow-ups with context, recovery after a restart, clean exit, Codex app-server approvals), and `--model=<agent>:<model>` per agent, e.g. `--model=claude:haiku`. It costs real tokens.

Delegated jobs may read external Git-ignored `node_modules`, `.vs`, `__pycache__` and Unity `Library` caches (`Library` requires an adjacent `ProjectSettings/ProjectVersion.txt`). Source links, tracked caches and other external links remain forbidden. These are read-only **by policy**: junctions do not prevent writes. Never run Unity imports or package installation through a shared cache, change its permissions, or delete its contents. Prefer project cache-root settings such as `ANIMASKY_LIBRARY_ROOT` over links and never use a partial cache copy. The scanner reports eligible cache links separately; no cache is linked automatically.

`cleanup` looks at the job worktrees in `~/.agent-bridge/worktrees`. It removes a worktree and its `agent-bridge/<id>` branch only when its job is not running, the branch is fully merged into the branch it was based on (for older jobs: into any local branch) and nothing is uncommitted. Folders left over from earlier removals (no `.git`, nothing but empty folders and links) are removed too. Everything else is kept, and each line says why. Without `--yes` it is a dry run. Before deleting, it unlinks every symlink and junction inside the worktree (a linked Unity `Library`, for example) without following it, so their targets are never touched.

Run `smoke` after updating Claude Code, Codex or opencode. It exercises the real CLIs (answer, session id, resume) and warns when a CLI version differs from the one this release was tested with.
