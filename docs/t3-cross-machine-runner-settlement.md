# Runner queue and final settlement evidence

This is source/mocked evidence for PR141 afterdf1aa84f. It is not native takeover,
cross-platform, daemon or end-to-end acceptance.

| Retained CI case | What the evidence proves | Current correction / remaining limit |
| --- | --- | --- |
| Mac120095569189, runner7ad6a0d5/PID92314 | Done, exited, deliveredfalse, report present, no final mailbox envelope/route. Runner-done was logged about65ms after finishedAt. This was not a120s timeout. | Explicit final settlement distinguishes permanent refusal, shutdown and retry exhaustion from confirmed storage. The old evidence does not identify which path actually caused that exit. |
| Windows120097529740, de56daa9/PID5248 | Note retry14 has protocol_mismatch/protocol-refusal while finalQueued is true. | Reproduced the terminal-note head-of-line defect. A node latches compatibility refusals, but the note previously spent its30-attempt retry budget blocking the final. Preserve the note before releasing the final. Why this built fixture got the refusal is still unproven. |
| Windows120097529653, quiet Claude observer | The original published-session poll ends with null, despite a successful hook tool response. | Failure-only capture of hook error flag, original poll's last peer/session category and bounded admission/refusal events. No extra poll/RPC, handoff to unknown identity or longer deadline. Root remains unproven. |
| Windows120097529794, embedded UI sender | Original HTTP200 assertion got500. No retained cause identifies startup inspection, lease or identity as the root. | Failure-only HTTP status/category plus original startup admission observations, embedded/listen counts. No daemon opt-in, expected500 or startup guard changes. Root remains unproven. |

## Queue and retention contract

`runOwnedJobRunner` already awaits `deliverFinal`. A controlled single provider
with a held note confirms the runner does not stop or settle its final while
that accepted note is unresolved, including an owned shutdown/cancel. This did
not reproduce an unexplained early Mac exit. The existing final helper does
intentionally return an undelivered retained report to session fallback on a
permanent refusal, retry exhaustion or shutdown. Its former void result did
not distinguish those exit paths in retained diagnostics.

A status note with terminal `protocol_mismatch` now stops network retries only
after `quarantineTextAsync` fsyncs an immutable evidence record under the isolated
home's `quarantine/<message UUID>-<content hash>.txt`. The original body, wire
body, dedupe key, message UUID, conversation, requested/attempted address and
declared job/supervisor context are retained. Existing source/run evidence and
broker intents are untouched. The intended sender is declared evidence, not
proof of an authenticated registration or destination. The record explicitly
says `authority:evidence-only-no-replay`: no reader, importer, automatic retry,
native fallback, new name/session/host grant or mailbox consumption is added.
Recovery of these notes requires an owner-reviewed original authority/intent;
they are not reported delivered. R19 found that throwing alone was insufficient:
the old ordinary-send queue observer swallowed a retention failure and let the
final advance. The owned barrier below replaces that behavior. General storage unavailability cannot be
reported as durable retention; final settlement exposes `unretained` if its
own report never persisted.

After note retention, the final still uses its original UUID/body and ordinary
ownership-fenced send/receipt path. Explicit protocol refusal is terminal for
that final and leaves it in runner state for existing session fallback. The
existing same-protocol handover signal remains retryable; a different
brokerProtocol still refuses. Question/answer retry policy is unchanged. No
protocol mismatch is swallowed, no old-protocol hello/downgrade or replacement
daemon is introduced, and original ten-job/exactly-once/120s assertions remain.

## R19: failed retention remains owned

The refused note's exact serialized evidence is captured once, including body,
wire body, original dedupe key/message UUID, conversation and original/attempted
destination. `pendingDeliveryRetention` holds that same string in the actual
runner-state metadata row before the async quarantine write. It is evidence,
not a transport outbox or authority to replay. The queue awaits write/fsync,
close and publication; a suspended or failed writer cannot release later sends,
receipt probes or final settlement. Only a confirmed evidence file and a
confirmed state update remove the pending entry. A failure after publication
reuses the same content-addressed file on retry, never another message identity.

Retention has six attempts and100/200/400/800/1600ms backoff (3.1s total). It
does not re-send the refused note. Cancellation interrupts the backoff but joins
an active writer; it never abandons an unobserved write promise. Cancellation or
exhaustion latches `RunnerRetentionUnsettled`, preserves pending evidence and the
original final report/UUID in runner state, returns exit1 and emits the finite
`job runner delivery unsettled` outcome. It does not emit runner-done or final-
settled success. If every persistence path fails, this is explicitly an
unsettled failure, not a claim that bytes reached durable storage. The existing
owned stop deadline can also exit1 with this explicit failure; it does not
claim that an in-flight writer completed.

`inSendOrder` observes its own accepted callback promises and latches retention
failure separately from ordinary send errors. Both awaited and callback-style
posts use that owned promise; there is no detached derived rejection to drop.
Drain rejects a latched failure and prevents later effects. Ordinary failures
retain their existing recovery/idempotence policy. Session fallback and queued
continuations stay held while pending retention/failure remains. A dead runner
is not automatically treated as a drained queue.

Initial state publication preserves pending evidence on restart. An explicitly
admitted restart validates the original job/message identity and completes only
the exact evidence write and confirmation. It does not register a new peer,
start a provider, dispatch the note, select today's supervisor or regenerate a
final. The original final stays undelivered under its original report UUID for
the existing ownership-fenced session fallback after confirmation. Invalid
evidence remains blocked for owner recovery; no replay importer was added.

