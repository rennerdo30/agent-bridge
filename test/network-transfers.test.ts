import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as realDelay } from "node:timers/promises";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { isQuietMessage, type BridgeMessage, type PeerInfo } from "../src/core/protocol.js";
import { DEFAULT_NETWORK_CONFIG, type NetworkConfig } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { FILE_STREAM_CAPABILITY, FILE_STREAM_WINDOW_CAPABILITY, TRANSFER_CHUNK_BYTES, TRANSFER_WINDOW_CHUNKS } from "../src/network/transfers.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const LOOPBACK = "127.0.0.1";
const BIG_FILE_BYTES = 32 * 1024 * 1024 + 17;
const TRANSFER_TEST_WAIT_MS = 90_000;
let home: string;
let services: NetworkService[];
beforeEach(() => { home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-transfers-"))); services = []; });
afterEach(async () => { vi.useRealTimers(); for (const service of services.reverse()) await service.close(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
const peer = (name: string): PeerInfo => ({ id: randomUUID(), name, agent: "codex", cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false });
async function wait(check: () => boolean, timeout = TRANSFER_TEST_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error("transfer test timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
async function generate(path: string, bytes = BIG_FILE_BYTES): Promise<string> {
  const file = await open(path, "wx"); const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES); const hash = createHash("sha256");
  try { for (let offset = 0; offset < bytes;) { buffer.fill((offset / TRANSFER_CHUNK_BYTES) % 251); const data = buffer.subarray(0, Math.min(buffer.length, bytes - offset)); await file.write(data); hash.update(data); offset += data.length; } }
  finally { await file.close(); }
  return hash.digest("hex");
}
async function hash(path: string): Promise<string> { const value = createHash("sha256"); for await (const data of createReadStream(path, { highWaterMark: TRANSFER_CHUNK_BYTES })) value.update(data); return value.digest("hex"); }
function service(name: string, peers: PeerInfo[], messages: BridgeMessage[] = [], config: Partial<NetworkConfig> = {}): NetworkService {
  const network = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, discovery: false, ...config },
    { peers: () => peers, receive: (message) => { messages.push(message); return { delivered: true }; } }, nullLogger);
  services.push(network); return network;
}
async function paired(config: Partial<NetworkConfig> = {}) {
  const sender = peer("sender"); const receiver = peer("receiver"); const aMessages: BridgeMessage[] = []; const bMessages: BridgeMessage[] = [];
  const a = service("pc", [sender], aMessages); const b = service("mac", [receiver], bMessages, config);
  await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
  return { a, b, sender, receiver, aMessages, bMessages };
}

describe("chunked paired-PC file transfers", () => {
  it("writes ordinary messages ahead of chunks queued behind socket backpressure", async () => {
    const { a, sender, bMessages } = await paired();
    const source = join(home, "priority.bin"); const expected = await generate(source, (TRANSFER_WINDOW_CHUNKS + 1) * TRANSFER_CHUNK_BYTES);
    const socket = (a as unknown as { links: Map<string, { socket: TLSSocket }> }).links.values().next().value!.socket;
    const write = socket.write.bind(socket); let chunks = 0; let release: (() => void) | undefined;
    vi.spyOn(socket, "write").mockImplementation((...args) => {
      const frame = typeof args[0] === "string" ? JSON.parse(args[0]) as { type: string; payload?: { op?: string } } : undefined;
      if (frame?.type === "file-stream" && frame.payload?.op === "chunk" && ++chunks === 1) {
        const callback = args.find((arg) => typeof arg === "function") as (error?: Error) => void;
        return write(args[0] as string, (error) => { release = () => callback(error ?? undefined); });
      }
      return write(...args);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    try {
      await wait(() => Boolean(release), 10_000);
      const id = randomUUID();
      await a.send({ id, from: sender, to: "mac/receiver", recipient: "mac/receiver", conversationId: id, replyTo: null, hop: 0, body: "priority over queued writes", createdAt: Date.now(), readAt: null });
      expect(bMessages.some((m) => m.id === id)).toBe(true);
      expect(chunks).toBe(1);
    } finally { release?.(); }
    await wait(() => a.transfers.list().find((t) => t.id === started.id)?.status === "completed");
    expect(await hash(join(home, "mac", "inbox", started.id, "priority.bin"))).toBe(expected);
  });

  it("fills a bounded window before the first ack while ordinary messages bypass busy receivers", async () => {
    const { a, b, sender, bMessages } = await paired();
    const source = join(home, "window.bin"); const expected = await generate(source, (TRANSFER_WINDOW_CHUNKS + 1) * TRANSFER_CHUNK_BYTES + 17);
    const chunkRequests = new Set<string>(); let sent = 0; let held = 0;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const receive = b.receiveExtension.bind(b), send = b.sendExtension.bind(b), aSend = a.sendExtension.bind(a);
    vi.spyOn(b, "receiveExtension").mockImplementation((type, payload, remote) => {
      if (payload.op === "chunk") chunkRequests.add(String(payload.rid));
      return receive(type, payload, remote);
    });
    vi.spyOn(b, "sendExtension").mockImplementation(async (remote, type, payload) => {
      if (payload.kind === "response" && chunkRequests.has(String(payload.rid))) { held++; await gate; }
      return send(remote, type, payload);
    });
    vi.spyOn(a, "sendExtension").mockImplementation((remote, type, payload) => {
      if (payload.op === "chunk") sent++;
      return aSend(remote, type, payload);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    try {
      await wait(() => held === TRANSFER_WINDOW_CHUNKS, 10_000);
      expect(sent).toBe(TRANSFER_WINDOW_CHUNKS);
      const id = randomUUID();
      await a.send({ id, from: sender, to: "mac/receiver", recipient: "mac/receiver", conversationId: id, replyTo: null, hop: 0, body: "priority message", createdAt: Date.now(), readAt: null });
      expect(bMessages.some((m) => m.id === id)).toBe(true);
      expect(sent).toBe(TRANSFER_WINDOW_CHUNKS);
    } finally { release(); }
    await wait(() => a.transfers.list().find((t) => t.id === started.id)?.status === "completed");
    expect(await hash(join(home, "mac", "inbox", started.id, "window.bin"))).toBe(expected);
  });

  it("keeps one chunk in flight for an older peer without window support", async () => {
    const sender = peer("sender"), receiver = peer("receiver");
    const a = service("pc", [sender]), b = service("mac", [receiver]);
    const capabilities = b.extensionCapabilities.bind(b);
    vi.spyOn(b, "extensionCapabilities").mockImplementation(() => capabilities().filter((c) => c !== FILE_STREAM_WINDOW_CAPABILITY));
    await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
    const source = join(home, "legacy-window.bin"); await generate(source, 3 * TRANSFER_CHUNK_BYTES);
    const chunkRequests = new Set<string>(); let outstanding = 0; let largest = 0;
    const send = a.sendExtension.bind(a), receive = a.receiveExtension.bind(a);
    vi.spyOn(a, "sendExtension").mockImplementation((remote, type, payload) => {
      if (payload.op === "chunk") { chunkRequests.add(String(payload.rid)); largest = Math.max(largest, ++outstanding); }
      return send(remote, type, payload);
    });
    vi.spyOn(a, "receiveExtension").mockImplementation((type, payload, remote) => {
      if (payload.kind === "response" && chunkRequests.has(String(payload.rid))) outstanding--;
      return receive(type, payload, remote);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list().find((t) => t.id === started.id)?.status === "completed");
    expect(largest).toBe(1);
  });

  it("streams a generated big file and empty folders with bounded chunks and SHA-256", async () => {
    const { a, b, sender, aMessages, bMessages } = await paired();
    const source = join(home, "build"); mkdirSync(join(source, "empty"), { recursive: true });
    const expected = await generate(join(source, "build.bin")); writeFileSync(join(source, "zero"), "");
    const original = a.sendExtension.bind(a); let chunks = 0; let largest = 0;
    vi.spyOn(a, "sendExtension").mockImplementation(async (remote, type, payload) => {
      if (payload.op === "chunk") { chunks++; largest = Math.max(largest, Buffer.byteLength(payload.data as string, "base64")); }
      return original(remote, type, payload);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    expect(started).toEqual({ id: expect.any(String), status: "queued" });
    expect(a.transfers.list()[0]?.bytes).toBe(0);
    await wait(() => a.transfers.list()[0]?.status === "completed");
    expect(chunks).toBe(Math.ceil(BIG_FILE_BYTES / TRANSFER_CHUNK_BYTES)); expect(largest).toBe(TRANSFER_CHUNK_BYTES);
    const destination = join(home, "mac", "inbox", started.id, "build");
    expect(await hash(join(destination, "build.bin"))).toBe(expected);
    expect(existsSync(join(destination, "empty"))).toBe(true); expect(readFileSync(join(destination, "zero")).length).toBe(0);
    expect(b.transfers.list()[0]).toMatchObject({ status: "completed", bytes: BIG_FILE_BYTES, files: 2, percent: 100 });
    expect(aMessages.some((message) => message.body.includes("files: 100%"))).toBe(true);
    expect(bMessages.some((message) => message.id === started.id)).toBe(true);
    for (const messages of [aMessages, bMessages]) {
      const progress = messages.filter((message) => message.conversationId !== started.id);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every(isQuietMessage)).toBe(true);
      const outcomes = messages.filter((message) => !isQuietMessage(message));
      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes.every((message) => message.conversationId === started.id && message.body.includes("completed"))).toBe(true);
    }
  }, 60_000);

  it("restarts both brokers and resumes after the last verified chunk, repairing a corrupt part", async () => {
    const { a, b, sender, receiver } = await paired();
    const source = join(home, "restart.bin"); const expected = await generate(source, 8 * 1024 * 1024 + 3);
    const original = a.sendExtension.bind(a); let chunks = 0;
    vi.spyOn(a, "sendExtension").mockImplementation(async (remote, type, payload) => {
      if (payload.op === "chunk" && ++chunks === 4) throw new Error("network link closed");
      return original(remote, type, payload);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "paused");
    expect(b.transfers.list()[0]?.bytes).toBe(3 * TRANSFER_CHUNK_BYTES);
    const port = b.port; await a.close(); await b.close();
    const part = join(home, "mac", "network", "transfers", started.id, "0.part");
    expect(existsSync(join(home, "mac", "inbox", started.id, "restart.bin"))).toBe(false);
    const file = await open(part, "r+"); await file.write(Buffer.from("bad"), 0, 3, TRANSFER_CHUNK_BYTES); await file.close();
    const restartedB = service("mac", [{ ...receiver, id: randomUUID() }], [], { port });
    const restartedA = service("pc", [{ ...sender, id: randomUUID() }]);
    const offsets: number[][] = []; const handle = restartedA.receiveExtension.bind(restartedA);
    vi.spyOn(restartedA, "receiveExtension").mockImplementation((type, payload, remote) => { const data = payload.data as { offsets?: number[] } | undefined; if (data?.offsets) offsets.push(data.offsets); return handle(type, payload, remote); });
    await restartedB.start(); await restartedA.start();
    await wait(() => restartedA.transfers.list()[0]?.status === "completed");
    expect(offsets[0]).toEqual([TRANSFER_CHUNK_BYTES]);
    expect(await hash(join(home, "mac", "inbox", started.id, "restart.bin"))).toBe(expected);
  }, 60_000);

  it("rejects corrupt chunks and never publishes the damaged file", async () => {
    const { a, b, sender, aMessages } = await paired(); const source = join(home, "corrupt.bin"); await generate(source, 2 * TRANSFER_CHUNK_BYTES);
    const original = a.sendExtension.bind(a);
    vi.spyOn(a, "sendExtension").mockImplementation((remote, type, payload) => original(remote, type, payload.op === "chunk" ? { ...payload, sha256: "0".repeat(64) } : payload));
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "failed");
    expect(aMessages.filter((message) => !isQuietMessage(message))).toEqual([expect.objectContaining({ conversationId: started.id, body: expect.stringContaining("failed") })]);
    expect(a.transfers.list()[0]?.error).toMatch(/checksum/); expect(b.transfers.list()[0]?.bytes).toBe(0);
    expect(existsSync(join(home, "mac", "inbox", started.id, "corrupt.bin"))).toBe(false);
  });

  it("resumes after a real TLS link drop while the sender broker stays running", async () => {
    const { a, b, sender, receiver } = await paired(); const source = join(home, "link-drop.bin"); const expected = await generate(source, 4 * 1024 * 1024 + 3);
    const original = a.sendExtension.bind(a); const port = b.port; let dropped = false;
    vi.spyOn(a, "sendExtension").mockImplementation(async (remote, type, payload) => {
      if (payload.op === "chunk" && payload.offset === 2 * TRANSFER_CHUNK_BYTES && !dropped) {
        dropped = true;
        // Pipelining reads ahead: wait for the prefix's durable ack before dropping this chunk.
        await wait(() => b.transfers.list()[0]?.bytes === 2 * TRANSFER_CHUNK_BYTES);
        await b.close();
      }
      return original(remote, type, payload);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "paused");
    expect(b.transfers.list().find((state) => state.id === started.id)?.bytes).toBe(2 * TRANSFER_CHUNK_BYTES);
    const restarted = service("mac", [receiver], [], { port }); await restarted.start();
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "completed");
    expect(await hash(join(home, "mac", "inbox", started.id, "link-drop.bin"))).toBe(expected);
  }, 120_000);

  it.each(["EPIPE", "ECONNRESET"])("resumes when socket write reports %s before socket close", async (code) => {
    const { a, sender } = await paired();
    const source = join(home, "write-drop.bin"); const expected = await generate(source, TRANSFER_CHUNK_BYTES + 3);
    // Model the OS callback ordering independently of which platform runs this regression.
    const socket = (a as unknown as { links: Map<string, { socket: TLSSocket }> }).links.values().next().value!.socket;
    const write = socket.write.bind(socket); let injected = false;
    vi.spyOn(socket, "write").mockImplementation((...args) => {
      if (!injected && typeof args[0] === "string" && JSON.parse(args[0]).type === "file-stream") {
        injected = true;
        const callback = args.find((arg) => typeof arg === "function") as (error?: Error) => void;
        queueMicrotask(() => callback(Object.assign(new Error(`write ${code}`), { code })));
        return false;
      }
      return write(...args);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "paused", 5_000);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "completed", 10_000);
    expect(injected).toBe(true);
    expect(await hash(join(home, "mac", "inbox", started.id, "write-drop.bin"))).toBe(expected);
  });

  it("propagates source failures so both sides finish and partial files stay unpublished", async () => {
    const { a, b, sender } = await paired(); const source = join(home, "changed.bin"); await generate(source, TRANSFER_CHUNK_BYTES);
    const original = a.sendExtension.bind(a); let changed = false;
    vi.spyOn(a, "sendExtension").mockImplementation((remote, type, payload) => {
      if (payload.op === "chunk" && !changed) { changed = true; appendFileSync(source, "changed"); }
      return original(remote, type, payload);
    });
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "failed");
    await wait(() => b.transfers.list().find((state) => state.id === started.id)?.status === "failed");
    expect(b.transfers.list().find((state) => state.id === started.id)?.error).toMatch(/source file changed/);
    expect(existsSync(join(home, "mac", "inbox", started.id, "changed.bin"))).toBe(false);
  });

  it("rejects a wrong whole-file SHA-256 even when every chunk is valid", async () => {
    const { a, sender } = await paired(); const source = join(home, "corrupt-file.bin"); await generate(source, TRANSFER_CHUNK_BYTES);
    const original = a.sendExtension.bind(a);
    vi.spyOn(a, "sendExtension").mockImplementation((remote, type, payload) => original(remote, type, payload.op === "finish-file" ? { ...payload, sha256: "0".repeat(64) } : payload));
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "failed");
    expect(a.transfers.list()[0]?.error).toMatch(/checksum/);
    expect(existsSync(join(home, "mac", "inbox", started.id, "corrupt-file.bin"))).toBe(false);
  });

  it("keeps long verification alive with authenticated request heartbeats", async () => {
    const { a, b, sender } = await paired(); const source = join(home, "slow-check.bin"); await generate(source, TRANSFER_CHUNK_BYTES);
    const checker = b.transfers as unknown as { hashFile(path: string): Promise<string> };
    const original = checker.hashFile.bind(checker); let release!: () => void; let hashing = false; let heartbeats = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(checker, "hashFile").mockImplementation(async (path) => { hashing = true; await gate; return original(path); });
    const handle = a.receiveExtension.bind(a);
    vi.spyOn(a, "receiveExtension").mockImplementation((type, payload, remote) => { if (payload.kind === "heartbeat") heartbeats++; return handle(type, payload, remote); });
    const realWait = async (condition: () => boolean) => {
      const deadline = performance.now() + TRANSFER_TEST_WAIT_MS;
      while (!condition()) { if (performance.now() > deadline) throw new Error("heartbeat test timed out"); await realDelay(10); }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    try {
      const started = a.startFiles("mac/receiver", [source], home, sender);
      await realWait(() => hashing);
      for (let tick = 1; tick <= 7; tick++) { await vi.advanceTimersByTimeAsync(5_000); await realWait(() => heartbeats >= tick); }
      expect(a.transfers.list().find((state) => state.id === started.id)?.status).toBe("running");
      release(); await realWait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "completed");
    } finally { release(); vi.useRealTimers(); }
  });

  it("cancels a running transfer on both sides and persists the cancellation", async () => {
    const { a, b, sender, aMessages, bMessages } = await paired(); const source = join(home, "cancel.bin"); await generate(source);
    const original = a.sendExtension.bind(a); let id = "";
    vi.spyOn(a, "sendExtension").mockImplementation(async (remote, type, payload) => {
      if (payload.op === "chunk" && payload.offset === TRANSFER_CHUNK_BYTES) await a.transfers.cancel(id);
      return original(remote, type, payload);
    });
    id = a.startFiles("mac/receiver", [source], home, sender).id;
    await wait(() => a.transfers.list()[0]?.status === "cancelled" && b.transfers.list()[0]?.status === "cancelled");
    for (const messages of [aMessages, bMessages]) {
      expect(messages.filter((message) => !isQuietMessage(message))).toEqual([expect.objectContaining({ conversationId: id, body: expect.stringContaining("cancelled") })]);
    }
    expect(b.transfers.list()[0]!.bytes).toBeLessThan(BIG_FILE_BYTES);
    expect(existsSync(join(home, "mac", "inbox", id, "cancel.bin"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "pc", "network", "transfers", `${id}.json`), "utf8")).status).toBe("cancelled");
  });

  it("falls back to the old single-message path when the peer advertises no file capability", async () => {
    const sender = peer("sender"); const receiver = peer("receiver"); const a = service("pc", [sender]); const b = service("mac", [receiver]);
    vi.spyOn(b, "extensionCapabilities").mockReturnValue([]);
    await a.start(); await b.start(); await a.link(b.keys.invite(), LOOPBACK, b.port);
    expect(a.peerSupports("mac", FILE_STREAM_CAPABILITY)).toBe(false);
    const small = join(home, "small.txt"); writeFileSync(small, "legacy");
    const started = a.startFiles("mac/receiver", [small], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "completed");
    expect(readFileSync(join(home, "mac", "inbox", started.id, "small.txt"), "utf8")).toBe("legacy");
    const big = join(home, "large.bin"); await generate(big, 2 * 1024 * 1024);
    const rejected = a.startFiles("mac/receiver", [big], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === rejected.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === rejected.id)?.error).toMatch(/size limit/);
    expect(() => a.startFiles("mac/receiver", [small], home, sender, true)).toThrow(/fetch_files/);
  });

  it("fetches only configured roots, defaults to disabled, and rejects ancestor junctions", async () => {
    const allowed = join(home, "allowed"); mkdirSync(allowed); const source = join(allowed, "pull.bin"); const expected = await generate(source, 2 * TRANSFER_CHUNK_BYTES + 1);
    const { a, b, sender } = await paired({ fetchRoots: [allowed] });
    const started = a.startFiles("mac/receiver", [source], home, sender, true);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "completed");
    expect(await hash(join(home, "pc", "inbox", started.id, "pull.bin"))).toBe(expected);
    const outside = join(home, "secret.txt"); writeFileSync(outside, "secret");
    const denied = a.startFiles("mac/receiver", [outside], home, sender, true);
    await wait(() => a.transfers.list().find((state) => state.id === denied.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === denied.id)?.error).toMatch(/allowed fetch roots/);
    const alias = join(allowed, "alias"); symlinkSync(allowed, alias, "junction");
    const linked = a.startFiles("mac/receiver", [join(alias, "pull.bin")], home, sender, true);
    await wait(() => a.transfers.list().find((state) => state.id === linked.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === linked.id)?.error).toMatch(/symlinks or junctions/);
    const port = b.port; await b.close();
    const off = service("mac", [peer("receiver")], [], { port }); await off.start();
    await wait(() => a.peers().length === 1);
    const disabled = a.startFiles("mac/receiver", [source], home, sender, true);
    await wait(() => a.transfers.list().find((state) => state.id === disabled.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === disabled.id)?.error).toMatch(/disabled/);
  }, 60_000);

  it("enforces transfer limits, receiver free disk, no overwrite and portable names", async () => {
    const { a, b, sender } = await paired({ maxTransferBytes: TRANSFER_CHUNK_BYTES });
    const source = join(home, "oversize.bin"); await generate(source, 2 * TRANSFER_CHUNK_BYTES);
    const denied = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === denied.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === denied.id)?.error).toMatch(/size limit/);
    const small = join(home, "small.txt"); writeFileSync(small, "new");
    const started = a.startFiles("mac/receiver", [small], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === started.id)?.status === "completed");
    const destination = join(home, "mac", "inbox", started.id, "small.txt");
    writeFileSync(destination, "existing");
    const response: Record<string, unknown>[] = []; const original = b.sendExtension.bind(b);
    vi.spyOn(b, "sendExtension").mockImplementation((remote, type, payload) => { response.push(payload); return original(remote, type, payload); });
    await a.sendExtension("mac", "file-stream", { kind: "request", op: "offer", rid: randomUUID(), id: started.id, from: sender, to: "receiver", entries: [{ kind: "file", path: "small.txt", size: 3 }] });
    await wait(() => response.some((reply) => typeof reply.error === "string"));
    expect(response.find((reply) => reply.error)?.error).toMatch(/checksum/);
    expect(readFileSync(destination, "utf8")).toBe("existing");
  });

  it("rejects insufficient disk space before creating any partial file", async () => {
    const { a, b, sender } = await paired();
    const source = join(home, "disk.bin"); await generate(source, TRANSFER_CHUNK_BYTES);
    vi.mocked(statfs).mockResolvedValueOnce({ bavail: 1n, bsize: 1n } as never);
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "failed");
    expect(a.transfers.list()[0]?.error).toMatch(/insufficient free disk/);
    expect(b.transfers.list()[0]?.status).toBe("failed");
    expect(existsSync(join(home, "mac", "network", "transfers", started.id, "0.part"))).toBe(false);
  });

  it("rejects an inbox junction and a source with a junction in an ancestor", async () => {
    const { a, b, sender } = await paired(); const source = join(home, "source.txt"); writeFileSync(source, "data");
    const outside = join(home, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(home, "mac", "inbox"), "junction");
    const started = a.startFiles("mac/receiver", [source], home, sender);
    await wait(() => a.transfers.list()[0]?.status === "failed");
    expect(a.transfers.list()[0]?.error).toMatch(/symlinks or junctions/);
    expect(existsSync(join(outside, started.id))).toBe(false);
    const alias = join(home, "alias"); symlinkSync(home, alias, "junction");
    const rejected = a.startFiles("mac/receiver", [join(alias, "source.txt")], home, sender);
    await wait(() => a.transfers.list().find((state) => state.id === rejected.id)?.status === "failed");
    expect(a.transfers.list().find((state) => state.id === rejected.id)?.error).toMatch(/symlinks or junctions/);
    expect(b.transfers.list().every((state) => state.status === "failed" && state.bytes === 0)).toBe(true);
  });
});
