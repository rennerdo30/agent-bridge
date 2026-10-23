# R34 correction contract before implementation

Base1491d078b042b9ae3eaddcf4b92f8c0bd88e9043. Read full independent R33
AB45843086, including the four source schedules and later P2 evidence. Parent
approved one new60s aggregate mocked/offline/noEmit batch, no native workers,
providers, daemons, TLS, builds, full suites or installed migrations.

1. Broker startup keeps both reserved and directly bound transports tentative.
   A single original check/signal follows every service await and the checks
   before each subsequent effect. TCP/network startup is prepared without
   request authority; activation occurs synchronously only after all preparation
   completes and the original check passes. Abort immediately revokes authority,
   destroys owned tentative sockets and closes only owned listeners. Asynchronous
   service completion after revocation checks before further effects; cleanup
   waits for exact partial resources, never calls late completion success.
   Optional-service errors cannot swallow the admission/cancellation error.
2. Every MessageStore constructor/opener and metadata admission, including an
   existing cached metadata handle, checks the bootstrap journal independently
   of optional cold preparation. The sole initializer exception is synchronous,
   exact home/attempt/preparing-byte witness scoped and nonescaping. Reindex and
   doctor get no exception from omitting startupDeadline. Cleanup of owned handles
   remains possible after refusal; uncertain originals are not removed/repaired.
3. Before any schema effect, directory durability must be supported: synchronize
   the existing home, create/check the private journal directory, synchronize its
   publication in home, then fsync the new record and its containing directory.
   Each entry/descriptor identity is checked around sync; unsupported directory
   flush or any uncertain publication refuses and retains all evidence. File
   fsync is never substituted for directory durability. Windows support remains
   UNVERIFIED; unsupported cold startup is an availability BLOCKER, not a completed
   product behavior. Local tests use an explicitly fake directory-flush transport.
4. Preparing/prepared reads capture exact raw-byte digest and stable path/descriptor
   dev/ino/size/mtime/ctime signatures before and after reading. Prepared retains
   the original preparing witness. Under exact maintenance exclusion after clean
   worker exit, reread and compare BOTH retained records with the original
   snapshots before publishing exited from the fresh read. Immediately revalidate
   the complete ledger before final construction; a missing/replaced/changed row
   is retained/unsettled, never reconstructed from cached JSON. No repeated DDL.

Parent's batched source-only compatibility approval: protocol9/metadata4 because
intermediate protocol8/metadata3 writers ignore this journal, including cached
pre-registration handles not excludable by endpoint probes. Probe p8 endpoints;
refuse metadata1/2/3 automatic shared-home upgrades before schema/journal effects.
Only existing explicit owner-coordinated offline admission in a named isolated
home may migrate old metadata, preserving original rows/snapshots. No automatic
copy/split, environment bypass or claim a version forces old cached writers to
cooperate. Pairing1/SQLite14/JSON4/runner-ledger-v2 remain unchanged.

Required focused schedules: recovery suspended across expiry; TCP preparation
suspended while local ping is attempted; directly bound listener remains tentative;
caller abort versus original deadline; opener without startupDeadline/direct
constructor/cached metadata sees unsettled records; unsupported directory sync and
record-directory failure before DDL; in-place read mutation; removed preparing or
replaced prepared before exact exit/final proof; legitimate complete reconnect;
protocol8/metadata3 refusal and explicit no-loss isolated metadata upgrade.

R33 P2 checklist transport isolation and typed AbortError at1491 remain retained
corrections, not retrospectively reviewed acceptance. All previous unsuccessful
harness attempts remain evidence; earlier aggregate is NOT RECONSTRUCTED. New
checks identify their own frozen head/tree, exact PID/start/end/exit and original
external60s aggregate cap. Protected method deltas require exact normalized
artifacts/parent approval before a separate attributable baseline amendment.
Fresh full independent R34 review and hosted actual-worker/Windows/full/lifecycle
acceptance are mandatory; no merge, release or installed update is approved.

