import type { Register } from 'claude-code'
import { register as registerWake } from './wake'
import { register as registerMailScope } from './mail-scope'

/**
 * The plugin's one hooks module. Claude Code loads a single entry from hooks.json `modules` per plugin and refuses
 * a second one, which left both mods (and with them every agent-bridge hook of the plugin) unloaded.
 */
export const register: Register = (on, options) => {
  registerWake(on, options)
  registerMailScope(on, options)
}
