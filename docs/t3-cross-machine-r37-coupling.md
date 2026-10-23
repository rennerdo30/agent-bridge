# PR141 boundary and coupling map for parent scope decision

This is a source-derived proposal, not a scope reduction, rollback, portability
proof or acceptance. No fences were removed for the strategic opinion. Parent
decides extraction after holistic review. The Opus opinion was brief-only, not
independently source verified; the source/CI qualifications below control.

## Failure model and authority boundary

The messaging contract protects exact destination selection, local/remote mailbox
provenance, native/frontend/job identity, claims, inbox reads, delivery/events,
ACK/recovery and immutable retry intent across disconnect/restart/reuse. Genuine
same-binding reconnect remains eligible. Missing/ambiguous historical evidence
is retained/quarantined, never guessed into a native/hosted/role/job owner.

Existing authenticated shared archive/history access is separately authorized.
It is not confidential per-recipient storage. No end-to-end confidentiality or
full data-isolation claim follows from these mailbox fences. Native-child and
cross-host restrictions still apply, and history reads cannot consume/ACK mail.

Two failure models must not be conflated:

- **Messaging/recovery:** authenticated or stale/replaced principals, duplicate
  and delayed RPCs, restarts, accepted-operation uncertainty, process/host identity
  collisions, concurrent registration and ordinary SQLite transaction rollback.
- **Whole-home preservation:** missing/replaced files/directories, independently
  retained group expectations, cross-file snapshots, power-loss publication and
  inactive unsupported cached writers. This stronger contract motivated the
  cold-journal/backup/parent-chain mechanisms. Local mocks do not establish its
  native filesystem guarantees or availability.

Neither model allows secrets probing, deleting originals or inventing resolved
operation/consumption proof. Arbitrary privileged rewriting of every independent
proof is not made safe by an unsigned manifest; ownership/physical publication
preconditions and explicit offline coordination remain material assumptions.

## Concrete source coupling

| Class | Source areas | Why it exists; extraction constraint |
|---|---|---|
| T3 messaging/auth required | `src/core/t3*.ts`, `recipient-ownership.ts`, protocol/envelopes, broker registration/send/read/ACK, node read journals | Exact app/provider/scope/thread/native incarnation and per-copy host/namespace fences. Original broad native/mailbox claims cannot return. |
| T3 messaging/auth required | `src/network/link.ts`, network peer schema/capabilities and tracked-send persistence in store | Persist authenticated host and original frontend before dispatch; preserve on retries/restart; prevent local/project/alias fallback or host-display-name retargeting. Both directions must gate payloads/receipts. |
| Existing supported behavior requiring explicit authority | `role-queue.ts`, `job-mail-routing.ts`, durable job lookup, owner-question/system producers | Parent retained explicit agent-kind queues and authenticated local job-supervisor succession. Ordinary exact mail and pinned remote sends stay immutable. Removing these changes would break supported behavior, not merely simplify tests. |
| Compensation for new ownership/auth fences | Producer envelopes, remote admission/report/initial-done/cancel paths, native-child receipt helper, offline jobs/aliases/project checks | New quarantining exposed previously untyped or name-only producers. These source fixes preserve delivery without granting a broad fallback. Bridge-owned remote JobRunners remain Bridge jobs, not remote T3 children. |
| Compensation for fail-closed delivery/refusal | `job-runner.ts`, runner store/control/start, retained/resolved/archive evidence and remote runner-ledger capability | Protocol/admission refusals exposed accepted-note/final loss, head-of-line and continuation overlap/restart gaps. Accepted UUID/body/intent/input evidence cannot be dropped to remove this machinery. A separate runner redesign needs a preserved non-loss seam. |
| Compensation for startup availability | `prior-endpoints.ts`, reader admission/process identity, store factory, observation, cold bootstrap worker/journal and deferred broker services | Source-created strict admission plus synchronous construction exceeded2s on Windows. The outer10s bootstrap/fresh final min(2s,remaining) architecture attempts to preserve the deadline. Reverting to one synchronous2s constructor is not a proven availability fix. No services/RPC authority may escape incomplete activation. |
| Protection necessitated by that bootstrap design | Independent ordinary/cold provenance, anchor, journal and parent-chain durability; metadata boundaries | Losing the entire ledger otherwise converts prepared uncertainty into absence. These are compensating safeguards, not evidence that cold preparation itself is required by the original T3 wire contract. Extracting bootstrap requires preserving the current unknown-state boundary, not deleting records or treating absence as ordinary. |
| Preservation protection while public APIs certify backups | `backups.ts`, message-backup snapshot barriers, current-layout preflight, R37 catalog and external format2 witness | Cross-file archive moves, omitted legal names, self-declared groups and incomplete copied proofs must not be labelled verified. Full-restore refusal alone does not close the backup-certification gap. Source current14 refusal must precede metadata mutation regardless of any extraction. |
| Stronger independent hardening candidate | Whole-home power-loss/parent-chain guarantee, full restore-generation design, portable cold-provisioning mechanism | These exceed exact T3 routing. They may be split only at a reviewed API/authority seam that stops certification/effects it cannot prove and preserves all bytes. No extraction is authorized by this document. |
| Preservation/gate fixtures, not product authority | Mocked network/filesystem/worker transports; actual-handle nonauthorizing observations; mobile pins; CI inventories | A fixture must reach its intended guard. Protected pin attribution and source mocks are not hosted/native acceptance. The approved flaky candidate is untouched. |

