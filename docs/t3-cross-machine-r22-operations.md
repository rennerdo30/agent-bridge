# R22 remote operation ownership correction

Base: `56edc4b6ad839539ecb7936ace0be384518d121c`, tree
`0a27bf58005d33fede9b9e55d06f20132dec8e47`. AB-458 review42999.
Source/mock evidence only; parent owns R23 and hosted acceptance.

The old job-wide `busy` set owned spawn/poll activity but not ordinary controls.
A suspended control consequently made C2/cancel look like unknown persisted
work. Finishing a different RPC could also clear the whole job's activity.

## Admission and effect matrix

| Path | Authority / effect / cleanup |
| --- | --- |
| Spawn / explicit continuation | Validate public request before projection changes; persist exact original operation then capture its live token. Existing recorded same turn never automatically executes again. Unknown or live mutating predecessors block new-turn admission. |
| Message/settings/title/effort/attach/pause/cancel | Each exact pending record has its own token, original Job/controller, immutable generation/owner/lineage/host context and request bytes. Owned live controls can overlap; one RPC never owns another pending item. |
| Retry / duplicate CID | Same active operation coalesces. Confirmed message CID does not dispatch again; changed body under its original CID refuses before storage/effects. Repeated explicit non-CID controls after settlement append a new operation, preserving earlier confirmed proof. |
| Normal cancellation / remote kill fallback | Both use the same operation path. A live cancel coalesces; completing spawn/poll/C1 cannot remove its token. No local PID/native fallback for a remote job. |
| Successful response | Validate wire snapshot, original context and exact pending record before confirmation. Confirm only that operation. Older running observations cannot resurrect the same generation after confirmed terminal evidence. |
| Failure / timeout / aborted RPC / invalid snapshot | Mutating requests remain pending/blocked with their exact originals. Remove only the completing token; no fabricated failure/delivery/consumption or automatic reexecution. Other already admitted RPCs can settle their own evidence. |
| Poll / outage | Read-only live polls suppress overlapping observation requests, but do not block settlement of already confirmed terminal evidence. Transient failed polls retain the last authoritative snapshot; polls are not provider admission. Capability refusal still records unknown evidence and fences effects. |
| Restart / replacement job, controller, supervisor, host or generation | No token is reconstructed from persisted pending rows, name, or another job's activity. Unknown originals remain preserved and require owner recovery. Late responses cannot be attributed to a changed context. |
| Approval relay | Separate RemoteJobs request/relay path retains its existing exact request IDs, paired-host/supervisor proof and v2 capability gates; it does not borrow RemoteJobHost control tokens. |

Tokens live only through the actual RPC chain and are removed by exact object
identity. Snapshot ordering uses a weak per-job observation record. Existing128
operation/8MiB retention limits and strict bounded/no-follow cache inspection
remain. No persisted ownership is inferred from a token's absence. Public error
evidence uses the existing bounded failure taxonomy, never arbitrary RPC text.

Protocol8, metadata3, runner-ledger-v2, pairing1, mailbox schema14 and JSON4 are
unchanged. All13 protected methods, UI, normalizer, baseline pins, retention
guard and the approved flaky files remain byte-identical to56ed. No new pin
amendment or compatibility fork is requested.

## Qualified evidence

- Unchanged56ed production plus the initial12 delayed-operation regressions:
  PID19680,60s,exit1,11failed/1passed. Failures reach suppressed C2/cancel and
  wrong-context late confirmation. Later tests expand operation types and
  fallback/invalid-input cases; final text is not claimed identical to that red.
- Working correction PID79712,60s,exit0:33passes in operation/ledger tests.
- Working combined fixture check PID9296,60s,exit1:20passes and9observation
  failures. This exposed an overbroad working admission guard on read-only
  polls; it is not a new defect attributed to unchanged56ed. Corrected working
  observation PID27516,60s,exit0:all10 original observation assertions pass.
- Working report-location reproduction PID4856,60s,exit0:1pass/33excluded.
  Its Windows CI cause remains unproven; no timeout/assertion was changed.
- Frozen exact-head logs, PIDs/exits, incremental and complete correction file
  inventories are recorded in `E:/AgentData/reports/ab458-pr141-<head>-r22-validation.json`.

## Exact56ed CI residual matrix

| Cases / retained logs | Root classification and concrete patch | Limits |
| --- | --- | --- |
| Ubuntu120186863333/Mac120186863357 and Win4 pause L6/N8 | Fixture uses noncanonical `abc` job ID; N8 snapshot peer is incorrectly host-prefixed. Use canonical job/name and executor-local wire peer. Await actual old RPC settlement before beginning a new turn; preserve pause-once and terminal reset assertions. | Corrupt/unknown cache refusal unchanged. |
| Same Ubuntu/Mac and Win3 observation9 | Fixture produces host-prefixed snapshot peers rejected by the production wire schema. Bind peer to actual request job ID and parse mock replies with the real schema. Preserve all running/done/failed/cancelled, outage/reconnect/expiry, no overlapping polls and positive-dead assertions. | No unknown mutating evidence is reclassified settled. |
| Detached approval, all three reported OSes | Fake's hook was injected before its original call-log/init statements, so pending approval proved no first-call file existed. Move only the fake approval point after original first-call logging/native init. Original accepted control, pending approval, explicit decide and exact two-call assertions remain. | Provider fixture CI-only; source-grounded correction, not a local provider pass. |
| Mac project-group-mail line123 | Sender storage ACK and recipient event travel independently. Hold actual recipient events across sender ACK, prove inbox still empty, then forward every original event and await recipient visibility before group changes. Preserve exact recipient, quiet copies and receipt/consumption assertions. | No event discarded or ownership/ACK granted by the fixture. |
| Win3 network-ui transfer notification | Fixture directly constructs native-kind peers without session identity. Await explicit fixture session identity before registration on each host. Preserve production captureNotificationRecipient refusal and all authenticated progress/cancel assertions. | TLS/UI transfer flow CI-only; no native identity guessed from name/process. |
| Win4 final-result-delivery line309 | Actual failed predicate is initial inbox visibility, not stored report lookup. Focused unchanged-path reproduction passes. Add failure-only stage, owner/result flags and bounded existing job-wait diagnostics; preserve location-only jobsJSON and exact stored text/receipt assertions. | Root remains UNPROVEN; no deadline increase or skip. |
| Win3 quiet fake-Claude observer | Retained diagnostic: emptyResponse=true, hookError=false, peerSeen=true, session missing, no retained hook events. | Root remains UNPROVEN. Original publication/privacy/quiet assertions and diagnostics retained. No Claude/provider run. |

Earlier Mac exited-without-final, approval expiry, note retry/fairness/HTTP causes
remain unproven. Their absence in this run is not proof of a fix. Hosted full,
lifecycle/native, TLS approvals/transfers and ten-job takeover remain mandatory.
No Bridge/Claude calls, further agents, installed migration/update, build,
release, local provider/daemon/TLS or full local suite is authorized or run here.
