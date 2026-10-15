# Hosted CI scope

Windows Node22/24 runs six Vitest shards of the unchanged fast and integration
lanes. Files are packed into shards by measured duration (`scripts/test-shards.mjs`,
greedy longest-first over the median Windows file times in
`scripts/test-shard-timings.json`; files without a timing get its default weight).
Refresh the table from downloaded `tests-windows-*` artifacts with
`scripts/update-test-shard-timings.mjs`; `node scripts/test-shards.mjs 6` prints the plan.
Install, typecheck, build, test and committed-bundle stages remain; Linux and macOS keep their existing lane behavior and result artifacts. CI calls the
released generic test runner directly with shard/report arguments. No local
Windows pretest, ACL cleanup, compiler or VHD machinery is part of this PR.

Before execution, `check-test-shards.mjs --collect` runs once per Node version in its
own Windows job, publishes `shards.json` as an artifact, and imports setup/modules and
evaluates registration code without running unsharded test callbacks/hooks. It
uses a fresh physical portable fixture root outside the repository and separate
per-lane project caches. Pinned Vitest5.0.2 cache derivation is checked against
actual resolved/physical config; execution uses the independent released cache.
These hosted fixture directories are retained for the runner's own lifecycle.

The collect job proves the six collected file/case partitions are disjoint and complete;
each shard job downloads that inventory and then checks its executed shard against that exact inventory by project/file and
deterministic Vitest module/case IDs. Full names/runtime parameters remain
informational. Counts are discovered from the new source; historical counts do
not transfer. Checkout/source head, Node/Vitest/platform, event/run/attempt and
census digest bind the evidence (a "re-run failed jobs" attempt may reuse the
inventory of an earlier attempt of the same run, never a later one); accepting a Node/event group requires all six
job artifacts with matching source/runtime and census digest. If setup-node resolves a
newer Node patch for a later re-run, that reuse fails with "source/runtime differs";
use "Re-run all jobs" then.

Artifacts retain actual passed/failed/skipped cases and raw errors labelled
`unclassified (cleanup/teardown or assertion)`. Membership is not failure-cause
proof. Failed tests still fail their jobs. Missing/duplicate/omitted identities,
changed collection skips, incomplete/malformed/module/suite/unhandled evidence
fail accounting as UNKNOWN; a surviving partial census is not a pass. Always-run
checks/uploads retain available evidence after failures.

AB-283 remains open. Old local/native sharing, hard-link preservation and compiler
fixture failures stay retained in reachable563e history and review/report packets;
removing that machinery from this PR does not waive or resolve them. New hosted
census/runtime/timing evidence and independent review remain separate gates.
