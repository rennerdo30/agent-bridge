import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const sender = peer("sender"), receiver = peer("receiver"), aMessages: BridgeMessage[] = [], bMessages: BridgeMessage[] = [];
  const mk = (name: string, peers: PeerInfo[], messages: BridgeMessage[], extra: Partial<NetworkConfig> = {}) => {
    const s = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, discovery: false, ...extra },
      { peers: () => peers, receive: (m) => { messages.push(m); return { delivered: true }; } }, nullLogger);
    services.push(s); return s;
  };
  const a = mk("pc", [sender], aMessages), b = mk("mac", [receiver], bMessages, config);
  await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
  return { a, b, sender, aMessages, bMessages };
}
const settled = (m: BridgeMessage, id: string) => m.body.includes(id) && / completed /.test(m.body) && /placed in|place in|not allowed/.test(m.body);
async function send(a: NetworkService, sender: PeerInfo, aMessages: BridgeMessage[], bMessages: BridgeMessage[], paths: string[]) {
  const started = a.startFiles("mac/receiver", paths, home, sender, false, "downloads");
  // Both sides are told where the files went (or why not).
  await wait(() => bMessages.some((m) => settled(m, started.id)) && aMessages.some((m) => settled(m, started.id)));
  return { receiver: bMessages.find((m) => settled(m, started.id))!.body, sender: aMessages.find((m) => settled(m, started.id))!.body };
}

