# AB-276: local waiter notice contract

Status: **proposal for root, Claude main and GN-206 review; not implemented**.
Source baseline: published `7e80ac79bc20c804985f0463125e7832308222b0` (0.30.11).
This change is documentation only. The CLI, wire operations and files marked
"new" below do not exist in the baseline. Acceptance of the architecture in
principle is not toolkit integration, security review or runtime acceptance.

## Purpose and boundary

GN-206 needs to notify the recorded current owner of a toolkit waiter without
becoming a general Bridge peer. The broker must issue authority for one waiter,
run, owner generation, project, physical library and notice operation. Neither
the toolkit nor the notice CLI chooses a recipient or a sender identity.

V1 is **one local Windows PC only**, per the owner decision reported as
`5f142c3d`. No paired-PC forwarding, remote owner, broadcast, agent-kind target,
project-wide route, name fallback or full-peer registration is permitted.
An unknown or unregistered owner is unsupported. An existing opaque toolkit
waiter token alone cannot be upgraded into Bridge authority.

The GN-206 coordinator reports that toolkit 15
`scripts/tool_locks.py:1159-1189` records an opaque token, OS PID/start identity,
owned children, project path, physical library and Git identity. Optional
`jobIdentity` / `jobRunner` are inherited attribution strings. There is no
constructor field establishing a Bridge owner session or owner generation.
These toolkit references are supplied evidence, not a local source inspection.
Project/library and process ownership are useful scope constraints, not proof
of who may receive a Bridge notice. Names, cwd, environment strings, lease
tokens and toolkit-supplied sender fields never mint that proof.

Unsupported states must remain visibly blocked: missing launch linkage;
unknown process creation identity; missing stable session/job identity;
unverified current owner; stale generation; expired or revoked grant; cross-PC
route; linked or unsafe capability path; incompatible retained reader; old
broker; unresolved handoff/restart; ambiguous prior notice submission. None
allows a generic `send`, shared-token fallback or admission-success claim.

## Baseline evidence and missing pieces

All following paths refer to the source baseline, not running services.

| Evidence | Consequence for this proposal |
| --- | --- |
| `src/core/protocol.ts:61-108` distinguishes process registration, session ID, process start identity and job ownership fields. | A display name or process PID alone is not a durable owner principal. |
| `src/core/protocol.ts:137-143`; `src/core/broker.ts:1274-1318` authenticate `hello` with the shared token and accept peer metadata. | Existing registration is not a new restricted waiter authorization mechanism or proof of an arbitrary toolkit process. |
| `src/core/broker.ts:111,684` currently permits unauthenticated hello/auth/ping and gates other operations on a general authenticated connection. | Add a separate auth class and an operation allowlist. Setting ordinary `authed=true` is insufficient. |
| `src/core/resource-slots.ts:10-11,193-194`; `src/mcp/delegate-run.ts:415-417` pass slot/job/root attribution through the environment. | Useful association hints, never credentials or authenticated generations. |
| `src/core/process-identity.ts:13-30,41-68` can distinguish PID creation identities and unknown probe failures. | Reuse the representation; this does not attest a named-pipe client PID, Windows SID or private launch handoff. Those are new work. |
| `src/core/broker.ts:726-727,1319,1508-1515` fences replay using connection mail generation and session/registration identity. | Connection mail generation is not the proposed durable owner generation. Keep both fences. |
| `src/core/broker.ts:239-274`; `src/core/job-handoff.ts:31-87` commit job ownership in a journaled registry and replay other effects. | Handoff and capability authority need a recoverable fence; registry and notice DB are not already one transaction. |
| `src/core/protocol.ts:153-187`; `src/core/broker.ts:1600-1640` implement stable message IDs, storage recovery and sender/content checks. | Reuse durable ID semantics, not the ordinary name-based sender authorization or generic routing. |
| `src/cli/main.ts:27-33,96-110` creates a general Bridge node/token for ordinary CLI sends. | The restricted CLI must dispatch before home/logger/token/node initialization and must never auto-start a broker. |
| `src/core/store.ts:355-389,447-468,516-539` stores batches, acknowledgements and retained active/archive ID lookups. | A new ledger must commit with its message, preserve archive recovery and distinguish storage from consumption. |
| `src/core/metadata-db.ts:67-111`; `src/core/store.ts:203-206` retain old readers and defer upgrades. | Do not evict readers, mutate protected formats or force migration to enable notices. |
| `src/mcp/codex-wake.ts:53-65,87-130` guards idle wake and says queue acceptance leaves consumption unconfirmed. | Keep normal activity, hop and wake preferences; never synthesize idle or acknowledge on queue acceptance. |

