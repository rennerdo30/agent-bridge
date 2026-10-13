---
title: "Muse"
---

```bash
npx -y github:rennerdo30/agent-bridge install muse --yes
# Later:
npx -y github:rennerdo30/agent-bridge update muse --yes
```

Requires an installed, authenticated `muse`. The integration uses stable MSP
schema v1, with protocol shapes checked against the Muse SDK 1.4.7 source.
The installer runs Muse's plugin manager (`muse plugins install`, followed by
`muse plugins approve agent-bridge`) and shows both steps before running them.
Start a new Muse session after installation and capability approval. The bundle
includes the bridge MCP server, native delivery and permission hooks, a
coordination skill and peer commands. Uninstall runs
`muse plugins remove agent-bridge`.

## Sessions and delegation

Muse exposes the shared peer, delegation, history and job tools. Every coding
agent, including Muse itself, can call `ask_muse` and `spawn_muse`. Jobs accept
`model`, `effort`, `session_id`, `access`, `permission_profile` and `worktree`.
The accepted effort vocabulary is
`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`ultra`; individual models
may support a subset. Configure `museBin` or `AGENT_BRIDGE_MUSE_BIN` to select
the executable, and `museModel` to select a default model.

Delegation uses `muse serve` and the stable Muse Session Protocol (MSP) by
default. It starts or resumes the requested session, reports native job steps
and effective model/effort, and waits for the submitted turn's terminal result.
An accepted command does not establish a completed job. `message_subagent`
steers a running turn or resumes a finished job; `cancel_subagent` cancels the
job through the existing lifecycle. Progress and ETA use the shared dashboard
and progress-report tools.

`list_models(agent="muse")` queries MSP `model/list` without creating a
session or submitting a turn. It displays the returned model IDs, defaults and
effort variants. An empty or unavailable catalog leaves availability unknown;
an explicit model ID still goes to Muse for resolution.

## Access and permission profiles

| Access | Behavior |
| --- | --- |
| `read` (default) | The approved native Bridge PreToolUse hook denies mutation tools and external MCP actions. Reading tools and the permitted Bridge routes remain available. |
| `ask` | The native hook requires approval for mutation tools even when a native allow rule would otherwise permit them. MSP approval requests are forwarded to the supervisor; an unavailable supervisor or gate cannot approve the action. |
| `edit` | Retains native policy. Workspace file approvals can be accepted within the job's writable roots; other surfaced requests need an available supervisor and remain subject to native restrictions. |

Read and ask jobs require an enabled Bridge permission hook before the first
turn is submitted. Install and approve the native plugin before using those
jobs. A named `permission_profile` selects Muse's native policy independently
of Bridge access. The bridge checks the served profile on session start or
resume, querying session state if needed. A missing or mismatched profile
stops startup before any prompt is submitted. It does not silently replace
the profile with a different approval mode.
A resumed MSP session must already have the requested profile; choosing a
different profile fails before the turn. Start a new job to select a new profile.

## Native mail and history

Muse's injected `MUSE_SESSION_ID` binds the registered peer to the native root
session. Authenticated command hooks inject mail at UserPromptSubmit,
PreLLMCall and PostToolUse, and may continue a stopping turn when mail is
eligible for delivery. Native child hooks cannot consume the root inbox or
change root session/activity. Native children share the root's MCP server;
their PreToolUse gate denies Bridge tool calls to prevent root impersonation.
Delegated plugin processes recover only their
owned Bridge parent/depth context from a private process-identity registry and
stay out of top-level peer registration.

**Native idle-TUI wake is not confirmed.** Mail for an already idle Muse TUI
waits for the next turn or an explicit `inbox` call. Active hook delivery and
MSP steering of a running delegated turn do not establish idle native wake.

Native chat and search read Muse session logs under
`$XDG_DATA_HOME/muse/sessions` (normally `~/.local/share/muse/sessions`), including
retained frames and explicit native child-session links, without changing the
logs. Native logs also feed durable conversation history. Session folder IDs
keep same-day conversations distinct. Muse's session
usage does not establish account quotas: `usage_limits` reports account limit
availability as unknown.

## Exec compatibility and validation

Set `AGENT_BRIDGE_MUSE_EXEC=1` in the supervising Bridge environment to opt
into the older `muse exec --json` path. Prompts use a temporary file;
`session_id` resumes the native session. This path has no MSP live steering or
approval relay: `ask` behaves as `read`, while `edit` disables approval prompts
unless a named profile owns the native approval settings. The bridge never
automatically retries a possibly started MSP turn through exec.
Exec applies a named profile through the native per-run flag; it does not
provide MSP's served-profile verification.

Protocol fixtures and actual subprocess tests verify the bridge behavior above
without model-provider calls. They do not establish acceptance in a live Muse
TUI or a real provider session. The remaining live checks include installation
and trust, active native mail delivery, two-turn provider continuation,
permission/profile behavior and model catalog output. See the
[implementation evidence](../../muse-support-research/).
