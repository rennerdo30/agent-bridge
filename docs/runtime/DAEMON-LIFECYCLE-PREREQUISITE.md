# AB325 1a-i lifecycle prerequisite proposal

Status: **design only; implementation and release blocked pending independent Sol review,
Claude assessment and coordinator approval of this exact note**. The owner now requires
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

Use one disclosed finite lifecycle preparation/drain budget compatible with the
existing 10-second RPC deadline; return a durable pending receipt promptly rather
than holding/replaying a mutating call. Freeze exact phase budgets in reviewed tests
before implementation; do not increase generic RPC deadlines. Drain timeout, receipt
flush failure or an unverifiable checkpoint returns `failed_serving`, opens admission
again and leaves endpoint/services up. Never abort accepted writes to pass the gate.

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