## A concrete scope-reduction seam, for decision only

If parent extracts full backup/cold durability, first inventory every entrypoint
that creates, lists, reads, reports success for or restores a current bound full
snapshot. The seam must refuse unprovable certification **before effects** and
explicitly distinguish raw preservation from verified/restorable backup. Preserve
existing originals, orphan artifacts, scoped message snapshots and separate merge
ownership rules. Merely disabling restore, deleting tests or moving files while
leaving a successful verifier/publication is unsafe. The existing AB-461 boundary
is full-restore unavailability, not permission to certify an incomplete backup.

Keep the message protocol/identity/namespace gates and accepted-operation
retention in PR141 unless a replacement actually preserves their demonstrated
red schedules. A reduced cold path needs a separate accepted startup strategy;
it cannot silently reuse stale proofs or increase the2s/10s deadlines. Protocol11/
metadata6 remain the approved source boundary until concrete released/development
compatibility evidence supports a separately reviewed change. No version rollback
or additional bump is implemented here.

## Windows candidate boundary, not an adapter/fallback

Hosted explicit `directory-publication/unsupported` proves current Windows
unavailability for ordinary metadata as well as cold preparation. It does not
prove all historical generic worker errors had that cause. The Microsoft API
research in the linked durability proposal establishes a proof gap, not a claim
that Windows durability is impossible. No native adapter/helper was implemented.

A concrete alternative for review is to separate **existing ordinary SQLite
authority** from **newly published cold/full-backup durability**:

1. Admit only an already populated, independently proved compatible ordinary
   database/home generation under the existing reader/endpoint/common exclusion
   and final fresh proof. Retain exact identities, namespaces, owner quarantine,
   cached-writer boundaries and no-unknown-reexecution rules. Component1 shipping
   data cannot be casually called compatible; offline migration/admission remains
   an explicit owner decision, not a runtime environment override.
2. Keep ordinary ownership/registration changes inside that existing database's
   SQLite transaction, with original rows retained, instead of requiring a new
   external directory/journal publication for every ordinary admission. Do not
   infer ordinary from a missing cold anchor or an absent catalog. New/lost/
   ambiguous homes remain refused.
3. Leave new cold preparation, independently witnessed full backups and bound
   full restore unavailable wherever their stronger publication proof is absent.
   Do not report an ordinary transactional open as proof of power-loss-safe
   parent-chain publication or a restorable whole-home snapshot.

