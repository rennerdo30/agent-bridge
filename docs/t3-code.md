# T3 Code host adapter (experimental, opt-in)

AB-446 adds a scoped MCP HTTP adapter for session messaging and T3-owned tasks. It does not install, update or configure T3. Ordinary Bridge sessions retain their provider paths unless explicitly opted in.

## Prerequisites

The process starting the Bridge MCP server must deliberately supply:

- `AGENT_BRIDGE_HOST=t3`.
- `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` from that exact T3 caller's runtime environment.
- The normal underlying provider selection, such as `--agent=opencode`, `--agent=muse`, `--agent=claude` or `--agent=codex`. T3 is a frontend, not a new provider kind.

Never copy a scoped token into command arguments, URLs, Bridge configuration or logs. The adapter reads only these runtime environment variables. It does not inspect provider MCP configuration, credential files, T3 databases or session stores for credentials. Ordinary Bridge children, detached job runners and shared broker daemons strip the host selector and every `T3_ACP_MCP_*` variable, including extra environment overrides. Windows daemon creation also supplies the cleaned environment to its creation helper and the daemon's explicit environment block.

The endpoint must use HTTPS or literal loopback HTTP (`127.0.0.1` or `[::1]`). URL user information, queries, fragments, control characters and redirects are rejected. Each operation has a 15-second total deadline, an eight-page tool-discovery limit and a two-MiB HTTP response limit. Connections close after each operation; shutdown aborts outstanding requests. The MCP client's optional notification GET is disabled locally; there is no host watcher, SSE reconnection loop, polling job or terminal/CLI transport fallback.

Source evidence: upstream pin `67c0fc0cdaf963b103518862dd7b68a9c758ecf2`, `packages/provider-acp/src/server/adapter.ts:629-641,1435-1460` exports the scoped ACP transport into MCP-server and provider process environments. Actual inheritance into the Bridge subprocess is still a prerequisite. The audited app version was `0.1.1-nightly.20261019.3360`; the adapter feature-detects rather than relying on that version string.

**Native Codex is currently unsupported without new, deliberate upstream transport injection.** The audited native Codex shell has no `T3_*` environment. Its scoped T3 MCP token exists only in provider MCP configuration; Bridge never extracts it. Native Claude's injected SDK MCP configuration likewise does not establish inherited ACP transport. Having T3 tools in the model's tool list alone is insufficient for a separate Bridge server to call them. An explicit opt-in with absent, partial, expired, rejected or wrongly scoped transport refuses; it never silently switches to native Codex queue or Claude rewake.

## Identity and session delivery

Before the first Bridge registration, the adapter initializes MCP, discovers literal supported tools, reads `orchestrator_capabilities`, and checks that its `parentThreadId` agrees with `t3_thread_list.currentThreadId`. Every subsequent connection repeats negotiation and checks the original binding. A changed thread or provider instance refuses before effects.

Bridge keeps its usual provider `agent` and native `sessionId`. A separate `frontend` binding contains `kind: "t3"`, a digest of the scoped endpoint, the exact T3 thread ID and the inherited provider instance ID. It contains no authorization value or raw endpoint. Native `_meta.threadId` is never used as a T3 ID. `peers`, `health` and `t3_capabilities` expose this distinction. The frontend is present in the initial `helloT3`, and brokers without that operation refuse rather than silently discarding it. Hosted registrations, remembered names and project-main identity are isolated from other T3 threads and ordinary provider sessions, including when native IDs are absent or reused. A reconnect of the same bound frontend can replace its old server while retaining its new provider-native session ID.

Incoming Bridge mail uses the existing quiet-message, hop, direct-wake, auto-wake and awaited-reply policy. Eligible arrivals are coalesced into a pointer sent with `t3_thread_send` to the exact bound T3 thread in `queue` mode. The pointer carries stable Bridge IDs and asks the model to read its existing Bridge inbox; it contains no mail bodies. Its deterministic `clientRequestId` is reused for the same pointer. Native Codex queue, Claude channel/rewake, opencode notification wake and Muse/Antigravity hook delivery are suppressed in host mode.

T3 dispatch receipts describe `queued`, `started`, `steered` or `restarted` delivery. They do **not** prove that the model read Bridge mail. Wake acceptance never marks mail read. Only the existing authenticated inbox consumption path does that. Unknown dispatch outcomes remain explicit and are not retried automatically or sent through another route. Mail stays unread for a later inbox call.

Before dispatch, each coalesced pointer is retained in `t3-wakes-<binding digest>.json` in the explicit Bridge home. A protected metadata file lease serializes admission and the existing JSON writer atomically publishes/fsyncs it. The record retains the exact frontend binding, immutable message membership, payload, mode and request ID; it contains no credentials, raw endpoint or message bodies. Every reload/reconnect consults this journal before batching new arrivals. Accepted, unknown and submitted members are excluded from every later operation, even after partial inbox consumption. A crash after admission, or failure to store the final receipt, leaves a submitted record that is treated as uncertain and never automatically retried. Successful receipts and sanitized failure stages are retained separately from inbox consumption.

