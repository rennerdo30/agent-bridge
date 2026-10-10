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
import { describeOpenDatabases } from "./open-db-tracker.js";

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
      await removeHome(home);
    },
  };
}

/** Delete a test home, re-closing the shared metadata handle before every attempt.
 * Background store-identity refreshes (a PowerShell query on Windows that takes seconds
 * under load) can reopen the handle after it is closed; without a re-close every
 * deletion retry fails with EBUSY held by this test process (AB-255).
 * Linear backoff gives a loaded runner about 5.5 s before the holders are named. */
export async function removeHome(home: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    closeMetadataDb(home);
    if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * attempt));
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 10 || !["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"].includes(code)) {
        // CI keeps only the console: name the process (this test process or a child) that still holds the file,
        // and which in-process SQLite handles are still open on this home (AB-255).
        const path = (error as NodeJS.ErrnoException).path;
        if (process.platform === "win32" && path && ["EBUSY", "EPERM"].includes(code)) {
          (error as Error).message += `
Held by:
${await describeFileLockers(path)}
Open in this process under ${home}:
${describeOpenDatabases(home) || "(none tracked)"}`;
        }
        throw error;
      }
      attempt++;
    }
  }
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
