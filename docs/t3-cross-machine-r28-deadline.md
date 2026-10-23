# R28: one aggregate startup-admission deadline

Base `5f7b4cdeecbf01ac64ae9b1b830e2627767f2294`, tree
`3dbe5858791df395e8704e13915c5a74fdf7ed3b`. R27 review AB45843038/43039
found a P2: a delayed retry could run another pass and return compatible after
the existing2s deadline. The census also called synchronous creation-time
queries with separate5s budgets. Previous R26 clean0c3 and R27 focused green
do not certify this correction. Parent owns fresh R28 and hosted gates.

## Admission and proof boundaries

| Stage | Corrected contract |
| --- | --- |
| Entry / retry | One CONNECT_TIMEOUT_MS deadline and AbortController span inspection, every endpoint pass, census, waits and final admission. Check remaining time before each new stage/pass and after any stage returns. Expiry cannot buy another pass or accept later-compatible proof. |
| Read-only SQLite | Timeout0 handles; retry callback checks deadline before open and between queries. Retry delay uses only remaining time, and finally closes the exact inspection handle on timeout/abort/error. No migration/backup/write is admitted on expiry. |
| Prior endpoint | Per-probe connect/auth timeout is min(original300ms, remaining aggregate time). Windows pipes remain unauthenticated/read-only. Errors are attached before post-connect deadline checks. Abort and timeout destroy only the owned socket and remove its listener/timer. POSIX connect uses optional cancellation; auth cancellation closes its owned client. No downgrade/hello/fallback. |
| Async reader census | Replace this call site's synchronous OS liveness probes with signal-bound readProcessIdentity. ESRCH, PID-reuse and pre-boot evidence retain existing meaning; unknown stays unproven. The synchronous maintenance API is unchanged. |
| Awaited liveness proof | Read two exact bounded snapshots: regular non-linked files, at most256 entries/4096bytes each, inode/stat identity and exact declaration bytes. Descriptor reads check remaining time and always close. A changed directory/file/nonce cannot borrow an earlier liveness proof. No mutation/deletion or attribution to a new owner. |
| Final admission | Fresh compatible/dead-owner evidence, unchanged second snapshot and a final elapsed/abort check are all required. Merely finishing a census, expiring an unknown lease or receiving a delayed identity answer never grants admission. |
| Compatibility | Complete incompatible readers, component1/2 cached-writer uncertainty, schema2/3 pre-lease stores, active prior endpoints and persistent unknown readers still refuse. Ordinary fast compatible admission and same-identity semantics remain. No new storage/wire/pin gate. |

The budget checks reject a synchronous filesystem/SQLite stage that returns
late; JavaScript cannot preempt a kernel syscall. No configurable5s synchronous
process query remains on this admission path. Cancellable asynchronous native
queries share the original deadline, rather than creating a new allowance.
Read-only bounded snapshots are evidence, not a replacement for the common
maintenance lock or the established isolated-offline admission contract.

## Qualified red and working evidence

- Initial unchanged5f production plus four initial cases: wrapper31784,
  PID53400/60000ms/exit1,4failed/29excluded, headed logs
  `E:/AgentData/reports/ab458-5f-r28-red.out` and `.err`.
  Three expose actual late-admission behavior. The inspection case initially
  wrapped an already-spied method recursively, so that case alone was not a
  qualified slow-inspection red; it was corrected without weakening assertions.
- Corrected four cases against the actual frozen5f guard body via an ignored
  loader: wrapper56364, PID43388/5000ms/exit1,4meaningful failures/33excluded,
  `E:/AgentData/reports/ab458-5f-r28-qualified-red.out` and `.err`.
  Only relative imports were relocated; the synchronous census was unchanged5f,
  and client cleanup was working source. This is explicitly NOT claimed as an
  unchanged whole-tree5f run. Each controlled late stage admits on that guard.
