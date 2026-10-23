# AB-458 R20: ordered runner retention and compatibility

Implementation base: `b2066633584490360c4b722b916c19d0bd77246b`, existing PR141,
branch `t3/fix-t3-cross-pc-messaging`. This supersedes the unchanged-gate and
direct-runner recovery conclusions in the R19 receipt. Parent approvals are
recorded in AB-458 comments 42897/42935 and the owner conversation on 2026-10-23.
Independent review and hosted full/native/lifecycle acceptance remain required.

## Final contract

Local Core protocol **7**, metadata component **2**, explicit local
`storeCapabilities.metadata=2`, and remote **`remote-runner-ledger-v1`** form one
batched contract. Mailbox SQLite schema stays **14**, JSON format stays **4**,
pairing/network version stays **1**, and `recipientOwnershipV1`,
`nativeOwnershipV1`, `mailboxProvenanceV1` remain unchanged. Protocol6/b206 and
earlier branch gates are unreleased intermediate states, not shipped protocols.

`deliveryLedger` captures original UUID/key, full original and wire bodies,
recipient intent, sender, job principal, runner incarnation and persistent store
namespace before queue admission returns. Later accepted notes and the final
cannot vanish behind a failed predecessor. Limits are 128 ordinary items with
reserved terminal capacity, 8MiB of captured item records, and a bounded input
queue. Backpressure refuses an unaccepted item; an incoming control stays unread
in its existing owned mailbox. A storage failure cannot manufacture durability:
the runner retains its owned in-memory items and reports unsettled failure.

The namespace is an authoritative identity row, restored with the metadata;
the per-archive index is only a derived accelerator. Removing or changing a
namespace, proof or referenced original does not establish a new owner.

## Acceptance and effect boundaries

| Path | Required boundary | Failure / cancellation |
| --- | --- | --- |
| Note, answer, question, approval notice | Capture exact item before entering the ordered queue | Rejected callback promises remain observed by the owned queue; failure is latched, not catch-to-success |
| A refused note | Durable pending item, joined async write, exact content/inode/path validation, synchronous confirmation callback | Six bounded attempts / 3.1s backoff; active write is joined; exhaustion/shutdown remains explicitly unsettled |
| Successor notes and final | All accepted items are already captured; drain predecessor barrier before dispatch or receipt probe | No later dispatch, final settlement, fallback or successful drain while retention is unresolved |
| Queued control | Exact CID/body retained before mailbox ACK | Failed confirmation leaves control unread; repeated CID does not append/execute twice |
| New provider turn | Drain, retain input, admit it, drain report notice, recheck cancellation; record provider admission | Admission is not completion. Crash after admission retains unconfirmed input; recovery never replays it |
| Provider result | Store complete result/UUID with input completion | An admitted input is only marked consumed when its result is retained; original input remains archived |
| State ledger removal | Original state archive and append-only retained proof in the same transaction as the active-state update | Failure rolls back archive/proof/update together; existing UUID bytes, namespace and incarnation cannot be replaced |
| Actual `JobRunners.start/startAsync` and `publishRunnerSpec` | Check current pending state and bounded archive proofs before reset/publication | Recovery confirms original evidence only, then refuses this new start; no launch, registration, new recipient or new UUID |
| JobManager registry claim | Strict runner/archive admission before and inside the registry lock, before consuming queued input or changing generation | Missing/unproven state is not converted into a new turn through the convenience reader's null fallback |
| Dead-runner recovery | Original durable spec, job incarnation, store namespace, liveness/current-owner callback and state CAS | Changed owner/spec/namespace, live/unknown runner, malformed evidence or racing writer refuses; no guessing |
| Session fallback / hosted settlement | Keep original final pending while any runner barrier exists | Tracked evidence-only recovery may progress; only the original result can subsequently settle |
| Remote executor observation / continuation | Same authenticated remote job owner; pending runner evidence cannot be stripped into a terminal snapshot | Refuse observation/continuation until execution-host evidence is retained |
| Remote operation | Persist exact local request identity/body before dispatch; require runner-ledger capability on request/result paths | Missing/dropped capability and unknown dispatched spawn remain retained/unconfirmed across requester restart; no automatic reexecution, status settlement or fallback |

Ordinary send failures retain existing retry behavior. Retention barriers are a
separate failure class. Evidence-only quarantine is not an outgoing envelope,
delivery receipt, read/ACK grant, or permission to address a replacement owner.

## Archives, original data and recovery limits

Every removed ledger item retains its complete original state in
`bridge_metadata/job-state-archive`. `runner-retention-proof` records the
original archive key/digest, item digest/UUID, namespace, principal and
incarnation in the same transaction. `runner-retention-index` is revalidated
against those originals; index presence alone never resolves work. Consistent
metadata snapshots include all these domains and the namespace in the same
`bridge_metadata` table. They are component snapshots, not full mailbox restores.

An archive census includes referenced proof originals (64 records / 8MiB / 25ms)
and older unprojected runner file archives (128 directory entries / 8MiB / 25ms).
Async start admission yields before the bounded final census. A budget limit,
changed file, malformed/incomplete record or unresolved b206 archive blocks new
turns with a recovery diagnostic. It is not skipped or considered empty.
Unknown historical ownership is preserved, not reconstructed. Namespace loss,
unprovable b206 records and oversized histories may therefore need a separate
owner-approved offline recovery procedure; this patch does not invent one.

