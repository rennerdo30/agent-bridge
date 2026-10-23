# AB-458: 431 opener fixtures and R30 phase corrections

Base `431918eb375c35b870977cfe2ccdc71dfb639cd3`, existing PR141 branch.
Parent R30: AB45843060; implementation milestone AB45843062. The new frozen
head/tree, complete incremental/cumulative inventories, own PIDs, exact exits,
raw commit headers and hashes are in the external r31 validation/handoff receipts.
This document supersedes no prior evidence: R30's 80 tests ran at871ef76a, with
only the affected test and noEmit repeated at431918eb. Those heads remain distinct.

## Proven defects and effect boundaries

| Finding | Cause and correction | Preservation / meaningful regression |
| --- | --- | --- |
| Archive opener fixtures168/191/212 | The fixture compared `PRAGMA busy_timeout = 3000`, but R29's policy helper emits `PRAGMA busy_timeout=3000`. The expected injected exception never happened. Match the actual native WAL configuration phase instead of a wait-policy spelling, after executing its real SQL. | Original capture identity, initialization/close outcome, strong retention, exact source bytes/BLOB and129 distinct captures/overflow assertions remain. Assert injection exactly once. Every unexpectedly successful returned handle is owned by fixture teardown, even when the assertion fails. No production catch was relaxed. |
| Native init/close versus support inspection | A support-policy read failure must not be confused with successful initialization or silently swallow an actual init/close failure. | Six additional ordinary opener-under-admission cases preserve the exact init/close-before/close-after Error object and historical capture. Two support-inspection failures occur only after the actual opener returned, must remain explicit AggregateErrors, and do not invent failed native initialization or a close ACK. |
| R30 P2 sidecar adoption after slow phase | `attachStoreCompatibility` could continue ATTACH/BEGIN/adoption/COMMIT after its original deadline. | Check at entry, after initialization and owned close, after ATTACH, before BEGIN, after BEGIN, before each table/fallback write and before COMMIT. Roll back an owned open transaction on expiry; retain original sidecar rows/proofs. Unknown rollback is an AggregateError with both errors, never a success. |
| R30 P2 readiness late success | `return await probe()` accepted a PID after the original10s deadline; connect/auth/ping previously got separate defaults. | Carry one remaining-budget/signal through actual client connect, read-only directory validation, auth, ping and process identity. Check after every await and before readiness/fixture ownership acceptance. Reject late success; preserve an explicit external abort reason and close only the probe's connection. Only auth/ping run: no hello/publication/registration/demand-start/mailbox operation. |

The overlay's ordinary policy is unchanged outside admission. Inside it, the main
handle shares the existing scoped zero-wait policy and exact restoration. An
already returned ATTACH is historical evidence, not authority to begin adoption
after expiry. The owning MessageStore failure path closes its own main connection;
a direct caller retains that connection/attachment for its own close. This helper
does not detach an unproved or foreign attachment. Temporary overlay initialization
handles always follow the existing close/capture contract. Failed adoption never
deletes the source sidecar or fabricates mailbox namespace/native/job authority.

Controlled-clock tests use actual canonical MessageStore schema initialization,
actual migration/ATTACH/transactions and real scratch SQLite. Six slow phases are
initialize/close/attach/begin/adopt/before-commit. Main rows and original sidecar
bytes remain unchanged on refusal. A fallback test expires after a real sidecar
write and requires rollback of both main adoption and sidecar updates. A positive
reopen test requires exact-once adoption, original UUID and untouched proof BLOB,
owner, authenticated-host namespace and direction. Legacy supplemental route
namespace remains empty; absence is not reclassified as authority.

The readiness tests exercise the real BridgeClient codec and production connect /
request methods over a complete EventEmitter socket transport. Remaining budgets
decrease across connect/auth/ping/identity; late connect/auth/ping cannot reach the
next stage or publish readiness. A suspended auth is cancelled with the exact
external reason, its own connection closes, and a late reply cannot resurrect it.
No real broker, daemon, native process or network session is started.

All synchronous filesystem/SQLite phases are non-preemptible. The contract forbids
starting the next effect after expiry, permits owned rollback/close/policy cleanup,
and never claims to undo a native COMMIT already started while admitted. Original
schema/component/pre-lease/reader/ownership guards and the2s admission budget stay.

## Qualified red and working evidence

- `E:/AgentData/reports/ab458-431918eb-r31-opener-red.out/.err`:
  wrapper27716, PID44068,10s limit,exit1;3failed/4passed/57selection exclusions.
  Production and original fault predicates/assertions are unchanged431. The only
  working fixture delta captures unexpected successful returned handles so the
  red cannot leak SQLite files. This is not unchanged-whole-tree evidence.
- `E:/AgentData/reports/ab458-r31-opener-working.out/.err`:
  wrapper46900,PID64732,10s limit,exit0;16passed/57exclusions, not frozen evidence.
  Includes the corrected opener cases and one mocked-worker backup schedule case.
- `E:/AgentData/reports/ab458-431918eb-r31-phase-readiness-red.out/.err`:
  wrapper70624,PID59664,10s limit,exit1;7failed/8exclusions. Reviewed431 overlay and
  readiness implementations are unchanged; new controlled-clock tests expose six
  late adoption phases and late successful readiness. Other working opener edits
  were outside this selection. Expanded final cases are not all claimed red431.
