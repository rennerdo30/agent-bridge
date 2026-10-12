# Native Claude child addresses

Claude Code's built-in Agent tool shares its parent's MCP server. A `SubagentStart`
hook issues a virtual address such as `claude-project/sub:agent-abc123`. This is a
queue under the registered parent session, never a top-level peer. The child cannot
register through hello, change the parent's name, take its main role, or update its
session metadata. Native Codex children remain outside this feature and retain the
AB-268 admission checks.

**Not yet supported:** native children inside delegated Claude job MCP servers.
Those servers use a parent link instead of a registered session connection; a
follow-up needs parent-link routing and job-runner lifetime handling. Their existing
parent-link delivery is unchanged.

The child receives its address and `native_child` id in hook context. Use that id on
the ordinary bridge tools:

```text
peers(native_child="agent-abc123")
inbox(native_child="agent-abc123")
send(native_child="agent-abc123", to="codex-job-1234", message="Review ready")
```

The explicit id is necessary on hosts that omit native identity from ordinary MCP
tool calls. Inspection of the installed Claude Code 2.1.296 call path found no
reliable native agent id in normal `tools/call` metadata. The bridge also recognizes
`_meta.agent_id` or `_meta.agentId` when provided. It never infers identity from the
most recent hook: concurrent children and the main can call the same server.

The parent and its directly owned bridge jobs can address the child. Parent `peers`
and `inbox` show live child addresses, and job sibling discovery includes authorized
children. The parent can grant exact external names with
`native_child_grant(agent_id="agent-abc123", send_to=["codex-reviewer"])`; replacing
the list with `[]` revokes external access. The broker checks both directions against
current ownership and these grants. Wildcards, agent kinds, project addresses and
unrelated sessions are refused. Grants end with the child.

Messages wait in the broker's child queue until that child's hook or scoped inbox
call. They never enter the parent's actionable inbox. Child sends use a virtual
sender through the parent's connection, with the sibling conversation hop limit
and quiet supervisor copies. `reply_to` must anchor mail exchanged with the exact
recipient. Message IDs support durable retries. Quiet copies remain inspectable
with the parent's `inbox(include_quiet=true)`.

A hook hand-out stays unacknowledged until the child's next hook or scoped tool
call confirms the preceding context. If the child ends first, the parent receives
that mail too. This favors retained duplicates over losing a cancelled hook's mail.

`SubagentStop` retires the address and returns pending mail to the parent. Parent
`SessionEnd`, session/name replacement and connection close do the same. Durable
queue mappings return orphaned mail after a broker restart. Returning mail changes
its recipient without removing message data; the original target remains visible.
Late child hooks cannot resurrect an ended address in the same session. Broker
restart ends live addresses conservatively; a fresh child hook can issue an address
again after pending mail has been returned.

Hook behavior follows the [Claude Code hook reference](https://code.claude.com/docs/en/hooks).
Automated fixtures cover broker exchange, hook and tool routing, authorization,
quiet copies, retained fallback and ownership protection. They do not prove a live
Opus/Codex session exchange on a deployed version.
