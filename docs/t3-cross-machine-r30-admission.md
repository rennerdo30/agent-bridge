# AB-458 R29 correction package and b4 CI residual matrix

Base: `b4b6f7028c5e8ed8ca483bbe138467e0f5acb4c6`, PR141,
`t3/fix-t3-cross-pc-messaging`. Parent findings: AB45843049. Progress: AB45843054.
The frozen result, exact head/tree, process exits, complete file inventories and
raw-log hashes belong to the external `-r30-validation.json` receipt. This document
does not label working-tree checks as exact-head verification. Parent fresh R30
review and hosted full/lifecycle/native gates remain required.

## Contract and correction

| Boundary | Proven defect / correction | Evidence and limits |
| --- | --- | --- |
| Snapshot → source transaction/schema | A completed snapshot could return after admission expired, then begin a schema transaction. Check the original scope before the next phase; check after schema and before commit. | Real scratch SQLite and actual snapshot/component migration paths; controlled clock advances after snapshot or actual schema execution. Original body BLOB, UUID, owner, schema/version and verified backup remain. |
| In-progress migration → expiry/cancellation | Migration needs an owned rollback, not another recovery phase after expiry. Track the open source transaction and roll it back when admission fails. Snapshot handles close even if schema observation fails. | Mid-schema and post-savepoint-release expiry cannot commit; explicit cancellation retains its own error. Original rows/backup survive. Ordinary failed-migration append-only recovery is checked separately. |
| History constructor / view refresh | Custom history DDL has its own transaction, independent of `migrateSqlite`. Apply the same checks before begin, individual rename/index/view phases, schema, version and commit. | Actual `openHistoryStore`, controlled slow begin/schema, rollback and exact original rows; no committed v2 objects or retained writer transaction. No native/history worker launched. |
| SQLite scope exit | Cached metadata was permanently changed to busy_timeout=0. New returned archive/history handles also retained zero. Capture each exact handle's prior policy (or a new handle's ordinary policy), temporarily cap it, restore on success/error/cancel. | Success/failure/cancel, nested/reentrant, native close/reopen, different replacement connection, explicit legitimate policy changes and new nested handles. One mocked short writer verifies the restored policy permits the original post-admission write without real contention. |
| Nested policy owner | A job-index discovery wait could replace zero with its separate 40 ms policy, then leave the cached connection at zero. Clamp that existing policy to the current admission scope; keep its ordinary outside-scope policy. | Source callgraph proof and a dedicated production discovery regression. Its separate 3-second working red probe timed out before any assertion result; it is not claimed as a meaningful red. Final frozen inclusion is reported independently. |
| Scope cleanup → hosting admission | Restoring policy can itself return late. Recheck the original controller after scope cleanup and after the factory await; close the exact constructed but unadmitted store on refusal. | Controlled actual native policy restoration advances the clock past 2 seconds; no store is admitted, all captured native handles close and the owned storage lease is removed. |
| Direct constructor refusal | The safe unproven-reader error omitted the established owner instruction. | Restore “owner-coordinated shutdown” while retaining STORE_READER_ACTIVE/unproven classification and original evidence. The existing old-reader/no-backup-effects assertion is unchanged. |
| Successful suspended census fixture | The Windows-only local path had hidden incomplete POSIX fake socket methods. Ubuntu/macOS constructed the real BridgeClient and threw at setEncoding, leaving the fixture promise pending. | Explicit Linux/macOS/Windows cases, real current-protocol client frame encoding/decoding on POSIX, split reply frames, no auth on unknown Windows pipe; publish p7 only after actual liveness suspension. Finally settle the promise and assert own sockets/descriptors closed. No 120-second timeout increase. |
| Parent-exit fixture readiness | Its initial auth/ping discovery loop retried only absent/refused transport. A tentative reservation's exact typed internal “no request was admitted” reply is not readiness, yet aborted this loop. | Extract the same read-only loop, then permit only that exact typed no-effect reply to retry within the original 10-second deadline. It still throws unauthorized, protocol mismatch, generic internal, ambiguous timeout and untyped lookalikes. The original identity/daemon/PID/effect assertions remain. Actual daemon acceptance is CI-only. |

Policy ownership is synchronous and scoped, not a cached home permission. Nested
checks include every ancestor's original deadline. Temporary observer methods are
removed only if they are still this scope's methods; closed/reopened native
generations and legitimate replacement policies are not overwritten. Cleanup
failures are explicit aggregate failures retaining the original operation error.
Necessary rollback/handle/policy cleanup is allowed after expiry; a new schema or
hosting effect is not. Synchronous filesystem/SQLite calls cannot be preempted:
these checks forbid the next phase and do not promise real-time OS scheduling.

## SQLite/callgraph audit

- Main `MessageStore`, compatibility overlay, archive and history handles register
  their ordinary policy before scoped configuration. Main/archive/history normally
  return with 3000 ms. Metadata new handles return with 5000 ms; cached handles
  recover their exact captured value, including a custom value.
