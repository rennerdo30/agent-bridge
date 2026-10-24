# AB-458 slice three: accepted runner work and remote operations

WIP implementation record. Design `24a650e1fda1d10b9cb99d9495e0c815d23c9cd9`
remains unchanged. Parent coordinates and reviews. This candidate is not integrated;
PR141 `c94cf75602c53e7949d68066071c2b05f11df986` and its writer remain untouched.
Slice four, native/private port, real providers, hosted/platform/lifecycle and
two-PC acceptance remain pending.

## Starting identities and prerequisite gates

- Original M: `5e3fa8aa17d22d57cb5d24549c16381c5843edeb`.
- Reviewed slice-two source: `870a9adea0931d9225e049a6d9420b8e024cb9b1`,
  tree `b7c5ee6d9beaa02691befb9106901ca8815cc4bc`; receipt `2dc0055ec2a3a3b07ffb1f5e8b414bee06937cab`.
- Separate P3 receipt correction: `27c11c9e7f73c1e2134708dae1a41ce98c0ee95f`.
  Historical inventory and logs were not rewritten. The old 183-entry inventory
  matched 181 entries; two live assembler logs were recorded before sealing.
  `.agent-bridge-test/slice3/slice2-receipt-correction.json` records the closed
  logs' actual hashes and separately qualifies four inherited checkout/EOL byte
  hashes; those are not canonical Git blob byte hashes.
- Separate approved three-pin commit/effective pre-slice-three base:
  `09727143ff8568eba30967e7b39abf0edb9cad03`,
  tree `474debd221a32d4b6d3ee2a80594203d00b06835`.
  Its `src` tree `86d0d91da04b26402ca2ba913b9d455bac45598a` is exactly the
  reviewed source's `src` tree. Baseline SHA256 after the approved amendment is
  `a60fbdccc5581c2157ddf3b1e7d218f095d23754fce8ca4398fa848d2a4331f1`.
- Exact anchored default-control-flow pin gate: PID21364, wrapper68320,
  2026-10-24 16:21:51.299–16:21:54.413 JST, external60s, exit0,
  exactly one executed/pass test and eighteen skipped. Node26.4.0. No noEmit
  for the JSON-only amendment. Raw headers/logs and baseline-only patch are in
  `.agent-bridge-test/slice3-pin/`; this qualifies source/pins only.

All prior red/green freezes and their qualifications remain as recorded in
`docs/t3-messaging-convergence-slice1.md` and `docs/t3-messaging-convergence-slice2.md`.
The historical slice-two 71 and slice-one141 runs belong to 870a, not a later
slice-three source. No slice-three validation has run at this audit freeze.

## Read-only assumption and selective extraction audit

Read the complete reviewed design via exact `git show`; rechecked the runner
contract, extraction map, slice-three scope and protected gates before source edits.
Current history includes AB400 durable finals and AB449 unknown liveness. P history
was inspected by file and symbol; no mixed commit is selected for cherry-pick.

| Reference history | Selected symbols/hunks | Adaptation required here |
| --- | --- | --- |
| `485b4173`, `b2066633`, `284d852c`, `990584ed`, design reference `03ef1b16` | `job-runner` prepare/capture, ordered drain, input batches, provider admission, final barrier, cleanup; `runner-delivery-retention` types/validation | Keep every accepted successor even when a predecessor refuses; replace external quarantine confirmation with a metadata transaction; bind actual live/provider effects, not just outer runner entry. |
| Same runner history | `runner-store` state CAS/stamp, strict retained reads, archive-before-removal, spec publication/start fences; `runner-retention-index` originals/proofs | Keep M ordinary SQLite and copy-before-removal. Verify exact original/proof/reference digests in bounded per-job windows; no index-only permission and no automatic replay. Missing/corrupt evidence is unresolved. |
| `990584ed` | `runner-ledger-recovery`, job-host initial publication/start and jobs registry claim/preclaim/settlement | Recovery is evidence-only; no new PID/provider or reconstructed message. Guard actual reset/archive before effects, including missing registry.remote. |
| `990584ed`, `56edc4b6`, `003199e3`, `2006221c`, `1b437a33`, `0c3a02db` | strict `remote-operation-evidence`; `remote-job-host` exact request/operation state; registered `RemoteJobs.receive/handle` original queued cancellation | Retain host/principal/return route and independent operation tokens. A duplicate/foreign/replacement rejection cannot abort the live original or invent death. Preserve slice-two exact pair/supervisor proof. |
| P `job-run-index`, `job-archive-index`, `local-result-receipts`, `delivery-evidence`, `final-result`, `remote-job-protocol`, broker/link integration diffs | Only retained proof, original route/owner read, ledger-v2 and affected integration hunks | Preserve current startup/family guards, owner semantics, ordinary retry/usage policies, retention selection and all defaults. No broad P files or bootstrap coupling. |

