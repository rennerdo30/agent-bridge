# AB-276: local waiter notice contract

Status: **proposal for root, Claude main and GN-206 review; not implemented**.
Source baseline: published `7e80ac79bc20c804985f0463125e7832308222b0` (0.30.11).
This change is documentation only. The CLI, wire operations and files marked
"new" below do not exist in the baseline. Acceptance of the architecture in
principle is not toolkit integration, security review or runtime acceptance.

Revision: Claude decision `03856544` rejects an ordinary SQLite reader-floor
bump. Capabilities, notices, delivery claims and acknowledgements belong only
to an isolated feature-home DB. No pinned notice body enters legacy ordinary
mail rows. GN-206 reviews `5abf0dce` / `f91fa818` inform the proposed handshake;
they do not authorize a toolkit patch or approve TTL/secret retention policy.

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
| `src/core/store.ts:355-389,447-468,516-539` stores batches, acknowledgements and retained active/archive ID lookups. | Atomic-write/retained-ID patterns only; waiter body/ledger/receipts live together in the new feature store, not ordinary rows. |
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

## GN-206 canonical inventory and lifecycle boundary

Read-only supplemental inventory:
`D:/AgentData/worktrees/renner-unity-tools-gn204-20261011/evidence/gn204/gn206-launch-inventory.md`,
source `f894de47fcfcd2bc943a800d9e8d3463747ce614`. The inventory was read;
underlying toolkit source/lifecycle was not executed or independently probed.
Canonical source references below are from that supplied inventory.

| Toolkit source | Existing responsibility; proposed notice boundary |
| --- | --- |
| `scripts/tool_locks.py:1143-1190,1217-1226` | Local token, PID/start, children, paths and attribution; preserve schemaVersion 1 / minReaderVersion 0.10.7. No automatic edit to shared lease schema; keep new public binding/outbox in a separately versioned private sidecar pending toolkit review. |
| `scripts/tool_scheduler.py:249-266` | Existing lease reader refusal remains unchanged; notice support cannot bypass it or raise its floor. |
| `scripts/tool_locks.py:1456-1476,1550-1570,1714-1743` | Wait ticket creation, admission and prelaunch requeue retain the token/sequence/deadline. Requeue must retain broker waiter/run binding and notice UUIDs without reminting authority. Rotating withdrawal proof does not rotate a Bridge generation. |
| `scripts/tool_locks.py:434-527,1159-1190` | Withdrawal proof, same-joblabel/worktree and ancestry are local lifecycle authority only. Withdrawal must retire the notice route before any later wake/delivery. Restart creates new token/PID-start and requires new attested registration; same job label cannot inherit the old grant. |
| `scripts/tool_process.py:415-456`; `scripts/tool_locks.py:1688-1706` | Suspended exact child PID/start is recorded, then assigned to the owned job before resume: possible future staged integration point, not shipped Bridge attestation. Never keep this admission gate across broker RPC, ACL or store work. |
| `scripts/tool_process.py:270-283,531-562` | Direct Editor binding needs the verified executable and exactly one -projectPath; an opaque wrapper has no Editor-child/project binding. Whole-tree completion is process-local; neither wrapper ownership nor completion proves a Bridge generation. |
| `scripts/tool_environment.py:14-16`; `scripts/tool_process.py:231-255` | Existing inherited/scoped toolkit lease credentials are not notice authority. Do not add a notice bearer to inherited/shared env or silently change wrapper argv/config. |
| `scripts/tool_runner.py:119-120`; `scripts/tool_fs.py:128-129`; `scripts/tool_locks.py:1143-1157` | Artifact run_id is unrelated to admission; no canonical native run ID exists. Broker must mint its own run binding. Normalize E:/D: aliases to the same physical Library, never two authority scopes. |

Existing unregistered waiters remain unsupported with truthful local blocked
status. Missing authenticated Bridge fields in the synthetic inventory are
absence examples, not shipped constructor fields. Canonical integration
boundaries are now known; final toolkit sidecar/launch API acceptance remains
pending.

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
   Require capable-broker and `waiterNoticeV1` owner delivery negotiation before
   preparation; older hosts continue ordinary messaging but cannot own a route.
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

GN-206 accepts **the authenticated requesting session/job itself** as the
issuer/recipient direction, never automatically its project main or supervisor. For a
job, its exact job ID, recorded session/route and current ownership revision
are all checked. A project main does not implicitly get every job's notices.
Exact toolkit launch plumbing into that principal still needs review. A
different target is not part of v1; toolkit text cannot make that choice.

