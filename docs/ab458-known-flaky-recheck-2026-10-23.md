# PR141 known-flaky recheck, 2026-10-23

Scope: only the ten October 22 deadlines reported by
`E:/AgentData/reports/ab458-ci-job-120162616996.log`. Numbers below refer to PR141
head `19355489a96557b0b7b8604020d381941a89a49e`, not the older supplied
`70820a0fd090bd12f8245e9cf7e51db13a78eef0` checkout. This child branch was
fast-forwarded to the exact PR head before editing. PR140's separate nine-entry
review and all 15 nonexpired entries are preserved. Policy: CONTRIBUTING.md,
"Known-flaky tests". AB-410/AB-420 remain open; no cause is declared fixed.

## Evidence qualification

- Queried three bounded pages of
  `actions/workflows/ci.yml/runs?created=2026-10-16..2026-10-23&per_page=100`:
  211 runs in the API snapshot. Selected the 145 runs with retained integration
  diagnostics since the first listed main run, October 16 16:55 JST, through
  PR141's October 23 09:08 JST run: 41 main pushes and 104 PR runs.
  This is the first scheduled review interval since listing, not seven full days.
- Reused the original, unchanged 125-run raw-artifact collection under
  `E:/AgentData/reports/ab410-recheck-20261022/`, but extracted these ten different
  selectors afresh. Downloaded `known-flaky-*` artifacts for 19 newly completed
  runs and the current head's three already-published artifacts. Cancelled runs'
  retained executions are included; absent executions are never passes.
- Counted exact file plus full test-name matches from 526
  `integration-diagnostics.json` files. Every counted execution has
  `complete: true`, exactly one match, no target-file/suite errors and no unhandled
  errors. Every diagnostic's `metadata.sourceHead`, run ID and event match the
  GitHub run inventory. All attempts are 1; OS and Node patch remain per-row data.
  Non-blocking job success is not used as a test result.
- Entries 22/23 are absent from 129 pre-list diagnostics each; those are missing,
  not skipped or passed. Their 397 actual executions span 123 runs, beginning
  October 16 18:39 JST. All other targets have 526 executions across 145 runs.
  The cancelled run 38933104811's fast-only artifact contributes no integration
  execution. No skipped target execution was counted as passing.
