import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { AgentKind } from "../src/core/protocol.js";

export interface TestEnv {
  home: string;
  pipe: string;
  db: string;
  node(name: string, agent?: AgentKind, autoWake?: boolean): BridgeNode;
  cleanup(): Promise<void>;
}

/** An isolated bridge endpoint per test: its own home dir, so its own pipe and database. */
export function makeEnv(): TestEnv {
  // macOS tmpdir uses the /var alias; transfer fixtures deliberately require unlinked ancestors.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-bridge-test-")));
  const pipe = resolvePipePath(home, {});
  const db = resolveDbPath(home);
  const nodes: BridgeNode[] = [];
  return {
    home,
    pipe,
    db,
    node(name, agent = "claude", autoWake = false) {
      const n = new BridgeNode({ pipePath: pipe, token: loadOrCreateToken(home), dbPath: db, agent, name, cwd: home, autoWake, log: nullLogger });
      nodes.push(n);
      return n;
    },
    async cleanup() {
      await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function until(pred: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
