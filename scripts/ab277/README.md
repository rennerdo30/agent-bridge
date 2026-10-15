# AB-277 historical measurement tools

Standalone, opt-in evidence tools retained from `211cfd0b` (2026-10-11).
The one measurement and one startup diagnostic both failed before readiness.
No accepted memory baseline, startup cause or savings resulted. See the
[evidence record](../../docs/runtime/MCP-MEMORY-MEASUREMENT.md) for historical
commands, fixture identifiers, hashes, results and review limits.

These files are not imported by product/plugin code, included in product
build entrypoints, invoked by package commands or executed by CI. Vitest
discovers `test/**/*.test.ts` and its configured lanes, not this directory's
Node test file. The executable files remain byte-for-byte unchanged from
the retained commit; this README and the evidence refresh do not activate them.

| File / explicit mode | Historical purpose |
| --- | --- |
| `mcp-memory.mjs --prepare --dependencies <existing-node_modules>` | Windows-only custom build into a fresh worktree fixture. Optional `--purpose startup-diagnostic` prepares a diagnostic fixture. No install or MCP launch during preparation. |
| `mcp-memory.mjs --run --fixture-root <prepared-root>` | Three owned synthetic stdio clients, readiness, one health call each, ten-minute idle and memory/module inventory; then held-child EOF shutdown. |
| `mcp-memory.mjs --diagnostic-startup --fixture-root <prepared-root>` | Separately prepared startup-only diagnostic; no health, idle or memory run. |
| `fixture-preload.mjs` | Child-only preload: fixture environment checks, process-launch guard and owned IPC telemetry. |
| `isolation.mjs` | Path/environment validation, role configuration and exact owned-PID creation-query allowlist. |
| `isolation.test.mjs` | Explicit Node test entrypoint for pure guards; optional `AB277_GUARD_PROBE_FILE` imports an already prepared fixture probe. Not part of the product test suite. |

No execution is authorized by retention. Any future run needs a separately
reviewed scope and fresh fixture. These are historical tools, not a supported
benchmark for current main: `BASE` labels 0.30.11 but does not verify checkout
identity, while preparation builds the current working tree. The readiness
test assumes broker PID equals MCP PID; the independent daemon lane (#17/#29)
requires its own reviewed ownership/readiness contract. Only Claude, Codex and
opencode roles are covered; Muse is absent. Current dependencies, config,
paths, guards, Node identity and actual source must be pinned and reviewed
before use; old hashes and past approvals do not validate a new execution.

The fixtures use separate empty homes/endpoints, a restricted child environment
and owned handles. This is not an OS filesystem sandbox. Launch interception
allows only reviewed creation-time probes for owned controller/child PIDs;
no foreign-process scan or kill fallback exists. EOF timeout requires an
explicit supervisor decision. Preserve all old fixture roots and failure
evidence; do not reuse them or infer shutdown success from exit code 1.
