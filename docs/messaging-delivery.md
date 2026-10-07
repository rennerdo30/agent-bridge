# Messaging delivery

The routing and quiet-message rules apply to Claude Code, Codex, opencode and
Antigravity. Native idle transports differ; inbox acceptance is never a read receipt.

## Quiet progress and questions

All `:note` messages stay in dashboard history and explicit `inbox(include_quiet=true)` reads. They
neither wake an idle host nor enter ordinary prompt/tool context. Ownership
fallback preserves that classification. Acknowledgements and sibling observer
copies remain quiet too.

`spawn_*` accepts `notes: "none" | "milestones" | "blockers"`, retained across
continuations. The default is `none`, asking the job for a final report only.
Milestones use `send(message_kind="note")`. Blockers needing a decision use
`send(message_kind="question")`. Dashboard `report_progress` is independent.
Quiet protection applies even if a job ignores the reporting cadence.
Questions, substantive answers to live requests, final results and approval
requests retain their attention paths. A note cannot consume an awaited answer.
Explicit parent-link kinds use a separate endpoint, so older parents reject them
instead of silently losing that classification. Existing host processes keep their
loaded code until the owner loads the new version.

## Reach the project team or running jobs

`send(to="project:<address>")` reaches every available live local session in the
unique project group, including secondaries. All copies share a message id and
conversation. Coordinate which session answers; an unavailable main is omitted.
Exact-name mail still has one recipient. Paired-PC project authority is unchanged.

`send(to="jobs:*", message="Hold at the next safe step")` uses this supervisor's
existing running-job links, without `jobAuthority` or `projectJobs` RPCs. `*` also
includes those jobs along with ordinary session recipients. Each job reports a
queueing outcome; this is not proof of consumption or a process-level pause.
Finished jobs are never resumed by this broadcast. Approvals still need explicit
decisions; messages cannot grant permission. If an older broker lacks authority
RPCs, `decide` can use fresh local ownership for this session's own pending jobs.
Expired unanswered approvals are explicitly reported without claiming owner denial.

## Avoid crossed replies

Ordinary sends warn about up to 50 relevant unread messages from the recipient or
in the same conversation. To refuse a stale settlement, use:

```text
send(to="peer", reply_to="proposal-id", if_no_newer_than="proposal-id", message="Accept beta")
```

The broker rechecks before persistence, including after SQLite lock retries.
Newer unread recipient or conversation mail blocks the send. Read the inbox and
reconsider the proposal before retrying. Equal timestamps are handled conservatively.
An older broker refuses the separate `guardedSend` opcode instead of silently
ignoring the guard. This protects mail already queued at this broker; it cannot
predict a proposal still travelling on another PC.

## What Codex permits

The installed `codex-cli 0.160.1` exposes
`codex queue --thread <UUID or exact session name> --message <text>` with optional
`--remote` and `--remote-auth-token-env`. An isolated real-CLI WebSocket probe
observed `initialize`, `initialized`, then `thread/queue/add` with text input and
a `clientUserMessageId`. The reply contains `queuedSubmission`; exit 0 means
accepted, not `turn/start`, completed generation, or bridge inbox consumption.
An app-server without that RPC exits 1 with an update/restart error.

The waker must address the same app-server as the TUI. For a TUI using a custom
remote server, configure `codexWakeRemote` / `AGENT_BRIDGE_CODEX_WAKE_REMOTE`
and optionally `codexWakeRemoteAuthTokenEnv` /
`AGENT_BRIDGE_CODEX_WAKE_REMOTE_AUTH_TOKEN_ENV`. The latter names the environment
variable containing the token. Never put the token itself in configuration.

The waker needs the thread identity learned from tool-call metadata. Native busy
reports defer mail; inferred busy state after queue acceptance cannot permanently
strand subsequent idle mail. Missing thread identity, an unsupported queue, a
different server or a detached TUI leaves mail unconsumed. No separate resumed
app-server is launched to simulate a wake. The [official app-server documentation](https://developers.openai.com/codex/app-server)
describes `turn/start` and `turn/steer`; the queue contract above was verified against
the installed CLI rather than inferred from those RPCs.

The `test/codex-native-queue-{main,secondary}.test.ts` files optionally run the installed CLI against an
isolated app-server and attached idle TUI mock for main and secondary roles.
It distinguishes detached acceptance, subsequent idle consumption and unsupported
RPC failure. The hermetic idle-host regression runs without the installed CLI.
Neither mock proves a real provider turn or native TUI acceptance on the owner's PC.

## Honest reporting

MCP approval answers say `MCP decide`; dashboard answers retain their own label.
Broker send retries use the same deduplication key. A parent-link response timeout
means delivery is unconfirmed and may already be queued; inspect history before
resending. It is not reported as a definite failed delivery.
