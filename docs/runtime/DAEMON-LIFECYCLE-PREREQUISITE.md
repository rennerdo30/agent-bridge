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

Receipt-mechanism successor: the coordinator/Claude approved proposing a lifecycle-only
SQLite journal using the already-supported `node:sqlite` dependency. This document
changes publication from a JSON temp/rename/selected-pointer scheme to one fixed
restricted-home journal. **Journal code remains held for independent recheck and
Claude assessment of this exact mechanism revision.** Source baseline for this
mechanism inventory is `35227bed0cfabf3e47d9418b8dd5114c9eed08d4`; owner/drain
anchors remain pinned to source447 above. No general state-core/job migration.

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
overrun BEFORE an uncertain intent COMMIT reopens old admission and retains serving endpoints, publishes
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
and the authenticated exact-instance witness before **any writable store, lease,
worker acquisition or initializer**, and before binding. In current source447,
broker-daemon.ts:31 constructs MessageStore before listen:70; store.ts:196-226 opens
and initializes multiple writable databases. A bind-only guard would leave an
initializer gap: release_committed precedes actual old-owner release and does not
authorize those constructors. Preparation remains read-only with no writable
initializer until this witness, or the crash reconciliation below, is verified.
The same guard covers successor recovery, every store constructor and side worker;
selected-successor/release_committed publication is not actual release proof.
Unknown or malformed receipt remains read-only/unavailable, with no automatic
repair or promotion to writable initialization.
PID or socket absence
alone cannot substitute for this witness; current Broker.close is not the witness.

If the old instance crashes or the witness is lost/invalid, require verified exit of
the receipt's exact nonce/PID/process-creation identity plus checkpoint/ownership
reconciliation **before any writable initializer/acquisition or binding**. Missing
nonce/creation identity, unknown process inspection, auth
failure, a reused PID or time expiry is unknown, never an exit witness. A release
receipt without drain/checkpoint proof cannot be completed merely because old died.
Both mechanisms may fail and yield unavailable/unknown; no zero-gap guarantee.

### Proposed final-close ledger and last control-journal ordering (review required)

This successor note proposes the final release boundary; it does not authorize
ledger, store-close, worker-release or role-promotion code. Source pin for this
proposal is `3e53b13b0a8cf9c6102b265575fa8fca2063ac4b`. The current additive
metadata stage is checkpoint-only/all-handles-retained; archive settlement observes
producers, not store release. Neither default `close()` nor a worker exit supplies
the following proofs. History/project closure is still unsupported.

`release_committed` (or `stop_committed`) is durable INTENT, NEVER promotion
permission. Before it, every required managed producer, opener, migration,
accepted dispatch/disconnect/native-route/mail operation, renewal and teardown
producer must be sealed and settled under its exact owner instance/nonce,
process-creation identity and generation. Include owned dashboard sender/HTTP
operations and metadata-reader registrations; an HTTP close that creates a late
broker disconnect/write is itself an owned producer, not cleanup proof. Unsupported
closure, an unaccounted handle, a changed owner/generation or a pending unknown
result blocks BEFORE endpoint release. Freeze actual FULL/autocommit/identity and
checkpoint evidence for every owned handle and schema; do not infer external-process
writer closure or treat installed inactive versions as live participants.

All substantive handles and leases remain owned during reversible preparation.
Pre-release failure/overrun BEFORE any uncertain intent COMMIT leaves the endpoint
serving and restores only proven reversible producer/admission gates. Once intent
COMMIT is ATTEMPTED, a throw/timeout/unavailable transaction observation may have
committed it. Latch all seals and retain substantive handles/leases/endpoint; do not
resume ordinary old writes, release, close or promote the target from absence or
timeout. Independent committed-only observation and known local settlement must
prove rejection or a durable matching abort that cannot later be interpreted as
release-ready before any resume claim. If that outcome is unprovable, old stays up
with truthful unavailable/unknown control admission; it is not a clean normal-serving
resume. Never clear quarantine, issue another intent attempt or force-close to
manufacture resolution. This is distinct from a proven reversible drain refusal.
No partial close/reopen or cached-statement
reconstruction is authorized as that abort mechanism. Once selected replacement
preparation, checkpoints and intent are committed, irreversibly inhibit all old
managed writes/openers/teardown/renewal callbacks and release only the actual owned
endpoint/accepted transports. Native routes must already have the frozen committed
zero proof; do not call endParent/recoverOrphans to manufacture it. Any unexpected
disconnect/registration/generation invalidates release eligibility. Stop applies the
same ownership ordering, with persisted stop intent and no prepared successor.

