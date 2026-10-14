# AB345 source packet and proposed fence

This is a source audit and contract draft, not a delivery implementation or an
integration acceptance report. The owner requested initial messaging items 1+2
on the sole `feat/messaging-stability` branch. The frozen released base is
`0761d56fe4c36e505550f9b889841fdf8e82c80a`. The worktree is
`E:/AgentData/worktrees/agentbridge-messaging-stability-20261015`.
The owner branch reason is messaging reliability.

## Plan and fence before code

1. Audit all actual routes and their authority and persistence boundaries.
2. Submit the source fence and command/receipt contract to root.
3. Draft isolated policy helpers and refusal fixtures while root resolves the
   issuer/transaction prerequisite. These files have no runtime callers.
4. Prepare the exact optional-mode four-file delta for root review without
   applying it. Genuine delivery is the next reviewed package on the same
   branch after the initial merge.
5. Freeze this NEW-only small draft PR with exact source evidence and NOT RUN
   gates. Root's sequential-scope decision expressly leaves item 2 incomplete.

Safe draft fence: this document, `src/core/messaging-contract.ts`, and
`test/messaging-contract.test.ts`. Proposed shared-source fence, subject to
root's contract decision: `src/core/protocol.ts`, `src/core/broker.ts`,
`src/core/node.ts`, `src/mcp/server.ts`. Store, runner, provider, launcher,
network, UI, generated bundles and other PRs are outside this draft fence.
Implementing durable effect reconciliation across the routes below requires
more than those four shared files. Root must resolve that scope first.

## Source route and ownership audit

References are to the frozen base. Research from `claude-job-433ce5da`, recorded
in AB337, is peer-attributed to T3 Code pin
`7ac952c630ef8a60d14ca8f6a0c7adce33db4bae`; its unverified labels remain intact.
T3 owns persistent provider processes. This draft adopts no T3 process-control
mechanism, SDK replacement, launcher or unverified API.

| Route | Actual source boundary | What it proves / missing prerequisite |
| --- | --- | --- |
| Session broker mail | `core/node.ts:542`, `core/broker.ts:1714`, `core/store.ts:377` | UUID retry plus transactional retained mail; retry issuer is compared by sender name. Storage does not prove model consumption. |
| Paired receiver | `core/broker.ts:2141` | Retained UUID/content comparison on authenticated network path; native child routes refused. No native effect transaction. |
| Parent/sibling link | `mcp/server.ts:881`, `mcp/siblings.ts:31` | Explicit caller UUID is refused on parent links. Sibling live delivery has only a process-local delivered set. |
| Detached job | `mcp/job-host.ts:238`, `mcp/job-runner.ts:290` | Supervisor control becomes broker mail. Runner posts input before saving seen cid, without immutable cid payload or generation envelope. |
| Inline/shared job | `core/broker.ts:345`, `mcp/jobs.ts:433` | Existing ownership checks precede event emit; sent:true is not durable receiver acceptance. |
| Owned Codex job | `core/codex-appserver.ts:319`, `mcp/delegate-run.ts:433` | Owned thread supports expected-turn steer; wrapper's void post does not expose effect reconciliation to caller. |
| Foreign Codex session | `mcp/codex-wake.ts:20` | `codex queue` acceptance alone proves neither started turn nor consumed mail. No foreign app-server steering authority. |
| Claude session | `mcp/rewake.ts:136`, `mcp/rewake.ts:268`, `mcp/hooks.ts:216` | Wake handout and later host activity/hook acknowledgement; retained mail survives unsuccessful wake. No model-completion receipt. |
| opencode session | `opencode/plugin.ts:275` | Model-boundary hook context and prompt persistence attempt. Failure to persist can leave context only in that step's system prompt. |
| Antigravity session | `mcp/antigravity-hooks.ts`, `mcp/hooks.ts` | Existing hook delivery at model/tool boundaries. Idle TUI has no authorized turn-start route. |
| Native child | `core/native-children.ts:27`, `core/broker.ts:1791` | Claude-only local authenticated parent/session/address/grant/hop checks. No invented Codex/opencode/Antigravity/Muse native route. |
| Muse | `core/protocol.ts:25` | Absent from released AgentKind and delegation list. Honest unsupported policy stub only; implementation remains PR20-owned. |

## Command and receipt contract submitted to root

- Keep logical command and message UUIDs stable on retry, with exact immutable
  payload binding. Compare issuer, receiver, route, generation, mode, body,
  conversation, reply anchor and guard. A different payload is a conflict.
