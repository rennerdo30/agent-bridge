# MessageStore owner closure proposal — not implementation authorization

Source inventory pin: `9c5f5e608fff35fc37b019ffd963b7624ddc013b`, original base
`7adb4817ea2800e56bd26737a81dbe28d7f17219`. Governing contract:
`DAEMON-LIFECYCLE-PREREQUISITE.md` at approved `2ce8055a58941a1bd90f92d43374e7adc3309be0`.
This proposal complements AB-325 comments 32915/32917. It does not replace their
History/Project/worker inventory or authorize metadata edits.

## Exact proposed fence

Implementation requires `src/core/store.ts`, `src/core/decisions.ts`,
`src/core/history.ts`, `src/core/storage-lock.ts`, `src/core/broker.ts`,
`src/core/daemon-lifecycle.ts`, `src/core/daemon-lifecycle-role.ts`, and new
`test/daemon-store-final-close.test.ts`. Existing role fixtures and the existing
branch-scoped workflow may receive only the necessary invocation.
`src/core/metadata-db.ts` and `test/daemon-metadata-final-close.test.ts` remain
excluded. HistoryBackground/worker, HistoryStore, ProjectStore and metadata final
closure remain separately commissioned owner packages; their current unsupported
observations cannot be converted into release permission here. No CLI, client,
controller, network protocol, domain migration, default-close replacement or pin
refresh belongs to this fence.

## Source facts and required enrollment

| Actual owner/entry point | Current evidence | Proposed supported closure requirement |
| --- | --- | --- |
| MessageStore main/archive/history connections | `store.ts:158–161,204,224–234`; memory mode aliases history to main | Enroll every actual connection separately, group only identical handle objects for one physical close, retain each consumer. Existing file identity remains observational. Memory mode is unsupported for restart. |
| Cached statements and direct writers | `store.ts:187–194,270–306,414–558,578–700` | Guard session/name/seen, insert/batch/once/job delivery, handoff/claim/read acknowledgement, native route mutations, expire/purge and maintenance at source entry and native SQL boundaries. Count synchronous operations and asynchronous continuations, including nested accepted operations. |
| Retry/maintenance producers | `store.ts:355–411,640–681` | Seal new producers without aborting accepted callbacks; drain actual retry promises naturally. Keep accepted bytes, purge cursor and queued archive work on reversible abort. The existing retry counter is only one component. |
| DecisionStore borrowed main connection | `decisions.ts:125–210`; Broker direct calls `1411,1449,1597,768` | Enroll this actual consumer; guard `record/importSync/enqueue/linkSession` and their transaction boundaries. Account for the accepted `enqueue` insert callback. Seal reads before physical close and invalidate the consumer permanently on retirement. No second close of the shared main handle. |
| Main-thread HistoryIndex borrowed history and main/source connections | `history.ts:85–106,118–174,275–286,462–507` | Enroll both actual handles and active directory walk. Guard peer/session writes, tick/reset/wake/discovery and their internal SQL. Track nested read-only source handles through actual close; failed disposal remains unknown. Retain queued discovery/cursors before irreversible retirement. |
| Raw HistoryIndex getters | `history.ts:94–98`; `store.ts:316–317`, `broker.ts:452` | Replace these known managed consumers with source-owned synchronous scoped reads. A legacy/raw `database` or `storageDatabase` escape in the managed instance permanently marks an unenrolled borrower and blocks prepare; normal legacy getter behavior remains available. A callback result must not export handles/statements/cursors. No proxy is claimed to revoke a previously escaped native handle. |
| Broker admission, callbacks and services | handlers `broker.ts:419–498`, seen callback `829–832`, mail routing `1005–1141`, service sinks `668–669`, close `701–731` | Seal dispatch/native registration/connection mutation, timers, disconnect and replacement callbacks before census. Settle accepted handlers and teardown callbacks under original identities. Seal DecisionSync/import and history sinks. Active native routes, network or questions with unsupported continuity refuse; no endParent/orphan recovery to manufacture zero. |
| Store-wide storage lease | `storage-lock.ts:71–84`; `store.ts:204,746` | Capture the exact source-created lease record/nonce/file identity at acquisition. Existing `createdAt` is not a process creation identity or complete census. Bind fresh daemon creation/boot identity before prepare. Retire only this exact lease after every associated handle/consumer is confirmed closed, with matching nonce/identity and actual removal acknowledgement. No stale-lease sweep, foreign lease deletion or default release callback as proof. |

Constructor-time initialization/migration must finish before enrollment can become
ready; failed or unknown initialization blocks. DecisionStore is a consumer, not a
second connection owner. Main-thread HistoryIndex is distinct from the history
worker owners in 32915. Every native handle, active directory/source read and lease
gets an exact source-owned record. Unknown borrowers, escaping raw statements,
changed generations, unresolved handles or undeclared children make the census
unsupported; path equality, public receipt JSON and `transactionsSettled` cannot
prove completeness.

## Reversible PREPARE and private intent provenance

The genuine activated/nonrevoked Broker with its actual MessageStore and canonical
endpoint binding is the minimum issuer dependency. Its private registry enrolls
the exact store consumers, backup/archive/history/project/metadata owners and all
owned process/thread members. Source adapters mint opaque seal/current-witness
records in private maps; public constructors, complete booleans, lists, serving
capability alone and fixture factories cannot mint this census.