After actual endpoint release, close the substantive resources with a retained
per-handle ledger `{ownerInstance, ownerNonce, generation, handleId, fileIdentity,
schemaIdentities, checkpointRevision, status}`. Status is exactly `unattempted`,
`attempted`, `closed`, `failed` or `unknown`. Register every handle before any attempt;
record a close only after the real owned call returns successfully and source-owned
consumer/statement invalidation is accounted for. A close error retains the entry
and any remaining handle; never clear the registry or release its lease in a finally
block to fake completion. Count aliases per connection, not just physical files.
Worker release ACKs must bind the exact request/worker/generation and attest all
owned handles plus accepted queues; actual exit alone is insufficient. No abort,
termination, rollback, replay, migration, repair or close-based durability claim.

The post-release two-second monotonic deadline is ONE shared observation envelope
for ledger returns, final post-close ACK transmission/observation, replacement bind/readiness
and outcome observation, not a fresh two seconds per resource. Sync SQLite close,
COMMIT and filesystem operations cannot be cancelled by that observer. Do not start
a new attempt after expiry. A return/error/ACK after the deadline yields UNKNOWN to
the expired observer; it never proves timely settlement, authorizes another launch,
or reopens old admission. Retain exact attempted/unattempted/unknown entries and
durable intent. Availability can remain interrupted: no old rollback or zero-gap
claim after endpoint release.

The restricted lifecycle journal is the explicit LAST control resource. While its
writer remains open, it may commit only release-ready INTENT/checkpoint revisions
under sealed ownership; no durable record claims that this still-open writer is
already released or that a successor is eligible. Validate the final intended
revision through a separate verified committed readonly snapshot first. Then
irrevocably revoke old admit/advance/open/renewal/queued journal permissions, drain
prior journal transactions, close the actual LAST journal connection and release
the exact owned control-role lease without a renewal task. Register and account for
each attempted native close. Unknown COMMIT/transaction state stays quarantined;
no writer SELECT, fresh BEGIN, repeated effect or auto-close as rollback proof.
An unknown/failed last close/lease release cannot generate a witness. No journal
write, reopen or fresh reader constructor in the old process after final closure.

Only AFTER actual last-journal/control-lease closure may old send a NONMUTATING
authenticated exact-instance post-close ACK to the original selected successor.
Bind the ACK to restartId, committed intent revision/digest, journal lineage/file
identities, old nonce/PID/creation identity, owner generation, original authenticated
prepared ACK, selected replacement nonce/PID/creation identity, verified target
version/manifest and complete actual close-ledger digest. The ACK is an ephemeral
release witness, not a new journal write or a durable eligibility record. A trusted
source-owned role must have revoked EVERY captured callback/opener, not merely
flipped a caller-supplied/public boolean. A still-eligible old writer cannot ACK.

The selected replacement's exact authenticated control connection is an explicitly
retained NONMUTATING channel while the public endpoint and ordinary accepted
connections are released. Inventory listener identity, every ordinary/control
socket and inflight/disconnect producer separately: EndpointReservation.close
does not own Broker.conns or their route/last-seen/mail side effects. Convert only
the already-bound original prepared channel to this private role; it accepts no
generic auth/hello/send/control/extension dispatch, registration or mutation while
retained. It is not a public role flag, a new general transport, or a wire/config
option arbitrary callers can select. Refuse queued ordinary frames before any
handler/pressure/store side effects. Its send/flush/EOF/actual-close observations
must be bounded and instance-bound; do not assume Node Server.close's callback
completes with a retained connection or equate listening=false with native endpoint
release without hosted supported-transport proof. If the existing primitive cannot
release the endpoint while retaining this safely fenced channel, block/review the
smallest alternative; do not silently add another unsafe authority path.

