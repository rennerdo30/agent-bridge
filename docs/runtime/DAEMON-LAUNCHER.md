# AB325 package 1a candidate

Base: `7adb4817ea2800e56bd26737a81dbe28d7f17219`. Frozen design:
`a7d87f8fa30bae99a0fdd577c5e7c587a4142759`. Owner decision is AB325
comment 32216; coordinator narrowed 1a to unchanged legacy behavior extraction.

**Release blocked:** the owner subsequently required core status plus safe restart/stop
for 1a-i. Read-only `agent-bridge core status` reports the actual serving broker's
version, PID, uptime, mode, clients and explicitly unverified legacy running-job count.
It does not demand-start. Restart/stop code is held for independent review of
`DAEMON-LIFECYCLE-PREREQUISITE.md` at frozen note commit
`354b132171e4e2e8b85c7f18b1aad052cd25e732`; no status-only release is permitted.

Production MCP and CLI nodes first discover the existing broker. Concrete endpoint
absence permits demand start of `node <bundled-cli> broker-daemon`. All peers remain
clients. The daemon owns the existing Broker/MessageStore and background services;
session exit does not close it. No service, task, autostart, installer action,
idle shutdown, domain migration, state-core database or ownership rewrite is added.

Unix uses detached Node with ignored stdio and unref. Windows uses local built-in
PowerShell/WMI `Win32_Process.Create`, hidden startup and explicit environment,
without a new dependency or compiler. Values enter PowerShell through structured
stdin; the static script and executable arguments contain no token. Session parent,
job and control credentials and NODE_OPTIONS are excluded. Creation has a 5-second
budget; existing election and RPC deadlines are unchanged.

Microsoft documents that [WMI creation avoids the caller's job membership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
The [Create method](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)
also warns about provider job limits; the candidate requests provider breakaway via
[Win32_ProcessStartup](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup).
These contracts need actual hosted SID, forced Job Object, requested-home and
authenticated-serving evidence. A PID/creation receipt is not readiness.

Only complete known nonzero WMI Create receipts or a missing PowerShell executable
before invocation classify as unavailable. After fresh discovery also confirms
ENOENT/ECONNREFUSED, legacy embedded election may preserve compatibility. This
degraded node emits one fixed reason and reports `embedded_degraded` in local health
evidence. It has session lifetime and cannot pass independent daemon acceptance.
Timeout, invalid/truncated response, provider exception, connection timeout, wrong
token/protocol and creation without authenticated readiness never permit fallback.
An ambiguous attempt stays latched throughout the node's lifetime; later attempts
only discover. A successful authenticated registration permits normal restart
discovery after connection loss. No forced embedded configuration is added.

The existing versioned Unix socket/named pipe and shared-token protocol remain.
Bind losers close only their own unbound store; they do not close the winner's
listener or replace its authentication material. Legacy Unix stale socket probing
and removal are retained limitations. No native lifetime-held lock, local principal
IPC verification, protocol-independent installation identity, durable epoch,
receiver fencing or full single-authority guarantee is implemented. Old retained
clients can still elect embedded brokers on incompatible endpoints. These remain
1b/later gates; no unknown legacy writer is forcibly stopped or promoted.

The only lifecycle RPC, `ensureDashboard`, uses the existing local authenticated
connection. It has no remote host/configuration/grant parameter. Force and port
are validated, concurrent opening shares one promise, and a conflicting selected
port rejects without restarting/rebinding. Existing configured MobileActivation,
TLS/material/grant checks and broker owner-question context remain unchanged.
Disabled automatic dashboard startup still allows explicit force. Broker shutdown
drains owned activation/controller before retiring the same existing services.

Remaining production BridgeNode callers: `mcp/server.ts` and `cli/main.ts` choose
daemon; `mcp/job-runner.ts` and `mcp/delegate-run.ts` are explicitly connect-only.
`startUi`'s backend sender defaults to connect-only; the nonmobile manual CLI host
passes trusted daemon options through DashboardController. Daemon-owned and configured
mobile hosts remain connect-only and cannot recursively launch themselves. One sender
node is retained for the complete UI-host lifetime, including failed starts/sends,
so an unknown launch cannot be erased by retrying an HTTP request. HTTP/config input
cannot select embedding; library/fixtures require explicit `embeddedCompatibility`.
Other BridgeNode library/source fixtures that omit daemon options retain the existing
embedded compatibility path without making it production eligible. Mobile CLI startup
failure before authenticated connection returns unavailable instead of creating a
second sender/launch attempt through a desktop fallback. No routes/visuals change.

Hosted workflow checks the exact PR source head on all three documented OSes and
Node 22/24, compiles JS bundles only there, and retains SOURCE_HEAD plus every plugin
file SHA256/length and runtime metadata. Documented Node minimum remains 22.16;
Node patch, architecture, OS and SQLite/libuv versions come from each manifest.
There is no new architecture/libc/Node ABI-specific binary distribution.

Required evidence includes ten-client race, parent/group/job death, exact user/home,
accepted mail across crash, auth refusal, definitive/unknown fallback classification,
forced dashboard startup/port conflicts, and existing mobile lifecycle tests.
Source inspection and hosted fixtures do not establish owner runtime, native CLI,
full retention or AB319 performance acceptance. PR13/14/15/16 and combined release
gates stay separate. After an approved 1a release, the next owner step is AB319
remeasurement, not later-stage implementation.
