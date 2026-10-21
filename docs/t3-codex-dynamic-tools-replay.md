# AB-458 dynamic-tool replay and disposal correction

Round-two review follow-up: use the [private RPC admission and production adapter test package](t3-codex-private-rpc-admission.md) for further review. The artifact below does not protect replay ahead of the protocol's 32-handler cap, and its manually wired transport candidate is not production adapter coverage.

Status: correction artifact for independent native design review `AB45842181`, awaiting parent review. **Default-off; no production connector, installed modification or native acceptance.** This supersedes the replay/disposal behavior of the first [private dynamic-tool artifact](t3-codex-dynamic-tools.md); the earlier artifact and receipts are preserved.

Bridge docs input: `9e3a1baf10359f04d4c97fd1240f88c3593cd598`. Original parent base `70820a0fd090bd12f8245e9cf7e51db13a78eef0` remains an ancestor. Source pins remain T3 `968dd51704441138559a3fe9c348719f2b11e0c6` and official Codex `6203846fb3ef040f62eed9b35bc6629c8e88980a`. Nothing here changes the private-stdio-only trust conclusion or existing T3 MCP child-borrowing limitation.

## Why the correction is necessary

Codex [outgoing_message.rs:463-481](https://github.com/openai/codex/blob/6203846fb3ef040f62eed9b35bc6629c8e88980a/codex-rs/app-server/src/outgoing_message.rs#L463) resends stored pending requests to a connection. [pending_requests_for_thread:599](https://github.com/openai/codex/blob/6203846fb3ef040f62eed9b35bc6629c8e88980a/codex-rs/app-server/src/outgoing_message.rs#L599) returns the original requests, while the response callback is removed on the first accepted response at [578-598](https://github.com/openai/codex/blob/6203846fb3ef040f62eed9b35bc6629c8e88980a/codex-rs/app-server/src/outgoing_message.rs#L578). Immediate duplicate denial could therefore settle the pending RPC while its first handler still sends or consumes a message. A separate timeout on each T3 request handler creates the same competing-settlement problem.

The first artifact's `close()` also awaited an unbounded port promise and returned immediately on later calls, including after failed disposal. Aborting admission is necessary but does not prove that the owned broker resource was released.

## Corrected call contract

- One immutable app/provider/provider-session/root lease owns the call table. The key includes app thread, provider instance/session, native thread, native turn and native call. The fingerprint includes namespace, explicit tool name and canonical exact arguments. Current tools permit only whitelisted string-valued fields, so sorted field/value tuples preserve exact values while ignoring JSON property order. No trimming, identity override or generic opcode is accepted.
- Reserve the entry synchronously before asynchronous admission. Identical in-flight requests await the same operation and receive its settlement; conflicting fingerprints refuse. There is one 10-second **operation** deadline, starting at first admission, never restarted by replay. The T3 handler no longer has an independent response timeout. A cancelled Effect waiter detaches; it does not create a new broker operation or competing denial for an admitted call.
- During temporary active-turn lookup absence, only an exact saved call may join its existing entry. It uses the captured original authenticated root/context guard. A new call without a current root context refuses. Explicit child/mismatched contexts refuse even when the key exists. Losing the original guard suppresses results; a replacement context/session never retargets the operation.
- Completed replay returns the original cached response only under that same live generation and captured active guard. At most 1,024 entries are retained, with at most 16,384 response-text characters each. Responses larger than that settle as sanitized failure. At capacity new keys refuse; entries are not evicted to permit re-execution. These are conservative prototype limits requiring production policy review.
- Timeout, abort, oversized response and uncertain port failure retain a failure settlement; replay never submits again. Late completion cannot overwrite it. The durable connector remains responsible for accepted/unknown/send-status semantics. Failure is not proof that no message was sent or read acknowledgment consumed.
- Revocation immediately aborts operations and clears cached responses before awaiting disposal. Pending promises carry no retained response value of their own. Delivery rechecks lifetime, root, port liveness and original active context. Another app scope, native child or replacement session cannot retrieve the cached private response. Nothing is persisted by this call table; restart/resume ownership restoration remains a separate reviewed design.

## Corrected disposal contract

`close(): Promise<BridgeDisposal>` is a non-async method returning one shared promise. It revokes admission synchronously, then attempts `port.close(freshCloseSignal)` once. That port method must release only its captured owned registration/connection. It must not close shared pools, foreign sockets, processes or replacement registrations.

The disposal result is exactly `{ status: "closed" | "failed" | "timedOut" }`. A 2-second deadline aborts the close signal and resolves `timedOut`; synchronous throw or rejection resolves `failed`. No raw exception or private diagnostic is returned. Later close calls receive the same promise/result, including after failure, timeout or late completion. No automatic disposal retry or falsely clean result is introduced. The finalizer logs the sanitized incomplete status; it cannot hang on the port's promise. Only the real connector can certify actual resource release. `failed` and `timedOut` mean unresolved ownership, requiring an app-owned cleanup receipt/quarantine path.

## Exact artifact and evidence

New directory: `E:/AgentData/reports/ab458-dynamic-tools-replay-20261022-t32af0942b`.

Final `t3-codex-dynamic-bridge.patch` SHA-256: `79db26fab48319995775b6b73f9a29071215fe594f8ca0c7991d21f2f8cae857`. It applies against the same pinned T3 preimage and changes five upstream files:

1. `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: optional port, scoped finalizer with explicit disposal-status warning, method-specific handler and raw experimental start registration. No composition supplies the factory; it remains absent by default.
2. `CodexBridgeDynamicTools.ts` in that directory: corrected shared call/disposal state, explicit messaging methods and unchanged root/child/lineage gates.
3. `CodexBridgeDynamicTools.test.ts`: original pure fixtures with completed-replay expectations updated.
4. `CodexBridgeDynamicTools.replay.test.ts`: genuinely suspended admission/effect/replay/close fixtures with a manual clock.
5. `CodexBridgeDynamicTools.transport.test.ts`: **unrun CI candidate** using actual pinned `CodexClient.make`, generated schemas, `makeInMemoryStdio`, Effect queues/fibers and response encoding.

| Recorded selection | PID / exit | Result |
| --- | --- | --- |
| New regression selection against preserved old implementation `cc759ab42c6ce3070211714becb84e403e98e65e7918cb218c9a531fadfc05bb` | 76404 / 1 | 6 failures out of the initial 10 regression cases; `red-receipt.log` |
| Final pure selection against corrected implementation `a8713533a7b93d49baf4703e0808460f917bc8ffbc99f99452ec92ac65434244` | 19244 / 0 | 26 passed; `green-v3-receipt.log` |
| Mutation: restore immediate denial for identical replay | 64712 / 1 | 5 failures; `mutation-coalesce-v3-receipt.log` |
| Mutation: later close returns falsely clean status | 59144 / 1 | 3 failures; `mutation-close-v3-receipt.log` |
| Exact upstream patch apply check | 74876 / 0 | `package-receipt.log`; nonempty diff generation exited 1 as expected |

Every own test/packaging child had a 15-second timeout and a recorded PID/exit; outer runners were bounded to 20 seconds. Deferred promises force the original operation to suspend before replay/revoke/close assertions. Manual clock expiration tests deadlines without sleeping or starting provider processes. Earlier intermediate receipts remain available; final artifacts use the `-v3` test receipts above.

`artifact-hashes.json` SHA-256: `e26877c82c44b98f4f29c6a5cab01befb4d10fce81dbc06e6a56c7d5c2eecda3`. It hashes the patch, implementation/tests, CI configs/runner, preparation scripts and source manifest. `green-v3-receipt.log` SHA-256: `5ec0940d167a0a967fc1d2b5c9943f0111fd9c265b2e55968f52ee9a4c71defe`. Eleven additional official public source blobs match the pinned T3 tree; the adapter preimage Git blob is `5c4df98d310d15437c3ca54366f807e0428b9107`.

`evidence-hashes.json` additionally hashes the red/green/mutation receipts and output, packaging receipt and local feasibility evidence. Its SHA-256 is `e2580034339af9229475ae3b1ea0dc7e2263264a9360fad8a883deb62c2d98a7`.

## Actual Effect/client feasibility and CI package

`local-feasibility.log` records bounded presence checks in the supplied Bridge worktree, canonical Bridge checkout and the two named public T3 checkout locations. Pinned Effect/client dependencies and `tsc-rs`/`vp` were absent there; `tsc`, `tsc-rs`, `pnpm` and `bun` were unavailable as commands. This is not a global disk search or an installed T3 runtime inspection. No dependency was installed, copied out of an installed app, or downloaded as a workaround.

Consequently **actual Effect/client replay and TypeScript checking were not run locally**. The 26 passing local fixtures use Node type stripping and substitute only the test-runner import. Their hand-written registration/client stand-ins do not execute the real Codex client, codecs, adapter or transport. Node syntax checks on the CI script and transport candidate passed; syntax checking is not compilation or a real transport test.

The prepared CI candidate uses the real exported [client.make:97](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/src/client.ts#L97) and existing [makeInMemoryStdio:24](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/src/_internal/stdio.ts#L24), following upstream [protocol.test.ts](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/src/protocol.test.ts). It sends experimental raw `thread/start`, decodes the actual start response, injects two identical pending `item/tool/call` requests with the same request ID while a send is suspended, then verifies one effect and identical encoded replies. It also checks a native child receives its own denied response. The peer is JSONL over queues; no child/provider process is launched. This tests the real client boundary when run; it does not simulate all of T3's actual session-manager/adapter warm-resume lifecycle or a live Codex server.

Copy the artifact to an approved disposable Linux CI workspace with a clean public T3 checkout at the exact pin and lockfile-provisioned dependencies. Then run:

```sh
CI=true AB458_CI_OWNED_CHECKOUT=1 node /work/ab458-artifact/run-ci.mjs /work/t3code-pinned
```

The runner rejects the owner Windows PC, wrong pin, dirty checkout, wrong provisioned pnpm or Effect version, and changed artifact hashes. It performs no install, tool update, provider launch or environment-file loading. It records child PIDs/timeouts/exits, applies the exact patch only in the explicitly supplied disposable checkout, then runs:

```sh
pnpm exec tsc-rs --noEmit -p .ab458-ci.typecheck.json
pnpm exec vp test run --config .ab458-ci.vitest.config.ts
```

The typecheck includes the patched adapter plus the new modules and their transitive types. The standalone test config selects only the three Bridge test files, one worker, with test/hook timeouts, and avoids T3's app build/environment-loading Vite config. Root [package.json](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/package.json) specifies Node 24, pnpm 12.14.0 and `tsc-rs`; [pnpm-workspace.yaml](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/pnpm-workspace.yaml) pins Effect 4.0.5. The runner requires already provisioned dependencies and never falls back to fetching them. It allows 120 seconds for typechecking and 90 seconds for focused tests on CI. Full suites remain a separate CI gate. This candidate has not been submitted or executed on CI.

## Production connector requirements still open

Parent review and real client/typecheck results precede integration or enablement. The optional factory must remain absent until the following have an implementation and evidence:

- **One owned port per app/provider-session generation.** The factory must capture environment, app thread, provider instance/session and an opaque immutable broker registration generation. The private native root comes only from the owned start response. A reused socket or auto-reconnect must not retarget old calls, cached results, recipients or cleanup. `isLive` is a synchronous, nonthrowing view of that exact generation, not the latest registration found by app ID.
- **Atomic admission and durable effects.** Keep Bridge native-main lineage admission, destination ownership, depth/hop guards and durable message IDs/read acknowledgments/status. Port methods must check the supplied guard and captured registration at the actual effect boundary, not only before an awaited queue/reconnect. A late completion after timeout/revoke is unknown and must not auto-retry. The private-channel origin tuple must never be replaced with an HTTP claim or tool argument.
- **Explicit owned disposal and unresolved-resource accounting.** `port.close(signal)` is idempotent for its captured resource, honors cancellation/deadline where possible and resolves only after release is verified. Failed/timed-out disposal is recorded by the app lifecycle owner for scoped cleanup/quarantine; a later replacement cannot turn that receipt into success. Closing a shared pool, foreign process, newer frontend or replacement registration is forbidden. The prototype's sanitized finalizer warning is not the production cleanup ledger.
- **Lifecycle and replay continuity.** Wire revocation, detach, provider termination, app shutdown and registry authorization loss to the same owned generation. Use the reviewed reservation/replacement rules in `ProviderSessionManager.ts` and `McpSessionRegistry.ts` identified in the previous contract; do not conflate credential reuse with broker ownership transfer. Prove warm-resume active-context continuity, lost-response replay, settled-turn cache invalidation and actual timeout cancellation in T3. Persisted schemas cannot reconstruct a live binding or pending operation after restart.
- **Scoped callbacks and native acceptance.** Keep wakes/task actions host-owned through existing scoped services, absent from these five provider tools. Prove root success, inherited-child refusal, two app scopes, revoke during admission/submission, disposal failure/timeout and replacement non-retargeting against the real connector and approved runtime. Existing T3 MCP child borrowing remains separate. No new Codex primitive is required for the inspected private stdio route; app-owned Bridge connection/lifecycle support and upstream T3 integration are still unavoidable.
