# Guarded cold bootstrap contract (R33)

Source base c86286f32f05457f0ed008a51937b6ee54e47be8. Parent source-only
approval,2026-10-23: one existing outer10s startup deadline; cold preparation
then a genuinely fresh final guard/open capped at min(2s,outerremaining).
No fixture prewarming, installed migration/update or release is authorized.

## Evidence, not a clock-source guarantee

Exact Windows lifecycle120298654727/run39918782512 lines871/887:

|Elapsed|Identity/endpoints/readers|Synchronous effect|Preceding constructor spans|
|---|---|---|---|
|2167ms|0/1/0ms|2166ms,pending|leases301; main-schema909; main-configure419; archive not entered beyond its first deadline check|
|3195ms|0/2/0ms|3193ms,pending|leases878; main-schema2315; overlay at first check|

These are c862 **wall-clock** observations, not retrospectively monotonic
measurements. No clock correction is established historically. The recorded
constructor critical path is the source of the architecture proposal; blaming
cold process identity contradicts these observations. R32 AB45843068 separately
requires monotonic *diagnostic durations*, without changing Date-based policy.

Backup line738 is separate:elapsed2010,pendingWorkers1,connected=true,exit
pending,all outcome counters0,unknown=false. It does not locate time inside
worker initialization/capture/verification and is not evidence of completed
backup or permission to stop the worker.

## Intended effect/admission boundaries

1. Create one startup deadline at the actual election/daemon entry. Discovery,
   preparation, cleanup qualification and final proof share it. Child creation
   must receive a tightening deadline; an absent caller deadline cannot extend
   an already-created attempt. Expiry/stop closes only the exact owned client,
   reservation and worker. No readiness, registration or request replay before
   the final admitted store. Existing denied discovery never becomes creation.
2. Read-only eligibility: canonical physical home/file identities, regular
   unlinked paths, bounded original reader/endpoint census. Component1/2 and
   schema2/3 still refuse automatic shared-home migration. Unknown/future
   versions, changed paths, incomplete prior preparation or unknown owners
   refuse. Fresh/current-compatible preparation does not rewrite completed
   schemas or broaden ordinary migrations. Existing populated stores retain
   original backup-first migration and metadata import semantics.
3. One worker owns all preparation SQLite handles; no handle is transferred to
   the parent. It executes the actual versioned initializer under a bounded
   fresh proof and common maintenance exclusion. A scope-bound *borrow* of its
   exact maintenance nonce lets nested existing initializer locks participate;
   nested release never removes the outer lock. This is not a home-global
   bypass, foreign PID exemption or transferable approval. All reader guards
   and exclusion checks still run at effects.
