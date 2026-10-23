# Post-R23 CI residual correction

Base: `003199e383794a628de54f6a6fa6ec2d34d988c2`, tree
`7977ed99b3e09a206a103f7d849dace5ec5c75d3`. R23 AB-45843008 is clean
for that frozen source, not acceptance of this later correction. Parent owns
fresh R24 review and hosted gates. No reviewed object is rewritten.

## Complete reported003 residual matrix

| Case / exact retained log | Classification, evidence and change | Verification limit |
| --- | --- | --- |
| Muse requesting profile paths226: Ubuntu120198344196, Mac120198344172, Windows5/120199219571 | Fixture constructs a Job without `startedAt`. Tracking serializes a missing turn; strict evidence inspection correctly refuses it before dispatch. Supply a complete typed Job with original supervisor/session and finite turn. Both requesting paths, profile arguments and all internal-wire-field refusals are unchanged. | Original fixture reproduced red against unchanged003. Only the named mocked requesting-path test runs locally; no Muse executable/provider. |
| Paired TLS cancellation during spawn: Ubuntu120198344196 | Retained lines786/785 show control `Unknown remote job` before spawn success. Requester correctly preserves that rejection as unknown, so later fallback cannot redispatch it. Executor's root/worktree/usage awaits precede even its provisional record. Replace the starting-ID set with an authenticated original-spawn reservation; overlapping requests await that exact start, then revalidate admitted record identity, absence of a replacement start, current owner binding, capability and closed state before normal handling. | Delayed production wire/parser/admission/persistence regressions reproduce the defect without TLS/processes. Actual cancellation flow remains hosted-CI acceptance. Mac passing this case does not establish the Ubuntu cause or validate the fix. |
| Windows2/120199219533 project-groups antigravity main/secondary,155 | Failure is an unresolved peers-poll callback after secondary stop, not proof of a wrong elected main. No retained query/stop/admission stage establishes its root. Add failure-only stop/peers stage, started/completed query counts and public connection/broker/result flags; rethrow original error. | UNPROVEN. Outsider denial, exact addresses, main re-election predicate and polling budget are unchanged. No Antigravity/provider/process run. |
| Windows5/120199219571 embedded UI HTTP500,566 | Recorded diagnostic: category unclassified, one start, embedded=false, listenCount=0, one ENOENT discovery observation at5834ms. This locates failure before a successful broker listen but does not identify identity, storage or endpoint admission as its cause. Observe the original start rejection with the existing bounded error taxonomy; retain store-open refusal/deferred preparation events in the existing finite startup logger. | UNPROVEN. Exact HTTP200, single start/listen and malicious HTTP daemon opt-in refusal stay unchanged. No UI/daemon/native run; protected UI/node/broker source and pins unchanged. |
| Windows1/120199219456 archive-writer responsiveness,40 | The same one-second helper wraps start, peers and send; retained timer stack identifies none of them. Source audit finds prior endpoint SQLite inspection uses timeout0 plus asynchronous bounded retry; message archive maintenance/queue expiry lower writer busy timeout and yield/retry. This does not prove which runtime stage failed. Add failure-only exact phase, elapsed time, writer-held flag and connection/broker state; rethrow original error. | UNPROVEN. Keep under1s requirement, actual held writer, both original legacy/expired bodies, archive completion and all preservation assertions. No local contention/load/native run. |

The two apparent runner starts in the Ubuntu summary are not two executions:
the diagnostic parser labels the logger process PID. Raw excerpts show broker
PID8567 logging its launch of runner8743 at02:03:27.895Z; runner8743 logs its own
start at02:03:28.136Z. Cancellation gets Unknown job at02:03:27.867Z, before
that launch. No duplicate-provider conclusion is drawn from the summary.

Earlier Windows report-location/quiet-observer publication, Mac final-exit,
takeover, note retry/fairness/approval causes remain UNPROVEN where no causal
evidence was established. Their absence from a later platform run is not proof
of a fix. Only the exact reported003 logs above are classified here.

## Admission and effect audit

