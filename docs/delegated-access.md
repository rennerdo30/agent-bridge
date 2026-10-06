# Delegated Codex access and worktree isolation

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
Read-only command/edit callbacks still cannot widen access. Workspace-write and ask-mode callbacks
are forwarded to the supervisor, including cleanup requests, rather than silently declined.

The protocol was checked against the installed `codex app-server generate-json-schema` output and
the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). A direct local
app-server smoke accepted the granular thread policy and ran a hidden, immediately exiting
`Start-Process` command under `dangerFullAccess` with exit code 0. No model inference was needed.

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
