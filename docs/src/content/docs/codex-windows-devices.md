---
title: "Windows execution identity and device work (AB-107)"
---

## Result

Codex CLI **0.160.1** runs unrestricted commands as its parent process user,
even with `[windows] sandbox = "elevated"`. When agent-bridge runs in the logged-in
user's session, `sandbox: "danger-full-access"` therefore uses that user's identity,
profile permissions and device access. It does not log into a different account.
If the bridge itself runs under another account, full access inherits that account;
it does not impersonate the interactive desktop user.

The original report describes a genuine empty `adb devices -l` result while the
supervisor saw a phone. **The hypothesis that every full-access Codex command uses
the separate sandbox account was not reproduced.** Live device-list probes from
this delegated job and an isolated full-access app-server both saw the reported
Xiaomi phone. No connected-phone deployment was verified. Identity alone does not prove USB visibility:
adb version/path, server context, authorization, drivers and connection state still
need to be checked in the failing session.

## Research evidence (2026-10-06)

- Installed executable: `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe`;
  `codex --version` reports `codex-cli 0.160.1`. `codex --help` and
  `codex app-server --help` document dotted TOML `-c key=value` overrides.
- Matching source tag: `rust-v0.160.1`, commit
  `d27764b82f7118f674371e6d6e76271d9d606edb`. Research checkout, probe scripts and
  isolated `CODEX_HOME` directories are outside this repository in the OS temp folder.
- The [versioned config schema](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/config.schema.json)
  defines `WindowsToml.sandbox` with `WindowsSandboxModeToml` values `elevated`,
  `unelevated`, and `mxc`. There is **no** `windows.sandbox="disabled"` or
  `windows.sandbox="danger-full-access"` value. The latter is a `sandbox_mode`.