- The broker derives authority from the existing authenticated connection and
  actual route. A caller DTO, environment identity, name alone or capability
  flag cannot confer control. Reload/restart issuer recovery needs a reviewed
  source-owned identity relation; inventing a bearer field in shared JSON is
  prohibited.
- Receiver durable acceptance and immutable dedupe must commit atomically before
  any provider effect. An effect that succeeds before its ACK is lost requires
  genuine reconciliation. Otherwise retain an unknown outcome and refuse
  automatic effect retry; do not infer an exactly-once effect from a cid.
- Distinguish stored, queued, transport accepted and hook observed. None proves
  model consumed or completed. Only an actual receiver with the corresponding
  evidence can issue a durable stage receipt. This draft issues no receipts.
- Retry policy: named capped exponential delay, 100 ms through 5 s, with a finite
  attempt limit. Recheck authenticated issuer, resolved receiver, unchanged
  generation, ownership/revocation and terminal state before every retry.
  Unknown generation or unknown effect outcome is a refusal, not a resume.
- Stop cancels automatic retry/wake intent immediately. Retain original accepted
  mail, histories and receipts in archive; terminal settlement cannot delete or
  evict them. Explicit continuation is a separate command for a fresh generation.
- Negotiate optional protocol support. Old peers refuse explicit modes and new
  receipt semantics; omitted/auto retains existing behavior. Do not format-upgrade
  live stores or advertise support based solely on a CLI name or release number.
- Report requested mode, effective mode and the evidenced stage separately.
  A boundary hook is not provider-native active steering. Queue support and idle
  wake depend on route, role, known generation and the receiving transport.
- Preserve authentication, owner/group control, worktree, permissions, depth,
  slots, hops, revocation and generation checks unchanged.

### Exact missing boundaries

`core/broker.ts:1716` authenticates a retained UUID retry by comparing
`message.from.name` with `sender.name`; `core/broker.ts:1747` records an in-flight
sender by that name. The content comparison at `core/broker.ts:1729` does not
bind a durable issuer generation, dispatch mode or retained reply guard. Its
in-flight fingerprint at line 1739 is process-local, not a durable issuer or
payload record. Preserve legacy recovery compatibility while reviewing a
separate new negotiated identity contract; do not silently harden the old path
by breaking retained readers or assume a reloaded name is an authenticated
issuer continuation.

`mcp/job-runner.ts:294` calls `job.live.post(c.body)` before adding cid to seen
at line 297 and saving at line 299. Thus a successful native effect followed
by crash/lost ACK can replay, and marking cid first without an effect journal
could instead drop the input. The cid does not bind immutable payload.
`mcp/delegate-run.ts:354` exposes void post; the owned Codex steer promise at
line 361 is handled internally with hook fallback at lines 362-363. The caller
cannot derive a provider acceptance receipt from this call returning.

### Proposed source-owned transaction schema for the next review

This is a review proposal, not SQL applied to any live database. It must be
negotiated separately from legacy formats, checked against retained .30.7
readers and .30.14 runtimes, and migration-reviewed by the store owner.
No private bearer fields are added to shared JSON.

| Proposed record | Immutable binding / transaction boundary |
| --- | --- |
| Issuer admission | Broker-derived issuer admission identity and verified continuation relation across reload/restart. Display name, caller sessionId and environment identity cannot establish this relation. Existing verified process/session/native-parent and durable job authority checks remain required. The recovery issuer relation is unresolved. |
| Logical command | Unique `(issuer_admission, command_uuid)` with message UUID, exact body, requested mode, route, resolved receiver, receiver generation, conversation, reply anchor and guard. Same ID with any changed field conflicts, including after archival. |
| Receiver acceptance | Unique `(receiver_identity, generation, message_uuid)` referencing the command. Commit immutable payload plus acceptance and retained inbox/queue entry in one receiver-owned transaction after rechecking current authorization/generation. ACK only after commit. |
| Effect attempt | Receiver-owned immutable attempt identity and provider correlation, recorded before effect dispatch; acceptance/unknown/terminal observations appended. Native effects with no queryable correlation or idempotent endpoint cannot be safely retried after unknown ACK. |
| Stage receipt | Command/message/receiver/generation/attempt reference, evidenced stage, source observation and timestamp; immutable append, never caller-issued authority. stored/queued require durable receiver transaction; transport accepted requires an actual transport response; hook observed requires authenticated current-boundary evidence. No consumed/completed claim without genuine model correlation. |
| Terminal settlement | Stop/revocation/stale generation settles pending retry/wake intent atomically while retaining every original command, mail copy, attempt and receipt. New explicit continuation gets a fresh generation/command, never resurrects a stopped attempt. |