it("places a completed transfer in the allowed Downloads folder under a free name and keeps the inbox copy", async () => {
  const downloads = join(home, "Downloads"); mkdirSync(downloads);
  writeFileSync(join(downloads, "app.aab"), "already here");
  const { a, sender, aMessages, bMessages } = await paired({ transferDestinations: { downloads } });
  const source = join(home, "app.aab"); writeFileSync(source, "new build");
  const folder = join(home, "assets"); mkdirSync(join(folder, "sub"), { recursive: true }); writeFileSync(join(folder, "sub", "a.txt"), "a");

  const { receiver: body, sender: told } = await send(a, sender, aMessages, bMessages, [source, folder]);
  expect(told).toContain(join(downloads, "app (2).aab"));
  expect(body).toContain("also placed in"); expect(body).toContain(join(downloads, "app (2).aab")); expect(body).toContain(join(downloads, "assets"));
  expect(readFileSync(join(downloads, "app.aab"), "utf8")).toBe("already here");
  expect(readFileSync(join(downloads, "app (2).aab"), "utf8")).toBe("new build");
  expect(readFileSync(join(downloads, "assets", "sub", "a.txt"), "utf8")).toBe("a");
  // The inbox copy stays.
  const inbox = join(home, "mac", "inbox");
  const [id] = readdirSync(inbox);
  expect(readFileSync(join(inbox, id!, "app.aab"), "utf8")).toBe("new build");
  // Windows: placed files carry the "downloaded from another computer" mark.
  if (process.platform === "win32") expect(readFileSync(`${join(downloads, "app (2).aab")}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
  // An independent copy: changing the placed file leaves the inbox copy as received.
  writeFileSync(join(downloads, "app (2).aab"), "edited");
  expect(readFileSync(join(inbox, id!, "app.aab"), "utf8")).toBe("new build");
  // No temporary names are left behind.
  expect(readdirSync(downloads).filter((n) => n.endsWith(".partial"))).toEqual([]);
});

it("keeps files only in the inbox when the receiving PC does not allow the place", async () => {
  const downloads = join(home, "Downloads"); mkdirSync(downloads);
  const { a, sender, aMessages, bMessages } = await paired({ transferDestinations: {} });
  const source = join(home, "report.txt"); writeFileSync(source, "x");
  const { receiver: body, sender: told } = await send(a, sender, aMessages, bMessages, [source]);
  expect(body).toContain('destination "downloads" is not allowed on this PC');
  expect(told).toContain('destination "downloads" is not allowed on this PC');
  expect(readdirSync(downloads)).toEqual([]);
  expect(existsSync(join(home, "mac", "inbox"))).toBe(true);
});

it("finishes a placement that a restart cut short, cleaning only its own leftover temporary copy", async () => {
  const { TransferManager } = await import("../src/network/transfers.js");
  const id = randomUUID(), downloads = join(home, "Downloads"), data = join(home, "receiver-home");
  mkdirSync(downloads); mkdirSync(join(data, "network", "transfers"), { recursive: true }); mkdirSync(join(data, "inbox", id), { recursive: true });
  writeFileSync(join(data, "inbox", id, "build.aab"), "complete build");
  writeFileSync(join(downloads, `.agent-bridge-${id}-0.partial`), "trunc");
  writeFileSync(join(downloads, "keep.txt"), "user file");
  writeFileSync(join(data, "network", "transfers", `${id}.json`), JSON.stringify({ version: 1, id, direction: "receive", remote: "remote-id", peer: "pc/sender",
    from: { id: "s", name: "sender", agent: "codex" }, to: "receiver", status: "completed", createdAt: 1, updatedAt: 1, paths: [], cwd: "", totalBytes: 14,
    entries: [{ path: "build.aab", kind: "file", size: 14, offset: 14, complete: true }], initialized: true, destination: "downloads", placingPending: true }));
  const notices: BridgeMessage[] = [], requests: Record<string, unknown>[] = [];
  const manager = new TransferManager(data, {
    supports: () => false, send: async (_remote: string, payload: Record<string, unknown>) => { requests.push(payload); }, validSender: () => true,
    localPeer: () => ({ id: "receiver", name: "receiver", agent: "codex", cwd: data }), notify: (m: BridgeMessage) => { notices.push(m); }, legacy: async () => { throw new Error("unused"); },
  } as never, nullLogger, { destinations: { downloads } });
  try {
    manager.resume();
    await wait(() => notices.some((m) => m.body.includes("also placed in")));
    expect(readFileSync(join(downloads, "build.aab"), "utf8")).toBe("complete build");
    expect(readdirSync(downloads).sort()).toEqual(["build.aab", "keep.txt"]);
    expect(requests.some((r) => r.op === "placed")).toBe(true);
  } finally { manager.close(); }
});

it("ends a pending placement whose place is no longer allowed after a restart, telling both sides", async () => {
  const { TransferManager } = await import("../src/network/transfers.js");
  const id = randomUUID(), data = join(home, "receiver-home");
  mkdirSync(join(data, "network", "transfers"), { recursive: true }); mkdirSync(join(data, "inbox", id), { recursive: true });
  writeFileSync(join(data, "inbox", id, "build.aab"), "complete build");
  writeFileSync(join(data, "network", "transfers", `${id}.json`), JSON.stringify({ version: 1, id, direction: "receive", remote: "remote-id", peer: "pc/sender",
    from: { id: "s", name: "sender", agent: "codex" }, to: "receiver", status: "completed", createdAt: 1, updatedAt: 1, paths: [], cwd: "", totalBytes: 14,
    entries: [{ path: "build.aab", kind: "file", size: 14, offset: 14, complete: true }], initialized: true, destination: "downloads", placingPending: true }));
  const notices: BridgeMessage[] = [], requests: Record<string, unknown>[] = [];
  const manager = new TransferManager(data, {
    supports: () => false, send: async (_remote: string, payload: Record<string, unknown>) => { requests.push(payload); }, validSender: () => true,
    localPeer: () => ({ id: "receiver", name: "receiver", agent: "codex", cwd: data }), notify: (m: BridgeMessage) => { notices.push(m); }, legacy: async () => { throw new Error("unused"); },
  } as never, nullLogger, { destinations: {} });
  try {
    manager.resume();
    await wait(() => notices.some((m) => m.body.includes("not allowed on this PC")));
    expect(requests.some((r) => r.op === "placed" && String(r.placeError).includes("not allowed"))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, "network", "transfers", `${id}.json`), "utf8")).placingPending).toBe(false);
    expect(readFileSync(join(data, "inbox", id, "build.aab"), "utf8")).toBe("complete build");
  } finally { manager.close(); }
});

it("resumes after the items a restart already placed, never placing one twice", async () => {
  const { TransferManager } = await import("../src/network/transfers.js");
  const id = randomUUID(), downloads = join(home, "Downloads"), data = join(home, "receiver-home");
  mkdirSync(downloads); mkdirSync(join(data, "network", "transfers"), { recursive: true }); mkdirSync(join(data, "inbox", id), { recursive: true });
  writeFileSync(join(data, "inbox", id, "a.txt"), "a"); writeFileSync(join(data, "inbox", id, "b.txt"), "b");
  writeFileSync(join(downloads, "a.txt"), "a"); // placed before the restart
  writeFileSync(join(data, "network", "transfers", `${id}.json`), JSON.stringify({ version: 1, id, direction: "receive", remote: "remote-id", peer: "pc/sender",
    from: { id: "s", name: "sender", agent: "codex" }, to: "receiver", status: "completed", createdAt: 1, updatedAt: 1, paths: [], cwd: "", totalBytes: 2,
    entries: [{ path: "a.txt", kind: "file", size: 1, offset: 1, complete: true }, { path: "b.txt", kind: "file", size: 1, offset: 1, complete: true }],
    initialized: true, destination: "downloads", placingPending: true, placedItems: [join(downloads, "a.txt"), null] }));
  const notices: BridgeMessage[] = [];
  const manager = new TransferManager(data, {
    supports: () => false, send: async () => {}, validSender: () => true,
    localPeer: () => ({ id: "receiver", name: "receiver", agent: "codex", cwd: data }), notify: (m: BridgeMessage) => { notices.push(m); }, legacy: async () => { throw new Error("unused"); },
  } as never, nullLogger, { destinations: { downloads } });
  try {
    manager.resume();
    await wait(() => notices.some((m) => m.body.includes("also placed in")));
    expect(readdirSync(downloads).sort()).toEqual(["a.txt", "b.txt"]);
  } finally { manager.close(); }
});

it("tells the sender when the paired PC is too old to place files (no acknowledgement)", async () => {
  const downloads = join(home, "Downloads"); mkdirSync(downloads);
  const { a, b, sender, aMessages } = await paired({ transferDestinations: { downloads } });
  // An older receiver: its offer schema drops the unknown destination field.
  const receive = b.receiveExtension.bind(b);
  vi.spyOn(b, "receiveExtension").mockImplementation((type, payload, remote) => {
    if ((payload as { op?: string }).op === "offer") delete (payload as { destination?: string }).destination;
    return receive(type, payload, remote);
  });
  const source = join(home, "x.txt"); writeFileSync(source, "x");
  const started = a.startFiles("mac/receiver", [source], home, sender, false, "downloads");
  await wait(() => aMessages.some((m) => m.body.includes(started.id) && m.body.includes("too old to place files")));
  expect(readdirSync(downloads)).toEqual([]);
});
