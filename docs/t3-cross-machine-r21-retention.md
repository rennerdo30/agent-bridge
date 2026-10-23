# R21 retention and admission correction

Source base: `80e16783ea1f6090811999ab671d0871ed403a38` (same production
code as03ef; approved flaky evidence integration retained byte-for-byte).
This is source/mock evidence, not native acceptance or a release.

## Observed failures and effects

| Boundary | Required evidence / corrected behavior |
| --- | --- |
| Queued control acceptance | Capture one immutable batch UUID, original bodies/CIDs and runner generation before ACK; append successors, never replace an executing batch |
| Provider admission | Select exact pending batch IDs after predecessor retention; consume only those queue entries after awaits; later controls remain pending |
| Provider completion | Persist exact selected batch IDs with result body/UUID/status and admission context; transactional original and completion archives plus exact per-batch proof before next admission |
| Retry / cancellation / restart | No second provider admission for an unconfirmed batch; retain all accepted batches; owned dead-generation recovery quarantines exact originals as evidence without replay |
| Remote cache read | Distinguish proven absence from malformed/oversized/unknown/nonregular data and retained corruption; bounded read-only inspection never moves bytes or guesses ownership |
| Preclaim / normal start / spec publication | Strict cache inspection independent of missing registry `remote`; unknown original operations cannot consume queued input or reset a spec |
| Live executor observation | Verify original spec/principal/namespace/generation and item evidence; report running/undelivered without a staged final; never run dead-generation recovery on valid live work |
| Dead / malformed executor observation | Existing fail-closed recovery boundary remains; no fabricated done, receipt or automatic new execution |
| Malformed send response | Missing `messages` is unknown delivery, not success; retain accepted UUID/body/intent and hold dependent final |

Input batches are append-only within one runner generation, capped at128 and
8MiB. Payload identity is immutable across phase changes. The root phase/body
fields are a conservative compatibility projection; proof and execution select
immutable batches, never that mutable projection. Legacy single-batch originals
stay exact and cannot be silently replaced by the new format. Archive inspection
still uses the existing64-record/8MiB/25ms boundary; exceeding it blocks with
retained originals for explicit owner recovery, rather than skipping evidence.

Remote cache inspection caps the directory census at256 entries, data at8MiB and
inspection at25ms, verifies descriptor/path identity and refuses retained corrupt
copies even when the current path is missing. These names identify evidence to
quarantine, never authority to execute or ownership to attribute. Empty/settled
valid caches remain admissible. No automatic repair, deletion or replay exists.

## Approved compatibility contract

The red regressions are also an older-writer bypass proof. Intermediate80e
advertises local protocol7 and metadata component2, but its
`RemoteJobHost.read` calls tolerant `readJsonStore`, which renames malformed
accepted-operation evidence and returns null. Its normal `JobRunners` preclaim
guard then admits a next turn even with the registry's remote projection absent.
The new strict reader cannot make that already-running component2 writer
cooperate. Its cached metadata handle can exist before presence/endpoint
registration, the same exclusion limit previously proved for component1.

Parent approved this coherent source-only gate on2026-10-23 (AB-458 comment42990):

- local protocol8, with exact symmetric refusal and p7 prior-endpoint probing;
- metadata component3, with component1 AND component2 automatic shared-home
  upgrades refused before mutation; explicit named isolated offline admission
  preserves originals/backups and common-lock exclusion;
- replace runner-ledger-v1 with runner-ledger-v2 in the existing additional
  capability array, both request/result directions, persisted operation/reconnect
  and execution admission paths; no array growth or old-runner fallback;
- pairing1, mailbox schema14, JSON4 and recipient/native/mailbox ownership
  capabilities stay unchanged. All intermediate branch versions are unreleased.

Shipping v0.30.4/v0.30.32 metadata1 impact remains the already approved offline
boundary. Component2 is unreleased but cannot be assumed inactive or lease-safe.
Endpoint probes and the common lock are necessary, not proof an inactive cached
older writer is gone. No installed migration, copy/split/update or termination is
authorized. The approval authorizes source changes only; fresh independent review and hosted CI remain mandatory.

## Qualified red and working evidence

- Unchanged80e production plus initial overlap regression: PID78832,60s,exit1;
  complete history fails archive admission after C2 replaced executing C1.
- Unchanged80e production plus corrected damaged-cache fixtures: PID14004,60s,
  exit1,two unsafe preclaim admissions. An earlier first attempt had a fixture
  directory-read error; it is not cache-bypass evidence. Later fixtures use the
  canonical eight-hex remote job ID; no claim final test text is identical.
- Working projection-disabled mutation: PID44872,60s,exit1,two live input/note
  cases take dead-generation recovery. Restoring the guarded projection passes.
- Working results are not exact-head validation. One continuity fixture attempt
  omitted its broker jobsPath; another completed assertions but lacked mock
  socket.destroy during teardown. Those failed receipts remain failures; neither
  is classified as a new production cause.

Working proof/CI selection PID40752:7passed,2negative assertions used the wrong error wrapper and failed; both now assert the exact invalid-evidence code. Corrected live ownership negatives PID75840:2passed,exit0. Continuity and transactional completion-proof assertions passed in PID40752; failed working evidence is retained. Working typecheck PID38168 found one test-only implicit parameter type, corrected before freeze.

