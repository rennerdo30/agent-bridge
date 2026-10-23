# AB-458: one convergence candidate from green main

Status: **design for independent review, before implementation**. This is not
repair round 38, a release decision, a migration authorization, or native/two-PC
acceptance. The proposed candidate uses ordinary SQLite transactions for durable
authority, retains exact messaging and accepted-work fences, and keeps main's
backup/restore feature. It does not require directory-publication proofs to open
ordinary Windows storage. Four implementation slices below form one candidate;
none is independently merge-ready.

## Frozen inputs and ownership

| Input | Exact identity and evidence qualification |
| --- | --- |
| Assigned starting base | `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`, tree `099261e3f7c378f38bf2ecb2dcf4ca4479d9fabf`; PR140 merge, supplied last green main. Green is the parent's starting-point evidence, not a test run by this design job. |
| Design checkout | `E:/AgentData/claude-codex-comm/t3-19a902db`, assigned branch `t3/t3-messaging-convergence-design`; initially clean and exactly at that base. Only this document is owned. |
| Preserved PR141 | `t3/fix-t3-cross-pc-messaging`, `c94cf75602c53e7949d68066071c2b05f11df986`, tree `fc748e5e488db7de4a012fcd40b304dd8f87608f`; checkout `C:/Users/renne/.t3/worktrees/claude-codex-comm/t3-c91ee5ff`. Read by immutable Git objects; no modifications there. |
| Final production source in that history | `6a64be36c5e11ec718eef65227332878c0286f0a`, tree `cecdbc8573974b219b083b64b0ddb8d954988f92`: **UNTESTED**. |
| Earlier tested source | `667a8f45b67706a037f450113bc3949a829a48c5`, tree `b388313b37bf78d3039ad7204bf895a026d6d19c`: R37 receipt reports 20 mocked preservation cases, one optional-purge resource case, and noEmit. Excluded cases are not passes. Neither later source nor native behavior inherits these results. |
| Shipping comparison | Local `v0.30.32` resolves to `42b9058fbd323654344f55d3c436da418bb804bf`. Its source and main declare local protocol 2 and metadata component 1. Main mailbox schema is 9. Branch schemas 10–14, protocols 3–11 and metadata 2–6 are unreleased. |
| Primary checkout | `E:/Development/claude-codex-comm` reports `main...origin/main`, with foreign untracked `.worktrees/` and `Python/`. They were not traversed or modified. |

All required shared/repository rules and the brief footer were read. The explicit
native-T3 routing and no-further-agents/no-Bridge restriction control this job.
No fetch was needed: all named commits were present locally. No history rewrite,
branch reset, PR creation, baseline amendment, installed-home inspection, or desk
state/verdict/handoff edit is part of this design.

After independent design approval, the parent builds from the exact main base in
its own assigned candidate checkout. Integration is a **forward commit into the
existing PR141**, after review: preserve the c94 ref/commit/worktree and show the
reviewer both `main..candidate` and `c94..integration`. Do not reset PR141, force
push, change its history, or delete the preserved mechanisms/evidence from the
frozen ref. Parent owns any necessary integration-file replacement; this design
job does not perform it.

## Failure model and product boundary

Protect against untrusted callers and authenticated but untrusted paired peers;
concurrent local sessions; delayed/duplicated requests and receipts; disconnects;
process death/restart, PID reuse, display-name reuse; ownership/namespace changes;
and ordinary SQLite commit/rollback/error behavior. A paired host may speak for
its advertised local principals, never impersonate a different authenticated host
or select an unadvertised local principal. Pairing is not per-recipient archive
confidentiality. Existing authorized history access stays separate from inbox
consumption, ACK and ownership.

An accepted message, control, runner note, input or final has durable original
bytes, ID and first intent before success/ACK/provider admission. A crash after
dispatch but before confirmation is **unknown**, not permission to execute again.
Live or unknown remote work is never automatically recovered as dead. Missing
ownership proof preserves/quarantines bytes; it does not mint an owner from a
name. No guarantee against the same OS user deliberately rewriting every database
and all its proofs is added. Ordinary nofollow, identity and path checks still
prevent accidental substitution and untrusted path selection.

**Explicit product tradeoff for design approval:** replace PR141's new
whole-home/ancestor-chain power-loss publication contract with main's ordinary
storage contract plus SQLite-transaction authority. There is no promise that a
newly created home, backup directory, rename or external JSON publication survives
arbitrary power loss atomically with its parents. Previously committed SQLite
records use the shipped VFS's synchronization guarantees; recovery refuses
incomplete artifacts and never infers successful execution from missing evidence.
Do not call this equivalent to R34–R37 directory durability. If that stronger
guarantee remains required, stop this candidate before code: a supported portable
publication design is still absent. No Nt/TxF/admin/volume/helper/PATH fallback,
and no inference of ancestor durability from MoveFileEx, is proposed.

This tradeoff does **not** waive authenticity, accepted-data retention, backup
completeness verification or restore recovery. It is the single consequential
product choice the parent should surface in design approval; this document makes
the recommendation concrete, without applying it to installed data.

## What source establishes

References below use `M = 5e3fa8aa` and `P = c94cf756`; line ranges belong to those
immutable blobs, not to an eventual candidate.

1. **Main already has the storage boundary.** `M:src/core/store.ts:360–429`
   constructs the owned main/archive/history handles under a storage lease,
   migrates, attaches compatibility, and configures SQLite. `metadata-db.ts:145–205`
   caches admitted handles, sets `synchronous=FULL`, snapshots before component
   migration, and uses `BEGIN IMMEDIATE`/commit/rollback for additive metadata.
   `sqlite-migrations.ts:59–149` rechecks versions under exclusion, protects
   pre-migration snapshots, and restores inside a transaction without swapping
   another reader's database. `runner-store.ts:70–80,177–204,223–240` already has
   transactional state/spec archives. Reuse these mechanisms rather than build a
   parallel initialization authority.
