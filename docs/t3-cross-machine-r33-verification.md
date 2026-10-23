# R33 source freeze and qualified verification

Base: c86286f32f05457f0ed008a51937b6ee54e47be8.
Tested source: **1c9876df4ef2f8ff3c9cccfb1dca7fd613bec293**.
Source tree: **3f373864185f9c3c251e360e8adf071b74962708**.
This document and the pin artifacts are later documentation, not a new tested
source head. No production source changed after the freeze.

Parent source-only architecture approval covers one original outer10s startup,
guarded initialization, then a new final min(2s,outerremaining) admission. See
[design and exact CI matrix](t3-cross-machine-r33-bootstrap-design.md).
R32 AB45843068 diagnostic durations now use performance.now; deadline policy
remains Date-based. The historical constructor figures remain wall-clock data.

## Frozen checks

|Check|Own PID / cap|Result|Raw files in E:/AgentData/reports/|
|---|---|---|---|
|Explicit seven-file mocked selection|71072 /8000ms|exit0, elapsed6731ms;23passed,125excluded; no unhandled error|ab458-r33-1c9876df-frozen-mocks-quoted.out and .err|
|NoEmit|77512 /6000ms|exit0, elapsed1476ms|ab458-r33-1c9876df-frozen-typecheck.out and .err; original empty compiler streams retained as .native.out/.native.err|
|Normalized pin/byte inspection (not a test)|62300 /5000ms; exact git cat-file child12568 /2000ms|exit0; exactly listen and tryBecomeBroker differ; other11/UI/normalizer unchanged|ab458-r33-pin-byte-reconciliation.out and .err|

Frozen raw streams identify the full source commit. The compiler receipt adds
the wrapper's exact head/PID/exit/elapsed header without changing its separately
retained native streams. No skipped/excluded test is counted as a pass.

The explicit selection uses ProcessStartInfo.ArgumentList, not a shell-joined
pattern. Files: store-bootstrap, admission-observation, hook-publication-evidence,
server-lifecycle, muse-msp, backup-settlement-schedule, prior-endpoint-inspection.
Only selected mocked cases ran; the MSP host/provider cases were excluded.
The bootstrap transport is an EventEmitter fake with the actual production
initializer/guard/SQLite/journal; it cannot fall through to a native Worker.

## Red and unsuccessful working evidence

All raw paths below have the E:/AgentData/reports/ prefix. Earlier working-tree
heads are not relabeled as exact frozen source. Their failures/timeouts remain
part of the receipt, not acceptance. No further local validation is scheduled
in this batch.

|Evidence|PID / cap|Qualification/result|
|---|---|---|
|ab458-c862-r33-clock-red|60872 /5000ms|Actual base diagnostic clocks plus new wall-step assertions;4failed/5excluded,exit1; Vitest1.35s.|
|ab458-c862-r33-bootstrap-red|17792 /5000ms|Qualified red: actual base store/factory/guard/storage-lock, new controlled2400ms schema fixture;1failed/6excluded,exit1; not an unchanged whole-tree replay.|
|ab458-r33-bootstrap-working|3984 /10000ms|exit1 after5418ms; unhandled Vitest worker-port closure. Fixed entry requires exact bootstrap workerData.kind. No coverage acceptance.|
|ab458-r33-bootstrap-working2|39832 /5000ms|Own PID stopped at limit, no verdict.|
|ab458-r33-bootstrap-working3|47456 /5000ms|Own PID stopped at limit, no verdict.|
|ab458-r33-bootstrap-working4|73420 /5000ms|One working-tree case passed/6excluded; Vitest1.13s, not frozen acceptance.|
|ab458-r33-bootstrap-working5|4552 /10000ms|7working-tree cases passed, elapsed7890ms; later source/test changes require frozen check above.|
|ab458-r33-typecheck-working|50004 /10000ms|exit1 after1619ms: two fixture callback types; corrected before freeze. Raw compiler file lacks its own head header; original tool wrapper records base/working qualification/PID.|
|ab458-r33-1c9876df-frozen-mocks|76648 /12000ms|Incorrect Start-Process argument joining selected unintended store-identity-refresh cases (2failed/45excluded), then own PID stopped at limit. Coverage unknown; not a source regression verdict or focused green. Corrected explicit-argument run is separate above.|

