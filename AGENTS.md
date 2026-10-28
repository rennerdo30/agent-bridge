# Agent rules

## Delegation

Agent Bridge is any to any: Claude, Codex, opencode and Antigravity may delegate to every coding agent, including their own kind. Never restrict targets by caller kind. Preserve depth, slot, ownership and hop guards.

Use Bridge subagents by default for parallel or self-contained packages. Built-in/native subagents are an interim fallback while Bridge capabilities are unavailable. Route work to Codex first; use Claude/Anthropic subagents only when the owner asks.

Each package needs one clear goal, its branch and files, applicable rules, completion criteria and verification. Give it its own worktree. Use `medium` effort by default and `high` for unknown causes, cross-cutting changes, concurrency or release-critical work. Use `danger-full-access` (no sandbox). Resume through `message_subagent`; the parent reviews before merge. Native Unity work goes only through the unity-tools queue.

Push WIP with explicit refs: `git push origin HEAD:refs/heads/<branch>`. Do not use `-u` or write Git configuration. Use the approved identity `rennerdo30 <9086097+rennerdo30@users.noreply.github.com>` through per-command environment variables; omit coauthor trailers.

**Branch limit per repo:** up to 10 active branches is normal, with no justification needed. 11–20 require a proper reason recorded in the branch's Pair Desk issue or the handoff (for example, a subagent actively working on it, or many parallel subagents with one branch each). 20 is the hard maximum: never exceed it; merge or finish first. An active branch is an unmerged work branch with a commit in the last 24 hours (owner, 2026-10-16; see `E:/Development/AGENTS.md`); unmerged branches without a commit for 14 days get reviewed. Clean up merged branches per the worktree rules; never delete unmerged or unpushed work.

**Generated bundles** (owner, 2026-10-16): `plugins/*/dist` is generated and committed only in the release PR (branch `release/*`), never in feature PRs. Feature PRs change `src/`, `test/`, docs and scripts only; CI builds the bundles itself before testing, and the "Bundles are committed and up to date" check runs only on release branches.

**Tests** (owner, 2026-10-17): only write a test if it would actually fail when the code is broken in a way that matters. Everything else is bloat.

**Scope and size stops** (owner, 2026-10-29; incident PR #141: a 300-line fix grew to 106 commits and +128k lines, red on every hosted run but one):

- **One issue, one PR, one stated change.** Anything new found during the work (edge cases, stronger guarantees, refactors) becomes a new Pair Desk issue, never more commits on the same branch.
- **Size stop:** at 25 commits or 1,000 changed non-test source lines, the job stops pushing and asks the parent to split, cut back or close. The parent never just waves it on.
- **Red existing test means stop:** a previously passing test that now fails is a defect in the change. Fix the code or drop the change. Never change expected values, baselines or pins to make it pass without a documented behaviour comparison approved by the parent. Storage, migration, retention and data-preservation tests are never re-baselined without the owner.
- **Red CI stop:** after two consecutive red hosted runs on the same branch, stop pushing and report to the parent with the failure list. No third push without the parent's decision.
- **No evidence in the repository:** CI logs, receipts, review records and pin requests go to `E:/AgentData/reports/` or Pair Desk, never into `docs/` or anywhere else in the tree.
- **Every brief has a done point:** an explicit, finite list of acceptance items. "Close the remaining gaps" is not a brief.

**Merge queues** (owner, 2026-10-16): while a merge queue or combined integration branch is open, follow-up fixes go into that branch. Do not open new PRs for them.

**Canonical drive paths:** `E:\` and `D:\` are the same drive: the whole drive is a subst, `E:\ = D:\`, so `E:\Development = D:\Development` and `E:\AgentData = D:\AgentData`. Always use `E:` paths in commands, configs, docs, messages, Pair Desk issues and job prompts; do not write new `D:\...` paths. When a tool reports a `D:` path, refer to it by its `E:` spelling. Comparisons and identity checks must treat both as the same location.

## Roles and evidence

The Claude session is the project main, decides, reviews milestones on Pair Desk and the diff, and talks to the owner with minimal usage. Codex sessions do implementation, Bridge packages and release work. Record a one-line Pair Desk note at each milestone. Reviews belong on the desk and the diff, rather than in chat. Distinguish source/test evidence from live session acceptance.

## Shared tools

Staying on the latest released shared tools is P0. Report tool defects in Pair Desk `general` first; never patch consumer copies locally. This repository is the canonical Agent Bridge source: make authorized repairs here in isolated worktrees and release tested versions. The owner runs the updater; agents do not. Preserve data and worktrees, and never stop foreign processes.
