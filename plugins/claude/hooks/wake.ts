import type { Register } from 'claude-code'

/**
 * agent-bridge's mod (Claude Code 2.1.287+): wakes the idle session with a real turn when something it waits
 * for arrives (a subagent's result, an approval question, an awaited reply).
 *
 * The MCP server publishes its wake endpoint per session in ~/.agent-bridge/sessions/<session id>.json. While
 * the session is idle the mod long-polls it (`/wait?role=mod`) and submits what comes back as a prompt. It
 * tells the server when turns start and end (`/mod?busy=`), so messages arriving mid-turn go out with the tool
 * hooks instead. Once the server has seen the mod, the asyncRewake Stop hooks step aside; older Claude Code
 * versions keep using them.
 */
const RETRY_MS = 5_000
/** A wake-up that started no turn within this long is asked for again (the server hands out the same messages). */
const RETAKE_MS = 25_000

type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]
type Endpoint = { port: number; secret: string }

const state = {
  /** Bumped by every new poll and every turn start: an older poll loop stops. */
  generation: 0,
  /** Main-loop turns that started and have not completed. */
  openTurns: new Set<string>(),
  turnsStarted: 0,
  /** Ids of the messages already submitted: never submitted twice (a server that missed the delivery). */
  submitted: [] as string[],
}

const MAX_REMEMBERED = 500

async function endpoint($: Engine): Promise<Endpoint | null> {
  const home =
    (await $.env.get('AGENT_BRIDGE_HOME')) || `${(await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''}/.agent-bridge`
  const id = (await $.session.id()).replace(/[^\w-]/g, '_')
  try {
    const reg = JSON.parse(await $.fs.read(`${home}/sessions/${id}.json`)) as Endpoint
    return typeof reg.port === 'number' && typeof reg.secret === 'string' ? reg : null
  } catch {
    return null // the server has not registered this session yet
  }
}

async function call($: Engine, path: string, method = 'GET') {
  const ep = await endpoint($)
  if (!ep) return null
  return $.http.fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: `Bearer ${ep.secret}` } })
}

async function poll($: Engine, mine: number): Promise<void> {
  while (mine === state.generation) {
    try {
      const r = await call($, '/wait?role=mod')
      if (mine !== state.generation) return
      if (!r || !r.ok) {
        await $.clock.sleep(RETRY_MS)
        continue
      }
      const { text, superseded } = JSON.parse(r.text) as { text?: string; superseded?: boolean }
      if (superseded) return
      if (!text) continue
      const ids = [...text.matchAll(/<agent-bridge-message id="([^"]+)"/g)].map((m) => m[1]!)
      if (ids.length && ids.every((id) => state.submitted.includes(id))) {
        // Shown before: tell that server they were delivered (a turn start confirms), instead of a second turn.
        await call($, '/mod?busy=1', 'POST')
        await call($, '/mod?busy=0', 'POST')
        continue
      }
      state.submitted = [...state.submitted, ...ids].slice(-MAX_REMEMBERED)
      const started = state.turnsStarted
      await $.prompt.submit({ text })
      // No turn came of it: ask again (the messages stay unread until a turn shows them).
      $.clock.after(RETAKE_MS, () => {
        if (state.turnsStarted !== started || mine !== state.generation) return
        // They were never shown: submitting them again is right this time.
        state.submitted = state.submitted.filter((id) => !ids.includes(id))
        void poll($, ++state.generation)
      })
      return
    } catch {
      await $.clock.sleep(RETRY_MS).catch(() => undefined)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void poll($, ++state.generation)
    return result
  })

  on('turn.start', async ($, e, next) => {
    state.turnsStarted++
    state.openTurns.add(e.turnId)
    state.generation++
    void call($, '/mod?busy=1', 'POST').catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's runs complete too; only the main loop's turns count.
    if (!e.agentId) {
      state.openTurns.delete(e.turnId)
      if (state.openTurns.size === 0) {
        await call($, '/mod?busy=0', 'POST').catch(() => undefined)
        void poll($, ++state.generation)
      }
    }
    return result
  })
}
