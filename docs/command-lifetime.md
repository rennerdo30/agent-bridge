# Command lifetime and unexplained exits

The bridge's `timeout_sec` limits an **agent turn**, not each command the agent runs.
Codex manages its own command sessions, tool deadlines and terminal cleanup. A command can
fail while its job keeps running. An exit code of `1`, or even `124`, does not identify the
killer or prove a timeout.

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server#items) supplies
command completion status, `exitCode`, `durationMs` and `aggregatedOutput`. It does not
supply the OS actor that terminated the process. Its `command/exec` deadline is a separate
RPC option; agent-bridge drives agent turns and does not issue that RPC for the agent's tools.

## What the bridge records

Failed Codex command completions now reach the dashboard progress and retained run feed:

- Command item ID, native status, exit code and duration when reported.
- Full command and up to 4,000 trailing output characters in the run log.
- Explicit native timeout evidence when supplied; otherwise `termination cause not reported`.
- A reminder that forced termination can skip `finally` and leave locks or children behind.

The CLI JSON stream and app-server stream use different field casing; both are handled.
Duplicate completions are suppressed without double-counting the command. A recovered
command failure does not turn a successful agent turn into a failed job. Its evidence remains
in the run log even if later progress replaces the dashboard's current line.

Tracked delegates also log `delegate process started` and `stopping delegate process tree`
with the root PID and reason (completion, timeout, abort or server shutdown). Cancellation's
runner fallback logs its target PID. These records describe **bridge actions**, separately
from failures reported by the native command tool. They do not infer OS-level causes.

## Process ownership and durable tools

Bridge cleanup targets the child it spawned: on Windows, `taskkill /PID <child> /T /F`;
on POSIX, the delegate's own process group. It does not select processes by executable name,
project path, drive letter, or sibling job. Do not add name-based sweeps. Already exited or
signaled `ChildProcess` roots are skipped. The wait added in `9edb0dc` waits for that child
to close; it does not broaden the target or introduce a command timeout.

Background `spawn_*` jobs have an independent runner and survive the session MCP server's
`/reload-plugins`. That protects the **agent job**. It does not promise that every native
tool outlives command cleanup, job cancellation, or the agent's app-server process.

For tools that need `finally` to release a resource:

1. Keep the command session alive and monitor it to completion. A yield/poll interval is
   not a lifetime guarantee. Save an ownership token, process identity and recovery snapshot
   before launching work. Verify those identities before cleanup or retry.
2. Redirect a deliberately detached tool's stdin/stdout/stderr away from the command session
   (to files or null) and monitor a separate completion record. On Windows, `Start-Process
   -WindowStyle Hidden` with file redirection can outlive the launching shell, but it remains
   a descendant for `/T` and may inherit a Windows job object. `detached`/`unref` on their own
   do not establish cancellation independence.
3. To survive **job cancellation or native tool cleanup**, submit the work to an independently
   running service, owner-controlled worker, or OS scheduler outside the delegate's tree.
   Use an explicit service/task identity and completion record. Set that lifetime up before
   acquiring the resource; do not bypass a denied approval or sandbox restriction. Cancelling
   the agent then leaves that external work running until its own owner stops it.

Never recover by deleting arbitrary lock files, killing every shell/Unity process, or
removing logs. Preserve the evidence and verify the exact resource owner first. On this
machine `E:` is a subst of `D:`; two spellings do not imply two independent resources.

## AB-109 incident evidence (2026-10-06 UTC)

**The root cause of the missing bridge diagnosis is fixed. The actor that ended the original
wrapper remains unknown.** No retained record proves a bridge kill, a Codex command timeout,
an app-server tool-call timeout or a Windows job-object termination. Do not close the causal
investigation by labelling the silent exit a timeout.

Read-only evidence:

- `~/.agent-bridge/runs/2026-10-06-11-29-51-codex-6aad747a.{json,log}` identifies job
  `codex-job-bdef8db0`, thread `01a11096-8a39-7133-a2cc-7ea88e5240cc`, bridge `0.29.2`,
  and continuation start `11:29:51Z`. The feed displays local time (UTC+9 on this machine).
- `~/.agent-bridge/jobs/bdef8db0.json` and `jobs.json` identify runner `49384`, still active
  after the incident. The job's earlier `finishedAt` belongs to an older run; its current
  status and runner heartbeat are the relevant continuation evidence.
- A live read-only process query confirmed runner `49384` was created at `11:29:51Z` and
  runs the installed `0.29.2/dist/cli.mjs`; its still-live app-server child `52588` was created
  at the same time. Neither runner nor app-server restarted at the wrapper failure.
- Native rollout `~/.codex/sessions/2026/10/06/rollout-2026-10-06T18-41-03-01a11096-8a39-7133-a2cc-7ea88e5240cc.jsonl`,
  entries 2728–2732: `exec_command` starts `pwsh -NoProfile -File scripts/review-world-assets.ps1`
  at `13:31:26.795Z`; the outer command finishes at `13:31:34.766Z`, status `failed`, exit
  `1`, duration `7.5384438s`, empty output. No timeout reason or ongoing command-session ID
  is reported. The wrapper's own requested deadline was `600s`.
- Entries 2743–2746 (`13:31:59.878Z`) show Unity `65580` still alive with parent PID `56312`;
  that wrapper is absent. Entries 2757–2761 (`13:32:22Z`) show exact-owner recovery after
  both processes were confirmed gone. Unity's exit does not establish wrapper finalization.
- `~/.agent-bridge/logs/agent-bridge.log` records no affected runner cancellation, turn
  completion, continuation, shutdown or broker handover around the command exit. Broker
  `55704` keeps routing messages. An unrelated MCP server exits at `13:29:58.990Z`.
- The sibling that produced `9edb0dc` ends its turn at `13:31:51.866Z`, **after** the wrapper
  exit. The affected runner was already executing bridge `0.29.2`; a source commit does not
  replace the code in an existing runner. Its new wait is not a cause supported by this timeline.
- A read-only query of `~/.codex/logs_2.sqlite` finds the native tool call completing and the
  same turn continuing. Its code-mode `outcome="interrupted"` tag also appears on ordinary
  successful calls in other threads, so it is not evidence of cancellation. Application event
  logs in the incident interval supplied no crash diagnosis; no accessible Security process-exit
  audit records or Sysmon log were available for that interval. A harmless 14-second nested
  PowerShell command reproduced neither failure nor skipped `finally`.

Previously `describeCodexEvent` ignored every command completion. The retained bridge feed
therefore recorded the launch at local `22:31:27`, but not the failure seven seconds later;
only the job's later message recorded it. The fix retains that missing failure evidence.

To settle the original OS-level cause on recurrence, capture process creation/termination
telemetry with root, parent and creation-time identities plus native command diagnostics.
Correlate it with the new bridge termination records. A PID-only snapshot and exit `1`
cannot distinguish an external kill, shell exit, native terminal cleanup or job-object action.
