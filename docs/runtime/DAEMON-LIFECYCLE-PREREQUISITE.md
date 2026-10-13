# AB325 1a-i lifecycle prerequisite proposal

Status: **successor design only; implementation and release blocked pending independent
recheck, Claude assessment and coordinator approval of this exact note**. The owner now requires
core status/restart/stop before 1a-i release. 1a-ii update integration and dashboard
controls remain separate and have not started. This is the narrow lifecycle subset
of 1b approved for design, not permission for a general epoch/state-core/jobs rewrite.

Source inventory: base `7adb4817ea2800e56bd26737a81dbe28d7f17219`, published initial
candidate `107444c7c705ba723cb69621d87dbbc60a733154`, draft PR17. Original design is
`a7d87f8fa30bae99a0fdd577c5e7c587a4142759`. Initial hosted run `38373145537`
failed its unchanged-source checksum gate after the approved dashboard lifecycle
handler addition. New daemon fixtures passed, including Linux parent-group death
and Windows prohibiting Job Object/current-user checks. That is initial extraction
evidence only, not restart/stop or full owner acceptance.

This successor addresses independent review AB325 comment 32318: P2 freezes the
budget and source-pinned adapter/checkpoint obligations below; P3 separates a normal
release witness from crash exit proof. The reviewed predecessor remains immutable
at `354b132171e4e2e8b85c7f18b1aad052cd25e732`. Adapter inventory is pinned to source
`44730015299fb7ad51fd5fd6c4da711348d8f071`; it is a proposed implementation contract,
not certification that current shutdown/capability paths satisfy it. Claude ratified
the initial numeric defaults through the coordinator; hosted phase measurements
remain absent and must be disclosed per OS in the eventual implementation PR.

## Source obligations and gaps

| Existing owner | Actual behavior and missing lifecycle proof |
| --- | --- |
| `core/broker.ts` dispatch/requestTurn/Conn.inFlight | Tracks each connection, schedules handler starts, and accepts new mutating requests while others await SQLite/network. No reversible global admission gate or complete operation-settlement counter. Socket acceptance, handler start and durable mutation are different boundaries. |
| `core/store.ts` retryWrite/stopWrites/close | retryWrite can wait indefinitely on asynchronous SQLite retries; stopWrites aborts them. Broker.close currently calls stopWrites before all dispatched handlers settle. Abort/close is not proof an accepted operation persisted. |
| Broker pendingJobMailRoute/retry/timers/nativeChildren/networkChange | Background delivery/routing, disconnect callbacks, native-child retained routes and network reconfiguration can mutate stores outside a tool handler. Every producer and outstanding mutation must participate, including work triggered by connection loss. |
| `core/history-background.ts`, job-archive-background, backup-background | Current close paths stop/terminate workers or reject pending requests. They do not expose a verified persisted checkpoint for every admitted candidate. Worker exit alone is insufficient durability evidence. |
| `network/link.ts`, transfers, remote jobs/dashboard/decision sync | Pending link requests, extension frames and transfer/replay work have separate queues. Closing the service can reject an unconfirmed accepted remote effect. Active unresolved work must settle or block restart; original UUID/bytes remain retained. |
| `core/owner-question-service.ts`, mobile activation/host/gateway | Timers, answer/outbox/mirror work and active gateway handlers have independent settlement. Optional mobile disposal has a bounded timeout, which cannot be treated as successful lifecycle drain. Persist accepted answers/replay state before release. |
| `mcp/server.ts` shutdown | Cancels inline jobs and calls killAllDelegates. Core commands must never call this path, terminate an MCP, cancel jobs, change grants or kill native children. |
| `mcp/jobs.ts`, runners/hosts/feeds/spec/state/relays and old binaries | Independent writers remain legacy. A daemon drain cannot silently fence them. Execution can continue; capable clients must acknowledge only their election/reattachment barrier. Unknown clients/writers capable of conflicting election or unsupported delivery/control block lifecycle handoff. |
| BridgeNode election, paths and plugin-runtime | Endpoint identity is protocol-versioned, creation can be ambiguous, and active runtime selectors are per plugin. No canonical restart barrier, durable lifecycle receipt or selected replacement ownership currently exists. New/retained clients can otherwise win election during a release/bind gap. |

Candidate read-only status may expose version, actual broker PID/process uptime,
daemon/embedded/degraded mode, authenticated connection counts, connected runner
count and explicitly labeled legacy running-row count. Labels/PIDs are not proof
of execution. Status must not create/start a daemon or mutate jobs/ownership.

