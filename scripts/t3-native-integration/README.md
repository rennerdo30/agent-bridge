# AB-458 pinned hosted gate

Follow-up for parent review on PR #140. The `76cf1a9a` hosted run
`39700140843` / job `119567110900` reached actual pinned typecheck and failed
15 error diagnostic lines from missing Crypto contexts and the Crypto mock API;
tests/mutations were not reached. This was not a timeout. That failure and the
earlier `430e3eec` failures remain recorded in the manifest. This revised upstream
artifact has not run on hosted CI; no native-session acceptance is claimed.
The feature remains unconnected/default-off. This package changes no Bridge runtime
code and never starts a provider. Parent reviews the **combined** patch and watches
the existing PR; this workflow has no push, dispatch, release, or publish trigger.

## Inputs and application order

Official public T3: `pingdotgg/t3code` at
`968dd51704441138559a3fe9c348719f2b11e0c6`. The protocol package is the private,
unversioned workspace `effect-codex-app-server`, owned by that T3 repository; do not
substitute an npm package. Codex protocol source previously inspected:
`6203846fb3ef040f62eed9b35bc6629c8e88980a`; no Codex binary is needed or installed.

Apply these files, in order, to the exact clean T3 commit:

1. `01-reviewed.patch`: unchanged historical eight-file artifact,
   SHA256 `e0b3c5ba6357eaf656aed86f8980b7a83338617efabbc4c4e0ce0d583e348f61`.
2. `02-disposal-test.patch`: separately authorized test-only compliance correction.
   Awaits explicit scope disposal and completion of the late broker callback, with
   Effect deadlines; removes the 20-yield loop. Original shutdown assertions remain.
3. `03-round3.patch`: current effective correction, including round-four terminal
   publication, both hosted typecheck corrections, actual encoded-wire observation,
   exact response assertions, and focused real protocol lifecycle regressions.
   The preceding revision's patch/manifest/tree hashes remain in `priorRevision`;
   exact prior bytes remain in commits `430e3eecd9cbb2b38ee5d5f7eec895236249bc2d`
   and `76cf1a9ae4b6ab09d3952353ab91de008657735d`.

`manifest.json` binds each patch/config/runner, public source preimages and lockfile,
tool versions, and every changed/new effective upstream source file. Its effective
tree digest covers those files, not the entire upstream repository. The commit pin
identifies the rest. Receipts bind the manifest digest, application order, and
effective tree before testing and after every mutation restoration. Historical
reports and hashes remain at their original paths; they are not hosted evidence.
`offline-evidence.json` is the compact local receipt: source Git-blob verification,
actual local Node/PIDs/exits, and explicitly unrun hosted/runtime gates.

The effective upstream changes are the original eight files plus
`packages/effect-codex-app-server/src/errors.ts` and
`packages/effect-codex-app-server/src/PrivateProtocolLifecycle.test.ts`,
`packages/effect-codex-app-server/src/client.ts`,
`packages/effect-codex-app-server/src/replay.ts`,
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts`, and
`apps/server/src/provider/CodexProvider.ts` (fourteen effective files).
The portable client/protocol/replay layers retain their explicit Crypto input.
T3's two Node client factories, shared provider client-construction boundary and
replay testkit supply `NodeCrypto.layer` with `Layer.provide` inside their existing
scoped client construction. Public provider contexts and factory `open` signatures
are unchanged; no Crypto requirement is added to driver/managed-provider APIs.
Tests are inside the patches so there is one authoritative fixture copy.

## What executes on the hosted runner

The path-filtered PR job uses `ubuntu-24.04`, read-only contents permissions,
SHA-pinned checkout/setup-node/upload actions, and a 25-minute job bound. JSON syntax
in the `.yml` file is the YAML 1.2 JSON subset, allowing an offline syntax check
without installing a YAML parser. No secret inputs or persisted checkout credentials.

```sh
node scripts/t3-native-integration/run.mjs --verify
node --test scripts/t3-native-integration/gate.test.mjs
node scripts/t3-native-integration/run.mjs --hosted
```

The last command refuses execution outside GitHub-hosted Linux x64 with exact
Node `24.13.1`. It creates a new checkout below `RUNNER_TEMP`, anonymously fetches
the public commit, verifies source hashes, applies all three patches, and verifies
the effective tree. It downloads the official pnpm `12.14.0` Linux executable
archive using the manifest's SHA512 integrity; no global install or PATH write.
Child processes get a small public environment and a scratch HOME, not Actions,
provider, npm, or Git authentication variables. Git ignores system/global
configuration; no author, credential, or persistent Git settings are written.

Exact hosted install command (absolute pnpm/store paths are runner-owned):

```sh
pnpm --filter @t3tools/monorepo --filter 't3...' --filter 'effect-codex-app-server...' \
  install --frozen-lockfile --store-dir "$SCRATCH/store"