Replacement first reads the matching committed intent/checkpoints with actual
readonly/query_only/non-hot lineage checks. It cannot promote from this INTENT
alone. It must receive the SAME authenticated post-close ACK, verify the original
channel/instance/ledger and actual release observations, then win exclusive
tentative bind. Its all-store guard and source-owned selected-role CAS precede ANY
writable acquisition/worker/initializer. After promotion only the selected successor
may append binding/done (or complete stopped evidence under its defined safe stop
role); old cannot write an outcome after its handles are closed. Preserve oldInstance
as receipt provenance and distinguish current journal writer from that historical
instance; current portable advance() does not yet implement successor role transfer.
No ordinary client, bind loser or unselected process gets promotion permission.

Missing/lost/invalid ACK, last-close failure, unknown channel release or late close
return keeps the successor readonly/UNKNOWN. Do not start an ACK send after the
shared deadline. An ACK sent only after proven actual closure may arrive late;
that cannot turn the expired observer into SUCCESS. Same-receipt discovery may
later observe the SAME selected successor's valid bind/readiness, never authorize
a second launch or interpret elapsed time as a release witness. If ACK is lost,
normal promotion is unavailable; only verified exact old-instance EXIT plus
ownership/checkpoint reconciliation supplies the separate recovery alternative.
Stop has no replacement: publish terminal stop INTENT while the last journal is
still open, independently validate it, then close actual resources. Observers must
not call that intent fully stopped while old resources/instance remain unproved;
it still blocks demand-start. Lost stop completion remains pending/unknown, not a
force stop or an opportunity to bootstrap. No write-after-close or old rollback.

Crash recovery is the separate exact old nonce/PID/process-creation EXIT plus
ownership/checkpoint reconciliation alternative, before bind and ANY writable
acquisition. A lost/invalid final witness, hot/partial journal, unknown PID identity,
unsettled ledger or unknown writer is not repaired or promoted merely because an
endpoint is absent. No second replacement launch, rollback, forced eviction or
automatic missing-journal bootstrap. Stop's valid terminal receipt must retain its
no-demand-start intent; an unknown stop is unavailable, not a force-stop success.

Required hosted Windows/Linux/macOS cases: partial close at each ledger position;
close error before/after actual native return; delayed worker release ACK/exit;
last-journal COMMIT_BUSY/IO/FULL/rollback failure and committed-only observation;
retired-role late callback/admit/renewal rejection; journal-close error preventing
post-close ACK; intent COMMIT late/unknown return retaining seals/ownership without
second effect or clean serving resume; last native close late return/ACK loss;
queued ordinary frames on the retained private channel and actual endpoint release;
new-client/selected-successor bind race; receipt loss/auth rejection; exact old crash
and replacement failures; accepted bytes/active detached jobs/connected dashboard
unchanged. Instrument only bounded primitive phase/ledger outcomes. No fixture or
source subset certifies full lifecycle closure until every required owner supports
this reviewed contract and the original timing/acceptance assertions pass.

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
release through the lifecycle-only journal contract below. Existing json-store.ts:107-137
fsyncs a temp file and renames it without established durable directory publication;
it is not the receipt backend. Existing storage leases still require audit: no
timeout-only steal or process-identity-unknown recovery is allowed.

The serialized lifecycle coordinator verifies the current receipt revision and exact
bound instance before each transition. After a conflicting/paused holder, only proven
old-instance exit plus receipt reconciliation permits a successor; no lease-age takeover.
This is a narrow lifecycle generation/instance guard, not a general domain epoch claim.

### Lifecycle-only SQLite publication proposal

