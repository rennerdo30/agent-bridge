# AB-277: Codex MCP lifetime and memory design

Status: **documentation-only proposal for root and Claude review**. No runtime,
configuration, process or store changes are implemented or authorized here.
Baseline: published `7e80ac79bc20c804985f0463125e7832308222b0` (0.30.11), after
the accepted AB-264 static checkpoint. No source from broken local `386bf7bb`
was used. Inspection date: 2026-10-11 UTC.

## Recommendation and unanswered cause

Keep one independent stdio endpoint per Codex client. First measure the loaded
Bridge roles and review lazy imports. Consider one substantial backend per
exact Codex parent lifecycle only behind lightweight, independently owned
stdio clients and explicit thread/native-context isolation. A parent PID is
a resource-sharing boundary, never a Bridge owner or thread identity.

The observed 2–4 MCP processes under some Codex parents are not yet proven
stale. Separate thread/client launches, reload overlap and an old transport
that has not closed are plausible causes. Published Bridge source establishes
what each launch loads and how it stops; it does not establish which Codex
client requested each host launch. Consolidation cannot depend on treating
all but one sibling as invalid or terminating them by PID/age/RSS.

The current mutable server context is unsuitable for multiplexing distinct
threads without a redesign. Sharing imports is potentially useful; sharing
identity, receipts, wake state or an active RPC namespace is unsafe.

## Evidence boundaries and attribution

The coordinator's accepted CIM snapshot at **10:03 UTC** reports 25 Codex MCP
processes, approximately **2239.7 MiB RSS**, across 14 `codex.exe` parents.
Five absent-parent nodes (60876, 68740, 12720, 66192, 73656) were attributed to
detached job runners, **not MCP servers**. This supplied classification was
not reconstructed from command lines or private runtime files in this task.
The other reported Node populations, including CUA, are outside this total.

A separate metadata-only query at approximately 10:09 UTC inspected
`Win32_Process` properties `ProcessId`, `ParentProcessId`, `CreationDate`,
`WorkingSetSize`, `Name`. Output contained only PID, PPID, start, role and RSS
for Node direct children of currently observed Codex processes. Several parents
had children in multiple start cohorts. Those children remain
`node-direct-codex-unclassified`: this query cannot distinguish MCP, CUA or
another Node role, establish RPC activity, or revise the 25-MCP baseline.
No command-line property was requested. PID absence in a racing snapshot is
not proof of stale ownership or authority to stop a process.

Public installed-package inspection was limited to manifests, static MCP
configuration and launcher code. The highest observed Agent Bridge cache
directory was 0.30.9; its MCP shape is Node plus two arguments, `cwd`, 18
forwarded environment key names and startup/tool timeouts. Its small
`dist/server.mjs` selects and imports a worker in the same process. Neither
cache-directory version nor launcher filename proves the active worker's
version, because the launcher supports runtime selection.

`Get-Command` identified a standalone Codex executable and npm wrappers. The
public npm package inspected was `@openai/codex` 0.153.4; its JavaScript
launcher selects and spawns a native executable. This is not proof of the
running standalone binary's version and contains no inspected native MCP
manager implementation. No Codex executable was run. User config values,
credentials, history, live Bridge logs, runtime selection records and command
payloads were not read; no heap dump, installation or process change occurred.

## What Codex documents, and what remains unproven

