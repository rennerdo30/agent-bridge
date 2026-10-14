# Hosted CI scope

Windows Node22/24 runs four Vitest shards of the unchanged fast and integration
lanes. Install, typecheck, build, test and committed-bundle stages remain; Linux
and macOS keep their existing lane behavior and result artifacts. CI calls the
released generic test runner directly with shard/report arguments. No local
Windows pretest, ACL cleanup, compiler or VHD machinery is part of this PR.

Before execution, `check-test-shards.mjs --collect` imports setup/modules and
evaluates registration code without running unsharded test callbacks/hooks. It
uses a fresh physical portable fixture root outside the repository and separate
per-lane project caches. Pinned Vitest5.0.2 cache derivation is checked against
actual resolved/physical config; execution uses the independent released cache.
These hosted fixture directories are retained for the runner's own lifecycle.

Each job proves the four collected file/case partitions are disjoint and complete,
then checks its executed shard against that exact inventory by project/file and
deterministic Vitest module/case IDs. Full names/runtime parameters remain
informational. Counts are discovered from the new source; historical counts do
not transfer. Checkout/source head, Node/Vitest/platform, event/run/attempt and
census digest bind the evidence; accepting a Node/event group requires all four
job artifacts with matching source/runtime and census digest.

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
