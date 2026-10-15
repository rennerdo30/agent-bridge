# Legacy job authority lookup

AB-407 replaces repeated run catalog discovery during asynchronous legacy job
recovery with a durable job-to-run head in `bridge_metadata`. Complete history
rows and validated runner witnesses retain their existing fast paths.

The broker starts backfill eagerly. Requests share the same background operation;
an archive-on-release metadata lease excludes a second process. A cold request
waits at most half of the existing ten-second request budget, leaving dispatch
and transport headroom. The two recovery passes share one deadline. If the index
is still preparing, the request returns `job_index_preparing` with its state and
submits no control. The shared backfill continues after that request ends.

Backfill commits routing facts in tiny batches of eight runs, yielding between
batches. The broker never waits for a competing SQLite writer (busy wait 0);
runner, MCP and worker processes wait at most 40 ms before an index write counts
as failed, so ordinary bridge.db traffic does not clear readiness. History insertion and routing head selection
share the same transaction (or the packer's existing transaction). Completion
requires a complete path observation and no intervening index failure; it does
not require directory timestamps or active feed contents to stop changing.
A crash leaves committed observations intact. Incomplete work reobserves the
catalog on restart and deduplicates identical observations;
it does not erase partial work or source files. Failed attempts retry in the
background with capped exponential backoff independently of requests.

Loose metadata that is malformed or not a JSON object does not stop backfill.
Its bytes stay where they are; the run is recorded as an observation with no
usable metadata and no routing key (neither its job field nor its filename can
prove a key). Sharing and IO errors stay retryable.

A miss on a ready index never clears readiness. The request re-observes that key
only: runs whose legacy filename names it, plus runs whose log or metadata changed
since the last complete observation. Concurrent misses share one pass inside the
request budget; if it cannot finish, the request returns `job_index_preparing`.
A completed miss is remembered for that completion generation for 30 seconds, so
repeated or mistyped refs cause no rescans and no invalidation receipts.

Feed creation and routing metadata changes publish exact routes. Progress,
session and other context-only patches write no index rows; exact lookups read
current metadata. Archiving and packing update those routes to their retained
locations. Distinct observations stay in
`job-run-history-v1`; only `job-run-head-v1` routing heads are replaced. There is
no deletion or retention limit in the index, but unchanged routing facts add no
history rows. Failed auxiliary updates invalidate completion and schedule repair;
successful writes cannot stamp readiness over an earlier failure. A failed index
write also appends a content-free invalidation receipt outside SQLite, so a
contended database cannot hide the failure from other processes or a restart.
Completion records that receipt's exact file identity. A failed index update does
not abort feed startup after required metadata is safely retained. Existing
archive/packing machinery continues to retain source bytes.

After completion, recovery reads a single routing head and its exact files. A
file that changes between two reads, or a transient read error, fails only that
lookup with retryable `job_index_preparing`; readiness stays. Metadata that no
longer parses yields no run for that key. Only a moved route (a path an index
update did not follow) clears readiness and schedules reindexing. On the broker
that invalidation appends its receipt asynchronously, never with a synchronous
fsync on the event loop.
Loose metadata is reobserved on every recovery pass, with containment and file
identity checks. The index discovers context; it does not grant control. Run
metadata must match the requested job. A present generation must match history
when history knows its generation. Older runs with no metadata or no generation
are accepted only as a single exact-key candidate.
Ambiguous legacy keys use discovery within the same cold deadline and never
select the newest unknown generation blindly. A moved route invalidates readiness
and schedules reindexing. Non-Bridge discovery failures return retryable
`job_index_preparing` too. Current registry ownership, grants, native generation,
and post-header authority fences
remain authoritative. Broker shutdown cancels background discovery before
closing metadata handles. Synchronous recovery uses the ready index too and keeps
discovery available while cold or when legacy candidates are ambiguous.

## Upgrade window

The completion record stores a schema number and the writing Bridge version.
Broker startup invalidates the index once when the record has an older schema or
was written by an older version, then rebuilds it. Processes started from an
older version that are still running after the upgrade (an MCP server or runner
that predates the index) may create or move runs without index rows. Such runs
are found by the per-key re-observation above (new or changed files, or a legacy
filename) or by the next broker start; a moved route clears readiness. Archiving
records a failed route update and keeps archiving the remaining runs.

Focused coverage is in `test/job-run-index.test.ts`,
`test/job-recovery-async.test.ts`, and `test/job-recovery.test.ts`.
