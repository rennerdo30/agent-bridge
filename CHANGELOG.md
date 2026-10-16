# Changelog

## 0.30.32

- **Fewer Muse hook runs.** Every Muse hook is a new Node process. PreLLMCall, PreToolUse and PostToolUse all ran the same mail check, so each step started three (a long list of HookRun entries in T3 Code). The Muse plugin no longer registers PostToolUse and PreToolUse only gates tools; mail still reaches the model before every model call.

## 0.30.31

- **Muse in T3 Code works again.** A `muse serve` that agent-bridge did not start (T3 Code and other MSP clients) was treated as a Bridge job waiting for its private handoff, so its bridge server marked itself internal and the hook denied every shell and write tool ("agent-bridge permission gate unavailable"). A serve host without Bridge's delegation markers is now an owner session; Bridge jobs still authenticate and fail closed.
- **Faster dashboard refreshes.** Open job questions are found in three single passes instead of rescanning every message once per question (about 0.9 s to 0.1 s on a 23,000-message store). Long-interrupted runs recheck their runner once a minute instead of on every poll.

## 0.30.30

- **Muse stays usable after an update.** Reinstalling the Muse plugin left it disabled with its hooks and MCP server unapproved, so Muse denied every shell and write tool ("agent-bridge permission gate unavailable") until `muse plugins enable` and `approve` were run by hand. An update now re-enables and re-approves the plugin when it was enabled before; a plugin you disabled stays disabled.

## 0.30.29

- **Broker no longer stalls on job-mail routing.** Routing re-reads the job listing once per job. The listing (about 28 MB on a home with ~1,700 jobs, one with a 6 MB delivery) did not fit the 8 MB archive cache, so every pass decoded every job once per job on the main thread (over a full core, pings timing out). Whole snapshots now have a 64 MB budget; the dashboard's job listing is reused across refreshes too.
- **Idle history worker.** Conversations whose folder resolves to no project (leftover worktrees) were re-resolved and rewritten on every tick; they are now retried every 10 minutes. Unchanged ingest cursors are no longer rewritten.
- **Muse plan usage.** Muse jobs record the 5-hour and weekly usage Muse reports while working; `usage_limits` and the dashboard show it with its time instead of "availability is unknown".

## 0.30.28

- **Idle broker CPU.** The history worker kept up to a whole core busy long after the import finished: every checked run log re-tagged its documents with a query that scanned the whole history store, which has no index on `run`. The lookup now uses the documents' primary-key id range (`run:<run>:`). The once-a-second storage budget check also no longer resolves two real paths per project.

## 0.30.27

- **Claude Code: agent-bridge hooks run again.** Since 0.30.22 the Claude plugin's `hooks/hooks.json` named two hooks modules (`wake.ts` and `mail-scope.ts`); Claude Code loads one per plugin and refuses a second, so none of the plugin's hooks ran: sessions showed no busy/idle (grey in the dashboard), peer mail was not delivered through hooks and native subagents were not registered. One entry module (`hooks/index.ts`) now registers both mods.

## 0.30.26

- **Dashboard: run summaries stay cached with more than 2,048 runs.** The cache was capped at 2,048 entries, so with more runs (2,902 here once packed runs were listed again) each refresh evicted what the next one needed and re-read every run preview: about 2.5-5 s per request and a busy broker. The cache now holds at least twice the current listing.
- **Dashboard: recent messages are reused until a message database changes.** Every refresh re-queried the main and archive message tables.

## 0.30.25

- **Dashboard: fast again with many archived runs.** A packed (archived) run's index entry keeps the identity of the original log, but its file is the retained copy in `cold/`. The preview read compared the two, which always failed, so on every refresh each packed run was opened again and then left out of the list: with ~1,700 packed runs every dashboard request took about 9 s and the broker used a full core. Packed runs now skip that comparison (their copy is immutable), are cached after the first read and appear in the run list again.
- **Updater: the Muse note now says to enable a disabled plugin before approving it.** On a disabled plugin `muse plugins approve agent-bridge` reports "no runtime capabilities match".

## 0.30.24

- **Updater: Muse installs always use user scope.** Run inside a Git project (for example the agent-bridge checkout), Muse refused the 0.30.23 update with "plugin `agent-bridge` is already installed from a different source", because `muse plugins install` without `--scope` targets that project. The installer now passes `--scope user`.

## 0.30.23

- **Updater: a running Claude Code session no longer makes `update` fail** with "Immutable plugin version differs". Claude Code writes `.in_use/<pid>` markers into the installed version folder; the immutable-version comparison now ignores that top-level folder, so an identical build is recognized as already installed. A real content difference is still refused.
- **Updater: Muse now actually updates.** `muse plugins update` only re-reads the source Muse recorded at install time, which could be Muse's own cached copy of an old version, so Muse stayed on 0.30.16. The updater now copies the Muse bundle to the same durable version folder as the other clients (`~/.agent-bridge/plugin-versions/muse/<version>`) and runs `muse plugins install` from there, then `inspect`. A disabled plugin stays disabled; capability approval stays with the owner.
- **Updater: a file lock during publication is retried for about 11 s** (10 attempts with growing waits, was 5 attempts in 0.5 s). A virus scanner checking the freshly written files could make the Antigravity update fail with EPERM; nothing was lost, but the update had to be re-run.

