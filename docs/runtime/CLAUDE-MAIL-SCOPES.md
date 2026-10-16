# Claude shared-server caller scopes (AB-405, AB-412)

## Threat model

Claude native children share their parent's MCP connection. This change
protects against a **confused or misbehaving child** that calls the bridge mail
tools: it must not read or consume the parent's inbox or history, send as the
parent, or exercise the parent's supervisor/owner authority by mistake.

It is **not isolation from a hostile child**. A child that runs arbitrary code
with the parent's user rights can read the session registration file under the
bridge home (`sessions/<session>.json`, which holds the loopback port and bearer
secret) and mint its own scope tokens, or talk to the broker directly. Defending
against that needs OS-level separation and is out of scope.

## Gated tools

All model-facing tools in `src/mcp/server.ts` use the same capability gate.
`CLAUDE_SCOPED_TOOLS` enumerates them; registration adds `_bridge_scope` to
each input schema, preserving strict object refinements. The host mod has a
matching list because it ships independently of the source modules. Inventory
tests check the registry, schemas and host filter together.

### Complete tool classification

Class **a** requires parent authority. Class **b** sends or starts work: use a
native child identity or refuse if that operation has no such identity.
Class **c** reads status/mail: restrict visibility to the child. Parent handler
behavior stays unchanged after authentication. Read APIs without a child-only
query are refused, as already established for wait/conversation in AB-405.

| Tool | Class | Authenticated native child behavior |
| --- | --- | --- |
| `health` | c | Broker health only; omit parent's node-hosting evidence |
| `ask_owner` | b | Refuse; owner questions have no child asker identity |
| `withdraw_owner_question` | a | Refuse |
| `search_history` | c | Pin session to child's address and kind to message |
| `get_conversation` | c | Refuse; no child-only retained conversation API |
| `decide` | a | Refuse both decision records and approval answers |
| `decisions` | c | Project/global/child-address decisions only; override requested scope |
| `project_main` | a | Refuse (currently a write-only tool) |
| `coordinator_availability` | a | Refuse |
| `peers` | c | Child address, parent's supervised jobs, child's send grants |
| `send` | b | Broker nativeChildSend/sendWithMode with child's identity and grants; refuse parent message_kind routing |
| `send_status` | c | Refuse; lookup authenticates parent sender, no child-only query |
| `native_child_grant` | a | Refuse |
| `network_status` | c | Counts and readiness only; omit hosts, identities, configuration and roots |
| `resource_slots` | c | Capacities and held/waiting counts only; omit owners/PIDs |
| `send_files` | b | Refuse; no native child transfer identity |
| `fetch_files` | b | Refuse; no native child transfer identity |
| `cancel_transfer` | a | Refuse |
| `inbox` | c | Read/ack only child's queue |
| `wait_for_message` | c | Refuse; hooks and child inbox deliver mail |
| `max_subagents` | a | Refuse |
| `auto_wake` | a | Refuse |
| `ask_claude` | b | Refuse; child has no independent supervisor identity |
| `spawn_claude` | b | Refuse; same reason |
| `ask_codex` | b | Refuse; same reason |
| `spawn_codex` | b | Refuse; same reason |
| `ask_opencode` | b | Refuse; same reason |
| `spawn_opencode` | b | Refuse; same reason |
| `ask_antigravity` | b | Refuse; same reason |
| `spawn_antigravity` | b | Refuse; same reason |
| `ask_muse` | b | Refuse; same reason |
| `spawn_muse` | b | Refuse; same reason |
| `usage_limits` | c | Shared account quota summaries; no parent metadata observation |
| `list_models` | c | Shared model catalogue; no parent metadata observation |
| `dashboard` | a | Refuse browser/UI side effect |
| `set_job_outcome` | a | Refuse, including worktree cleanup |
| `handoff_subagents` | a | Refuse |
| `message_subagent` | b | Refuse continuation/settings changes; child may send ordinary mail using send |
| `cancel_subagent` | a | Refuse |
| `report_progress` | a | Delegated-job servers only; never offered on the shared parent connection |
| `hook_event` | internal | Native mcp_tool lifecycle transport only; host mod denies every model tool.call for it |

