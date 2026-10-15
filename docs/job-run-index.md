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

Backfill commits observations in batches and publishes completion only after a
complete, stable catalog observation. A crash leaves committed observations
intact. Restart reobserves the catalog and deduplicates identical observations;
it does not erase partial work or source files. Run directory changes invalidate
completion for legacy writers that do not publish index updates.

Feed creation and metadata updates publish exact routes. Archiving and packing
update those routes to their retained locations. Distinct observations stay in
`job-run-history-v1`; only `job-run-head-v1` routing heads are replaced. There is
no deletion or retention limit in the index. Existing archive/packing machinery
continues to retain source bytes.

After completion, recovery reads a single routing head and its exact files.
Loose metadata is reobserved on every recovery pass, with containment and file
identity checks. The index discovers context; it does not grant control. Current
registry ownership, grants, native generation, and post-header authority fences
remain authoritative. Broker shutdown cancels background discovery before
closing metadata handles. Synchronous offline inspection remains available.

Focused coverage is in `test/job-run-index.test.ts`,
`test/job-recovery-async.test.ts`, and `test/job-recovery.test.ts`.
