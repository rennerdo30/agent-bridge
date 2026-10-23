# R25 P1 correction and R26 handoff

Starting production head `1b437a33a9268e3ab4cb3d5bf61e2a43a96b2ec9`,
tree `99709e297831c64387ca9aeb13ffe575de009625`.
Independent R25 AB45843024/43025 requires this correction; earlier passing
focused checks and R23 clean003 do not accept the new head. Parent owns R26
and hosted gates. Exact frozen validation/complete inventory is recorded in
`E:/AgentData/reports/ab458-pr141-<head>-r26-validation.json`.

## Rejected reservation is not cancellation authority

The registered wire boundary reserved an ID before the async spawn handler's
synchronous existing-record checks completed. A consecutive cancel frame could
therefore attach to a spawn already rejected for a live or foreign-owned job,
write blocked evidence against that ID, and replace the rejection with a false
cancelled/alive=false result. The original runner was still running.

| Boundary | Corrected effect contract |
| --- | --- |
| Reservation creation | Reserves concurrency only. No cancellation/evidence authority yet. |
| Original record checks | Validate paired host, supervisor, typed return binding, strict retained-operation evidence, live/retention status, target, policy, settings and permitted root before marking this exact previous generation eligible. No await separates these checks from eligibility. |
| Concurrent cancel | May capture/abort only the current eligible reservation and its exact previous record, or the exact pending record/controller created by it. A rejected reservation keeps its original error for every waiter. No write, abort or control against an existing live/foreign generation. |
| Proven pre-effect cancellation | Requires eligible admission, successful capture, requested/actual abort, no attempted effect, current reservation and exact previous-record rollback, compatible peer and unchanged authenticated route. Only then may the original live RPCs attest no-start. A restored previous record is never published as the new admitted generation. |
| Late host/effect | Existing R24 attempted-effect/late-host cancellation remains; no no-start proof after an attempted effect. Failed durable control remains unconfirmed. |
| Release/retry | Release only this reservation; later explicit same-owner controls can reach the original live generation normally. Duplicate rejected spawn/cancel attempts cannot mutate its evidence or acquire its controller. |

The new regression invokes the registered extension handler/schema with two
authenticated paired identities and canonical public native proofs. Actual
JobRunners.startAsync, metadata/spec publication and remote registry persistence
run; only physical launch/liveness/control and network transport are mocked.
For same-owner live, foreign supervisor and foreign pair collisions, two
consecutive-frame attempts retain exact original registry bytes, spec/state,
record reference/controller and running status. Both original errors survive;
no blocked cache, false terminal reply, new launch or control is permitted.
A subsequent legitimate same-owner cancellation still reaches the original
job once with its original authenticated remote control provenance.

Qualified unchanged1b red: wrapper56428/PID41772/60000ms/exit1,
3failed/28excluded. All three cases observe a fabricated success value where
both responses must refuse. Raw headed logs:
`E:/AgentData/reports/ab458-1b-r26-red.out` and `.err`.
Initial working run wrapper11164/PID70332/60000ms/exit1:30passed/1failed;
the remaining assertion omitted the legitimate third control-origin argument.
The assertion was corrected to require that exact authenticated provenance;
no production guard or intended refusal assertion was relaxed. This working
run is not frozen green evidence.

## Exact runtime residual matrix

