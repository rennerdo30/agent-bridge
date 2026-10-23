# R13 remote supervisor admission and residual CI evidence

Base: `3271b943b306b285abc306f22b9d9f5d633f2f7e`, existing PR141,
`t3/fix-t3-cross-pc-messaging`. AB-45842524 is a blocking production defect.
This package is source/offline evidence, not hosted lifecycle acceptance.

## Observed root and fix

`jobForRegistration` was a registration-only projection with no `owner`. Passing
it to `jobRecipient` rewrote an actual `HOST/supervisor` report to an empty local
target after the broker had already retained its request. The first send failed
with `invalid target: `; retry then failed with `Original destination was not
retained`. The old local-reader regression hid this by setting `jobParent` to
literal `undefined` and never addressing the real remote supervisor.

Registration principals are now explicitly marked `remote-registration`, expose
their original owner address separately, and never enter local supervisor
selection, peer refresh, conversation fallback or job-grant creation. The
paired request's production wire admission captures `returnRoute`: original
display address, stable supervisor principal, authenticated host ID/fingerprint,
exact destination name and canonical hosted/native ownership. This comes from
the paired host's advertisement parsed by the production network service, not
request fields. Continuation retains the original route; replacement binding or
host fingerprint is refused. A display rename preserves the authenticated host.

Before first remote dispatch, `prepareSend` validates current advertisements,
sender identity and all ownership capabilities without effects. At the writer
boundary the broker rechecks its registration and destination, then commits
request and destination together through `admitRemoteSend`. Its savepoint rolls
both back on pin failure. The pin includes local sender namespace and remote
mailbox provenance as well as the exact destination proof. Dispatch revalidates
that pin. Crash/retry never selects a new advertisement as authority. A missing
capability or destination proof leaves no request-only intent.

## Routing audit

| Entry/state | Authority and result |
| --- | --- |
| Local durable runner, including a local `JobHostInfo` in `job.host` | Existing current local job/grant transaction; no change to failover policy. Missing archive authority still refuses before ordinary routing. |
| Receiver-side paired runner, with correct original `jobParent` | Registration principal authorizes the runner; captured remote return route authorizes only its original supervisor destination. No local grant or quiet observer copies are minted. |
| Remote runner with omitted/empty/incorrect caller `jobParent` | Original owner address still comes from the registry. Caller metadata cannot manufacture a local supervisor or change that address. Unproven original return mail refuses. |
| Explicit local context from an admitted remote runner | Ordinary explicit local route, with real original parent in the corrected fixture. It does not acquire a supervisor grant. Wrong job alias and wrong supervisor registration remain refused. |
| Source-side `job.remote` / `args.host` proxy | Not a local runner grant; existing native registration and `currentJobAuthority` exclusions remain. Explicit remote addresses use remote pins; `args.host` is not allowed in the strict remote executor argument schema. A conflicting unproven registry row fails closed. |
| Tracked send / legacy completion send / note / question / cancelled final | Same production `routeSend` boundary. Completion dedupe preserves original report UUID/body and cannot mint local succession. |
| Direct/alias/project remote selection | Selection must yield a complete authenticated remote destination before atomic admission. Existing pin takes priority over fresh local/project resolution on retry. |
| Broadcast or unrelated explicit mail | Existing routing and permissions remain; only proven local job supervisor delivery can create a job grant. Remote registration is never a local-job projection. No role grant is inferred from it. |
| Paired request/control/approval/state after binding replacement | Existing authenticated pair/supervisor policy plus original captured binding/fingerprint; replacement cannot borrow the old remote record. |
| Source restart before remote storage / lost ACK after remote storage | Original store intent/pin and remote-job return route reload from actual persistent stores. Retry sends original bytes to the original host/binding; receiver deduplicates. |
| Legacy remote registry with no return proof | Original bytes, owner and job remain. Registration can retain a proven runner, but original supervisor mail is refused without attributing today's binding. Existing destination-less intents are preserved/refused, not repaired by guessing. Explicit reviewed recovery is separate. |

