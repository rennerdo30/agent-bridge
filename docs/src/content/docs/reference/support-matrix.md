---
title: CLI support matrix
description: Which agent-bridge features each coding CLI supports, with the exact limits.
---

This table describes **agent-bridge 0.30.17**, plus the unreleased Muse column. ✅ supported · ⚠️ partial (see footnotes) · ❌ not supported. Delegation rows describe the CLI running the job; “delegate from” describes the supervising session. Muse behavior is covered by protocol fixtures and subprocess tests; live Muse binary/provider acceptance remains pending.

| Feature | Claude Code | Codex | opencode | Antigravity | Muse |
| --- | --- | --- | --- | --- | --- |
| Session connection, peers, send/receive | ✅ | ✅ | ✅ | ✅ | ✅ |
| Messages while busy (hooks / next tool or model step) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Idle message delivery / auto-wake | ⚠️[^claude-wake] | ⚠️[^codex-wake] | ✅ | ⚠️[^antigravity-wake] | ⚠️[^muse-wake] |
| Delegate **to** (`spawn` target) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Delegate **from** (all five targets, including itself) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Follow-ups / resume (`message_subagent`) | ✅ | ✅ | ✅ | ✅ | ✅[^muse-msp] |
| Jobs in isolated git worktrees | ✅ | ✅ | ✅ | ✅ | ✅ |
| Live job steps, progress and ETA | ✅ | ✅ | ✅ | ✅ | ✅[^muse-msp] |
| Job model and effort selection | ✅ | ✅ | ⚠️[^opencode-models] | ✅ | ✅ |
| `list_models` for this CLI | ⚠️[^claude-models] | ✅ | ⚠️[^opencode-models] | ✅ | ✅[^muse-models] |
| Job access: `read` / `ask` / `edit` | ⚠️[^claude-permissions] | ⚠️[^codex-permissions] | ✅ | ✅ | ✅[^muse-permissions] |
| Job approval relay to supervisor | ⚠️[^claude-permissions] | ⚠️[^codex-permissions] | ⚠️[^opencode-permissions] | ✅[^antigravity-permissions] | ⚠️[^muse-permissions] |
| Native job approval / sandbox options | ✅ `permission_mode` | ⚠️ `sandbox`, `approvals_reviewer`[^codex-permissions] | ✅ `auto_approve` | ✅ `terminal_sandbox`, `bypass_permissions` | ✅ `permission_profile`[^muse-permissions] |
| Nested bridge subagents (depth limit) | ✅ | ✅ | ⚠️[^nested-opencode] | ✅ | ✅ |
| Scoped native child bridge addresses | ⚠️[^native-addresses] | ❌ | ❌ | ❌ | ❌ |
| Native children excluded from top-level registration | ✅ | ✅ | ✅ | ⚠️[^native-isolation] | ✅[^muse-native] |
| `usage_limits` for this CLI | ✅ | ✅ | ⚠️[^usage] | ✅[^antigravity-usage] | ⚠️[^muse-usage] |
| Native transcript ingestion and `search_history` | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dashboard native chat and child transcripts | ✅ | ✅ | ✅ | ✅ | ✅ |
| Owner questions (`ask_owner`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pinned decisions (`decisions`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project main / secondary roles | ✅ | ✅ | ✅ | ✅ | ✅ |
| Paired-PC messaging | ✅ | ✅ | ✅ | ✅ | ✅ |
| Jobs on a paired PC | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mobile app session / job visibility | ⚠️[^mobile] | ⚠️[^mobile] | ⚠️[^mobile] | ⚠️[^mobile] | ⚠️[^mobile] |
| `install` / `update` setup | ✅ Marketplace plugin[^install] | ✅ Marketplace plugin[^install] | ✅ Native plugin[^install] | ✅ Native plugin[^install] | ✅ Native plugin[^muse-install] |

Nested bridge delegation defaults to depth **2**, configurable up to **3**; depth, slot, ownership and hop guards apply to every CLI. Owner questions, decisions and project roles belong to top-level project sessions; delegated jobs use their supervisor. Jobs without `allow_tools` may use Pair Desk worker tools (reads, comments, progress, plans, steps, edit issues; creating issues and status, build or handoff writes are not included) without asking, in every access mode including read and ask; change or clear this with `jobs.defaultAllowTools` in the home config, or per job with `allow_tools` (a list replaces it, `[]` turns it off). Transcript views and search require the CLI's local transcript files or database. Paired-PC jobs require an enabled remote-job policy, an allowed agent and an absolute working directory within the receiving PC's allowed roots.

[^claude-wake]: Idle delivery uses a channel when enabled, the wake module on Claude Code 2.1.287+, or the host's `asyncRewake` Stop hooks. It depends on an available wake transport and the session's wake settings; otherwise mail stays queued for a later prompt or inbox.
[^codex-wake]: Requires a known main-thread ID, native `codex queue` support and a TUI consuming that queue. Queue acceptance does not confirm a started turn or read mail. Trust the bridge hooks in `/hooks` for automatic injection.
[^antigravity-wake]: Active `PreInvocation` / Stop hooks deliver mail (retaining unread mail if a Stop continuation hits the native cap), but an already idle TUI cannot be woken. Queued mail arrives on the next turn or through inbox.
[^claude-models]: Returns native help's model aliases and effort levels, with alias fallbacks; Claude Code has no full model-catalog query here.
[^opencode-models]: The catalog is a non-exhaustive provider/model list and can be empty; explicit IDs still resolve at startup. Effort is a provider-specific variant. OpenCode 2 requires an explicit model when selecting effort.
[^claude-permissions]: `access: "ask"` stays read-only, like `read`: allowed native edits cannot reliably be intercepted. In editable modes, actual native permission prompts can be relayed through a PermissionRequest hook (Claude Code 2.1.268+, bundled hook and a launch without a shell); native allow/deny rules run first.
[^codex-permissions]: Access maps to Codex's sandbox. In app-server jobs, `approvals_reviewer` defaults to `auto_review`; choose `user` for forwarded native requests. Automatic review refusals can be escalated for a supervised retry without overriding sandbox policy. Full-access jobs and the `codex exec` fallback fix the reviewer to `user`. The exec fallback needs a trusted PermissionRequest hook for `ask`; without it, `access: "ask"` stays read-only.
[^opencode-permissions]: `access: "ask"`, and eligible `edit` runs, relay native permission events through a private served session. Plain headless runs reject requests or auto-approve with `auto_approve=true`; those requests are not relayed.
[^antigravity-permissions]: `access: "ask"` relays every non-reading tool through the installed PreToolUse gate. `edit` delegates workspace reads/writes (and pathless reading tools) to native policy—which still enforces native Ask/deny rules and soft-denies headless prompts—while relaying outside-workspace file actions, commands and external tools to the supervisor (`auto_approve`, preserving explicit native deny rules). `bypass_permissions` explicitly overrides the read/ask/edit access policy; `terminal_sandbox` is separate.
[^nested-opencode]: Read-only opencode jobs' tool allowlist enables delegation to the other four CLIs, including Muse, but omits opencode self-delegation, `list_models` and `decide`. Top-level opencode sessions expose all five targets.
[^native-addresses]: Claude only: a live native child gets `<parent>/sub:<agent_id>` on its registered parent's connection. It may use only `peers`, `inbox` and `send`, with explicit child identity, ownership and hop limits; recipients are its parent, the parent's owned jobs and exact local recipient grants. No independent registration, delegation, broadcast or remote address; remaining mail returns to the parent when the child ends.
[^native-isolation]: Antigravity ignores hooks for a child conversation on the parent's shared server. It has no equivalent MCP caller-lineage admission check, so separate child-server registration is not established by this implementation.
[^usage]: opencode reports today's spend/tokens and free-model information, not remaining provider quotas.
[^antigravity-usage]: Reads structured model quota buckets and reset times from `agy -p /usage --output-format json` (requires `agy` 1.1.11+; older versions report unknown without starting a model turn).
[^remote-antigravity]: Paired jobs accept `terminal_sandbox` and `bypass_permissions`, preserve explicit false settings on continuation, and reject these options for other agents before launch.
[^mobile]: With the mobile gateway enabled and a phone paired, each enrolled PC exposes local registered sessions and retained jobs, with chats/steps where available. Paired-PC peer projections are excluded and native child hierarchy is not projected.
[^install]: `npx -y github:rennerdo30/agent-bridge install` sets up detected CLIs; `update` publishes their next runtime while retaining old versions. Claude gets MCP/channel support, hooks, the wake module, skills, commands and agent definitions. Codex gets MCP, skills and hooks (trust them in `/hooks`). opencode gets the native plugin with `bridge_*` tools, its runtime, skill and agent definitions for both plugin API generations. Antigravity gets the native plugin, MCP configuration, skill, delivery/permission hooks and a bridge MCP grant. Running integrations adopt updates on reload or restart; an existing broker keeps its version until its host closes or reloads.
[^muse-wake]: Native command hooks deliver active-turn mail and can continue a stopping turn. Native idle-TUI wake is not confirmed; queued mail waits for another turn or inbox.
[^muse-msp]: Stable MSP v1 over `muse serve` is the default job transport, including live steering and native item progress. `AGENT_BRIDGE_MUSE_EXEC=1` explicitly selects the exec compatibility path without MSP steering/approval relay. A failed MSP turn is never automatically replayed through exec. Resumed profile selection opts into the experimental, Muse-version-dependent `session/setPermissionProfile` only after initialize negotiates it, and verifies the resulting profile before a turn. Unsupported or rejected changes fail closed; diagnostics pin SDK 1.4.7 and report the served version/capability. Other jobs keep experimental APIs disabled.
[^muse-models]: MSP `model/list` reports catalog IDs, defaults and effort variants without starting a session/turn. Empty or failed catalog reads mean unknown availability; explicit IDs still go to Muse for resolution.
[^muse-permissions]: MSP jobs require an enabled, approved native Bridge permission hook before turn submission, including edit jobs where it isolates native children. Read denies mutations; ask forwards mutation approvals even under native allow rules. An unavailable gate/supervisor cannot approve them. Edit retains native policy. Named profiles must match served session state before any turn. In explicit exec compatibility mode, ask behaves as read.
[^muse-native]: Native children share their root's MCP server. Their PreToolUse gate denies Bridge tool calls to prevent root impersonation, and their delivery hooks cannot consume root mail or change root identity/activity. Sanitized delegated MCP processes restore owned parent/depth context and publish no top-level peer. Muse has no separate scoped native child Bridge address.
[^muse-usage]: MSP session usage does not establish account quotas. Account limit availability is reported as unknown, without invented quota percentages or reset times.
[^muse-install]: Uses Muse's native plugin manager and explicit capability approval on install. Update inspects changes; renewed capability approval requires separate review. The bundle includes MCP, command hooks, a coordination skill and peer commands. See [Muse configuration](../../configuration/muse/) for requirements and remaining live acceptance checks.

