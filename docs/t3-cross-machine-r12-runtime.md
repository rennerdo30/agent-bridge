# AB-458 runtime continuation after R12 static review

Base: `2d3a6c8de2a2d73527c44d33fd39e4680281c7bd`. R12 static clean
(AB45842494) is not runtime acceptance. Parent owns hosted integration/full tests.

## Evidence and classification

| Evidence | Classification / action |
| --- | --- |
| Mac120012581098, final-report diagnostics: nine exact master copies stored; runner30789e6a still alive, terminal report retained but `delivered:false`, no final envelope/route/consumption, durable supervisor record still running | Actual unresolved wait. Running supervisor metadata is expected until its live runner finishes delivery/exits; it does not by itself prove an invalid grant. The official artifact `tests-macos-latest-node-24-attempt-1` (12450731136) contains structured results/census/diagnostics only, no retained fixture/raw runner logs. Structured diagnostics confirm timeout but provide no additional refusal. Specific causal attribution is unavailable. |
| Actual registered job sends while original supervisor ownership is temporarily absent from its durable projection | Demonstrated production defect: preflight grant failure selects the ordinary send-intent path; later authorization rejects, leaving an intent without destination/copy/grant. Subsequent exact retry cannot route after proof returns. Refuse before persistence; do not turn unavailable authority into ordinary routing. Keep original request/grant/copy admission transactional. |
| Actual registered job sends while archive authority read throws SQLITE_BUSY | Demonstrated production defect: `storedJobs()` returns no current row and the report falls through to ordinary exact-name mail, bypassing supervisor routing. Refuse with retryable `job_index_preparing` before any intent/copy. Resolve genuine remote-hosted jobs through the same authorized durable registration source already used by hello; no new caller-supplied authority. |
| Windows120014661783, pure stored-final/read-only-consumption fixture, metadataFileLease line125 | Fixture omits async own-process identity admission. The exact source line refuses because `processIdentity(process.pid)` is unavailable, before migration-lock acquisition. This fixture has no node.start/listen warmup. Await the actual `ownProcessIdentity()` readiness before its first metadata write. Unknown identity still fails; no synthesized process proof or lease recovery exception. |
| Windows120014661690, fresh hook connect deadline | Cause unresolved. Test/source first introduced in d57c277a (2026-10-08); this historical presence does not prove the failure predates current changes or establish flakiness. Retain six connections, 24 accepted messages, 500ms connect deadline, 40ms synchronous-work model and event-loop yielding assertions. Add bounded aggregate start/completion/connect/setup/synchronous-stage evidence on failure. Do not run that CPU-work fixture locally. |

The Mac quiet notification cases passed this run. Windows remote initial-done
cases passed this run. Neither is claimed fixed across all platforms or causes
merely inferred from a later pass. Ten-job/exact-once/120s assertions stay intact.

## Source contract

Every new local job report requires current durable job authority and its
original supervisor grant before entering persistence. A temporarily missing
row is not permission to use ordinary name routing. A temporarily missing grant
must not leave a request-only intent. Existing stored copies can still be
inspected/replayed by their exact original sender; old orphan intents remain
preserved/refused, never silently rerouted or reattributed.

There is no new schema/protocol/pairing gate. Typed delivery evidence is optional
diagnostic JSON in the existing runner-state row, not a route, receipt,
ownership, process-liveness or continuation grant. It records only enums,
timestamp, bounded attempt, message UUID and whether a final is waiting. It
captures actual send/receipt/queue phase and a preceding note's bounded retry
reason. Existing heartbeats retain the latest observation without a new writer
on the hot path; an undelivered terminal refusal is flushed before exit. Remote
wire schemas may omit it; CI reads each isolated host's actual state row.

The diagnostic reader validates a strict allowlist, emits neither prompts,
bodies, owner proof strings nor exception text, and keeps its read-only SQLite
boundary. Tests include a note retry whose final is queued and a rolled-away
oversized log prefix. The new retry observer cannot swallow a permanent error
or change retry count, even when the observer throws.

## Qualified regressions

- PID66932, exit1, 60s bound: **base2d3 source plus corrected new regressions**.
  Two meaningful failures: retained intent despite rejected report, and ordinary
  storage despite failed job authority read. Initial PID78652 also reproduced
  the orphan intent; its second case had an incorrect fixture module import,
  corrected before the qualified base run. Original working source was restored
  after that isolated base check; no foreign files/reset/stash were used.
- PID56768, exit0: both new admission cases green against working fix, with real
  production registration, durable job projection, tracked send and message store.
  After actual original proof restoration, one exact report stores for the
  available project master and deduplicates with unchanged body/UUID.
- PID75012, exit1: strengthened base-broker regression restores the original
  proof and actually retries the same UUID/body. Base then refuses with
  `Original destination was not retained`, proving the stranded retry rather
  than only observing its orphan intent.
- PID73860, exit1: deliberate omitted-refusal-observer mutation makes the new
  bounded-evidence regression fail; the mutation was restored. PID23528, exit0,
  covers an actually admitted paired-host job absent from the local jobs file;
  subsequent wrong-job-alias/wrong-supervisor negatives require the final run.
- PID61452, exit0: eleven focused mocked/loopback/offline cases across five files;
  36 excluded, not passes. Includes atomic rollback, actual terminal retry policy,
  diagnostic privacy/persistence, read-only consumption and protected hash inventory.
- PID62880, exit0: working-tree noEmit before the final test-only evidence additions.

These are working-tree receipts, not runs on a later commit. The final admitted
head/tree, PIDs, commands, exclusions, exits and changed-file inventory are
recorded in the separate exact-head validation receipt under
`E:/AgentData/reports/ab458-pr141-<head>-r12-validation.json`.

No local provider/daemon/native fixture/build/full suite/install/release was run.
All protected method bodies, UI, normalizer and baseline remain unchanged from
the approved2d3 pin amendment. Fresh independent review and hosted gates remain
mandatory. The root fix is concrete; whether it caused the tenth-runner timeout
needs the new per-runner evidence or a hosted green outcome plus appropriate
causal review, not a blanket assertion that the wait is fixed.
