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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Set or remove the capability argument, always replacing any value the model supplied.
 * Tool arguments sit in `e.input` where the host nests them, else beside the envelope
 * (the 2.1.300 type contract spreads them; observed hosts nest them). Never both. */
function withScope(e: Record<string, unknown>, token: string | null): Record<string, unknown> {
  const put = (args: Record<string, unknown>): Record<string, unknown> => {
    const { _bridge_scope: _model, ...rest } = args
    return token === null ? rest : { ...rest, _bridge_scope: token }
  }
  if (!isRecord(e.input)) return put(e)
  const { _bridge_scope: _model, ...envelope } = e
  return { ...envelope, input: put(e.input) }
}

export const register: Register = on => {
  on('tool.call', { tool: TOOLS.map(tool => `${PREFIX}${tool}`) }, async ($, e, next) => {
    // agentId is pinned by Claude Code: changing it in next(e) is refused by the host.
    // No inference from the last hook or active child. Without a capability the call goes
    // on unscoped; the server then serves parent mail only while no native child is live.
    const tool = e.tool.slice(PREFIX.length)
    const token = await Promise.race([scope($, tool, e.agentId).catch(() => null), $.clock.sleep(TIMEOUT_MS).then(() => null)])
    return next(withScope(e as unknown as Record<string, unknown>, token) as unknown as typeof e)
  })
}