Existing tests are useful patterns, not AB-276 proof: `test/send-state.test.ts`
tests lost replies, restarts, archival and changed-content retries;
`test/message-notify.test.ts` tests retained subscriptions and lost wake
delivery; `test/codex-wake.test.ts` and `test/hook-activity.test.ts` test activity
and retained mail; `test/handoff-subagents.test.ts` tests ownership replay and
reader refusal; `test/store-compatibility.test.ts` and
`test/metadata-db.test.ts` test retention and upgrade refusal. No tests are run
as part of this design package.

## Authority and minimum launch/registration handshake

The trusted issuer is the local broker handling an authenticated registered
session/job connection. The notice endpoint never accepts an asserted owner,
session, generation, sender, recipient or physical-PC identity as authority.
The ordinary Bridge token stays in Bridge; it is not exported to toolkit,
toolkit children, capability files or notice CLI.

1. The owner requests preparation on its existing authenticated Bridge
   connection. The broker resolves the caller's exact stable session or job
   principal, verifies current authority from its own registration/job ledger,
   and derives the exact local recipient. A caller cannot request another
   session by name. A job's parent/root strings alone do not authorize issuance.
2. A proposed Bridge-owned launch adapter creates a durable launch receipt for
   the specific toolkit process: requesting registration, owner principal and
   generation, broker-issued run nonce, waiter ID, verified project/physical
   library identities, same-user Windows SID, child PID and creation identity.
   Owner-approved project/library inputs are normalized and verified locally;
   raw toolkit strings cannot substitute for the verified scope. The exact
   executable/arguments and the authorized child must be recorded before the
   bootstrap is released. This is not a general process-launch capability.
3. The launcher supplies only the exact child with a private, bounded bootstrap
   handle/path. No broad handle inheritance, shared environment credential,
   raw credential in argv, or reusable credential accessible to every job
   descendant. An already-running toolkit lacking this receipt is unsupported
   in v1; adoption requires a separately reviewed launch integration.
4. The child connects to a restricted local named pipe. A new Windows adapter
   must attest the connecting PID, creation identity and same-user SID, match
   the recorded exact launch, and complete a single-use bootstrap challenge.
   The challenge cannot register a different process or select an owner. If
   the OS attestation or linkage cannot be established, issuance fails closed.
   Existing Node socket metadata and inherited attribution are not assumed to
   provide this adapter. Implementation feasibility needs review before code.
5. Immediately before grant activation, the broker rechecks current caller,
   launch, owner generation and scope. It persists a prepared grant and writes
   the private capability file atomically. The toolkit persists the public
   waiter binding atomically, then confirms registration with its public
   binding digest. Only a successfully confirmed binding becomes active.
   A lost response is recovered by the same registration request ID, not by
   creating another owner route. Prepared/crash-interrupted grants cannot send.
   A prepared credential authenticates only the original attested process for
   registration confirmation; emit/status rights start after activation.

The principal receiving notices must be agreed with GN-206: a waiting session
or a waiting job. The default proposal is **the authenticated requesting
principal itself**, never automatically its project main or supervisor. For a
job, its exact job ID, recorded session/route and current ownership revision
are all checked. A project main does not implicitly get every job's notices.
If GN-206 actually waits on a different principal, a separately reviewed
broker-authorized registration contract is required; toolkit text cannot make
that choice. This integration decision remains open.

## Persisted records and secret handling

