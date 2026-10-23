# R24 P1: owned cancellation before remote runner publication

Base `2006221c719639e4a42a6e2db76ca99e4f68e274`, tree
`91045aa8766fd6191eb4d5fe547f6fd587ee7c33`; review AB-45843014.
R23 clean003 and the R24 receipts remain historical evidence, not acceptance
of200 or this correction. Parent owns fresh R25 and hosted acceptance.

## Root and effect boundaries

The200 registered wire handler waited for the entire spawn before handling
cancel. A cancellation received during real reader admission therefore could
not abort its controller; opening admission could publish and launch before
the cancel arrived. Private handle-only cancellation tests bypassed that wait.

The spawn reservation now owns an AbortController, immutable original request,
executor turn/incarnation and captured authenticated return route from before
the pre-record awaits. Its controller becomes the actual startup controller.
Only an authenticated matching cancel can interrupt it. Other controls retain
their wait and cannot execute before admission or borrow another generation.

| Boundary | Actual contract |
| --- | --- |
| Pre-record root/usage/worktree awaits | Check the original controller/current reservation after awaits and before later effects. Cancellation can reach this reservation even before pendingStarts exists. No new owner/address is selected. |
| Accepted cancel before attempted start | Under existing metadata3/JSON4 admission, atomically retain exact original spawn and cancel as existing blocked remote-operation records, plus paired host/fingerprint, peer/supervisor, original typed route, canonical local ledger namespace and incarnation audit evidence. Capture succeeds before abort/ACK. Existing evidence is strictly inspected, never overwritten or attributed to a new owner. The serialized evidence must fit the existing8MiB reader bound. |
| Actual startAsync boundary | After its final await and authority/signal checks, call an optional synchronous non-authoritative observer immediately before actual start/spec effects. The observer records only that an effect was attempted; it grants no routing or execution authority. |
| Proven cancellation before that boundary | Both original RPCs may return the same cancelled/no-live-runner snapshot only from this still-owned live admission after its abort settles. No delivered/final body or consumed receipt is invented. Provisional record rollback/cleanup remains original-generation fenced. |
| Effect already attempted / delayed host completion | Do not invent no-start or put a prelaunch barrier in front of an already admitted runner. Abort the exact admission controller and mark its pending cancellation; when the exact host arrives, the existing durable control path captures cancellation once. All overlapping cancel responses wait for that original result. Failed control/effect completion remains unconfirmed, preserving the admitted host/spec/args. |
| Retention failure | No cancellation acceptance or false abort/ACK. The original caller retains its unknown operation; storage failure is not converted to success. Close still aborts only its own admission. |
| Duplicate / foreign owner / reconnect capability | Same live owner-bound cancel coalesces without rewriting original bytes. Foreign supervisor, changed binding or lost capability cannot borrow the reservation or receive a new acceptance. Existing original-operation live tokens/dedupe remain. |
| Restart / old writer / spec reset | The durable blocked operations remain explicit recovery evidence. No token, resolved state or authority is reconstructed from optional audit fields. Current RemoteJobs spawn and existing actual JobRunners preclaim/publishRunnerSpec reject these records before execution/reset; no automatic replay or delete. |

Prelaunch cancellation evidence remains at
`<isolated-home>/remote-job-states/<original-job-id>.json`, including original
request bytes and namespace/principal proof. It deliberately remains blocked
against same-ID execution, even after an original live RPC confirmed no-start.
If the response is lost or the host restarts, evidence-only owner recovery is
required; there is no automatic reexecution or newly attributed terminal proof.
An interrupted/oversized/corrupt write is never treated as absent acceptance.

The automatic requester spawn-completion callback also checks whether this
original turn already retained a cancel. A confirmed cancel can settle before
a delayed spawn response; the callback must not mint a new explicit operation
and replay cancellation. Explicit subsequent user controls retain their
existing semantics; unknown originals are neither cleared nor automatically
retried. The changed source helper is outside all protected methods/pins.

## Compatibility proof

No wire/schema/capability increment: protocol8, metadata3, runner-ledger-v2,
pairing1, mailbox schema14 and JSON4 are unchanged. Intermediate200 already
reads these same blocked operation states in RemoteJobHost.assertTurnAdmission
and core/runner-store assertRunnerArchiveAdmission/publishRunnerSpec. The new
audit field is not the exclusion primitive. Tests invoke actual normal start
and publication fences without interpreting that optional field. Originals
remain readable/preserved; no installed migration/scan/cleanup is performed.
The established component1/2 isolated-offline admission limits remain.

## Qualified focused evidence