```

Root `prepare` runs upstream's `effect-tsgo patch && vp config --no-agent` normally
in this disposable runner checkout. Workspace `allowBuilds` and committed dependency
patches remain upstream's exact policy. No lifecycle bypass, system-package install,
secret fallback, reference-repo import/edit, or provider executable invocation.
The server dependency closure includes web/shared packages needed by its imports;
mobile/desktop/infra workspaces are not selected. Native dependency failure is a
gate failure, never permission to weaken the install policy.

Exact typecheck and focused test commands, from the patched T3 root:

```sh
pnpm exec tsc-rs --noEmit -p .ab458-ci.typecheck.json
pnpm exec vp test run --config .ab458-ci.vitest.config.ts \
  --reporter=json --outputFile="$EVIDENCE/baseline.json"
```

These use T3's locked Effect/platform-node/vitest `4.0.5`, TypeScript `7.0.2`,
tsc-rs `0.7.0`, effect-tsgo `0.51.1`, and Vite+ `1.3.0`. The standalone config
is stored here as `ci.vitest.config.ts.template`, outside Bridge's TS source glob.
Only the pinned upstream runner materializes `.ab458-ci.vitest.config.ts`; it
verifies identical SHA256 `43b4ab80ef6e94cc2b4306acc4975f59602314b35ad008066cf499da7a5b6ac3`.
No upstream dependency is added to Bridge and no source checks are excluded.
The standalone config
avoids repo environment loading and runs one worker. It includes the actual pinned
upstream `protocol.test.ts`, new protocol lifecycle/admission tests, and the three
Bridge helper/production adapter test files. No full suite, app/server process,
native Codex process, broker, or live credential is used.

The production adapter fixture instantiates `makeCodexAdapterV2` and actual
`Client.make` over in-memory private stdio. The fake peer only answers provider
requests; it does not register handlers or dispatch Bridge calls. Registration,
root/child/turn tracking, warm replay at 32 suspended handlers, fault, and close go
through production wiring. Delivery assertions decode the real writer output;
incoming logger markers only synchronize reading and are followed by a real wire
barrier. Late mock completion after explicit disposal cannot emit a private reply.

Four adapter mutations remove the production handler, remove registration,
move cap rejection before replay lookup, and corrupt an encoded response. Each runs:

```sh
pnpm exec vp test run --config .ab458-ci.vitest.config.ts \
  --reporter=json --outputFile="$EVIDENCE/mutation-NAME.json" \
  apps/server/src/orchestration-v2/Adapters/CodexBridgeDynamicTools.adapter.test.ts \
  -t 'AB458 production admission: actual adapter registration, 32-limit warm replay, roots, fault and close'
