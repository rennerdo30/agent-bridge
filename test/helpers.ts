import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { AgentKind } from "../src/core/protocol.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import type { MessageStore } from "../src/core/store.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { describeFileLockers } from "./file-lockers.js";

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
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "abt-")));
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
      closeMetadataDb(home);
      // Yield between Windows handle-release retries so pending shutdown callbacks and exiting child processes can
      // finish; linear backoff gives a loaded runner about 5.5 s.
      try { await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) {
        // CI keeps only the console: name the process (this test process or a child) that still holds the file.
        const path = (error as NodeJS.ErrnoException).path;
        if (process.platform === "win32" && path && ["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          (error as Error).message += `
Held by:
${await describeFileLockers(path)}`;
        }
        throw error;
      }
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

/** Seed an existing inbox atomically; measure delivery rather than disk sync per fixture row. */
export function seedInbox(store: MessageStore, messages: BridgeMessage[]): void {
  const db = (store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec("BEGIN");
  try {
    for (const message of messages) store.insert(message);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