## 0.30.22

- **Requires Node.js 24 or newer** (owner decision 2026-10-16; Node 24 is the current LTS). The MCP server, its worker and the CLI (including hooks) check the version before anything else and refuse to start on Node 22 or older, printing what to install. CI and diagnostic workflows test Node 24 only; bundles target Node 24.

- Job approval questions no longer hide security-relevant arguments (AB-417). Before, a supervisor saw only the command or file path, so a sandbox-off or escalated command read like an ordinary one. A request with such arguments now starts with a line of markers before the command, for example `[sandbox OFF] [background] [timeout: 600000 ms]` (Claude Bash) or `[escalated: <justification>] [workdir: <path>]` (Codex `sandbox_permissions`, `with_escalated_permissions`, `workdir`, `timeout_ms`, `prefix_rule`, `additional_permissions`); any other argument shows as a bounded `+args: {...}` on that line. Codex app-server command approvals mark `networkApprovalContext`, proposed exec-policy and network-policy amendments, extra permissions, a folder other than the job's and the reason; file-change approvals mark a requested write root (`grantRoot`). opencode questions mark a working folder, timeout, patterns that differ from the command and other metadata. Marker values are escaped (no raw line breaks, brackets or bidirectional controls; also no ANSI escapes, zero-width, tag or other invisible format characters, variation selectors or brackets that look like `[` `]`, which are written as `\u` escapes) and cut at 200 characters with their length named, so a hostile path or reason cannot fake a new line or approval; the command itself is shown unchanged. A command whose first line starts, after whitespace and invisible characters, with `[`, a look-alike bracket or `+args` (any case; for example `+args: {...}`, `[sandbox ON] [reviewed]` or `[ -f x ] && ls`) always gets the bridge's header `[command starts like a marker line]` before it, so the first line read as markers is always the bridge's and the whole command stays in the command box; other question texts (MCP calls, Codex permission and MCP prompts, opencode and Antigravity requests, and approvals mirrored from a paired PC, whose bridge may be older) get the same guard. The dashboard reads a marker row only from a first line without raw control, invisible or line-separator characters or look-alike brackets, which the bridge always escapes. MCP tool calls always show their whole input as JSON, even when they have a `command` or `file_path` argument. The dashboard approval card shows the markers as their own row above the command. An ordinary request reads exactly as before. Display only: approval identities, reuse and allow patterns are unchanged. Antigravity and Muse questions already show their full arguments as JSON and are unchanged.
- Spawned and asked jobs get the `pair-desk:worker` allowance by default (AB-403, owner decision 2026-10-16): a `spawn_*` / `ask_*` call without `allow_tools` lets the job read the desk, comment, post progress, write plans and steps, edit issues and set review locations without an approval question, in every access mode (`read` and `ask` jobs included). The `pair-desk:worker` preset no longer includes creating issues (owner decision): grant `"pair-desk.create_issue"` explicitly for that. Issue creation, status changes, build publication and handoff writes are asked or declined as before. The new home-config key `jobs.defaultAllowTools` (default `["pair-desk:worker"]`) changes or clears it (`[]`); a project config cannot set it, and the spawning session's agent section applies (on a paired PC, the receiving PC's section for the target agent). An explicit `allow_tools` list replaces the default (include `"pair-desk:worker"` to keep it) and `allow_tools: []` turns it off for that job, its follow-ups and restored runs. The default is applied where the explicit list is, so every CLI kind (Codex, Claude, opencode, Antigravity, Muse) behaves the same. It covers the bridge job and what runs inside it, such as Task subagents of a Claude job; the session itself and its own native children are not affected. A Claude job whose desk server is selected only by the default runs without the desk, with a warning, when that server fails to start or does not answer in time; an explicit grant still fails the job. Tool descriptions show the default from the configuration at session start; runner specs from older releases without `jobs` use the built-in default.
- A subagent queued for a machine slot no longer looks stuck (AB-401). While it waits for machine startup admission, the job limit (its session's limit or the shared root job budget) or a resource slot such as `unity`, `peers` says so with its place in line and the holders ("waiting for machine resource slot \"unity\": position 2 in queue, 1/1 held"), `peers(job=...)` and `/api/state` carry `waitingFor: { kind, resource?, position, holders, capacity }`, and the dashboard shows a "waiting" pill in the subagent row and conversation header with the wait in the conversation note. The pill is shown for a running job's slot or startup wait; a job still held back by the job limit is not running, so it shows its wait in `peers` and `/api/state` only. The job limit is named only when it is the blocker: a stopping job with a queued follow-up, a start deferred by a job-store lock or upgrade, and a paused job's queued resume ("paused; resume queued" in `peers`) are not labelled as the job limit. It is read from the queues' own state (a read-only snapshot of the slot database, reused for 1.5 s by the dashboard's polls, and the session's queue) without process probes, writes or creating a missing database, and admission is unchanged. A queue entry that has not been polled for 30 seconds does not count, so a job that is really stalled still shows as working with an old update time.
- A job no longer asks its supervisor twice for the same thing (AB-402). When a job asks for an approval identical to one the supervisor (`decide`) or the owner (dashboard or native dialog) already allowed in the same job (same agent, tool, working folder and exact command line, file path or tool arguments), the earlier grant answers it. The supervisor gets a quiet note naming the original approval id, the job's step log and run report show the reuse, and the approvals history records a `reused` event. Grants never widen or cross jobs, end when the job's access, sandbox, permission settings or supervisor change, and are kept in memory (at most 64 per job). A deny is never reused, and automatic allows (`autoApproveTools`, `allow_tools`) create no grants. Codex summaries without an exact request (MCP elicitation text, edits without paths, commands without a command line), automatic-review refusals and sandbox permission requests are always asked. On by default; set `"jobs": { "reuseIdenticalApprovals": false }` in the home config to ask every time.
- `peers` no longer fails with "Message too large" when the project keeps many jobs with long histories (AB-404). It reads slim, frame-bounded pages of job summaries (`projectJobSummaries`); an older broker that refuses its full listing as too large is reported as a note, also for native children. MCP tool results, hook context, Claude wake-ups (Stop hook and mod) and channel pushes stay below one result's size: a message too large to show is listed by id once, stays unread and is read in pages with `inbox(id=..., offset=...)`, and only messages shown in full are ever marked read. A page read out of order says the message is still unread and where to continue.
- Sessions of Claude Code or Codex whose CLI process has ended no longer show up as live peers or take mail (AB-399). The broker retires such a bridge server when the CLI's process is gone (signal 0) or its PID provably belongs to a later process (a background check every 10 minutes, only for sessions whose CLI PID still exists; on Windows one PowerShell query per check). A retired server gets a new `retired` event and stays off the bridge; mail to its name is queued offline as for any absent session, and stored registrations, names and messages are kept. A retired server that tries to register again is refused with a retry error, so releases that do not know the event fall back to their normal reconnect backoff instead of reconnecting in a loop; the refusal also runs before session recovery, replacement of another server of the session and mail claims. A retired project main gets its role back only when the same session reconnects within 5 minutes. Session identity now uses the physical path of the working folder, so SUBST and mapped-drive spellings of the same folder (including a removed one) match.
- Claude Code: a peer message that the agent-bridge mod already submitted as its own wake turn ("New actionable message(s) arrived") is no longer also injected as hook context when a user prompt runs first, so it no longer costs a second turn. A mod hand-out is read only when its own wake prompt runs or the mod acknowledges it; an unrelated turn start no longer marks a hand-out read that the mod dropped without submitting, so it is woken again instead of lost. A job result a hook already handed out (awaiting its receipt, AB-400) never starts a wake turn. Copies that may repeat an earlier hand-out (a lost Stop-hook wake-up, a result whose hook output was discarded by StopFailure or session end, a mod hand-out the mod never took again) carry `repeat="true"` and a note not to act twice (AB-396).
- The standalone broker daemon is now on by default (AB-325, #17). When no broker is running, the first session, CLI command or CLI dashboard starts one background broker that also hosts the dashboard and keeps running when that session exits. Set `AGENT_BRIDGE_DAEMON=0` or `"daemon": { "enabled": false }` to keep the embedded broker. On upgrade, an already running broker of an older release keeps serving and no second broker starts; the daemon takes over the same store and its queued mail once that broker exits.
- The broker daemon hands over to a newer release. When a session of a newer agent-bridge version or protocol connects with the shared token, the daemon stops admitting requests (refused as "not applied; retry"), lets admitted ones finish for up to 10 seconds, closes the store, releases the pipe and exits; the newer session then starts its own daemon on the same store, so accepted mail carries over. The new daemon never starts before the old one has released the pipe. Older sessions wait 15 seconds before starting a daemon themselves so the newer release wins, then reconnect to it. Only clients that can start a daemon themselves trigger a handover (never job runners, delegated runs or status probes), and a daemon does not hand over to the same release again within 10 minutes (`daemon-handover.json`), so a newer release whose daemon cannot start cannot make brokers churn. A daemon that has served nothing for 10 minutes also exits (`AGENT_BRIDGE_DAEMON_IDLE_EXIT_MS`); connected sessions, pending remote-job requests and starts, connected paired PCs and open or recent dashboard and phone connections keep it serving. Update advice for remote jobs and remote verification now says to start or reload one updated session instead of restarting every hosting session.
- A session no longer stays without a broker for its whole life after a daemon creation with an unknown result. Any authenticated registration settles the attempt, so a later crash, handover or idle exit starts a new daemon; a definite failure that the Windows creation helper reports after the 5-second decision also allows a new attempt, spaced by a backoff of 5 seconds doubling to 5 minutes.
- Windows: the loopback fallback record is not replaced when discovery content appears while the broker writes its own record.
- Windows: a demand-started broker answers its first clients seconds sooner. Its own process identity is read in parallel with binding, and the loopback fallback's protected record is read and written without blocking the event loop; before, up to three synchronous PowerShell calls held up authentication of waiting clients. Clients also start their host CLI identity query while the daemon is being created. A slow WMI creation helper is no longer killed at the 5-second decision point, so a creation that is applied late is still found instead of leaving no broker.

## 0.30.21

- A message larger than the 4 MiB frame limit no longer puts sessions into an endless reconnect loop. Senders now check the encoded size first: an oversized request fails with a non-retryable `too_large` error, and the broker skips an oversized event instead of dropping the connection. Oversized job reports and stored messages are sent as a short stub with the same id; the full text is kept in `quarantine/` under the bridge home, and the stored original is never rewritten. Worktree reports list at most 50 skipped files. `doctor` reports oversized and unsendable stored messages (AB-380, #59).
- The job-close autosave never commits half of a regenerated plugin bundle. Changed `plugins/*/dist` files are left out as a whole and listed in the close report; the files stay on disk (AB-274, #52).
- Packed run history is read without failing while the outcome worker holds the SQLite database (AB-290, #38).

## 0.30.20

- The broker no longer stalls under load from many running jobs. Job control requests (`message_subagent`, handoffs, `jobAuthority`) used to decode the whole job archive several times per request and scan every retained run log; they now look up only the requested job, reuse already-decoded records within a bounded cache, and read a running job's current run directly. In a test home with 3,000 runs, one request dropped from about 470 ms to 5 ms and 15 concurrent requests from about 6 s to 0.16 s (AB-300, #39).

## 0.30.19

- Add Muse as a fifth coding agent, including native plugin installation, authenticated mail hooks, stable MSP delegation, live steering, approvals, model discovery, session history and remote jobs. Preserve named permission profiles across job reloads and continuations; verify the served profile before submitting a turn (AB-330, #20).
- Antigravity jobs in `ask` mode deny approval requests again when no supervisor is allowed to approve them, instead of relaying them. This regressed in 0.30.17 (#20).

## 0.30.18

- Antigravity jobs in `edit` mode no longer ask the supervisor to approve read-only tools such as `view_file`, `list_dir` and searches outside the workspace, including Antigravity's own skills and tool schemas under `~/.gemini`. Reads defer to Antigravity's own permission policy again; shell commands, external MCP tools, writes outside the workspace and unknown tools are still forwarded for approval (AB-367, #43).
- Phones can be paired from the dashboard (AB-271, #10).
- Messaging reports how each send was delivered, and Claude native children get a one-shot scoped queue (AB-345, #32).

## 0.30.17

- Antigravity sessions can use their built-in tools and other MCP servers again. On agy 1.3.5 the bridge's `PreToolUse` hook answered `{}`, which Antigravity treats as "deny", so every non-bridge tool was refused with an empty reason. It now defers to Antigravity's own permission policy, and in `edit` mode forwards shell commands, external MCP tools and writes outside the workspace for approval (AB-331, AB-305, #28).
- Mail delivered when an Antigravity turn stops is kept unread until the continuation is confirmed, so it is not lost when Antigravity reaches its continuation limit (AB-315, #28).
- `usage_limits` reports Antigravity quotas and credits from `agy /usage` (agy 1.1.11 and later) without using a model turn (AB-303, #28).
- Antigravity jobs on paired PCs keep `terminal_sandbox` and `bypass_permissions`, and remote approvals settle reliably (AB-308, #28).
- Antigravity Desktop and IDE sessions and transcripts are recognized (#28).

## 0.30.16

- New and continued jobs no longer stay queued forever behind a finished job whose process ID Windows reused for a protected system process (svchost, WmiPrvSE, SearchFilterHost). Such a reader now counts as gone only when Windows reports a known OS service host under that ID; renamed runtimes, unknown names and failed queries still block the store upgrade (AB-362, #36).
- On Windows, plugin installs and updates retry briefly when the new version folder cannot be moved into place yet. A failure now names both folders and says what was kept, and a missing plugin build prints the `npx` command to use instead (AB-360, #34).
- The dashboard yields while reading large job archives, so it stays responsive (AB-294, #37).
- `search_history` explains its query grammar and filters to agents (AB-336, #30).
- Windows CI runs in four parallel shards with complete coverage checks, and two intermittent test failures are fixed (#8, #33, #35).

## 0.30.15

- Storage finalize and absorb keep backups, migration snapshots, `retained_*` tables and old archives without deleting or rewriting retained data. Linked, uncertain or WAL-mode candidates are refused before they are opened (AB-215/AB-228, #18).
- Unchanged finished jobs are no longer archived again on every save (AB-319, #13).
- Jobs that refuse a follow-up now return a typed reason explaining why (AB-320, #15).
- Codex plugin hooks no longer fail with "hook input placeholder `${agent_id}` was not found" on Codex 0.162 and later (AB-299, #12).

## 0.30.14

- Phone pairing over a plain home-network IP now works with `"tls": "pinned"`, with no CA or certificate setup. Scan the QR code to pin the PC key; the native phone transport checks that key before sending requests (AB-271).
- Project paths and full-access prompts prefer verified drive aliases, and project decisions match across drive aliases. You can turn the display preference off with `pathDisplay.preferAlias`. Release rehearsals also recognize aliases when checking fixture containment (AB-272).
- Native Claude children have their own scoped bridge addresses and mail queues, with explicit recipient grants and recovery of unread mail when a child ends (AB-280).
- opencode jobs in served/edit mode keep their private server's input open, preventing early shutdown and "fetch failed" errors in worktrees (AB-264).
- Cancelling and resuming jobs wait briefly for another session's state write, avoiding unnecessary retry errors and delayed starts. A lock that stays busy still blocks the operation safely (AB-278).
- Ordinary mail to jobs stays blocked while background indexing catches up; use the supervisor or an authorized sibling channel.
- Windows scans keep complete file IDs, so replacing a JSON file cannot be mistaken for unchanged cached data.
- opencode retries deferred initial peer context and records it only after session storage succeeds.

## 0.30.13

- Dashboard job controls now check who sent the request before allowing it, preventing unauthorized sessions from controlling jobs.
- Claude activity hooks track each turn so delayed hooks cannot change a newer turn. Native Codex children join under their parent without taking its mail, and project main sessions keep the correct identity (AB-268/269).
- Cancelling and resuming the same job now happen one at a time, preventing overlapping runners and lost continuation messages. The original executor can still stop handed-off inline work, and job results stay recoverable while store upgrades wait (AB-278).
- Support opencode 2.x session discovery, project matching and launches while keeping compatibility with earlier versions (AB-264).
- Add the mobile gateway and the first Expo companion app for pairing, conversations, jobs, owner questions and push notifications. The gateway is opt-in through config. Push registrations are archived when replaced or revoked; the app includes iOS 27 scene support and its launcher icon. Update the MCP SDK to 1.32.1 and source-map-js to 1.2.2 (AB-271).

## 0.30.12

- New background jobs no longer fail at startup when the PC is busy. Before its first state write, a job runner checks the identities of running store readers; on Windows that check is a PowerShell query that takes many seconds with dozens of agent processes running. A slow or failed check used to end the job after 15 s ("job runner ended without reporting a result"). The runner now retries the check and waits up to 5 minutes for store admission, still writing nothing before identities are ready (AB-278).

## 0.30.11

- Every CLI can now use `ask_*` and `spawn_*` with Claude, Codex, opencode and Antigravity, including its own kind. Existing delegation limits still apply.
- Codex sessions recover idle when an end-of-turn hook reaches its deadline, allowing queued peer mail to wake the session. Delayed older hooks cannot interrupt a newer turn or consume its mail.
- Hooks flagged as native subagents leave the main session's mail untouched. This also preserves supervisor messages for a delegated job's main agent, instead of letting its native children drain them.
- Archive identity conflicts no longer prevent sessions from joining the bridge. Conflicting original messages stay intact in quarantine, with both variants, hashes and provenance retained; unaffected mail remains available.
- `doctor` reports an `archive-conflicts` warning requiring manual review. Quarantine is permanent pending explicitly reviewed recovery, without automatic retries or expiry. The originating handoff identity issue remains tracked as AB-275.
- Archive maintenance reports progress for newly moved and newly quarantined rows: `archiveMessages` returns their combined count.

## 0.30.10

- Codex sessions can now start Codex subagents with `spawn_codex` and `ask_codex`, choose their model, reasoning effort and sandbox, and manage them with the existing subagent tools.

## 0.30.9

- The dashboard opens a conversation at its latest messages. It used to read every transcript from its first byte, which took seconds for long sessions (a 140 MB transcript) and showed the oldest part first. A paired PC on an older version is still read from the start.
- Loading the dashboard no longer blocks the bridge. The resource-slot view ran a slow liveness check (PowerShell on Windows) for every slot holder, stalling the serving process, broker included, for seconds. The dashboard, `peers` and `resource_slots` now show the slots without new checks; acquiring and releasing still prune dead holders.
- Owner decisions with scope "all" now sync between paired PCs. They are announced when recorded, caught up after a reconnect, and imported with their ids, so nothing is duplicated or rebroadcast. When both PCs decided the same topic while apart, the newer revision is current on both and the other stays in history. Project and session scopes stay on their own PC. Both PCs need 0.30.9.
- A job turn no longer fails at once when its worktree state write waits on a store upgrade behind a briefly unverifiable reader. It retries with a fresh identity check for up to 2 minutes, then fails with the same message as before.
- Opening the job archive no longer fails when a SQLite `-shm` or `-wal` file disappears while the archive path is checked.
- A config or store file that is being rewritten in place (for example saved by an editor) is no longer moved aside as corrupt when it is read half written. It is read again after a moment; a file that stays unreadable is still preserved as before.
- The job archive waits out a brief writer lock like the other stores instead of reporting "busy" after 100 ms.

## 0.30.8

- New jobs no longer fail at their first store write because another reader looked unknown. A reader verified once stays known while its identity refreshes in the background, and readers not yet verified (a runner that started a moment ago, or a cold cache) are checked directly against their recorded process identity.
- A recorded reader whose PID now belongs to another process, or to no running process at all (an exited process whose PID a lingering handle keeps answering), counts as gone. A listed process whose start time cannot be read (elevated or protected) still blocks.
- The dashboard shows a silent run as interrupted only when its job runner's heartbeat is old too. Freshly started jobs waiting for admission, a queue or a long model step no longer flip between interrupted and running.
- The owner's dashboard shows only questions addressed to the owner (`ask_owner`). Subagent questions to their parent session no longer appear in the overview, question list, session page, counters, toasts or notifications.

## 0.30.7

- A session adopts the jobs it started under a "-N" stand-in name during a reload again. Since 0.30.4 the stand-in's presence lives in the metadata database, which the check that the stand-in had exited did not read, so those jobs stayed with the dead stand-in: missing from the session's job list, refused by `message_subagent` as unknown, and their results stuck in its mailbox. Presence written before the current boot also counts as proof that the stand-in exited; a stand-in that may still be alive is never adopted.
- A handed-off subagent turn that ran inside the old session (an `ask_*` run, or a job without a job runner) no longer stays "running" forever after that session crashed or the PC rebooted. Once the broker no longer lists the executing session and its process is proven gone, the turn is marked interrupted and can be resumed with its session. It no longer counts against the subagent limit.
- `message_subagent` no longer loses a message to such a turn whose executing session is offline. The message is queued and sent with the resume, or after the running turn ends, and is reported as queued instead of delivered. `cancel_subagent` on such a turn settles it as cancelled once the executing session is proven gone.
- Job starts no longer wait on a json store upgrade when the system is busy. When the Windows process-identity query failed or timed out (for example with about 20 jobs starting at once), every live reader was marked "unknown, reads 0". A failed query now keeps each reader's last verified identity, and the query may take up to 15 s. A reader that a successful query does not find is still unknown.
- A job runner whose process cannot be verified (its PID answers access denied, or its start time cannot be read) and whose last heartbeat is from before the current boot now counts as gone. Its job becomes interrupted and resumable and frees its slot. Recent unverifiable runners are still kept and never killed.
- Legacy reader records from before the current boot no longer keep the compatible file stores running. Imported 0.29 reader records now use their file time to detect a reused PID.
- Migration locks, the storage maintenance lock, storage leases and metadata file leases whose owner cannot be verified and that were written before the current boot are recovered the same way as those of a dead owner. Metadata leases are archived. Recent unverifiable owners are still refused.
- Resource slots held by an unverifiable owner that last renewed them before the current boot are freed without waiting for the 6-hour expiry.
- `job-close` and `close-idle-jobs` no longer keep a worktree for a process that only reuses the runner's PID. They check the runner's identity and apply the same boot rule.

## 0.30.6

- A worktree lease whose holder cannot be verified (legacy or unidentified owner) and whose last heartbeat predates the current boot is archived with its reason and no longer blocks resuming its job after a reboot. Live and recent unverifiable holders are still refused; the legacy lease directory stays in place.

## 0.30.5

- After a reboot, reader presence records written before the boot no longer block the history and metadata upgrades. Windows reuses low PIDs for protected system processes whose start time cannot be read, so such stale records looked like unidentified live readers and kept every 0.30.4 migration waiting.
- The metadata import keeps each presence record's original file time instead of the import time, and once restores that time for rows an earlier 0.30.4 import stamped. Values, retained originals and bundles stay unchanged.
- `message_subagent` continues finished jobs that a session loaded during startup before its continuation factory was installed. They reported "no session to continue" although their session existed.
- The health tool's event-loop maximum no longer counts the idle time between health checks as one delay.

## 0.30.4

0.30.2 and 0.30.3 were not released separately; this release contains them.

- History store v2: transcript bytes and search text are stored once and zstd-compressed with a per-row codec. The record body that duplicated its raw bytes and the derivable folded search copy are no longer stored. Search reads decoded text through a view; plain legacy rows stay readable.
- The history migration takes a consistent snapshot of the legacy store in about a minute instead of a row-by-row copy, copies in batches that are decoded and compared byte-for-byte before their cursor commits, verifies every row a second time, and only then switches readers. It checks free disk space first, resumes after a stop, crash or reboot, latches verification failures until an explicit retry, and keeps a failed attempt's rows. A verified v1 history store is upgraded in place and its tables are kept.
- Migration snapshots no longer count against `history.budgetBytes`; the default budget is 32 GiB.
- `agent-bridge db tables | query | export --decompressed` and the dashboard's Database page show the bridge databases read-only, with compressed text decoded.
- `agent-bridge storage finalize` lists the old-format data that the verified new storage replaces (legacy history tables, migration snapshots, old database backups, incomplete backups, retired job copy originals) and removes exactly that list only with `--yes`, then compacts `bridge.db`. It refuses while any migration is unverified.
- Job copies are indexed per job version in SQLite and the existing copies are packed into one verified compressed bundle; polls no longer reread archived copies.
- Verify cancel-then-continue of worktree jobs and preserve archived dead-owner leases. Report associated surviving processes to supervisors without guessing termination authority.
- Lazy-load broker, dashboard and CLI command modules with split bundles; back off idle history scans and coalesce pressure events.
- Checkpoint sender transfer progress once per negotiated window; test two-instance throughput and concurrent message fairness. Receiver chunk durability stays unchanged.
- Add a read-only legacy empty-lock evidence report; no legacy reconciliation or deletion.
- Refresh eligible GitHub Actions pins; retain dependency upgrades younger than two weeks for a later release.
- Generate test homes outside source repositories with a Git discovery ceiling.
- `db export --decompressed` copies TEXT values byte-exact on Node 22, which cut text at its first NUL character.
- A broker socket path longer than macOS or Linux accept moves to a private per-user folder under `/tmp`; homes with short paths keep their socket.
- Run log lookup by filter matches the run name only, not the home path.
- An inline job report that another writer's save left out of the store is saved again with backoff instead of waiting for an unrelated save.
- A late read-journal retry closes the database handle it opened after its session stopped, and a retry timer that fires slightly early still retries instead of stopping.
- After a handoff, the broker routes a job's reports by the stored job, not by an older recovered copy that still named the previous owner.
- A session that stops while it is taking over as broker closes that broker instead of leaving its databases open.
- A handoff retries for up to 2 s while the jobs store lease is briefly held, instead of failing at once.
- The README states prominently what agent-bridge may ever delete and that close cleanup is off by default.

## 0.30.3

- Authority reads use bounded backoff and explicit retry-later errors. Durable sends reuse their message identity across busy/timeout retries and retain conservative stored/unknown outcomes. Cancelled final states remain authoritative in deferred job journals and shutdown recovery.
- Ask completions retain independent versioned receipts, including recovery from paired native tool records. Stale active records are repaired with a backup and archive; older results cannot finish newer continuations.
- Unsupported ordinary job mail is rejected visibly before storage. Legacy ordinary envelopes remain unread rather than being silently consumed; granted sibling and supervisor control channels retain their existing contracts.
- `worktreeRoot` and `AGENT_BRIDGE_WORKTREE_ROOT` select the root for new local and remote jobs. Existing worktrees retain their saved paths.
- History imports run in the isolated worker, verify retained bytes before advancing cursors and pause at the configured storage budget. `history-archive` creates verified compact snapshots and compressed copies while preserving originals and every prior archive. Verification failures latch until explicit retry.
- Automatic checkpoints include tracked changes and explicitly staged new files. Unstaged untracked build outputs and private files remain on disk and are named in the report.
- Windows worktree edits default to full access when the general sandbox is unset/read-only. Explicit read/ask and configured sandbox overrides are preserved. Cancelled jobs have their own status across runners, protocols, retained history and the dashboard. Older paired brokers receive a compatible status with an explicit cancellation cause; retained records are unchanged.
- Savepoint cleanup preserves the original SQLite error after automatic rollback.
- The default test lane is fast; `test:integration` runs native process, pipe and storage fixtures. CI runs both lanes on every platform. Hook tests verify wait/budget behavior without fixed wall-clock assertions.
- Windows permission repair preserves the original owner, backs up descriptors and reports access refusals without escalation or data removal.

## 0.30.2

- Archive and run-history caches use file metadata before parsing; bounded log previews and job projections avoid copying full transcripts on polls. Dashboard catalog traversal yields between file and record operations so messages can proceed during cold scans. Concurrent nodes publish identical finished-job archives once and preserve existing archives.
- New sessions can host the existing store while upgrades wait for old runners. Process identities prevent stale reused PIDs from blocking upgrades, and the additive v8→v9 migration backs up only affected metadata.
- Peers reads reconnect once across a retiring broker connection, with bounded waiting and cancellation; mutation requests keep their existing durable-status contract.
- Opt-in daily backups capture only message tables in a single low-priority process with incremental verification and pressure-aware IO pacing. Scoped snapshots cannot replace a full restore; manual full backups remain available.
- Legacy and expired-message archival starts after the broker listens and yields in bounded chunks. Queue expiry completes before a reloaded session claims mail; pending refills, replay and explicit stand-in claims verify expiry and the final registration generation during rename or reload.
- History migration runs outside broker dispatch. History-only snapshots, persisted chunk cursors, incremental verification, pressure pauses and IO pacing preserve originals and resume after interruption. Verification failures require an explicit retry. Restarted imports base their approximate row-based ETA on newly completed work.
- Worktree leases identify their owners and archive dead-owner lease metadata without touching checkout contents. Metadata locks retain inode and owner-nonce checks when filesystem timestamps change. Unknown legacy leases remain protected. Completed and continuable trees retain ignored cache links.
- Failed worktree creation preserves existing branches and partial checkout data; timeout retries use an unused location without cleaning the first attempt.
- Windows permission repair preserves original ownership, retains descriptor backups, and reports unavailable ACL rights without escalation (AB-195).
- Transient Claude sessions cannot claim a live owner's jobs. Running turns survive owner handover and control failures; detached runners contain escaped callback exceptions and rejections. Initial state publication rechecks concurrently joining readers asynchronously before launching a turn. Result delivery refreshes its destination while retrying.
- Context retention and live-link preparation run before native startup admission; each CLI handshake keeps its own bounded permit through session readiness, including retries (AB-207).
- Deferred job saves refresh reader identities asynchronously and retain versioned pending context across shutdown. Result delivery waits for the exact durable envelope, retries with the same message ID, and cannot overwrite newer ownership, queues or completed state (AB-199).
- Explicit handoff verifies cold reader identities asynchronously and rechecks both sessions before committing. Stale owner snapshots cannot revive completed turns; failed continuation preparation retains queued context for explicit retry.
- Ordinary and linked-worktree project discovery reads verified Git metadata without launching Git on broker requests, and honors configured Git discovery ceilings.
- Paired transfers negotiate larger pipelined windows while messages take priority. Same-content message-id retries return stored delivery status; paired project addresses route to the available main session.
- Health, status, doctor and the dashboard show cached migration and backup progress. Slow responses are distinguished from a stopped bridge; agent instructions direct status checks to tools.
- Finished-run outcomes use a background cache; dashboard polls no longer open message databases or invoke git for each run. Warm run scans batch metadata validation while retaining fresh containment and file-replacement checks.
- All delegate and runner environments disable .NET first-run PATH changes by default, preserving explicit user values and the existing PATH. Doctor warns about unusually long Windows user PATHs or repeated .NET tools entries without changing them.
- Requires Node.js 22.16 or newer for incremental native SQLite backups.
- Release rehearsal retains every raw sample and error. A separate acceptance result may allow only a 0.29.17 broker-retirement connection error whose message is durably confirmed stored; the strict result remains false. Current-client errors, unconfirmed messages, latency gates of one second or more, or failed migration, context or cleanup verification block release.

## 0.30.1

- Hotfix: the broker no longer rereads every archived job and run snapshot on each dashboard poll and peers refresh. The snapshot cache now covers the real working set and merged job history is reused while its files are unchanged, so `jobAuthority`, `pending`, `ack` and the dashboard stay responsive.

## 0.30.0

Changes since 0.29.17:

- Owner questions appear in the dashboard and desktop notifications, retain answers, and reach the current project master.
- Project groups and subagent handoff preserve discovery, ownership and control across supervisor reloads; main changes are visible and announced.
- Codex idle wake and delivery distinguish queue acceptance from consumption, with consistent direct, broadcast and quiet-note handling.
- Broadcasts reach live secondary sessions; stale offline names are skipped. Inbox pages keep retained quiet copies available explicitly.
- Startup admission bounds concurrent native launches across Claude Code, Codex, opencode and Antigravity; broker scheduling and SQLite contention fixes keep bursts responsive.
- Plugin updates preserve running jobs, retained versions and user data, synchronize marketplace/cache records, and expose mismatches through doctor checks.
- Storage isolation, outcome lookup and terminal log parsing protect live jobs and retained history; the dashboard groups project sessions more clearly.
- History and conversations move to a separate database with a backed-up, verified migration, yielding ingestion and kill switches, keeping message delivery responsive during large backfills.

Idle-memory and lazy-loading changes remain deferred pending load acceptance.