## Frozen correction and evidence

Tested source **0dec70aafcbd8968579eba65c7056bbdf62a5a6c**, tree
**fcca0ff58c7f88b955b2f886f5a0ec4fb84efb4d**. Later artifact/receipt commits
must not be described as exact tested commits. All production and selected test
bytes remain frozen at that source. Baseline is deliberately untouched pending
parent review of `t3-cross-machine-mobile-pin-r34.patch` and `.json`.

The nine qualified red schedules ran at f692e72b, whose production source is
unchanged from1491; only tests/design were added. All nine failed,15 were excluded.
Final core run:30 passed, no exclusions. Separate compatibility/migration run:
12 passed,61 excluded. `noEmit` passed at the same frozen source. Exclusions are
not passes. The first compile failed on optional proof narrowing; the first
core run had26 passed/1 failed because missing evidence leaked ENOENT. Both are
retained as intermediate failures, followed by fixes and frozen passing evidence.
One broader selection hit its external15s cap without reporting results; it is
INCOMPLETE, not a pass or evidence of a production cause. No blind native rerun.

Original60s validation batch aggregate: **55,163ms**, including every failed run,
timeout, compile and bounded exact-blob inventory. Own root PIDs in launch order:
28616,80524,48872,15608,46120,79204,48364,50140. The last inspection owned Git
PID26200, bounded2s, exit0, inside its root838ms interval. Only root15608 reached
the external cap and was stopped; all others exited. Raw logs retain full
commit/tree/PID/start/end/exit headers. Original receipt paths:
`E:/AgentData/reports/ab458-r34-*.out`, matching `.err`, and
`E:/AgentData/reports/ab458-r34-budget.json`. No additional verification is claimed.
Earlier unrelated batch remains **NOT RECONSTRUCTED**; this allowance does not
validate it retrospectively.

## Effect and recovery audit

| Boundary | Required proof / preservation | Evidence |
| --- | --- | --- |
| Reserved or direct local listener | Real reservation stays tentative; no serving issuer for the direct legacy call; one final original check before synchronous activation | Suspended recovery/TCP negatives and compatible direct activation positive |
| Native recovery, job index, optional services, purge, network/TCP | Check after await and before later phases; signal revokes transport immediately; exact partial services are closed and uncertain cleanup retains broker owner | Late recovery red/green; source audit of nested native recovery/index/network/DPAPI helpers; real Windows helpers NOT RUN |
| Factory without deadline, direct constructor, cached metadata, writable history/archive/job archive | Independent journal fence; sole synchronous exact initializer witness; no omission-based grant | Actual factory/constructor/cached metadata regression; writable opener source audit |
| Preparing publication | Supported directory fsync before schema effects; original deadline between flush/create/write/flush phases; no deletion on uncertain publication | Explicit fake directory transport; unsupported/late/post-file failure, exact retained bytes and no reexecution |
| Prepared and exact worker exit | Preparing raw digest/signature retained; fresh both-row read under exclusion, exact original witness and current DB identities before exited append | Missing, replaced, in-place and during-read mutation regressions; no exited/new DDL on refusal |
| Final open | Complete journal proof checked independently again; actual current namespace remains store-owned | Mutation during final construction refused; legitimate completed preparation/reopen preserved |
| Old local client/broker/metadata | Exact protocol9 auth, p8 prior endpoints, component1/2/3 refuse before automatic mutation; explicit isolated offline only | Auth8 negative/9 positive, p8 endpoint refusal, component3 early refusal and1/2/3 no-loss interruption/upgrade fixtures |
| Backup/restore | Existing consistent metadata snapshots retained; no old journal reconstruction or inferred ownership | Offline migration interrupted backup/transaction and restart fixtures; native backup/restore acceptance NOT RUN |