## Minimal additional boundary

### P2: pinned owner/adapters and checkpoint manifest

All anchors in this table refer to source `44730015299fb7ad51fd5fd6c4da711348d8f071`.
Each row requires a reversible producer gate, tracked admitted work, settlement
without cancellation and a verified durable checkpoint. Adapter names describe
required responsibilities, not existing APIs. No row currently has certified
lifecycle closure. A disabled owner must prove it was never instantiated and has
no pending work; an unsupported active owner returns a fixed `owner_unsupported`
blocker before release. Any newly discovered producer adds a review requirement,
never an implicit exemption or expansion into a general state domain.

| Owner and exact source anchor | Required adapter and checkpoint proof |
| --- | --- |
| Broker `broker.ts:714-801`, `627-657` | `dispatchAdmission`: gate before handler acceptance, track scheduled requestTurn and handler continuations independently of socket presence; settle every admitted handler, excluding only lifecycle control/lookup itself. Record accepted/settled work counts, zero unfinished operations and the complete read-only/mutating operation classification. `closing`/Conn.inFlight alone is insufficient. |
| Disconnect/native routes `broker.ts:749-762`, `1497`, `1571`; `native-children.ts:20,67,72` | `disconnectRoutes`: register endParent/recover/replacement callbacks and their write promises; close-time disconnect must neither end surviving children nor reroute their accepted mail as a side effect of restart. Preserve exact route/mail bytes, settle already admitted fallback work; inhibit teardown producers before transport release. Missing continuity proof blocks active-child restart. |
| Mail delivery/reroute `broker.ts:990-1057,1778-1780,1841,2019-2066` | `mailSettlement`: gate timers/new sends, settle pendingJobMailRoute/Again/retry, sendingByKey, remote response continuations and all writes they enqueue. Checkpoint original UUID/body/recipient/read-receipt bytes and unresolved delivery obligations; timeout/lost reply is not absence and cannot authorize resend. |
| MessageStore `store.ts:347-354,521,580,660-673` | `writeSettlement`: register retryWrite before scheduling, drain only after dispatch/producers settle, include archive timer and transaction/history sinks. Verify commits plus existing message/history/archive/decision/config stores and WAL recovery identity. Infinity retry remains live if budget expires; stopWrites/close must not abort it. Directory/file durability and any untracked direct mutation are explicit blockers. |
| History `history-background.ts:147-187`; `history-worker.ts:99-160,195-220` | `historyCheckpoint`: inhibit wake/peer/pressure/reconcile/restart producers, settle pending/reconcilingAsks/current tick and any ingestion/index work, preserve raw originals and resumable checkpoint/candidate bytes. Return an authenticated restart-bound checkpoint manifest after flush. Rejecting pending or terminating at two seconds is not proof; derive-only work may resume only from a proven persisted original/checkpoint. |
| Archive `job-archive-background.ts:58-71`; `job-archive-worker.ts:11-74` | `archiveCheckpoint`: gate repack/import requests, settle current migration/packing/import batch, retain originals/conflicting payloads, prove published archive/index and next-work checkpoint plus released migration/storage leases. AbortController stop and worker exit alone are insufficient; no deletion/finalization/migration is authorized by the lifecycle adapter. |
| Backup `backup-background.ts:47-93`; `backup-worker.ts:5-34` | `backupCheckpoint`: inhibit timer/restart, settle admitted capture/verification and acknowledge flushed complete or retained partial snapshot with manifest, original store remains readable. Current stop throws during capture; do not call it to pass drain or silently discard an admitted backup. Unprovable partial continuation blocks release. |
| Networking `broker.ts:487-488,642-649`; `network/link.ts:103-124,246-280,633-644`; `network/transfers.ts:146,252-288,535-647,660-664` | `networkCheckpoint`: gate networkChange/inbound extensions/bulk producers, settle pending requests and queued socket writes; persist exact transfer parts/journals/offsets/checksums and unresolved remote UUID/outcome obligations. Closing/rejecting pending, pausing states or ignoring drain is not success. Unknown remote effect remains retained/unconfirmed; if existing protocol cannot reattach it, refuse rather than replay or invent delivery authority. |
| Remote services `network/remote-jobs.ts:41-51,178-202,237,248-337`; `remote-dashboard.ts:13-72`; `decision-sync.ts:54-86` | `remoteCheckpoint`: include pendingStarts/starting, pending replies, mirrorIntents/Turns/States, feeds, approval publication and decision receives. Settle/persist existing remote records and accepted control/approval/result bytes without aborting a spawn, closing approvals or changing native execution. Dashboard reads must settle before resource retirement; unsupported unresolved activity blocks release. |
| Owner questions `owner-question-service.ts:16-26,99-143`; `owner-questions.ts:79-101,153-167` | `questionCheckpoint`: inhibit maintenance/default-answer timers, await mirrors and admitted answer/delivery/decision completion, retain original question revision/answer/outbox/mirror state durably. A mirror POST with lost response remains unknown and must not be replayed to claim settlement. Closing its SQLite store is not producer settlement. |
| Mobile/dashboard `mobile/activation.ts:52-138`; `mobile/bootstrap.ts:35-48`; `mobile/gateway.ts:22-53,164`; `mobile/store.ts:48-51`; `cli/ui.ts:289,722-726`; `cli/broker-daemon.ts:52-87` | `hostCheckpoint`: gate ensureDashboard/HTTP mutations/push/hint polls, settle all admitted handlers and dashboard sender work; flush unchanged registry/answer/grant bytes, retain selected origin/port/TLS/config/owner context. Five-second close/disposal races and late-response discard do not prove settlement. Listener teardown only after settlement; no security registry migration or UI feature is authorized. |
| MCP/runner independent owners `mcp/server.ts` shutdown; `mcp/jobs.ts`; `mcp/job-runner.ts`; `mcp/delegate-run.ts` | `clientElectionBarrier`: require exact instance/receipt capability acknowledgement and safe delivery/backpressure/reattach proof; do not drain or mutate session job queues, cancel/kill children or call MCP shutdown. Unknown election-capable retained binaries or unprovable accepted work block restart; process-name enumeration is not a complete writer census. |
| Receipt/storage ownership `json-store.ts:107-137`; `storage-lock.ts:17-57,91-105`; `node.ts` election | `receiptPublication`: verify restricted canonical physical home, nonce/process creation identity, atomic flushed receipt/revisions/gate/checkpoint manifest and selected-pointer durability on every OS; prove all eligible election paths consult it. Existing file fsync/lease logic is evidence to audit, not certified directory durability/canonical authority. |

