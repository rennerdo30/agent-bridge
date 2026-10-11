# Agent rules

## Delegation

Agent Bridge is any to any: Claude, Codex, opencode and Antigravity may delegate to every coding agent, including their own kind. Never restrict targets by caller kind. Preserve depth, slot, ownership and hop guards.

Use Bridge subagents by default for parallel or self-contained packages. Built-in/native subagents are an interim fallback while Bridge capabilities are unavailable. Route work to Codex first; use Claude/Anthropic subagents only when the owner asks.

Each package needs one clear goal, its branch and files, applicable rules, completion criteria and verification. Give it its own worktree. Use `medium` effort by default and `high` for unknown causes, cross-cutting changes, concurrency or release-critical work. Use `danger-full-access` (no sandbox). Resume through `message_subagent`; the parent reviews before merge. Native Unity work goes only through the unity-tools queue.

Push WIP with explicit refs: `git push origin HEAD:refs/heads/<branch>`. Do not use `-u` or write Git configuration. Use the approved identity `rennerdo30 <9086097+rennerdo30@users.noreply.github.com>` through per-command environment variables; omit coauthor trailers.

## Roles and evidence

The Claude session is the project main, decides, reviews milestones on Pair Desk and the diff, and talks to the owner with minimal usage. Codex sessions do implementation, Bridge packages and release work. Record a one-line Pair Desk note at each milestone. Reviews belong on the desk and the diff, rather than in chat. Distinguish source/test evidence from live session acceptance.

## Shared tools

Staying on the latest released shared tools is P0. Report tool defects in Pair Desk `general` first; never patch consumer copies locally. This repository is the canonical Agent Bridge source: make authorized repairs here in isolated worktrees and release tested versions. The owner runs the updater; agents do not. Preserve data and worktrees, and never stop foreign processes.