Protocol9/metadata4 does not force an already running protocol8 cached writer to
cooperate. Automatic shared-home metadata1/2/3 upgrade refuses, even with no
endpoint. Only the explicit owner-coordinated isolated offline contract can
upgrade; retained incompatible/incomplete journal rows remain blocked afterward,
not silently translated. SQLite14/JSON4/pairing1/runner-ledger-v2 and recipient,
native and mailbox capability contracts do not change. Shipping component1 homes
are affected as well as unreleased component2/3 homes; this is an explicit upgrade
boundary, not a test-only exemption. No installed data was opened or migrated.

Windows directory publication is **UNVERIFIED**. Where mandatory directory-open
flags/fsync are unsupported, cold startup refuses before schema effects. That is
an unresolved availability blocker requiring a portable reviewed solution and
actual hosted acceptance, not a claim the user's Windows startup gap is fixed.
Current populated compatible opens still enforce the journal fence. Authenticated
shared archive history remains separately authorized, not recipient-confidential
storage; this repair does not change that established contract.

## CI residual matrix retained for parent acceptance

| Exact source / evidence | Proven stage / classification | Current qualification |
| --- | --- | --- |
| R33 6b59 AB45843086 four P1 schedules | Late services/early activation; optional-deadline opener bypass; nondurable directory publication; cached exit originals | Actual production boundaries repaired; qualified9 red, final30 core green; independent R34 required |
| 053 isolated profile120331834598 | Actual Worker error listener, generic unsettled; archive persistence bytes/publication assertion not reached | Prior immutable thread ID/bounded error/build ordering corrections retained; actual native error cause not retrospectively proved |
| 053/6b lifecycle120331835232/120331835161/120335523521/120335523764 | Prepared-message validation catch, distinct from Worker error | Frozen repair now preserves exact original preparing/prepared evidence; hosted original backoff/unknown-attempt scenario remains required |
| 053 full120331834904 checklist10 setup + endpoint AbortError + backoff + pin | Forbidden native Worker fixture boundary, typed stop cancellation, actual prepared failure, expected old pin |1491 controlled preparation mock/typed abort retained; no native permission granted. Pin baseline now needs NEW four-method review, not prior two-method approval |
| 1491 Win TLS120340382508 cancellation report380 | Local cancelled/host-null; no report envelope/grant; both operation caches retain confirmed/blocked cancellation evidence; no actual runner | Cancellation notification history missing remains UNPROVEN. No synthetic runner/note, no assertion removal, no inference RPC success means consumed |
| 1491 Win dashboard120340382456 forward pages126 | Raw source open delta8 vs0; exact cursor/record checks follow | Source review finds permitted fallback on unreadable/busy/not-ready indexed history. Exact trigger not retained/proved; no cache or zero-read assertion weakened |
| 1491 Win message-notify same job | Timeout.stop bootstrap74, actual original expiry before scenario | Safe fixed phase classification added; historical internal phase unavailable. No claim same cause as prepared93/import96; hosted immediate/dedup/consume-after-delivery required |
| Historical takeover exit/fairness/quiet observer, Windows HTTP/readiness/cleanup | Structured artifacts did not retain raw lease/quarantine/runner-ledger evidence; constructor timings were wall-clock observations | Remain cause-unproven. Original ten-job/exact-once, budgets, owner cleanup and observer identity/quiet assertions retained; no native reruns or success inference |

The previous R33 pin approval covers its exact prior bodies only. This freeze
changes listen/startServices/abortStartup/tryBecomeBroker; other9 method hashes,
UI hash, normalizer and behavioral assertions remain unchanged. Exact committed
Git-blob SHA256 plus separate raw/LF-worktree evidence are in the new manifest.
Parent exact pin review, separate attributable amendment, fresh independent full
design/correction review and hosted actual-worker/full/lifecycle/Windows gates
are all outstanding. No merge/release/acceptance is implied by mock passes.
