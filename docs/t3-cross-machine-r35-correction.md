# R35 source correction and review boundaries

Frozen source: `7c0538623ef3d6361d80b260e675343aae448012`, tree
`d3dede915a014dc9ae582c966fd27cc536ba9405`. Base:
`a0c27f1f6f9cc40278481ac07b87f11eceeab6c5`. Later artifact/receipt commits
are not labeled exact tested heads. Parent approved design/gates, not acceptance.

## Repairs and actual effect boundaries

| Boundary | Contract and evidence |
| --- | --- |
| Startup services and TCP/network | Mandatory recovery and deferred network setup retain the original check. No optional producer is launched before entire activation. The reserved/nonreserved accept boundary remains tentative. A suspended TCP stage crossing expiry has no archive timer/backups/history/archive worker to run later. |
| Normal serving producers | A broker-owned next-turn task starts optional maintenance only after successful activation. Startup revocation/close cancels that exact task and awaits its settlement. Normal serving checks do not expire just because the task has completed. Existing index stop, worker close and exact resource accounting remain. |
| Ordinary versus cold initialization | Canonical metadata transaction writes an explicit generation/home/store identity stamp. Cold preparation binds it to the external anchor. Current metadata with missing/ambiguous provenance refuses. Creating canonical metadata precedes mailbox migration lock acquisition to avoid recursive lock admission. |
| Lost whole journal/anchor | Independent `.store-bootstrap.expected.json` plus DB provenance require the exact directory and anchor identity. Missing/renamed/replaced/inconsistent evidence refuses cached, direct, no-deadline, restart and final factory opens. A captured witness is rechecked before and after final construction. |
| Parent publication | Bounded root-to-home nofollow directory synchronization and identity revalidation precede schema/evidence effects. Partial anchor/preparing publication is retained and blocks automatic retry. Unsupported durability refuses; no file-fsync substitute. |
| Worker prepared/exit | Existing retained preparing/prepared descriptor/digest and file-identity revalidation stays under owned exclusion before exited publication; fresh final admission follows. IPC failure forwarding uses exact-attempt, fixed stage/reason allowlists, never arbitrary native text/paths/stack. |
| Backup and restore | Full backups preserve namespace, provenance, exact anchor and all journal bytes, including an explicitly proven alternate main DB. Copied metadata/evidence must match the captured source before publication, and the source expectation must still match afterward. Restore refuses bound/ambiguous source or destination before maintenance and displacement. No new restore generation is minted. |
| Local compatibility | Exact protocol10 auth, p9 probes, metadata5. Components1/2/3/4 automatic shared-home upgrade refuse before mutation. Explicit isolated offline admission preserves accepted bytes/snapshots, then mints new ordinary provenance only for the authorized legacy path. |
| Remote compatibility | Pairing1, SQLite14, JSON4, runner-ledger-v2 and recipient/native/mailbox capabilities unchanged. No new remote permission or fallback is introduced. |

`5e3fa8aa:src/core/metadata-db.ts` and `b2066633:...` both declare component1.
The refusal therefore affects homes produced by those source versions, not just
intermediate test homes. No installed home/version was scanned. Endpoint absence
and the common lock do not prove an inactive cached old writer gone; isolated
owner-coordinated offline admission is still required. All these version changes
are unreleased branch states; no installed migration/update is authorized.

## CI classification, without retrospective causation

`t3-cross-machine-r35-ci-failures.json` retains every FAIL header and original line
from nine explicitly supplied exact-a0 logs. Its 893 error headers include 789
distinct per-job headers: 786 reported failed tests plus three suite setup errors.
There are 104 repeated headers, including secondary teardown records. No failures
were discarded to make these counts match. Shard6's two unhandled rejections make
coverage UNKNOWN. Mechanical first-error classifications are triage, not verdicts.

| Root/group | Change and qualification |
| --- | --- |
| Standalone lease helper external `zod` import | New journal dependency was reachable from low-level metadata/lease paths. Replace runtime schema import with bounded strict dependency-free validation. No scratch-package install or weakened standalone assertion. Hosted standalone bundle/child process gates NOT RUN locally. |
| Fourteen remote-supervisor fixture cases on Linux/Mac, eleven on Win5 | Fixture injected an unstarted NetworkService before Broker.listen, so the real readiness guard correctly rejected it. Complete real local admission before attaching the authenticated transport fixture; do not pretend the network started or relax activateAuthority. These transport integration fixtures NOT RUN locally. |
| Six hardcoded current-version cases per Linux/Mac/Win3 | Preserve exact pre-effect refusal and assert protocol10; expand old2..9 negatives in both directions and prior-endpoint cases. Mock broker auth covers old9/new10; broad cross-machine fixture remains hosted-only. |
| Windows broad startup cascades | Generic worker-failed/expiry messages establish unavailable startup, not a specific directory/kernel cause. New fixed allowlist forwarding can distinguish directory publication, metadata/store phases, owned close, prepared publication and native module failures safely. Actual Worker/Windows result remains UNVERIFIED. |
| Windows partial setup/owned cleanup | Preserve every EPERM/EBUSY/undefined teardown record and original assertion. No global ignore, timeout extension or forced foreign cleanup. |
| MCP chat unhandled close | Own each tool promise at creation; retain rejection for the original caller and explicit bounded cleanup settlement. A failed fixture retains artifacts/errors. Delayed rejection helper regression passes; exact historical rename schedule and hosted MCP behavior remain UNPROVEN. |
| Archive identity/broadcast schedules, history reread/notify expiry, cancellation-report history | Kept separately in the matrix/receipt; no evidence establishes the common bootstrap cause for these assertion/timeouts. No altered assertion or deadline. |

The overflow fixture Object.is identity fix from a0 is preserved. Its fresh raw
metadata scaffold now declares version0 and uses the existing canonical metadata
open to mint current provenance; it never fabricates a current proof string or
weakens the exact 129th/130th native reference/close-failure assertions. Its actual
native lifecycle gate was NOT RUN locally.

## Verification and unresolved acceptance

Frozen source has 47 distinct focused mocked checks passing (39 bootstrap,
7 broker admission, 1 owned-RPC helper) and noEmit exit0. All runs, including
failed harnesses, the earlier 8.552s timeout and the offline-census regression,
remain in the receipt. Four qualified red schedules on unchanged a0 production
proved the root defects; the initial leaked-handle matcher and polluted assertion
are explicitly not red proof. No green source claim is made for docs-only heads.

Directory IO and Worker are explicit controlled transports locally. These checks
are NOT native Worker/fsync/Windows/daemon/TLS/provider acceptance. Full backup
verification is not restore authority. AB-461 tracks durable offline restore
generations. Windows unsupported directory durability remains an availability
blocker; compatible populated opens are still journal-fenced. WMI late Create
(`daemon-launcher.ts`, helper phase/30s lifetime versus original startup budget)
remains unresolved: child refusal or unknown latch is not no-start proof.

Historical takeover exit, fairness, quiet publication, UI500, disconnect/alias,
reader classification and rawSourceReads causes are not retroactively proved.
The deliberately shared authenticated history contract remains separate from
recipient delivery/read/ACK ownership; no end-to-end confidentiality claim.

Three protected broker method deltas (startServices, abortStartup, close) await
parent exact artifact review; other ten method hashes, UI and normalizer are
unchanged. Baseline stays untouched. Fresh independent R35 full design/correction
review and hosted actual-worker/full/lifecycle/Windows/native gates are mandatory.