Quarantine publication refuses links/junctions, hard-linked leaves, same-size
different content, and directory/leaf substitution across awaits. It verifies
full bytes and the original directory/inode identities before confirmation.
Only the exact private temporary inode is eligible for existing temp cleanup;
foreign conflicts and published evidence stay intact. Accepted bytes also remain
in the transactional original archive, independently of the quarantine path.
This is not protection against an OS-account owner maliciously rewriting files.

## Compatibility matrix and source proof

| Combination | Admission |
| --- | --- |
| Old local protocol2–6 client → protocol7 broker | Symmetric exact-auth refusal before registration/mailbox effects |
| Protocol7 client → old local broker | Current-protocol auth only; no hello/downgrade/handover/replacement |
| Prior p2–p6 / canonical endpoint active or indeterminate | Fail closed before startup/migration; absent/stale transport is not exclusion proof |
| Common maintenance lock vs active lease-aware writer | Excludes that active lease; recheck reader capabilities under the lock before snapshots/DDL |
| Component1 → component2 shared home | Automatic upgrade refused before snapshot/schema/spec reset |
| Explicit offline-isolated component1 admission | Named home and owner attestation; common-lock/capability checks, backup-first additive transaction; originals retained |
| New home / admitted component2 home | Normal admission, explicit metadata capability |
| New requester → old executor, or old requester → new executor | Require remote runner-ledger capability before execution/control/result effects |
| Capability drops after dispatch/reconnect | No result acknowledgement or automatic retry of unknown work; original operation remains retained |
| Compatible peers, cancellation during owned in-flight spawn | Cancellation remains available; only an unknown/restarted operation is blocked |

`metadataDb` component1 cached handles bypass cold version checks; old runner
startup has a window between initial state publication and node/presence
registration. The common lock excludes active lease-aware writes, not that
inactive cached writer. Protocol7 plus the lock is necessary and **insufficient**.
No version number forces an already running old process to cooperate.

This affects actual shipping data homes, not just branch fixtures:
`v0.30.4:src/core/metadata-db.ts` and `v0.30.32` (tag commit
`d7ab50594f5d1d08b87fc754f81f1f7d2fc30a80`) both declare component version1.
The criterion is the source store's component version, not a guessed app version.
Automatic startup cannot supply offline admission. The owner must coordinate
shutdown and an explicitly isolated destination, retain the complete originals
and backups, and authorize the offline admission API for that home. There is no
environment flag, automatic copy/split/delete, installed migration or updater.
Unsupported pre-lease binaries reopening later stores remain a coordinated
upgrade limitation. The explicit offline contract is an operator attestation,
not a claim that software can prove all old binaries stopped.

The remote capability uses the existing additional hello array; the shipped
eight-entry primary list and pairing version are unchanged. All remote job RPC
operations/results are gated, including approval/ask/control and continuation.
Ordinary per-copy mailbox read receipts retain their separately proven
ownership/namespace protocol; they are not remote execution acknowledgements.
Blocked remote operations retain local request bytes and IDs with explicit
recovery diagnostics. Automatic read-only polling is also stopped for an unknown
operation, since a display name alone cannot prove the original execution host.
An owner-approved remote recovery workflow remains follow-up work.

Relevant older test boundaries now advertise the actual new metadata/runner
capabilities. Legacy native profile/usage projections remain independent of
binary compatibility; they do not authorize dispatch to a b206 executor. The
fallback regression mints its principal/namespace from the actual registered
job/store and confirms a real quarantine write before clearing active evidence.

## Evidence and remaining CI classification

Initial regressions on unchanged b206 production: wrapper62392 / PID28604,
60s bound, exit1, five failures. They exposed missing successor capture,
continuation bypass, actual start/spec reset bypass, same-size content reuse and
junction following. Final fixtures add canonical spec/namespace seeding and
recovery checks; the initial red receipt does not claim that final test text was
identical on base. Working results and exact frozen receipts are distinguished.

| CI case | Classification / patch | Qualification |
| --- | --- | --- |
| Startup live-reader re-verification (Ubuntu/Mac/Windows) | Real early state-read ordering regression; check moved to actual guarded writer | Original re-verification count/effect order retained; valid late reader now explicitly advertises metadata2 |
| `conversations.test` no-project idle writes | Confounded fixture metric: `total_changes()` includes checked/cursor/mirror work subject to tick deadlines | Observe actual resolver calls and scoped project writes over five idle intervals; exact cause of CI's 25→23 change remains unproven; changed native fixture is CI-only |
| Background re-election Windows timeout | No production cause proven | Add bounded allowlisted stage/state diagnostics, preserve 8s limit and retry/join assertions; CI-only |
| Previous ten-runner takeover, fairness, quiet hooks, HTTP startup | Runtime causes remain unproven by this patch | No timeout, provider count, expected result, ownership gate or native acceptance relaxed |

All13 protected method pins, the UI hash, normalizer and retention guard are
unchanged; no pin amendment is requested. No provider, daemon, TLS fixture, full
local suite, build, install, release, Bridge call or further agent was run.
Exact frozen validation/push receipts are external:
`E:/AgentData/reports/ab458-pr141-<head>-r20-validation*.json` and `-r20-push.json`.
The first freeze `284d852c` recorded 83 passes and one local-selection error:
the legacy Muse wire-profile test intentionally executes a fake CLI script,
which the subprocess guard blocked (three attempts, no process launched).
That failed receipt remains retained; it is not production red evidence. The
fake-CLI integration case stays intact and CI-only. Corrected local selection
includes only its in-process request-argument case. A subsequent docs-only
commit records this qualification; its own exact head is validated separately.
