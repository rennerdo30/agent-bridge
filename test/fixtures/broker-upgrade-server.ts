import { BridgeNode } from "../../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../../src/core/paths.js";
import { loadOrCreateToken } from "../../src/core/token.js";
import { nullLogger } from "../../src/core/logger.js";

const [home, name] = process.argv.slice(2) as [string, string];
const node = new BridgeNode({ pipePath: resolvePipePath(home, {}), dbPath: resolveDbPath(home), token: loadOrCreateToken(home), name, agent: "codex", cwd: home, autoWake: false, log: nullLogger });
process.on("message", async (request: { id: number; op: string; args: any }) => {
  try {
    let result: unknown;
    if (request.op === "status") { const health = await node.health(); result = { isBroker: node.isBroker, isConnected: node.isConnected, health, mail: node.unread() }; }
    else if (request.op === "send") result = await node.send(request.args);
    else if (request.op === "stop") { await node.stop(); process.send?.({ id: request.id, result: true }); process.disconnect?.(); return; }
    process.send?.({ id: request.id, result });
  } catch (error) { process.send?.({ id: request.id, error: String(error) }); }
});
await node.start(); process.send?.({ ready: true });