Canonical location is the fixed physical-home path `.core-lifecycle/receipts.sqlite`;
there is **no external selected-pointer file**, version-dependent endpoint path or
selector that could discover a different journal. Every updated election path checks
this location before create/takeover/degraded embedding. Canonical physical home,
user identity and an immutable journal lineage UUID are committed during bootstrap,
before accepting a lifecycle command. Receipt revisions and the selected active
receipt/revision/old-instance/designated-successor projection commit in ONE transaction.
The projection is disposable only by verified reconciliation, not guessed absence.

Initial bootstrap is performed by the authenticated current daemon owner, never by
a prepared replacement or ordinary discovering client. The successor role/absence
contract below refines this to the already-bound normally serving singleton; absence
alone does not authorize bootstrap. Verify all ancestors and
the database/journal are regular, nonlinked, correctly owned private paths; retain
the physical-directory/file identities in lineage evidence. Create the new directory
0700 and files0600 on Unix, flush initial schema/lineage and validate reopen through
a separate strict reader before acknowledgement. Require durable directory-entry
proof for initial database/journal creation (Unix directory sync/VFS evidence;
Windows documented VFS/FlushFileBuffers and local-filesystem creation assumptions).
If initial lineage/publication proof cannot be established, refuse lifecycle admission
while the old daemon serves; SQLite does not make that missing proof disappear.
After bootstrap, absent/replaced/corrupt/mismatched journal is unknown, never permission
to re-bootstrap or elect. A participant that has observed lineage must retain that
identity for its lifetime; release must not occur while a new participant can mistake
a missing journal for a never-initialized home. Prove this discovery boundary in
fixtures, including interrupted first creation; unknown lineage blocks election.

#### Successor: serving bootstrap, established journal and tentative endpoint

This section records the coordinator-relayed Claude choice after the independent
Windows establishment assessment. It is a DOC-only revision requiring independent
recheck and Claude short final BEFORE its new startup/bootstrap behavior is coded.
Portable receipt API/fault work under de420 is separate. Source anchors for this
mechanism correction are `02b1fe6d5860e4f509ec879544b784c50b526d85` (UI diagnostic
successor), `35227bed`/source447 for the earlier inventory, and the unchanged source
sections referenced below. It is not certification of current release safety.

There is no user provisioning command and no extra durable discovery anchor.
Only the controlled daemon instance that already exclusively owns the canonical
endpoint and is **SERVING normally** may perform first journal bootstrap. Clients,
prepared/designated successors, tentative listeners and a process in a handoff gap
must never bootstrap. A virgin home first obtains the existing transport singleton,
initializes its normal broker and serves; that owner then establishes the lifecycle
journal. Missing/unestablished journal makes restart/stop return the fixed
`journal_not_established` reason while that normal owner keeps serving. It is not a
receipt acknowledgement or lifecycle effect. Bootstrap failures retain their bytes;
no implicit repair/recreation of an interrupted or ambiguous existing directory.

Establishment requires a real committed bootstrap write that creates/uses the DB
and physical PERSIST journal, verified independent committed lineage and retained
DB/journal/directory identities, restrictive ownership/ACL and a later independent
strict readonly reopen. Initial file flush and reopened lineage are **operational
evidence**, not proof of directory-entry durability after arbitrary power loss.
Record actual SQLite version/compile options/default VFS, local filesystem/runtime,
flush results and Windows creation assumptions. Without the reviewed publication/
establishment evidence, remain lifecycle unavailable; never promote file existence
or a self-recorded marker to a universal durability claim. Hosted process-crash
fixtures do not certify physical power-cut behavior. ACL creation/protection is
bootstrap-only and only for exclusively created receipt paths; each restart still
validates ownership, permissions, nonlinks and identity without repair or ACL changes.

Every writable lifecycle connection verifies PERSIST/FULL, journal_size_limit=-1,
trusted_schema=OFF, foreign_keys=ON, 25ms busy cap and macOS fullfsync. Established
DB AND PERSIST file must already exist with the verified lineage/identities before
receipt writes. Missing/replaced files or hot-journal recovery ambiguity during an
active or designated handoff remain UNKNOWN. Never open/create a new empty journal,
recover writable from a prepared reader, change modes, ATTACH, VACUUM or prune history.
SQLite's pager can open its journal READWRITE|CREATE; preflight alone cannot atomically
prevent recreation under external removal. The supported controlled workload and
path protections must be explicit, with check/write-race detection and quarantine;
do not promise fencing of arbitrary same-user removers. Unknown proof blocks effects.

