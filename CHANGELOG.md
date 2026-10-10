# Changelog

## 0.30.9

- The dashboard opens a conversation at its latest messages. It used to read every transcript from its first byte, which took seconds for long sessions (a 140 MB transcript) and showed the oldest part first. A paired PC on an older version is still read from the start.
- Loading the dashboard no longer blocks the bridge. The resource-slot view ran a slow liveness check (PowerShell on Windows) for every slot holder, stalling the serving process, broker included, for seconds. The dashboard, `peers` and `resource_slots` now show the slots without new checks; acquiring and releasing still prune dead holders.
- Owner decisions with scope "all" now sync between paired PCs. They are announced when recorded, caught up after a reconnect, and imported with their ids, so nothing is duplicated or rebroadcast. When both PCs decided the same topic while apart, the newer revision is current on both and the other stays in history. Project and session scopes stay on their own PC. Both PCs need 0.30.9.
- A job turn no longer fails at once when its worktree state write waits on a store upgrade behind a briefly unverifiable reader. It retries with a fresh identity check for up to 2 minutes, then fails with the same message as before.
- Opening the job archive no longer fails when a SQLite `-shm` or `-wal` file disappears while the archive path is checked.

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
