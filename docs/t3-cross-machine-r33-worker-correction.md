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