Every launched validator had its own timeout; only its exact owned PID was
stopped. Aggregate accounting must include these unsuccessful attempts, not
only the final8.207s. Earlier raw receipts do not all retain exact process-wall
elapsed values (Vitest duration is not identical to process lifetime), so this
document does not invent an exact aggregate from those files. No additional
local rerun is authorized by this receipt.

## Acceptance/effect boundaries

|Boundary|Focused evidence|Remaining limit|
|---|---|---|
|Fresh initialization exceeds2s but stays within outer10s|Controlled2400ms real migration, actual production kernel, prepared/exited ledger; same namespace reopen and no repeated DDL|Real built worker/Windows cost hosted only|
|Prepared IPC versus exit|Hold fake exact worker exit; no admission before exit|Native termination/handle closure requires hosted acceptance|
|Cancel/expiry before effects|Suspend worker before kernel, revoke, then release; no DB/schema effects|No actual process launch locally|
|Expiry after main schema|Original metadata UUID/BLOB retained; no archive phase, incomplete ledger blocks restart/duplicate DDL|Unknown interrupted evidence needs owner recovery; no automated recovery implemented|
|Foreign result|Wrong attempt refuses, original prepared DB bytes retained, no new preparation|No caller-supplied proof grants mailbox authority|
|New incompatible reader after preparation|Actual protocol7 lease arrives before exit; fresh proof refuses|Historical race not retrospectively proved|
|Final admission outer remainder|9850ms preparation plus151ms final phase refuses; no replay|Original2s/10s limits unchanged|
|Diagnostic clock|Forward/backward wall steps through phase observations and actual registered hook handlers|Does not establish historical wall correction or fix quiet observer publication|
|Backup progress|Validated progress leaves exact accepted copy pending; actual copied bytes and exit assertions retained|2010ms CI pending worker cause unresolved|
|Shutdown backstop|Normal ordered cleanup cancels only own timer; suspended cleanup retains original backstop|Exact original MCP native fixture not run locally|
|Partial marker|Empty/partial/full actual file bytes with deterministic content observations|Historical fs.watch schedule remains unproven; real host tests unchanged|

## Pin manifest reconciliation and pending gates

The first sourceHashes field used decoded worktree text with CRLF normalized
to LF, without an explicit label. The regenerated manifest hashes **exact
committed Git blob bytes** obtained with binary git cat-file --batch and also
records separate raw-worktree/LF-normalized hashes, byte counts and Git OIDs.
Nothing was normalized or edited on disk to make the comparison pass.

For storage-lock.ts: committed blob dce153739c134c77855a7e9b3cda5adad706a4a6,
19793bytes, SHA256412dd1c61e7ddd02460be6738f3004f9b82903480daee87cb8622bab0231f177.
Raw CRLF worktree20113bytes hashes to
e0d316b0bd158b6fe0bcaf45294a57de1e5ec4e506e8688f07ca28572dc0cd11;
its LF-normalized text equals the committed bytes. This explains the parent's
raw-worktree mismatch, without claiming raw bytes are identical.

Parent has **not approved** the R33 pin amendment. Baseline is untouched.
Exact deltas: broker.listen bd39e0af... to4f8cb41d...;
node.tryBecomeBroker0703c468... toce203d2b.... Review includes nonreserved listener
activation, worker cancellation/late native effects, journal durability, nonce
borrow and nested admission helpers. Pin approval alone is not behavior acceptance.
Fresh independent full design/correction review and hosted full/lifecycle/native
gates remain required. No release/install/migration/provider/daemon/TLS/full local
run occurred. Prior takeover/fairness/UI500/alias/quiet causes remain qualified
and unproven where earlier evidence did not establish them.
