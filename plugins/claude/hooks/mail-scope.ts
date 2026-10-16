import type { Register } from 'claude-code'

type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]
const PREFIX = 'mcp__plugin_agent-bridge_bridge__'
const TOOLS = ['inbox', 'wait_for_message', 'get_conversation']
const TIMEOUT_MS = 1_500

/** Only the host mod can reach this authenticated endpoint. Never show or retain grants. */
async function scope($: Engine, tool?: string, agentId?: string): Promise<string | null> {
  const home = (await $.env.get('AGENT_BRIDGE_HOME')) || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.agent-bridge`
  const session = await $.session.id()
  const reg = JSON.parse(await $.fs.read(`${home}/sessions/${session.replace(/[^\w-]/g, '_')}.json`)) as { port: number; secret: string }
  if (typeof reg.port !== 'number' || typeof reg.secret !== 'string') return null
  const path = `/mail-scope?session_id=${encodeURIComponent(session)}${tool ? `&tool=${encodeURIComponent(tool)}` : ''}${agentId !== undefined ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`
  const response = await $.http.fetch(`http://127.0.0.1:${reg.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${reg.secret}` } })
  if (!response.ok || !tool) return null
  const { token } = JSON.parse(response.text) as { token?: unknown }
  return typeof token === 'string' ? token : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.race([scope($).catch(() => null), $.clock.sleep(TIMEOUT_MS)])
    return next(e)
  })
  on('tool.call', { tool: TOOLS.map(tool => `${PREFIX}${tool}`) }, async ($, e, next) => {
    // agentId is pinned by Claude Code: changing it in next(e) is refused by the host.
    // Replace any model-supplied token. No inference from the last hook or active child.
    const tool = e.tool.slice(PREFIX.length)
    const token = await Promise.race([scope($, tool, e.agentId).catch(() => null), $.clock.sleep(TIMEOUT_MS).then(() => null)])
    if (!token) return { deny: 'Bridge mail caller could not be authenticated; mail remains queued for hooks.' }
    return next({ ...e, _bridge_scope: token })
  })
}
