# Windows startup inspection and retained delivery taxonomy

Base `510ae699caefd0761ad091d6e2855e59f1d20913`, existing PR141/AB-458.
Evidence: Windows Node24 shard2 job120064592467, retained log
`E:/AgentData/reports/ab458-ci-job-120064592467.log`.

## Failure mapping

| Failure | Root finding / qualification |
| --- | --- |
| OpenCode suite beforeAll172: prior-endpoints48 `PRAGMA user_version`, database locked | Demonstrated production startup defect. Read-only inspection occurs before the node's ordinary election retries. SQLite busy escaped immediately, failing startup even though a writer could release shortly. A busy schema is unknown, not safe. |
| OpenCode-primary ten-job takeover, runner9705521c/PID9280 | Nine other jobs delivered; this runner repeatedly reports note retry with finalQueued, no final envelope/route. `other/other` does not establish the underlying refusal. The exact takeover cause remains **UNPROVEN**. There is no claim this inspection fix or a particular lease error caused it. |

## Startup contract

The read-only schema observation now uses the existing `retrySqlite` asynchronous
backoff, capped by existing `CONNECT_TIMEOUT_MS` (2s). Each attempt opens with
SQLite timeout0 and closes its handle before yielding. There is no synchronous
busy spin, longer SQLite busy timeout or raised election/test deadline. A
persistent busy inspection returns retryable timeout and does not admit startup.
Non-busy errors propagate. Missing/unknown inspection is never compatibility.

The initial node election supplies a cancellation signal tied to its existing
`stopped` event and releases only its own listener in `finally`. Stopping during
inspection aborts before discovery/launch. This changes unprotected `elect`, not
the pinned constructor/start/tryBecomeBroker methods. Other callers retain the
same bounded guard with an optional signal; no daemon/provider is started by it.

After a successful observation, schema2/3 still refuses before mutation, and
every known prior endpoint plus the existing storage-reader guard is still
checked. Active incompatible/unknown endpoints refuse, with current-protocol
auth only where the existing private-socket checks allow it. Probes are still
observations, not migration exclusion. Common maintenance-lock exclusion and
the approved pre-lease/offline boundary are unchanged. Unsupported older readers
reopening shared data still require owner-coordinated upgrades/isolated homes.

## Diagnostic contract

The retained runner state already distinguishes `kind:note` versus `kind:final`,
stage, message UUID, bounded attempt and `finalQueued`. The failure classifier
now has a finite code/reason allowlist for actual metadata ownership, storage
admission/version, mailbox provenance, ownership conflicts, job route/grant,
authority, registration, dedupe, protocol, cancellation and transport failures.
No exception body, stack, path, credential, token or proof string is copied.
Input classification is capped4096 characters; unknown errors remain `other`.
This is optional diagnostic JSON, never routing, ACK, recovery or liveness
authority. Protocol6/schema14/pairing/remote capability gates do not change.

One concrete sanitizer defect is proven: the real metadata lease exception is
`ELEASEBUSY` with “has a live or unknown owner”; the previous regex omitted “a”
and did not preserve its code. This omission does **not** prove that exception
was the cause for9705521c. The bounded CI log-tail helper now retains the same
strict failure taxonomy as the runner state. Existing meaningful coarse labels
remain alongside that canonical classification rather than erasing new codes.

## Regression evidence and limits

- Base510 plus new tests: PID19104 exit1,60s bound.16 failures and1 pass among
  selected cases (23 excluded). Includes immediate busy rejection instead of
  successful retry, persistent-busy/cancellation failures, active-old-endpoint
  refusal not reached after busy, and real lease failure collapsed to `other`.
- Working patch: PID52992 exit0,26 selected cases across3 files (14 excluded).
  Later additions cover non-busy refusal and the actual sanitized log-tail event.
- Working noEmit PID67188 exit0. These working checks are not labelled as runs
  at a later commit. Final head/tree/commands/PIDs/exits are in
  `E:/AgentData/reports/ab458-pr141-<head>-startup-validation.json`.

Inspection tests use real isolated SQLite files with original accepted bytes,
mocked busy stages and mocked endpoint transport. They verify yield, every
handle close, bounded refusal, cancellation, schema2/3 refusal, incompatible
endpoint refusal and no backup/schema effects. An actual node start/stop during
busy verifies no discovery or daemon launch. No native process or TLS runs.

The note/final regression obtains an actual `ELEASEBUSY` from a held fixture
metadata lease, uses production `inSendOrder`/`deliverWithRetry`, persists the
note refusal through the actual runner-state writer, and reads it through the
bounded CI snapshot/log helper while the final remains queued. It verifies
order, finalQueued, exact typed cause and removal of private error text; releasing
the mocked wait permits note then final. It does not run ten native providers.

Ten-job/exactly-once/120s acceptance and all original takeover assertions remain
unchanged. The Windows takeover, earlier Mac tenth-runner and fairness causes
remain unproven pending new hosted evidence. Fresh independent review, hosted
OpenCode/TLS/native lifecycle/full gates remain mandatory. No install, migration
launch, release, daemon replacement, Bridge call, delegation or further agent.