4. Before SQLite effects, append and fsync an exclusive preparation record
   containing attempt nonce, original process/thread incarnation, canonical
   home/file identities and exact schema/component contract. No token, payload,
   prompt or ownership inference. States are immutable evidence records:
   `preparing`, `prepared` (only after owned handles close), `exited` (parent
   observed the exact worker's clean exit and checked the prepared digest).
   Interrupted is an incomplete group, not a new post-revocation write.
   Never overwrite/delete prior records. Unknown/unclosed/partial preparation
   blocks new execution; it cannot be treated as absence or retried as a new
   generation. Prepared is only initialization evidence, never mailbox authority.
5. The parent revokes an owned shared cancellation cell at deadline/stop before
   requesting termination of that exact worker. Every later synchronous phase
   checks the same original deadline and revocation. A native operation already
   in progress cannot be preempted by JavaScript: its possible completed effects
   remain original retained evidence, not admitted success. The owner waits for
   exact worker exit/handle cleanup, records late/unknown exit, and admits no
   work while cleanup remains pending. No orphan, foreign/shared worker kill,
   automatic unknown reexecution or fabricated no-effects claim.
6. A successful IPC is insufficient. Match attempt/home/file identity and
   durable prepared state plus exact clean worker exit. Release only the owned
   exclusion. Then acquire a **new**, nonescaping endpoint+census+constructor
   proof under min(2s,outerremaining); an endpoint/reader joining meanwhile
   blocks admission. The initial proof or prepared record cannot authorize it.

The new record is an initialization ledger, not job/mail/runner authority.
Pairing1/schema14/JSON4/metadata3/protocol8/runner-ledger-v2 remain unchanged only
if the implementation audit establishes that older writers cannot defeat the
new boundary. Any demonstrated exception returns to the parent before a gate
change. Cached old component1/2 and pre-lease schema2/3 refusals remain mandatory.

## Verification and review still required

Before acceptance: controlled production-worker boundary with no native worker
launch locally; preparation>2s but<outer and fresh final success; outer expiry,
stop during cold start/native phase, late IPC/exit, foreign/duplicate result,
incompatible join after preparation, original populated schema untouched,
crash/partial/prepared restart without duplicate DDL, exact originals/backups
retained. Assert no request, registration, listener activation or provider call
before final proof. Record all phases and total startup budget. Pin deltas require
exact frozen method review before baseline amendment; hosted full/lifecycle/native
gates and independent full design/correction review remain parent-owned.

This design is not a claim the implementation or Windows availability has passed.

## Current source and evidence qualifications

Only an all-absent three-database home or a metadata3-only/schema0 home with
absent archive/history enters preparation. Fully populated stores take the
ordinary final opener; partial schema14 without complete preparation evidence
refuses. Preparation uses the existing backup-first initializer, not a second
DDL implementation. An existing completed ledger permits a fresh final open,
never a repeated preparation. Inode-changing restore, missing ledger records,
more than 48 records, corrupt/changed records and uncertain exit require owner
recovery. No record is deleted or attributed to a new process/thread.

The common maintenance lock and nonescaping exact-nonce borrow exclude
cooperating writers during the synchronous initializer. They do not prove an
unsupported cached old writer has disappeared: component1/2 and pre-lease
schema2/3 automatic-upgrade refusal remains unchanged. The preparation record
does not authorize any changed mailbox, runner or wire semantics. No version
increment or automatic isolated-home copy is included.

The owned worker is revoked before termination on stop/expiry. A synchronous
native operation may finish before termination is acknowledged; later phases
must check revocation and cannot become admitted success. Cleanup may outlast
the admission deadline; this is retained/unsettled cleanup, never a widened
startup or successful readiness. No provider/listener/service runs in that
worker. Local fixtures use an explicit fake Worker transport invoking the real
initializer, guard, maintenance exclusion and journal; actual worker startup and
Windows cost remain hosted-CI gates. The source path requires the ordinary
CI-built worker entry and never builds or starts a fallback locally.

Backup progress is bounded, nonce-validated, monotonic telemetry only: it cannot
settle a worker, prove a backup, release ownership or grant cleanup. The previous
2010ms pending-worker cause remains unproven. Failure-only CI evidence can now
separate worker entry/pressure pause/checkpoint yield/result/exit stages.

The partial-marker content unit fixture now explicitly schedules observations
after its empty/partial/full writes. Real host/deadline fixtures retain fs.watch.
This removes an event-per-write assumption from the content test, without
establishing the historical Mac event schedule. The shutdown backstop retains
its original production deadline and remains active during suspended cleanup;
normal ordered completion cancels only that owned timer before normal exit.

## Exact c862 residual matrix

|Evidence|Affected cases|Classification and retained acceptance|
|---|---|---|
|Windows lifecycle120298654727, 3 failed/386 passed/6 skipped|Ambiguous creation latch; authenticated discovery refusal; backup completion pressure|First two fail before their assertions at constructor phases above. Architecture candidate requires CI availability proof. Backup pending/connected/exit-pending is a separate unresolved cause; original 2s, bytes and no-premature-kill assertions retained.|
|Mac120298654987, 1 failed/4420 passed/133 skipped|MSP complete partial-write marker|Content/observer handshake; historical cause unproven; controlled file observations keep complete-content assertion, real host paths unchanged.|
|Windows120300315312, 3 failed/703 passed/3 skipped|Recovery-first hello reservation; failed recovery release; cancelled recovery versus new runner|Constructor budget before registration assertions, not proof of a new hello race.|
|Windows120300315295, 2 failed/622 passed/9 skipped; fast253 passed|Preferred-drive diagnostics; minimal-array recovery feed|Constructor admission before scenario assertions. Secondary jobs teardown called undefined manager after failed setup; fixture now cleans only a successfully constructed current manager and preserves the primary error.|
|Windows120300315381, 8 failed/686 passed/6 skipped plus 1 unhandled|Atomic remote-descendant rejection; child ask_codex/spawn_opencode/ask_opencode/spawn_antigravity; parent handlers livechild true/false; unscoped livechild|All eight expire at archive/history/overlay before security assertions. Coverage unknown due separate unhandled process.exit from MCP shutdown backstop. Preserve all security assertions and production shutdown deadline; cancel only the completed fixture's owned normal-shutdown timer.|

Exact official lifecycle artifact12486866874 (run39918782512), retained under
`E:/AgentData/reports/ab458-c862-windows-lifecycle-artifact`, has605 files:
601 bundle files, SOURCE_HEAD, manifest and two unrelated diagnostic JSONs.
The download ZIP SHA256 is
`59dc73fd8bffda1c81cfe40db63387bcc05e055894c02f246ad32ad0e248e9a6`.
No raw backup state or bootstrap phase JSON is in that inventory. Only named
public diagnostics, file inventory and exact job-log phases were inspected;
no credential/config harvesting. Prior takeover, fairness, alias disconnect,
quiet observer and UI500 causes retain their earlier unproven qualifications.
Passing a later platform run cannot establish those earlier causes.
