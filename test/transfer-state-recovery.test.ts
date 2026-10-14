import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { readTransferHistory, TransferManager } from "../src/network/transfers.js";

// AB-243: one unreadable or future-version transfer state must not stop networking; it is kept aside, never deleted.
it("starts with an unreadable and a future-version transfer state, keeping both files aside", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-transfer-state-")));
  try {
    const root = join(home, "network", "transfers");
    mkdirSync(root, { recursive: true });
    const truncated = randomUUID(), future = randomUUID();
    writeFileSync(join(root, `${truncated}.json`), '{"version":1,"id":');
    writeFileSync(join(root, `${future}.json`), JSON.stringify({ version: 2, id: future, entries: [] }));
    expect(readTransferHistory(home)).toEqual([]);
    const manager = new TransferManager(home, {
      supports: () => true, send: async () => {}, validSender: () => true,
      localPeer: () => ({ id: "receiver", name: "receiver", agent: "opencode", cwd: home }), notify: () => {}, legacy: async () => { throw new Error("unused"); },
    }, nullLogger);
    try { expect(manager.list()).toEqual([]); } finally { manager.close(); }
    const kept = readdirSync(root);
    expect(kept.filter((f) => f.startsWith(truncated)).map((f) => readFileSync(join(root, f), "utf8"))).toEqual(['{"version":1,"id":']);
    expect(kept.some((f) => f.startsWith(future))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