Named new modules in the design are allowed, but P's external quarantine dependency
is not a selected authority. Full original/state archive plus exact digest proof and
active-state transition must share the existing metadata transaction. No new home
journal, publication authority, worker or directory durability claim is introduced.

## Acceptance and effect callgraph (pre-edit audit)

The table distinguishes acceptance, ordinary effects, required recovery, cleanup
and unknown settlement. A read observation never substitutes for a current effect
fence. Every asynchronous fence retains the original generation/operation identity.

| Entry/callee | Acceptance or await | Next effect and required fence | Ownership / settlement |
| --- | --- | --- | --- |
| `JobManager.launch -> claimTurn -> launchClaimed` | Registry lock, retained current/archives/remote evidence, registry CAS | Before reset, queue removal, host clear and registry publication: validate exact old generation and original evidence. Repeat before detached or inline effect. | Registry lock is released in finally; refusal retains queued originals, not a new running grant. |
| `JobRunners.startAsync -> start -> publishRunnerSpec` | Reader identity await and admission.isCurrent | Check retained originals before mkdir/archive/reset/spec publication and again at actual start; remote projection absence is not cache absence. | An unsettled refusal propagates rather than falling back to inline provider. Preserve known owned launch cleanup and normal admission guards. |
| `takeRunnerSpec -> publishInitialRunnerState -> runOwnedJobRunner` | Spec consumption, first state write, node startup | Retained generation and current/archive/cold/legacy proof before destructive spec consumption or PID replacement; no restart re-execution of unknown work. | Original spec/state identity retained; recovery publishes evidence only. |
| Runner sink `fromSubagent/post/ask/escalateApproval` | Synchronous immutable ID/body/intent/owner/ns/generation capture before callback acceptance | Queue output only after capture commits. No send or final receipt probe may pass predecessor retention drain. | Capture refusal is unaccepted, not a claim of process-death durability; accepted successors stay retained independently. |
| `handleControl` and inline JobManager controls | Exact authenticated mailbox owner and control CID/body, generation fence | Capacity and durable capture before markRead, queue mutation or live output. A retry with same CID must agree on full bytes/intent. | Failed capture leaves control unread. Cancel/pause/title/settings retain their original control identity too. |
| `delegate-run job.live.post` | Capture hook before steering or ParentLink enqueue; native send response may suspend | Same original input/operation after hook await. Accepted/not-dispatched/unknown are distinct; only proved local non-dispatch may fall back with the same captured identity. | Unknown external outcome is retained and fenced; no automatic l.post fallback. Ordinary no-hook callers preserve behavior. |
| `delegate-run retryTransient callback -> profile.run` | Machine permit and usage preflight await | After those awaits, revalidate exact selected EXECUTING batches/generation, persist provider admission immediately before profile.run and recheck after any hook await. C2 stays separate from C1. | Existing permit/usage/permission/lineage finally and release stay. No external callback inside SQL retry; unknown provider outcome is never restart permission. |
| `ParentLink.post / inbox / reportCompleted / closeMessages` | Existing link keeps controlId across pending/unanswered, returns unconsumed controls on close | Capture occurs upstream before post. Closing returns exact original CID/body for queue reconciliation; in-memory pickup/answer is not metadata consumption proof. | ParentLink unchanged. Provider result retention must precede durable batch consumption/follow-up admission. |
| Runner provider result -> notes/final/continuation | Native work, cleanup and progress callbacks may interleave C2 | Persist exact result bound to selected batches; drain accepted notes before successor provider, final receipt/send/fallback/settlement. Oversized final stays unsettled, not truncated. | C1 result never settles C2. Preserve completed effects and exact original IDs. |
| `writeRunnerStateRecord` / evidence settlement | Storage lease + one metadata transaction | Validate CAS and immutable header/ordered entries/input transitions; archive originals and exact proof before removal/update, then COMMIT. | Proved rollback restores all three; ambiguous COMMIT stays unknown and is inspected by same operation/CAS, never external retry. |
| `assertRunnerArchiveAdmission / recovery` | Per-job current + archive/cold/file evidence inspection | Exact bytes/UUID/body/intent/principal/ns plus completion/source digest, not index/existence/size alone. 64records/8MiB/25ms window exhaustion returns resumable unresolved, no permission. | No provider registration/replay. Missing namespace, malformed/legacy evidence refuses the affected job; no global name guess. |
| Runner archive/import/cold relocation | RetainMetadataFiles owns existing copy/import transaction and later move | Project exact source/digest/cold reference in the same import transaction; don't remove sole original or invalidate proof by relocation. | Original/copy retained on partial failure; no cross-DB atomicity claim or TTL for unknowns. |
| `RemoteJobHost.start/send/sendRequest/read` | Exact original host/request/owner/turn before accepted/pending | Persist immutable operation before node.remoteJob; inspect strict current/archive/corrupt evidence before absence; independent live tokens for C1/C2/cancel; same-operation confirmation only. | Unknown reply does not synthesize failed/dead. Restart pending/blocked remains fenced; no automatic provider/network replay. |
| Broker remote request -> `RemoteJobs.request -> network extension` | Current authenticated pair/capabilities/advertised supervisor | Both-direction runner-ledger-v2; preserve original request/host fingerprint/ns/principal and source-two pinned return route before send. | RPC timer/close owns exact pending token; rejected response does not prove no remote effect. |
| Registered `RemoteJobs.receive -> handle(spawn)` | Existing sender/pair policy, live original eligibility, directory/usage/worktree awaits | Capture original eligible spawn before first await; cancellation can target only that admission. Revalidate identity before normal persistence/spec/launch. Persist required provenance before report-capable launch. | Duplicate/foreign/live replacement never owns original cancellation/blocked-state/death publication. Join exact admission cleanup. |
| Registered control/state/cancel response | Same record/supervisor/turn plus awaited dispatch | Same original operation token after await; do not let an older C1 settlement erase C2 or cancel. | Request/response errors retain unknown; late-start cancel uses original retained origin, not labels. |
| Job polling/settlement/local result receipts/report fallback | Observed state/result/storage receipt | Verify retained originals and exact owner/read-journal proof; final delivered=true only authoritative stored receipt; evidence-only is neither delivery/read nor replay permission. | Poll liveness uncertainty retains hosted job; independent cleanup and exact reader ownership remain. |