PREPARE first seals all managed producers and teardown/open/renewal paths, then
observes accepted work and every actual handle (`isTransaction === false`, actual
FULL, supported main-only attachment inventory, file identity, generation). It
retains resources and takes no close action. All required owner adapters must
support this exact instance/boot/member census; present History/Project unsupported
closure is a blocker. A complete current census is refreshed before intent and
again before final released. Reversible abort resumes only while original
ownership/producers are intact, no handle or permission was irreversibly retired,
and the committed-only intent/abort outcome is proved nonuncertain.

Observation and authorized writer preparation are different stages. The registry
census reads only source-owned records and native transaction properties; it must
not step schema/page-reading SQL on cached writable connections. A read-looking
PRAGMA or `authority:false` label is not a no-effect guarantee: a writable handle
can perform hot-journal recovery while stepping it. Strict actual read-only,
query-only, committed/nonhot observation precedes any separately authorized
checkpoint/writer-preparation SQL. Unknown cold/schema/borrower state blocks proof;
there is no writable probe, implicit recovery or fallback. The metadata observer
under review at comment 32936 is not an accepted dependency.

The canonical issuer then performs the source-owned `release_intent` transaction
for the exact selected receipt/lineage/revision/old actor/generation and verifies
successful COMMIT, autocommit and an independent committed read. Only this source
path mints a private committed-intent permit bound to the census, owner/member
records, exact consumer/handle/lease scope and original deadline. The permit is
single-use; adapters cannot receive a substitute from receipt fields or caller
arguments. Uncertain intent COMMIT retains all seals/ownership and UNKNOWN, even
if a row is readable. It grants neither close nor old-serving resumption.

## One-shot retirement and final qualification

After verified intent, consume the retirement permit before the first irreversible
operation and latch permanent denial of old writes, opens, renewals and election.
Every queued callback and cached consumer must consult that source latch. Attempt
owned walk/source reader disposal, then independently owned history/archive/main
native connections, recording each actual handle as unattempted/attempted/closed/
failed. Invalidate consumers before their handle closes; do not lose cached
statement or failed-handle accounting. Shared handles receive one close only.
Unknown or partial closure retains the exact ledger; it cannot restore an already
invalidated consumer, reopen handles, resume old serving, retry an uncertain close
or use `MessageStore.close()` (which currently aborts retries and releases in
finally) as an alternative.

Release the exact store lease only after all its owned consumers/handles have
confirmed closure. Other owners and their leases must likewise be retired before
the final control-journal transaction. The control journal and its lease stay
explicitly separate. The final SQL permit is consumed before its single attempt;
there is no subsequent explicit old SQL, rollback, failure-row write or new permit.
Persisted `released` includes the actual closed ledger; last-control-tail failure
remains explicit, never an all-handles-closed assertion.

Successor eligibility still requires the approved strict RO/nonhot observation,
exact old daemon AND every declared child-writer exit with creation/boot/member
proof, checkpoint/lease reconciliation, tentative bind, same-held current CAS and
its OWN successful COMMIT/autocommit/independent committed observation. Neither a
close return, absent PID, released JSON, lock acquisition nor parent exit replaces
that sequence. There is no silent generation revival after reboot.

All checkpoint/close work shares the original 2-second phase within the 10-second
operation; lock waits clamp to remaining budget. Synchronous native calls are not
cancellable. A late return or partial-close overrun is UNKNOWN without revival;
the final journal COMMIT uses the note's separate issuance gate and successful
verified late outcome is explicitly `released(late)`, never timely completion.

## Smallest ordered implementation packages and evidence

1. **Store consumer closure:** this fence's store/decision/history/storage-lease
   adapters plus Broker enrollment/seal integration. Actual supported PREPARE for
   this facet, permanent consumer guards and retained per-handle ledger; no claim
   of whole-Broker census while companion owners remain unsupported.
2. **Companion owners:** separately reviewed metadata final-close and 32915
   History/Project/worker release-ACK packages, with all nested migration/snapshot
   ownership proved or naturally completed. These provide real supported preflight
   and exact closure observations, not existing diagnostic `workSettled` alone.
3. **Canonical issuer and retirement:** connect these actual current owner proofs
   to committed-intent permits and the one-shot final journal permit. Enable this
   supported closure path only when ALL required adapters support the complete
   census; then actual store/worker/lease closure and final released can be tested.
   Controller/CLI orchestration remains its own later package.

Fixtures use actual owned SQLite handles, native workers and leases. Preserve
accepted mail/decision/history bytes through pending retries, active directory
walks, stale witnesses, raw getter escape, active transactions, unsupported
attachments and busy checkpoints. Exercise genuine committed intent and separate
explicitly SIMULATED close throws before/after actual native close, a failure after
one successful close, real deadline overrun, lease mismatch/removal failure and
cached callback attempts after retirement. Require exact attempted/closed/failed/
unattempted counts, no duplicate close, no revival and no release proof on unknown.
Fault injections are not VFS/power-loss evidence. Positive final-close fixtures
must use the real canonical issuer and complete supported owner set; there is no
test mint. Execute the frozen packages automatically on all six hosted targets,
with independent source reviews between boundaries. No local runtime validation.