The private checkpoint manifest is restart-bound:
`{schema,restartId,oldInstance,sourceManifestDigest,revision,owners:[{ownerId,
adapterVersion,sourceAnchors,producerGate,acceptedCount,settledCount,pendingCount,
checkpointRevision,artifacts:[{relativePath,bytes,sha256}],durabilityEvidence,
ownershipReleaseEvidence}],closureDigest}`. It contains no tokens/content in
public status/logs; private entries reference preserved existing bytes, never newly
invented job/domain state. acceptedCount must equal settledCount OR every retained
pending obligation has a verified durable original/checkpoint and an existing safe
resume contract; absent such a contract, pendingCount must be zero. Counts alone
are not durability proof. Replacement validates each digest/checkpoint before done.

Receipt publication, durable checkpoint and writer-census proof remain implementation
entry gates. This table freezes the obligations/file boundary; it does not authorize
rewriting unsupported services to fit the boundary. An adapter needing a new domain,
remote replay protocol or complete global census must return to the coordinator.

### P2: ratified numeric budget and pending command semantics

Named initial constants (milliseconds) are `LIFECYCLE_PRE_RELEASE_MS=10000`,
`LIFECYCLE_ADMISSION_MS=1000`, `LIFECYCLE_PREPARE_MS=5000`,
`LIFECYCLE_DISPATCH_DRAIN_MS=2000`, `LIFECYCLE_WRITE_CHECKPOINT_MS=2000`,
`LIFECYCLE_BIND_OBSERVE_MS=2000`. Measure with one monotonic clock from command
admission. Each phase deadline is min(t0+10s, phaseStart+its named cap); the maximum
cumulative boundaries are t0+1/6/8/10s. Early completion does not donate time or
reset/extend another phase's cap. No nested hidden retry
or generic deadline inflation. Freeze these constants in hosted tests; record each
phase and total per OS/runtime, adjust only through review of new measured evidence.