`hook_event` is intentionally outside the ordinary server capability gate:
native hooks call MCP directly, without model tool.call middleware. Gating
that transport on a model-call token would break SubagentStart/Stop and parent
mail hooks. The current host mod instead denies model-origin hook_event calls
before forwarding, including forged lifecycle arguments. This is not new
authentication of the legacy hook transport; a caller bypassing the host mod
can still spoof native hook traffic. As with the session registration mechanism,
hostile direct transport access is outside this change's threat model.

Neither an omitted `native_child` argument nor a caller-supplied
`_meta.agent_id` proves who called. The last hook is not proof either: parent
and child calls can overlap.

## Rules

A scope token is required **only while the session has a live native child**,
that is a live SubagentStart route on this parent connection.

- **No live child:** an unscoped call can only come from the parent. It is
  served as before, whether the host mod and scope endpoint are available or
  not.
- **Live child, valid token:** the token proves parent or child. The parent may
  use all tools. A child gets only its own inbox (read and acknowledged
  from its own queue) and a `search_history` restricted to its own mail (the
  session filter is pinned to the child address, kind `message`). Child
  `wait_for_message` and `get_conversation` are refused; hooks and the child
  inbox deliver its mail. Non-mail tools follow the classification above;
  refused tools never enter parent handlers, job admission or approval effects.
- **Live child, no token (ambiguous):** a read-only status with the live child
  addresses. No parent message bodies, history, read acknowledgements or wait
  registration. Parent mail stays queued for parent hooks. An explicit
  `native_child` inbox still reads only that live child's queue. Non-mail
  ambiguous calls return an error without entering the parent handler. Legacy
  explicit child claims can only reach child-scoped paths, never parent controls.
- **Older broker without nativeChildren:** treated as no live child, preserving
  the pre-scope unscoped parent path during mixed-release operation. This is a
  compatibility limit, not proof of child isolation on that older broker.
- **Any presented token** is validated whether or not a child is live:
  missing grant, forgery, expiry, replay, wrong tool, wrong session or a
  `native_child` claim that conflicts with the token fail before metadata
  observation, mail reads, receipts, wait registration or child-delivery
  confirmation.

A replaced server that is still called first takes the session back (the
existing reclaim), then applies these rules.

## Tokens

`plugins/claude/hooks/mail-scope.ts` intercepts all listed tools on the
`tool.call` event. Claude Code pins the event's `agentId` to the originating
loop; it is absent on main. The event is flat: tool arguments sit beside
`tool`, `tool_use_id` and `agentId` (the nested `{ tool, input, ... }` shape is
`tool.check`'s). The mod places the token only at that top level, so a
model-supplied `input` argument is an ordinary argument and cannot divert it.

The mod asks the authenticated loopback endpoint of the current, registered
session (the existing registration mechanism; retired servers refuse) for a
random, in-memory capability. Each one expires after ten seconds, belongs to one
session and tool, records the pinned agent identity, and permits one validation
attempt; the bounded grant map prunes expired entries. The mod always replaces
any model-supplied `_bridge_scope` argument. If no capability can be obtained
(endpoint down, timeout, old server), a parent call (no `agentId`) goes through
unscoped without the argument and the server decides by the rules above. A
child call (`agentId` set) is denied instead: a child never needs an unscoped call,
and before its SubagentStart route is live an unscoped call would count as the
parent.

The server strips the argument before logging or forwarding to broker or
storage. Tokens never appear in bridge logs, tool results or persistent bridge
storage.

## Residual race

The unscoped path checks live child routes per call. A child can start after
that check, and an already admitted wait can outlive it. Calls that carry a
valid token do not depend on this check. No timeout or retry policy is raised.
