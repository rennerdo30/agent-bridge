---
title: "Updating"
---

```bash
npx -y github:rennerdo30/agent-bridge update     # or: update claude codex opencode
npx -y github:rennerdo30/agent-bridge status     # which sessions still run an old version
```

1. **Keep your sessions running.** `update` publishes immutable versions side by side and preserves every old version. It bypasses Codex's native cache pruning and atomically selects the new cache and marketplace source.
2. New MCP server starts use the selected compatible release. Running servers keep their current code, connections, identity and active work. The updater reports recorded live PIDs and versions; legacy launches are unrecorded. It asks per tool; `--yes` skips the questions. See [live update behavior and limits](../../live-plugin-updates/).
3. **Running sessions may keep their old version.** Adopt the new code at a convenient plugin reload or next MCP server start; updating itself does not require a restart. `status` lists every connected session with its agent-bridge version and marks old ones `OUTDATED`:

   ```
   claude-myrepo  [claude, busy, v0.29.8 OUTDATED]  since …  /home/demo/myrepo
   codex-myrepo   [codex, idle, v0.29.9]            since …  /home/demo/myrepo
   1 session(s) run an older agent-bridge than 0.29.9. They can keep working; a plugin reload or the next MCP server start loads the selected compatible update.
   ```
4. In Codex, check `/hooks` after an update. Newly added agent-bridge hooks, such as the `PermissionRequest` hook in 0.5.0, must be trusted once.

Compatible versions can run together. Since 0.10.0 the bridge's pipe name includes the wire protocol, so sessions of incompatible versions run separate bridges instead of locking each other out. They don't see each other until they adopt compatible code. The same applies to sessions from before 0.10.0.
