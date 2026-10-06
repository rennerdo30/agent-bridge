# Native subagents in delegated Codex jobs (AB-105)

`spawn_codex` and `ask_codex` enable Codex's native collaboration tools by default.
The bridge default is **6 native child threads per Codex job**, excluding the delegated
job's own coordinator. Accepted values are integers **0 through 32**; **0 disables**
native collaboration. The ceiling of 32 is bridge validation policy, not an upstream
Codex limit. Availability still depends on the installed CLI, model and managed policy.

## Research evidence

Verified on 2026-10-06:

- PATH resolves to `C:/Users/renne/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe`,
  version `codex-cli 0.160.1`. `codex --help` and `codex app-server --help` document
  dotted TOML `-c key=value` overrides. `codex features list` reports `multi_agent`
  stable and enabled, `multi_agent_v2` stable and disabled.
- The npm installation is separately versioned `@openai/codex` 0.153.4. Neither
  installation contains Rust source or a local config schema; npm packages contain
  the launcher and platform binary. Research therefore used the matching upstream
  `rust-v0.160.1` tag, rather than assuming current `main` matches the installed binary.
- [Versioned schema](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/config.schema.json)
  defines `agents.enabled` and `agents.max_concurrent_threads_per_session`, whose
  minimum is 1. [Config TOML source](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/config/src/config_toml.rs#L729-L740)
  confirms `max_threads` is a serde alias for the latter key.
- [Config source](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/config/mod.rs#L254-L255)
  sets the V1 default to 6 child threads. V2's separate default is 4 total threads
  (3 children). The bridge deliberately uses the V1 default of 6 consistently.
- [Backend selection and effective limit](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/config/mod.rs#L1586-L1629)
  show that enabled V2 takes precedence over `agents.enabled`, and V2 subtracts the
  coordinator from its total cap. [V2 config resolution](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/config/mod.rs#L2760-L2774)
  derives its total cap from `agents.max_threads + 1` when a separate V2 cap is absent.
- Isolated installed-CLI `app-server --strict-config` probes with `initialize` and
  `config/read` accepted the alias and returned `agents.enabled=false`, cap 1,
  both features false for bridge value 0; value 6 returned enabled true and cap 6.
  A `thread/start` probe also accepted dotted thread overrides while startup config
  contained a V2 table and a different canonical cap. These probes used an isolated
  `CODEX_HOME`, ephemeral thread and no model turn.

The original bridge launchers did not explicitly disable native tools; they inherited
CLI defaults without setting a native concurrency budget. The implementation shares
these four overrides between app-server `thread/start` / `thread/resume` config and
exec / exec resume `-c` arguments:

```text
features.multi_agent = (native_subagents > 0)
features.multi_agent_v2 = false
agents.enabled = (native_subagents > 0)
agents.max_threads = max(1, native_subagents)
```

Replacing an inherited V2 table with false clears its separate concurrency override.
If the model selects V2, its cap is consequently derived from the bridge child limit.
Disabling both the explicit V2 override and `agents.enabled` makes value 0 disable
native tools regardless of model backend selection. Never pass `agents.max_threads=0`:
Codex rejects it even when collaboration is disabled.

## Config and MCP contract

In `~/.agent-bridge/config.json`, add `"codexSubagents": 6`. Existing config conventions
apply: per-agent sections override the top-level default; invalid values are ignored
in favor of the next valid value or built-in default. No environment override is added.
New local Codex jobs save the resolved default in their existing `args` record.
Old jobs without the field inherit their execution config's default; no migration
or stored-version change is required. Detached runner specs without the new config
key retain the built-in default of 6.

Optional MCP integer `native_subagents` (0..32) is supported on:

- `spawn_codex`: budget for the new job.
- `ask_codex`: budget for the blocking job.
- `message_subagent`: saved budget for the continuation and later turns; rejected
  for Claude/opencode jobs. A running turn retains its current budget.

Changing only this field leaves model, effort, access and sandbox settings intact.
An explicit zero is saved and forwarded; it is never treated as missing.

## Dashboard API contract (UI belongs to the supervisor)

All routes use the existing authenticated dashboard cookie. POST also requires
`x-agent-bridge: 1` and `content-type: application/json`.

### Global default

`GET /api/config/codex-subagents` returns:

```json
{ "codexSubagents": 6, "defaultCodexSubagents": 6, "maxCodexSubagents": 32 }
```

`POST /api/config/codex-subagents` accepts exactly:

```json
{ "codexSubagents": 0 }
```

Success: HTTP 200 with the same response shape and updated value. Missing cookie or
POST header: 403. Invalid JSON, extra fields, null, strings, fractional/out-of-range
values: 400 with `{"error":"..."}`. Saving preserves other config keys and sections.
The endpoint reads the dashboard's `other` effective config; per-agent overrides
remain authoritative for sessions that have them. Config watchers apply file changes
within the existing polling interval (about 2 seconds). Existing jobs retain their
saved budgets; use the job endpoint to change them. Remote defaults are configured
on the execution PC, not through this local-only endpoint.

### Existing job settings

`POST /api/subagents/settings` accepts the new field in `settings`:

```json
{ "run": "2026-10-06-13-00-00-codex-abcd1234", "settings": { "native_subagents": 2 } }
```

`run` is the existing run basename without `.log`. Other job settings can be included.
Success remains HTTP 200 with `outcome: "saved"`, `isError: false` and explanatory
`text`. Validation by the owning session returns HTTP 409 with `outcome: "invalid"`
for bad values or a non-Codex job. The current turn is not interrupted or restarted.
`GET /api/state` and the existing run-page job projection expose the saved value at
`jobs[jobName].next.native_subagents`. Legacy jobs can omit this field; UI should show
an inherited/default value rather than interpreting omission as zero.

## Limits and remote compatibility

Native child threads are owned and scheduled by Codex. They are **not agent-bridge
jobs**: no separate bridge job IDs, worktrees or root-budget leases are allocated.
`maxJobs` and the shared root concurrency budget continue to limit bridge jobs;
`maxDelegateDepth` continues to limit bridge delegation generations. These settings
are not multiplied into or substituted for the native cap. Native children inherit
the job's environment and worker context, so bridge tool calls still face the same
depth, root budget and worker grants. Codex's own native depth rules are separate:
V1 defaults to native depth 1; V2 ignores `agents.max_depth`. The bridge does not
redefine native depth. Six bridge Codex jobs can each have six native children.

`remote-jobs-v1` adds optional `args.native_subagents` to spawn frames. Settings
controls already carry a settings object and now validate/forward this field.
Receiving Codex jobs save the supplied value or the execution PC's default.
Old frames and stored records without the field remain valid. The requester omits
the field when unspecified, preserving ordinary calls to older receivers. Explicit
use requires a receiver with this update: older strict schemas can reject the new
field. No capability/version bump, deletion or migration is introduced.

## Verification scope

Regression checks cover integer bounds, config fallback/precedence, job persistence,
next-turn dashboard updates, exec resume and app-server resume overrides, optional
remote wire parsing, and unchanged data retention. Installed probes prove config
acceptance, not successful model-driven spawning or subjective dashboard UI behavior.

Validation on this branch (2026-10-06):

- `npm run build`: passed; all three plugin bundles rebuilt.
- `npx tsc --noEmit -p .`: passed.
- `npx vitest run --maxWorkers=4 --testTimeout=120000 --hookTimeout=120000`:
  74 files passed, 697 tests passed, 1 skipped; 209.96 seconds.
- `test/data-retention.test.ts` stayed green in both focused and full-suite runs.
- Paired TLS broker regression exercised receiving-PC default, zero on same-thread
  continuation, explicit 32 on blocking ask, and local/remote saved settings.
