import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { MessageStore } from "../src/core/store.js";
import { resolveDbPath, resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";

const LOOPBACK = "127.0.0.1";
let root: string, aHome: string, bHome: string;
let cleanup: (() => Promise<unknown> | void)[];
beforeEach(() => {
  // Short native temp paths: macOS sockets cap paths at 104 bytes; Windows may use aliases.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "abds-")));
  aHome = join(root, "a"); bHome = join(root, "b");
  mkdirSync(aHome, { recursive: true }); mkdirSync(bHome, { recursive: true });
  cleanup = [];
});
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function node(home: string, name: string, networkName: string): Promise<BridgeNode> {
  const bridge = new BridgeNode({ pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: resolveDbPath(home),
    agent: "codex", name, cwd: home, autoWake: false, log: nullLogger,
    network: { home, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: networkName, bind: LOOPBACK, port: 0, discovery: false } } });
  await bridge.start();
  cleanup.push(() => bridge.stop());
  await bridge.setSessionId(`${name}-session`);
  return bridge;
}
async function admin(home: string): Promise<BridgeClient> {
  const client = await BridgeClient.connect(resolvePipePath(home, {}), nullLogger);
  cleanup.push(() => client.close());
  await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
  return client;
}
async function waitFor(test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error("decision sync timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function paired() {
  const a = await node(aHome, "alpha", "alpha-pc");
  const b = await node(bHome, "beta", "beta-pc");
  const adminA = await admin(aHome), adminB = await admin(bHome);
  const invitation = await adminB.request("networkPair", {});
  const status = await adminB.request("networkStatus", {});
  await adminA.request("networkLink", { code: invitation.code, host: LOOPBACK, port: status.port! });
  await waitFor(async () => (await adminA.request("networkStatus", {})).paired.some((p) => p.connected));
  return { a, b, adminA, adminB };
}

describe("forked decision history", () => {
  it("keeps exactly one current revision when both PCs decided the same topic apart, without rewriting rows", () => {
    const store = new MessageStore(":memory:", nullLogger);
    cleanup.push(() => store.close());
    const author = { id: "a", name: "alpha", agent: "codex" as const };
    const base = store.decisions.record({ topic: "lunch", text: "Ramen", scope: "all" }, author, 1_000);
    const local = store.decisions.record({ topic: "lunch", text: "Udon", scope: "all" }, author, 3_000);
    // Recorded on the other PC while apart: older than the local revision, both superseding base.
    const remote = { id: "00000000-0000-4000-8000-000000000002", topic: "lunch", text: "Soba", scope: "all" as const, author, createdAt: 2_000, sourceMessageId: null, supersedes: base.id };
    expect(store.decisions.importSync(remote)).toBe(true);
    expect(store.decisions.importSync(remote)).toBe(false);
    const current = () => store.decisions.list({ topic: "lunch" }).map((d) => d.text);
    expect(current()).toEqual(["Udon"]);
    const history = store.decisions.list({ topic: "lunch", history: true });
    expect(history.find((d) => d.id === local.id)!.supersedes).toBe(base.id);
    expect(history.find((d) => d.id === remote.id)!.supersedes).toBe(base.id);
    // The next local decision supersedes the current revision, not the last imported row.
    const next = store.decisions.record({ topic: "lunch", text: "Curry", scope: "all" }, author, 4_000);
    expect(next.supersedes).toBe(local.id);
    expect(current()).toEqual(["Curry"]);
    // A newer revision from the other PC wins on arrival.
    store.decisions.importSync({ ...remote, id: "00000000-0000-4000-8000-000000000003", text: "Pho", createdAt: 5_000, supersedes: local.id });
    expect(current()).toEqual(["Pho"]);
  });
});

describe("owner decision sync between paired PCs", () => {
  it("syncs scope-all decisions in both directions with ids intact and notifies once", async () => {
    const { a, b } = await paired();
    const first = await a.decide({ topic: "lunch", text: "Ramen", scope: "all" });
    await waitFor(async () => (await b.decisions({ scope: "all" })).some((d) => d.id === first.decision.id));
    const synced = (await b.decisions({ scope: "all" })).find((d) => d.id === first.decision.id)!;
    expect(synced).toMatchObject({ topic: "lunch", text: "Ramen", createdAt: first.decision.createdAt, current: true });
    expect(synced.author).toEqual(first.decision.author);
    await waitFor(() => b.unread().length === 1);
    expect(b.unread()[0]!.conversationId).toBe(`decision-${first.decision.id}`);
    // The reverse direction works too, without duplicating the earlier decision.
    const second = await b.decide({ topic: "dinner", text: "Sushi", scope: "all" });
    await waitFor(async () => (await a.decisions({ scope: "all" })).some((d) => d.id === second.decision.id));
    expect((await b.decisions({ scope: "all" })).filter((d) => d.id === first.decision.id)).toHaveLength(1);
    expect((await a.decisions({ scope: "all" })).map((d) => d.topic).sort()).toEqual(["dinner", "lunch"]);
  });

  it("keeps the newer revision current on both sides with history intact", async () => {
    const { a, b } = await paired();
    const first = await a.decide({ topic: " Backups ", text: "Daily", scope: "all" });
    await waitFor(async () => (await b.decisions({ scope: "all" })).some((d) => d.id === first.decision.id));
    const second = await b.decide({ topic: "BACKUPS", text: "Before migrations", scope: "all" });
    expect(second.decision).toMatchObject({ topic: "backups", supersedes: first.decision.id, current: true });
    await waitFor(async () => (await a.decisions({ scope: "all" })).some((d) => d.id === second.decision.id));
    for (const peer of [a, b]) {
      expect(await peer.decisions({ scope: "all", query: "backup" })).toHaveLength(1);
      expect(await peer.decisions({ scope: "all", query: "backup" })).toMatchObject([{ id: second.decision.id, current: true }]);
      const history = await peer.decisions({ history: true, topic: "backups" });
      expect(history.map((d) => d.id).sort()).toEqual([first.decision.id, second.decision.id].sort());
      expect(history.find((d) => d.id === first.decision.id)).toMatchObject({ current: false, text: "Daily" });
      expect(history.find((d) => d.id === second.decision.id)).toMatchObject({ current: true, supersedes: first.decision.id });
    }
  });

  it("delivers a decision recorded while disconnected on reconnect", async () => {
    const { a, b, adminA, adminB } = await paired();
    const idA = (await adminA.request("networkStatus", {})).identity!.id;
    const idB = (await adminB.request("networkStatus", {})).identity!.id;
    await adminA.request("networkUnlink", { id: idB });
    await adminB.request("networkUnlink", { id: idA });
    await waitFor(async () => !(await adminA.request("networkStatus", {})).paired.some((p) => p.connected));
    const meanwhile = await a.decide({ topic: "offline", text: "Recorded while apart", scope: "all" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await b.decisions({ scope: "all" })).toEqual([]);
    const invitation = await adminB.request("networkPair", {});
    const status = await adminB.request("networkStatus", {});
    await adminA.request("networkLink", { code: invitation.code, host: LOOPBACK, port: status.port! });
    await waitFor(async () => (await b.decisions({ scope: "all" })).some((d) => d.id === meanwhile.decision.id));
    expect(await b.decisions({ scope: "all" })).toMatchObject([{ id: meanwhile.decision.id, current: true }]);
  });

  it("never syncs project-scoped decisions", async () => {
    const { a, b } = await paired();
    await a.decide({ topic: "local", text: "Stays here", scope: { project: aHome } });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await b.decisions({ scope: "all" })).toEqual([]);
    expect(await b.decisions({ history: true, scope: { project: aHome } })).toEqual([]);
    expect(b.unread()).toEqual([]);
    expect((await a.decisions({ scope: "all" })).map((d) => d.topic)).not.toContain("local");
  });
});
