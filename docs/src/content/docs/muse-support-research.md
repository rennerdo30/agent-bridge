---
title: "Muse support research"
slug: muse-support-research
---

Updated 2026-10-13 for the `feat/muse-support` implementation. This page records
the implemented behavior and the evidence supporting it. For installation and
settings, see [Muse configuration](../configuration/muse/).

## Implemented integration

Muse is the fifth coding agent. Every coding CLI can delegate to every coding
CLI, including itself, through the shared `ask_*` and `spawn_*` tools. Muse
uses the existing depth, slot, ownership, hop and durable-job guards.

Delegated jobs use stable MSP schema v1 over `muse serve` by default. Protocol
shapes are checked against the [official Muse SDK schema source](https://github.com/meta-models/muse-code-sdk/tree/main/schema/msp)
and [versioned 1.4 documentation](https://meta-models.github.io/muse-code-sdk/1.4/).
The bridge initializes with experimental APIs disabled, starts
or resumes a session, submits a turn and uses its terminal event to establish
the result. Native item events supply progress; effective model and effort
come from served state/events. Active jobs accept live steering through
`message_subagent`; finished jobs can resume their native session.

Read and ask jobs require the installed and approved Bridge PreToolUse hook.
It denies mutation tools for read access and requires approval for ask access,
including actions covered by native allow rules. MSP approval requests can
then be answered by the supervisor. Missing gates, unsupported interactions
or unavailable approval responders cannot approve an action. Edit access
retains native policy and its restrictions.

Named permission profiles are selected on session start and verified against
served state on start or resume, before any prompt is submitted. Missing or
mismatched profile state is a startup failure. Profiles do not replace Bridge
access enforcement. A resumed MSP session must retain the same verified
profile; a request for a different profile fails before turn submission.

The explicit `AGENT_BRIDGE_MUSE_EXEC=1` compatibility path uses
`muse exec --json`, prompt files and native session IDs. It does not provide
MSP steering, approval relay or served-profile verification, and ask access
behaves as read. Exec applies the profile through its native per-run flag. MSP failures
never trigger an automatic exec replay of a possibly submitted turn.

## Native sessions, models and history

The native plugin includes MCP, command hooks, a coordination skill and peer
commands. Muse's injected root/session identity binds the peer. Hook commands
authenticate to a local endpoint whose registration is bound to host and
server process creation identities. Native child hooks cannot consume root
mail or change root session/activity; the general MCP `hook_event` route is
disabled for Muse so it cannot override the native identity.
Native children use their root's shared MCP server. Their PreToolUse gate
denies Bridge tool calls so they cannot impersonate the root through those tools.

Muse sanitizes plugin subprocess environments. Delegated MCP and hook
processes restore only the owned Bridge context and selected CLI storage
paths from a private host registry. This preserves parent messaging and
delegation depth without publishing an independent top-level peer. Corrupt,
unsafe or stale process bindings do not authorize registration. Cleanup
retains a successor registration.

Root mail can be injected at UserPromptSubmit, PreLLMCall and PostToolUse.
Stop can continue a turn with eligible mail under the shared delivery policy.
This is active-turn delivery. **A native idle TUI has no confirmed Bridge wake
path**; its queued mail waits for another turn or `inbox`.

`model/list` provides model IDs, defaults and effort variants without creating
a session or starting a model turn. Empty or failed catalog reads mean
unknown availability. Explicit IDs still resolve through Muse. Session usage
does not prove account limits, so the bridge does not invent account quota
percentages or reset times.

Transcript display and history search read native
`sessions/YYYY/MM/DD/<session-id>/session.jsonl` logs. The adapter unwraps
retained transaction frames, preserves record identities, paginates by byte
cursor and follows explicit child-session bindings. Discovery uses the actual
session folder ID, keeping multiple conversations on the same day distinct.
Native logs also feed durable conversation ingestion and history.

## Evidence and remaining acceptance

The earlier research recorded Muse 1.4.7 CLI-help, plugin-validation and
deterministic echo-provider probes. Those observations support the native
bundle format and exec record shapes; they do not establish live acceptance
of the newer MSP or hook integration.

Current evidence consists of SDK/documentation review, source checks,
protocol fixtures and actual subprocess tests with fake Muse hosts. Tests do
not call model providers. They cover:

- MSP initialization, command/session identity, early events, terminal
  outcomes, steering, approvals, cancellation and owned-process cleanup.
- Named-profile verification and refusal before turn submission when served
  state does not establish the requested profile.
- Sanitized delegated MCP bootstrap, parent messaging, depth limits and
  exclusion from top-level peers.
- Native mail injection, child/session spoof isolation, endpoint auth,
  process bindings and read/ask gate behavior.
- Retained-frame transcripts, duplicate record identities, paging, native
  child access, same-day search links and packed-run classification.

Two defects exposed by native tests were repaired: an old context cleanup
could delete a successor registration for the same live host, and a supplied
MCP hook session ID could change root identity/activity. Regression tests
retain both cases.

No live Muse binary/provider acceptance was established in the current cloud
validation. Remaining checks on a machine with authenticated Muse include
plugin install/approval, active native hook delivery, real-provider two-turn
continuation, effective model/effort and profile reporting, and read/ask
approval behavior. `smoke muse` checks initial and resumed provider turns;
it does not replace native-hook acceptance or prove native idle wake. Do not treat
protocol or fake-host success as that live acceptance.
