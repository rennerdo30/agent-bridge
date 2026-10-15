# AB345 source packet and proposed fence

This packet implements bounded optional modes and retains the shared delivery
contract draft. It is not shared idempotent delivery or provider/model integration
acceptance. The owner requested initial messaging items 1+2
on the sole `feat/messaging-stability` branch. The frozen released base is
`0761d56fe4c36e505550f9b889841fdf8e82c80a`. The worktree is
`E:/AgentData/worktrees/agentbridge-messaging-stability-20261015`.
The owner branch reason is messaging reliability.

## Plan and fence before code

1. Audit all actual routes and their authority and persistence boundaries.
2. Submit the source fence and command/receipt contract to root.
3. Publish the isolated three-file draft at
   `f7c444fa93f0532d1ee9865f217441580e337f6d` / draft PR32. Its policy helpers have
   no runtime callers and remain distinct from the bounded wire implementation.
4. Record root's next exact four-file method/hunk fence on AB345 before editing;
   implement optional modes plus one real-boundary hosted fixture file.
5. Freeze that source packet on the same branch. Genuine shared delivery is the
   next reviewed transaction/issuer package after merge; item 2 is incomplete.

Initial draft fence: this document, `src/core/messaging-contract.ts`, and
`test/messaging-contract.test.ts`. Next approved fence: exactly
`src/core/protocol.ts`, `src/core/broker.ts`, `src/core/node.ts`,
`src/mcp/server.ts`, new `test/messaging-mode-routes.test.ts`, and this existing
source packet. Store, runner, provider, launcher, network, UI, generated bundles
and other PRs remain outside the fence. Implementing durable effect
reconciliation requires the separately reviewed next package.

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

## Approved optional-mode implementation and method/hunk fence

Root approved this bounded delta after the initial draft. The exact method/hunk
fence was recorded on AB345 before edits; no existing tests or JSON baselines,
normalizers, assertions or deadlines were changed.

| File / released seam | Actual bounded change |
| --- | --- |
| `core/protocol.ts:155`, `core/protocol.ts:228` | Add SendMode/ModeSendArgs/SendModeReport/ModeSendResult and exactly one modeSend RequestMap opcode. Wire-only requested/effective/stage/capability facts; no AgentKind or shared format change. |
| `core/broker.ts:203`, `core/broker.ts:751`, `core/broker.ts:1791` | Exclude modeSend from the constructor handler map's type and select NEW onModeSend in dispatch instead. Constructor/default lifecycle pins unchanged. New strict mode handler; auto calls existing send/native route; native queue adds an optional current-registration callback to routeNativeSend's check and reuses existing insertBatch. No existing auth/ownership/grant/hop logic replaced. |
| `core/node.ts:542`, `core/node.ts:660` | Import wire types and add sendWithMode, one authenticated modeSend request, no read-reconnect/send-retry route. Only typed protocol_mismatch with operation=modeSend permits auto-only legacy fallback; errors/timeout/closed socket/unknown effects never retry. Existing send and lifecycle methods unchanged. |
| `mcp/server.ts:624`, `mcp/server.ts:868`, `mcp/server.ts:1518` | Add mode report/error helpers, optional enums on send/message_subagent, native guard mode branch, explicit-mode preflight before old send/job paths, explicit auto report, and job refusal before lookup/title/settings/followUp/resume. Omitted paths unchanged. |

Actual capability/outcome boundaries:

- All unsupported native kinds and Muse: every explicit capability false.
- Authenticated live Claude native target: one-shot queue only. The broker
  creates a fresh UUID; caller messageId/dedupeKey refuses before effects. Two
  identical body sends are distinct legacy attempts, not idempotent retries.
- New queue issuers: current parent connection or an exact granted top-level
  Claude/Codex/opencode/Antigravity connection. Both sender and native parent's
  broker mailReady registrations must be ready/current. Captured registrations
  are rechecked inside the existing transaction alongside child activity,
  owner/session, grant and hop checks. No caller generation is minted or trusted.
- Delegated/other issuers and scoped native senders cannot use new queue. Their
  genuine issuer generation is unimplemented; even a grant cannot replace it.
  JobOwner/session/name DTO labels do not create new queue authority.
- Existing insertion success reports stored only, never transport accepted,
  model consumed/completed or exactly-once effects. Stop returns original mail
  using the existing retained native fallback; this patch schedules no timer,
  mode retry, replay or automatic restart.
- Session hooks and delegated job links: boundary/mailbox mechanisms are
  inventoried; no queue-after-active or steer support advertised from a void
  emission. Foreign Codex queue acceptance cannot become consumed/completed.
- `auto` result: actual broker storage can report stored; fire-and-forget job
  events report requested/unknown. A local array push is not durable queueing.
- Existing native recovered() at frozen `core/broker.ts:1818` still compares
  sender name/content, not a durable issuer generation or requested mode. New
  one-shot queue uses no caller identity/dedupe key and has no automatic retry.
  It does not repair or claim the next transactional acceptance layer.
- A downstream opcode/protocol failure cannot impersonate refusal of modeSend
  after effects begin. The new broker handler wraps it as unknown outcome;
  Node cannot downgrade it into another legacy send.

The proposed opcode is an internal negotiation boundary, not a new MCP tool
family. There is no blanket capability advertisement on peer registration.
The helper's route inventory is deliberately not wired to this proposal and
cannot itself authorize a route or issue a receipt.

## Evidence gates

The original isolated fixtures remain policy/refusal tests only. New
`test/messaging-mode-routes.test.ts` exercises real hermetic Broker/Node/MCP
boundaries: 25-pair idle/busy session and native-role matrices, authentic Muse
registration refusal, actual native insertions, duplicate-body distinct IDs,
stop retention, grants/revocation/hops, stale registration after an admitted
write yields, caller ID/generation/grant spoof refusal, authenticated old-opcode
wire refusal, unknown effects/lost ACK after real storage, and refusal before
job continuation/native acknowledgement. Old-opcode and lost-ACK cases inject
failures, never positive provider outcomes. No provider/model consumption or
live session acceptance is proved. Shared issuer/receiver transaction,
reconciliation, restart/retry/terminal integration and migration review remain
required. Root prepares the independent protocol fixture design.

NOT RUN by this allocation: local tests/suites, build, typecheck, JS imports,
native/provider/process/OS probes, owner DB and live Bridge probes. No peer
messages or controls were exercised except authorized questions to parent.
Only normal automatic hosted CI is authorized; no dispatch, rerun, cancellation
or polling loop. No generated runtime bundles have been built. Root separately
allocates fresh hosted packaging against the independently reviewed frozen
head. The automatic CI generated-bundle freshness check remains a real pending
packaging gate; a source packet or policy fixture is not a runtime pass.

ACP research now lives on AB347 (Bridge0761/T37ac952c6) and its proposal-only
children. It adds no authority, dependency, provider, launcher or queue/steer
scope to this allocation. ACP insertion ACKs, idle states, old fixture versions
and native model completion remain distinct future evidence questions.
