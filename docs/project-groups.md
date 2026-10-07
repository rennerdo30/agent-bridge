# Project groups

Local sessions in one project share its jobs. Claude Code, Codex and opencode can all be masters,
primaries, handoff targets and fallback recipients. Paired PCs stay outside local groups.

The project identity uses the Git common directory and physical main checkout path, so nested
folders, linked worktrees and Windows drive aliases belong to the same project. Non-Git projects
share only an identical existing directory. Missing paths grant no group permissions.

## Jobs: primary contact and masters

Every job has one primary contact, initially its spawning session. All local group masters may
discover, message, continue, retitle, cancel, change settings and answer approvals. Explicit handoff
also grants mastery to the named local target, including a session outside the group. Earlier
primaries keep control rights.

Delivery goes to one live, available recipient. Prefer the primary, then previous primaries newest
first, then other group masters in connection order with session name as a tie breaker. Closing or
yielding a session leaves detached runners running. Pending job envelopes move with their stable
IDs; the shared durable routing ledger distinguishes forwarded history from consumed deliveries.
Consumed deliveries are never replayed. Fallback does not change the primary. When it returns,
new mail goes to it again. If every master is unavailable, reports stay queued until one returns.
Undelivered project-job notes remain available after the job finishes.

Use `coordinator_availability(unavailable=true)` before a usage limit or interruption when the
session remains connected. Restore with `unavailable=false`. The dashboard's **Hand jobs to project**
and **Make available** buttons provide the same action. Availability is live session state;
restarting the session makes it available again. Account-wide usage estimates do not silently
mark every session unavailable.

## Group main and project addresses

The first live session is the main contact for the group; the others are secondaries. If it closes,
the next live session becomes main. Use `project_main(to="codex-myproject")` or **Make project main**
in the dashboard to change the role. `handoff_subagents(to=..., jobs="all",
switch_project_main=true)` also switches it; the target must belong to that local project.

`peers` shows main and secondary roles and the project's address, for example
`project:animal-catch-game`. A message to that address goes to the available main, then an available
secondary. Duplicate project names are rejected as ambiguous. Exact session names always keep
direct routing. When all masters are unavailable, use an exact session name to queue mail.

Main switches send a one-line notice to the previous main and local sessions that mailed that project
address in the last 24 hours. `peers` and project-address send results show the current main, the UTC
switch time and the previous main. This routing timeline belongs to the current broker; a broker
restart chooses its main from live sessions again. Delivery and notices respect each client's wake
settings. An exact session address always stays direct.

For opencode, the plugin exposes these tools with its usual `bridge_` prefix and delivers through
its existing message notification and wake paths.

## Opt out

Set `"projectGroups": false` in the shared main checkout's `.agent-bridge/config.json` or the local
bridge's global `config.json`. Project settings override global settings; each file's agent section
overrides its general setting. Agent sections can disable sharing for that agent. The files are
read without rewriting them. Invalid or unreadable sharing settings deny group authority.
Explicit handoff grants remain usable when automatic project sharing is disabled.

The dashboard retains each session's own subagent column and groups local sessions and running
jobs under their project in the sidebar.
