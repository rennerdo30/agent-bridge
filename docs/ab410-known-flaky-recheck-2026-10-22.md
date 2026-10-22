# AB-410 known-flaky recheck, 2026-10-22

Candidate for integration into existing PR140, based on
`70820a0fd090bd12f8245e9cf7e51db13a78eef0`. Scope: the nine entries whose
2026-10-21 UTC deadline expired. Entry numbers below refer to that base manifest.
Policy: CONTRIBUTING.md, "Known-flaky tests", weekly recheck. AB-410 remains open;
this is CI evidence, not an owner verdict or a root-cause fix.

## Evidence and method

- Read AB-410's body, plan and 33 existing comments, including the backup-drain
  recurrence warning (36140) and the PR108 quarantine review (36132, 36156).
- Queried both pages of `actions/workflows/ci.yml/runs?created=%3E=2026-10-16&per_page=100`.
  Selected all 125 runs from the first main containing the list,
  [38870273983](https://github.com/rennerdo30/agent-bridge/actions/runs/38870273983),
  through [39697775445](https://github.com/rennerdo30/agent-bridge/actions/runs/39697775445):
  40 main pushes and 85 PR runs, including cancelled runs' retained artifacts.
  Run creation spans October 16 16:55 JST through October 22 09:07 JST. This is the
  scheduled first review interval since introduction, not seven complete 24-hour days.
- Downloaded only `known-flaky-*` artifacts: 468 artifacts, 935 diagnostics files.
  All diagnostics' `metadata.sourceHead` matched the corresponding GitHub run's
  `head_sha`. All observed attempts are 1. Read exact file + full test-name matches,
  not the green non-blocking job conclusion. Every counted execution had
  `complete: true`, no target-file/suite errors, and no unhandled errors.
- There are 467 integration-lane observations per target, across Windows, Linux and
  macOS, Node 22/24 where the workflow selected them. One cancelled Windows artifact
  (run 38933104811) retained fast diagnostics only: no integration pass is inferred.
  A cancelled or missing execution is not a pass. Node patch versions vary by run.
- Entry 25 was skipped in 129 observations from branches predating its listing;
  those are not counted as passes. It executed and passed in 338 observations across
  103 runs since its first listed execution on October 16 18:39 JST.
- Latest completed main evidence is
  [39681057277](https://github.com/rennerdo30/agent-bridge/actions/runs/39681057277),
  source `70820a0fd090bd12f8245e9cf7e51db13a78eef0`: all four removal candidates
  execute and pass on all three OSes. Entries 7 and 16 still fail on Windows.
- Local read-only evidence: `E:/AgentData/reports/ab410-recheck-20261022/` contains
  API inventories, downloaded artifacts and `observations.json` (4,203 exact-match
  rows). Its SHA-256 is
  `888305369861E0E421E257DC29BE1A41D3219F179E4B83EF3AB6AC8847002934`.
  Reproduce downloads with `gh run download <run> --repo rennerdo30/agent-bridge
  --pattern 'known-flaky-*' --dir <fresh-directory>`; inspect
  `integration-diagnostics.json` within each artifact.

## Decisions

P/F/S are actual passed/failed/skipped observations in the review interval.
Removal uses the policy's passing-through-the-review-week condition; it does not
assert a deterministic fix. Renewals preserve owners, issues, added dates and exact
selectors, append the recurrence to `seen`, and advance the old deadline by 3–7 days.

| Base entry | File and exact full test name | P/F/S | Decision |
| --- | --- | --- | --- |
| 1 | `test/daemon-backup-drain.test.ts` — `owned automatic-backup settlement (not whole-core durability) > timeout and second observer leave the same actual capture alive; completion preserves exact accepted bytes` | 466/1/0 | Renew to October 28; settlement recurrence A |
| 4 | `test/daemon-lifecycle.test.ts` — `standalone demand-start broker > UI definitive unavailable creation preserves explicit degraded compatibility only` | 467/0/0 | Remove; restore blocking |
| 7 | `test/dashboard-history-read.test.ts` — `dashboard reads from the history store (AB-383) > serves lines appended after ingestion: a watched change is retained in the next batch` | 466/1/0 | Renew to October 25; raw-read recurrence B |
| 10 | `test/dashboard-history-read.test.ts` — `dashboard reads from the history store (AB-383) > a rewritten file is never served from its stale copy > replaced by a new file whose identity cannot be told apart (Windows ino 0, simulated)` | 462/5/0 | Renew to October 26; replacement recurrence C |
| 13 | `test/history.test.ts` — `authenticated history endpoint and broker API > wakes a backed-off history worker so a new message is searchable within about 2 s` | 466/1/0 | Renew to October 27; search recurrence D |
| 16 | `test/job-recovery-async.test.ts` — `yields throughout a cold archive/run catalog, matches offline recovery and clones only selected jobs` | 451/16/0 | Renew to October 24; recovery recurrence E |
| 19 | `test/job-terminal-handoff.test.ts` — `retains a throwing handoff continuation's accepted queue across persistence and restore until explicit retry` | 467/0/0 | Remove; restore blocking |
| 22 | `test/project-group-takeover.test.ts` — `observes a stored final and consumption receipts on a separate read-only connection before delivery confirmation` | 467/0/0 | Remove; restore blocking |
| 25 | `test/daemon-lifecycle.test.ts` — `standalone demand-start broker > default UI sender hosts an embedded broker and HTTP data cannot opt into the daemon` | 338/0/129 | Remove; restore blocking; pre-list skips excluded |

Recurrence anchors (all Windows Node 24 unless specified):

- A: [38882464624](https://github.com/rennerdo30/agent-bridge/actions/runs/38882464624),
  source `e806875c4a90192a79271fc0b57b4fdfd27eb276`, test line 56:
  `settled=false,pendingWorkers=1` instead of `true,0`. This independently confirms
  AB-410 comment 36140; no harmless-timing or data-loss cause is inferred.
- B: main 39681057277, test line 165: `expected 1 to be +0` (raw-read count).
- C: [39461554223](https://github.com/rennerdo30/agent-bridge/actions/runs/39461554223),
  source `ba1dbc29145c5ee8618ad78c02e8bfd8c9ca762c`, lines 219/266:
  `expected undefined to be true` in `expectFileAnswer`. Earlier failures:
  38897502239 (Windows24), 38901522791 (Windows22), 38917742558 (Linux24),
  38938724894 (Windows24).
- D: [38877815893](https://github.com/rennerdo30/agent-bridge/actions/runs/38877815893),
  source `c35a41b35b37a513696ab31f8dab17122297d4eb`, test line 270:
  `expected [] to have a length of 1 but got +0`.
- E: main 39681057277 and PR140 run 39697775445 (source
  `430e3eecd9cbb2b38ee5d5f7eec895236249bc2d`): unchanged 15,000 ms timeout.
  Other observations include `Job index preparing (backfill running); retry later.
  No control submitted.` This remains an unresolved attribution/fix gate.

## Fix history and remaining gates

Git history since list introduction does not establish fixes for these nine exact
failures. Reachability of each following commit was checked against the base:
`bab84285` optimizes history SQL and adds a different regression; it does not prove
the wake case's cause fixed. `bfaa1f26` changes authority error handling and a
different recovery assertion; the listed cold-catalog case still fails afterward.
`3781e17a` adds unknown-UI diagnostics; it is not a fix for either removed lifecycle
case. Backup, terminal-handoff and takeover test files have no post-list changes.
Unmerged history findings are not treated as fixes present in the candidate.

Static manifest validation and preservation of the other 20 entries are checked
locally. No local tests, provider/runtime probes, full suite, CI dispatch/rerun,
delegation, merge, new PR, install or release was performed. No production code,
test assertion, timeout, runner, workflow or generated bundle changes.

Parent gates: integrate the candidate into PR140, obtain independent review, and
let the resulting hosted CI prove the four restored cases in blocking lanes and
the exact skip accounting. Existing PR140 pinned-integration failure is outside
this package. Other entries still have their original October 22/23 deadlines;
they were not silently renewed. If focused hosted confirmation is needed, use the
existing Node 24 build setup and run (hosted runner only):

```bash
AGENT_BRIDGE_KNOWN_FLAKY=off npm run test:integration -- test/daemon-lifecycle.test.ts test/job-terminal-handoff.test.ts test/project-group-takeover.test.ts
node scripts/known-flaky.mjs validate
```
