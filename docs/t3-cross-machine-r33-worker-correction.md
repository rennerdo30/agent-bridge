# Hosted worker corrections after the R33 freeze

The original tested source remains1c9876df/tree3f373864. Parent approved only
its exact listen/tryBecomeBroker baseline deltas, separately attributed in
a5a8854651c2d5cf90ffb6288f402575b9853bf2. This correction changes neither
protected body, UI, normalizer nor existing security/retention assertions.
It requires fresh full independent review and actual-worker CI acceptance.

## Actual hosted failures, not mocked acceptance

|Exact evidence|Stage and classification|Concrete correction / limit|
|---|---|---|
|053 branch, run39928854240/job120331834598; checkout merge b6b72174aae85d3435237c468973fdc0b7e55165; archive profile1failed/1passed|Ten-session unchanged-publication/changed-bytes fixture fails876ms at native Worker error listener96. Not a2s timeout. Exact native error was discarded.|Workflow runs regression after npm ci and builds only afterward. Required new bootstrap entry is absent in committed bundles. Move the existing CI build before the regression, retaining all archive/changed-byte assertions and post-pass patch publication. This establishes a missing build prerequisite, not the historical discarded error code. Native worker errors now retain only an allowlisted category and fixed stage, with no raw message/stack/path/cause.|
|053 lifecycle run39928854260 Ubuntu120331835232 and Mac120331835161; both2failed/348passed/44skipped|Late definite failure/backoff fixture fails at message listener89 prepared-record validation catch, distinct from Worker error96.|Capture the exact assigned thread ID immediately after creation, rather than comparing with mutable live threadId which retires to-1. Keep exact PID/incarnation/attempt/home/original-file/namespace checks, clean exit requirement and quarantine. Fixed field-category diagnostics distinguish unreadable record/destination/original files/process/thread/incarnation/proof. The original historical mismatched field remains unknown until actual-worker evidence is retained.|
|Same lifecycle runs|Old listen hash expected; source new hash observed|Expected pre-amendment preservation failure. Parent-authorized a5a88546 changes only the two approved hashes and their attribution, not behavior acceptance.|

## Additional verification allowance

Parent approved one fresh **maximum12s aggregate** source/mock/noEmit batch
for these newly evidenced corrections against one frozen correction head.
Use an external original aggregate deadline, own recorded PIDs and exact raw
commit headers; stop at exhaustion and report incomplete. No native Worker,
build, daemon/provider/TLS/full launch is permitted. Earlier batch aggregate
is **NOT RECONSTRUCTED**; this allowance does not retroactively validate it.

New fixtures suspend/retire only an EventEmitter worker transport, invoking the
real initializer/journal. They require legitimate original thread identity to
survive live-ID retirement, reject a foreign-thread prepared record without
reexecution or byte changes, and reject worker errors without reading code
accessors or publishing private data. Native-error codes are bounded before
allowlist lookup; unknown/oversized/getter/proxy evidence remains unclassified.
The workflow fixture requires the existing build step before the original
archive regression and confirms registration of its actual worker entry.

No later source helper change is called tested at the original1c freeze. Final
receipt must distinguish original source/test head, artifact053, approved pin
amendment and this correction's own frozen check head. Unknown actual-worker
errors, Windows availability, backup completion and prior unproven runtime
causes remain hosted review/CI gates. No refused/unknown result is admitted or
automatically reexecuted by a diagnostic category.

## Frozen correction result

Exact tested correction **8b36cae5a1184fa3fd10f26e7ba170a5cfd59be3**, tree
**ffaaf787d86b83f7bc5bb955fe77d26c9b239749**. No protected-body change from
the approved1c source; the separate pin attribution remains a5a88546.

The one parent-approved additional batch used a single external12000ms
aggregate deadline: start2026-10-23T09:08:52.7165316Z,
end09:08:57.7870717Z, **5071ms total**, no timeout/retry/extension.

|Check|Own PID|Start/end UTC|Process elapsed / result|
|---|---|---|---|
|All15 bootstrap mocked cases|60452|09:08:52.7289528 /09:08:56.4634219|3734ms,exit0;15passed,0excluded|
|NoEmit|68572|09:08:56.4905589 /09:08:57.7782112|1288ms,exit0|

Raw streams each include full commit/tree/PID/start/end/exit headers. Receipt:
`E:/AgentData/reports/ab458-r33-8b36cae5-correction.json`, plus
`-mock.out/.err` and `-typecheck.out/.err` at the same prefix.
No native Worker/build/provider was used. New early-thread-retirement and
classification cases were not replayed against a modified historical tree;
do not label this as a newly executed red/green pair. The earlier c862 qualified
red evidence is separately retained, as are every unsuccessful harness attempt
and the **NOT RECONSTRUCTED** original-batch aggregate.