- Metadata new/cached/existing access, component snapshot/schema, main/overlay/
  archive migrations, custom history upgrade/view refresh and job-index nested
  reads retain the original scope. Transaction cleanup never certifies a failed
  source migration as successful.
- Temporary read-only backup/snapshot inspection handles are closed before return;
  their admission wait remains zero and they gain no persistent mailbox authority.
- Job-index ordinary short waits, request-operation caps, daemon durability
  preparation, history worker and dedicated auxiliary stores have separate owners.
  No general SQLite retry policy, daemon serving budget, mailbox authorization,
  maintenance lock or native process policy is weakened. The nested job-index path
  is the only additional ordinary-wait caller changed here.
- `openMessageStore` remains the production stop-bound async factory used by node,
  daemon and authorized offline reindex. Direct synchronous constructors still
  fail closed on unproven retained reader evidence. No awaited proof is cached or
  borrowed by another constructor; no source mutation follows expired admission.

## Qualified red and working evidence

Raw stdout and stderr are retained under `E:/AgentData/reports/`; PID and header
qualification are repeated in the final external receipt. Expanded green cases
are not all claimed to have been red on an unchanged whole base.

| Evidence prefix | PID / limit / exit | Exact qualification |
| --- | --- | --- |
| `ab458-b4b6-r29-residual-red` | 34680 / 5s / 1 | Existing old-reader test, unchanged b4 production/test; 1failed, 161 selection exclusions. |
| `ab458-b4-r29-phase-policy-red` | 29780 / 6s / 1 | Initial phase/policy file: 10failed/2passed against reviewed unchanged b4 implementations. Working recovery text/socket changes existed elsewhere but were outside this selection; not unchanged whole b4. |
| `ab458-r29-correction-working1` | 57172 / 7s / 0 | Working 15passed/46 exclusions; not frozen evidence. |
| `ab458-r29-correction-working-tsc` | 28540 / 5s / 1 | Working noEmit found fake-socket contextual `this` missing emit; corrected explicitly. Header was in wrapper, not empty native stderr. |
| `ab458-r29-correction-working2` | 74252 / 7s / 0 | Working 22passed/43 exclusions, including unchanged ordinary migration recovery; not frozen evidence. |
| `ab458-r29-policy-cleanup-red` | 54388 / 4s / 1 | Actual b4 guard/factory with working policy restoration; late restoration admitted the store. Not unchanged whole b4. Broken-result fixture closes the exact returned store. |
| `ab458-b4-r30-readiness-red` | 27032 / 3s / 1 | Extracted unchanged b4 read-only discovery loop; 1failed/6passed. Other working production corrections are outside this isolated check. |
| `ab458-b4-r30-jobindex-red` | 43620 / 3s / stopped | No assertion result before the own-PID limit. Stopped only that owned PID; no red or green claim. |

The timeout maxima above total40 seconds. The final frozen check is admitted once
with one aggregate20-second test/typecheck budget, keeping this task's aggregate
admitted test windows at60 seconds. Process cleanup/observed elapsed are recorded
separately. No further blind working reruns, real writer contention, load/stress,
native/provider/daemon/UI/TLS/full local suite, build/install/release or installed
migration is part of this package.

## Complete b4 CI residual matrix

All following logs are at `E:/AgentData/reports/ab458-ci-job-<job>.log`. Counts are
CI observations supplied by the parent, not local acceptance. Selection exclusions
and skipped cases are never passes.

