# AB-458 R28 corrections: one deadline-owned store admission

Parent brief: AB45843042, base `5cee44d71ae82c3180e243c9d78689a75b420dc2`.
This is source/offline evidence; parent R29 and hosted full/lifecycle/native gates remain required.
No installed home, provider, daemon, native UI, TLS session or full local suite was run.

## Findings and effect boundary

| Finding | Root | Correction / qualified regression |
| --- | --- | --- |
| P1 successful suspended census | The prior endpoint pass preceded awaited liveness; successful unchanged census returned directly. | Probe known prior endpoints again after successful census, then synchronously revalidate exact census evidence before the effect. The new test suspends the actual identity query, publishes p7, resolves a genuine gone-owner result and requires refusal with no storage callback. |
| P2 constructor repeats old probes | A completed guard expired its controller before `MessageStore` repeated synchronous OS creation queries at both census sites. | `openMessageStore` runs actual construction inside the original controller/deadline. Proof is private-issued, exact-byte/inode/time scoped, freshly checked at each constructor census, and unavailable to later direct constructors. Synchronous direct constructors conservatively refuse unknown/PID-reuse evidence without starting a query. |
| P2 cold shared helper escapes cancellation | `readyHelper()` could create worker/PowerShell before a signal listener, with independent 15-second startup and 5-minute idle lifetime. | Signal-owned identity queries never start a cold shared helper. They use an existing ready helper or an independently signal/remaining-budget-bound fallback. Aborting/timing out one ready-helper query removes only that request and sends its exact cancellation ID, preserving other helper owners. A separate ongoing cold startup remains owned by its original caller. |

Own creation identity needed by constructor metadata/migration locks is prepared asynchronously within the same admission budget. Existing session identity warmup or other shared helper owners do not become owned by this census. A deadline-owned query cannot retire their helper. Explicit external cancellation retains its reason. Internal timer/backoff expiry is normalized to `BridgeError(timeout)`; a completed incompatible-reader observation remains `protocol_mismatch`. An incomplete historical lease is never promoted to a completed incompatible declaration or a safe reader.

The proof includes the original lease file identity and exact bytes; no old lease is rewritten to make it compatible. New/changed unproven evidence refuses. PID reuse can be admitted only from the bounded asynchronous identity result and still-matching evidence. Constructor error callbacks are never replayed by the census retry loop. Failed/expired constructed stores close their own handles; partial construction retains the existing lifecycle capture/cleanup contract.

## Production callgraph audit

| Entry / nested path | Admission behavior |
| --- | --- |
| `BridgeNode.elect` | Read-only early preflight retains caller-stop cancellation and existing compatibility refusal. This preflight is not a transferable store grant. |
| `BridgeNode.tryBecomeBroker` | Tentative endpoint reservation owns no mailbox authority. Stop-bound `openMessageStore` replaces guard-then-constructor; failure closes the exact reservation. This one protected method needs parent pin review; baseline remains unchanged. |
| `runBrokerDaemon` | Early read-only preflight retained; after exclusive reservation, the same factory guards the actual store, preparing own identity inside its budget. No daemon launch/replacement is added. |
| `runReindex` offline branch | Factory checks the actual selected database before creating its store. Connected maintenance still uses exact authenticated current-broker RPC. |
| `archiveHome` / direct `MessageStore` | Explicit synchronous maintenance retains conservative constructor refusal, pre-lease schema refusal and exclusion lock. It cannot borrow a prior async proof or synchronously query PID-reuse evidence at either mailbox census. It is not automatic hosting admission. |
| Main migrations / compatibility overlay / archive / history constructors | Inside factory effect scope, SQLite busy timeouts are zero rather than independent 3-second waits. Busy propagates to existing async caller/re-election handling; no busy means compatible inference. Main/overlay migration lock refuses busy without `Atomics.wait`. |
| Metadata new/cached connections / component migration / metadata leases | Scope checks precede opens; newly configured and reused metadata handles have zero SQLite wait in this effect. Metadata lease acquisition has zero wait and no detached discovery. Existing component1/2 offline-only boundary and maintenance exclusion remain. |
| Nested legacy capability/liveness fallback | Synchronous process identity/name/batch APIs return unknown inside the construction scope; they cannot start separate 5/15-second queries. Detached identity discovery is deferred, not treated as absence. Outside the scope the general policy remains. |
| Post-open broker services, backups, history ingestion | Existing service/effect ownership remains. No early guard proof is cached for later services or mailbox actions. This change does not admit old readers or change delivery/ACK/owner authorization. |

