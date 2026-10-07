---
title: "Delegated Codex access and worktree isolation"
---

## Full access and approvals (AB-60)

The app-server runner previously selected `on-request` for every sandbox and declined command/file
approval callbacks for every non-ask job. The reported run on 2026-10-06 recorded
`permission: danger-full-access`, `access: default`, and the bridge's own denial message. This was
not a filesystem denial or an automatic reviewer verdict. Commit `ae82d9b` changed the common
thread policy from `never` to `on-request` to relay approvals, while gating command/file approvals
on ask mode. That combination incorrectly included full-access jobs. The recent denial-reason
change in `5620c15` exposed that refusal to the job. Commit `ad51b90` made turn sandbox policies
explicit, but its full-access mapping is correctly `dangerFullAccess`; the refusal was in approval
routing rather than a downgrade of the sandbox.

Full-access threads and turns now use a granular policy: sandbox and rule approvals are disabled,
MCP elicitations remain enabled. The installed app-server requires `experimentalApi: true` for this
policy. Legacy command/file callbacks are accepted for full access. The exec fallback explicitly
sets `approval_policy="never"` and `approvals_reviewer="user"`, overriding inherited auto-review.
Command/edit callbacks are forwarded when a supervisor is available, including read-only escalations
and cleanup requests. Without supervision, read-only callbacks are declined with an explicit reason.

The protocol was checked against the installed `codex app-server generate-json-schema` output and
the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). A direct local
app-server smoke accepted the granular thread policy and ran a hidden, immediately exiting
`Start-Process` command under `dangerFullAccess` with exit code 0. No model inference was needed.

## Automatic approval review (AB-92)

Research on 2026-10-06 used `codex --version` (`codex-cli 0.160.1`) and
`codex app-server generate-json-schema --out <temporary-directory>`, also checking the experimental
schema. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review), and
[changelog](https://learn.chatgpt.com/docs/changelog) establish the feature and current release.

- Native Codex config: `approvals_reviewer = "auto_review"` or `"user"`.
- App-server: `approvalsReviewer` on `thread/start`, `thread/resume`, and `turn/start`.
  The schema also accepts the legacy `guardian_subagent` alias; the bridge exposes the canonical values.
- Bridge config: `codexApprovalsReviewer`, default `"auto_review"`, with normal per-agent overrides.
- Job override: `approvals_reviewer` on ask/spawn and `message_subagent`. It persists independently of
  `access` and `sandbox`; a running turn keeps its current reviewer. Remote spawn accepts it too.
- Non-full-access approval policy remains `on-request`. Automatic review applies only to eligible
  approval requests, including command, file, blocked network, MCP, and permission requests. Routine
  sandboxed actions continue without review. Codex's managed requirements and protected paths still apply.
- `read-only` and `workspace-write` keep their configured roots and network limits. An eligible
  escalation can be approved by the reviewer, so `read-only` describes the initial sandbox boundary,
  not a guarantee that an authorized escalation can never write. For direct supervision use `user`.
- Full access retains the AB-60 granular policy and `user` reviewer: no command/edit review or prompts;
  existing MCP elicitation checks remain. The bridge never writes the owner's Codex configuration.

Codex's risk-based reviewer can approve authorized, bounded actions. Its documented policy blocks
secret exfiltration, credential probing, broad security weakening, and destructive operations with
significant irreversible risk. Local `auto_review.policy` / `auto_review.extra_policy` and managed
`guardian_policy_config` / `guardian_extra_policy` can customize policy; the bridge sets none of them.

The installed schema reports terminal decisions via `item/autoApprovalReview/completed` with
`reviewId`, `action`, and `review.status` (`approved`, `denied`, `timedOut`, `aborted`). These payloads
are marked unstable. A refusal or inability to decide is forwarded once to the existing approval
handler and AB-81 registry when someone can answer. The runner interrupts the affected turn, waits
for the decision (even if the turn already completed), and continues the same thread with the exact
action, reviewer rationale, and supervisor decision. Cached MCP allows and automatic tool allowlists
cannot approve terminal refusals. A supervisor allow requests one exact retry with the same automatic
reviewer and sandbox; a deny supplies its reason and prohibits retry or workarounds. Repeated review
refusals require another explicit decision. Without a supervisor, progress and denial callbacks report
the refusal rather than silently dropping it.

This is continuation context, not the TUI `/approve` developer-scoped marker: no equivalent override
method exists in this installed app-server schema. Codex may still refuse the retry, including denials
the user cannot override. Codex itself has a denial circuit breaker. The bridge does not replay a shell
command, weaken policy, or change the reviewer to force execution. Pending command/file approvals and
`item/permissions/requestApproval` still use normal forwarding; permission grants last only for the turn.
Unsupported dynamic tools and user-input forms remain unsupported.

The legacy `AGENT_BRIDGE_CODEX_EXEC=1` / older-server exec fallback keeps existing strict/relay handling:
it cannot consume app-server review notifications or provide this supervisor continuation workflow.
Fake-server tests verify configuration, overrides, sandbox preservation, terminal deduplication,
dashboard settlement, and allow/deny continuations. Real reviewer inference, managed-policy rejection,
the TUI marker, native sandbox execution, and live supervisor/dashboard UI remain unverified.

## Windows drive aliases (AB-72)

Windows drive aliases belong to a logon session, not to every process on the machine. A regular
child in the supervisor's session can see its `subst` drives. Codex's elevated Windows sandbox uses
a different account/logon context, which can lose those aliases. The runner already canonicalized
the working directory, but prompts still named the unavailable drive. On this machine, native
realpath resolves `E:\` to `D:\`; no mapping is guessed from those letters.

The runner resolves drive roots referenced by the working directory or prompt before handing work
to Codex. Both exec and app-server rewrite those prefixes, including paths for files that do not
exist yet. The job receives one mapping explanation and reports include the alias-to-real-path
mapping so outputs can be located from either session. No drive mappings or owner folders are
changed. UNC targets may still require credentials or network access; translation cannot provide
those privileges.

Microsoft documents the [per-logon DOS device namespace](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/local-and-global-ms-dos-device-names).
The Windows regression creates an unused temporary `subst` drive, checks both runners' prompt and
working-directory translation, and removes only that test mapping.

## Worktree links and cleanup (AB-73)

Jobs in new or continued worktrees are told never to create links leaving the worktree and to copy
caches instead. Completion and failure reports inspect symlinks and directory junctions, including
ignored Unity Library folders, and list external targets. A nested managed-worktree cwd still scans
the whole worktree. The scanner never follows directory links. Dangling external links are listed;
unreadable entries produce an incomplete-inspection warning.

`agent-bridge cleanup` lists external links in its normal dry-run output, even for kept worktrees.
An incomplete scan keeps the worktree. Existing safe cleanup unlinks links themselves before
removing eligible trees and does not delete their targets. The instruction is a guardrail, not an
OS prohibition on full-access jobs creating links. Live Unity cache safety and supervisor UI
delivery require acceptance on the installed bridge; tests use disposable folders only.

## Read-only Pair Desk defaults (AB-69)

Read-access jobs allow `pair-desk.get_*` and `pair-desk.list_*` without `allow_tools`. Existing name
normalization covers Codex's underscore name, Claude's plugin server name and opencode's tool
prefix. These defaults do not cover other servers or desk writes. Handoff writes remain declined
before any allowlist or remembered server approval is considered.