2. **Main does not establish cross-database atomicity.** `sqlite-policy.ts:8–9`
   selects WAL and busy timeout, but does not explicitly set synchronous policy
   for every MessageStore writer. Metadata's FULL setting is connection-local.
   Set and read back WAL/FULL on every candidate writer of accepted authority,
   including archive writers that move such records; do not assume metadata's
   connection configures another connection. SQLite documents per-database WAL
   atomicity, not an atomic transaction across attached WAL databases; WAL is for
   same-host storage. The existing backup APIs obtain consistent SQLite views,
   not a simultaneous whole-home transaction. [SQLite WAL](https://www.sqlite.org/wal.html).
3. **Windows needs no application directory fsync for a SQL commit.** The normal
   Windows VFS is `win32`; retain the bundled Node/SQLite VFS, with real locking,
   rather than substitute a no-lock/custom VFS. This is the portability boundary,
   not proof of a particular installed filesystem. [SQLite VFS](https://www.sqlite.org/vfs.html).
   WAL/FULL adds a commit sync; WAL/NORMAL may lose the last commit on OS crash.
   FULL in rollback mode is not universally power-loss durable, so the candidate
   requires verified WAL/FULL for accepted authority, not an assumed default.
   [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).
   These guarantees assume working OS flush/locking and hardware; they do not
   certify publication of unrelated directories. [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html).
4. **The reported token/classifier coupling is real source behavior.**
   `P:src/cli/broker-daemon.ts:23–33` calls `loadOrCreateToken` before the store
   factory. `src/core/token.ts` names that infrastructure file `token`.
   `P:store-bootstrap-journal.ts:335–356` allows canonical DB sidecars and a small
   infrastructure set, excluding `token`. Thus the ordinary daemon sequence makes
   `initial=unproven, origin=legacy-unproven`; `preservationGroup:424–434` requires
   fresh origin, so full backup refuses. Token bytes were not read. This is a
   source-derived schedule, not a newly run reproduction.
5. **The completeness fix is not proved complete.** The same classifier is a
   one-time directory enumeration; it neither revokes a cached native handle nor
   serializes later unregistered creation. `registerMailboxDatafile:381–402`
   registers constructors, while an old returned object can keep using prepared
   statements. `preservationGroup` skips private-name candidates and snapshots
   are separated by awaits. Parser rejection of a missing `initial` field proves
   only a new read refuses. Consequently constructor registration, a fresh flag,
   or restoring refusal cannot establish that all captured groups are complete.
   Do not presume the interrupted R37 review accepted these schedules.
6. **Main's full verifier is insufficient for the retained omission negative.**
   `M:backups.ts:20,81–113,247–263` selects five canonical DB names and checks only
   manifest-listed files. Removing one complete group and reweighting a manifest
   can leave checksums valid. Legal noncanonical MessageStore files are absent
   from that list. `restoreBackup:266–309` does preserve displaced bytes, uses
   maintenance exclusion and compensates on failure: keep that feature and repair
   completeness before allowing candidate backup success.
7. **Scoped snapshots are different.** `M:message-backups.ts:13–29,72–178` backs up
   selected tables, in bounded row/byte windows, using a SQLite single-flight
   transaction and explicit merge-only metadata. Keep that scope, but include
   envelope/namespace/intent proofs needed by those rows; it is not a full home.
8. **Native T3 integration is still a dependency.** Main contains PR139's validated
   reduced profile and local `T3Waker`, plus PR140's disabled upstream patch/CI
   package. Neither is a production native connector. `t3-identity.ts`,
   `t3-wake-journal.ts`, `mcp/t3-wake.ts`, `docs/t3-native-bridge-contract.md` and
   `scripts/t3-native-integration/manifest.json` establish that separation.

## The candidate architecture

### One authority in the existing databases

Keep envelopes, store namespace, sender intents, destination pins, recipient
registrations, explicit role grants and job-mail generations in the MessageStore
database, transactionally with the corresponding message copy. Use the existing
`bridge_metadata` rows in canonical `bridge.db` for runner state/original archives,
retention proofs, backup input registrations and backup selection records.
Indexes accelerate lookup; they never replace retained originals. No new bootstrap
worker, external initialization journal, home anchor or general-purpose external
quarantine ledger is required.

Propose **local protocol 12, metadata component 7 and mailbox schema 15** as one
reviewed candidate contract. They deliberately do not reuse unreleased p11/m6/s14
for a different storage/backup meaning. Pairing version 1 and JSON format 4 stay;
the exact-owner capability bits and `remote-runner-ledger-v2` keep their established
meanings. Schema 15 includes the 10–14 envelope structures and a candidate marker;
metadata 7 identifies the consolidated admission/retention/backup contract.
These are proposed source changes, not authorized baseline edits or installation.

Migration of main s9 creates the 10–14 tables/columns with **no guessed native
owner or direction** for old mail. Keep original messages/archives byte-exact and
quarantine unproved copies. Existing proven hosted evidence may be retained only
when it satisfies the complete new host/direction/namespace contract; otherwise
retain it as evidence. A native/frontend identity collision never grants access.
No fallback via compatibility overlays may expose an ownership-blind mailbox.

Namespace loss in a nonempty candidate database is corruption/unknown, never
permission to generate a replacement. New namespace creation is limited to the
explicit fresh or offline migration transaction. Restore preserves its identity
bytes but admits it under a fresh local operating generation; it does not turn
copied inode IDs into local authentication proof.

### Exact dispatch, receipt and consumption

At first dispatch persist UUID, original and wire bodies, authenticated sender
owner and mailbox source, immutable target intent, and selected destination:
host UUID/fingerprint plus exact frontend scope/thread/provider or native
incarnation. A display name is a label, not the durable route. Transactional
admission precedes network output. Every subsequent attempt uses those bytes and
that host/owner; it cannot resolve a new alias, project main or local session to
replace a retained remote destination. An initial resolution that conclusively
has no effect may fail normally; a dispatched unknown result stays unknown.

The paired transport derives host provenance from its authenticated link, checks
sender against that host's advertised principal, and validates the exact selected
destination and capability bits in **both directions**. A caller-supplied host ID
is not evidence. An outbound durable copy carries remote mailbox provenance and
cannot become local inbox mail, even if owner IDs collide. Broadcast produces
independent per-recipient envelopes and receipts. Sender-owned send-state and
receipt probes verify original intent before exposing progress.

Only the exact current owner and namespace can pending/read/claim/ACK a local
copy. ReadJournal keys bind frontend or native incarnation, host and namespace;
legacy name-only marks cannot ACK new mail. Read evidence is retained before
returning inbox context; lost ACK retries use that same proof. Role queues are
explicit agent-kind authority with one transactional claim. Job report succession
uses original job incarnation, creator/project/supervisor grant and generation;
ordinary mail never gains this retargeting privilege. Offline/system producers
capture authority before notification or remain unproven/unread.

Wake stays the existing local pointer-only `T3Waker`: mail storage and wake
submission are separate. Reuse the journal's submitted/accepted/unknown states,
stable ID and no automatic retry/native fallback; do not replay across a new T3
request namespace or credential generation. A wake receipt means accepted turn
injection, never inbox consumption or completed work. Hosted messages ultimately
use the destination PC's local current-thread connector, not remote generic T3
delegation or a native CLI wake.

### Accepted runner work: necessary, bounded dependency

Keeping strict message refusal while reverting runner handling to main would
reopen the R20/R21 losses. Keep immutable delivery ledger entries, append-only
input batches, predecessor barriers, transactional original/completion archives,
generation/CAS guards at registry claim, spec publication and actual start, and
evidence-only recovery. Provider admission records the selected input batch before
the external turn; no successor starts until its prior result is durably retained.
Controls remain unread if input capture fails. Persist every accepted successor
and final even if the first delivery is refused. A failed/malformed send response
is not delivered success.

Replace the **additional external quarantine file confirmation** with the existing
state archive plus exact proof row in the **same metadata transaction** as ledger
removal. The transaction retains full original bytes/UUID/body/intent/principal/
namespace and records evidence-only disposition. Recovery verifies those originals
and their hashes, never just an index or a file's existence. A proved failure rolls back
archive, proof and active-state update together, holds accepted bytes and latches
unsettled failure. Callback/queue admission returns success only after capture;
uncommitted callbacks cannot be advertised as durably accepted. A storage outage
does not magically preserve new, unaccepted in-memory bytes across process death.

Distinguish a proved rollback from an ambiguous COMMIT/I/O failure. If commit
outcome is unknown, keep the same operation ID and inspect the exact retained
row/CAS transition on reopen; do not assert that rollback succeeded or reissue an
external effect. An unreadable database blocks that affected effect. Retry only
an atomic/idempotent SQL step whose admission identity is unchanged, never a
provider/network callback embedded inside a transaction retry.

Retain remote-operation exact request/host ownership, strict corrupt-cache reads,
capability checks, and original-spawn cancellation eligibility. Rejected spawn
cannot cancel a still-live original operation. A missing `registry.remote` field
does not bypass pending-operation admission. Existing pending/blocked/unknown
requests survive reconnect/restart without automatically reexecuting or claiming
terminal success. These are necessary compatibility fixes for existing Bridge
jobs; **generic T3-to-T3 task delegation remains separate and is not implemented**.
Do not expand the remote job feature set or redesign the whole supervisor.

Bounds: retain branch's 128 ordinary items plus one reserved final and 8 MiB per
runner generation; 128 immutable input batches; bounded remote operation records;
and 2,000 wake message IDs/8 MiB per existing journal. Admission checks occur
before accepting another item. Recovery uses indexed per-job cursors in 64-record,
8 MiB/25 ms windows; limit exhaustion means a resumable unresolved cursor, never
empty evidence or permission to start. Keep a transactional byte counter for new
retention/original/proof domains with a proposed 256 MiB home high-water mark;
refuse new producer admission before exceeding it, preserving reserved terminal
capacity for already admitted generations. Existing bytes over the limit are
readable/recoverable, not purged. Account reservations before accepting a job or
input; an oversized terminal result remains unsettled, never truncated.

Completed originals can move through main's archive/cold preservation workflow,
with transactional reference relocation and exact digest verification. Unknown
work and dedupe tombstones have no automatic TTL. Do not promise bounded total
historical disk while retaining arbitrary accepted bytes forever: bound active
work, inspection and new admission; capacity exhaustion requires explicit offline
archive handling. Main's existing backup rotation archives rather than deletes.
No periodic external-ledger scans or background collection of unknown effects.

### Ordinary startup and finite compatibility

Keep main's one synchronous initializer and owned handle cleanup. Carry over only
the nonescaping deadline, reader exclusion and cancellation checks required by the
new p12/m7/s15 authority. **Do not put the entire initializer inside a two-second
proof lifetime.** The original outer ten-second startup budget covers bounded
version reads, compatible-reader checks, the normal initializer and activation.
A fresh reader/endpoint check is immediately before effects under exclusion; a
fresh final check precedes serving. Two seconds remains the connection/probe
budget, not a claim that SQLite construction can be timer-preempted.

On Windows: bounded asynchronous process-identity observation first; acquire
existing endpoint reservation and common maintenance exclusion; inspect known
schema/component/layout; open ordinary SQLite with per-phase remaining busy
timeouts; perform allowed additive work transactionally; open archive/history;
recheck authority and original deadline; finish mandatory recovery; activate.
No call to `syncBootstrapDirectory`, `syncBootstrapHomeChain`, cold preparation or
directory-publication helper exists on this path. Token infrastructure is never
used as proof that a root is empty or as a backup payload. Known infrastructure
does not make an otherwise complete backup ineligible.

An in-flight synchronous SQLite call can finish after the deadline: the next
check denies serving, closes owned handles, retains any committed data and reports
settlement. No new SQLite phase or automatic second initialization is admitted on
timeout. Cleanup may settle later; it is not successful startup or a fresh budget.
Hosted Windows must show this path meets the unchanged outer budget; otherwise
stop with measured phase evidence, not another worker/journal/timeout workaround.

| Source home/state | Finite candidate treatment; no live operation authorized here |
| --- | --- |
| Fresh synthetic/new home | Known-role constructor creates ordinary SQLite, namespace and component in transactions. Full backup eligibility comes from input registration and complete known-role enumeration, not a permanent empty-root assertion. Unknown names only block certification of a full backup; they do not block unrelated ordinary SQL startup. |
| Shipping m1/s9, including v0.30.32/main | Preserve original home and main binary behavior. Candidate activation needs one owner-coordinated **offline, isolated** migration with a named input inventory and verified backups; then ordinary Windows opens m7/s15. No automatic in-place upgrade, updater, split/copy or inference that a missing endpoint proves cached old writers gone. The candidate must provide this finite path, not leave all shipping data permanently unsupported. Until coordinated migration, the old installation stays usable; candidate authority is not enabled over that shared home. |
| Shipping older supported schemas/JSON | Reuse main's backup-first additive migrations under the same isolated admission; retain original snapshots and imported file bundles. Preserve main's historical upgrade fixture matrix. Pre-lease s2/s3 do not gain automatic shared-home admission. |
| Candidate m7/s15 | Ordinary reopen/restart and compatible concurrent sessions; namespace and complete layout required. No directory proof requirement. Pending work retains exact evidence and does not block unrelated jobs/ordinary metadata reads. |
| Unreleased m2–m6 / s10–s14, p3–p11 | Do not lower version numbers or reinterpret them as shipping. Refuse automatic mutation before DDL/import/backup-directory effects. Read-only exact-format inventory may be prepared offline; preserve original branch, home and all bootstrap anchors/journals/witnesses, runner archives, operation caches and snapshots. A reviewed migration must transfer only proven authority with original intent/direction, retaining all unknowns as evidence. No blanket m6 parser upgrade. |
| Partial/unknown layout, missing namespace, malformed accepted evidence | Refuse only the affected authority/effect. Do not fabricate owner, direction, absence or settlement. Current-layout preflight is before metadata initialization or recovery snapshot; raw preservation is explicitly distinct from verified backup. |
| Cached old handle / old endpoint | Exact symmetric protocol refusal; probe all p2–p11 names and known canonical endpoint spellings. Common locks exclude cooperating active writers only. Offline operator coordination excludes the otherwise unprovable cached-writer case; a version bump/parser mismatch is not revocation. |

The shipping migration constraint is a real compatibility cost and must be shown
to the owner before enablement. It is not a new claim that shipping homes need
directory provisioning, nor permission to disable backups or normal main usage.
No installed migration is executed by implementation tests or this design job.

### Full backup completeness without a home publication ledger

Preserve create/list/read/verify, background capture, rotation, explicit confirmed
restore, raw recovery and main's displaced-byte rollback. Scope remains all
supported data stores/registered mailboxes and existing data JSON roles; credentials,
tokens, sockets and provider stores remain excluded. No secret/config discovery
or payload sniffing is used to classify unknown names. Existing explicit config
preservation is a known role, not authorization for this job to read owner config.

Use one registered-input domain and one per-snapshot selection domain in existing
`bridge_metadata`, **not** R37's fresh-root catalog plus external `.groups` witness:

1. Register each persistent MessageStore basename, namespace, role and current
   physical identity before it may accept traffic. Keep layout preflight first.
   A single generation counter changes with registration. Bound registrations at
   64 mailboxes. Explicit isolated shipping migration inventories legal alternate
   names (Unicode/spaces/case/extensionless/JSON suffix included) without opening
   private/unknown files automatically. A legal but private-role collision stays
   usable as a MessageStore; full backup refuses it pending explicit offline
   classification, rather than silently omitting it or weakening naming rules.
2. Before capture, reuse the single-flight SQLite lock pattern from
   `messageBackupIfDue` (main's full backup has only a shared storage lease, not
   single-flight exclusion). Coordinate both snapshot kinds with the existing
   `message-backup-lock.db`; do not hold a write transaction in live bridge.db
   across incremental copy awaits. Validate
   registrations and enumerate the fixed supported DB/JSON roles under cooperative
   exclusion. Persist an immutable selection record keyed by snapshot UUID in
   canonical `bridge.db`: exact expected paths, roles, source namespaces and
   input-generation cutoff. Record explicit absences for optional canonical roles.
   Unknown non-infrastructure input, missing registered input or census exhaustion
   refuses full certification; ordinary startup and scoped snapshots still work.
3. **Snapshot canonical bridge.db first**, carrying that selection row. Snapshot
   all other primary mailboxes next, then monotonically growing shared archives;
   preserve bounded main WAL-inclusive snapshot APIs and JSON active-before-archive
   ordering. Revalidate the input generation and every selected source identity
   before publication; changed membership aborts the artifact, never extends its
   manifest from an unchecked enumeration. Coordinate import/archive movement or
   retain its originals across the capture so no pre-cutoff accepted record loses
   both copies. A storage lease alone is not a stop-the-world write barrier.
4. A new **full artifact version 3** requires canonical `bridge.db` at a fixed path.
   `readBackup` opens its snapshot read-only and compares that immutable selection
   with the manifest's exact file set and namespace/layout of every mailbox,
   checks hashes/bytes, duplicate/path/link bounds and absence declarations, then
   returns success. Manifest edits cannot select the expected group. Missing
   canonical DB, removed whole group, partial copied proof, registry mismatch or
   changed selection refuses before restore effects. There is no R37 bootstrap
   chain in a new candidate artifact to omit or pretend was validated.
5. The copied SQL selection is independent of the mutable JSON manifest, not a
   cryptographic signature against an OS owner rewriting both. Detached complete
   v3 backups remain verifiable/restorable: there is no source-home inode witness
   requirement. Keep a source-side publication receipt in the same metadata domain
   for status/recovery; artifact verification still checks actual payload bytes.
   Pending directory/file/manifest publication is retained but never listed as
   verified success. Normal file sync/rename has main's stated power-loss limit.
6. Restore validates source and destination before maintenance/close/displacement,
   rechecks after exclusion, and uses main's recovery/displaced/rollback mechanics.
   Restore is explicitly offline with all old processes coordinated out. Reuse
   source namespaces and immutable evidence; create a fresh **operating generation**
   transaction after verified install, recording restore provenance without granting
   new recipients or replaying unknown work. Old inode IDs are historical, never
   live authority. Crash during displacement uses retained recovery originals;
   interrupted completion refuses startup of affected authority until recovery.

   Before displacing bytes, put a restore-pending marker in both the original
   canonical metadata and the staged canonical replacement, referencing the
   exact recovery set and affected namespaces/job IDs. Install canonical metadata
   last. A process crash sees an old or staged marker, or missing canonical data
   plus the known recovery set, and refuses fresh-home inference. The offline
   restore joins the displaced current accepted mail, read evidence, send intents,
   runner inputs/finals and remote-operation records into retained restore archives
   before clearing the marker. Same-namespace copies can merge only on exact
   UUID/owner/body agreement; different namespaces and conflicts remain evidence.
   Restored provider-admitted inputs and unknown remote effects are held per job,
   including those known only to the newer displaced data. They never become
   eligible merely because an older snapshot lacked them. Clearing restoration
   status is not resolution of those effects. This preserves usable full restore
   and all newer accepted bytes while preventing rollback-to-an-earlier-snapshot
   from admitting duplicate execution. Test every displacement/install/marker
   boundary; this is process-crash recovery, not atomic whole-directory power-loss
   publication. Missing or inconsistent recovery originals remain unresolved.

V1 shipping backups stay readable and restorable with their original **listed-file
integrity** meaning. The API/status must label that scope and never certify them
as a complete candidate home. Restoring v1 into a candidate is an explicit isolated
legacy restore followed by the shipping migration/quarantine path, not replacement
of live candidate authority. This preserves main's backup/restore capability while
preventing false completeness. Unreleased v2 artifacts remain byte-preserved and
are verified only by their exact retained witness/chain reader; absent or partial
witnesses refuse. They are not relabeled v1/v3 or accepted by a generic manifest
checksum. Retain an explicit read-only v2 verifier if such artifacts must be
verified by the candidate; its existence cannot place directory fsync on startup.

Scoped message backups include local envelope rows, mailbox namespace, send intent
and destination rows, role/job generation records and required read receipts for
the selected messages. Their merge checks the destination namespace and ownership;
incompatible copies are evidence-only, never consumable local inbox. They still
exclude unrelated runner/history/config data and cannot invoke full restore.

Selection records are bounded at 10,000 files/8 MiB per snapshot and 64 mailboxes;
enumeration uses cursors/windows. Exhaustion refuses new full capture without
removing old artifacts. Completed selection records travel with snapshots; their
source copies can be archived with the associated retained backup, transactionally
updating references. No per-message external witness or new permanent directory
journal. Any inability to preserve main's confirmed restore is a stop condition,
not justification for carrying AB-461's restore-off behavior into this candidate.

## Extraction map: commits, exact source hunks and dependencies

This is a **selective port/rewrite**, not a list of whole commits to cherry-pick.
Use `git diff --unified=0 M P -- <file>` and the named symbols to delimit hunks.
M/P line coordinates below make overlapping historical edits unambiguous.
Preserve tests/evidence on P even where replacement production code is smaller.

| Package | Source commits / exact hunk selection | Candidate operation and dependency |
| --- | --- | --- |
| Ownership/envelope schema | `cf6270a9`, `cca32254`, `bf256d48`, `11bcc123`, `7ed06b09`; P `recipient-ownership.ts:1–83`; `protocol.ts:64–180,254–258,299–345`; `store.ts:138–206,265,848–1110,1190–1345,1390–1420` | Port typed frontend/native/mailbox/source ownership, ambiguity, local-copy guards, sender intents/pins, independent broadcast and read/ACK/claim checks. Retain original schema10–14 evidence transformations; add candidate15 marker. Depends on isolated admission and namespace, not bootstrap provenance. |
| Exact remote route | `14c5489b`, `cf6270a9`, `cca32254`, `7ed06b09`; P `network/link.ts` peer/message/hello/frame schemas, `Link.handleFrame`, send/receipt gates and pinned-destination selection; P `broker.ts:2723–2821,3022–3110,3314–3498` | Port authenticated host derivation, destination pins and sender receipt guards together. Reject a remote pin before any local fallback. Retain primary capability-array bounds; new bits are existing explicit optional fields. Requires ownership/envelope schema. |
| Read/reconnect/native child | Same identity commits plus `183c59e8`, `530267be`; P `read-journal.ts` diff hunks at M~10/101/116; `node.ts` message event/decode, `helloArgs`, `trackedSend:859+`, `messageReceipt:952+`, `nativeChildAck:964+`, `unread:1114+`, `markRead:1174+`; `client.ts` auth/connect hunks | Port original proof-bearing read marks, host/ns/native incarnation, ACK replay and exact auth refusal. Keep M native-child lineage guards, remove no isolation checks. Do not port P constructor/startup worker plumbing by proximity. |
| Existing producer behavior | `bb6f598b`, `e671229a`, `2a0f4acf`, `3f86ae28`, `18a66e05`, `183c59e8`, `e13ce806`, `3271b943`, `9cfa6e73`; P complete `job-mail-routing.ts`, `role-queue.ts`; store `jobNames`, `retainJobGrant`, `claimRole`, `handoffMail`, `insertJobDelivery`; broker `mailboxJob`, `durableRecipient`, `claimQueueAliases` and job-report handlers | Port explicit queues and job generation grants, producer capture, alias-sharing and supervisor reports. Include matching ownership hunks in owner questions, transfer notifications, final results, handoffs and hooks. These are compatibility requirements, not new general delegation. |
| Runner non-loss seam | `485b4173`, `b2066633`, `284d852c`, `03ef1b16`, `990584ed`; P `runner-store.ts:184–300` plus `publishRunnerSpec` guards; complete `runner-delivery-retention.ts`, `runner-retention-index.ts`; job-runner ledger/input/queue/drain/provider-admission/completion hunks; `runner-ledger-recovery.ts` | Port ledger/batch/CAS semantics and actual start/preclaim checks; replace external quarantine publication with existing transactional state archives/proofs. Keep bounded read-only legacy evidence import/census; no whole-home journal dependency. Requires metadata authority. |
| Remote unknown/cancel compatibility | `990584ed`, `56edc4b6`, `003199e3`, `2006221c`, `1b437a33`, `0c3a02db`; complete `remote-operation-evidence.ts`; P remote-job-host `read`/operation admission/confirm/observe paths, remote-jobs original-spawn/control/settlement hunks, remote-job-protocol ledger-v2 gate | Retain exact pending request ownership, strict read failure, original cancellation and request/result capability gates. Do not port general remote T3 task execution. Depends on runner retained originals; cannot be deferred while strict messaging drives existing job callbacks. |
| Admission: keep necessary checks, replace coupling | `78bd894a`, `30e8e4e4`, `871ef76a`, `c0712283`; P `prior-endpoints.ts`, `startup-budget.ts`, `storage-admission.ts`, client signal/remaining-budget changes; M `store.ts:360–429`, metadata opener/migrations/locks | Rewrite a single ordinary initializer with outer10s budget, short probes and effect-adjacent checks. Keep async liveness/SQLite timeout/restoration checks where needed. No cold worker, no proof renewed by a timer, no legacy cached-writer exemption. |
| Layout and backup completeness | `70c17296`, `7007cbec`, `9e5eddcd`, `b82c0b29`, `4b99f5e2`, `6a64be36`; P complete `mailbox-layout.ts`, registered-name/no-probe/whole-group negatives; M `backups.ts:81–113,224–309`, message snapshot tables | Port pre-effect current-layout refusal and exact legal-name registration rules; replace P bootstrap/catalog/witness/publication coupling with SQL selection/v3 verifier/restore above. Do not port fresh-root classification, strict directory barrier, external group witness, or bound restore refusal. |

Production call-site closure for the producer/runner rows is finite: affected
files are enumerated in slices 2–3. If a new required producer is discovered,
record the actual call path and update this design for parent review; do not add
a name-based fallback or let another repair chain expand silently.

**Leave on M unchanged unless a listed seam requires a documented edit:**
`t3-host.ts`, `t3-identity.ts`, `t3-wake-journal.ts`, `mcp/t3-wake.ts`,
`job-environment.ts`, native lineage, profile selection, pairing/TLS identity,
history/transcript storage, existing cleanup policies and PR140 artifacts.
Their current limitations stay explicit. No generated `plugins/*/dist`.

**Do not extract the following production mechanisms:**
`store-bootstrap.ts`, `store-bootstrap-worker.ts`,
`store-bootstrap-journal.ts` as startup authority, or their cold-worker build
entry; ordinary/cold parent-chain proofs from `1c9876df`, `63fc64ae`, `f2f440d8`,
`3f1084d1`, `f6120223`; directory sync dependencies in metadata/backups; copied
inode equality as restore authority; P's permanent full-restore refusal. Keep all
their source/evidence on the frozen branch. Only exact read-only old-format
inspection code may be retained in an offline compatibility reader, without
authority to initialize/reexecute/repair. `admission-observation.ts` telemetry is
optional; it cannot become a proof or new acceptance condition.

## Four implementation slices, in dependency order

Each slice uses one source freeze, real regressions that fail on its broken base,
and a bounded mocked selection. Full suites are hosted only. The parent chooses
the permitted local test budget before implementation; this document runs none.

### 1. Portable storage/admission and explicit compatibility

**Production files:** `src/core/store.ts`, `store-version.ts`, `metadata-db.ts`,
`metadata-file-lease.ts`, `sqlite-migrations.ts`, `sqlite-policy.ts`,
`sqlite-maintenance.ts`, `store-compatibility.ts`, `store-compatibility-overlay.ts`,
`storage-lock.ts`, `prior-endpoints.ts`, `storage-admission.ts`, `startup-budget.ts`,
`mailbox-layout.ts`, `process-identity.ts`, `windows-process-identity.ts`,
`constants.ts`, `paths.ts`, `client.ts`, `node.ts`, `broker.ts`,
`daemon-launcher.ts`, `src/cli/broker-daemon.ts`, `src/cli/doctor.ts`,
`src/core/doctor.ts`, `src/cli/reindex.ts`.

**Effect:** p12/m7/s15 preflight, one normal opener, no directory barrier; explicit
offline shipping upgrade, future/draft refusal, owned abort. Production offline
admission API is narrow named-home coordination, not an environment bypass.
Keep native metadata lifecycle observation APIs nonauthorizing and their exact
actual-handle accounting; do not rewrite unsafe/hot native fixtures to authorize
unknown opens. No app/daemon/worker is launched by this slice's local checks.

**Mocked checks:** fake slow native phases >2s but <10s; original10s expiry,
late completion/abort and owned cleanup; p2–p11 exact-auth/prior-endpoint refusal;
cached old handle schedule; current malformed layout before metadata effects;
WAL/FULL readback per accepted writer; nonempty missing namespace; token-first
fresh home remains an ordinary admissible home. Use synthetic isolated s9/m1
upgrade with failure before/after snapshot/DDL/commit and exact original retention.

**Hosted actual checks:** `daemon-windows-bootstrap`, startup/daemon readiness,
`historical-sqlite-upgrade`, `sqlite-migration-recovery`, native metadata/lifecycle,
ordinary direct/factory/doctor/reindex opens on Windows/Linux/macOS; actual SQLite
contention and recovered journals. Preserve historical schemas and native counts.

**Exit:** healthy fresh and explicitly migrated shipping-format Windows homes
open under original outer budget with no directory-sync refusal; corrupt/draft
homes refuse before effects; no serving authority before admission. **Stop:**
native phase cannot meet budget, rollback/cleanup ambiguity, inability to exclude
old writer without coordination, or proposed gate/pin change beyond this design.

### 2. Exact local/paired messaging, all existing producers and read/wake

**Production files:** `src/core/protocol.ts`, `recipient-ownership.ts`, `store.ts`,
`broker.ts`, `node.ts`, `client.ts`, `read-journal.ts`, `native-children.ts`,
`job-mail-routing.ts`, `role-queue.ts`, `project-groups.ts`, `job-handoff.ts`,
`owner-questions.ts`, `owner-question-service.ts`, `oversize.ts`,
`src/network/link.ts`, `transfers.ts`, `src/mcp/delivery-evidence.ts`,
`final-result.ts`, `hooks.ts`, `job-host.ts`. Reuse main T3 host/waker/profile code;
no production native connector enablement.

**Compatibility:** fail-closed local p12, paired explicit ownership/provenance
capability refusal; legacy bodies retained unproven. Preserve explicit role queues,
aliases with sharing off, offline jobs/owner questions and job report succession.

**Mocked checks:** `t3-cross-machine`, ownership/native-child, routing/broadcast,
job reply/question/supervisor and read-journal regressions. Include hostile paired
sender, exact-thread mismatch, host fingerprint/name reuse, cross-host outbound
copy as inbox, native incarnation collision, changed read namespace, independent
broadcast ACKs, first-intent/body mutation, local fallback after remote pin,
sender-only receipts, missing old proof and same-binding reconnect. T3Waker
submitted/unknown restart never retries or calls native wake; delivery/consumption
asserted separately.

**Hosted actual checks:** authenticated TLS paired-envelope integration using
synthetic hosts, real SQLite concurrent read/ACK/restart, MCP hook and native-child
refusal/lineage tests on all three OSes. These do not establish actual two-PC T3.

**Exit:** every listed negative fails closed while valid local/remote/native/job
and role flows retain original bytes and deliver to exact owners. **Stop:** any
producer requires guessing ownership, old-reader downgrade, a retained remote
destination resolves locally, or native fallback is proposed.

### 3. Accepted runner evidence and existing remote operations

**Production files:** `src/core/runner-store.ts`, `runner-retention-index.ts`,
`remote-operation-evidence.ts`, `job-run-index.ts`, `job-archive-index.ts`,
`local-result-receipts.ts`, `src/mcp/job-runner.ts`, `runner-delivery-retention.ts`,
`runner-ledger-recovery.ts`, `jobs.ts`, `job-host.ts`, `remote-job-host.ts`,
`delivery-evidence.ts`, `final-result.ts`, `src/network/remote-jobs.ts`,
`remote-job-protocol.ts`, and existing integration seams in `core/broker.ts`,
`network/link.ts`, `core/runner-store.ts`. Do not bring unrelated Muse/history
changes unless a specific listed retention call path proves they are necessary.

**Compatibility:** retain runner-ledger-v2 both ways, immutable old single-batch
records, strict corrupt accepted-operation refusal and no automatic restart of
unknown remote effects. m7 admission excludes old cached writers by coordinated
offline transition; protocol numbers alone do not. Legacy retained archives are
read-only evidence, never inferred empty after parse failure.

**Mocked checks:** R20/R21 `job-runner-continuity`,
`job-runner-delivery-settlement`, `runner-ledger-archive`, `job-authority-retained`,
`remote-operation-ownership`, `remote-start-admission`, `remote-cancellation-compat`,
`remote-runner-ledger`, `remote-job-observation`. Inject transaction failure at
capture/archive/proof/update/commit; first refusal plus accepted successor notes,
controls and final; CID dedupe; input arriving during admission await; restart
after provider admission but before result; live original spawn with rejected
replacement cancel; registry missing remote flag; corrupt cache disappearance;
capacity exhaustion without ACK/drop. Replace filesystem quarantine assertions
with actual SQL original/proof/rollback assertions, preserving behavior and IDs.

**Hosted actual checks:** real SQLite multi-process state CAS/restart, ten-runner
takeover, fairness/quiet observer, original-cancel races, Windows locked-handle
and lifecycle shutdown with no unhandled rejection. Real provider execution is a
separate explicitly authorized lane; mock provider success is not that evidence.

**Exit:** no accepted UUID/body/intent/input/final lost; unknown work never reruns;
all retention transitions atomic and capacity refusal precise. **Stop:** external
effect could have occurred but admission is treated as absent, a final bypasses a
barrier, or backpressure causes accepted-data loss. Do not fix by weakening fixtures.

### 4. Complete portable backup/restore and coherent candidate acceptance

**Production files:** `src/core/backups.ts`, `message-backups.ts`,
`backup-background.ts`, `backup-worker.ts`, `metadata-db.ts`, `store.ts`,
`sqlite-maintenance.ts`, `history-store.ts`, `src/cli/storage.ts`. Put the small
SQL selection/verification helpers in `backups.ts`/`metadata-db.ts`; no new external
ledger service. Include read-only old-v2 verifier only for compatibility, without
startup imports/effects. Keep main background worker ownership/drain ordering.

**Compatibility:** new full v3; v1 listed-file legacy restore plus explicit
migration; v2 exact-proof verification/refusal without fabricated witness;
scoped message snapshots remain merge-only and ownership-aware. Preserve original
data/config role coverage, full restore and raw recovery. No live migration or
restore is run in this design or local mocked checks.

**Mocked checks:** all R37 legal names and whole-group omission schedules, including
manifest reweight and missing canonical SQL selection; unknown private inputs
without sniffing; token-first ordinary home; concurrent constructor registration
and old cached writer; membership change across each snapshot await; primary
archive movement; omitted ownership table or namespace; malformed/future current
layout before effects; detached complete v3 restore; v2 missing/corrupt whole
chain refusal; mid-displacement failure/rollback retains every original; message
snapshot merge cannot turn outbound remote copy into inbox. Assert backup success
only at the verifier boundary, not just artifact directory existence.

Also restore an older snapshot over newer accepted work: kill the controlled
restore at each marker/displacement/install step, reopen, and prove the newer
originals remain retained and their unknown external effects cannot reexecute.

**Hosted actual checks:** `backup-background`, `backup-contention`,
`backup-settlement-schedule`, `message-backups`, `additive-migration-backup`,
`release-rehearsal-backup`, data preservation, daemon-backup drain and interrupted
restore/recovery on Linux/macOS/Windows. Then staged full/lifecycle/integration
workflows on the exact integrated freeze. No local full suite.

**Exit:** ordinary Windows metadata/startup/backups/recovery and explicit shipping
migration all work; full restore roundtrips history/owner answers/mail/evidence;
omitted groups never certify; original feature assertions retained; complete
hosted matrix has no unhandled/unknown coverage. **Stop:** any full verifier still
accepts an incomplete candidate artifact, restore remains unavailable, source
identity/cutoff cannot be established, or a product regression is dismissed as
fixture drift without source evidence.

## Protected gates: precise proposed deltas, no amendments

The 13 methods below are the exact keys in
`M:test/fixtures/mobile-wiring-baseline.json`. All baseline files, UI hashes,
normalizers and retention guards remain untouched by this design. Implementation
must first present normalized source deltas against M and get the parent's exact
gate review; this document is not permission to refresh a pin. If approval is
needed, stop at that source freeze with failing pin evidence, not a blanket update.

| Protected method | Proposed candidate delta and reason |
| --- | --- |
| `core/broker.ts:constructor` | Only ownership-aware handler arguments/guards for pending/read/ACK/send-state/native child and owner-question producer capture from the extraction map. Preserve constructor order, optional services, mobile authority, and native-child admission. No constructor-time bootstrap/store/worker/timer. |
| `core/broker.ts:listen` | Carry original outer deadline/cancellation and fresh post-recovery activation check. Keep main tentative listener and recovery semantics; no cold-worker wait or extra startup authority. Exact late recovery/abort assertions stay. |
| `core/broker.ts:startServices` | Bind network callbacks to exact destination/source provenance, pins and notifications; move only optional producers that could run before final admission to the existing successful-serving boundary. All original backup/history/archive/health/handoff services still start and drain. No service disabled. |
| `core/broker.ts:abortStartup` | If needed to close newly tentative exact transports/tasks, revoke first and join only those owned resources; retain store ownership and main cleanup ordering. No swallowing unsettled cleanup into success. No P whole-home provenance side effect. |
| `core/broker.ts:close` | Target unchanged normalized body. Ownership helpers must fit existing normal shutdown. Any discovered need to change it returns for separate exact review. |
| `core/node.ts:constructor` | Advertise m7 and store exact mailbox/owner proof needed by read journal; keep lifecycle registration and constructor ownership. No cold/provenance startup or new background job. |
| `core/node.ts:start` | Thread one original outer startup budget/cancel into connect/host admission; no second budget, deadline increase, default change or early readiness. |
| `core/node.ts:stop` | Target unchanged normalized body; existing exact client/broker/store cleanup remains. |
| `core/node.ts:tryBecomeBroker` | Replace direct ordinary store open with the single admitted ordinary opener, then final serving check, keeping endpoint reservation and cleanup. No bootstrap worker or journals. |
| `cli/dashboard.ts:constructor` | Unchanged. |
| `cli/dashboard.ts:open` | Unchanged. |
| `cli/dashboard.ts:ensure` | Unchanged. |
| `cli/dashboard.ts:close` | Unchanged. |

`src/dashboard/ui.ts`, desktop/mobile page markup, mobile activation/wiring
baselines, the UI/page SHA values, `methodBody`/normalization code in
`test/mobile-wiring.test.ts`, mobile owner-startup normalizer, and
`test/retention-guard.ts` are unchanged. Retention guard additions are evidence of
new behavior to review, not an excuse to suppress DELETE/DROP detection. Source
pins from P's earlier approved repairs are not automatically applicable to this
different candidate. Existing failure/unknown-coverage records are immutable.

## Native connector and acceptance matrix

PR140 at main pins T3 upstream
`968dd51704441138559a3fe9c348719f2b11e0c6`, reviewed patch order
`01-reviewed.patch`, `02-disposal-test.patch`, `03-round3.patch`, and Codex source
inspection pin `6203846fb3ef040f62eed9b35bc6629c8e88980a` in its manifest.
Preserve this package and its hosted gate; the workflow's mocked adapter tests
are distinct from production native transport.

Production use still needs trusted local-stdio Bridge server registration and
per-app-thread/per-provider injection at `CodexAdapterV2.codexThreadRuntimeParams`,
using the prepared in-memory MCP session's deliberate endpoint/authorization
projection. Preserve command/args/env/permission merge behavior; no CLI/global
environment/config credential scan. Registration producer/UI is not implemented
by the disabled patch. Rotation/revocation must replace the exact owned running
Bridge transport, with obsolete teardown unable to revoke its successor. Prove
no usable parent MCP config/credentials reach fresh/forked/resumed/nested native
children and no overrides persist. If isolation cannot be proved, use the
documented thread-bound authenticated proxy contract; do not enable injection.
No connector implementation or switch flip is included in these four Bridge
slices. It is a named upstream prerequisite to actual native/two-PC acceptance.

| Gate | Required evidence on exact final candidate | Current status |
| --- | --- | --- |
| Ordinary Windows | Fresh + explicitly migrated m1/s9 opens, metadata writes, full/scoped backups, restore/recovery, no unsupported directory publication; preserved original outer budget and handle counts | NOT RUN; source design only |
| Shipping compatibility | Synthetic v0.30.32/main m1/s9 offline isolated migration with original snapshots and ambiguous mail retained; future/draft states refuse before effects; no cached-handle exclusion claim | NOT RUN |
| Linux/macOS/Windows full | All configured full shards, lifecycle, preservation and integration workflows on one freeze; retain test IDs/counts, first errors and rejection ownership | NOT RUN; any unhandled rejection makes lane coverage UNKNOWN, never accepted |
| Paired envelope | Authorized synthetic TLS peers: exact advertised thread/host/scope/provider/ns, duplicate/retry/restart, replaced name/fingerprint, sender receipt guards and remote-pin local-fallback rejection | NOT RUN |
| Actual two PCs | Known reachable **authorized** paired endpoints on both PCs, compatible Bridge candidate and working current-thread connector on both; send/reply, idle/busy wake, restart/retry/name reuse, revoked connector refusal | NOT RUN; no scanning, secret lookup, provider startup or endpoint assumption allowed |
| Delivery vs consumption | Durable send accepted, remote storage, wake queued/accepted, exact-owner inbox read, ACK and application completion recorded separately | NOT RUN; wake receipt never substitutes for consumption |
| Native children | Existing Bridge lineage refusal plus exact-build upstream no-leak/non-persistence/revocation evidence for fresh/forked/resumed/nested children | NOT RUN; PR140 artifact alone is insufficient |
| Accepted runner/remote work | Transaction-fault, restart, successor-input/final and live/unknown operation schedules, no automatic reexecution/cancel of wrong original | NOT RUN |
| Backup completeness | Legal alternate files, independent expected SQL selection, whole-group omission/reweighted manifest negatives, detached complete v3 restore, v1 scoped integrity, exact v2 proof refusal | NOT RUN; restore-off does not pass |
| Protected gates | Exact proposed normalized deltas independently reviewed; all untouched pins/UI/normalizers/baselines/retention assertions preserved until explicit parent-controlled approval | NOT RUN; no amendments here |
| Release/update | Separate owner authorization and normal review/release gates | NOT AUTHORIZED; no install, migration, update or publication automatically |

R37's committed 22-lane matrix, R35/R36 matrices and R20/R21/R29/R33–37 design/
correction receipts remain failure history, not permissions to weaken tests. The
brief's later reported Ubuntu 75, prior macOS 18, Windows lifecycle 246,
preservation 4 and shard3 361 failures are unaccepted input evidence, not a new
run reproduced here. Attribute each retained failure to the final candidate's
source path; passing a later lane does not prove the historical cause. A handled
startup refusal that prevents a feature's assertion is unavailable coverage,
not a security/feature pass.

## Review decision and this job's evidence

Recommend approval of this single transaction-based candidate, conditional on
explicit acceptance of the stated directory/power-loss product boundary and
coordinated shipping migration cost. Independent design review must specifically
challenge the SQL selection snapshot/restore closure, cached-old-writer exclusion,
and accepted-work transition ordering before implementation. If one cannot be
proved, return one concrete counterexample and revise this design; do not start
another compensating repair sequence or silently remove a supported feature.

Inspected: required rules/footer; main storage/openers/migrations/locks/backup/
restore/read-journal/T3 binding/wake/native contract and artifact; P diff/history
and exact ownership/envelope/runner/remote-operation/bootstrap/catalog/backup
source seams; R20/R21 retention, R29 admission, R33 bootstrap, R34/R35/R36/R37
correction/coupling/Windows proposal, R37 receipt and CI inventory sections;
protected baseline keys and normalization source; primary checkout status and
preserved checkout commit/tree. SQLite primary documentation was read for the
failure model; no current package/VFS binary was executed or inferred from it.

Performed only bounded source/docs/Git reads and this document's diff/commit
checks. **NOT RUN:** implementation, tests, noEmit/typecheck, builds, full suites,
native handles/Workers/helpers, application/daemon/provider/TLS launches, installed
migration/restore, live paired endpoint access, native connector enablement,
release/update. No further agents, Bridge calls, background processes or foreign
PID termination. This job supplies a finite plan and source evidence, not a
passing candidate or an owner verdict.
