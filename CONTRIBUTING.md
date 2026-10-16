# Hosted CI scope

Windows Node 24 runs six Vitest shards of the unchanged fast and integration
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

# Known-flaky tests

Owner rule (2026-10-16): a test that flakes in CI and is not fixed the same week may go
on the known-flaky list, `test/known-flaky.json`. Listed tests are reported but do not
block a merge; every other test still blocks. The list never hides a new failure: an
entry matches only the exact test it names.

How it works:

- `vitest.config.ts` sets `runner: "./scripts/known-flaky-runner.mjs"`. Per test file it
  feeds Vitest's own name filter (the `--testNamePattern` path) with an exact comparison
  against the list, installed in the awaited `importFile(file, "collect")` step, so the
  decision is made at collection for exactly that file.
- It fails open, loudly: the filter's string form matches every test, and after collection
  the runner checks each file (every test that will run was decided by the filter, no
  listed test runs in `exclude` mode, an entry names exactly one test, and the number of
  tests it skipped equals the listed tests collected). Any mismatch fails the run with
  an error naming the file.
- `AGENT_BRIDGE_KNOWN_FLAKY` picks the mode: unset or `exclude` skips the listed tests
  (the normal lanes; they show as skipped and the shard membership checks still pass);
  `only` runs nothing but the listed tests; `off` ignores the list.
- The blocking lanes in `ci.yml` (Linux/macOS jobs, Windows shards) use `exclude`. Their
  step "Known-flaky skips match the list" (`node scripts/known-flaky.mjs skips`) writes
  "skipped by known-flaky: N" per lane to the job summary and fails the job unless N
  equals the listed tests collected in that job and each of them is reported skipped.
- The diagnostic workflows (AB325 daemon lifecycle, AB320, AB319 archive profile, storage
  retention) set `AGENT_BRIDGE_KNOWN_FLAKY: 'off'` and keep running every selected test,
  as before: they run in other modes (for example `AGENT_BRIDGE_DAEMON=1`) that the
  known-flaky lane does not cover. A new workflow that runs Vitest outside `ci.yml` sets
  `off` too, unless it has its own known-flaky lane.
- The CI job "Known-flaky tests (non-blocking)" runs the listed tests on Windows, Linux and
  macOS with Node 24 in `only` mode, in their usual fast/integration lane with the
  usual deadlines. Its test steps continue on error; the report step writes a table to
  the job summary and a warning for each failed entry and each entry that matched no test.
  Its artifacts keep the raw results.
- The job "Known-flaky list is complete and re-checked" (`node scripts/known-flaky.mjs
  validate`) fails when an entry is incomplete, names a missing file, or its re-check
  date has passed (UTC).

Adding an entry (only with evidence from CI logs, never to make a new change pass):

1. Record the sighting on a Pair Desk issue (job link, lane, exact test name).
2. Add an object to `entries`:
   - `file`: the test file, for example `test/ui.test.ts`;
   - `test`: the exact full name as CI prints it after the file, describe blocks joined
     by ` > ` (for example `web dashboard > saves a job's ...`). Only exact test names
     are allowed: `pattern` and `wholeFile` entries are rejected by the validator, and a
     name shared by several tests in one file fails the run;
   - `issue` (for example `AB-410`; a test with its own cause gets its own issue),
     `owner` (the session that re-checks it), `added` (today) and `recheckBy` (at most 7
     days ahead; spread the dates so entries do not all expire together), plus an
     optional `seen` note.
   Evidence means failures on `main` or on several runs; a single sighting on an
   in-progress PR branch is not enough.
3. `node scripts/known-flaky.mjs validate` must pass.

Weekly re-check: by its `recheckBy` date the owner looks at the known-flaky lane results
and the issue. If the test is fixed, or has passed in the known-flaky lane all week,
remove the entry. If it still flakes, comment the re-check on the issue and move
`recheckBy` forward by at most 7 days. An expired entry turns the list check red for
every PR until it is re-checked or removed.

Fixing a listed test: fix the cause (no timeout raises, retries or weaker assertions) and
remove its entry in the same PR, so the fix runs in the blocking lanes again.