Admission/census/durable pending acknowledgement must finish within the first second.
An accepted restart RPC returns PENDING with the durable restartId/receipt revision,
never a completed outcome, because ten-second RPC cannot cover ten plus two seconds.
Receipt lookup is read-only: CLI performs at most 24 lookups at a minimum 500ms
interval within a 12-second monotonic observation envelope; each lookup uses only
the remaining envelope (and at most existing RPC10s). No overlapping polls, busy
loop, mutation replay or recreated ID. Envelope expiry prints pending/unknown and
the same receipt ID truthfully; a later explicit lookup can observe completion.

Prepare includes WMI/create, exact successor authentication and ready-to-bind within
five seconds; the creation timeout is not an extra allowance. Any pre-release phase
overrun reopens old admission and retains serving endpoints, publishes
`aborted:<phase>budget` as the failed_serving outcome and prohibits release. Do not
kill a possibly created replacement: it remains bound to the original receipt and
cannot bind without release_committed. Unknown WMI creation stays latched, no second
launch. Already accepted store/worker work continues settling while old serves.
If durable abort publication itself is unprovable, retain unknown receipt/election
gate and report it; do not claim a durably clean abort or a completed command.

Post-release two seconds is observation only, starting at verified endpoint release.
Bind/outcome timeout retains unknown plus same-receipt discovery; it never proves
death, grants takeover, replays work or permits rollback. A bind may eventually
complete beyond the observer envelope without another launch. Stop uses the same
admission/dispatch/write caps and total bound, skips replacement preparation, and
still cannot treat elapsed time as job safety or authorize automatic relaunch.

### P3: normal release witness versus crash exit proof

Normal release does not require killing or observing death of the old process.
After release_committed it must produce a restart-bound release witness proving:
its mutation gate remains shut; all owned admitted/teardown/disconnect producers
have settled or are inhibited; verified checkpoints are immutable; every writable
store/worker lease is released without cancellation; the public listener/accepted
old connections are released without causing untracked native-route/mail changes.
The still-live old coordinator owns no writable stores/public endpoint and cannot
reopen them or elect. Replacement validates durable selected-successor/checkpoints
and the authenticated exact-instance witness before binding. PID or socket absence
alone cannot substitute for this witness; current Broker.close is not the witness.

If the old instance crashes or the witness is lost/invalid, require verified exit of
the receipt's exact nonce/PID/process-creation identity plus checkpoint/ownership
reconciliation. Missing nonce/creation identity, unknown process inspection, auth
failure, a reused PID or time expiry is unknown, never an exit witness. A release
receipt without drain/checkpoint proof cannot be completed merely because old died.
Both mechanisms may fail and yield unavailable/unknown; no zero-gap guarantee.

Proposed files: new `core/daemon-lifecycle.ts` for a **restricted lifecycle receipt**
and its election gate; launcher/daemon/node wiring; narrow broker/protocol/CLI lifecycle
handlers; minimal store/background-service drain adapters and isolated fixture tests.
Before implementation, enumerate exact extra worker/service files needing adapters.
Any service without a bounded, reversible durable checkpoint blocks release rather
than being dropped, force-closed or rewritten into a new domain.

No state-core.db, general command ledger, job state machine, snapshot cursor,
receiver permits, executor launch or ownership migration is introduced. The receipt
is lifecycle coordination only. It cannot claim to fence arbitrary same-user software
or unknown legacy writers that ignore it.

## Restricted receipt and current-instance binding

Use one protocol-independent lifecycle directory under the canonical physical Bridge
home, mapped identically across supported aliases. Reject unsafe ownership/linked
publication paths using existing containment/private-material rules. Bind the same
user/home, current authenticated endpoint, broker-generated random instance nonce,
PID **and verified process creation identity**. PID/time alone never establishes
authority. Home/installation mismatch or unknown process inspection is unavailable.

One retained receipt per command:

`{schema,restartId,operation,homeIdentity,oldInstance:{nonce,pid,creationIdentity},
target:{immutableRuntimePath,version,protocol,fileManifestDigest},replacementInstance?,
state,revision,requestDigest,acceptedAt,checkpointManifest?,outcome?,failureCode?}`.

States are `accepted -> preparing -> draining -> prepared -> release_committed ->
binding -> done`, with pre-release `failed_serving`, post-release `unavailable`,
and unprovable `unknown`. Stop uses `accepted -> draining -> prepared ->
stop_committed -> stopped`. Retain all revisions and conflicting bytes; no deletion,
time expiry, overwrite by a reused ID or reconstructed guessed completion.