## Approved narrow scope amendments from this audit

`src/mcp/delegate-run.ts` optional runner/Job supplied hooks are approved only for
actual live input capture and actual post-await provider admission. Ordinary callers
keep existing behavior. Existing boolean steering APIs erase a consequential
distinction: both Codex and Muse return false before dispatch and after a possibly
sent request failed. Parent approved a typed retained-aware outcome seam only in
`src/core/codex-appserver.ts` and `src/core/muse-msp.ts`, their steering interfaces
and implementations, plus the retained delegate path:

| Outcome | Evidence | Retained action |
| --- | --- | --- |
| accepted | Existing request/command completed successfully | Bind the exact original input/operation to the accepted outcome; no C2 substitution. |
| not-dispatched | Local no-active-thread/turn or already-closed/completed check BEFORE invoking request/command | Existing ParentLink fallback may use the SAME captured identity. |
| unknown | Invocation may have occurred; reply missing/rejected/aborted/error | Retain bytes/operation and block automatic fallback/replay. No error-text inference, probe or provider retry. |

Keep one shared internal steering implementation per adapter and legacy boolean
mapping/config/protocol/timers. An adapter lacking the typed method treats false or
rejection as unknown for retained jobs. No provider was launched to establish this
static finding. No additional verification allowance was granted.