No schema or protocol migration is introduced: protocol6/schema14/pairing and
the recipient/native/mailbox remote capabilities remain unchanged. All numbered
branch intermediates remain unreleased. The new local JSON proof is additive;
it is not a remote task protocol, a token, or authority accepted from a caller.
An older branch reader still containing this routing defect is not claimed
fixed by a capability bit. Existing owner-coordinated upgrade/startup exclusion
and schema14 gates remain necessary. No installed migration/update was run.

## Qualified red and focused green

- PID22468, exit1, 60s bound: two new tests on base3271 production sources fail
  for missing remote storage and a retained request-only intent. Cleanup was
  corrected before this qualified run; the earlier PID61592 also had fixture
  metadata handles open during teardown and is not clean red evidence.
- PID56844, exit1, 60s bound: final native/hosted regression bodies on base3271
  sources reproduce three failures. The only base-source adjustment exports
  its existing private network message parser for the transport fixture; no
  routing, ownership or storage guard changes. Both real supervisor sends fail
  with `invalid target: ` before reaching transport; the replacement case
  leaves an intent. Working source bytes were restored in `finally`.
- PID71496, exit0: 28 focused cases across five files; 15 excluded, not passes.
  Includes prior local authority/rollback regressions and remote admission.
- PID25320, exit0: all eleven remote supervisor cases, including the final
  before-storage crash/rename and legacy quarantine cases. This is a working
  tree run, not a claim about a later commit.
- PID21084, exit0: working-tree TypeScript noEmit before the last test additions.
  Final exact-head checks and all commands/PIDs/exits are in the separate
  `E:/AgentData/reports/ab458-pr141-<head>-r13-validation.json` receipt.

The new fixture replaces only runner process launch and the authenticated
transport boundary. Remote request/envelope schemas, canonical peer parsing,
real broker hello, registration guards, tracked/legacy sends, network routing,
recipient enforcement, SQLite persistence and broker/store reopen are real.
It does not prove TLS or provider process acceptance. Assertions retain exact
body/UUID/owner/provenance, no local job grant, no duplicate receiver row,
replacement refusal, capability withholding and transaction rollback.

## Residual failure matrix

| Hosted evidence | Qualification / next gate |
| --- | --- |
| Ubuntu120035349656, Mac120035349540, Windows120037033218: five remote-jobs TLS failures | Same full names on all three platforms. Ubuntu initial-done job6cf2919f, pre-spawn cancellation12a2ef4b and observed-start cancellationfeb4e23a retain `unretained-destination` final retry evidence. The approval and worktree waits have no indexed runner in their snapshot; their bounded event sets contain respectively14 and7 destination-unavailable observations. These corroborate the root, but the two unindexed waits are not individually proven causal. All original native limits/approval/worktree/cancel assertions need hosted rerun. |
| Windows120037033516, opencode takeover | Nine delivered jobs; `5dbe41a8` done/report-present, no final envelope or route, final queued behind a note retry attempt15 (`other/other`), runner still alive in the pre-cleanup snapshot. This narrows the stage to the serial note delivery path, not remote fallback. Same broad symptom as Mac2d3 job30789e6a, whose refusal was not retained. Specific cause remains **UNPROVEN**. Diagnostic categories now distinguish connection/deadline, metadata owner, quiescence, content mismatch and runtime type errors without logging arbitrary exception text. Ten jobs, exactly-once and120s deadline remain. |
| Windows120037033583, quiet Claude notification client | Failure occurs before handoff: broker still publishes `sessionId:null` after bounded SessionStart hook response. A hook response is not a registration barrier (`buildHookResponse` can time out while an existing `setSessionId` await settles). Fixture now checks non-error response and waits for actual published session identity before acquiring the handoff. It retains both siblings, exact handoff receipt/wire barrier, quiet inbox/read hook and no unsolicited notification assertions. Cause is a demonstrated missing fixture postcondition; cross-platform acceptance remains CI-only. |
| Windows120014661690, broker fairness | Still **UNPROVEN**; existing bounded diagnostics remain. No local CPU-work fixture, deadline increase or blind rerun. |

