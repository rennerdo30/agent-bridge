---
title: "Muse support research"
slug: muse-support-research
---

Verified 2026-10-13 against the local agent-bridge tree (0.30.1) and the
installed Muse Code **1.4.7** (`muse --version`). All Muse facts below come
from local command probes (`--help` output, `muse plugins validate --json`,
and `muse exec --provider echo --json` runs), not from documentation guesses.

**Status: implemented on the `feat/muse-support` branch** — headless
delegation, the native plugin and installer, transcripts and history, and
dashboard labels. Unit tests mock the CLI and make no paid API calls; the
`smoke muse` two-turn check against the real provider is the remaining live
gate. Known subsets are listed under "Open questions and risks".

## Verdict

Muse joins agent-bridge as a fifth coding agent (`muse`, tools
`ask_muse` / `spawn_muse`, peers named `muse-<folder>`) following the exact
path Antigravity took. The headless half is low-risk and verified. The
live-session half works through Muse's native plugin and MCP support;
whether a Muse session can be woken by peer mail depends on one remaining
spike: what Muse plugin hooks receive and may return. Until then, like
Antigravity's idle TUI, an idle Muse session reads mail at its next turn.

## How agent-bridge adds an agent today

Antigravity was the last agent added, and its touchpoints are the template.
One central entry per subsystem means most wiring is compile-forced (adding
`"muse"` to the `CodingAgent` union makes TypeScript list the rest):

| Subsystem | Template location | What a `muse` entry needs |
| --- | --- | --- |
| Agent registry | `src/core/protocol.ts:21` (`AgentKind`, `CODING_AGENTS`) | Add `"muse"` to both |
| Binary/model config | `src/core/config.ts:58` (`BridgeConfig`), `src/core/constants.ts:92` (`DEFAULT_*_BIN`) | `museBin` (env `AGENT_BRIDGE_MUSE_BIN`), `museModel`, defaults + `loadConfig` picks |
| Headless runner | `src/core/antigravity.ts` (separate file per newer agent) | New `src/core/muse.ts`: `delegateToMuse()` + `parseMuseJsonl()` over the shared `runProcess` in `src/core/delegate.ts:243` |
| Delegation target | `src/mcp/targets.ts:97` (`DELEGATION_TARGETS`) | One entry: title, model/effort examples, `defaultModel`, permission mapping, `run`. This auto-creates `ask_muse`/`spawn_muse` (`src/mcp/server.ts:1148`) |
| Model listing | `src/core/models.ts:88` (`describeModels`) | A `muse` branch like Claude's: Muse cannot list models (see below) |
| Default effort display | `src/core/effort.ts:13` | Return `null` until Muse's settings key for effort is known |
| Usage limits | `src/core/usage.ts:254` | Antigravity-style "unknown, no machine-readable quota command" branch |
| Live peer identity | `src/mcp/server.ts:232` (`parseAgentKind`), `src/mcp/launcher.ts:6`, `src/core/plugin-runtime.ts:6` (`PluginClient`) | Add `"muse"` so the MCP server started by Muse registers as agent `muse` |
| Installer | `src/cli/installer.ts:18` (`TOOLS`, `planFor`) | Add `"muse"` plus a plan; detection is the existing `resolveBinary("muse")` check at `installer.ts:110` |
| Build | `scripts/build.mjs:9` (`PLUGIN_DIRS`, `MANIFESTS`) | Add `plugins/muse`; every plugin dir gets the same bundled `dist/server.mjs`, `worker.mjs`, `cli.mjs` |
| Smoke test | `src/cli/smoke.ts:40` | Add `muse` to the bin record and delegate branch; `smoke muse` then exercises the real adapter twice (answer + resumed answer), as it does for Antigravity |
| Transcripts/history | `src/core/transcripts/index.ts:15`, `src/core/history.ts:41` | Optional parity phase: a `muse` transcript adapter and history discovery root |

