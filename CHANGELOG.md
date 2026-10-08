# Changelog

## 0.30.3

- Authority reads use bounded backoff and explicit retry-later errors. Durable sends reuse their message identity across busy/timeout retries and retain conservative stored/unknown outcomes.
- Ask completions retain independent versioned receipts, including recovery from paired native tool records. Stale active records are repaired with a backup and archive; older results cannot finish newer continuations.
- Unsupported ordinary job mail is rejected visibly before storage. Legacy ordinary envelopes remain unread rather than being silently consumed; granted sibling and supervisor control channels retain their existing contracts.
- `worktreeRoot` and `AGENT_BRIDGE_WORKTREE_ROOT` select the root for new local and remote jobs. Existing worktrees retain their saved paths.
- History imports run in the isolated worker, verify retained bytes before advancing cursors and pause at the configured storage budget. `history-archive` creates verified compact snapshots and compressed copies while preserving originals and every prior archive. Verification failures latch until explicit retry.
- Automatic checkpoints include tracked changes and explicitly staged new files. Unstaged untracked build outputs and private files remain on disk and are named in the report.
- Windows worktree edits default to full access when the general sandbox is unset/read-only. Explicit read/ask and configured sandbox overrides are preserved. Cancelled jobs have their own status across runners, protocols, retained history and the dashboard.
- Savepoint cleanup preserves the original SQLite error after automatic rollback.
- The default test lane is fast; `test:integration` runs native process, pipe and storage fixtures. CI runs both lanes on every platform. Hook tests verify wait/budget behavior without fixed wall-clock assertions.

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
