# AB45842190: private RPC admission and production adapter test package

Status: **review artifact, default-off; mandatory upstream typecheck/CI not run**. This corrects the protocol admission and test-coverage gaps in the [previous revision](t3-codex-dynamic-tools-replay.md). Earlier artifacts, hashes and receipts are preserved. It does not close either review finding with runtime evidence or claim native acceptance.

Bridge docs input is `ec6d9d3ccdefcbfce680864874dfc130023e4548`, descending from parent base `70820a0fd090bd12f8245e9cf7e51db13a78eef0` (ancestor check exit 0). Exact source pins remain T3 `968dd51704441138559a3fe9c348719f2b11e0c6` and Codex `6203846fb3ef040f62eed9b35bc6629c8e88980a`. No installed application, dependency, provider/runtime copy or credentials were inspected or modified.

## Ownership, compatibility and required upstream change

The affected [packages/effect-codex-app-server/package.json](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/package.json) declares **`effect-codex-app-server`, private workspace source, with no package version**. It belongs to T3's monorepo; this is not a patch to Effect, an installed dependency or the Codex runtime. Its [client.ts:196-205](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/src/client.ts#L196) always passes its typed request dispatcher as `onRequest` to the package's own protocol. No `client.ts` API change is needed for this candidate.

The exact compatible **source/provisioning target**, rather than an installed-version assertion, is:

| Component | Target at the pinned T3 source |
| --- | --- |
| T3 app and private protocol workspace | `968dd51704441138559a3fe9c348719f2b11e0c6`; public app manifest `t3` version `0.1.1` |
| Codex implementation inspected | Source `6203846fb3ef040f62eed9b35bc6629c8e88980a`; installed binary/version not probed |
| Effect / platform-node / test integration | `effect`, `@effect/platform-node`, `@effect/vitest`: each `4.0.5` |
| TypeScript / compiler | Catalog TypeScript `7.0.2`; root `tsc-rs` `0.7.0`, the workspace's `--noEmit` compiler |
| Test runner | `vite-plus` `1.3.0` |
| CI Node / package manager | Exactly Node `24.13.1` and pnpm `12.14.0` in this runner; root engine is `^24.13.1` |

Versions come from the pinned [root manifest](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/package.json), [catalog](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/pnpm-workspace.yaml) and [app manifest](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/apps/server/package.json). Thirteen copied public source files were verified against that pinned Git tree. No package installation/update was performed. The owner must build/review the T3 workspace changes together; copying a patched file into an installed app is excluded. No new Codex protocol primitive or Effect library change is proposed.

## Request admission before the cap