| Boundary | Contract |
| --- | --- |
| Spawn reservation | Installed before the first asynchronous executor admission stage. Captures authenticated paired host, peer ID, supervisor session and original typed return route; a competing spawn cannot replace it. No executable or owner comes from caller-injected internal fields. |
| Control / settings / message / pause / title / effort / attach / cancel | If the original start is in flight, wait for that reservation. Do not return Unknown job merely because its provisional registry row has not yet been created. After admission, the existing durable job principal, sender ownership, remote namespace and control callback remain the effect boundary. |
| State / approval | Use the same pre-record reservation boundary rather than borrowing an unrelated active operation. Existing read-only state projection and exact approval lookup/relay policy remain; waiting does not create an approval or settle unknown operation evidence. |
| Completion after awaits | Require successful original admission, the identical current RemoteRecord, no newer starting reservation, the original currently advertised typed return route and current runner-ledger capability. Failed startup cannot lend its previous record to a queued control. |
| Failed admission / closed broker / changed owner / dropped capability | No control effect. Requester retains exact original operation bytes as unsettled. No fabricated cancelled/done/delivered result, same-ID reexecution, alternate owner or native fallback. |
| Cleanup / restart | Each start releases only its own reservation; close releases waiters which then refuse before effects. Reservations are ephemeral and are never reconstructed from pending cache rows. Existing strict cache inspection and restart refusal remain authoritative. |
| Deadlines and capacity | Existing remote RPC deadline, executor admission deadline, per-pair rate and pending limits remain. The wait yields; no busy spin, new timeout allowance, compatibility change or permanent background process. |

The focused wire fixture uses actual RemoteJobs extension receive/parser,
paired advertisement proof minted by the canonical store helper, ordinary
executor admission/registry persistence, RemoteJobHost operation capture and
strict cache reads. Transport, slow root admission, physical runner start and
physical control application are controlled boundaries. The fake control sink
checks the generated sender/host proof and writes an actual runner snapshot;
it is not a real runner/mailbox acceptance or TLS test. Existing real broker
registration and owner-negative fixture coverage remains in the same file.

New cases exercise every control type through the pre-record gap, exact abort
controller cancellation, failed spawn, close, replacement binding, capability
loss, foreign-supervisor refusal and requester restart without replay. Original
UUID/CID/body/turn/route evidence is checked after actual persistence.

## Evidence and preserved contract

- Qualified red on unchanged003 production plus initial3 wire regressions and
  original Muse fixture: wrapper73796, PID79252, timeout60s, exit1,
  4failed/13excluded. Raw logs:
  `E:/AgentData/reports/ab458-003-r24-red.out` and `.err`.
  Later coverage expands to every control and failure mode; its final text is
  not claimed identical to this initial red.
- Working checks: PID9648 exit0,7passes/10excluded; expanded PID68188 exit0,
  8passes/13excluded. Later working PID56368 exit0,64passes/13excluded.
  Working noEmit PID13648 exit1 found an incomplete typed Muse fixture;
  required Job fields were supplied rather than bypassing the type contract.
  These are working-tree observations, not exact-head acceptance.
- Frozen exact source/tree, raw commit headers, own PID/timeouts/exits,
  incremental/complete file inventories and preserved-blob comparisons are in
  `E:/AgentData/reports/ab458-pr141-<head>-r24-validation.json`.
- Protocol8, metadata3, runner-ledger-v2, pairing1, schema14 and JSON4 remain.
  All13 protected method pins, UI, normalizer, baseline assertions, retention
  guard and both approved flaky files remain byte-identical to003/56ed.
  No migration/version fork or pin amendment is requested; no installed data
  or persistent environment was changed.
- NOT RUN locally: TLS, native/provider/daemon/UI/lifecycle/contention/full
  suites, builds, installs, migrations, releases. No Bridge/Claude calls or
  further agents. Exact-head hosted full/lifecycle/native/TLS and fresh review
  remain mandatory. Shared archive history remains separately authorized;
  mailbox ownership does not claim per-recipient archive confidentiality.