| Record | Required fields and owner |
| --- | --- |
| Broker owner authority | Local installation ID; principal type/ID; exact session/job identity; durable owner generation; current authority revision; verified launch identity; state and invalidation reason. Broker-owned, never inferred from names. |
| Broker grant | Public capability ID; secret digest only; registration request ID; waiter/run; project and physical-library scope; exact owner principal/generation; permitted operation `waiter.notice`; issued/expiry times; activation/revocation state; launch identity and public binding digest. |
| Toolkit waiter binding | Schema version; opaque toolkit waiter ID; broker run nonce; capability ID; expiry; owner generation; non-secret installation/principal descriptor; verified project/library scope; registration request ID and confirmation state. Persist atomically with the waiter record. Persist a private capability-file locator separately; no bearer in lease JSON. |
| Toolkit notice outbox | Durable notice UUID; immutable canonical payload and digest; capability ID/generation/run; prepared/submitted/unknown/stored/read state; last non-secret error and receipt. Save before first send. No bearer or arbitrary recipient/sender. |
| Broker notice ledger/pin | Notice UUID; capability/run/generation; payload digest; derived message ID; exact pinned owner principal; storage and acknowledgement state; timestamps and non-secret rejection/retirement audit. Retain across restart, archival and grant expiry. |
| Private capability file | Format/version, public grant descriptor and at least 256 random bits of bearer secret. This is the only persistent raw-secret copy, not an ordinary Bridge message or retained audit object. |

The broker creates the capability in a same-user private directory with an
explicit Windows DACL restricting access to the intended account and necessary
system authority. POSIX `mode: 0o600` is not a Windows DACL check; the existing
shared token implementation is not a sufficient template. Verify a regular
file, every path component, no symlink/junction/reparse link, no hard-link
aliases, and no shared/tracked workspace placement. Use OS file handles to
verify file identity and ACL on open, preventing a path swap after inspection.
Unknown filesystem/ACL state is unsupported. Create a private nonlinked temp
file, flush contents, publish atomically without overwriting an unrelated file,
and verify the final identity/ACL. Retry/recovery must not leave an active grant
with an empty or partially written secret file.

The secret exists transiently only while minting, reading and authenticating
over the private local transport. It is never printed or placed in logs,
receipts, dashboard, ordinary message archives, build artifacts, shared lease
JSON, argv, shared environment or exception dumps. Issuance returns a public
descriptor and controlled private file/handle reference, not a secret in a
normal MCP tool response. Public audit exposes capability ID, expiry and
generation, not bearer, digest, file locator or payload contents. Launch
inheritance is explicitly limited to the intended owned process; a notice CLI
child must be separately recorded/attested, not permitted merely because it
claims descent. No blanket same-user process or all-descendant allowance.

Same-user ACLs do not isolate a malicious process already controlling that
Windows account or a fully authorized Bridge session. V1 protects accidental
leakage, arbitrary-target misuse, stale/foreign process claims and unsupported
routes within that trust boundary; it does not promise isolation from local
administrator compromise or a hostile account owner.

## Proposed CLI and wire surface

Illustrative interfaces; no commands below were executed or shipped.

Registered owner API, available only on a general authenticated owner
connection:

```text
prepare_waiter_notice(registration_id, waiter_id, launch_spec, project_scope,
                      physical_library_scope, requested_ttl)
revalidate_waiter_notice(capability_id, registration_id)
revoke_waiter_notice(capability_id, reason)
waiter_notice_status(notice_id)  # caller's own authorized records only
```

`registration_id` is a durable request UUID, not an owner claim. `launch_spec`
goes through the reviewed exact-owned-process adapter, not a spawn-anything
notice token. Generation, principal, recipient and expiry are broker outputs.
There is no general grant minting for arbitrary targets. The default TTL
proposal is one hour with an issuer-approved maximum of 24 hours; these
numbers need owner/toolkit review before implementation. Expiry is independent
of toolkit admission leases. No automatic extension by heartbeat or retry.

Restricted toolkit CLI, using a private file locator rather than a bearer:

```text
agent-bridge waiter-notice register --capability-file <private-path> --binding-file <private-binding>
agent-bridge waiter-notice emit --capability-file <private-path> --request-file <durable-outbox-entry>
agent-bridge waiter-notice status --capability-file <private-path> --notice-id <uuid>
```

The capability-file path is a locator, not authority without its verified
file/launch binding. It must reach only the recorded process/CLI child. No
`--to`, `--from`, session override, network endpoint override, shared token,
`--broadcast`, arbitrary operation, arbitrary command or grant export option.
The CLI must connect only, dispatch before generic home/config/logger/token
initialization, and never create a broker, general peer, user configuration,
shared token or upgrade. Unsupported brokers produce an explicit refusal.

