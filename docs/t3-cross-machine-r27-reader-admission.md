# R27: reobserve transient mailbox-reader admission

Base `0c3a02db2690273e77f39dcefd3f623406b46134`, tree
`129d90d869876ae2786b628994f9f5950aaeda9d`. Parent independent R26 clean,
AB45843034, reviewed8 incremental/66 cumulative files on that frozen object.
This changed head requires fresh parent review and hosted gates.

## Exact CI evidence and limits

Run39896605459 artifacts identify source0c3 and CI merge revision
`597f4466f3c791d9f00bb2ca5eb52f6799918f41`, Node24.21.0/Vitest5.0.2.

| Exact log / job | Retained observation |
| --- | --- |
| Ubuntu120228403717, closed primary1c84880e, PID10857 | Final6516fe9c-a05a-52c2-8bde-6799ab1b54ac refused at1792727163633 with protocol.source=`storage-reader`; finalDelivery retained/permanent-refusal/persisted=true at1792727163638, retainedDeliveries1/pendingRetentions0/acceptedDeliveries0. Runner done/dead, delivered=false/report present; no envelope/route/consumption. |
| Mac120228403755, opencode primary6bebff3f, PID85846 | Final7821b838-1adf-54c0-808e-1961b499f82a refused at1792727327080 with protocol.source=`storage-reader`; retained/permanent-refusal/persisted=true at1792727327084; same retained/pending/accepted counts. Runner done/dead, delivered=false/report present. The separate local job projection is done with reportEnvelopes1/reportGrants1; this is not proof that this exact final UUID reached the mailbox. |

Both fail in final-reports before inbox reads/final counting. This measurement
identifies the actual prior-startup reader-census refusal family, rather than
an unexplained remote route or native-provider exit. It does NOT identify a
specific malformed lease or independently verify quarantine bytes.

Official Ubuntu artifact12477710279 (813838bytes),
`tests-ubuntu-latest-node-24-attempt-1`, is retained at
`E:/AgentData/reports/ab458-0c3-ubuntu-artifact`. The matching official
`tests-macos-latest-node-24-attempt-1` is at
`E:/AgentData/reports/ab458-0c3-macos-artifact`. Complete rg-files inventories
of both contain only fast/integration results, diagnostics,census and
known-flaky-skips JSON. Matches for job IDs/protocol-refusal/quarantine are
only structured integration diagnostics/census/results. No raw runner event,
lease, quarantine or state-ledger files are available. Exact named joblogs and
both inventories were inspected; no unrelated config or secrets were scanned.

## Violated admission contract and correction

The synchronous census reads a directory snapshot, then each lease's owner
bytes/mtime. A real storageLease exclusively creates its entry before writing
the declaration; a legitimate release can remove an entry after the snapshot.
Base0c3 immediately converts either unresolved observation into permanent
protocol_mismatch. Node election latches that refusal, so final delivery can
retain its report and exit without mailbox storage even after the transient
reader observation would settle. The prior R26 write-boundary fixture already
demonstrates that unknown interval without granting compatibility.

The correction changes only asynchronous startup admission:

| Observation | Admission/effect contract |
| --- | --- |
| Complete incompatible declaration | Immediate refusal. No retry, rewrite, deletion, expiry or compatible attribution. Protocol2 through7 and wrong schema with current protocol are negatives. |
| Incomplete/unproven reader or ENOENT census race | Keep admission pending and yield with bounded backoff. Repeat prior endpoint probes and the complete reader census; only a newly successful census may admit. No success is inferred from time, retry count, missing owner fields or a recovered name. |
| Persistent unknown / legacy empty lease | Refuse with the original sanitized storage-reader diagnostic when the existing CONNECT_TIMEOUT_MS budget is exhausted. Budget begins at guard entry and includes prior inspection/probing; no constant or caller deadline increased. Bytes remain unchanged. |
| Cancellation | Abort pending delay/observation with the original AbortError. Do not replace cancellation with protocol refusal or permit subsequent discovery/effects. |
| Prior endpoint appears during wait | Probe again using current protocol only; live/incompatible/unknown endpoint still refuses before effects. Windows still sends no auth token to unverified pipes. |
| Component1/2 or pre-lease schema2/3 | Existing automatic shared-home refusal remains before probes/wait/mutation. No offline admission inferred. Common maintenance lock, reader ownership/liveness, cached-writer exclusion and isolated offline migration contract are unchanged. |

The synchronous census and maintenance APIs remain fail closed. The added
internal incompatible/unproven error category only selects whether a bounded
fresh inspection is possible; it cannot grant storage, mailbox or process
authority. No new leases, data mutations or cleanup operations were added.

## Qualified regression evidence

Unchanged0c3 production plus initial actual guard/census fixtures:
wrapper28900/PID74572/60000ms/exit1,3failed/16excluded. Headed raw logs
`E:/AgentData/reports/ab458-0c3-r27-red.out` and `.err`.
Publication and removal-visibility schedules reject before their controlled
completion; cancellation incorrectly receives the already-latched BridgeError.
The final fixture additionally controls yielded timers and adds compatibility
negatives; it is not claimed text-identical to the initial19-test selection.

Final tests invoke production guard, actual synchronous census and real
read-only SQLite inspection against isolated owned fixtures. Only network,
process identity and selected filesystem visibility/timer boundaries are
mocked. A controlled current lease retains exact original bytes; no effect
occurs while its observation is unresolved. Compatible completion admits once;
cancel does not; persistent unknown refuses within the original budget.
An endpoint introduced during the yield still refuses. No real process,
provider, socket/TLS peer, contention or stress fixture is launched.

Exact frozen head/tree, own PIDs/timeouts/exits, raw commit headers, bounded
aggregate run, incremental/complete inventories and preserved-blob checks:
`E:/AgentData/reports/ab458-pr141-<head>-r27-validation.json`.

## Carried gates

Earlier1b b5e3970c and200 c104be9f/83e5a245/d903a926 had source unspecified;
their individual causes remain unproven. The new exact0c3 family does not
retroactively identify them. Raw quarantine preservation is independently
unverified for those CI runs. Corrected200 Windows120210430813:579 cancel was
TOOLERROR invalid-evidence, NOT accepted cancellation. Windows fairness4/6
connections, quiet observer and earlier peers/UI/archive causes remain
unproven; later passes are not root proof. R24/R25/R26 matrices remain retained.

All13 protected methods/pins, UI/normalizer, retention guard, approved flaky
files and protocol8/metadata3/runner-ledger-v2/pairing1/schema14/JSON4 remain
unchanged. No version/pin fork, automatic downgrade, process replacement,
installed migration or data capture. Original ten jobs, exact-once checks,
unavailable/closed/opencode variants and120s deadline remain untouched.
Parent fresh changed-head review plus hosted full/lifecycle/native/TLS gates
remain mandatory. The mocked contract fix is not native takeover acceptance.