Publication must be all-or-none and durable before acknowledgement or endpoint
release: private temp write, complete bytes/digest, file flush, atomic selected-pointer
publication and platform-appropriate durable directory/rename proof. The existing
JSON helper's file fsync alone is not a full cross-platform directory durability proof.
Existing storage leases require audit: no timeout-only steal or process-identity
unknown recovery is allowed. This is an explicit implementation/CI dependency.

The serialized lifecycle coordinator verifies the current receipt revision and exact
bound instance before each transition. After a conflicting/paused holder, only proven
old-instance exit plus receipt reconciliation permits a successor; no lease-age takeover.
This is a narrow lifecycle generation/instance guard, not a general domain epoch claim.

## Writer/election barrier and replacement preparation

1. Authenticate the local lifecycle command. No remote host/arbitrary executable
   argument. Resolve an immutable installed runtime using existing publication/selector
   containment and complete hashes. 1a-i initially restarts the same approved runtime;
   N-to-N+1 selector/update behavior is 1a-ii. Refuse mixed incompatible protocols.
2. Establish a capable-client barrier. All connected eligible MCP/CLI clients and
   retained election-capable installed runtimes must advertise/acknowledge lifecycle
   support bound to this exact instance/receipt revision. Discover relevant detached
   writers using existing capability/process evidence; unavailable inspection, old
   unacknowledged clients or unknown writers **blocks restart** with nonsecret reason
   codes and an explicit process/version list. Names are explanatory, not identities.
   No forced exit, eviction, cancellation or invented complete census.
3. Persist accepted receipt and active canonical election gate **before** spawning a
   replacement. Updated launchers consult it before any daemon or degraded embedded
   election, including new clients never connected to the old broker. Active/pending
   receipts mean wait/discover/status, never another launcher. Unknown receipt/capability
   or authentication failure means unavailable, not absence. This closes the bind gap
   only if all capable election paths participate; unknown legacy elections block it.
4. Start the replacement once, with the original restartId and exact target identity.
   It validates the private receipt/runtime and connects to a scoped authenticated
   preparation channel. It creates **no writable stores/public listener** while old
   serves. Prepared acknowledges exact replacement instance/process creation identity,
   compatible runtime, readable verified receipt and ability to attempt the endpoint.
   This is readiness to bind, not a claim that an unattempted OS bind cannot fail.
5. Failure/timeout/invalid creation receipt remains unconfirmed. No second launch.
   The old broker keeps serving while preparation is unresolved. A prepared replacement
   watches durable receipt state; it never elects independently or treats time as release.

Capability closure/census and restricted atomic receipt are prerequisites, not facts
established by PR17. A globally unknown legacy writer makes an unconditional restart
guarantee impossible; return a concrete blocker instead of widening authority.

## Admission, drain and endpoint release

The lifecycle operation enters an in-memory reversible `draining` state only after
durable admission/preparation. Gate mutations at dispatch **before acceptance**, plus
background/timer/network/mobile producers. Read-only status/health, authenticated
receipt lookup and reconnect discovery remain available. Previously accepted handler
work is tracked to settlement; the initiating control/receipt-read request is excluded
from its own wait, never allowed to make the barrier trivially pass.

Drain **dispatch first, then writes**, including work handlers enqueue after awaiting.
Then checkpoint each owned worker/store/outbox/transfer/mobile queue and verify the
retained bytes/checkpoints. Independent MCP/runner execution continues unchanged;
do not replay mutations merely because a connection disappears. Child heartbeat,
report and approval delivery need explicit capable settlement/backpressure semantics;
if current legacy adapters cannot preserve them through the bounded gap, refuse.

Use the exact monotonic budget and durable pending-receipt semantics below; do not
increase generic RPC deadlines. A pre-release phase overrun aborts the reversible
transition, retains the old endpoint/services and reopens admission. Never cancel
accepted writes or terminate workers to manufacture successful drain/checkpoint.

After prepared replacement + verified drain/checkpoints, persist `release_committed`
and its exact designated successor before releasing the public endpoint. Only that
replacement may bind/open existing stores, verify/recover checkpoints, advertise its
instance and persist `done`. Clients reconnect and fully refetch through existing APIs;
no new snapshot/event cursor or automatic mutating request replay is claimed.