Proposed restricted wire operations are `waiterAuth`, `waiterRegister`,
`waiterNoticeEmit` and `waiterNoticeStatus`. A connection is either unauthenticated,
general-peer authenticated or waiter authenticated; waiter auth cannot promote
it to general auth. It can access only its exact grant/run/notices. Deny hello,
ordinary auth/send/ack/peers/history/job control/transfer/network/approval and
all unknown operations after waiter authentication. Reject unknown request
fields, mismatched scope, malformed UUIDs and sender/target injection.

The toolkit request contains `noticeId`, public capability ID, run nonce,
owner generation and a versioned structured event: bounded event kind,
non-secret summary, toolkit recovery receipt reference and relevant scope
digest. Suggested limits for review: 16 KiB UTF-8 request, one event per call,
bounded per-grant rate and five-second total CLI deadline including connection.
No broad log dump or shell interpolation. Emission is scheduled **outside
toolkit admission/lease locks** and cannot alter admission, release a lock,
repair a library or block other waiters. Notification failure changes only
notice state, not the truth of the toolkit operation/recovery result.

JSON result fields are `noticeId`, `capabilityId`, `ownerGeneration`,
`storageState` (`stored`, `not_stored`, `unknown`), `deliveryState`,
`checkedAt`, `receipt` (`readAt` or null), `recovered` and `reason`. No message
body, peer inventory or bearer is returned by status. Public reason codes
include `route_missing`, `launch_unverified`, `scope_mismatch`,
`generation_stale`, `capability_expired`, `capability_revoked`,
`authority_suspended`, `reader_incompatible`, `broker_unavailable`,
`unsupported_remote`, `id_conflict` and `submission_unknown`; errors never echo
credentials or raw request files. Proposed CLI exits: 0 for a confirmed emit
storage result or successful authoritative status query, 2 for malformed
input, 3 for unknown submission/transport result, 4 for blocked authority, 5
for an immutable-ID conflict and 6 for incompatible broker/reader. Exit 0 is
never a read or admission-success claim; consumers must inspect JSON states.

## Durable idempotency and delivery transaction

1. GN-206 creates a UUID once for each logical event, atomically persists the
   canonical event and fingerprint in its outbox, and flushes it before its
   first submission. Process restart recovers that UUID. A CLI timeout never
   generates a new UUID, changes its owner generation or edits its payload.
2. The broker validates the active grant, exact attested caller, expiry, current
   owner generation and project/library/run scope. It does not trust a claimed
   sender. It renders a broker-authored sender such as `waiter:<capability-id>`
   with agent `other`, visibly identified as a toolkit notice, not the owner.
   Replies do not confer general sender/routing rights on the toolkit.
3. Under one synchronous store transaction, revalidate the current authority
   fence and insert the unique notice ledger, exact owner delivery pin and one
   ordinary Bridge message. Use the notice UUID as its stable message ID.
   Commit before wake scheduling or replying. A separate metadata connection
   and message insert are **not** an atomic transaction; expose a store-owned
   operation using the same SQLite handle. No half-committed ledger/message.
4. Uniqueness is local installation + notice UUID, not process name, ephemeral
   peer ID or an in-memory dedupe map. Same UUID with the same immutable
   grant/run/generation/payload returns the retained result without another
   message, observer copy or wake. Any different binding/content is a conflict.
   Concurrent duplicates converge on the committed record.
5. A crash before commit leaves no stored notice. A crash after commit but
   before response is resolved by status/retry with the same UUID. A crash
   before wake leaves durable pending delivery, reconciled once by normal
   receiver replay; no repeated wakes are scheduled merely by CLI retries.
   Runtime wake admission remains per receiver/activity epoch, not a claim of
   exactly-once OS queue execution across an unknowable host crash.
6. Archives retain the original message and receipt history, while the small
   notice ledger/pin remains authoritative. Archived, quarantined or withheld
   rows cannot be mistaken for `not_stored` and regenerated. Capability expiry
   does not expire the dedupe evidence. A lost local outbox/ledger is an
   unsupported recovery state requiring reviewed evidence, not a new send.

`emit`/`status` return public IDs, owner generation, storage state, observation
time and scoped receipt state. A deadline or disconnected reply gives
`unknown`, not `not_stored`. A truthful `not_stored` requires an authoritative
broker observation. Do not silently retry against another owner or broker.
Once an expired/revoked capability can no longer authenticate, the recorded
owner can inspect its own notice through the general owner status API; the
toolkit stays blocked until explicit revalidation/reissuance is approved.

## Busy/idle semantics and receipts