These checks validate the controlled identity schedule and safe classification,
not the discarded native error or historical prepared-record mismatch. The CI
workflow prerequisite is source-proved and the order assertion passes; actual
built-worker and archive-profile acceptance still requires hosted execution.
File-record fsync, directory publication durability and nonreserved activation
timing remain explicit full-design review topics, not a claim of power-loss or
complete lifecycle acceptance from these mocked tests.

## Further exact053 Ubuntu full matrix

Run39928854247/job120331834904: **13failed/4418passed/133skipped,
0unhandled**. Ten checklist cases fail during setup when the deliberately
forbidden native Worker is requested; teardown's zero-Worker-call assertion
also catches the attempted launch. The correction isolates only the optional
prepareColdStore transport, checking the exact fixture home/endpoint, original
deadline and cancellation. It creates no files or prepared proof; the real final
endpoint/reader guard, MessageStore initializer, registration and checklist
authority handlers remain production code. All Worker/subprocess refusal and
zero-call assertions remain intact. No fixture prewarming or native fallback.

Affected checklist cases: combined project/parent overflow; spawn brief/state;
progress in peers; proposal approve/reject; master mid-run edits; canonical
project spelling; agent descriptions/instructions; project-main authorization
including unregistered/cwd mismatch; non-hook instructions; remote explicit
checklist refusal. Original scenario/security assertions are unchanged.

The remaining three are the separately recorded prepared-validation/backoff
failure, pre-amendment mobile pin failure, and actual node stop during busy
inspection. The latter exposed a production cancellation-type regression:
the new outer budget supplied generic Error while the original AbortController
contract supplied AbortError. Node and daemon explicit stop now use AbortError;
internal deadline expiry remains timeout. No assertion is broadened, no caller
abort is swallowed, and neither protected method body changes.

This steering does not renew the approved12s aggregate allowance. The prior
correction used5071ms; any additional focused check shares the remaining6929ms,
records a fixed external remaining deadline and reports incomplete on exhaustion.
The ten full checklist cases and actual daemon/lifecycle/native gates remain CI
acceptance unless explicitly selected and reported as local mocked evidence.

The steered source is frozen at
**43d9ad7c8f6779418d6e6d387dfd1876db0dbe41**, tree
**47889d0d3469e69dd434ce390fcf33e5d4d256d6**. Exact selected checks:
combined checklist overflow, checklist/project spawn brief/state, and actual
node stop during busy inspection. **3passed/297excluded** (PID65360,3004ms,
exit0), including original zero-native-Worker/subprocess teardown assertions;
noEmit PID2848,1317ms,exit0. The remaining segment consumed4376ms of the6929ms
remaining cap; combined measured validation is **9447ms/12000ms**. No timeout,
retry or extension. This is a second source freeze under the user's subsequent
steering and the same aggregate allowance, not a rerun of the15-case8b freeze
or a claim that all18 cases ran on43d9.

Raw exact-head/tree/PID/start/end/exit streams and segment/combined accounting:
`E:/AgentData/reports/ab458-r33-43d9ad7c-remaining-batch.json` and its
`-mock.out/.err`, `-typecheck.out/.err` siblings. All ten checklist failures
remain in the matrix; only the two named checklist cases were selected locally.
No native-worker or actual daemon acceptance is inferred. The earlier, separate
batch remains **NOT RECONSTRUCTED**.

## Exact6b lifecycle source correction

Run39929971037 Ubuntu120335523521 and Mac120335523764 each report
**1failed/349passed/44skipped**. Pin failure is resolved. The late-definite-failure
case still fails at stop74/message93. Correction to the earlier interpretation:
exact6b line93 is the worker-message envelope refusal (non-prepared or wrong
attempt), not the durable prepared-record catch at105. The kernel deliberately
sends failed when it refuses; the stack cannot identify a record/thread mismatch.
Immutable thread capture therefore is not claimed to fix this hosted failure.

The fixture alone fakes Date to1000000 in the parent, but its real worker retains
the actual wall clock. The parent exports this fake absolute startup deadline;
the worker's original deadline check must refuse it before initialization. This
is a source-proved unsupported cross-worker clock schedule, not permission to
relax expired-worker or journal proof. The fixture now uses the production
RelaunchBackoff constructor's existing injected-clock interface for that node
only. Startup/election/worker clocks remain real. The same unknown-attempt,
4999/5000 and9999/10000 boundaries, launch counts, authenticated connection and
nonembedded assertions are retained. No provider/native test ran locally.

The exact failed kernel reason was not serialized by that run. Source and
fixture establish the clock mismatch; actual-worker hosted execution is still
required to show the corrected fixture reaches and passes its original final
assertions. No discarded native error, power-loss durability or general Windows
availability is retroactively proved.