**Ordering for ALL controlled broker-owner startup paths** (designated successor,
ordinary daemon and explicit embedded compatibility): validate the canonical gate
and exact home; bind the exclusive canonical endpoint FIRST, THEN acquire/initialize
any writable broker-owner store, lease, lifecycle journal or side worker. A designated
successor additionally verifies the SAME authenticated normal release witness OR
exact old nonce/PID/creation-exit PLUS ownership/checkpoint reconciliation BEFORE the
first writable acquisition; it must also have won bind. Neither release_committed,
designation nor a valid witness alone bypasses endpoint exclusivity. Unknown remains
readonly/unavailable. Prepared replacement opens no other stores even readonly.

The endpoint is initially **TENTATIVE**, distinct from SERVING. Before initialization
and all applicable guards finish, it cannot acknowledge authenticated authority/ready,
admit a mutation or create an unbounded request queue. Use a typed fixed not-ready
response or strictly bounded frame/connection buffering with existing frame bounds;
preserve supported transport/auth semantics and disclose compatibility behavior.
Failure after bind but before initialization never advertises ready/done; report a
retained same-receipt unknown/unavailable outcome through the original authorized
journal writer/committed reader, release only the exact owned tentative endpoint,
and never start another successor automatically. A bind loser stays readonly, exits
without broker/store/journal initialization, cleanup, auth replacement or endpoint
unlink. It cannot write an UNKNOWN receipt on its own; the authorized old coordinator
or proven successor writer owns that publication, otherwise committed lookup says
unknown. Done follows initialization/checkpoint validation and serving readiness.

Fresh clients that have never observed lineage cannot distinguish a lost journal
from a virgin home without an extra anchor. Claude's explicit bounded fault choice
excludes wholesale EXTERNAL deletion of an ESTABLISHED lifecycle DB AND PERSIST
journal from stop/restart guarantees; there is no extra anchor or provisioning flow.
Deleting Bridge lifecycle/state files outside the Bridge can lose persisted stop/
handover intent, and ordinary demand-start may start again. Bind-first does not
restore lost history, checkpoints or intentional-stop evidence. This exclusion is
ONLY wholesale external deletion, NOT SQLite COMMIT/flush errors, failed or interrupted
bootstrap, Bridge-owned cleanup, partial absence, corrupt/hot journal or an unknown
publication result. Those remain retained unknown/fail-closed cases, never permission
to recreate a missing journal beside an existing DB or during an active handoff.

The owner also excludes EXTERNAL same-user or privileged processes replacing or
renaming Bridge store files DURING restart. Native fstat/atomic binding of SQLite's
live handles is outside 1a-i. Existing regular-file identities observed immediately
before/after open and freshly before/after checkpoint are observational hardening,
not an atomic handle-binding guarantee. Detected change, absent-before-open or
unprovable identity remains unknown/abort; a post-create stat is not open-time proof.
This exclusion never covers Bridge's OWN managed workers, migrations or accepted
writers: their seals, registry/generation checks, dispatch-then-write drains,
retained bytes and checkpoints remain mandatory. It does not weaken the partial,
hot, corrupt, internal COMMIT/flush/bootstrap failure or unknown receipt guards.
Checkpoint-only metadata observation retains every connection; each has its own
transaction/FULL/admission preflight. A bounded main-only database-list inventory
rejects ATTACH/temp/untracked aliases before any schema-qualified main checkpoint.
The SQLite -1/-1 no-WAL acknowledgement is not a completed WAL checkpoint. Path
alias grouping uses physical identities only after all per-handle checks; no
native-open, external-writer closure or ownership-release claim follows.