The exact current owner may be busy, idle, offline or unknown. Once authorized,
the notice can be durably stored for that principal without interrupting its
active turn. An idle receiver may admit a wake using existing preferences,
host availability and hop/depth/ownership guards. Busy or unknown remains
queued; missing transport remains stored/unread with an explicit reason.
No elapsed-time idle heuristic, activity overwrite, direct native injection,
session start, permission change or wake-policy bypass is part of this feature.

Report distinct facts:

| State | Meaning |
| --- | --- |
| `blocked` | Missing/invalid route or authority; no new message submitted. Preserve the event and non-secret actionable reason. |
| `unknown` | Submission/response incomplete; storage must be recovered using the same notice UUID. |
| `stored` / `queued` | Exactly one durable message for the pinned principal exists; the owner has not acknowledged it. |
| `wake_requested` / `wake_accepted` | A receiver transport was requested/accepted; neither means read, model action or successful toolkit admission. |
| `read` | Existing receiver acknowledgement is durably recorded for the pinned message/principal. It proves Bridge consumption only. |
| `withheld` / `retired` | The stored event is retained but no longer deliverable under the old owner authority; no silent forwarding. |

The capability cannot acknowledge, drain, read other inboxes, inspect broad
history, or claim an application-level outcome. A separate owner reply may
describe action, but a read receipt never proves admission/recovery success.
Expose current blocked/queued/read evidence in the toolkit's non-secret status
without pretending an outbound owner route exists before it is registered.

## Expiry, revocation, restart and handoff

Owner generation is a broker-owned **durable authority epoch**, distinct from
connection mail generation, hook epochs, PID values and toolkit tokens. New
owner, changed stable session/job identity, job ownership revision, run
replacement or explicit revoke invalidates the binding. Preserve a reasoned
non-secret retirement record. Main/job completion invalidates new emissions.
Unknown authority fails closed instead of treating the last name as current.

Expiry stops new authenticated emissions; it does not retract an already
committed notice while its pinned owner/generation remains current. Explicit
revocation or authority change withholds unread delivery as well as stopping
new emits. Retain both the accepted event and the invalidation evidence.
Clock rollback or an untrustworthy restored clock suspends grants instead of
extending their lifetime; revalidation needs a trustworthy expiry observation.

On broker restart, grants are suspended until an authenticated owner and
attested launch revalidate the same stable principal, generation, revision and
scope. A replaced MCP transport may reconnect to the same verified owner;
neither a reused name nor a new session ID may silently restore the grant.
Revalidation cannot extend expiry, change target or resurrect a revoked grant.
Expired renewal requires a new explicit issuance/registration; it must not
automatically resubmit old-generation events to a new principal.

Handoff must invalidate before a new owner can receive under that run. Because
job registry writes and notice storage are separate, propose a durable
capability-authority fence before the existing handoff commit. Suspend affected
grants and delivery pins, commit the existing journaled transfer, then record
the new generation/revocations. A crash with an unresolved fence blocks
issuance/emission/replay until authoritative journal reconciliation. If transfer
fails, only verified unchanged authority can reopen the old fence. Every owner
mutation path, including failover/restoration and session replacement, must
participate; otherwise that path is unsupported for active waiter grants.

Do not use generic job reroute, project master fallback, alias claim or inbox
name reuse to redirect notices. Recheck the durable pin at storage, replay,
wake admission and acknowledgement. An unread notice predating handoff remains
retained/withheld for reviewed recovery; it is not delivered to the successor
or an unrelated process taking the old name. If already handed to the old
owner before invalidation, retain that fact/receipt; no protocol can retract
context already delivered. The successor must explicitly register a new
capability before future events. Resending a withheld event requires an
explicit reviewed new event/reference, not rebinding its existing UUID.

Expired/revoked **secret-file removal is not automatically authorized**. Default
proposal: invalidate immediately but preserve private files in place pending
an owner-approved retention/disposal policy. Public non-secret retirement and
dedupe audit is permanent in v1. Future disposal must verify exact broker-owned
file identity, ACL, nonlinked path and grant state, never recurse, never follow
links, never delete a foreign file, and never archive bearer bytes into normal
history/backups/artifacts. Review existing backup collectors so private bearer
files cannot enter a general archive. No cleanup occurs in this design task.

## Store and retained-reader compatibility