This bounds query, inspection, retry and lock-wait policies with one 2-second controller. Synchronous filesystem/SQLite system calls are not OS-preemptible; this is not a real-time scheduling guarantee. Busy operations fail closed and no newer pass/effect may start after expiry. Endpoint observations are not a migration exclusion lock. Common-lock exclusion, component1/2 automatic shared-home refusal, and owner-coordinated unsupported cached/pre-lease-writer limitations remain as documented previously.

## Focused evidence

Three new regressions were red against unchanged 5cee production (only new test source added): suspended-success endpoint admission, actual constructor synchronous query, cold deadline-owned helper startup. Raw commit-header logs: `E:/AgentData/reports/ab458-5cee-r29-red.out` and `.err`, wrapper15404, PID26016, timeout8000, exit1, 3failed/48excluded. No relocated production imports or working client changes are used for this new red.

Working pass and final exact-head results belong to their respective receipts; working-tree results are not exact-head green. The earlier R28 red remains qualified: relocated frozen5f imports and working client cleanup, not an unchanged whole-tree5f run. No local standalone bundle/compiler case is included. Exact frozen raw headers, own PIDs, exits, budgets, full incremental/cumulative inventories and preserved hashes are in the external R29 validation receipt.

## Residual CI matrix (cause qualification retained)

| Exact source / logs | Failure and present conclusion |
| --- | --- |
| 5cee Windows lifecycle120243822771 | `daemon-windows-paths` Modify ancestor ACL negative received safe budget refusal before ACL policy. Semantic negative now uses a controlled clock around the unchanged native verifier; exact unsafe_acl/foreign_write/ancestor/depth2 assertion is retained. Separate expiry/late-helper assertions and production budget are unchanged. Native ACL execution NOT RUN locally. |
| 5cee Ubuntu120243822915, Mac120243822746, Windows4120244604489 | `store-deferred-hosting` empty retained lease expected old protocol refusal, got timeout or ABORT_ERR. Empty publication is unproven, not a completed incompatible declaration. Actual bounded tests distinguish external explicit abort, internal deadline, and completed incompatible refusal. CI fixture now requires exact timeout and retains all no-schema/backup/body/read-state changes and live old-reader assertions. No broad error allowance. |
| 5cee Mac120243822746 | Remote prelaunch cancellation: saved host=null passed, original cancellation notice not yet in deliveryHistory. Cause UNPROVEN. No synthetic runner/log/state or notification is created. Original visibility assertion remains. |
| 5f Windows1120235009787; 5cee Windows1120244604491 | Collision-allocated alias reconnect succeeds, then exact peer-removal observation after client.close times out before offline-owner/impostor checks. Auto-reconnect versus delayed removal remains UNPROVEN; no reconnect disable/deadline change. |
| 5f Windows lifecycle120234003315 | First five actual daemon UI sends returned500, before crash/status stages. Failure-only bounded HTTP diagnostics were added earlier; cause still UNPROVEN. Exact official 605-file artifact inspected: 601pluginfiles plus SOURCE_HEAD/manifest/two unrelated bounded diagnostic JSON files; no first-five HTTP admission evidence. |
| 0c3 Ubuntu120228403717 / Mac120228403755 | Exited runner finals classified storage-reader protocol refusal. That family is identified, not the exact historical reader/publication race. Three earlier official artifacts each inventory21 structured files, no raw lease/quarantine/ledger bytes. Bounded publication schedules preserve unknown/fresh-old-reader refusal. |
| Earlier 1b/200 takeover variants, Windows fairness/quiet observer/peers/UI/archive responsiveness | Still UNPROVEN historically. Later CI passes do not prove cause. Windows120210430813 cancellation was TOOLERROR invalid-evidence, not accepted cancellation. Original ten-job/exactly-once, quiet-client identity, responsiveness and native process/receipt assertions remain. |

Protocol8, metadata3, runner-ledger-v2, pairing1, SQLite14, JSON4 are unchanged. All original persistent proof columns and content remain. No pin baseline, UI, normalizer, data-retention guard or approved flaky candidate is refreshed. Shared authenticated archive history retains its separately authorized access contract; no end-to-end/per-recipient archive confidentiality is claimed.