If in-memory lineage or already-available verified installation bootstrap metadata
shows a prior journal, status/health/logs use the fixed sanitized category
`lifecycle_journal_missing` (display text: "lifecycle journal missing (external deletion?)").
Restart/stop are unavailable while a normally SERVING holder establishes a new lineage;
it must make that NEW lineage explicit, with no silent continuity/history-restoration
claim. An old active/unknown lifecycle coordinator or designated successor must not
bootstrap or promote based on absence; an unresolved receipt remains unknown. A normal
serving role must independently prove its ownership/admission state before any new
establishment. No new main-store anchor write is authorized: use existing metadata
evidence only if already present/verified, never fabricate past establishment. A fresh
process with no such evidence cannot claim whether a new lineage is the home's first.

The compatibility choice lets journal absence use existing 0.30.14 election ONLY
within that disclosed whole-external-loss fault exclusion; it does NOT override remembered
lineage, malformed/hot/partial journal, designated-successor or active-receipt guards.
Therefore a fresh competing controlled daemon must win tentative bind before any
broker-owner writable acquisition, including while a successor waits. If it wins,
the designated successor remains readonly and the original handoff is UNKNOWN;
no false graceful-continuity or job-ownership rollback claim. Unknown legacy election
clients must have blocked restart before release; no forced eviction. Completeness
of the live writer/capability barrier and lost-journal gap behavior remain mandatory
source/race proof. Successful bind or reopened lineage alone does not classify a
publication failure as external deletion. Endpoint exclusivity proves only ONE controlled BROKER-OWNER;
legacy MCP/job/runner domain writers still exist and no full AB325 authority claim
follows. If this bounded compatibility choice cannot preserve accepted bytes or
prevent competing broker-owner writes, report the exact blocker for review.

Current source needs an explicit listener/store split: broker-daemon.ts constructs
MessageStore before Broker.listen; node.ts tryBecomeBroker does likewise. Separately,
node.ts constructor records store presence and restores ReadJournal metadata BEFORE
election. Those are existing CLIENT metadata writes, not broker initialization;
inventory and barrier their actual owners, never silently assert all writes occur
after bind. This contract requires startup wiring review; it does not authorize a
domain rewrite or certify client queues. Proposed narrow files: broker listener
reservation/adoption, daemon/node controlled startup, receipt path/reader guards,
and fixture acceptance. Any additional owner adapter returns to the coordinator.

Hosted acceptance additions: interrupted first bootstrap; actual committed bootstrap
write/reopen; lost DB/lineage marker versus virgin home from a fresh client; missing/
replaced PERSIST journal and check/write race; hot journal strict readonly refusal;
every writer reopen's mode/flush/size-limit settings; no per-restart ACL mutations or
new journal entry; fresh client versus designated successor tentative-bind race;
bind loser zero broker-owner writes/unlinks; failure after bind before initialization;
bounded tentative readiness/connection buffers; no job launch/ownership rollback;
explicit NEW-lineage/missing status on remembered whole external deletion, disclosure
that stop intent may be lost in that excluded case, and refusal for internal/partial/
hot/unknown failures; existing COMMIT/flush/quarantine/stop/revision/crash gates remain unchanged. Preserve
unavailable/unknown outcomes and all existing ratified budgets.

Windows must verify current SID ownership and a restrictive directory/file ACL
equivalent to the existing private authentication-material scope, using built-in
OS/.NET facilities only. New private receipt paths may receive a restrictive ACL;
do not alter existing home/job/store ACLs or widen grants. Failure/unknown ACL or
filesystem inspection blocks lifecycle, not a broad permission repair. No tokens,
auth material, arbitrary command line or content payload is persisted in receipts.
Target fields are attested existing immutable runtime path/version/protocol/complete
manifest digest, resolved in current authenticated local scope; never caller-supplied
executable/argv or an update selector. Revalidate before launch and writable activation.