- Working PID26724 was stopped at its owned20s bound, not a pass. The fixture's
  lstat mock omitted bigint options; strict production identity checks refused
  it. Low-budget isolated runs retained raw counts to identify this fixture
  defect. Forwarding the real option fixed it. Temporary probes were removed.
- Working PID59704/8000ms/exit1:38passes/1recursive-spy fixture failure plus one
  unhandled late socket error. The corrected spy now calls the captured native
  implementation, and the socket error listener is installed before deadline
  rejection. Neither failed working run is frozen green or native acceptance.

Final fixtures call actual production guard/census/connect paths with bounded
clock/filesystem/network/identity fakes. Cases include late retry callback,
slow inspection/probe/census, suspended identity success/expiry/abort, changed
lease proof, actual socket abort/late connect, fast compatible admission, prior
endpoint publication after a yield, persistent unknown and incompatible reader
negatives. All original remaining negative/retention assertions are retained.
Exact frozen receipts/raw headers/PIDs/exits/inventories are at
`E:/AgentData/reports/ab458-pr141-<head>-r28-validation.json`.

## Artifact correction and carried runtime matrix

The three previously inspected structured artifacts each contain exactly21
files: `ab458-1b-ubuntu-artifact-parent`, `ab458-0c3-ubuntu-artifact`, and
`ab458-0c3-macos-artifact` under `E:/AgentData/reports`. They contain structured
results/diagnostics/census/skips only; no raw lease/quarantine/state ledgers.
Exact0c3 Ubuntu1c84880e and Mac6bebff3f identify storage-reader as the refusal
family, not the exact historical publication/removal race. Earlier1b/200 source
unspecified cases remain individually unproven. Raw preservation was not
independently verified for those runs; no lost bytes or delivered mail claimed.

| Exact evidence | Current interpretation |
| --- | --- |
| 5f Windows lifecycle120234003315:540, first five actual daemon UI sends | All500 before accepted-ID/status/crash assertions. Distinct from earlier embeddedUI500:566. Cause UNPROVEN. Original five200s/daemon crash-restart/HTTP opt-in refusal remain. |
| Run39898383270 artifact12478450804,6511816bytes | Downloaded official `ab325-windows-latest-node24-5f7b4cdeecbf01ac64ae9b1b830e2627767f2294` to `E:/AgentData/reports/ab458-5f-windows-lifecycle-artifact`. Complete rg-files -uu inventory605:601 plugin files, SOURCE_HEAD,manifest,receipt-admission-diagnostics.json,client-count-diagnostics.json. Only manifest and the two bounded diagnostic JSON files were inspected; they describe unrelated receipt/client-count fixtures, not these five HTTP responses. No first-send response/daemon-admission evidence is retained. |
| Minimal new HTTP measurement | On failure only, reuse existing httpFailureEvidence for exactly five status/category records plus stage/mobile/child-exited booleans. Its original4096byte/16read/250ms bounds and response-text exclusion remain. No new request, production/UI change, timeout increase or discarded original assertion. |
| 5f Windows shard1/120235009787 alias944 | After successful restart/ensureConnected with retained alias, peer-removal observation times out after client.close, before offline owner-question/impostor assertions. Automatic reconnect vs delayed cleanup is UNPROVEN. No production reconnect disabled, timing changed or assertion removed. |
| Prior fairness/quiet observer/peers/UI/archive/cancel cases | R24–R27 matrix remains. Windows200 cancel RPC was TOOLERROR invalid-evidence, not accepted cancellation. Later passes do not establish earlier causes. |

All13 protected method pins, UI/normalizer, retention guard and approved flaky
files remain untouched. Protocol8/metadata3/runner-ledger-v2/pairing1/schema14/
JSON4 unchanged. No rule files/generated bundles changed; hosted bundles were
retained only as an external artifact. No Bridge/Claude/further agents or local
provider/daemon/native/UI/TLS/contention/stress/full suite/build/install/
migration/release. Parent fresh R28 review and hosted acceptance remain required.
