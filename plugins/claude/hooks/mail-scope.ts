import type { Register } from 'claude-code'

type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]
const PREFIX = 'mcp__plugin_agent-bridge_bridge__'
// Kept in sync with CLAUDE_SCOPED_TOOLS; this mod ships independently of src/.
const TOOLS = [
  'inbox', 'wait_for_message', 'get_conversation', 'search_history',
  'health', 'ask_owner', 'withdraw_owner_question', 'decide', 'decisions',
  'project_main', 'coordinator_availability', 'peers', 'send', 'send_status', 'native_child_grant',
  'network_status', 'resource_slots', 'send_files', 'fetch_files', 'cancel_transfer',
  'max_subagents', 'auto_wake', 'usage_limits', 'list_models', 'dashboard', 'set_job_outcome',
  'handoff_subagents', 'message_subagent', 'cancel_subagent', 'pause_subagent', 'resume_subagent', 'report_progress',
  ...['claude', 'codex', 'opencode', 'antigravity', 'muse'].flatMap(agent => [`ask_${agent}`, `spawn_${agent}`]),
  'hook_event',
]
const TIMEOUT_MS = 1_500

/** Only the host mod can reach this authenticated endpoint. Never show or retain grants. */
async function scope($: Engine, tool: string, agentId?: string): Promise<string | null> {
  const home = (await $.env.get('AGENT_BRIDGE_HOME')) || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.agent-bridge`
  const session = await $.session.id()
  const reg = JSON.parse(await $.fs.read(`${home}/sessions/${session.replace(/[^\w-]/g, '_')}.json`)) as { port: number; secret: string }
  if (typeof reg.port !== 'number' || typeof reg.secret !== 'string') return null
  const path = `/mail-scope?session_id=${encodeURIComponent(session)}&tool=${encodeURIComponent(tool)}${agentId !== undefined ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`
  const response = await $.http.fetch(`http://127.0.0.1:${reg.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${reg.secret}` } })
  if (!response.ok) return null
  const { token } = JSON.parse(response.text) as { token?: unknown }
  return typeof token === 'string' ? token : null
}

/** Set or remove the capability argument, always replacing any value the model supplied.
 * Claude Code's tool.call event is flat: tool arguments sit beside tool, tool_use_id and
 * agentId. The only placement is that top level; a model-supplied `input` argument is
 * an ordinary argument and never receives the token, so it cannot downgrade the call. */
function withScope(e: Record<string, unknown>, token: string | null): Record<string, unknown> {
  const { _bridge_scope: _model, ...rest } = e
  return token === null ? rest : { ...rest, _bridge_scope: token }
}

export const register: Register = on => {
  on('tool.call', { tool: TOOLS.map(tool => `${PREFIX}${tool}`) }, async ($, e, next) => {
    // agentId is pinned by Claude Code: changing it in next(e) is refused by the host.
    // No inference from the last hook or active child. Without a capability a parent call goes
    // on unscoped; the server admits parent tools only while no native child is live.
    const tool = e.tool.slice(PREFIX.length)
    // Native lifecycle hooks call MCP directly. A model must never impersonate a hook,
    // including a child's forged SubagentStop that would remove the live-child gate.
    if (tool === 'hook_event') return { deny: 'hook_event is reserved for native lifecycle hooks.' }
    const fetchScope = () => Promise.race([scope($, tool, e.agentId).catch(() => null), $.clock.sleep(TIMEOUT_MS).then(() => null)])
    // A parent without a token is refused while a child is live: retry once (slow event loop).
    const token = await fetchScope() ?? (e.agentId === undefined ? await fetchScope() : null)
    // A child call never legitimately needs unscoped tools: it could act as the parent.
    if (token === null && e.agentId !== undefined) return { deny: 'Bridge tool scope for this native child could not be obtained; no action taken.' }
    return next(withScope(e as unknown as Record<string, unknown>, token) as unknown as typeof e)
  })
}