Exact frozen head/tree, complete changed-file inventory, launch PIDs, exits and
raw log paths will be in `E:/AgentData/reports/ab458-pr141-<head>-r21-*.json`.
Raw published logs begin with the tested commit header. No full local suite,
native/provider/TLS/daemon process, build, install, release or delegation ran.

## Complete80e CI root matrix

| Case / evidence | Classification and concrete action | Limit |
| --- | --- | --- |
| Ubuntu120167605457 / Mac120167605431 / Win3 completion-dedup | Fixture injects state failure at initial admission; move it to callback stage, retain initial unknown-state refusal regression | No production guard weakening |
| Continuity final main2 vs main3, also Win1 | Fake send bypasses persisted local succession; use actual store grants and broker reroute, retaining main2 wire intent and exact main3 final copy | Actual grant/retained-copy assertions pass working; frozen-head receipt required |
| network TLS95/112, all OSes incl Win4 | Remote-job extension fixtures omit required ledger capability; advertise it in bounded additional array, preserve old hello and missing-cap negatives | TLS run remains CI-only |
| Provider-admission two cases | Mock omits required SendResult.messages; mint valid mock result; malformed response now separately retains original pending evidence | No malformed response accepted |
| Remote approval expired, Ubuntu/Mac/Win5 | Exact cause UNPROVEN; add bounded requester deadline/RPC and executor lookup/relay categories, retain original answered/expired assertions and clock | No timeout increase or blind rerun |
| Current store capability publication | Expected current metadata capability absent; use canonical version, keep internal-authority nonoverwrite/public-stripping assertions | No authority exposure |
| Mac closed-primary takeover codex-job-ad5014a7 | Exited without delivered/stored final; correlation with ledger changes UNPROVEN; retain bounded per-batch/admission/result counts in existing diagnostics | Ten jobs/exactly-once/deadline unchanged; native CI required |
| Win3 detached approval/plain messages | Done can be a staged first result before continuation; wait original new-control acceptance before explicit decide and delivered terminal result, keep exact two provider calls and no plain-mail extra turn | Native fixture CI-only |
| Win3 quiet fake-Claude observer | Published session remains null; exact cause UNPROVEN; retain original identity/poll and add bounded response-category/hook-publication evidence | No session substitution or hidden notification discard |
| Win1 job-admission teardown EPERM | Fixture uses current test PID, no launched runner; new real admission opens shared metadata handle, cancelAll is not close; close owned metadata before async owned-home removal | Do not infer foreign process/kill or suppress cleanup errors |
| Win5 two blocking remote asks | Real reproducible path attempts recovery on valid live evidence; verify owned live ledger and project running without terminal report | Exact original CI snapshots unavailable; not a claim all platform failures share this cause |

All13 protected method pins, UI, normalizer, retention guard and the approved
known-flaky candidate files remain unchanged. Fresh complete independent review
and hosted full/lifecycle/native acceptance remain mandatory.

## Compatibility and mutation matrix

| Reader/writer | Admission |
| --- | --- |
| Fresh home / protocol8 / metadata3 / ledger-v2 | Initialize current component directly; typed original evidence required |
| p7 or earlier local client/broker | Exact symmetric refusal before registration/mailbox effects; prior p7 endpoints included in read-only startup probes |
| Existing metadata1 or2, automatic shared-home start | Refuse before PRAGMA/schema/backup/spec reset; bytes remain original |
| Explicit named offline-isolated fixture/operator admission | Common-lock reader exclusion, verified additive backup, atomic component3; interruption preserves originals; repeat/reopen idempotent |
| v1-only or missing remote runner capability | No spawn/ask/continuation/control/result/receipt effects in either direction; original pending identities stay unknown, no fallback |
| Capability lost after dispatch/reconnect | Reject in-flight reply/retry before acknowledgement or execution; do not automatically reexecute unknown accepted work |
| Valid live original ledger | Read-only running/undelivered projection; no staged final/result escape, no dead recovery |
| Wrong namespace/principal/generation, malformed cache or retained corrupt proof | Refuse without spec reset, owner attribution, input consumption or provider admission |

Protocol/presence checks cannot force an already running cached older writer to
cooperate. An isolated offline migration is an explicit owner attestation, never
inferred from absent endpoints and never a runtime environment bypass. Unsupported
old binaries reopening a shared home remain an operator coordination limit.

Batch input completion archives the entire original and completion state with
same-transaction proof. Injected proof-insert failure rolls back state, both
archives and proof; changed result-source bytes fail archive admission. Cancellation
preserves consumed result context and queued input, with owned dead-generation
evidence-only recovery and no provider replay. All original row/body/UUID/namespace
and proof bytes remain in active state, append-only archives or owned quarantine.
No persistent data is deleted.

Approval42990 is source-only. The final validation receipt supplies the exact
source/tree and complete file inventory for parent correction review. No new
protected-method body, UI source, normalizer, baseline hash or flaky selector/date
was changed in R21.

The final audit also proved a restored-remote early-return bypass on7e5b104:
`job.remote` skipped the local spec/admission path, allowing a component1/2 cache
write and dispatch. PID44068 (60s,exit1) shows both unsafe admissions on unchanged
7e5 production. Remote host admission and every cache writer now require current
metadata after strict operation inspection, including direct start and restored
normal JobRunners.start; no cache/job/metadata change is allowed on refusal. This
is a correction within the same approved8/3/v2 contract, not a further version.
The7e5 receipt remains valid for that earlier head only; the final receipt must
name the correcting head and qualification explicitly.
