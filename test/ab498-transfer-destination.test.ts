import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { DEFAULT_NETWORK_CONFIG, type NetworkConfig } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";

// AB-498: a sender may ask a paired PC to also place received files in its Downloads folder, if that PC allows it.
const LOOPBACK = "127.0.0.1";
let home: string;
let services: NetworkService[];
beforeEach(() => { home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-dest-"))); services = []; });
afterEach(async () => { for (const s of services.reverse()) await s.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
const peer = (name: string): PeerInfo => ({ id: randomUUID(), name, agent: "codex", cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false });
async function wait(check: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
}
async function paired(config: Partial<NetworkConfig>) {
  const sender = peer("sender"), receiver = peer("receiver"), bMessages: BridgeMessage[] = [];
  const mk = (name: string, peers: PeerInfo[], messages: BridgeMessage[], extra: Partial<NetworkConfig> = {}) => {
    const s = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, discovery: false, ...extra },
      { peers: () => peers, receive: (m) => { messages.push(m); return { delivered: true }; } }, nullLogger);
    services.push(s); return s;
  };
  const a = mk("pc", [sender], []), b = mk("mac", [receiver], bMessages, config);
  await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
  return { a, b, sender, bMessages };
}
async function send(a: NetworkService, sender: PeerInfo, bMessages: BridgeMessage[], paths: string[]) {
  const started = a.startFiles("mac/receiver", paths, home, sender, false, "downloads");
  await wait(() => bMessages.some((m) => m.body.includes(started.id) && / completed /.test(m.body)));
  return bMessages.find((m) => m.body.includes(started.id) && / completed /.test(m.body))!.body;
}

it("places a completed transfer in the allowed Downloads folder under a free name and keeps the inbox copy", async () => {
  const downloads = join(home, "Downloads"); mkdirSync(downloads);
  writeFileSync(join(downloads, "app.aab"), "already here");
  const { a, sender, bMessages } = await paired({ transferDestinations: { downloads } });
  const source = join(home, "app.aab"); writeFileSync(source, "new build");
  const folder = join(home, "assets"); mkdirSync(join(folder, "sub"), { recursive: true }); writeFileSync(join(folder, "sub", "a.txt"), "a");

  const body = await send(a, sender, bMessages, [source, folder]);
  expect(body).toContain("also placed in"); expect(body).toContain(join(downloads, "app (2).aab")); expect(body).toContain(join(downloads, "assets"));
  expect(readFileSync(join(downloads, "app.aab"), "utf8")).toBe("already here");
  expect(readFileSync(join(downloads, "app (2).aab"), "utf8")).toBe("new build");
  expect(readFileSync(join(downloads, "assets", "sub", "a.txt"), "utf8")).toBe("a");
  // The inbox copy stays.
  const inbox = join(home, "mac", "inbox");
  const [id] = readdirSync(inbox);
  expect(readFileSync(join(inbox, id!, "app.aab"), "utf8")).toBe("new build");
});

it("keeps files only in the inbox when the receiving PC does not allow the place", async () => {
  const downloads = join(home, "Downloads"); mkdirSync(downloads);
  const { a, sender, bMessages } = await paired({ transferDestinations: {} });
  const source = join(home, "report.txt"); writeFileSync(source, "x");
  const body = await send(a, sender, bMessages, [source]);
  expect(body).toContain('destination "downloads" is not allowed on this PC');
  expect(readdirSync(downloads)).toEqual([]);
  expect(existsSync(join(home, "mac", "inbox"))).toBe(true);
});