Use a dedicated database only for receipt history, its active selection and lineage;
no jobs/commands/domain state, state-core.db, archive/delete/eviction, lease-age expiry,
schema migration of existing stores or new dependency. Configure and VERIFY
`journal_mode=PERSIST`, `synchronous=FULL`, macOS `fullfsync=ON`, `foreign_keys=ON`,
`trusted_schema=OFF`, and a25ms busy timeout. PERSIST is rollback journaling, not WAL;
commit retains the journal file and invalidates its header, avoiding per-commit
directory deletion. Durable history means COMMITTED receipt/revision/conflict table
rows. The physical PERSIST rollback file is reusable, not an append-only archive
of failed/uncommitted SQL or acknowledged receipt history. Do not archive/delete an
active/hot journal as a retention action. A failed/unacknowledged transaction may
have no durable failure row; disclose unknown rather than claiming its bytes were
retained. Separately committed failure evidence is retained when safely provable.
Never truncate/prune committed lifecycle history to meet a size envelope.
Legacy code must not be offered this database as a compatible domain store.

The sole writer before release is the OLD daemon. Prepared replacement opens with
actual `DatabaseSync(...,{readOnly:true})` plus verified `PRAGMA query_only=ON`; it
reads ONLY its own selected receipt/revision/lineage and target/checkpoint descriptors.
It opens no other store even read-only unless a separately reviewed exact verification
read is listed. Its prepared acknowledgement is sent through the authenticated old
control channel; the old writer validates instance/restartId/expected revision/target
digest and records it with a CAS transaction. Stale/concurrent ACK or reused ID with
different bytes cannot advance selection. There is no prepared writer-registration
or journal-write exception. Hosted attempted UPDATE/INSERT from this actual reader
MUST fail, and an ACK cannot make it writable.

Only after the SAME normal-release witness, or exact old nonce/PID/creation-exit
PLUS ownership/checkpoint reconciliation, may the designated successor acquire a
writable journal connection under the **all-store pre-writable guard**. Then it may
acquire substantive stores/workers and CAS binding/done. release_committed alone is
not release proof. If a readonly open encounters a hot journal requiring write
recovery, unavailable schema, missing lineage or corrupt bytes, stay unknown/read-only;
do not silently open read-write to repair it. Recovery writer acquisition uses the
same guard, never PID absence, time or installed-version/cache evidence alone.

Small transactions use indexed current receipt/ID lookups, BEGIN IMMEDIATE and
expected revision/old-instance/selected-successor CAS; append revision and selection
atomically, no transaction across asynchronous preparation/dispatch/drain. Maximum
serialized receipt/checkpoint metadata is64KiB per revision, with at most128 owner
descriptor entries; oversized closure evidence blocks release, never drops entries.
The25ms lock wait is within each ratified phase cap, not an extra budget. Busy/error/
unconfirmed COMMIT returns pending/unknown or pre-release serving failure; no hidden
transaction retry, inferred rollback, repeated launch or ordinary request replay.
Durable disk flush can stall despite a small transaction: disclose measurements and
storage assumptions, do not claim a universal hard OS I/O deadline or raise10s RPC.
No synchronous bulk scan/checkpoint/hash operation is added to the control path.

#### Failed COMMIT settlement and committed-only observation

[SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html) distinguish
a BUSY COMMIT, which can leave the transaction active, from automatic rollback on
some errors; an exception alone proves neither rollback nor persistence. Use
Node22.16's `database.isTransaction` (SQLite autocommit state) to inspect this LOCAL
receipt transaction. Never publish, prepare, release, promote ownership or report
done from a SELECT on the writer connection: it can see tentative uncommitted rows.

Every externally observed transition is checked through a separate verified strict
readOnly/query_only connection and fully settled indexed SELECT, with matching
lineage/restartId/revision/old instance/request digest. It sees only a committed
snapshot; do not retain a reader transaction/iterator that obstructs COMMIT. Success
requires returned COMMIT success, writer autocommit true, expected committed revision
from that reader AND the configured VFS/durability assumptions. A readable tentative
or even newly visible row after an I/O error is not proof a flush succeeded.

On failed BEGIN/COMMIT or I/O/FULL/unknown transaction error, latch lifecycle writes
and effect advancement BEFORE another observer/control request can use tentative
state. Within the remaining phase budget, if isTransaction is true attempt ONE
explicit ROLLBACK of ONLY this known local UNCOMMITTED receipt transaction, then
require isTransaction false and independent committed-snapshot verification. This
is transaction settlement, not rollback of accepted work, stores, jobs, a committed
lifecycle effect, replacement creation or public endpoint release. Never retry COMMIT,
replay a CAS/effect, begin a nested transaction or infer absence from an exception.

