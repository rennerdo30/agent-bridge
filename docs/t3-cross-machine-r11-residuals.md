# AB-458 R11 and final CI residual package

Parent owns fresh independent review and hosted full/lifecycle acceptance. This
package does not claim the native fixtures pass. No provider, daemon, native
fixture subprocess, build or full suite was launched locally.

## Retained evidence and classification

All reports below tested `fbc10e67c986091f6d68f036d8dcef335aee33b0`,
not the subsequent implementation in this package.

| Case / retained report | First failing boundary | Classification and concrete change |
| --- | --- | --- |
| R11 AB45842413, concurrent hello during job recovery | Second hello publishes before the first real retained-header read resumes; the first then overwrites `conn.peer` | Production race. One exclusive per-connection admission survives recovery awaits; the exact reservation and connection are revalidated before publication. Queue awaits retain their existing registration generation checks. |
| Quiet observer copies, Claude; Ubuntu119989226170, mac119989226017, Windows119990997526 | Handoff `inbox` expects unread body after channel already consumed it | Fixture delivery expectation. Capture the actual typed recipient, handoff ID and stored copy; await that exact channel notification and durable receipt before a wire barrier. All notifications remain observed. |
| Quiet observer copies, opencode; same reports | Every notification is expected to contain the handoff body | Fixture wire expectation. Opencode notifications intentionally carry only the ID. Explicitly read that actual ID, await its durable receipt and barrier, then assert quiet copies add no notification and remain discoverable without appearing in the hook. Both sibling jobs retain actual authorized handoff relationships. |
| Native takeover unavailable/opencode; mac119989226017; closed primary Windows119990997385 | Unavailable reaches final reports with nine copies stored and one live runner `done`, `delivered:false`; opencode last recorded phase is steering. Windows closed has eight final copies and two live runners `done`, `delivered:false` | Root cause **unresolved**. Preserve ten jobs, unique receipts, quiet copies, original owner and 120s deadline. Add RPC-vs-native-instruction, per-note and approval stages; all failure stages now print own runner, durable report/grant, namespace receipt, read-only storage admission and sanitized failure-event evidence before cleanup. No speculative production fix or deadline increase. |
| Remote native Codex limits, Windows119990997449 | Initial local `peers` done-cache wait at old line485 | Root cause **unresolved**. The remote runner eventually registers and finishes `delivered:true` in the retained teardown log; this does not establish why the initial wait expired. Preserve spawn/continuation/blocking ask limits and deadlines. Add named waits, in-flight RPC stage, both host registry/cache/runner facts and bounded registration/report error classifications. |
| Remote cancellation during startup, Windows119990997449 | Cancelled durable state exists; original supervisor inbox report never arrives (old line365) | Production producer/consumer mismatch. Log repeatedly refuses `inlineJobReport` with `Proven local job report grant is unavailable`. A remote proxy has no local native principal/succession grant. Its authenticated local supervisor now captures the exact original typed owner and local namespace before persisting the report. Broker validates current durable job authority and byte-equivalent retained envelope inside the actual write boundary; only that original supervisor copy can store/replay. No remote or local succession grant is minted. |

Logs are under `E:/AgentData/reports/ab458-ci-job-<job>.log`. Latest reported
Ubuntu result: 4152 passed, 136 skipped, two quiet failures. Windows shard3:
832 passed and the same two quiet failures. These are historical hosted results;
skips are not passes and no cross-platform acceptance is inferred.

## Regression evidence

- Actual production recovery reads are suspended inside a real retained job
  FileHandle, rather than replacing recovery with an already-resolved result.
  The broken source publishes both identities; the fixed source accepts only
  the admitted identity. Both completion orders, rejected read, cancelled old
  wire and independent legitimate reconnect are covered with alias/cache/history
  and original-byte assertions.
- Actual JobManager pre-admission cancellation persists its report and dispatches
  through the real broker. A lost successful response retries exactly once;
  typed original mailbox proof, no local grant, durable read/ACK, same-session
  broker restart and duplicate replay are checked. Changed body, UUID, job,
  sender proof, mailbox namespace and replacement supervisor are refused.
- Captured envelopes are canonicalized to their JSON wire/storage form before
  being retained for replay. Otherwise optional own-inbox `undefined` fields
  disappear during JSON persistence and make full-envelope equality fail before
  dispatch. Every original body/ID and all actual proof fields remain intact.
- The shared fixture diagnostic helper reads at most ten selected jobs, bounded
  registries and a 256KiB log tail, emits at most forty allowlisted events, and
  reads runner metadata using a separate read-only SQLite handle with zero busy
  wait. It does not import old state or acquire a production writer. Its focused
  fixture checks admission-stage evidence and excludes prompts/body/env/proof
  values from output.

Working-tree evidence before source freeze (not exact-commit acceptance):

| Receipt | Result |
| --- | --- |
| Registration red PID11428, 60s bound | Exit1; two meaningful concurrent-admission failures, one initial cancellation fixture assertion corrected because public peers intentionally hide job runners, one passing completion order |
| Registration green PID66964 | Exit0; four cases; later strengthened assertions rerun in batch |
| Remote cancellation red PID28080 | Exit1 on fbc source plus unrelated admission fix; successful report replay never settles, matching retained CI refusal |
| Remote cancellation green PID45208 | Exit0; original report, proof negatives, duplicate and replacement checks; same-session restart then added and rerun in batch |
| Combined PID17108, 60s bound | Exit0; thirteen selected mocked/loopback/offline cases across eight files; 67 excluded. Later read-only diagnostic refinement requires final frozen rerun |
| Typecheck PID51272, 60s bound | Exit0; noEmit. Later diagnostic test/refinement requires frozen rerun |

The final exact-head receipt records the subsequent admitted commands, exits and
PIDs separately. It must not label these earlier working-tree checks as runs on a
later commit.

## Compatibility and pin review

Protocol6/schema14, pairing and remote capabilities stay unchanged. The local
proxy report uses existing typed owner/mailbox fields, a current durable record
and its existing append-only delivery history. It conveys no new cross-host
authority. Intermediate readers that reject such a report fail closed; no
fallback, historical proof attribution or automatic migration is introduced.
Historical proxy reports without provable source/recipient namespace remain
retained and pending. No original record is deleted or rewritten to guess it.

Only the broker constructor's inline-report handler is extracted into a helper;
the new exact-proxy branch is in that helper. The other twelve protected methods,
UI and normalizer remain unchanged. This is a new attributable protected delta:
the baseline stays unchanged pending parent review of the frozen source,
normalized patch and complete hash inventory. Prior constructor approval does
not authorize this amendment.
