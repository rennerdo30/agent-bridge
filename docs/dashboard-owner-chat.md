# Owner input from session Chat (AB-140)

Research date: 2026-10-07. Read-only CLI probes and version-matched source are
evidence of an available transport, not a successful model turn. Automated tests
mock the CLIs. No CLI transcript, session database or user configuration is edited.

## Per-CLI input and native children

| CLI | Main live session | Native child | Busy behavior |
| --- | --- | --- | --- |
| Claude Code | Existing bridge channel; otherwise existing mod submits a real user prompt, or asyncRewake/hooks deliver labeled bridge input | No dashboard transport to Task/Agent children; parent can use native SendMessage | Channel input is processed by Claude; mod waits idle, hooks deliver at a safe step. No interrupt |
| Codex | `codex queue --thread UUID --message TEXT`, using the shared app-server queue; definitive failure falls back to bridge/waker | Attempt the same queue with the verified child UUID. If that server cannot address it, show unsupported and offer parent delivery | Native queue waits until idle. Bridge waker also waits idle; no turn/interrupt or turn/steer |
| opencode | Existing plugin persists bridge input with `client.session.promptAsync` | Served API can address child sessions, but this dashboard has no verified live plugin client for a child; parent route only | Busy plugin steps use noReply input; idle plugin starts a prompt after Stop. No abort |
| Antigravity (`agy`) | Existing native plugin hooks/MCP inbox | No established external child input; parent route only | During a step, PreInvocation delivers input; Stop can continue if input is pending. Mail arriving after idle waits next turn/inbox |

Claude's [channels documentation](https://code.claude.com/docs/en/channels)
describes MCP events arriving in the currently open session. They are channel
events rather than typed terminal input. This bridge already sends
`notifications/claude/channel` in `src/mcp/server.ts`; `src/mcp/rewake.ts` and
`plugins/claude/hooks/wake.ts` provide the other path, using `$.prompt.submit`
on supported hosts. Wake settings still apply to bridge delivery. A plain new
`claude -p --resume` process is not used to impersonate live interactive input.