If settlement/autocommit/committed observation/durability is unprovable or the phase
budget is exhausted, quarantine that writer/connection and keep the command unknown.
Do not use its tentative revision; do not automatically reacquire another writer,
repair a hot journal, launch another replacement or report a durable failed outcome.
Release an owned connection only through proven local settlement; failure to release
its lock remains an explicit blocker. Committed prior rows and any hot artifacts
remain preserved. Receipt queries use the strict reader and disclose unknown when
blocked; no writer-state fallback. A separately persisted failure revision, if one
can be safely committed without retrying the effect, is distinct from the failed CAS.

Before public release, the old daemon may continue/reopen serving admission ONLY
after proving its substantive ownership stayed intact, no release or successor
writable acquisition occurred, and reversible producer/admission state is safe.
Otherwise retain a truthful blocked/unknown state; do not manufacture failed_serving.
After release, no old-serving/rollback claim follows from a journal exception.
Required hosted faults: BUSY COMMIT with active transaction, I/O/FULL auto-rollback
versus active state, ROLLBACK failure/budget exhaustion, writer tentative selection
invisible to strict receipt reads, success-but-reader-failure quarantine, no prepared
write/ownership advancement, preserved committed history and reusable PERSIST-file
semantics. These are code-entry/acceptance obligations, not existing runtime proof.

Primary basis: [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html),
[locking/VFS flush behavior](https://www.sqlite.org/lockingv3.html),
[rollback journal modes](https://www.sqlite.org/tempfiles.html),
[Node22.16 SQLite API](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html).
SQLite's guarantees depend on correct VFS locking/sync, a supported local filesystem
and storage honoring flush/barrier semantics. Filesystems/controllers that lie,
unsupported network mounts or unverified initial creation/ACL are blockers/unknown;
FULL/PERSIST do not eliminate hardware/power-loss risk or bounded-history storage cost.
Hosted Node22/24 on every OS must record actual SQLite/VFS/OS/filesystem/runtime and
phase durations, strict readonly flags/pragma, initial creation/reopen lineage, crash
at every revision/selection/ACK/commit boundary, busy/fault injection, stale CAS,
lost reply and same-ID conflict, exact accepted bytes and no second launch. Process
crash/fault fixtures are not physical power-cut or arbitrary-device durability proof.
Any missing release/durability/live-writer proof keeps lifecycle acceptance blocked.

## Writer/election barrier and replacement preparation

1. Authenticate the local lifecycle command. No remote host/arbitrary executable
   argument. Resolve an immutable installed runtime using existing publication/selector
   containment and complete hashes. 1a-i initially restarts the same approved runtime;
   N-to-N+1 selector/update behavior is 1a-ii. Refuse mixed incompatible protocols.
2. Establish a capable-client barrier. All connected eligible MCP/CLI clients and
   actual live runtime/writer registrations must advertise/acknowledge lifecycle
   support bound to this exact instance/receipt revision. Discover relevant detached
   writers using existing capability/process evidence; unavailable inspection, old
   unacknowledged clients or unknown writers **blocks restart** with nonsecret reason
   codes and an explicit process/version list. Names are explanatory, not identities.
   No forced exit, eviction, cancellation or invented complete census.
   Count only actual running processes/connected clients/live writer registrations;
   installed inactive cache versions on disk never constitute a barrier. Source352
   plugin-runtime.ts:156 silently filters failed liveness inspection, so that helper
   alone cannot prove absence. storage-lock.ts:71 registers writers but its legacy
   record lacks exact process creation identity/capability; a live unknown holder
   blocks until proven compatible. Read registrations without retiring/deleting them.
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
replacement, after the normal-release witness or exact-exit/checkpoint reconciliation
above is verified, may acquire writable stores/leases/workers or run initializers,
bind, verify/recover checkpoints, advertise its
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