### Staged suspended-child handshake (proposal, not a launch)

Preparation/RPC/ACL/store work happens outside toolkit admission gates. Before
entry, the authenticated owner prepares a non-active launch/binding request.
Inside the existing short local gate, record only the exact suspended child
PID/start, owned-job assignment and a local reservation revision; then release
the gate while retaining the reservation. Outside the gate, the broker-owned
adapter attests that exact child, completes its private bootstrap, and confirms
the bound route with a bounded deadline. Re-enter the local gate briefly to
verify the same reservation/token/run/child is still current and not withdrawn
before resume; no broker call runs while this gate is held. Bootstrap precedes
resume, but no gate spans network/pipe RPC, DACL probes or SQLite locking.

This requires a reviewed toolkit launch change; existing tool_process.py does
not supply the split automatically. Each notice CLI child must use its own
recorded/attested launch and bounded private handoff; possessing the parent's
capability is insufficient. Timeout or concurrent withdrawal leaves a truthful
blocked route, invalidates prepared authority, and uses only the toolkit's
reviewed owned-child failure path. The bounded cancellation/reservation policy
must be agreed before code: no orphaned indefinite suspended child, foreign
process stop, automatic native launch or argv/config change is authorized.

## Persisted records and secret handling

| Record | Required fields and owner |
| --- | --- |
| Broker owner authority | Local installation ID; principal type/ID; exact session/job identity; durable owner generation; current authority revision; verified launch identity; state and invalidation reason. Broker-owned, never inferred from names. |
| Broker grant | Public capability ID; secret digest only; registration request ID; waiter/run; project and physical-library scope; exact owner principal/generation; permitted operation `waiter.notice`; issued/expiry times; activation/revocation state; launch identity and public binding digest. |
| Toolkit waiter binding | Independently versioned private sidecar; opaque toolkit waiter ID; stable broker binding ID/run nonce; capability ID; expiry and absolute expiry; owner generation; non-secret installation/principal descriptor; verified project/library scope; registration request ID and confirmation state. Persist atomically and cross-check against the unchanged lease token/PID-start; no automatic shared lease schema change. Persist a private capability-file locator separately; no bearer in lease JSON. |
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
renew_waiter_notice(capability_id, renewal_request_id, requested_expiry)
revoke_waiter_notice(capability_id, reason)
waiter_notice_status(notice_id)  # caller's own authorized records only
```

`registration_id` is a durable request UUID, not an owner claim. `launch_spec`
goes through the reviewed exact-owned-process adapter, not a spawn-anything
notice token. Generation, principal, recipient and expiry are broker outputs.
There is no general grant minting for arbitrary targets. One hour is not an
accepted policy: GN-206 observed a 37-minute wait followed by potentially long
build work. Propose explicit issuer-authorized renewal before expiry, only
after revalidating the SAME owner generation, waiter/run, attested process and
project/library/operation scope. Keep a stable binding ID and immutable notice
UUID/fingerprint across renewal; a rotated capability ID/secret is only a new
credential version for that binding, never a new recipient or dedupe domain.
Persist renewal by its own request UUID and return a recoverable public result.
No heartbeat, CLI retry or same-joblabel restart may extend expiry. Proposed
absolute ceiling is 24 hours from first issuance, also bounded by the reviewed
wait hard deadline; renewal/reissuance for the same run cannot reset it. Initial
TTL, ceiling/alignment, rates and secret retirement remain main-reviewed choices,
not approved policy. Expired/revoked or changed-run grants require new explicit
registration, not a silent renewal/rebind of old pending events.

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

Stable binding ID is part of the immutable event fingerprint. Transport
capability ID/version may change only through approved same-binding renewal;
it is not an edited event body or a new notice UUID/dedupe namespace.

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
   visibly identified as a toolkit notice, not the owner. This is a dedicated
   `WaiterNotice` envelope, not a synthetic ordinary-mail peer/message row.
   Replies do not confer general sender/routing rights on the toolkit.
3. In one transaction on the **isolated notice DB**, revalidate the current
   authority fence and persist the unique notice ID/fingerprint, body, exact
   owner pin and pending delivery state. The notice UUID is its message ID.
   Commit before wake scheduling or replying. Never insert the body or a
   pinned delivery into ordinary bridge.db/messages or legacy archives.
   There is no required transaction across the ordinary store and feature DB:
   all durable notice facts live together on one feature-store SQLite handle.
4. Uniqueness is local installation + notice UUID, not process name, ephemeral
   peer ID or an in-memory dedupe map. Same UUID with the same immutable
   binding/run/generation/payload returns the retained result without another
   notice, observer copy or wake. Different binding/content conflicts; explicit
   same-binding renewal does not change the fingerprint. Concurrent duplicates
   converge on the committed record.
5. A crash before commit leaves no stored notice. A crash after commit but
   before response is resolved by status/retry with the same UUID. A crash
   before wake leaves durable pending delivery, reconciled once by normal
   dedicated notice receiver replay; no wakes are scheduled merely by retries.
   Runtime wake admission remains per receiver/activity epoch, not a claim of
   exactly-once OS queue execution across an unknowable host crash.
6. Feature-store retention retains the notice body and receipt history in
   place for v1; no export into ordinary archives. Retired or withheld
   rows cannot be mistaken for `not_stored` and regenerated. Capability expiry
   does not expire the dedupe evidence. A lost local outbox/ledger is an
   unsupported recovery state requiring reviewed evidence, not a new send.

Dedicated receiver operations are `waiterNoticesSubscribe`,
`waiterNoticesClaim` and `waiterNoticesAck`, available only to a feature-aware
Bridge owner connection bound to its current registration/generation. They
are not on the toolkit allowlist. Claim records a stable delivery-attempt ID,
notice ID, generation and exact receiving registration in the feature DB
transaction before returning a body. An acknowledgement atomically verifies
that claim/current authority, inserts the unique scoped receipt and marks the
notice consumed **in that same feature DB**. Ordinary `ack`/`inbox` cannot
read or consume it. Revoked/withdrawn/stale claims cannot mutate successor
state; retain late outcomes as non-secret historical evidence, not new-owner
read receipts.

Rendering to the host/OS queue happens outside this transaction. A crash before
hand-off leaves the claim retryable only to the same revalidated owner; a
crash after rendering but before ack can replay the same stable ID. The
feature-aware receiver must preserve its own scoped dedupe/ack journal within
the isolated feature home, never an ordinary inbox row. Exactly-once durable
notice insertion/ack is achievable; exactly-once model context across a crash
with an unconfirmed hand-off is not promised. Lost acceptance is `unknown`,
not consumed. Handed-but-unacknowledged old-generation notices remain retained
and withheld after ownership change, not automatically rebound.

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
Only feature-aware receivers may subscribe/claim. Maintain a separate pending
notice collection in memory and use existing host activity/wake policies as
guards, with a dedicated notice provider/ack path. Do not call ordinary
BridgeNode.send or store.insert to make notices visible. Wake payloads are
rendered just in time after claim/authority checks, without persistent legacy
mail copies. An old host's ordinary inbox, history reader or alias claim sees
no notice body, even if it shares a display name with the recorded owner.
No elapsed-time idle heuristic, activity overwrite, direct native injection,
session start, permission change or wake-policy bypass is part of this feature.

Report distinct facts:

| State | Meaning |
| --- | --- |
| `blocked` | Missing/invalid route or authority; no new message submitted. Preserve the event and non-secret actionable reason. |
| `unknown` | Submission/response incomplete; storage must be recovered using the same notice UUID. |
| `stored` / `queued` | Exactly one durable message for the pinned principal exists; the owner has not acknowledged it. |
| `wake_requested` / `wake_accepted` | A receiver transport was requested/accepted; neither means read, model action or successful toolkit admission. |
| `read` | Dedicated receiver acknowledgement is durably recorded in the isolated DB for the claimed notice/principal/generation. It proves Bridge consumption only. |
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
Revalidation is distinct from the separately authorized same-binding renewal
above. Expired renewal requires new explicit issuance/registration and must
not automatically resubmit old-generation events to a new principal.

Toolkit prelaunch requeue retains the existing attested waiter/run binding;
it is not a reason to mint another grant. Withdrawal must fence/retire the
route before subsequent delivery/wake. New token/PID-start after toolkit
restart requires new exact launch attestation and registration, regardless of
unchanged joblabel/ancestry. Preserve old in-flight/late notices as withheld.

Proposed feature-aware withdrawal is staged too: record local withdrawal intent
under the short toolkit gate, release it, obtain durable route retirement from
the authenticated issuer/broker, then briefly re-enter the gate to complete
the same token/revision's existing local withdrawal. No shared joblabel/proof
becomes a Bridge revoke credential. Until retirement is acknowledged, report
`withdraw_pending`/blocked notice authority, not completed route retirement.
If the issuer or broker cannot establish the fence, do not claim the new
contract's withdrawal guarantee or silently fall back to legacy delivery.
Exact treatment of the underlying admission reservation during this bounded
failure needs toolkit/main review; this proposal does not change its existing
withdrawal semantics by itself. On restart an unresolved intent suspends the
route before replay. Already handed context cannot be retracted.

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

### Required isolated feature home

The proposed global reader-floor bump is **rejected**, not an implementation
option. Ordinary `bridge.db` stays schema/version 9 at this baseline; existing
message envelopes, retained archives, metadata domains and reader admission
rules remain unchanged. Toolkit shared lease schema1/minReader0.10.7 likewise
stays unchanged. No capability or notice table is added to either shared store.

Propose a dedicated private feature home, for example
`%LOCALAPPDATA%/AgentBridge/WaiterNotice/v1/<broker-installation-id>/`, resolved
only by the feature-aware broker (exact location needs main review). Its own
`notice.db`, WAL/SHM, recovery journal and private capability directory are
never supplied to an old broker as `--home` or an ordinary `resolveDbPath`.
Use an explicit feature-store file identity/version magic and separate pipe
namespace; no generic shared-home directory scan, attach or fallback. Old
hosts have no open path or delivery handler for this store. Normal backups
must exclude its bearer files; separately reviewed feature snapshots may
retain the complete non-secret DB/authority state.

Illustrative isolated schema (names/DDL still subject to implementation review):

| Table | Key facts kept together in notice.db |
| --- | --- |
| `feature_meta` | Store kind/version, local installation ID, supported notice protocol. Newer/unknown feature format refuses unchanged. |
| `owner_authority` | Principal key, generation, authoritative revision, registration/launch identity, active/suspended/retired state. |
| `launches` | Launch/request/run IDs, exact PID/start/SID, scope digest, bootstrap state; no bearer. |
| `grants` / `grant_renewals` | Public binding/capability IDs, secret digest, immutable owner/run/scope, expiry/absolute expiry, activation/revoke state, renewal request ID. |
| `authority_fences` | Durable pending/committed/reconciled handoff or withdrawal intent, affected generation and registry/local lifecycle revision. |
| `notices` | Unique notice UUID, binding/run/generation, body/fingerprint, exact owner pin, created/storage/retirement state. This is the only durable notice body store. |
| `delivery_claims` / `notice_receipts` | Notice/attempt IDs, exact receiver registration/generation, hand-off/ack state and durable read timestamp; one consumed receipt per scoped notice. |
| `retirement_audit` | Permanent non-secret grant/run/notice retirement reasons, epochs and late-outcome evidence. |

A single feature-DB transaction checks grant/fence/generation and inserts the
notice/pin/pending delivery; a second feature-DB transaction validates a claim
and commits receipt/consumption. WAL plus full durable sync is proposed for
this new store, not a change to the ordinary DB. Do not claim atomic commit
across attached WAL databases: this design intentionally requires no notice
body write in the ordinary DB. Recovery of feature DB, WAL and non-secret
authority journal is one retained feature boundary; losing any part suspends
delivery rather than sourcing bodies/receipts from legacy rows.

The ordinary registration/job registry is still an external authority source.
Its mutation is not made atomic with this DB by isolation. Keep the durable
pre-change fence/reconcile protocol described above and revalidate authority
before emit, claim, wake and ack. Only notice-aware authority paths may change
an active binding; an uninstrumented/unknown legacy job mutation path means
the binding is unsupported/suspended, not silently adopted. A fresh generation
cannot be installed while a fence is unresolved. An old broker taking over the
ordinary pipe cannot serve notices; suspend the feature route until the
authenticated owner reconnects to a capable broker and exact authority is
revalidated. No second general peer or token export bridges this boundary.

### v0.30.11 coexistence fixture (required, not run)

Use two isolated synthetic homes: an ordinary fixture at SQLite9 and a new
feature home with synthetic notices/capabilities; never use a real profile.
First, a capable broker owns registration/control with a feature-aware owner
and pinned v0.30.11 ordinary peers/readers coexisting; exercise normal sends,
alias claims, inbox/ack and history/retention. Second, hand ordinary hosting to
an exact pinned v0.30.11 broker in the fixture: ordinary messaging continues
but notice operations/replay are unsupported/suspended. Never run two owners
of the same ordinary pipe. Record ordinary user_version/schema plus relevant
legacy rows before/after **feature-only** operations: no notice body/ID/pin or
secret is introduced. Verify old binary opens only ordinary fixture paths
with file-access instrumentation; new feature data stays unchanged by old
read/claim/ack/retention. A reused owner name must not make a notice visible.

An owner/host lacking `waiterNoticeV1` delivery negotiation is explicitly
unsupported for issue/subscribe/claim/ack, while unrelated v0.30.11 peers keep
ordinary messaging. A pre-AB-276 broker rejects/does not know the new feature
operations; the CLI reports unsupported/broker-unavailable and keeps its
outbox, never starts a broker, inserts ordinary mail or borrows shared auth.
After a capable broker restarts/ordinary ownership changes, old claims cannot
be acknowledged or replayed under a new principal. Fixtures must also crash
between feature commit/claim/host hand-off/ack and between fence/registry
commit/reconciliation, proving durable recovery and truthful unknown states.

### Tradeoffs and rejected alternatives

| Approach | Authority/durability tradeoff |
| --- | --- |
| Isolated capabilities **and notices**, dedicated claim/ack (required) | No legacy ordinary-reader bypass and single-DB notice/receipt atomicity without ordinary floor bump. Costs a new receiver provider, separate history/status/snapshot tooling, capability negotiation and recoverable cross-registry authority fences. Legacy owner hosts cannot receive these notices. |
| Isolated capabilities but ordinary pinned body/mail rows (rejected) | Old readers ignore pins, alias/name claims bypass authority; cross-store insertion is not one durable notice transaction. Isolation of grants alone does not solve delivery. |
| ATTACH feature + ordinary WAL DB (rejected) | Does not provide a joint atomic transaction across WAL DBs and still exposes ordinary rows to legacy readers; see the [SQLite WAL transaction boundary](https://sqlite.org/wal.html). |
| Shared-table pins plus global reader-floor bump (rejected by main) | Could fence upgraded readers but blocks old hosting; violates approved coexistence boundary. Do not retain as a fallback. |
| In-memory-only notice queue or full-peer CLI shortcut (rejected) | Loses crash/idempotency evidence or grants arbitrary routing/shared-token authority. |

Retain feature data and verify physical paths/private ACLs before first use.
Feature schema upgrades have their own compatible-reader/snapshot gate; never
rewrite protected old formats or stop/age-evict readers. V1 keeps notice bodies,
dedupe and receipts in place: a later feature archive/export/disposal contract
requires review. Ordinary archive conflicts remain untouched, and feature
retention cannot turn a withheld notice into a new send.

## Proposed implementation ownership (after approval only)

| File | Narrow responsibility |
| --- | --- |
| `src/core/waiter-notice.ts` (new) | Grant/owner/scope state machine, validation, public result/error types, expiry and revalidation policy. No generic routing or activity guessing. |
| `src/core/waiter-notice-store.ts` (new) | Isolated feature-home schema, same-handle atomic grant/notice/pin/claim/receipt persistence and retained recovery. No ordinary MessageStore notice-body writes. |
| `src/core/waiter-notice-delivery.ts` (new), `src/core/node.ts`, host hook/wake adapters | Separate pending notice provider, feature-aware subscription/claim/render/ack, host activity/current-registration guards. No legacy inbox/history copies or generic send fallback. |
| `src/core/waiter-notice-windows.ts` (new) | Restricted pipe ACL/client PID/SID attestation, exact launch identity, private nonlinked capability file and bounded bootstrap/child handle transfer. Review feasibility and dependencies first. |
| `src/core/waiter-notice-launch.ts` (new) | Exact broker-owned toolkit launch receipt/registration linkage and explicit child allowlist. No native subagent or unrestricted peer-token inheritance. |
| `src/core/protocol.ts`, `src/core/broker.ts` | Disjoint auth classes/allowlist; owner issuance and restricted notice RPCs; durable authority fencing; commit/replay integration. |
| `src/core/job-handoff.ts`, `src/core/node.ts` | Handoff/restart/session replacement authority invalidation and current registration/pin checks. Preserve existing job ownership and mail cancellation behavior. |
| `src/core/waiter-notice-snapshot.ts` (new), feature store | Complete isolated authority/notice/receipt recovery boundary and feature-specific reader gate; no bearer snapshots. Ordinary store-version/migrations/metadata schemas are outside this package. |
| `src/cli/waiter-notice.ts` (new), `src/cli/main.ts` | Strict connect-only bounded CLI; durable request consumption/status; early dispatch with no shared-token/config initialization. |
| `src/mcp/server.ts` | Owner-facing prepare/revalidate/revoke/status tools only on the authenticated caller's authority, returning no bearer. |
| `test/waiter-notice*.test.ts` (new), related existing tests | In-memory authority/transport tests and isolated private filesystem/store fixtures; Windows-native ACL/attestation acceptance separately. |
| GN-206 `scripts/tool_locks.py`, `scripts/tool_process.py`, proposed notice sidecar/CLI adapter (owner to approve exact new file) | Preserve recorded admission/requeue/withdrawal and suspended-child boundaries above; staged registration/outbox/renewal and bounded out-of-gate notice operations. No automatic lease-schema edit, consumer-copy patch or silent argv/config/env credential change. |

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
| Isolated-store coexistence/retention/downgrade | Pin exact v0.30.11 fixture and verify no feature DB opens, no notice bodies/IDs/pins/secrets in ordinary rows/archives and unchanged SQLite9 schema; old host refuses feature operations without fallback; feature snapshots retain complete notice/receipt/fence ledger. |
| Secret leakage | Synthetic marked bearer never appears in stdout/stderr, exception text, log/dashboard/message/receipt/snapshot/export artifacts, argv or shared env; only verified private file contains it. |
| Toolkit admission independence | Bounded sends happen after gates are released; unavailable broker leaves toolkit result and leases truthful, with durable blocked/unknown notice and actionable non-secret reason. |
| Requeue/withdrawal/restart | Requeue preserves run/binding/UUID; withdrawal's durable fence precedes later claim/wake; new token/PID-start cannot inherit authority through joblabel or proof; late old notices retained/withheld, never rebound. |
| Suspended bootstrap and deadlock | Stub broker/ACL/store stalls at each staged handshake point; assert no admission gate is held during RPC and unrelated waiters can progress; bounded failure has an explicit reservation/owned-child outcome and no unreviewed resume/kill. |
| Renewal | Authenticated issuer renewal preserves SAME generation/scope/run/notice fingerprint, rotates only credential version and is idempotent by renewal UUID; heartbeat cannot extend; absolute first-issue ceiling cannot reset; changed process/run requires new attestation. |

Use synthetic capabilities and isolated stores/temp directories only. No live
home DB/config/log/history, real secrets, foreign process inspection or toolkit
library repair. Unit tests cannot establish Windows pipe/DACL/process-launch
acceptance: require a separately authorized Windows fixture test, then explicit
GN-206 integration and owner acceptance. Existing test passes are not proof of
these new guarantees.

## Approval questions and integration dependencies

1. GN-206 accepts the requesting authenticated session/job itself, without main
   forwarding. Approve its exact launch connection and new private sidecar API
   using the canonical inventory above; no current toolkit field proves Bridge
   ownership and existing opaque waiters remain unsupported.
2. Review the proposed Windows attestation/private-file adapter and exact
   child transfer. Decide whether its dependencies and launch changes are
   acceptable; no weak env-only alternative is proposed.
3. Approve issuance TTL/rate/payload/deadline policy and expiry/renewal behavior
   for long waits, plus explicit secret-file retention/disposal and backup
   exclusion policy. No automatic cleanup authorization follows from expiry.
4. Review isolated feature schema/receiver claim+ack transactions, v0.30.11
   coexistence fixture and durable owner/withdrawal fencing across all supported
   lifecycle paths. Ordinary reader-floor bump and pinned legacy body rows are
   rejected; no general lineage/routing redesign is proposed.
5. GN-206 owner must accept the persisted public binding, durable event UUID,
   crash recovery, out-of-gate bounded sends and truthful blocked/queued/read
   status before a toolkit patch. Remote/cross-PC scope remains refused in v1;
   any future extension requires a new contract and owner decision.

Approval order: root/Claude design review, GN-206 exact integration acceptance,
scoped implementation authorization, isolated security/durability tests,
separately authorized Windows fixture acceptance, then runtime owner review.
This proposal authorizes none of those later actions by itself.