Propose a separately versioned `waiter_notice` component in the existing
`bridge.db`, using additive owner/grant/launch/fence/notice/pin tables. Preserve
the existing message envelope, archive bytes and old metadata domains. The
table names and component version must be finalized with storage review;
no live DDL or migration is authorized here.

An additive table alone is insufficient: older brokers/readers do not honor
owner delivery pins. Advertise a specific waiter-notice/pin reader capability
and refuse activation until all live readers able to host, claim, replay or
acknowledge this store understand it. Keep ordinary messaging available on its
existing compatible schema. Old/incompatible readers finish naturally; never
stop them, expire them by age, rewrite their presence or bypass deferred
admission. Unknown identity/version remains a blocker. A downgrade encountering
an active component must refuse hosting it rather than expose pinned notices
as ordinary name mail. Propose a minimum global reader floor alongside the
additive component (candidate SQLite version 10 against this version-9
baseline; allocate the actual number during implementation review). Baseline
`src/core/sqlite-migrations.ts:69-72` rejects a version above its supported
target; `src/core/store.ts:201-208` only catches deferred upgrade errors.
Exercise retained older-host fixtures to prove refusal, including restart,
rather than assuming a component marker protects pins. Merely leaving
`user_version` unchanged does not supply a downgrade fence. Reader admission
must succeed before raising the floor; while deferred, no waiter pins/messages
are activated and ordinary compatible messaging continues.

Before additive DDL, use existing admission, physical-path, lease and verified
snapshot practices. Extend snapshots/restore coverage to the complete new
component and its message references, without raw capabilities. Snapshot
failures preserve originals. The ledger transaction must use the message
store connection, not `saveMetadataValue` on a separate handle. A component
newer than its reader is retained unchanged. Retain archive conflicts and
dedupe evidence; never repair or delete conflicts to make notice retries pass.

## Proposed implementation ownership (after approval only)

| File | Narrow responsibility |
| --- | --- |
| `src/core/waiter-notice.ts` (new) | Grant/owner/scope state machine, validation, public result/error types, expiry and revalidation policy. No generic routing or activity guessing. |
| `src/core/waiter-notice-store.ts` (new), `src/core/store.ts` | Additive component/ledger/pin persistence; a same-handle atomic notice/message operation and pin checks on delivery/ack/retained ID recovery. |
| `src/core/waiter-notice-windows.ts` (new) | Restricted pipe ACL/client PID/SID attestation, exact launch identity, private nonlinked capability file and bounded bootstrap/child handle transfer. Review feasibility and dependencies first. |
| `src/core/waiter-notice-launch.ts` (new) | Exact broker-owned toolkit launch receipt/registration linkage and explicit child allowlist. No native subagent or unrestricted peer-token inheritance. |
| `src/core/protocol.ts`, `src/core/broker.ts` | Disjoint auth classes/allowlist; owner issuance and restricted notice RPCs; durable authority fencing; commit/replay integration. |
| `src/core/job-handoff.ts`, `src/core/node.ts` | Handoff/restart/session replacement authority invalidation and current registration/pin checks. Preserve existing job ownership and mail cancellation behavior. |
| `src/core/store-compatibility.ts`, `src/core/metadata-db.ts`, `src/core/metadata-snapshot.ts` | Explicit reader/component admission, snapshot coverage and downgrade refusal. No forced reader eviction. |
| `src/core/store-version.ts`, `src/core/sqlite-migrations.ts` | Reviewed minimum reader floor and additive migration/snapshot coverage, retaining the old compatible store when admission is deferred. |
| `src/cli/waiter-notice.ts` (new), `src/cli/main.ts` | Strict connect-only bounded CLI; durable request consumption/status; early dispatch with no shared-token/config initialization. |
| `src/mcp/server.ts` | Owner-facing prepare/revalidate/revoke/status tools only on the authenticated caller's authority, returning no bearer. |
| `test/waiter-notice*.test.ts` (new), related existing tests | In-memory authority/transport tests and isolated private filesystem/store fixtures; Windows-native ACL/attestation acceptance separately. |
| GN-206 canonical toolkit files (owner-supplied exact inventory pending) | Persist binding and outbox; registration handshake; bounded notice invocation outside admission gates; truthful status and non-secret receipts. No consumer copies or broad lease-schema edits. |