## Verification and protection ledger

Slice-three red, noEmit and whole slice-three/two/one checks: **NOT RUN** at this audit
freeze. The permitted order is one meaningful unchanged-pre-source red launch,
then one coherent corrected source freeze, noEmit, whole guarded new slice3,
whole71 slice2, whole141 slice1; each external60s, own PIDs/immutable first headers,
stop on unexpected failure/timeout/count mismatch with no automatic retry.
Only fake provider/link/native adapters and isolated synthetic SQLite are allowed.
Existing Node26 evidence is not hosted Node24/platform/native acceptance.

The reviewed slice-two baseline amendment is the only pin change authorized here.
Any new protected13 body delta is a proposal requiring exact regenerated normalized
before/after packet and parent review; no slice-three baseline update is approved.
UI/dashboard/mobile normalizers/assertions/retention guard/flaky/rules stay unchanged.

## Stopped first red launch — fixture failure, no production proof

Freeze `1da2aed8acb1a816bca4c14facd97603c2babaac`, tree
`a453b415de4d4037d7023668a1851bab4754c820`, test checkout SHA256
`bf8be9f2151a7e61ce706e6580a402b5ebf2c8cb00e78b4d1067ae79935c5a69`.
Production `src` remains exactly reviewed 870a (`86d0d91da04b26402ca2ba913b9d455bac45598a`).

The one admitted red selection executed six cases, but all six stopped in fixture
construction before their contract assertions: the new fixture called
`new MessageStore(path)` instead of the actual required `new MessageStore(path, log)`.
`store.ts:550` therefore threw `Cannot read properties of undefined (reading 'debug')`.
The ordinary merge control failed too. This is **not meaningful red evidence** for
any of the five intended counterexamples; there is no production finding from it.
The existing slice-two fixture supplies `nullLogger`; that actual signature was
missed during this fixture composition audit. No assertion or production change
is justified by this failed setup.

Raw logs/first immutable headers: `.agent-bridge-test/slice3/red.stdout.log` and
`red.stderr.log`; `red.receipt.json` and `red.launcher.receipt.json` retain the mismatch.
PID59960, wrapper45356, shell30132, 2026-10-24 16:36:46.223–16:36:50.288 JST,
4065ms, external60s, process exit1, six failed; expected five counterexample
failures and one passing control. Node26.4.0 / SQLite3.53.2 were printed inside
that already-authorized process. All owned processes settled; no timeout/retry.

Per the parent's stop rule, the fixture remains unchanged and no further check
has run. **Requested renewal:** only supply the already-imported `nullLogger` to
that constructor, freeze an attributable fixture correction, and renew one same
six-case unchanged-production red selection. The corrected-source noEmit and whole
slice3/71-case slice2/141-case slice1 allowances have not been used. Slice3 production
implementation has not begun; its typed delegate/provider seams are approved scope,
not implemented or validated effects. No slice-three closure/acceptance is claimed.

Separately, reference-only assembler PID72672 failed before producing its final
manifest because it attempted to resolve a design-named new module in HEAD where
that module is absent. Its raw failure and two partial M/P reference patches are
retained. It was not retried, and no complete selective-reference manifest is
claimed. This was source/artifact assembly, not a production launch or validation
run; the committed readable extraction/callgraph table is the current audit.

The source/pin packet for 870a remains exact: protected13 manifest SHA256
`90a1ac8b9f842ec4a27e320ae9fa6ee532ce754b3e7316efe1d966e970386f3e`,
normalizer SHA256 `93ca63b8638622cc790c0d776b544af0840133e4c144ce792836e718a93b664a`.
There is no new production body delta to regenerate. The three approved slice-two
hashes now match the separate baseline-only commit; the other ten and UI source
remain unchanged. All prior receipts and the original PR141 evidence are retained.