| Evidence | Observed stage | Qualification / next evidence |
| --- | --- | --- |
| 1b Ubuntu120219760524, closed primary b5e3970c/PID10509 | Final8eccdfff-1fc9-5e1b-895e-771df772c827 refused protocol_mismatch/source unspecified at1792725371269; finalDelivery retained/permanent-refusal/persisted=true at1792725371281, retainedDeliveries2/pendingRetentions0/acceptedDeliveries0; runner done then dead, no envelopes/routes/consumption. | Specific refusal cause UNPROVEN. Structured state reports retention; original quarantine bytes are unavailable and independently unverified. Not evidence of successful mailbox delivery or proof of silent loss. |
| 1b Windows5/120220993820 fresh-hook fairness | At failure: starts2/completed2/connected4 of6, firstConnectAtStart1, maxHandlerMs122.091, probeSetupMs0.548, original connect budget500ms and burst24. | Scheduler yielded and admitted some fresh connections before burst completion; this does not prove all six met deadline or explain delay. Cause UNPROVEN; no local burst/load run or deadline/assertion change. |
| 200 Windows5/120210430813:579 | Cancel returned TOOLERROR invalid-evidence, later executor-state timeout. | Corrects earlier misleading successful-RPC wording. Acceptance is now asserted before effect waits. Cause UNPROVEN; a later passing case is not a root finding. |
| 200 Ubuntu c104be9f; Windows83e5a245/d903a926 | Recorded permanent protocol-refusal/final retention family, absent mailbox effects. | Specific causes remain UNPROVEN; do not infer equivalence to b5e3970c. |
| 200 Windows quiet observer; earlier003 peers/UI/archive; earlier platform takeover/note/fairness gates | Original diagnostics/observed stages remain in R24/R25 documents. | Causes remain UNPROVEN unless separately demonstrated. No quiet-copy/session, ten-job/exact-once, privacy, PID, cancel, busy-writer or responsiveness assertion is weakened. |

Searched exact joblog120219760524, report directories matching
ab458/1b4/120219/200/120209/120210, and the parent's exact run39893905779
artifact12476531091 at `E:/AgentData/reports/ab458-1b-ubuntu-artifact-parent`.
Its complete rg-files inventory contains only fast/integration results,
diagnostics,census and known-flaky-skips JSON. Metadata identifies source1b
(CI merge revisiond7dbfbda); no raw runner protocol-event, quarantine or state
ledger files exist in that artifact. Parent confirmed the same inventory.
Earlier2d3 artifact is not evidence for this run. No unrelated secrets/config
were scanned. Absence of a retained refusal event does not identify its cause.

## Bounded root-oriented checks and remaining measurement

Source audit identifies a testable publication interval: storageLease opens
its exclusive reader entry before writing its compatibility declaration.
A different process can observe incomplete bytes during that interval.
The new mock invokes the real reader census at that actual write boundary,
then completes the original write. Unknown remains refused; only the completed
current declaration admits the guard. A separate actual guard fixture retains
an incomplete entry unchanged and refuses before discovery/registration.
This proves a possible schedule, NOT that this schedule caused the CI failure.
Atomic lease publication would change the retention/cleanup boundary and is
not implemented speculatively in this correction.

Minimal parent-authorized failure measurement adds only bounded diagnostic
families for prior endpoints, legacy storage and unproven storage readers.
Existing final-settlement/event projection carries these allowlisted categories
into CI diagnostics/census artifacts; no raw paths, owner bytes or messages are
copied. Existing broker frame observations still distinguish operation and
connection generation. This does not retry, bypass or reclassify a refusal as
safe, and cannot recover missing historical bytes.

Focused fake-provider settlement checks cover the earlier violated contracts:
owned suspended/failed note retention holds final; successor notes and queued
provider turns retain exact ordered input/delivery proofs; restart/spec reset
cannot bypass unresolved evidence; compatible handover retries but genuine
protocol refusal preserves the original report without claiming delivered;
lost final ACK recovers original UUID/body without replaying a new identity.
These checks establish those mocked contracts, not ten native jobs or the
unknown exact CI refusal cause. Existing broker dispatch starts one handler per
setImmediate turn and does not await a previous handler's full settlement.
The live Windows connection deadline still requires hosted acceptance.

No compatibility increment: protocol8/metadata3/runner-ledger-v2/pairing1/
schema14/JSON4 and ownership capabilities remain unchanged. No authority is
derived from diagnostic fields. All13 protected pins, UI/normalizer, retention
guard and approved flaky files remain byte-identical to1b. No further agent,
Bridge/Claude call, provider/daemon/native/UI/TLS/contention/full local suite,
build/install/migration/release or installed-data capture was performed.
Parent fresh R26 and hosted full/lifecycle/native/paired-TLS acceptance remain
mandatory. Unavailable raw artifacts and unproven runtime causes remain gates.