- [Windows backend resolution](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/windows_sandbox.rs#L66-L105)
  maps elevated to the elevated backend and unelevated to the restricted-token
  backend. Explicit `[windows]` selection takes precedence over legacy feature
  flags. Unelevated remains a sandbox; switching every job to it would change
  stricter jobs unnecessarily. Disabling legacy feature flags does not override
  an explicit Windows table. No such backend/feature change is made here.
- [Sandbox selection](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/sandboxing/src/manager.rs#L310-L350)
  returns `SandboxType::None` when the effective permission profile does not require
  a platform sandbox. [Policy logic](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/sandboxing/src/policy_transforms.rs#L646-L665)
  skips it for unrestricted filesystem and enabled network access, unless managed
  network requirements demand enforcement. Full-access labels do not override
  organization policy or an external sandbox around the bridge process.
- [Command execution](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/exec.rs#L127-L138)
  uses that selection. [Unified execution spawn](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/sandboxing/src/spawn.rs#L55-L127)
  invokes the Windows sandbox account/token machinery only for the restricted-token
  sandbox type; otherwise it spawns an ordinary process/PTY. The elevated
  [runner client](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/windows-sandbox-rs/src/elevated/runner_client.rs#L393)
  uses Windows account logon APIs when that backend is selected.
- Installed binary probe, with an isolated home configured **read-only + elevated**:
  `thread/start` with `sandbox: "danger-full-access"` returned `dangerFullAccess`.
  `command/exec` with explicit `dangerFullAccess` ran `whoami.exe` as
  `demo-pc\demo-user`, matching the parent shell. Both pipe output and decoded
  PTY stdout notifications contained that identity. No model turn was needed.
- A second `app-server --strict-config -c 'sandbox_mode="danger-full-access"'`
  probe retained `windows.sandbox="elevated"`, returned full-access startup config,
  and ran pipe/PTY `whoami` as the parent user **without** a command sandbox override.
  This verifies the startup override added by this change.
- An additional strict-config probe with inherited `default_permissions=":read-only"`
  accepted the full-access startup override. An ephemeral `thread/start` with no
  sandbox argument then reported `dangerFullAccess`, verifying override precedence
  for the newer built-in permissions-profile syntax too.
- The original stored job `codex-job-e954c547` requested `danger-full-access`, and
  its Codex transcript's `turn_context` records the effective policy as
  `danger-full-access`. It probed Unity's bundled
  `C:/Program Files/Unity/Hub/Editor/6000.6.4f1/Editor/Data/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb.exe`.
  This delegated job's own shell, and an isolated full-access startup app-server's
  `command/exec`, both listed `V47XK77HPZDMPBMZ device model:2409BRN2CL` with that
  exact executable (adb 1.0.41, build 37.0.1-15733141). These live checks verify
  current connected-phone visibility without an APK install or device mutation.
  The first probe let adb start its ordinary daemon on port 5037 because it was
  absent; no `kill-server`, driver/config changes or account switches were used.

The [official Windows sandbox documentation](https://developers.openai.com/codex/windows)
describes the sandbox backends. The versioned schema/source and installed probes
above determine the behavior for this exact binary rather than assuming current
online documentation matches its implementation.

## Bridge behavior

Before this change, `src/core/codex-appserver.ts` launched plain `codex app-server`,
inheriting the user's startup sandbox config. It already supplied the requested
sandbox to `thread/start` / `thread/resume` and an explicit `dangerFullAccess`
policy to `turn/start`. `src/core/delegate.ts` already supplied `-s danger-full-access`
for exec and `-c sandbox_mode="danger-full-access"` for exec resume. Both paths
spawn the CLI normally with the bridge's environment and process identity.

Full-access app-server jobs now also supply
`-c sandbox_mode="danger-full-access"` **at startup**, so standalone server
commands without a thread/turn policy inherit the requested unrestricted policy.
Start and resume use the same launch path. Read-only/workspace-write startup,
thread/turn policies, writable roots, network settings and approval behavior are
unchanged. No global Codex config, Windows permissions, users, device services or
stored job data are changed. This closes a startup-policy gap; it is not proof that
the historical model-driven adb failure used a standalone server command.

`codexSandbox` / `codexWorktreeSandbox` in bridge config select job policies;
an explicit MCP `sandbox` overrides the inferred `access` policy. No new Windows
backend setting is needed. The shared permission description used by both
`spawn_codex` and `ask_codex` now distinguishes full access from elevated sandboxed
execution and warns about USB/adb and profile access in sandboxed jobs.

Every Windows exec/app-server job, including continuations, receives a prompt
instruction to check identity before device work and to interpret an empty list
as a visibility observation. If it is running as the sandbox user, it must report
**"can't see devices from the sandbox"**, then ask the supervisor to use an
authorized full-access job or a claude/opencode job. It must not infer a disconnected
cable, alter permissions or switch accounts to get around the sandbox.

## Verification and reproducing a device report

Regression tests cover startup config, thread/turn policies, exec flags and Windows
prompt guidance across all three sandbox modes, fresh jobs and resumes. They also
assert that no Windows backend override is sent. Non-Windows prompts remain intact.
The data-retention suite must remain green.

For the next live phone check, compare the supervisor and job on the **execution PC**:

1. Run `whoami` and record the effective job sandbox and installed CLI version.
2. Resolve the exact adb executable; run that same path's `version` and `devices -l`.
3. Compare `ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_PORT` and adb server identity/path
   if the lists differ. Do not restart another user's adb server as a diagnostic shortcut.
4. If the identity is the sandbox account, report sandbox visibility and delegate
   device work appropriately. If it matches the supervisor, report the empty result
   and investigate adb/server/driver state; do not claim that the cable is disconnected.

The automated tests and identity probes do not replace this connected-device check.

## Validation on the isolated branch

Base: `origin/main` at `26dbe3320f2061d169dd4659788faac794cf7f64`.
Branch: `fix/ab107-windows-user`.

- `npm run build`: passed; plugin bundles regenerated.
- `npx tsc --noEmit -p .`: passed.
- Focused default-timeout checks: 5 files, 53 tests passed (61.41 seconds), including
  launch/environment/access/approval regressions and data retention.
- `npx vitest run --maxWorkers=4 --testTimeout=120000 --hookTimeout=120000`:
  **76 files passed, 719 tests passed, 1 skipped** (232.25 seconds).
- Plain `npm test`, with unchanged 30-second test/hook defaults: **failed**;
  65 files passed, 11 failed; 691 tests passed, 28 failed, 1 skipped (439.68 seconds).
  AB-107 launch/environment tests and data retention passed in this run too.
  Failures occurred in unchanged broadcast, cleanup-scope, delegate-run,
  job-outcomes, network-transfers, network-ui, network, remote-dashboard,
  remote-jobs, remote-reconnect and worktree tests. Errors included test/hello/broker
  timeouts, a network configuration HTTP 409, and cleanup EPERM after timeouts.
  Some sibling focused tests overlapped; contention is a possible contributor,
  not an established explanation for every failure.

The AB-104 network owner identified a deterministic default-timeout failure on this
base: the silent-link test waits for a production 30-second deadline plus polling,
exceeding its own 30-second test timeout. That lane supplies injectable test timings
separately. No network code/tests or timeout configuration were changed for AB-107.
The supervisor must repeat default-suite validation after integrating that fix;
the extended green run does not establish default-timeout CI acceptance.
