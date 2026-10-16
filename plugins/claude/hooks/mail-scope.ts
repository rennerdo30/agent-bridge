import type { Register } from 'claude-code'

type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]
const PREFIX = 'mcp__plugin_agent-bridge_bridge__'
const TOOLS = ['inbox', 'wait_for_message', 'get_conversation', 'search_history']
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
    // on unscoped; the server then serves parent mail only while no native child is live.
    const tool = e.tool.slice(PREFIX.length)
    const token = await Promise.race([scope($, tool, e.agentId).catch(() => null), $.clock.sleep(TIMEOUT_MS).then(() => null)])
    // A child call never legitimately needs unscoped mail: it could only reach parent mail.
    if (token === null && e.agentId !== undefined) return { deny: 'Bridge mail scope for this native child could not be obtained; child mail remains queued for hooks.' }
    return next(withScope(e as unknown as Record<string, unknown>, token) as unknown as typeof e)
  })
}