The shared authenticated history/archive contract is unchanged and is separately
authorized. Exact mailbox ownership fences delivery, inbox consumption,
ACK/recovery and retargeting; this is not a claim of end-to-end confidentiality
or private per-recipient archive storage.

All13 protected method hashes, UI source, normalizer and baseline are unchanged.
There is no pin amendment request in this package. No local native/provider,
daemon, full network fixture, build or full suite was launched. Fresh independent
review and hosted full/lifecycle/integration gates remain mandatory.

## Later e13 Ubuntu residuals and fixture corrections

Ubuntu job120052367478 tested e13:4177 passed,136 skipped, four failures.
The five earlier remote-jobs TLS flow cases passed on that Ubuntu run only;
this is not cross-platform proof. No additional production root is inferred
from these fixture failures.

| Case | Demonstrated classification and concrete correction |
| --- | --- |
| Peer refresh, remote-jobs424 | R14 AB-45842561: fixture advertised a null native session without process provenance, so the new return-owner guard correctly refused before lookup. Canonical store-minted identity now reaches the unchanged unknown-job and impostor assertions. Missing identity explicitly refuses with zero lookup calls. The corresponding mocked production request/refresh/lookup regression is local; TLS acceptance is CI-only. Fix commits dc8468e9 and f6da966f; final R14 receipt qualifies1 focused case/typecheck at f6da966f and12 cases at prior dc8468e9. |
| Muse profile reload, muse-job-contracts203 | `receiver()` generated a fresh pair UUID on every reconstruction. The persisted job correctly belongs to the original host ID/supervisor even when display name and native session strings match. Reuse the exact original public pair identity on receiver reload; keep all existing permission-profile, access, saved-session, wrong-owner and wrong-agent assertions. Add an explicitly different host with identical display/native identity and assert no launch. Locally, actual wire admission/registry/settings/reload are tested with `JobRunners.startAsync` replaced; no Muse adapter/CLI/process is invoked. Original executable-argument fixture remains CI-only. |
| Missing-provenance backlog, t3-cross-machine1150 | The old fixture expected a pin after a first attempt was refused for missing capability. R13 correctly commits neither intent nor pin in that state. The test now first negotiates full proof, loses transport after atomic admission but before receiver storage, and retains the original complete pin across capability loss/reconnect/source restart and a colliding local recipient. A separate fresh UUID during capability loss explicitly has no intent/pin. Restore compatible original recipient and require original body/UUID, unchanged pin and exactly one remote copy through duplicate retry. The regression is retained, not reduced to a zero-pin assertion. TLS execution remains CI-only; the equivalent actual production store/reopen path uses mocked transport locally. |
| Closed-primary ten-job takeover | Still unproven: jobs c482c40a and7d67ba63 are done/report-present but finalQueued behind note retries attempt15, code/reason other, with no final envelope or grant. Their runners remain alive in pre-cleanup diagnostics. This corroborates the earlier Windows note-stage obstruction, not its precise cause. Preserve ten jobs/exactly-once/120s; no timeout increase, native reproduction or assertion change. Mac30789e6a and Windows fairness also remain unproven. |

Bounded local red PID72860 exit1 reproduced both new fixture errors against
unchanged f6da966f production: regenerated host refused as another supervisor,
and capability-first admission has zero pins. These are intentional ownership
and atomic-admission semantics, not grounds to weaken production guards. Final
frozen-head commands/PIDs/exits and actual exclusions are recorded separately in
`E:/AgentData/reports/ab458-pr141-<head>-residual-validation.json`.
