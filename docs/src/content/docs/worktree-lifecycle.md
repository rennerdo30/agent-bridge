---
title: "Worktree checkpoints, permissions and opt-in close"
slug: worktree-lifecycle
---

Automatic checkpoints use the fixed message `Save worktree changes`, with no trailers,
task text, agent names or model names. They use the checkout's effective `user.name` and
`user.email`; missing identity leaves the worktree intact and reports the problem.
Inherited author/committer environment overrides are excluded from these checkpoints.

## Windows file ownership

Delegated sandboxed runs use `codexWindowsSandbox: "unelevated"` by default. This backend
uses a restricted token derived from the bridge user, so new files retain that user's
ownership instead of belonging to the dedicated elevated-sandbox account. It still
enforces the requested read-only/workspace-write policy. Unsupported policies fail;
the bridge never retries them with unrestricted access. Full-access runs keep their
existing policy and do not select a sandbox backend.

The [native Windows sandbox documentation](https://developers.openai.com/codex/windows)
describes the tradeoff: unelevated has weaker network isolation than elevated. Set
`codexWindowsSandbox: "elevated"` explicitly when the dedicated account boundary is
required. That mode may still leave account-owned folders; automatic worktree close
does not bypass their permissions.

For old folders, stop their jobs and inspect one explicit folder:

```text
agent-bridge repair-permissions <folder>
agent-bridge repair-permissions <folder> --yes
```

The first command only lists scope. The second saves original SDDL descriptors under
`<bridge-home>/permission-repairs/` before enabling inheritance, restoring the current
user as owner, and granting that user full control. It resets explicit permissions
only within the selected physical tree. No file is deleted or truncated. No elevation
or account switch is attempted. Unreadable descriptors are kept unchanged and reported
as failures; this command cannot grant rights the invoking account lacks.
Every path component is checked. Linked roots/ancestors are refused and descendant
links (including internal links and junctions) are skipped without touching targets.

## Close policy

Finished and continuable jobs keep ignored cache links, including Unity `Library`
and `node_modules`, for follow-up checks. Completing a turn never unlinks them.
The optional 24-hour close sweep also retains any worktree containing a link,
even after that continuation window. Job results list the link paths and targets.
Only an explicit supervisor-approved cleanup may detach those link entries;
cleanup never removes or modifies their targets. Cache links permit reads only:
run imports and package installation against a separate writable cache.

`jobCloseCleanup` defaults to `false`. Opt in through bridge configuration:

```json
{ "jobCloseCleanup": true }
```

With this setting, a supervisor discarding a finished local job requests close. A held
job is retained. A cancelled detached runner requests close only after its real process
scope confirms no surviving job-owned processes. A missing/degraded scope never supplies
that proof. The supervising server checks its finished jobs every 15 minutes and requests
close after 24 hours without a continuation or recent finish. Queued continuations are
retained. The same policy applies to every supported agent, including opencode.

Manual commands default to dry run and still require the configuration opt-in:

```text
agent-bridge job-state <job>
agent-bridge job-close <job> --yes
agent-bridge close-idle-jobs --yes
```

`job-state` reads status, finish/continuation times, close/reap records, outcome decisions
and runner status without modifying stores. A live runner or held job prevents CLI close.

The close operation:

1. Takes the same exclusive physical-worktree lease used by delegated turns. A busy or
   unreconciled lease retains everything; there is no age-based lock stealing.
2. Requires versioned provenance for that exact checkout and proven process shutdown.
   Legacy jobs, replaced roots and unsupported metadata are kept.
3. Refuses tracked changes, staged changes, non-ignored untracked files, any links, and
   unknown ignored files. Permission or inspection failures retain the checkout.
4. Pushes the current tip to `wip/<job>` on `origin`. Reflog-only and abandoned-branch tips
   not reachable from it are pushed to `wip/<job>-history-<sha>`. No force push is used.
5. Reads exact remote branch hashes and rechecks the checkout/history before deletion.
6. Drops only physical, untracked Unity `Library` directories recorded as absent beside
   tracked `ProjectSettings/ProjectVersion.txt` when the job's checkout was created.
   Those directories are regenerable caches created during that job. Existing caches,
   linked/shared Libraries, tracked Libraries and other ignored files are retained.
7. Uses non-force `git worktree remove`. Failed removal is reported and has no recursive
   fallback. Local branches, logs, job records, provenance and pushed history survive.

A continuation recreates a reaped checkout on its retained local branch under the same
lease and records fresh cache provenance. A missing checkout without a successful reap
record is never guessed or silently replaced. Old job and configuration formats are
unchanged; new sidecars use contract version 1 and the existing backup-writing store.
External `unity-tools` installation is not required.