Proposed consumer integration: route authenticated send/parent/sibling/native
commands through the same acceptance layer; replace job runner seen-cid-only
handling with transactional receiver acceptance; make inline/shared events
carry only references to durable accepted commands, with the executor claiming
the current generation; expose the real provider delivery outcome instead of
void post. Connect Claude held/rewake and Codex queued prompts to retained
message IDs and current receiver generation. Antigravity remains next-boundary
delivery. Muse remains a refusal until PR20 supplies a real supported route.
Every consumer reuses existing authorization and lifecycle gates. These
consumers, issuer/schema changes and real-route tests are outside this PR.

## Exact optional-mode delta submitted for separate root review

No shared-source edits are applied in this PR. Proposed four-file seams:

| File / released seam | Concrete proposed change |
| --- | --- |
| `core/protocol.ts:155`, `core/protocol.ts:228` | Optional wire-only mode and mode-result types; one new `modeSend` opcode so old brokers explicitly refuse instead of ignoring semantics. Report requested/effective/refusal, actual route/role/ownership/generation-known facts and lowest provable stage. Do not widen AgentKind or shared store formats. |
| `core/broker.ts:390`, `core/broker.ts:1723`, `core/broker.ts:1791` | Require the existing current authenticated connection first. Derive route/role/generation and preserve existing authorization. Auto delegates to the existing send route. Refuse unsupported steer/restart, unknown-generation explicit modes and unverified receivers before effects. Scoped native queues can only use routeNativeSend's current child/parent/grant/hop rechecks; no foreign TUI control. |
| `core/node.ts:542`, `core/node.ts:660` | Add a mode-aware request method using modeSend, including the existing scoped-child selector where applicable. No automatic mode retry. Only explicit unknown-op refusal permits legacy auto fallback. Timeout/disconnect yields unknown outcome with no retry/fallback effect. |
| `mcp/server.ts:624`, `mcp/server.ts:868`, `mcp/server.ts:1518` | Add optional enum mode to send/message_subagent and handle it inside the native-child guard too. Omitted auto keeps legacy execution. Refuse unsupported explicit job modes before title/settings/followUp so refusal cannot resume a finished/stale job or mutate its settings. Include honest requested/effective/lowest-stage information. |

Conservative proposed capability result for that later delta:

- All unsupported native kinds and Muse: every explicit capability false.
- Authenticated live Claude native target: existing durable mailbox queue
  mechanism only; no active steering, interrupt/restart or idle wake claim.
- Session hooks and delegated job links: boundary/mailbox mechanisms are
  inventoried; no queue-after-active or steer support advertised from a void
  emission. Foreign Codex queue acceptance cannot become consumed/completed.
- `auto` result: actual broker storage can report stored; fire-and-forget job
  events report requested/unknown. A local array push is not durable queueing.
- All explicit queue behavior remains subject to root review of immutable
  mode/issuer binding. Existing native recovered() at `core/broker.ts:1818`
  compares sender name/content, not an issuer generation or requested mode.
  Therefore this draft enables no functional queue retry. Root was asked
  whether a single-attempt native queue with no caller explicit ID is acceptable,
  or all explicit modes must remain refused until the transactional package.

The proposed opcode is an internal negotiation boundary, not a new MCP tool
family. There is no blanket capability advertisement on peer registration.
The helper's route inventory is deliberately not wired to this proposal and
cannot itself authorize a route or issue a receipt.

## Evidence gates

The isolated fixtures are policy/refusal tests only. A 25-pair sender/receiver
matrix in idle and busy states is not integration proof when routes are not
wired. Real supported-route hosted fixtures, lost ACK/restart/stop/terminal
cases and migration review remain required. Root prepares the independent
read-only protocol fixture design.

NOT RUN by this allocation: local tests/suites, build, typecheck, JS imports,
native/provider/process/OS probes, owner DB and live Bridge probes. No peer
messages or controls were exercised except authorized questions to parent.
Only normal automatic hosted CI is authorized; no dispatch, rerun, cancellation
or polling loop. No generated runtime bundles have been built.