- Unchanged200 production plus initial registered-wire/actual-startAsync reader
  regression: wrapper22084, PID70756,60s,exit1,1fail/20excluded. The assertion
  reaches the actual pending admission controller: aborted=false after cancel.
  Raw commit-headed logs `E:/AgentData/reports/ab458-200-r25-red.out` / `.err`.
  Final text expands phases/negative coverage; it is not claimed identical.
- Additional qualified red: PID72768,60s,exit1,1fail/21excluded, with working
  network correction but RemoteJobHost byte-identical to200. A confirmed cancel
  then delayed aborted-spawn response causes3RPCs instead of the original2.
  Raw header/logs `E:/AgentData/reports/ab458-200-r25-dedupe-red.out` / `.err`.
  This is not labelled an unchanged whole-tree200 run.
- Working initial PID4652 exit0; expanded PID63224 exit0,15passes/9excluded;
  working PID32920 exit0,27passes. Physical process start remains mocked.
  Working noEmit PID80640 exit0. These are not frozen-head acceptance.
- Final wire cases use actual registered extension dispatch/schema, canonical
  job ID, paired ownership minted by the canonical store helper, actual
  startAsync/readiness and actual metadata/spec/cache persistence. They suspend
  identity readiness, cancel before release, and prove no spec/publication or
  launch afterward. Pre-record, duplicate, foreign supervisor, held C2, failed
  capture, restart/normal start and late-host success/failure are separate cases.
  Existing helper-only tests stay qualified as such; no provider/TLS launch.
- Exact frozen head/tree, raw commit headers, own PIDs/timeouts/exits,
  aggregate60s run, complete and incremental inventories, and protected-blob
  comparisons: `E:/AgentData/reports/ab458-pr141-<head>-r25-validation.json`.

## Runtime matrix carried forward and exact200 additions

All003 roots and unproven Windows peers/UI/archive stages remain in
`t3-cross-machine-r24-residuals.md`. Passing a later case does not prove its
earlier cause. No original assertion, ten-job count, exact-once/unavailability
condition, original session poll or deadline is weakened.

| Exact retained log / case | Bounded retained facts | Root / acceptance qualification |
| --- | --- | --- |
| Ubuntu120209150468, unavailable primary, c104be9f/PID11911 | Final message3f47b568-386d-53ab-8d37-b3a0b67852e1 refused protocol_mismatch/source unspecified. FinalDelivery retained/permanent-refusal/persisted=true; retainedDeliveries1, report present, delivered=false, runner dead, no envelope/route/consumption. | Specific protocol refusal UNPROVEN. Runner reports retained evidence; original quarantine bytes were not independently available/verified here. Not evidence of mailbox delivery or proof of the earlier silent-loss cause. |
| Windows2/120210430810, closed primary,83e5a245/PID11168 | Final50e898b0-8551-55cc-8948-0c0235019f40 has the same recorded refusal/retention family, report present, delivered=false and no envelope/route/consumption. | Specific cause UNPROVEN; not inferred identical to Ubuntu. |
| Same Windows2, opencode primary,d903a926/PID7752 | Finalddd655f7-7847-5b84-8f3b-9d97f276e98a has the same recorded refusal/retention family and absent mailbox effects. | Specific cause UNPROVEN; no real opencode/native takeover run locally. |
| Windows3/120210430756, quiet fake-Claude observer | hookError=false, emptyResponse=true, peerSeen=true, session missing, no retained hook events. | Publication root UNPROVEN. Original poll, identity and no-unsolicited-notification assertions retained; no Claude execution. |
| Windows5/120210430813 approval roundtrip/cancel,579/629 | Answered assertion, both cleared queues and repeated-answer expiry pass. The cancel RPC returns TOOLERROR `Runner delivery retention remains unsettled (invalid-evidence)` at579; the old text helper flattened it without asserting `isError`. The later executor cancelled-state wait fails before the original PID-death assertion. | Corrected per AB45843025: RPC return did NOT establish cancellation acceptance. The invalid-evidence cause remains UNPROVEN. The fixture now requires successful RPC acceptance before the unchanged state/PID waits. Bounded job/operation diagnostics do not grant recovery or execution authority. |

Locally searched the four named exact200 logs plus directories under
`E:/AgentData/reports` matching ab458 and200/120209/120210. No matching retained
fixture/artifact directory was present. The earlier2d3 Mac artifact is not
evidence for these exact200 jobs. Specific raw refusal frames, executor return
codes and exact retained quarantine bytes therefore remain unavailable here;
parent owns artifact retention/hosted diagnosis. No unrelated config/secrets
were scanned.

All13 protected methods/pins, UI/normalizer, retention guard, approved flaky
files and version gates remain unchanged. No local native/provider/daemon/UI,
TLS, actual contention, full suite, build, install, migration, release,
Bridge/Claude call or further agent. Fresh R25 review and hosted full,
lifecycle/native/paired-TLS/ten-job acceptance remain mandatory.