```

Each must execute the intended production testcase, exit 1, and fail exactly its
named assertion (`AB458_HANDLER_MUST_SUSPEND32`, `AB458_REGISTRATION`,
`AB458_REPLAY_MUST_REMAIN_PENDING`, `AB458_WIRE_RESULT`). Baseline must first pass
all selected tests. Empty collection, import/setup/syntax/worker/unhandled errors,
timeouts, wrong assertions, and unexpected failures are inconclusive gate failures.
The runner restores exact bytes in `finally`, verifies all effective source hashes,
and records base/mutation hashes, testcase, PID, timeout, exit, and report digest.
This is evidence qualification, not an assertion that the prepared tests pass.

A fifth mutation restores the old in-handler terminal-publication order and runs
the real protocol regression from `PrivateProtocolLifecycle.test.ts`, selecting
`AB458 real protocol lifecycle publishes suspended-handler termination before owned cleanup completes`.
It must fail `AB458_SUSPENDED_TERMINAL_PUBLICATION`, not hang or fail collection.
The regression holds the defect handler on an unresolved native promise, awaits
its entry and a second handler from the parent, then releases the defect after
suspension. It holds the second handler's finalizer until notification and pending
app-request failure are asserted. There are no yield loops or sleeps.

## Scope and remaining production requirements

Transport replay admission applies to **all managed server requests**, even with no
Bridge port. This is deliberate: a reused RPC ID with a changed method cannot be
allowed to settle another handler's original callback. It retains the existing
32-active-handler cap but adds a 1,024-record generation budget, 512-character ID
bound, and JSON-depth bound. Budget exhaustion closes the generation; no eviction,
payload caching, waiter-per-replay, or uncertain re-execution. These are new global
compatibility constraints requiring upstream review, including long-session UX.
The pinned non-Bridge protocol regressions and typed-error/approval/shutdown tests
must pass. Passive no-handler/raw-observer mode retains its existing routing.

Admission uses the declared platform `Crypto` service's SHA-256 Effect, serialized
on the private reader before the handler cap. Canonical bytes are temporary and
bounded by the wire frame; records retain only digests. Closure is rechecked after
hashing, and a suspended-digest revocation regression prevents ticket resurrection.
Crypto failure remains fail-closed. Promise-port timers use the app's captured
Effect Clock, preserving the 10-second operation and 2-second disposal bounds;
no ambient JavaScript timer is called.

Pinned primary APIs are also hashed in `sources`: Effect `Crypto.ts` / `Layer.ts`
and platform node/node-shared `NodeCrypto.ts` / `NodeServices.ts`. `Crypto.make`
requires a synchronous `randomBytes(size): Uint8Array` primitive and an Effect
digest. The Node layer is stateless `Layer.succeed`, with digest implemented by
`Effect.try(createHash(...))`; constructing it launches nothing and owns no foreign
resource. `Layer.provide` removes Crypto from the construction input; `Layer.build`
still uses the existing client scope. Portable callers/tests may supply controlled
asynchronous digests. The wire reader awaits admission serially before forking a
handler, so digest suspension creates no replay handler or concurrent ticket race.
Cancellation before digest completion inserts no ticket, and closure is rechecked
after suspension. Cancellation and revocation fixtures exercise these two cases;
their real Effect execution still awaits hosted CI.

Writer failure, response-encoding failure, handler construction throw, and handler
defect seal admission and terminate the generation. Pending app requests fail;
later writes/reforwards fail; replay/fresh input cannot resume an uncertain effect.
Typed handler errors still produce ordinary error replies. Shutdown/interruption
uses the input-ended category, separate from defect/write categories. Classification
has an Effect deadline; admission is sealed before it can suspend. A protocol-owned
fiber publishes the one-time failure, pending settlements, reader signal and bounded
notification in an interruption-safe operation. Only then is cleanup forked for
the captured handler scope; publication cannot interrupt itself by closing its own
handler scope. Notification/cleanup failure is not a clean CI result.
Arbitrary uninterruptible foreign finalizers are not
proven bounded by this package and require upstream lifecycle review.

Production still requires the T3-owned connector service: one captured broker
registration/connection per app/provider session, immutable root lease, existing
Bridge native-lineage admission at each effect boundary, atomic scope/generation
checks, unique messaging tools only, durable message-ID/outcome policy, revocation
without retargeting, and owned bounded cancellation/disposal. No task/delegation
opcode is forwarded. Wakes/task actions remain host callbacks through already-scoped
services. The HTTP T3 MCP credential/child-scope problem is not changed here.

The connector also needs an explicit provider-transport terminal signal before any
new broker effect: the pinned `Client.make` does not forward `onTermination` to an
app consumer. The protocol overlay seals transport admission and interrupts its
owned request handlers; it does not itself revoke an app-owned broker registration
or cancel the helper's shared broker operation on transport failure. That missing
client/factory-to-connector lifecycle interface is a production implementation
prerequisite, not something the mocked protocol tests prove. Any in-flight effect
at failure has an unknown outcome and cannot be automatically retried.

No upstream Codex change is proven necessary at the inspected private-stdio pin.
T3-owned protocol/adapter/connector changes and fresh independent review plus
successful hosted typecheck/tests/mutations are mandatory before any enablement.
Native session acceptance, installed T3 adoption and parent integration remain open.
