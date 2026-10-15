# AB-277: isolated role-memory measurement package

Status (2026-10-15): **historical evidence record; one approved measurement and
one startup-only diagnostic failed before readiness; neither was retried**.
Memory measurement remains unavailable. Historical preparation approval:
`884e37d1` and subsequent guard/preflight criteria; it is not a new run approval.
Historical source baseline: published `7e80ac79bc20c804985f0463125e7832308222b0`
(0.30.11). Original evidence and source-line references below describe the
2026-10-11 work, not current runtime acceptance.
Worktree: `E:/AgentData/worktrees/agentbridge-ab277-mcp-measurement-97821066`.
Branch: `measure/ab277-role-memory`. No production source is changed.

## Retention and current integration boundary

[PR #25](https://github.com/rennerdo30/agent-bridge/pull/25) retains the failed
measurement, diagnostic limits and standalone harness from `211cfd0b`.
Reconciled with main `40672ff4e040b8d48e1282ef1fb730efba97a2b2` (0.30.19 plus
merged #22/#23 design records), by ordinary merge on 2026-10-15. The four
executable files remain unchanged; the historical instrumentation hashes
below still describe those files. A [local README](../../scripts/ab277/README.md)
documents their opt-in entrypoints and limitations.

Source inspection found no harness imports or execution in production source,
plugin code, package commands, build entrypoints or `.github` workflows.
`scripts/test.mjs` invokes Vitest; `vitest.config.ts` selects test lanes from
`scripts/test-lanes.mjs` or `test/**/*.test.ts`. It does not discover this
directory's Node `.test.mjs` file. Nothing is wired into product or CI by
retaining the package. No build, guard test, diagnostic or measurement was
run during this reconciliation; historical pass claims below were not rerun.

The harness is not validated for current main. In particular:

- `BASE` is a historical label, not a Git-tree admission check. `--prepare`
  bundles source from its working tree, so running it on this refreshed branch
  would not reproduce the 0.30.11 baseline despite that label. A future review
  must pin actual source, dependencies, instrumentation and Node identities.
- The three roles are only `claude`, `codex`, `opencode`; merged
  [#20 Muse](https://github.com/rennerdo30/agent-bridge/pull/20) is not measured.
  Merged [#32 messaging](https://github.com/rennerdo30/agent-bridge/pull/32)
  and current hook/config behavior require a fresh fixture audit.
- Readiness requires the broker PID to equal the held MCP child's PID.
  [#17](https://github.com/rennerdo30/agent-bridge/pull/17) owns the independent
  daemon/core lifetime and [#29](https://github.com/rennerdo30/agent-bridge/pull/29)
  its default-off shadow-ledger lane; both remain open at this review.
  The old embedded-broker expectation is not daemon acceptance. Future work
  must adopt the core lane's final ownership, readiness and shutdown contract.
- [#23's design](MCP-MEMORY-DESIGN.md) is retained on main. Its controlled
  measurement and isolation gates remain open, as do AB-277's existing plan
  and acceptance criteria. No startup cause, memory baseline, live population
  attribution, module cost or savings was established by this package.

Retention does not approve a rerun or make this an actively supported current
benchmark. The project main must separately scope any future measurement
package and assign its owner. Historical fixture roots remain retained;
their present on-disk contents were not revalidated in this review.

The root/Claude direction is lazy-role-import investigation first. A shared
backend remains deferred pending context, authentication, election, broker
lifetime and measured benefit review. This package neither implements an
optimization nor establishes why a live Codex parent has multiple clients.

## Files and phases

| File | Purpose |
| --- | --- |
| `scripts/ab277/isolation.mjs` | Fixture path/env validation and launch interception with exact creation-time allowlist. |
| `scripts/ab277/fixture-preload.mjs` | Install guard before worker imports; owned IPC memory samples; late in-process parsed-script inventory. |
| `scripts/ab277/mcp-memory.mjs` | Custom fixture-only build/preflight, three owned stdio clients, exactly one safe tool call per role, ten-minute idle and EOF shutdown. |
| `scripts/ab277/isolation.test.mjs` | Pure guard tests, including published process-identity/procinfo imports from a separate prepared probe bundle. No MCP startup. |
| This document | Review evidence, exact invocation and measurement limits/results. |

One owned Node MCP process for each `claude`, `codex`, `opencode` role is the
proposed run. These are synthetic stdio clients, not installed agent hosts.
Each owns a separate empty Bridge home and broker endpoint. Roles run
concurrently; all three include their own elected-broker cost.

Samples use [Node's memory API](https://nodejs.org/api/process.html#processmemoryusage)
for RSS, heap used/total, external and array-buffer bytes. No forced GC or heap
dump. Startup means MCP initialization plus verified owned broker readiness
and `tools/list`; the second sample follows exactly one `tools/call`:
`health({})`. The final sample follows at least 600000 ms idle after that call.
No other tool, prompt, message, delegate, installed CLI or native work occurs.

`health` is registered at `src/mcp/server.ts:584-589`. Its guarded handler
does not reclaim a replaced node and no thread metadata is supplied.
`src/core/health.ts:95` performs an unauthenticated read-only ping to the
explicit fixture endpoint, with no election, token creation or history read.
The pre-call broker-readiness ping verifies `brokerPid` equals the held child
PID. Tool output is reduced to call count and success; response bodies and
stderr content are discarded. Only stderr byte count is retained.

After the final memory sample, [an in-process inspector session](https://nodejs.org/api/inspector.html)
enables `Debugger.scriptParsed` inventory. No inspector listening port,
breakpoint, source retrieval, CPU profile or heap snapshot is requested.
Only URLs matching the prepared fixture bundle output allowlist are statted
and reported. Other file URLs are counted and discarded without file reads.
Loaded bundle/chunk sizes are reported separately from the esbuild source
graph, import edges and `bytesInOutput`. Parsed bundle presence is not proof
of each bundled source module's evaluation or retained heap allocation.

## Isolation and owned lifetime

All writable config, Bridge DB/runtime/session records, temporary directories,
generated bundles and result files are under a new unlinked directory in
`.agent-bridge-test/ab277-memory/<UUID>` in this isolated worktree. Windows
named pipes use the unique `ab277-fixture-<UUID>-<role>` namespace. No endpoint
is derived from a live home. `AGENT_BRIDGE_HOME` and
`AGENT_BRIDGE_PLUGIN_RUNTIME_HOME` are identical fixture paths; a selected
runtime is absent initially, so the launcher's only fallback is the hashed
prepared `bundle/worker.mjs`, also in the fixture.

The child environment is constructed from a whitelist, not copied from the
agent environment. Necessary OS fields are `SystemRoot`, `WINDIR`, and a
system-only `PATH`. All home/profile/CLI config/XDG/AppData/TEMP fields point
to the fixture. No credential, token, session, parent, job or delegated linkage
is inherited. Preload verifies OS `homedir()` and cwd match those fixture
fields. Each synthetic project has an empty `.git` directory to stop project
config discovery before it reaches the containing worktree.

History ingestion, automatic backup, dashboard, federation/discovery/remote
jobs, wake and desktop notifications are disabled in fixture config/env.
Job runner creation is disabled; agent executable paths are nonexistent
fixture paths. Token generation, if the stock server needs it, is confined
to the fixture home; token files are never read into measurement artifacts.
No real user config/log/history/DB or private payload is inspected.

Claude startup unconditionally calls `inspectClaudeLaunch`, which would read
ancestor command lines (`server.ts:498`, `procinfo.ts:105`). Therefore the
preload intercepts **all** `spawn`, `spawnSync`, `exec`, `execSync`, `fork`,
`execFile`, and `execFileSync` paths before the worker loads, and synchronizes
builtin ESM exports. Early named imports and later CommonJS/destructured
access are tested. The only allowed execution is the fixed absolute Windows
PowerShell executable with exact published creation-time query literals,
containing only the fixed owned child/controller PIDs. No shell or interpolated
user input is allowed. Allowed calls get a fixed sanitized environment/options.
Ancestor argv queries and every agent launch fail closed before execution;
Claude native launch attribution consequently stays unknown/noninteractive.
If an identity probe fails, stock unknown/error semantics remain unchanged.

This is an audited fixture harness, not an OS filesystem sandbox. Confinement
rests on the explicit stock path sources, fresh homes/config, disabled
discovery and verified environment/runtime/build identities. Preparation and
run reject linked paths, changed bundles/config/instrumentation and reuse of
an already started fixture. Existing dependencies are read-only build inputs;
there is no install, external source link or cache write.

Shutdown ends only each held child's stdin and waits for normal stock server
closure. No scan, PID-based kill, process-tree stop or cleanup fallback exists.
An EOF timeout reports the owned fixture PID and leaves further action to
the supervisor. All fixture files, including unsuccessful preparations, remain.

## Historical prepared commands and review evidence

Original preparation commands, recorded for provenance only. They are not
instructions or authorization to execute against the refreshed branch:

```powershell
node --test --test-concurrency=1 scripts/ab277/isolation.test.mjs
node scripts/ab277/mcp-memory.mjs --prepare --dependencies E:/Development/claude-codex-comm/node_modules
```

Preparation uses the same seven production entrypoints and bundle/splitting
options, writes only the fixture, and produces a separate guard probe exporting
actual baseline `process-identity.ts` and `procinfo.ts` functions. A second pure
guard-test invocation sets `AB277_GUARD_PROBE_FILE` to that prepared probe;
its launch implementations are spies, so no external command executes.

The approved measurement root was
`.agent-bridge-test/ab277-memory/be287182-3e56-41a9-9ded-038e3e2d0cf0`.
Its exact `--run` invocation ran once after root/Claude review (`23a11b43`).
All preparation pins passed before `run-started.json` publication. This root
is preserved unchanged and never reused for diagnostic or retry.

## Failed measurement evidence

The controller exited 1 with `fixture request timeout`. All three held child
handles recorded exit code 1, no signal, 1099 stderr bytes per role. No readiness
sample, health call, ten-minute idle or inspector inventory occurred. Each
home still contained only synthetic `config.json`; no launcher session record
was published. Failure precedes that publication; its cause was not established
from stderr, whose content the initial harness deliberately discarded.

| Role | Startup RSS / heapUsed / external | After health | Idle 10 min | Health calls | Exit |
| --- | --- | --- | --- | --- | --- |
| claude | unavailable | unavailable | unavailable | 0 | 1 |
| codex | unavailable | unavailable | unavailable | 0 | 1 |
| opencode | unavailable | unavailable | unavailable | 0 | 1 |

Initial harness evidence gap: PIDs were not persisted at spawn and its
successful-exit summary omitted them. Exact owned PIDs are consequently
unavailable for this failed measurement; none are invented or recovered from
host history. EOF was attempted only on held children; recorded exit code 1
is not successful normal EOF shutdown. All three recorded exit; no unknown
surviving child is asserted. No retry, foreign process control or cleanup.

Final read-only hash check, before the subsequent diagnostic harness changes,
matched preload, launch guard, controller, all 99 bundle outputs and all three
configs against that measurement's prepared manifest. Its pins remain unchanged;
the current diagnostic instrumentation is a separate revision.
Four pure guard tests passed, including actual baseline process identity and
procinfo imports, but did not establish real Windows preload startup.

Static build attribution remains available; **runtime loaded bundles and
memory attribution are unavailable** because inspector never ran:

| Input group | Modules | Original input bytes |
| --- | --- | --- |
| dependencies | 258 | 1,668,364 |
| src/core | 142 | 1,341,751 |
| src/mcp | 23 | 387,189 |
| src/network | 19 | 183,737 |
| other source | 34 | 423,619 |
| Total | 476 | 4,004,660 |

All 99 generated output files total 3,375,646 bytes; `worker.mjs` entry is
183,793 bytes and `server.mjs` entry 1,351 bytes, with shared chunks separate.
These sizes cover all seven build entries and do not represent loaded role
code, JavaScript heap, RSS or savings. No lazy-import conclusion is accepted.

## Separately authorized startup diagnostic

Root/Claude `f2caf156` authorize one startup-only diagnostic after harness-only
failure-reporting fixes, on a fresh dedicated prepared root/nonce. Exact
invocation/root must be reviewed before launch. No measurement retry, health,
idle period, inspector, installed CLI, production edit or guard weakening.

The diagnostic controller persists PID/PPID at spawn, handles spawn/early-exit
and oversized-frame failures without uncaught event throws, and waits for
stdio closure before final failure accounting. Initialization/readiness remain
bounded; shutdown is still held-child EOF only. A purpose marker prevents
using the diagnostic fixture as a measurement run or reusing a started root.

At most 64 KiB synthetic stderr per role is buffered. Raw stderr and paths
are never persisted/displayed: retain a fixed reviewed category/tag, a constructor
from the fixed built-in allowlist, Node code from an explicit safe-code list,
syscall enum and first three approved basename/line/column frames. Unknown
values are `unknown`; no arbitrary regex-derived strings or message text.
Unknown/outside-fixture source paths are discarded. This deliberately sacrifices
unknown error detail rather than risk content leakage. Guard telemetry reports
fixed allowed/denied counts/category and denied counts per API when reachable; early failure before an
observation is explicitly unknown, not a fabricated zero. IPC telemetry adds
no permission or new executable to the launch allowlist.

### Diagnostic result

After the closed-list revision and new pin review, the separately approved
startup-only invocation ran exactly once from this measurement worktree:

```powershell
node scripts/ab277/mcp-memory.mjs --diagnostic-startup --fixture-root E:/AgentData/worktrees/agentbridge-ab277-mcp-measurement-97821066/.agent-bridge-test/ab277-memory/b7a88091-9606-4d3b-b208-68f112e2116b
```

The controller exited 1. Each owned child exited before initialization completed;
neither initialization nor owned broker readiness succeeded. No health call,
memory sample, idle period or inspector occurred. PID/PPID records and the closed
diagnostic summary remain in that root. Shutdown attempted EOF only on the held
children; all exit events were recorded, with no signal or process kill. Exit
code 1 is a startup failure, not successful normal server shutdown.

| Role | Owned PID | Initialize / ready | Health calls | Captured stderr bytes | Exit |
| --- | --- | --- | --- | --- | --- |
| claude | 70700 | false / false | 0 | 1099 | 1 |
| codex | 4196 | false / false | 0 | 1099 | 1 |
| opencode | 65768 | false / false | 0 | 1099 | 1 |

For every role, the controller category was `fixture child exited before request
completion`; sanitized stderr category was `unclassified_fixture_startup_failure`.
Constructor, code and syscall were `unknown`; approved stack frames were empty.
Capture was not truncated. Guard installation and denied-call counts per API
were not observed before early failure and remain unknown, not zero. Raw stderr
was never persisted or displayed. This diagnostic did not establish the startup
failure's cause or whether a guard denial occurred.

Start hash checks passed. The final read-only check matched all three
instrumentation files, all 99 outputs and all three synthetic configs. SHA256:

| Pin | SHA256 |
| --- | --- |
| `prepared.json` | `5248aba1e0bdff0add5d95601d8d89fba9da90493f24fc19c85401916281185b` |
| `fixture-preload.mjs` | `ce347c4825e224f4f6a1080ecb1101b1e112f1f7cd11f1d60cd46284abba3219` |
| `isolation.mjs` | `03055e721c94e00c38303ed1c666870baac21b040f23b4bb51bafcec4f069d4b` |
| `mcp-memory.mjs` | `b3d2ed6a2d5f878e755ef7dbb7e3cce6c206e803908c072ddf255857de52f7bc` |

The earlier measurement root and all earlier prepared-only roots remain intact.
In particular, `9636aeab-89f2-4487-bc2f-ac192fb6d87c` was never launched after
the crossed closed-list review required new pins. There was one startup
diagnostic total. Any further instrumentation or run requires separate concrete
review; there is no automatic retry or optimization authorization.

## Limits and result interpretation

- Preload/IPC/launch-guard overhead is included in every memory sample;
  inspector setup occurs afterward. No uninstrumented production memory claim.
- Node version is recorded, not inferred from the production bundle target.
  Full eager build graph/byte sizes do not mean every output loaded at startup.
- All fixture roles host an empty broker, with ingestion/dashboard/network
  disabled. This is not a live client-only, native-subagent or loaded-history
  population and does not explain the supplied 25-process host baseline.
- Concurrent ten-minute roles may contend. This is one scoped baseline run,
  not paired statistical savings evidence. RSS is not private committed memory;
  source bytes are not heap attribution, and GC is not forced.
- Two-to-four MCP children per live Codex parent remain unattributed. A future
  separately authorized host thread/client correlation fixture using nonsecret
  IDs would be needed; no installed CLI/live thread/log investigation occurs.
- Lazy import changes require Claude measurement review and new implementation
  authorization. No shared backend or protocol change follows from this run.

AB-276's [waiter notice contract](WAITER-NOTICE-CONTRACT.md), retained revision
`c4e3eebb`, was merged as a design record by #22 in `09229f8c`. This replaces the
former `12fa4e68` reference and includes capable-broker election fencing.
It replaces the rejected floor/shared
legacy-mail storage proposal with an isolated feature DB and negotiated
dedicated claim/ack. Durable authenticated owner generation and Windows
attestation remain proposed/unimplemented; this harness assumes neither.
