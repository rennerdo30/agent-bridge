import { once } from "node:events";
import { readFileSync } from "node:fs";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { tokenPath } from "../src/core/token.js";
import { fixtureProcessExists, fixtureProcessGeneration } from "./fixture-process-generation.js";
import { until } from "./helpers.js";

/** Only for a fresh mkdtemp home owned exclusively by the calling fixture.
 * Capture before closing its MCP servers: their normal stop deliberately leaves
 * the standalone daemon alive. Authentication binds this PID to the fixture's
 * private endpoint/token; creation identity prevents signalling a reused PID.
 * Call the returned stop only after closing every fixture client/server. */
export async function captureFixtureBroker(home: string, serverPids: number[]): Promise<() => Promise<void>> {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  try {
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: readFileSync(tokenPath(home), "utf8").trim() });
    const status = await client.request("coreStatus", {});
    // The ordinary Windows launch-unavailable fallback is owned by an MCP
    // server and exits with that server; never signal it as a detached daemon.
    if (status.mode !== "daemon") {
      if (!serverPids.includes(status.pid)) throw new Error("Fixture embedded broker is not an owned MCP server");
      return async () => {};
    }
    if (!Number.isSafeInteger(status.pid) || status.pid <= 0 || status.pid === process.pid || serverPids.includes(status.pid)) {
      throw new Error("Fixture daemon PID is not a separate process");
    }
    const identity = await readProcessIdentity(status.pid);
    if (!identity) throw new Error("Fixture daemon creation identity is unavailable");
    return async () => {
      if (await fixtureProcessGeneration(status.pid, identity, "Fixture daemon identity changed or is unavailable")) {
        try { process.kill(status.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await until(() => !fixtureProcessExists(status.pid, "Fixture daemon exit is unavailable"));
    };
  } finally {
    if (!client.isClosed) {
      const closed = once(client, "close");
      client.close();
      await closed;
    }
  }
}