This is not yet a proved portable implementation. It needs an explicit failure-
model decision and review of SQLite's actual Windows VFS/WAL/directory guarantee,
existing-home provenance, interrupted migration and cached writers. It would avoid
global ordinary failure only for the genuinely proved subset, not manufacture
authority for arbitrary shipping/dev homes. Another option is an independently
reviewed consolidated/provisioned durable authority store; that too needs initial
publication/absence/restore proof. No implementation of either is authorized here.

## Release versus development provenance

Local tagv0.30.32 and original parent70820a0f use metadata1/protocol2. The branch's
metadata2..6/protocol3..11 states are unreleased. Actual installed processes/homes
were not inspected. Therefore m1 exclusion has shipping impact, while every later
cached-writer claim must name its exact intermediate source schedule. Endpoint
absence and a common lock exclude only what they prove, never an inactive cached
writer. No new source/format field retroactively revokes a returned native handle.

The R37 post-admission `initial` field is specifically unaccepted: a static
fresh-root classification is not automatically immutable absence evidence. The
review must test concurrent additions, old parser bypass via cached statements,
catalog deletion/replacement, pending backup snapshots and crash/restart. Missing
old draft evidence refuses; it is not reconstructed. No new gate is asserted
necessary or sufficient until that schedule is reviewed.

## Residual classification, not expectation rewrites

| Exact residual family | Intended refusal / actual issue / present status |
|---|---|
| Three unsafe/hot metadata native observation cases | Parent changed the contract: authorizing opens refuse, already-owned actual handles/bytes use nonauthorizing observation. Two-handle and129/130 capture/close assertions retained. Source fixture changes here; native gates unrun. |
| Optional purge closeBackups1 versus2 | Fixture measured helper calls rather than one owned worker. Production close order explains both helper calls; exact worker blocking/drain case passed at667. No broad count relaxation. Mandatory recovery failure remains separate. |
| Doctor5/job-outcomes/background bound restore | Current source explicitly refuses before displacement; availability is open AB-461. Prior roundtrip assertions remain evidence of unavailable behavior, not passes or silent expected-value updates. |
| Backup checkpoint ENOENT/backups | Fails before intended checkpoint/preservation assertion; no demonstrated source loss. Fixture stage/inputs unresolved, not suppressed. |
| Owner-question/deferred-hosting legacy cohosting | Old/new component exclusion is intentional; original cohosting acceptance conflicts with the approved gate. No blanket offline override or mass assertion rewrite performed. |
| Prior endpoint unknown lease versus timeout; t3 restored-old matcher | Classification/actionable recovery differences unresolved; old-reader/unknown refusal remains. Do not accept any error as equivalent. |
| Windows broad directory refusal + secondary HTTP/null/cleanup/timeouts | Explicit hosted unsupported classifications confirm unavailability, but each first error and secondary resource/RPC rejection remains in the raw matrix. Unhandled lanes have UNKNOWN coverage. No native acceptance via mocks/skips. |
| Mac0e job5aff0ffe exited without final | Ten-job takeover test569 still a real unresolved runtime gate. Earlier1b/200/0c variants are retained history, not proof of one cause. UUID/body/intent/final retention assertions unchanged. |
| Mac0e runner-store background import locked | `storedProvenance` journal267 → inspect/assertBootstrapAccess → existingMetadataDb → runnerFilesImported251. Exact locking schedule unproven; no blind retry/timeout/assertion weakening. |
| Historical quiet observer/fairness/WMI lateCreate | Later passes do not prove causes. Original identity, responsiveness, ownership and shutdown accounting gates remain. |

The22-lane matrix includes all four/five/two unhandled-rejection groups reported
for Windows shards, including remote-start-admission, runner continuity,
job-authority-retained, job lookup/recovery, start-readiness and authority recovery.
No global rejection ignore or foreign PID cleanup was added. Parent's next review
must assess the complete candidate, not extrapolate from21 local mocked passes.