| Job / counts | Exact affected test/context | Classification / retained assertion |
| --- | --- | --- |
| Ubuntu120254237827: 2failed/4370passed/133skipped +1unhandled | Suspended-success prior-endpoint test75 timeout; separate uncaught socket.setEncoding TypeError; old-reader test1378 recovery instruction. | POSIX mock codec/cleanup and production diagnostic text proven; corrected here. No full fixture 120s rerun. |
| Mac120254238109: 3failed/4369passed/133skipped +1unhandled | Same two tests/unhandled, plus daemon parent-exit receives Core initializing/no admitted request. | Same corrections plus narrowly read-only readiness discovery correction; native result unverified. |
| Windows lifecycle120254238147: 3failed/378passed/6skipped, FOUR error records | Parent-exit/prohibiting Job Object gets Core initializing; its afterEach EBUSY removing owned temp with no holder reported; UI Continue interrupted retained project-master record fetch ECONNRESET; malformed-command/foreign-restored-job case aggregate timeout at post-constructor store check. | Readiness gap source-proven and corrected. Cleanup holder, UI reset and specific 2s cost remain UNPROVEN. No accepted-request claim from tentative auth; strict ownership/readiness/deadline and all UI assertions retained. |
| Windows shard1 120255336914: 3failed/885passed/1skipped | Old-reader instruction; delivery-settlement “captures all accepted successors and holds false continuation input behind suspended failed retention”174 and “owns a failed refused-note retention before dispatching or settling the queued final”257: suspended flag stays false. | Instruction corrected. Both retention fixtures fail before the injected async sync/retention boundary; delegate/start/identity/admission stage remains UNPROVEN. Keep every accepted note, original UUID/body/intent, continuation barrier and final-blocking assertions. |
| Windows shard2 120255336878: 2failed/654passed/2skipped | codex-hook-manifest “a child Stop without agent_id cannot register a ghost main or supersede the parent's Stop”; “serves main-thread hooks, including null transcript_path, and keeps child-thread hooks out”. | Aggregate startup TIMEOUT at openHistoryStore171/store514 and openArchive68/store504 BEFORE hook assertions. Added affected cases, no new proven cause. Preserve ghost-main/lineage/parentStop/null-transcript/child-denial semantics. No local CLI-hook launch. |
| Windows shard5 120255336957: 4failed/695passed/14skipped +extra afterEach EBUSY | Parent-exit/readiness/cleanup repeat; hook-budget “bounds slow refresh work and retains late mail for the next hook”; “Stop immediately arms one notify wait for running jobs, with no polling”; remote-dashboard-reload paired HTTP “restores paired links and remote peers when a session with stale disabled config takes over”. | Startup timeout stacks include storageAdmissionTimeout → migrationLock37 → upgradeHistoryStore208 → openHistoryStore183 → store514. Specific synchronous construction/guarded-identity cost is UNPROVEN from these stacks. Preserve late mail, notification/no-poll and paired-restore assertions. No budget increase/retry of effects. |
| Windows shard6 120255336838: 9failed/730passed/10skipped | Four native-child forged-scope cases inbox/get_conversation/wait_for_message/search_history; replaced-server session ownership; injected input downgrade; scope-request-failure denial; node-election non-hosting jitter/no broker; established-host immediate election/queued mail. | Aggregate startup timeout configureSqlite/store495 or openArchive/store504 BEFORE privacy/election assertions. Not evidence to weaken any scope/identity/negative effect/jitter/queue guard. Phase/policy source corrections are tested separately; native CI cause remains UNPROVEN. |

The two R29 P2s are actual source defects. They do not prove all Windows timeout
stacks have one cause. The original 2-second admission budget is unchanged. A
later hosted pass is not historical cause proof. Earlier alias-disconnect,
prelaunch cancellation notice, exact takeover exit/publication race, fairness,
quiet observer, HTTP500 and archive-responsiveness cases remain qualified in the
R29 and earlier matrices. Windows120210430813 cancellation returned TOOLERROR
invalid-evidence; it was not successful cancellation.

## Official artifact scope and missing evidence

Run39904827415, Windows lifecycle artifact12480213361,
`ab325-windows-latest-node24-b4b6f7028c5e8ed8ca483bbe138467e0f5acb4c6`,
6524584 bytes, official digest
`sha256:cc501e8e3b0dadad8f3d0b97c32de781ffc50fd16cc41c1cef24189c3d358458`.
Downloaded to
`E:/AgentData/reports/ab458-b4-windows-lifecycle-artifact` (own PID59308,
60s download-only timeout, exit0). Complete `rg --files -uu` inventory:605 files,
601 generated plugin files plus SOURCE_HEAD, manifest.json,
receipt-admission-diagnostics.json and client-count-diagnostics.json. The four
provenance/diagnostic files were inspected; bundles were inventoried, not run or
modified. Receipt_initial_envelope_admission and concurrent_start_client_count
are other fixtures. No affected parent-exit/UI/storage-admission phase timings or
owned-temp holder records exist in this complete artifact inventory. Job logs
listed above give failure stacks, not the missing per-phase timing/holder proof.

No exact historical raw lease/quarantine/ledger bytes were retained in the three
earlier 21-structured-file artifacts either; locations are retained in earlier
matrices. Do not infer incompatible-reader versus incomplete publication or an
EBUSY holder from absence. Minimal additional CI-only measurement, if needed:
bounded failure-only phase entry/exit/deadline classification and exact owned
handle close outcome, with counts/hashes and sanitized categories only. No
payloads, paths, arbitrary exception text, credentials or unrelated config scan.

## Compatibility and handoff limits

No version change: protocol8/metadata3/runner-ledger-v2/pairing1/SQLite14/JSON4.
Component1/2 offline-only automatic-upgrade refusal, legacy/pre-lease exclusion,
exact local/remote ownership and original pending generation/proof bytes remain.
All13 protected method bodies and their baseline, UI/normalizer, preservation
guard and approved flaky candidate are unchanged. No new pin amendment is needed.
Previously approved b4 pin/source/artifact freezes remain distinct; this is a new
source head requiring fresh review. Shared authenticated archive history remains
separately authorized storage, not confidential per-recipient storage. No live
cross-PC acceptance, full isolation or end-to-end confidentiality is claimed.
