# Claude shared-server mailbox isolation (AB-405)

## Threat model

Claude native children share their parent's MCP connection. This change
protects against a **confused or misbehaving child** that calls the bridge mail
tools: it must not read or consume the parent's inbox or history by mistake.

It is **not isolation from a hostile child**. A child that runs arbitrary code
with the parent's user rights can read the session registration file under the
bridge home (`sessions/<session>.json`, which holds the loopback port and bearer
secret) and mint its own scope tokens, or talk to the broker directly. Defending
against that needs OS-level separation and is out of scope.

Non-mail tools (`send`, `decide`, `spawn_*`, `message_subagent` and the rest)
are not identity-scoped yet: an unscoped call from a child acts as the parent.
That is tracked as AB-412, not part of this change.

## Gated tools

`inbox`, `wait_for_message`, `get_conversation` and `search_history`.

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
  use all four tools. A child gets only its own inbox (read and acknowledged
  from its own queue) and a `search_history` restricted to its own mail (the
  session filter is pinned to the child address, kind `message`). Child
  `wait_for_message` and `get_conversation` are refused; hooks and the child
  inbox deliver its mail.
- **Live child, no token (ambiguous):** a read-only status with the live child
  addresses. No parent message bodies, history, read acknowledgements or wait
  registration. Parent mail stays queued for parent hooks. An explicit
  `native_child` inbox still reads only that live child's queue.
- **Any presented token** is validated whether or not a child is live:
  missing grant, forgery, expiry, replay, wrong tool, wrong session or a
  `native_child` claim that conflicts with the token fail before metadata
  observation, mail reads, receipts, wait registration or child-delivery
  confirmation.

A replaced server that is still called first takes the session back (the
existing reclaim), then applies these rules.

## Tokens

`plugins/claude/hooks/mail-scope.ts` intercepts the four tools on the
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
child call (`agentId` set) is denied instead: a child never needs unscoped mail,
and before its SubagentStart route is live an unscoped call would count as the
parent.

The server strips the argument before logging or forwarding to broker or
storage. Tokens never appear in bridge logs, tool results or persistent bridge
storage.

## Residual race

The unscoped path checks live child routes per call. A child can start after
that check, and an already admitted wait can outlive it. Calls that carry a
valid token do not depend on this check. No timeout or retry policy is raised.