[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
documents command-launched STDIO and URL-based Streamable HTTP servers, with
configuration shared between Codex surfaces. It does not document an
exact-parent singleton or guarantee one MCP process per OS parent. A shared
configuration file does not imply a shared live transport.

[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
documents distinct thread start/resume/fork operations and
`config/mcpServer/reload`, which queues configuration refresh for loaded
threads. These make multiple client lifetimes and reload overlap plausible;
they do not prove the host's observed launch attribution. Documented thread
unload behavior is not an MCP child lifetime guarantee. Required-server
startup failures can block thread start/resume, so startup availability matters.

[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents MCP command/URL selection, tool filters, startup/tool timeouts and
required-server policy. No documented parent-sharing switch was established
by this inspection. Tool filtering alone does not remove the Bridge worker's
imports. Streamable HTTP support in Codex is not an existing Bridge HTTP
implementation or an authenticated parent/thread binding.

## Published Bridge source evidence

References below are pinned to the baseline, not an assertion about every
running cached worker. Import presence is source attribution, not measured
resident heap attribution.

| Source | Finding and implication |
| --- | --- |
| `plugins/codex/.mcp.json:1`; `.codex-plugin/plugin.json` in that plugin | Ordinary command-launched stdio MCP. Hook session/cwd metadata exists; its strings alone are not durable ownership authority. |
| `src/mcp/launcher.ts:10-16` | Selects a worker, records a runtime session, then imports it into the same Node process. The launcher is small, but is not a lightweight proxy today. |
| `src/mcp/server.ts:1-66,241-303` | Static MCP/validation/tool/job/delegation/wake imports and per-server context/managers are potential repeated costs. `AntigravityHooks` is statically imported even on a Codex launch; actual savings require module and memory measurement. |
| `src/mcp/server.ts:263-291` | Delegated/internal launches do not create an independent `BridgeNode`; linked children can use a private coordinator. Preserve this role boundary and all depth/slot/ownership guards. |
| `src/mcp/server.ts:295-303`; `src/mcp/job-host.ts:25-45,197-209` | Replacement pauses a manager; detached runners intentionally survive server/session reload. Absent parents do not make these MCP leaks. |
| `src/mcp/server.ts:305-345,575` | Config, project relocation, waker and `node.setSessionId` mutate one context. `observeMeta` runs before a tool handler. Concurrent requests for different threads cannot safely reuse this global mutable state. |
| `src/mcp/server.ts:435-442`; `src/core/node.ts:307` | Dashboard and elected broker/store are already dynamically imported. Do not claim every MCP statically opens a store or that moving these existing lazy boundaries creates a new saving. |
| `src/mcp/server.ts:472-493` | Shutdown handles transport close, stdin end, SIGTERM and SIGINT, then stops owned resources. No direct-parent lifecycle watchdog was found in this MCP startup path. Open transport/process observations alone cannot prove why a child remains alive. |
| `src/mcp/server.ts:532-539` | Defers node connection when project cwd is unknown, not worker imports/tool registration. Lazy connection is not a lightweight launch. |
| `src/core/process-identity.ts:10-30,39-55,108`; `src/core/node.ts:367-390` | Parent PID plus creation identity is available; lookup failures have unknown/error semantics. Registration attribution is not a parent-exit watchdog or authenticated thread owner. |
| `src/core/broker.ts:97,726-728,1319,1508-1515` | Replay/admission are fenced by connection mail generation, exact peer/session/registration and socket ownership. Keep these logical checks even if several contexts share a physical runtime. |

There is no evidence here that ordinary retried RPCs themselves launch extra
MCP processes. To resolve launch origin, a future authorized fixture must
associate each transport with host thread/client start, refresh and closure
events using public non-secret IDs. No live log/payload inspection is proposed.

## Alternatives and decision order

| Alternative | Benefit hypothesis | Cost or blocking proof |
| --- | --- | --- |
| Keep separate runtimes; lazy role/tool imports | Smallest ownership change; avoid work unused by a Codex role or before first relevant tool. | Common MCP SDK/validation overhead remains. Existing dashboard/broker laziness is baseline, not new work. Preserve synchronous tool discovery/capabilities and first-use behavior; bundle splitting must really avoid eager evaluation. |
| Independent stdio shims plus one compatible backend per exact parent lifecycle | Shares substantial imports while retaining every host pipe; best fit for the owner's proposed boundary. | Shims still consume memory; per-context state remains. Requires new local transport authentication, isolation, election, drain/recovery and broker-role separation review. Current server cannot simply be reused globally. |
| Streamable HTTP clients to a shared local backend | Codex supports this transport; potentially avoids one Node shim per client. | Bridge server/authorization are new work. Parent PID/creation and thread authority do not arrive automatically over HTTP; bind clients explicitly, preserve MCP sessions/cancellation/receipts and protect endpoint credentials. Config/version compatibility and hooks need separate proof. |
| Remove redundant native-child MCP startup where host routing permits | Avoids a full child runtime only if that client genuinely requires no independent Bridge endpoint. | Requires AB-268 child-versus-pane and host configuration evidence. Cannot disable a valid sibling, infer native ownership from a shared PID, or force all children to register as main. No supported native-client suppression guarantee was established. |

Review lazy import candidates and baseline instrumentation first. Review the
stdio-shim architecture with exact context ownership next; choose it only if
measured savings exceed its added footprint and lifetime/security cost. HTTP
is an alternative, not a prerequisite. These choices do not authorize edits.

## Conditional shared-backend contract

### Physical lifecycle and owned shutdown

Proposed runtime key: local security principal/home namespace, exact Codex
parent PID **and creation identity**, compatible runtime protocol and immutable
worker version/digest. Direct parent may be a wrapper: resolve a verified
native ancestor chain using process metadata, not argv/prompt matching or
untrusted tool metadata. Missing/unknown creation identity blocks sharing;
preserve an isolated channel or report unsupported binding, never guess.

Elect through an atomic owned rendezvous with a random generation nonce,
verified process identity and an authenticated local endpoint. A lock or PID
file alone is insufficient. Authenticate every shim/channel with a reviewed
OS-owned launch/IPC binding and least-privilege same-principal endpoint access;
no new capability in shared argv, inherited broad env or ordinary logs. Exact
Windows pipe-client/launch attestation feasibility needs isolated native proof.

One backend is a steady-state goal for compatible channels, not a reason to
terminate valid old-version work. On plugin reload, immutable incompatible
worker generations may overlap while old channels drain. Never overwrite the
running worker, replay an ambiguous mutation after reconnect, or take over a
foreign rendezvous. Count and explain overlap instead of declaring it a leak.

Stdin EOF or a shim signal retires only that channel and its authorized
context leases. Other channels, outstanding server-to-client requests, waits
and receipt ownership survive. A verified parent-generation exit allows the
backend to drain/cancel only resources it owns and shut itself down; it does
not permit scanning/killing siblings. Unknown probe results are not death.
Use bounded, batched identity checks off the RPC hot path, not one shell spawn
per channel/request. Failed startup or election must produce an explicit
bounded error, not an unowned fallback heavy singleton or silent tool loss.

Broker election is a separate role. A backend that currently hosts the broker
serves other sessions too; parent-scoped shutdown must either retain that
service in an independently owned lifetime or gracefully close its own broker
and prove safe reelection. Detached job runners retain their own job lifecycle
and recovery ledger. Parent exit/reload never sweeps them or their native
children into MCP cleanup. Persistent data and quarantine evidence survive.

### Independent channels and RPC ownership

Each stdio shim owns one SDK transport, initialization/capabilities, inbound
and outbound RPCs, cancellation, notifications and elicitation responses.
Backend request identity includes channel nonce, direction and typed original
RPC ID: numeric `1` and string `"1"` differ; identical IDs on two clients never
collide. Notifications still carry channel/context binding. Route backend
requests and responses to their original client; no shared stdout or broadcast
reply. Per-channel bounded queues/backpressure prevent one blocked client from
stalling or exhausting siblings. Losing a client leaves an explicit outcome
for its in-flight calls without falsely completing another client's request.

Capture an immutable authorized call context **before any await**: logical
thread/native principal, project/config snapshot, role/delegation linkage,
permission/cancellation scope and current logical registration generation.
If a channel legitimately carries multiple thread IDs, maintain separate
contexts and allow concurrent RPCs. Do not merely serialize handlers around
the existing mutable `ctx.node`, waker or `setSessionId`: asynchronous wakes,
hooks, waits and acknowledgements also need the right binding.

Share code/immutable schemas; scope nodes, read journals, waits, wake/activity
epochs, config application, managers, permission callbacks and receipt state
to their logical principal. Physical config watchers may be shared only with
isolated project snapshots/subscriptions. Same OS parent, cwd, name or env
attribution is not permission to merge identities. Preserve private delegated
coordination until native-child linkage is verified; never turn an unknown
child into an independent main peer. Main/pane/native-child identity from
AB-268 must remain distinct even under one parent PID.

## AB-276 dependency and generation distinctions

Related proposal: [AB-276 waiter notice contract](../../../agentbridge-ab276-design-332867e2/docs/runtime/WAITER-NOTICE-CONTRACT.md)
in `D:/AgentData/worktrees/agentbridge-ab276-design-332867e2`, commit
`1c2a0f70ab9c5fffa9ef61ad3b8924820ecd5669`. This sibling artifact is a
proposal, not implemented authority. The relative link is convenient between
these local worktrees; use the exact commit/path when reviewing elsewhere.

| Identity/fence | What it means here |
| --- | --- |
| PID + creation identity | Exact OS lifecycle attribution; neither a thread nor durable owner authority. |
| Backend/channel nonce | Proposed physical RPC routing/lifetime fence; cannot authorize Bridge mail. |
| Thread/session/native context | Logical client association; needs verified role/ownership binding, not PID deduplication. |
| Connection mail generation | Existing broker replay/admission fence; retain per logical registration. |
| Hook/activity epoch | Existing activity/wake sequencing; not owner generation or proof of process death. |
| Env/cwd/name | Association hints; never credentials or ownership authority. |
| Durable authenticated owner generation | AB-276's proposed broker-owned authority epoch; not present merely because a shared runtime exists. |

Do not implement or assume AB-276's proposed global store reader floor as a
memory optimization. Its schema/pin/fencing decisions require separate review.
AB-277 does not need a store migration to explore lazy imports or shared code.
If future runtime ownership relies on durable owner generations, that part
must remain blocked until the authority contract is approved and implemented.
No cross-thread inbox drain/read/ack, old mail to a successor, wake bypass or
quarantine replay can follow from backend sharing. Queued, accepted and read
receipts remain distinct, individually pinned facts.

## Measurable baseline and source-led attribution

The supplied population averages about 89.6 MiB RSS per MCP. Moving 25 heavy
copies to 14 is an arithmetic reduction of 11 copies, **not evidence that 11
are stale** or a memory forecast. Zero-cost shims and zero incremental state
would imply approximately 985.5 MiB less RSS; that is an unrealistic ceiling
under a homogeneous-copy assumption, not a promised saving.

Measure the candidate as `14 * backend + 25 * shim + incremental contexts`,
with separate broker-host and detached-runner accounting and measured role
mix. Shims remain 25. Avoid double-counting common backend/context costs and
compare the same tool/thread/load population. Windows RSS includes shared
resident pages and is not retained JavaScript heap or private committed memory.

A future approved controlled harness should record:

- Exact fixture parent/child creation identities and role; worker digest,
  channel/context count and module-load phases. No prompts, tokens, argv or
  private history. Safe aggregate role telemetry must identify itself at
  launch rather than infer all Node roles from process names.
- Per-process RSS and private committed memory; owned-runtime
  `process.memoryUsage()` heap/external/array-buffer counters when separately
  authorized. No heap dumps. Attribute import candidates using a build
  module graph and first-load checkpoints; bundle size alone is not RSS.
- Cold start, handshake, first tool, representative delegation/wait/wake
  workload and idle checkpoints at 1/10/30 minutes; broker and nonbroker,
  main/delegated/native roles, 1/2/4 clients under one parent and separate
  parents. CUA is a separate control population, not Bridge MCP savings.
- At least five paired runs with a fixed Node/Codex/candidate version,
  same fixtures and identical workload; startup/first-tool and RPC p50/p95,
  success/cancellation outcomes, pending requests and stable context counts.
  Set the savings/latency budget after baseline, before candidate measurement.

A reasonable review gate is a declared material aggregate private-memory
reduction with no lifecycle/identity regressions and no agreed latency-budget
violation. Do not set an exact RSS unit-test assertion or claim success from
static imports. This design task ran none of these host workloads.

## Proposed focused verification before implementation acceptance

All fixtures are isolated and synthetic. Host/native acceptance requires a
separate authorization; unit tests do not prove Codex internal launch behavior.

| Case | Required proof |
| --- | --- |
| Host launch attribution | Controlled thread start/fork/resume/reload identifies each client launch and close without reading private logs or payloads; distinguish valid concurrent clients from stale transport. |
| Exact lifecycle | PID reuse, same PID/new creation time, wrapper ancestor, query failure and parent exit: unknown never kills; only owned generation drains. Unrelated sibling and detached runner survive. |
| Election/version storm | Four simultaneous clients converge on one compatible backend; crash at each rendezvous stage has no foreign overwrite or abandoned authority. Incompatible versions drain separately without active-call loss. |
| Concurrent RPCs | Same numeric/string IDs on four channels; notifications, cancellation, long waits, elicitation and backpressure route only to owner. Disconnecting one does not cancel others or broadcast a receipt. |
| Multiple threads on a channel | Overlapping requests capture distinct immutable contexts before await; cwd/config/activity/waker changes do not alter the other's pending call. |
| Native/main/delegated identities | AB-268 distinctions, slots/depth/hops, private coordinator linkage and permissions remain intact; unverified native child cannot register as main or drain a parent's inbox. |
| Mail/session replacement | Existing generation and ownership guards hold during reload/reclaim; old-session mail and AB-273 quarantined rows remain excluded; healthy delivery and read receipts stay pinned to the exact owner. |
| Failure/drain | Backend/shim crash before/after mutation yields truthful known/unknown results, no automatic mutation replay or silent RPC loss. Timers/watchers/context leases do not grow on repeated reload. |
| Broker/job boundary | Owned broker closes/re-elects without changing another session's authority; detached runners retain state and finish under their own lifecycle after MCP parent exit. |
| Lazy imports | Tool inventory/capabilities unchanged; role-ineligible modules stay unloaded until needed, first-use failure is explicit, permission and shutdown behavior preserved. |
| Memory/latency | Paired controlled measurements meet the predeclared budget; include shim/state overhead and broker roles, not just fewer heavy PIDs. |

## Proposed file ownership and review sequence

Only **this Markdown artifact** changes in AB-277. Future names below are
tentative review boundaries, not authorization to create or edit source.

| Proposed files | Responsibility |
| --- | --- |
| `src/mcp/launcher.ts`, `plugins/codex/.mcp.json`, `scripts/build.mjs` | Reviewed stdio-shim entry/version selection, only if that alternative is selected. Never hot-patch installed copies. |
| New `src/mcp/client-shim.ts`, `runtime-channel.ts`, `runtime-backend.ts` | Independent MCP channels, authenticated framed IPC, per-channel routing/backpressure and compatible backend election. |
| New `src/mcp/runtime-context.ts`, `runtime-lifecycle.ts`; `src/mcp/server.ts` | Immutable logical call contexts, owned drain/lease policy and measured role-specific lazy imports. |
| `src/core/process-identity.ts`, scoped `src/core/node.ts` adapters | Reuse batched creation-identity semantics and explicit context factories; do not weaken broker/session/admission guards. |
| Separate broker-role package if required | Independently owned elected-broker lifetime; larger scope needs explicit approval before parent-bounded backend shutdown. |
| New focused `test/mcp-runtime-*.test.ts` and controlled measurement harness | Channel, lifecycle, identity and failure fixtures; memory evidence without fragile exact-RSS assertions. |

Root and Claude review this design together with AB-268 context attribution
and AB-276's unimplemented authority proposal. Decide alternative, IPC/security
boundary, logical context contract, broker lifetime and measurement budget
before source authorization. Then implement one narrow isolated package,
run its focused tests/typecheck/build, obtain separately authorized controlled
Codex/Windows acceptance and compare baseline metrics. Publish one reviewed
immutable release only after integration review and owner authorization.

Remaining risks: unexplained host client multiplicity; native runtime internals
not inspected; unmeasured heap/private-memory costs; shim overhead; mutable
context migration; authentication/election races; reload/version overlap;
broker-host availability; and coordination with durable owner authority.
The design establishes reviewable boundaries, not host behavior or savings.