There is a bounded public-endpoint gap between release and successful bind. Do not
promise zero unavailability. Replacement bind/readiness/durability failure after release
is explicit unavailable/unknown. No automatic old-executable rollback or duplicate
replacement launch is authorized by elapsed time. A reviewed reconciliation may prove
old/replacement exited and grant a new explicit recovery intent under a new receipt;
it cannot erase pending accepted bytes or pretend the original command never applied.

## Idempotency, stop and crash cases

Same restartId + identical immutable request returns its retained pending/done/failed/
unknown receipt. Different bytes/target conflict. Receipt lookup is read-only after
reconnect and scoped to the authenticated local lifecycle principal. Lost reply never
authorizes a fresh ID, second launch or rollback. Corrupt/missing/unflushed receipt after
acceptance stays unknown; it cannot be repaired by replaying the effect.

Stop must also gate future automatic launches. Persist `stop_committed/stopped` as
an intentional availability state that updated clients honor indefinitely, until an
explicit authenticated user lifecycle resume/restart intent is reviewed. No time-based
autostart. Stop refuses while active/unknown jobs, live native children, pending accepted
delivery, approvals/waits, unsupported writers or uncheckpointed work would be stranded.
Do not infer safety from a zero historical badge. Minimal safe stop can conservatively
refuse any unresolved execution or election-capable client. It does not kill children
or call MCP shutdown; ordinary future demand cannot override the stop receipt.

| Crash/race | Required retained result and recovery |
| --- | --- |
| Old dies before accepted receipt is durable | No success receipt; ambiguous accepted work remains unknown. Reconcile exact original stores/instances, never blindly repeat. |
| Old dies after acceptance but before successor preparation/release | Active gate blocks ordinary election. Existing designated replacement waits; recovery verifies old exit and checkpoints. Without proof, unavailable/unknown, no takeover. |
| Replacement dies before ready | Old stays up; pre-release failure or unknown receipt. No timeout-driven second launch. |
| Replacement dies after prepared but before release | Old must revalidate live authenticated exact successor before release. If unprovable, failed_serving/unknown and remain up. |
| Old dies during drain | Receipt/checkpoints survive; successor cannot infer drain success. Reconcile all admitted queues or block. |
| Receipt write/fsync/selected-pointer fails | Before release remain serving and report failure; an acknowledged but unprovable generation blocks release/recovery. |
| Old dies after release commit before actual endpoint close | Successor waits for exact old-instance exit and safe endpoint availability. No unlink/kill of a live unknown holder. |
| Replacement dies after ready/release or before done flush | Preserve release/designated successor/checkpoints; unavailable or unknown until exact outcome is proved. No automatic duplicate/old-runtime rollback. |
| Both unavailable or discovery auth/token/protocol failure | Keep receipt and bytes; explicit unavailable/unknown. PID absence, connection timeout or name reuse never authorizes new election. |
| New capable client arrives during bind gap | Reads canonical gate and waits/discovers original receipt; does not launch embedded/daemon. |
| Legacy election/client appears during prepare | Abort before release and remain serving. Arrival after closure cannot be called safe without writer/deployment proof; do not force eviction. |
| Lost command reply after release/done | Query same receipt. Existing reconnect/full-refetch may observe new host; never replay accepted lifecycle/mutating work. |
| Stop with active native/runner/inline work | Refuse, endpoint remains serving, no child/cancel/ownership effect. |

## Review and hosted acceptance

Mandatory fixtures on Windows/Linux/macOS with Node 22/24: same-home alias/new-client
restart race, active MCP and detached runner/native-child continuity, exact accepted
mail/report/approval bytes, dashboard reconnect, forced parent job containment, receipt
write/flush faults, deferred SQLite and worker checkpoints, drain-timeout-stays-serving,
lost reply/same-ID conflict, legacy/unknown writer refusal, all crash rows above and
replacement bind/version/identity failure. Fixture-only processes/stores, no model calls
or owner-PC workloads. Preserve raw outcomes, checkpoint hashes, source/target/runtime
manifests and any unavailable/unknown result; no skipped race, timeout inflation or
assertion weakening. A green initial launch test cannot satisfy these gates.

Independent reviewer must identify whether complete source closure, durability and
canonical election gating are achievable within the named narrow subset. If not,
document the exact unmet prerequisite and return to the coordinator/Claude; do not
silently implement general 1b or claim safe restart from plain process spawn/close.
Only after reviewed-note approval may restart/stop code begin. No 1a-i release without
status and accepted safe restart; owner next step after eventual 1a release is AB319
remeasurement, not later-stage jobs/state/UI work.
