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
batches with zero SQLite busy wait. History insertion and routing head selection
share the same transaction (or the packer's existing transaction). Completion
requires a complete path observation and no intervening index failure; it does
not require directory timestamps or active feed contents to stop changing.
A crash leaves committed observations intact. Incomplete work reobserves the
catalog on restart and deduplicates identical observations;
it does not erase partial work or source files. Failed attempts retry in the
background with capped exponential backoff independently of requests. A ready
lookup for a previously unseen legacy key triggers one bounded reobservation.

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

After completion, recovery reads a single routing head and its exact files.
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

Focused coverage is in `test/job-run-index.test.ts`,
`test/job-recovery-async.test.ts`, and `test/job-recovery.test.ts`.