Pinned [protocol.ts:305-322](https://github.com/pingdotgg/t3code/blob/968dd51704441138559a3fe9c348719f2b11e0c6/packages/effect-codex-app-server/src/protocol.ts#L305) checks the 32-handler cap before invoking T3's typed handler. That is earlier than helper coalescing. A replay at the cap can therefore emit an overload error under the original RPC ID while its original effect is still running. Codex [outgoing_message.rs:463-481](https://github.com/openai/codex/blob/6203846fb3ef040f62eed9b35bc6629c8e88980a/codex-rs/app-server/src/outgoing_message.rs#L463) resends the stored original request, including its ID.

The correction adds a **per-protocol-instance, synchronous managed-request admission table** before queue publication, cap evaluation and handler/fiber allocation. It applies to the actual `CodexClient` managed dispatcher path. The optional passive raw-observer mode with no `onRequest` remains unchanged; it is not the path used by the T3 client or this adapter.

- Keys preserve JSON-RPC ID type (`1` and `"1"` differ). Fingerprints cover method and canonical params, including omitted versus explicit null. An incremental SHA-256 hash of sorted JSON object members avoids retaining private params/results; arrays and exact scalar values preserve their order/value. No identity field is accepted from tool arguments as a scope override.
- An identical pending replay is dropped before the cap. It allocates no second handler, promise waiter, queue entry or response. The original handler retains sole ownership of its response. A changed method or payload under the same ID is also dropped, classified as conflict. **No same-ID error is emitted**, since that could steal the legitimate original callback. Fresh calls at the 32-handler cap receive their own one-time overload error without starting an effect.
- After settlement/cancellation, the ID becomes a tombstone for this connection generation. Same-ID replay never re-executes and never emits a second response or cached private payload. The original response is emitted once on the same reliable private stdio stream. This is deliberately not a generic reconnect/lost-network-response protocol. Write failure/shutdown ends the generation; outcomes remain unknown and are not automatically re-executed in a new connection. The existing app helper still protects native call identity if a separately admitted RPC reaches it.
- At most 32 managed handlers and 1,024 identity records exist per protocol instance. Records store bounded ID text and fixed-size fingerprints, never results; there are no per-replay fibers or retained duplicate waiters. IDs above 512 characters, canonical JSON depth above 128, or record exhaustion close this transport admission explicitly. Records are never evicted to turn an old operation into a fresh one. The existing 128 MiB wire-frame bound remains unchanged. These conservative connection-lifetime limits require explicit upstream acceptance before deployment; this package does not auto-restart a provider or silently rotate a session.
- Handler `ensuring` releases only its own ticket. An interruption that emits no response terminates this connection generation, avoiding an unanswered tombstone on a live channel. Scope finalization and termination close admission and clear the table. Outgoing writes check that the same protocol is still open. Late handler completion cannot reopen the table or affect a replacement protocol instance. Pending Bridge operations/disposal retain the previous immutable-generation and no-retry contract.

The scope is the already-owned **private stdio connection**, not unsigned HTTP metadata or a provider-visible credential. Shared multi-client listeners remain outside the proof. Generic broker opcode forwarding and delegation authority remain absent.

## Actual production adapter CI test

The replacement `CodexBridgeDynamicTools.adapter.test.ts` constructs **`Adapter.makeCodexAdapterV2`**, injects only mocked services/Bridge port and the real `CodexClient.make` over T3's `makeInMemoryStdio`, and invokes the returned runtime's `ensureThread`, `startTurn` and `resumeThread`. It never calls `client.handleServerRequest("item/tool/call")`, `session.dispatch`, or a test-side dynamic-tool registration equivalent.

The queued fake peer supplies only expected initialization/thread/turn metadata responses. Production code owns dynamic registration, handler installation, active-turn state and response encoding. The candidate:

1. Asserts the actual outbound production `thread/start` includes the five dynamic tool specs.
2. Waits for production `provider_turn.updated` to establish the root, then holds 32 actual production messaging handlers on deferred mock-port effects.
3. Calls actual `runtime.resumeThread`, injects the original pending RPC frames, changed params/method under an original ID, and one fresh over-cap call. A private input marker confirms the preceding frames passed admission. It asserts no early original-ID response and exactly one fresh-ID overload response.
4. Releases the 32 effects, asserts their actual encoded success responses occur once, and tests completed same-ID replay without another effect/response.
5. Sends native child-discovery and turn-start notifications through production handlers, waits for the child's real provider-turn event, and asserts child/mismatched/unknown-turn calls cannot enter the port.
6. Injects a genuinely deferred mock broker timeout/failure and replay, checks one failure settlement/no re-execution, then closes the real owned Effect scope during another suspended operation. Late mock data must not be emitted. The previously recorded pure manual-clock tests separately check the exact shared 10-second call/2-second disposal deadlines; this candidate does not claim that simulated broker failure is the real timer expiring.

After a successful pinned typecheck and baseline, the CI runner makes three separate, restored mutations: remove the **production adapter handler**, remove **production registration**, and move protocol cap rejection ahead of replay lookup. Each must fail the true adapter test. Handler removal has an explicit premature-response assertion; registration removal fails the outbound-spec assertion. These are prepared expectations, **not recorded mutation passes**. The previous manually wired transport test is not included in this exact patch/config.

## Package and bounded evidence

Directory: `E:/AgentData/reports/ab458-dynamic-tools-admission-20261022-t32af0942b`.

Final `t3-codex-dynamic-bridge.patch` SHA-256: `e0b3c5ba6357eaf656aed86f8980b7a83338617efabbc4c4e0ce0d583e348f61`. It changes exactly eight upstream files: the adapter, Bridge helper, its two pure test files, the new true adapter test, `packages/effect-codex-app-server/src/protocol.ts`, and new `PrivateRequestAdmission.ts` / `.test.ts`. It contains no app composition enabling the optional port and no production broker connector.

Recorded local evidence:

- **31 pure fixtures passed**, PID `4280`, exit `0`: the unchanged 26 helper fixtures plus five admission-policy fixtures. They execute the real pure modules with Node type stripping, substituting only the test-runner import. They do not execute Effect, `CodexClient`, `protocol.ts` or the adapter.
- Moving cap rejection before replay lookup caused **2/5 admission-policy failures**, PID `70400`, exit `1`. This is a pure-module mutation, not the pending CI production mutation.
- Final patch apply-check PID `73188`, exit `0`; nonempty patch generation exit `1` expected. Syntax checks of the protocol/CI adapter candidate/runner exited `0`. Syntax is not typechecking or module execution.
- Test/packaging children were bounded to 15 seconds with own PID/exit receipts. `local-receipt.log` preserves the pure run; `package-receipt.log` describes the final CI-candidate-only packaging refinement without rerunning unchanged passing pure tests.
- `artifact-hashes.json` SHA-256: `d18e0825f4b27a4527a1e8c09054307742d4fc24f72cd963a431c7a90dc197be`. `evidence-hashes.json` SHA-256: `1fe93cb8d1088296dfd3e15dbf49343918f6bb452bba34d5505d56faf2cd41bf`. They cover the final patch/source/scripts and local receipts/output/feasibility checks respectively. Previous revision directories remain intact.

## Mandatory CI and remaining owner implementation

Bounded checks again found no provisioned Effect/compiler/test-runner dependencies in the named checkout locations, and no `pnpm`, `tsc-rs` or `tsc` command. `local-feasibility.log` records the exact locations; this was not an installed runtime/config inspection or global dependency search. No dependency was installed or harvested. **The exact upstream typecheck, real production adapter/protocol tests and three production mutations remain NOT RUN and mandatory.** Neither review finding is presented as runtime-closed.

Transfer a copy of the artifact to the parent's approved disposable, already-provisioned Linux CI workspace and run:

```sh
CI=true AB458_CI_OWNED_CHECKOUT=1 node /work/ab458-artifact/run-ci.mjs /work/t3code-pinned
```

The guarded runner rejects the owner Windows PC, wrong/dirty pin and wrong provisioned Node/pnpm/Effect. It installs nothing, loads no environment file, launches no provider, checks hashes and applies the patch only to the explicitly supplied disposable checkout. It runs `pnpm exec tsc-rs --noEmit -p .ab458-ci.typecheck.json` (120-second bound), then `pnpm exec vp test run --config .ab458-ci.vitest.config.ts` (90-second bound), then each restored production mutation (45-second bound). Only the four Bridge/admission test files are selected, one worker; full suites remain a separate CI gate. The actual adapter's transitive types and actual protocol/client sources are included in typechecking. No CI submission or result is claimed here.

Owner/parent action is limited to reviewing/building these **T3-owned** workspace changes, accepting the explicit connection-lifetime/replay policy, and implementing the still-missing generation-pinned app-owned Bridge connector/lifecycle contract. That connector must retain atomic durable admission, main lineage/ownership/depth guards, exact recipient binding, bounded owned disposal with unresolved-resource accounting, and scoped revocation/host callbacks. Real warm-resume/root-child/close/native acceptance and existing T3 MCP child borrowing remain open. No Codex runtime patch, Effect library patch, installed dependency edit, release, PR or enablement is authorized or performed by this package.

## Tracked hosted follow-on (round-three review)

The historical package and receipts above remain unchanged. The owner authorized
the separately reviewable hosted package at
[`scripts/t3-native-integration`](../scripts/t3-native-integration/README.md),
including a path-filtered PR-only Linux workflow. It preserves the exact original
patch and applies separately hashed disposal-test and round-three corrections in
the manifest's order. Review must cover the effective combined ten-file upstream
diff, runner, and workflow. Parent opens/links the PR; this child does not trigger CI.

The old adapter candidate observed outgoing pre-write logger events; those were
not delivery evidence. The follow-on captures decoded frames at the actual private
writer boundary and asserts the correlated RPC ID and full result. It replaces the
20-yield close loop with explicit bounded disposal/completion waits. Additional
protocol tests exercise committed-effect writer failure, handler defects, ordinary
managed approvals, pre-handler admission exhaustion, and shutdown. Mutation gates
require their named assertion in a structured executed-test report; an arbitrary
exit 1, timeout, import/collection/setup failure is not accepted as proof.

Offline package checks, layered application, syntax, and validator tests are
distinct from the mandatory **NOT RUN** pinned upstream typecheck, real production
adapter/protocol tests, and production mutations. No local dependency install,
provider launch, installed modification, hosted workflow invocation, PR, or native
acceptance occurred. The all-managed-request lifetime budget and the still-missing
transport-terminal-signal-to-broker-revocation interface require upstream review
before production enablement. The tracked README records exact hosted commands,
tool/source pins, evidence boundaries, and connector ownership requirements.

## PR #140 round-four and first hosted failures

Parent opened [PR #140](https://github.com/rennerdo30/agent-bridge/pull/140).
The `430e3eec` hosted run reached the pinned upstream typecheck and failed eight
errors before executing tests. The follow-up replaces synchronous schema decode
inside Effect, ambient timers, unsafe JSON indexing, schema `instanceof`, unknown
error-channel flips, native crypto import, and the collapsed admission union.
Effect Crypto is explicit in the protocol/client/replay service requirements;
production and replay factories capture/provide it. Admission remains serialized
before the cap and rechecks revocation after asynchronous hashing.

Round-four review also found that a suspended defect handler could interrupt
itself while closing its own scope before publishing termination. Publication is
now attached atomically to a protocol-owned fiber, with interruption-safe one-time
claim, pending settlements, bounded callback and subsequent forked handler cleanup.
A native-Promise suspension regression holds a sibling finalizer while asserting
notification and pending failure; a fifth hosted mutation restores the old order.
It must produce the named assertion failure rather than a timeout or setup error.

The Windows Bridge typecheck failures were package isolation failures: its source
glob included the upstream Vitest config. That file is now a non-TS data template;
the runner materializes the exact original upstream bytes/hash. No Bridge source
exclusions or upstream dependencies were added. A bounded local Bridge typecheck
passed using its unchanged config, all source roots, and exact existing canonical
dependencies through read-only junctions in an owned report mirror. No dependency
was installed. Revised upstream typecheck, actual Effect/client/adapter tests and
five production mutations still require the next hosted run and independent review.

## PR #140 second hosted typecheck correction

At `76cf1a9ae4b6ab09d3952353ab91de008657735d`, hosted run `39700140843`
/ job `119567110900` reached actual pinned typecheck and failed 15 error diagnostic
lines before tests, rather than timing out. Crypto leaked through the shared
provider client constructor into snapshot, driver, managed-provider and reset-credit
APIs, and through the replay testkit's factory. The Crypto mock also confused the
Effect-valued service method with `Crypto.make`'s synchronous primitive callback.

The revised artifact provides pinned `NodeCrypto.layer` locally at the existing
T3 Node client-construction sites and the replay testkit. It supersedes the prior
factory capture/propagation approach without changing public provider contexts.
The portable protocol/client/replay input remains explicit. Primary source proves
that the layer is stateless and its digest is an `Effect.try`; `Layer.provide`
discharges the Crypto input while existing client scopes still own lifecycle.
No platform dependency is added to the portable protocol package. Existing T3
server platform dependencies suffice. No driver or managed-provider file changes
are required. All inspected source paths and hashes are bound in the manifest.

The mock now returns synchronous bytes. A new Deferred-controlled digest fixture
interrupts after real suspension and asserts that no ticket/active slot survived;
the existing revocation fixture prevents insertion into a closed generation.
Wire admission remains serialized before the handler cap, with no extra digest or
replay fibers. Replay/disposal/terminal-publication policies and all five required
production mutations remain intact. Earlier patch/manifest/tree/log hashes remain
historical receipts in the manifest's revision chain and preceding commits.

The new effective upstream artifact still requires fresh independent review and
actual successful hosted typecheck, production tests and mutations. Offline source,
application, syntax and validator checks cannot establish those gates or native
acceptance. No provider launch, install, runtime modification or enablement occurs.