These are proposed ownership boundaries, not permission to edit these files.
Toolkit integration must be coordinated with its canonical owner and exact
source inventory. No implementation proceeds before root/Claude review.

## Threats and meaningful verification

| Case | Required isolated proof |
| --- | --- |
| Forged name/cwd/env/jobIdentity/toolkit lease or owner fields | Issuance refused without authenticated current principal and attested launch; no general peer or message created. |
| Copied secret, PID reuse, another child, another SID/run/library/project | Exact launch and scope checks refuse auth/emission; a fake parent string or same-user PID is insufficient. |
| Recipient/sender injection or auth escalation | Enumerate every existing RPC plus unknown ops on a waiter connection: all except restricted allowlist denied; `to=*`, agent kinds, slash addresses and sender fields rejected. |
| Link/path/ACL race, hard-link alias, partial write | Isolated Windows fixtures prove regular nonlinked private file/handle identity, fail-closed DACL checks, atomic publication and no foreign overwrite. No real profile secrets or ACL mutation. |
| Crash across register phases | Kill fixture at prepare/file publication/toolkit binding/confirm points; retry same request ID yields one binding or blocked prepared state, never two grants or a partial active route. |
| Crash before/after notice commit or lost reply | Real fixture store transaction plus stubbed transport; one UUID/message/ledger/pin survives restart; changed payload conflicts; concurrent retry creates no extra message/wake/observer copy. |
| Wake lost after storage | Replay retained mail through the real receiver/waker with stubbed queue; idle admits one current wake, busy blocks it, queue acceptance leaves unread mail, ack alone establishes read. No elapsed idle inference or process interruption. |
| Handoff/failover/session replacement during stalled send/replay | Fence before authority change, no old-generation commit/wake/ack mutation; old mail withheld, not consumed by successor/name reuse; recovery at each journal/fence crash point stays blocked until authority proven. |
| Broker restart and capability expiry | Revalidation required; exact same owner may resume without rebinding; new owner/unknown launch/expired grant refuses new emit. Status never fabricates `not_stored` after lost submission. |
| Archive/quarantine/retention and downgrade | Stored notice remains deduplicated and receipts retained after archive; quarantine never triggers resend; incompatible readers defer activation unchanged; old host cannot bypass pins; snapshot/restore retains complete ledger. |
| Secret leakage | Synthetic marked bearer never appears in stdout/stderr, exception text, log/dashboard/message/receipt/snapshot/export artifacts, argv or shared env; only verified private file contains it. |
| Toolkit admission independence | Bounded sends happen after gates are released; unavailable broker leaves toolkit result and leases truthful, with durable blocked/unknown notice and actionable non-secret reason. |

Use synthetic capabilities and isolated stores/temp directories only. No live
home DB/config/log/history, real secrets, foreign process inspection or toolkit
library repair. Unit tests cannot establish Windows pipe/DACL/process-launch
acceptance: require a separately authorized Windows fixture test, then explicit
GN-206 integration and owner acceptance. Existing test passes are not proof of
these new guarantees.

## Approval questions and integration dependencies

1. Which exact registered session/job is GN-206's waiting owner, and how does
   its launch flow request authority on that principal's existing connection?
   No toolkit field currently proves this. Confirm canonical files/schema and
   the smallest launch adapter; existing opaque waiters remain unsupported.
2. Review the proposed Windows attestation/private-file adapter and exact
   child transfer. Decide whether its dependencies and launch changes are
   acceptable; no weak env-only alternative is proposed.
3. Approve issuance TTL/rate/payload/deadline policy and expiry/renewal behavior
   for long waits, plus explicit secret-file retention/disposal and backup
   exclusion policy. No automatic cleanup authorization follows from expiry.
4. Review durable owner-generation/fencing coverage across every ownership
   path and the pinned-delivery/downgrade storage boundary. These are necessary
   security changes, not a general lineage/routing redesign.
5. GN-206 owner must accept the persisted public binding, durable event UUID,
   crash recovery, out-of-gate bounded sends and truthful blocked/queued/read
   status before a toolkit patch. Remote/cross-PC scope remains refused in v1;
   any future extension requires a new contract and owner decision.

Approval order: root/Claude design review, GN-206 exact integration acceptance,
scoped implementation authorization, isolated security/durability tests,
separately authorized Windows fixture acceptance, then runtime owner review.
This proposal authorizes none of those later actions by itself.