Peer messaging itself needs no per-agent work: once the MCP server runs
inside a Muse session with `--agent=muse`, `send` / `inbox` /
`wait_for_message` / `peers` work through the broker unchanged.

## Muse surfaces, verified

### Headless delegation (`muse exec`)

`muse exec --json "prompt"` runs one prompt non-interactively and streams
the session log as JSONL on stdout. Verified with `--provider echo`:

- Every record is `{schema_version: 1, stream: {kind: "session", id}, sequence, payload_type, payload}`.
  `stream.id` is the session id (the bridge's `sessionId`).
- Text arrives as `payload_type: "run.output.delta"` (`payload.text`).
- The final answer is `payload_type: "run.terminal.completed"` with
  `payload: {kind: "run_terminal", terminal: "completed", text}`. Failures
  surface as `task.lifecycle.failed` records with `event.reason`, and the
  process exit code was 0 even for the echo provider's internal failures —
  so, like Antigravity's SUCCESS check, the parser must trust the terminal
  record, not the exit code alone.
- `--session-id <uuid>` pins/reuses the session id across runs (verified:
  two runs shared the stream id). Whether the second run keeps the first
  run's context must be confirmed with the real provider by the `smoke`
  command's two-turn check; the id contract the bridge needs is verified.
- Flags the bridge maps onto: `--model <id>`, `--reasoning-effort`
  (alias `--effort`; `none|minimal|low|medium|high|xhigh|max|ultra`),
  `--workspace <path>`, `--prompt-file <path>`,
  `--approval-mode untrusted|on-request|never`, `--disable-write`,
  `--disable-shell`, `--disable-approval`, `--user-input-auto-resolve`,
  `-w/--worktree` (not used: the bridge owns worktree creation itself).

Two consequences for `delegateToMuse`:

1. **The prompt cannot go on stdin.** Existing delegates pass the prompt via
   `runProcess` stdin; Muse takes it as a positional argument or
   `--prompt-file`, and stdin is reserved for `--api-key-stdin`. Passing
   user text as an argument would also break the Windows shim safety rule
   in `delegate.ts:239`. Use `--prompt-file` with a bridge-owned temp file.
2. **Read access is enforceable natively.** `read` maps to
   `--disable-write --disable-shell`; that is stronger than opencode's
   config-layer deny and needs no hook gate. The `edit`/`ask` mapping
   (which approval mode, and whether approvals can be relayed to the
   parent like Claude's PermissionRequest hook) needs one live probe with
   the real provider before it is promised; until then `ask` should behave
   as `read`, matching `supportsAsk` returning `false` for Claude in
   `src/mcp/targets.ts:77`.

### Models

There is no model-list command. `muse model-profile show <model>` resolves
one known model per effort tier, so `list_models(agent="muse")` follows the
Claude branch in `models.ts:103`: it cannot enumerate, any model id is
passed through verbatim, and examples can name `muse-spark-1.3` (the id
shape `model-profile --help` itself uses).

### Sessions and transcripts

Interactive sessions persist under
`~/.local/share/muse/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl`
(plus `session-index.db` in `~/.local/share/muse`). On-disk lines wrap
records: a line may be a `retained_frame` whose `children[].record_json`
holds the same record JSON that `muse exec --json` prints bare. A
transcript adapter (`src/core/transcripts/muse.ts`) therefore unwraps
frames, then reuses the shared JSONL paging in
`src/core/transcripts/common.ts:92`. `muse export --session <id>` also
produces a self-contained JSON document, but the bridge reads native logs
for every other agent and should do the same here. This is parity work,
not a prerequisite for delegation or peer messaging.

### Plugins, MCP, hooks, skills

Muse has a native plugin system, and this is the live-session path:

- A native bundle keeps its manifest at `.muse-plugin/plugin.json` with
  `schemaVersion: 1`, `compat: {source: "native", manifestDir:
  ".muse-plugin"}`, and `capabilities` holding **arrays of objects** for
  exactly five families: `skills` (`{id, path, enabledDefault?}`),
  `commands` (`{id, path}`), `hooks` (`{id, event, command: [argv...],
  timeoutMs?}`), `mcpServers` (`{id, transport: "stdio", command:
  [argv...]}` or HTTP `{id, transport: "http", url}`), and `reminders`.
  A minimal manifest in this shape validates clean
  (`muse plugins validate <dir> --json` → `valid: true`, no diagnostics).
- Muse also imports foreign bundles (a nested `.claude-plugin/` or
  `.codex-plugin/plugin.json`), but the existing Claude bundle does **not**
  pass: the validator rejects its `mcp_tool` hook handlers and `channels`
  field. A native `plugins/muse/` bundle is required; it cannot be a copy
  of `plugins/claude/`.
- The MCP entry gives the live session its bridge tools:
  `command: ["node", "dist/server.mjs", "--agent=muse"]`, mirroring how
  every other bundle starts the same bundled server. How Muse resolves
  relative argv paths inside an installed (cached) bundle, and whether
  `node` is found as-is on Windows, is part of the install spike below.
- User MCP config also exists (`mcpServers` in
  `~/.config/muse/settings.json`, per `muse mcp login --help`), so a
  plugin-free fallback install (write one `mcpServers` entry, like
  Antigravity's settings grant) is possible if the plugin route stalls.
- Skills are the same `SKILL.md` shape the bridge already ships
  (`muse skills validate <dir> --json` exists), so
  `plugins/muse/skills/agent-bridge/SKILL.md` adapts the Antigravity one.
- Hook events, payloads and return values are **not yet probed**. The
  validator names the capability shape but not the event enum, and
  `muse plugins hook test <plugin>:<hook> --fixture <path>` can run one
  installed hook against a fixture. Until a SessionStart/Stop-class hook
  is shown to inject context, Muse must be treated like Antigravity:
  `setWakePolicy` in `src/mcp/server.ts:295` must not advertise wake for
  `muse`, and mail waits for the next turn or an explicit `inbox` call.
  Muse's native `session-message` command is its own cross-session
  channel and is not used; the bridge broker stays the transport.

### Install and update

`muse plugins install <path>`, `muse plugins update <id>`,
`muse plugins approve <capability>` (trust), `muse plugins list --json`
and `muse plugins marketplace add <name> <source>` all exist. The
installer plan for `muse` should therefore mirror Antigravity's custom
step (`installer.ts:27`): resolve the bundled `plugins/muse` source with
`pluginSourceDir`, run `muse plugins install <source>`, then surface the
`approve` step in the printed plan — never silently. Update maps to
`muse plugins update agent-bridge` plus the existing live-runtime
reporting. Detection is free: the installer already skips tools whose
binary `resolveBinary` cannot find.

## Implementation plan

### Phase 1 — headless Muse (no plugin)

Enough for every other agent to call `ask_muse` / `spawn_muse`:

1. `src/core/protocol.ts`: add `"muse"` to `AgentKind` / `CODING_AGENTS`.
2. `src/core/constants.ts`, `src/core/config.ts`: `DEFAULT_MUSE_BIN`,
   `ENV.museBin`, `museBin` / `museModel` config with defaults.
3. New `src/core/muse.ts`: `delegateToMuse()` (prompt via `--prompt-file`,
   `--json` stream, `--session-id` resume, model/effort flags, read =
   `--disable-write --disable-shell`) and `parseMuseJsonl()` (session id
   from `stream.id`, final text from `run.terminal.completed`, error from
   `task.lifecycle.failed`/non-completed terminal), following
   `parseAntigravityJsonl` in `src/core/antigravity.ts:11`.
4. `src/mcp/targets.ts`: the `muse` target entry; `supportsAsk` stays
   `false` for it in phase 1.
5. `src/core/models.ts`: the cannot-list branch; `src/core/effort.ts`:
   `null`; `src/core/usage.ts`: unknown-limits branch.
6. `src/cli/smoke.ts`: bin + delegate branch, then `smoke muse` against
   the real provider proves flags, parsing and `--session-id` continuation.
7. Tests: `test/muse.test.ts` with captured `--provider echo --json`
   fixtures for the parser (terminal success, lifecycle failure, deltas
   before terminal, pinned session id) and argument construction with a
   fake `muse` binary, following the existing delegate test patterns.
   No test may call the real provider.

### Phase 2 — Muse as a live peer

1. New `plugins/muse/`: `.muse-plugin/plugin.json` (native manifest:
   one `mcpServers` entry `bridge`, the `agent-bridge` skill, optionally
   the peer commands), `skills/agent-bridge/SKILL.md`, and the `dist/`
   bundles `scripts/build.mjs` already produces for every plugin dir.
2. `scripts/build.mjs`: add `plugins/muse` to `PLUGIN_DIRS` and its
   manifest to `MANIFESTS` (the native manifest's `version` field syncs
   like the others).
3. `src/mcp/launcher.ts`, `src/core/plugin-runtime.ts`: add `"muse"` to
   the client unions so runtime version selection works.
4. `src/cli/installer.ts`: `TOOLS` + a `muse` step kind handled like
   Antigravity's, running `muse plugins install`/`update` and printing
   the `approve` trust step.
5. Spike, in order: (a) install a throwaway bundle whose MCP server is the
   real `dist/server.mjs --agent=muse` and confirm a Muse session lists
   the bridge tools and appears in `peers` as `muse-<folder>`;
   (b) probe hook events with `muse plugins hook test` and a logging
   hook to learn payloads and whether a hook can inject mail or start a
   turn; (c) only then decide the wake story and whether a
   `src/cli/muse-hook.ts` (modelled on `antigravity-hook.ts`) is needed.
6. Tests: installer plan tests for the new step kind, manifest validation
   in CI via `muse plugins validate` where the binary exists (skipped
   otherwise), and an e2e peer test with a fake MCP host if the existing
   harness allows.

### Phase 3 — parity

1. `src/core/transcripts/muse.ts` + registration in
   `transcripts/index.ts` and `src/core/history.ts` (discovery root
   `~/.local/share/muse/sessions`, session id = folder name), so Muse
   sessions appear in history search and the dashboard with native
   subagent links where the log records them.
2. Approval relay for delegated runs, if the phase 1 probe shows an
   approval mode that can be answered externally; otherwise document
   `ask` = `read` for Muse permanently.
3. Consider `muse serve` (MSP session host over stdio) as a richer
   delegation transport — steering and approvals over the wire, the role
   Codex's app-server plays — only if `muse exec` proves limiting.
4. Docs: README headline, `configuration/muse.md` modelled on
   `configuration/antigravity.md`, install page tool list; the tools
   reference picks up `ask_muse` / `spawn_muse` automatically.

## Open questions and risks

- **Hook semantics are the one unknown that changes the design.** Event
  names, stdin/argv payload, and whether output can inject context or
  trigger a turn are unprobed. Phase 2 is planned so this only affects
  wake, never basic peer messaging.
- **Edit-mode approvals in headless runs.** `--approval-mode never`,
  `on-request` with nobody to answer, and `--disable-approval` differ in
  ways only a real-provider probe can settle. Phase 1 ships `read`
  enforcement and treats `ask` as `read`.
- **Plugin trust.** `muse plugins approve` gates capabilities; the
  installer must show it as an explicit step, and a session started
  before approval will not have the bridge tools.
- **Relative MCP argv in an installed bundle.** The validator requires
  referenced files to exist under the plugin root, but how the cached
  install resolves `node` and relative paths on Windows needs the
  phase 2 spike, not an assumption.
- **Echo-provider limits.** Every verified Muse fact comes from the
  deterministic echo provider or `--help`; it proves framing, ids and
  flags, not model behaviour, context continuity, or quota reporting.
  The `smoke muse` run is the gate for those.