Failure to retain admission prevents dispatch. Corrupt, incompatible or wrongly bound journals stay at their original path and block automatic wake delivery. Journal errors stop that waker with an explicit logged reason. Capacity is 2,000 retained message memberships per exact frontend; reaching it refuses additional operations rather than deleting outstanding or accepted history. There is no automatic pruning/reset. Any future retention migration must preserve membership so unread mail cannot acquire a new operation ID. Manual inbox reads remain available while automatic wake is blocked.

Provider-native admission is retained. Codex still requires proven main-thread rollout lineage for Bridge tools; an ACP driver without that metadata is refused. Claude native child metadata and live mail scopes still restrict tools. Where native lifecycle hooks exist, hosted hooks may record the native session and child start/end, but never inject or acknowledge Bridge mail. This feature does not add an authenticated shared-MCP native-child transport: use T3-owned tasks for supported hosted delegation, and do not assume native children can use a parent's Bridge connection without existing caller attestation.

## Explicit host tools

These tools are registered only for an opted-in session with a verified host binding:

| Tool | Contract |
| --- | --- |
| `t3_capabilities` | Re-negotiate the scoped binding, supported tools, inherited settings and live composer provider/model/options catalog, including configured custom models. |
| `t3_delegate` | Supply `task` and a stable `clientRequestId`; optionally select a catalog `target` with `providerInstanceId`, `model` and option `{id,value}` entries. Always async, default `isolation: "worktree"`; optional `shared`, title, role and interaction mode. Runtime permissions inherit; no permission override is exposed. Bridge's local depth gate and T3's own provider/permission/ownership gates remain. |
| `t3_task_status` | Read an app-owned `taskId` when its result is needed mid-turn. Preserve `childThreadId`, original run, descendants, pending questions, original summary, later terminal result and `workState` separately. Reading terminal results acknowledges T3's automatic parent delivery. |
| `t3_task_cancel` | Supply `taskId`, stable `clientRequestId` and optional reason. T3 handles cancellation, including later child turns. A terminal published result may stay terminal. No OS process or Bridge job is stopped. |
| `t3_send` | Supply `message`, stable `clientRequestId`, optional `mode` (`queue` by default; also `auto`, `steer`, `restart`). Omit `taskId` to address the exact bound caller thread. Child sends use only the local task-to-thread map learned by successful explicit `t3_delegate`/`t3_task_status` calls; send never calls upstream task status. Unknown mappings refuse and instruct an explicit `t3_task_status` read, which returns the acknowledged result to the caller. The bounded map may require that explicit read after reload or eviction. Arbitrary thread IDs are not accepted. |

Effects use a six-tool literal upstream allowlist: capabilities, current-thread listing, thread send, delegate, task status and task cancel. There is no anonymous RPC passthrough or top-level thread-launch tool. Result schemas and `isError` are checked; transport/error response text is never passed through. An effect whose result is missing, malformed, rejected or mismatched is reported as **outcome unknown**. Retain its request ID and inspect T3 before deciding on any retry; use a fresh ID only for a new operation. Independent review rounds use a fresh `t3_delegate` operation and ID with full context.

These tasks belong to T3. They are not `JobManager` jobs, do not occupy Bridge job slots, are not listed as Bridge subagents and do not create Bridge completion/read receipts. T3 supplies its own admission and automatic completion notifications; end the turn rather than polling. For pending child questions use T3's pending-request tools or the owner. Existing `ask_*`, `spawn_*`, `message_subagent` and related tools continue to mean ordinary Bridge jobs, with host environment removed from their children.

## Verification boundary

`test/t3-code.test.ts` contains only offline fixtures: SDK HTTP replay, schema and wrong-parent refusals, unknown effects, custom catalogs, T3 task handles, native admission/depth guards, durable wake reload/read receipts, persistence failures/corruption/capacity, child and mocked daemon environment cleanup, explicit child-result reads and isolated broker registration/recovery. The initial identity assertion failed on base `4277dc248013b8bc158ac3166974a6c0b07b464f`; accepted/unknown reload, daemon inheritance and implicit-result-acknowledgment regressions failed on reviewed head `ee1b6144a652ec437140b34d623324c69c97cd08`.

Live host acceptance is **NOT RUN**: no provider/ACP session was launched, no live message was sent, and no T3 task was delegated or cancelled to validate this implementation. The parent owns live ACP inheritance, exact-thread idle/busy wake, permission refusals, restart/reload identity and child completion/question/cancellation acceptance. A focused test or typecheck is not that evidence.