The remote snapshot parser strips unknown state fields. Consequently the
execution host refuses a terminal snapshot or continuation while retention is
unsettled, using the existing error reply; it never sends pending body/proof
records to the requesting host. A failed state observation retains the last
snapshot/unknown liveness, rather than proving death or accepting a final.
Unsettled jobs count toward admission limits; unrelated jobs retain admission
subject to those limits. After evidence confirmation, the original terminal
snapshot becomes available. No new optional wire field, capability, version or
schema migration is required. Protocol6/schema14/pairing/ownership capabilities
remain unchanged; intermediate branch revisions remain unreleased.

R19 qualified red: unchanged485b4173496e95c79e5de645a8d5b817461d55b3 production
plus the initial regression, wrapper74204/PID68392, exit1 within60s: a forced
synchronous quarantine failure let the final send (2 calls vs1) and produced
an unhandled note rejection. The final regression faults the real async
FileHandle.sync after write suspension. It proves suspension, failure/recovery,
cancellation, six-attempt exhaustion, restart via actual initial publication,
and interruption after file publication before state confirmation. Only the
writer failure boundary, provider and node transport are mocked; state
persistence, retry/order/settlement and quarantine filesystem operations are
production code. Separate checks exercise session fallback with real mailbox
guards and receiver-side remote admission/state handling with the native
launcher blocked. The requesting-host check retains a failed observation.

Working PID54488 exit1 exposed an ESM spy fixture issue (native namespace
exports are nonconfigurable), corrected by wrapping the module export while
retaining its actual filesystem implementation. It is not production evidence.
Working PID30172 exit0/7 checks, PID44712 exit0/13 selected checks and PID39032
exit0/14 selected checks precede the final source freeze. Working noEmit PID9912
exit0 likewise is not labelled as an exact final-head check. Final receipts use
`E:/AgentData/reports/ab458-pr141-<head>-owned-retention-validation.json` and
record exact head/tree, commands, own PIDs, exits and excluded counts. No skipped
or excluded native scenario is reported passed. R19 does not prove the earlier
Mac/Windows takeover, refusal, quiet-hook, fairness or HTTP roots.

`finalDelivery` records a strict finite outcome: stored/retained/unretained,
cause, bounded attempt, whether report persistence succeeded, message UUID,
time and optional allowlisted failure evidence. Stored means the existing
receipt path confirmed storage; these diagnostic fields themselves are never
ACK, ownership, consumption, replay, migration or liveness authority. A lost
response is recovered by the original final's receipt without another send or
new UUID. Runner state JSON preserves these additive fields; schema14,
protocol6, pairing and remote ownership capabilities are unchanged. The new
quarantine records are not discovered by legacy job-copy importers.

## Protocol and failure diagnostics

The real client response parser annotates protocol refusals with finite request
family, process-local connection generation, local protocol and a validated
numeric brokerProtocol when actually supplied. It preserves the original
refusal code, message and compatibility behavior. Local hello attestation
failures receive the same observation. Diagnostic failure always leaves the
original refusal in place. No token, raw frame, identity proof, body, endpoint
or arbitrary error text is added to diagnostic output.

The classifier still reads only own data descriptors, rejects proxy/getter
inputs, caps message inspection4096 characters and codes64 characters, and
admits bounded finite integer diagnostic numbers. A finite source identifies
version, native/frontend/mailbox attestation, schema admission, unsupported
operation or handover. It never turns same-build expectations into proof that
an endpoint is compatible. General SQLite policy and all namespace/ownership
guards are unchanged. The CI tail/snapshot retains final outcomes and these
source/operation/generation observations instead of only `queued` or `other`.

HTTP failure evidence reads at most4096 bytes/16 chunks and waits at most250ms,
cancelling only its own response reader. Output contains status and finite
category, never response text. Hook/HTTP fixtures keep all original behavioral
assertions; native fixture execution remains CI-only.

## Verification qualification

- Qualified red on unchangeddf1aa84f production: PID31164 exit1,60s bound,
  three failures. Two are absent final-settlement evidence; one is the
  protocol-refused note blocking its final. Only fake time drains the old finite
  retry budget for cleanup. These are not three independent native root causes.
- Earlier PID10832 exit1 included a test-clock cleanup mistake: the test had not
  yet mocked timers/promises, so cleanup reached its10s fixture timeout. It is
  retained as failed harness evidence, not the qualified behavioral red.
- Working PID43288 exit0 covered25 checks; later PID74604 exit0 covered33 checks
  including original UUID receipt recovery, bounded HTTP reads and real client
  frame parsing with mocked transport. Working noEmit PID77360 found one
  test-only signal-listener argument, then corrected. None is labelled as a run
  at a later frozen commit.
- Exact frozen head/tree, own PIDs, commands, exits, selected/excluded counts,
  source-pin/retention checks and noEmit are in
  `E:/AgentData/reports/ab458-pr141-<head>-runner-settlement-validation.json`.

The runner tests use the actual orchestration, order/retry/final helpers,
fsynced quarantine writer and runner-state persistence, with one fake provider
and mocked node transport. They do not establish real broker admission. The
parser test uses production request/response decoding over mocked sockets and
only refusal/status operations; no mailbox effect is granted. Selected session
fallback checks use production broker/store guards with the subsequent worker
launcher and native OS discovery mocked. No provider, daemon, TLS fixture,
full local suite, build, install, release, Bridge call or further agent ran.
All13 protected method pins, UI source and normalizer stay unchanged; no pin
amendment is requested. Parent fresh review and hosted full/native/lifecycle
gates remain mandatory. Earlier tenth-runner/note-retry/fairness causes are not
retroactively proven by this patch or by one platform's passing CI cases.
