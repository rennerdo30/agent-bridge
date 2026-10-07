import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NetworkService } from "../src/network/link.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { decodePairingCode } from "../src/network/pairing.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("advertises changed peers while unchanged refreshes still verify the link", async () => {
  const peers: PeerInfo[] = [{ id: "session-id", name: "session", agent: "codex", cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false }];
  const config = { ...DEFAULT_NETWORK_CONFIG, enabled: true, discovery: false, bind: "127.0.0.1", port: 0 };
  const a = new NetworkService(join(env.home, "a"), { ...config, name: "pc-a" }, { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
  const b = new NetworkService(join(env.home, "b"), { ...config, name: "pc-b" }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger);
  try {
    await a.start(); await b.start();
    const invite = b.keys.invite(); b.keys.accept(decodePairingCode(invite).key, a.keys.identity);
    await a.link(invite, "127.0.0.1", b.port);
    const link = [...(a as any).links.values()][0];
    link.refresh();
    const writes = vi.spyOn(link, "write");
    link.refresh(); link.refresh();
    expect(writes.mock.calls.filter((args: any) => args[0].type === "peers")).toHaveLength(0);
    await a.verify(b.keys.identity.id);
    expect(writes.mock.calls.some((args: any) => args[0].type === "echo")).toBe(true);
    peers[0]!.activity = "busy"; link.refresh();
    await until(() => b.peers()[0]?.activity === "busy");
    expect(writes.mock.calls.filter((args: any) => args[0].type === "peers")).toHaveLength(1);
    peers.splice(0); link.refresh(); await until(() => b.peers().length === 0);
    expect(writes.mock.calls.filter((args: any) => args[0].type === "peers")).toHaveLength(2);
  } finally { await a.close(); await b.close(); }
});
