# Claude shared-server mailbox isolation (AB-405)

Claude native children use their parent's MCP connection. Neither an omitted
`native_child` argument nor a caller-supplied `_meta.agent_id` proves that a call
came from the parent. The last hook is also not proof: parent and child calls
can overlap.

On current hosts, `plugins/claude/hooks/mail-scope.ts` intercepts the three mail
tools (`inbox`, `wait_for_message`, `get_conversation`). Claude Code pins the
`tool.call` event's `agentId` to the originating loop; it is absent on main.
The [official mod type contract](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)
defines `AgentLoop` and `ToolCallInput`, including the reserved identity fields.

The mod uses the existing authenticated loopback endpoint registration mechanism
to request a random, in-memory capability. The endpoint checks the registered,
current session and refuses retired servers. Each capability expires after ten
seconds, belongs to one session and tool, records the pinned agent identity, and
permits only one validation attempt. The bounded grant map also prunes expired
entries. The mod replaces any caller-provided `_bridge_scope` argument.

The server strips that argument before logging or forwarding to broker/storage.
It requires capabilities once the mod announces support or requests a grant.
Missing, forged, expired, replayed, conflicting and wrong-session/tool grants
fail before metadata observation, mail reads, receipts, wait registration or
child-delivery confirmation. The authenticated child must still have a live
SubagentStart route belonging to this parent connection. Its inbox reads and
acknowledges only that child's queue. Child history and wait tools remain
refused; hooks and the child inbox provide delivery. Tokens never appear in
bridge logs, tool results or persistent bridge storage. This is a host-to-server
boundary, not isolation against arbitrary local code that can read the host's
endpoint credentials.

Parent calls continue through the same mod and may use all three tools, including
while children are active. Native child send/queue routing is unchanged.

For legacy hosts without the mod, an unscoped mail call checks the live child
routes. While any is live it returns only a read-only status and child addresses:
no parent bodies, read acknowledgements, history or wait registration. Parent mail
is delivered by parent hooks. Explicit child inbox selection retains the existing
live-route validation. With no live children, parent mail tools behave as before.
This compatibility path has a known residual race: a child can start after the
live-route check, and an already admitted wait can outlive that check. It cannot
provide current-host identity guarantees; authenticated mod capabilities are the
solution for concurrent native children. No timeout or retry policy is raised.