- Latest main [39705278070](https://github.com/rennerdo30/agent-bridge/actions/runs/39705278070),
  source `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`, passes all ten on three OSes.
  Current PR [39876301053](https://github.com/rennerdo30/agent-bridge/actions/runs/39876301053)
  also has 30 actual passes: macOS/Linux Node 24.21.0, Windows Node 24.22.1.
  Its source is exactly `19355489`; tested merge revision
  `fd72016cf41f3d3301a8335ceba921c8d56d7d2c` was fetched and its parents verified
  as `5e3fa8aa` plus `19355489`. The merge manifest equals the PR manifest.
  These completed diagnostics do not certify the entire run or this new candidate.
- New inventories, downloaded additions, analysis script and 5,260 observation
  rows: `E:/AgentData/reports/ab458-flaky-recheck-20261023/`.
  `observations.json` SHA-256:
  `2819DEEB475691A8BA78BCE636430B2895EA07E95EDF26D05CEB8B73813B3767`.
  The previous collection's `observations.json` still hashes to its documented
  `888305369861E0E421E257DC29BE1A41D3219F179E4B83EF3AB6AC8847002934`.

## Decisions

P/F/M are qualified passes/failures and missing pre-list observations. Removal
uses the policy's pass-through-review-interval condition, not a claimed fix.
Renewals change only `recheckBy` and append evidence to `seen`; each advances the
old October 22 deadline by 2-7 days. Issues, owners, added dates and selectors stay.

| PR entry | File and exact full test name | P/F/M | Decision |
| --- | --- | --- | --- |
| 2 | `test/daemon-lifecycle.test.ts` — `standalone demand-start broker > actual CLI ui authorized sends use a daemon before/after crash (mobile-configured=false)` | 523/3/0 | Renew October 24; A |
| 4 | `test/daemon-receipt.test.ts` — `source-associated publication UNKNOWN (not controller or durability authority) > SIMULATED reader_native_expiry failure after ORIGINAL COMMIT cannot acknowledge its tentative return value` | 526/0/0 | Remove; restore blocking |
| 7 | `test/dashboard-history-read.test.ts` — `dashboard reads from the history store (AB-383) > serves the newest chat page, forward pages and subagents equal to the file reads, with zero raw reads` | 522/4/0 | Renew October 25; B |
| 10 | `test/handoff-runner.test.ts` — `hands off a blocking ask without returning results or notes to the old caller` | 526/0/0 | Remove; restore blocking |
| 13 | `test/history.test.ts` — `authenticated history endpoint and broker API > exposes broker-owned search and bounded rebuild to clients` | 525/1/0 | Renew October 26; C |
| 16 | `test/job-recovery.test.ts` — `recovers a 0.29.10 backup with current handoff authority and preserves unknown data` | 522/4/0 | Renew October 27; D, AB-420 |
| 18 | `test/muse-job-contracts.test.ts` — `Muse legacy exec profile persistence > keeps the initial profile through continuation and reload, and replaces exact profiles with access` | 525/1/0 | Renew October 28; E |
| 20 | `test/siblings.test.ts` — `sibling job messaging > source-witnessed legacy supervisor assignment > invalidates the assignment on a durable root session change before any skipped import` | 526/0/0 | Remove; restore blocking |
| 22 | `test/broker-queue-expiry-contention.test.ts` — `defers a combined availability/session/rename replay until final-name expiry finishes` | 394/3/129 | Renew October 29; A |
| 23 | `test/remote-jobs.test.ts` — `remote jobs with two paired TLS brokers > starts remotely, applies follow-up settings, returns results, logs on both PCs and shows remote dashboard runs` | 393/4/129 | Renew October 24; F |

Failure anchors, with original source heads retained in every observation:

- A: [39709742483](https://github.com/rennerdo30/agent-bridge/actions/runs/39709742483),
  source `3f86ae286a275bb0b3a86dc34883bcec4223d081`, all three OSes, Node 24:
  `condition not met in time`, lifecycle line 540 and queue-expiry line 219.
- B: main [38917750344](https://github.com/rennerdo30/agent-bridge/actions/runs/38917750344),
  source `eb4273bd5d872050c6e733a3da33d2e9c3a7c30c`, Windows Node 24, line 101:
  raw reads 3 versus 0. Three earlier failures have raw reads 11 versus 0.
- C: [38877815893](https://github.com/rennerdo30/agent-bridge/actions/runs/38877815893),
  source `c35a41b35b37a513696ab31f8dab17122297d4eb`, Windows Node 24:
  `broker request timed out: reindexHistory`.
- D: [39702972278](https://github.com/rennerdo30/agent-bridge/actions/runs/39702972278),
  source `356bbfd3169994386a731e5596c8cbb2a8f95424`, macOS Node 24:
  `ENOENT` opening `archive/jobs-2-new.json`, `archive-fixture.ts:7` /
  `job-recovery.test.ts:55`. Earlier failures: 38880250227, 38884171863
  (`jobs.json.backup-v2-1`, Node 22), 38962476972. AB-420's preservation risk
  remains unresolved; a fixture race versus product data loss is not attributed.
- E: main [39681057277](https://github.com/rennerdo30/agent-bridge/actions/runs/39681057277),
  source `70820a0fd090bd12f8245e9cf7e51db13a78eef0`, Windows Node 24:
  `condition not met in time`, `muse-job-contracts.test.ts:111`.
- F: [39839173808](https://github.com/rennerdo30/agent-bridge/actions/runs/39839173808),
  source `3271b943b306b285abc306f22b9d9f5d633f2f7e`, all three OSes, Node 24:
  `Remote test timed out`, `remote-jobs.test.ts:582`. Earlier Windows24 failure
  38936849352 asserts false versus true. Different symptoms are not equated causes.

## Verification and parent gates

Read AB-410/AB-420 history and reachable Git changes since list introduction.
`bab84285` history optimization is not proof that reindex/wake/raw-read causes are
fixed. PR141 changes ownership-aware fixtures in lifecycle, recovery, Muse,
siblings, queue-expiry and remote jobs; newest passes do not erase their earlier
failed executions. No deterministic cause fix is used to justify these removals.

Static JSON/delta/date/file checks and `git diff --check` verify 25 to 22 entries,
exactly three removals, seven bounded renewals, and the other 15 objects unchanged.
No local Node validator, tests, provider/native runtime, install, full suite,
CI dispatch/rerun, Bridge/Claude/further agents, PR creation, watcher or merge.
Only this document and the manifest change; all source, assertions, deadlines in
test code, runner/workflows and generated bundles retain the PR head's bytes.

Parent must independently review and integrate into existing PR141, then obtain
hosted validator, restored blocking-test and skip-accounting acceptance on the
resulting head. There is no insufficient-evidence removal/renewal in this batch.
If a new exact-head recheck is needed, use the existing hosted Node 24 install/build
setup and unchanged lane budgets, on each OS (commands prepared, not dispatched):

```bash
node scripts/known-flaky.mjs validate
AGENT_BRIDGE_KNOWN_FLAKY=off npm run test:integration -- --reporter=default --reporter=./scripts/ci-reporter.mjs test/daemon-receipt.test.ts test/handoff-runner.test.ts test/siblings.test.ts
AGENT_BRIDGE_KNOWN_FLAKY=only npm run test:integration -- --reporter=default --reporter=./scripts/ci-reporter.mjs $(node scripts/known-flaky.mjs files)
```

Retain diagnostics with `AGENT_BRIDGE_CI_RESULTS_DIR` and
`AGENT_BRIDGE_CI_SOURCE_HEAD` set as in `ci.yml`; `only` cannot verify removed cases.
The full normal CI remains the blocking acceptance gate. The seven recurring
causes and the independent PR141 native/cross-PC acceptance gates remain open.