- Final frozen mocked/offline checks and noEmit are separately source-bound in the
  external receipt. Prior admitted windows total30s; final window is at most25s,
  within the task's aggregate60s. No actual worker/provider/daemon/CLI/UI/TLS,
  stress/contention, full local suite, build, install, release or installed migration.

## 431 CI matrix, including separate cleanup errors

Logs: `E:/AgentData/reports/ab458-ci-job-<job>.log`.

| Exact job | Counts / affected cases | Classification and action |
| --- | --- | --- |
| Linux lifecycle120271256468; Mac lifecycle120271256641 | Each3failed/339passed/44skipped: archive initialization failure168, close-before/after191,129-capture census212, all expected throw but NONE. | Deterministic missed fault predicate, reproduced and corrected. Original assertions preserved; actual lifecycle suites not run locally. |
| Ubuntu full120271256878; Mac full120271256815 | Each3failed/4391passed/133skipped, exactly the same three archive cases; no new unhandled error. | Same root; full CI acceptance remains parent-owned. Passing unrelated cases do not prove older causes fixed. |
| Windows lifecycle120271256250 |5failed/376passed/6skipped; three archive failures plus three afterEachEBUSY errors on archive-closed/before/overflow database or-shm; holder own VitestPID3108. | Separate assertion and cleanup records. Source inspection proves unexpectedly successful returned connections were not enrolled in fixture ownership. The red now captures/closes these exact returns without suppressing close errors; observed Windows errors are consistent with that omission, not evidence to close foreign/unknown resources. |
| Windows shard3 120272764429 |3failed/863passed/13skipped, six error records: same three archive failures and their EBUSY teardown errors; own VitestPID9208 holds archive db/shm/wal. | Same correction and qualification; no extra root, no foreign PID action. |
| Windows lifecycle120271256250 |`daemon-backup-drain`56: timeout/second observer case receives settled=false,pendingWorkers=1,unknown=false instead of true/0/false after pressure release. | Actual completion/IPC/exit stage UNPROVEN in this log. Keep the original2s observer, exact bytes, no kill/stop/duplicate-worker assertions. Add failure-only bounded outcome/exit evidence; no arbitrary messages, payloads, paths or credentials. |
| Windows lifecycle120271256250 |`daemon-readonly`: read-only directory/metadata/real broker auth case fails startup budget at admissionSqliteBusy57 → configureSqlite → openArchive101 → store506. | Failure before intended auth/read-only assertions; guarded identity versus construction phase cost remains UNPROVEN. No auth relaxation, retries of effects or budget extension. |
| Windows shard5 120272764392 |8failed/657passed/8skipped: job-settings exact permission deletion for claude/opencode/antigravity/muse(4); detached next-turn settings; generic→exact including false auto-approval; jobs result to spawner inbox; old active jobs addressable after newer history eviction. | All fail startup aggregate admission before their settings/result assertions. Existing2s deadline retained. Unknown future args, exact deletion, noninterruption, false approval, inbox and old-addressability assertions unchanged. No evidence those product paths are broken. |
| Windows shard4 120272764360 |6failed/691passed/6skipped: remote-descendant atomic rejection; move leases beyond capacity/no interruption/original root; approval relay to new supervisor; delayed executor cannot overwrite continuation(handoff=true); newer-format preservation; registry-commit crash replay. | Startup budget at configureSqlite/store497, openArchive/store506 or bounded factory1519 before handoff assertions. All security/ownership/capacity/approval/continuation/data/replay assertions retained. Phase cost remains UNPROVEN. |

The archive predicate mismatch is proven; it is not a blanket explanation for
Windows startup timeouts or a backup worker remaining alive. No constructor
prewarming, automatic unknown-home admission, longer deadline or startup retry is
introduced to make those assertions pass. Controlled-clock overlay/readiness
coverage is phase-contract evidence, not measurement of historical Windows cost.
The forwarded stacks do not contain an elapsed breakdown of identity/probe/main/
archive/history phases. A future failure-only CI phase timing trace, if required,
must use fixed categories/counts and the original deadline, not secrets/raw data.

## Backup schedule qualification

The added offline test calls actual BackupBackground.start and its registered
message/exit handlers, with only fork replaced by one exact EventEmitter transport.
The compile boundary is refused; no native fork/build fallback exists. Actual
messageBackupIfDue copies a tiny owned fixture through a controlled checkpoint;
its original UUID and BLOB match the resulting verified backup. A first observer
expires while the copy is suspended, a second observer cannot claim it, and a
later verified-copy IPC still cannot settle before the exact worker exit. A late
exit permits a fresh witness but does not retroactively turn the earlier timeout
into success. No accepted worker is terminated, replaced or prematurely closed.
This proves the simulated schedule's contract, not the historical CI cause.

The original native backup fixture now prints only bounded counters for verified /
not-due / error / other IPC, observed exit, pending worker count, unknown flag,
elapsed cap, connected flag and exit/signal categories if completion fails. All
original assertions, process cleanup and2s deadline remain. No native run is done
locally. Earlier b4 and historical residual matrices remain cause-qualified,
including cancelled RPC TOOLERRORinvalid-evidence rather than successful cancel.

## Preserved gates

Protocol8 / metadata3 / runner-ledger-v2 / pairing1 / SQLite14 / JSON4 unchanged.
All13 protected methods/pins, UI/normalizer, preservation guard and flaky candidate
bytes unchanged. No new pin or compatibility approval is requested. Parent fresh
R31 review and hosted full/lifecycle/native gates remain mandatory. Shared archive
access is separately authorized; no per-recipient archive confidentiality claim.