The [native subagent documentation](https://code.claude.com/docs/en/sub-agents#resume-subagents)
states that a parent can resume/message children using SendMessage. Explore/Plan
are one-shot. This does not provide an external dashboard endpoint for an
arbitrary live child. Parent fallback asks the parent to relay the note using its
own available native tools; it does not promise that every child can continue.

The [official app-server reference](https://developers.openai.com/codex/app-server/)
documents `turn/start` for user turns and `turn/steer` for active input. Those
methods act on the server owning the loaded thread. `src/core/codex-appserver.ts`
owns delegated jobs' private stdio server, not every interactive master's server.
Launching a second app-server and resuming the same thread is therefore avoided.

Installed read-only probes: `codex --version` reported **0.160.1**;
`codex queue --help` lists `--thread` and `--message`, plus optional remote server
connection flags. The matching [queue entry point](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/cli/src/queue_cmd.rs)
calls the [session queue implementation](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/session_queue_commands.rs).
It sends `thread/queue/add` with a text UserInput to the shared server, refuses
`--no-daemon`, and rejects embedded-server writes when a daemon exists. UUID
targets go straight to the queue request. Child support consequently depends
on the live server accepting that child's UUID; the dashboard checks ancestry
before attempting it. No new server address or auth token can be supplied by
the dashboard request. `src/mcp/codex-wake.ts` already used this CLI command;
dashboard owner input now sends the actual owner text through it.

The [opencode served API](https://opencode.ai/docs/server/#sessions) exposes
session prompts and asynchronous prompts. This bridge's
`src/opencode/plugin.ts` already has the live client: Stop starts a prompt, and
working-session hooks store noReply prompts. It deliberately excludes child
sessions from main-session tracking. The dashboard reuses that delivery instead
of guessing a server URL or starting an independent resumed process. A future
plugin capability could securely expose child input, but this release does not.

Antigravity read-only probes here reported **agy 1.3.1**. `agy --help` documents
print-mode stream-json stdin, `--conversation` resume, and `--remote-control`.
`agy remote-control --help` offers daemon start/status/stop, not a send command.
The [official Remote Control documentation](https://antigravity.google/docs/remote-control?tab=cli)
describes authenticated browser/desktop prompt synchronization over a reverse
tunnel, but does not document a local programmatic send API. Stdin can only feed
a process whose stdin the caller owns; resume does not prove live interactive
steering. The sibling's `docs/google-cli-research.md` records
native plugin hook evidence and a live MCP smoke test. No documented external
idle-input method was established, so no terminal keystrokes, private remote
protocol, competing resume or transcript-file writes are attempted.

## Direct wake with auto-wake disabled (AB-70)

`wakeOnDirect` is distinct from global `autoWake`. Codex now considers an exact
named/id target eligible for its existing idle queue waker, and opencode Stop
considers eligible direct mail when no listen window remains. Receivers advertise
this policy to the broker. Quiet observer copies, status notes and hop limits
still exclude automatic delivery. Global wake preferences are not changed.
Antigravity does not advertise an unsupported idle wake: its delivery wording
continues to say next turn/inbox. Older CLIs or a stale daemon can reject queue;
the mail remains unread, and diagnostics describe the failure. Existing MCP
servers must load the upgraded bridge before the new direct-wake policy applies;
a plugin file update alone does not hot-replace an already running server.

AB-68's external job reply grants remain separate. This feature does not create
an implicit send_to grant or authorize a job to answer another master.

## HTTP and UI contract

- `POST /api/sessions/<exact-local-name>/message`: `{body, child?, target?}`.
- `child` must belong to that session's native-child list. `target: "parent"`
  requires a child and sends a note with its id/title to the parent.
- `POST /api/jobs/<job>/message` is parent-note delivery for a verified native
  child of a locally recorded delegated job, through existing job control.
- Both endpoints require the dashboard's HttpOnly SameSite cookie,
  `x-agent-bridge: 1`, JSON Content-Type and same origin when Origin is present.
  Cross-site requests are refused. Paired-PC names, unknown fields, arbitrary
  cwd/binary/server addresses and forged parent/child pairs are refused.
- The server supplies attribution (`you`, owner). Native Codex input includes
  an owner label. Fallback is explicitly a bridge message; no peer is granted
  a new native-input tool, and message text does not gain a new authorization
  rule just because it claims owner origin.
- State is `queued`, `delivered`, `not-supported` or `unconfirmed`, with
  transport `native-prompt`, `bridge` or `parent`. Native queue acceptance is
  queued until idle, never a read receipt. Bridge delivery returns a receipt
  handle; `GET /api/chat-delivery/<id>` checks only this dashboard instance's
  handles using existing durable broker consumption receipts. Delivered means
  a CLI hook/channel consumed it, not a reply or completed work.
- If native queue times out or throws after launch, return unconfirmed and do
  not automatically send a second copy. A definitive unavailable/failed queue
  allows main-session bridge fallback; a child gets the parent option.
- Composers share jobSend styling, per-chat drafts and status. A child always
  explains its direct limitation and shows a separate parent button.

No persistence format change or migration is introduced. Owner bridge messages
remain in existing history; native prompt persistence belongs to the CLI. A
dashboard restart discards only transient composer/receipt UI state.

## Validation scope

Mocked regression tests cover queue argv (shell characters retained as text),
native acceptance, busy/idle bridge behavior, ambiguous transport failures,
ancestry checks, parent routing, endpoint cookie/header/origin checks, read
receipts, per-chat drafts, navigation races and unsupported/remote states.
Build, tsc, the four-worker suite and data-retention are release gates. Live
interactive master/child behavior and visual browser acceptance remain distinct
from these checks; CLI versions and loaded-server capabilities can differ.
