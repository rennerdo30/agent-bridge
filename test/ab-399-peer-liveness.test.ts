import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { physicalPath } from "../src/core/project-identity.js";
import { makeEnv } from "./helpers.js";
import type { TestEnv } from "./helpers.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { MessageStore } from "../src/core/store.js";
import { Broker } from "../src/core/broker.js";
import type { AgentKind, PeerInfo } from "../src/core/protocol.js";

/**
 * No real PowerShell or ps: every process-identity reader is a fixture. Synchronous probes of any process other
 * than this one are recorded, so a test can prove the broker's liveness check never runs one inline.
 */
const probe = vi.hoisted(() => ({ syncPids: [] as number[] }));
vi.mock("../src/core/process-identity.js", async original => {
  const actual = await original<typeof import("../src/core/process-identity.js")>();
  const own = "fixture-own-identity";
  const sync = (pid: number) => {
    if (pid !== process.pid) probe.syncPids.push(pid);
    return pid === process.pid ? own : undefined;
  };
  const ownOnly = (pids: number[]) => new Map(pids.filter(pid => pid === process.pid).map(pid => [pid, own] as const));
  return {
    ...actual,
    // Unknown: the broker skips its loopback TCP fallback, whose discovery record would start DPAPI PowerShell.
    ownProcessIdentity: async () => undefined,
    parentProcessIdentity: async () => "fixture-parent-identity",
    readProcessIdentity: async (pid: number) => pid === process.pid ? own : null,
    readProcessIdentities: async (pids: number[]) => ownOnly(pids),
    readProcessIdentitiesSync: (pids: number[]) => { pids.forEach(sync); return ownOnly(pids); },
    readProcessNamesSync: () => undefined,
    processIdentity: sync,
    processStartMs: (pid: number) => { sync(pid); return undefined; },
    isProcessIdentityAlive: (pid: number, identity: string) => { sync(pid); return pid === process.pid ? identity === own : undefined; },
    recordedOwnerLiveness: (pid: number, identity?: string) => { sync(pid); return pid === process.pid ? !identity || identity === own : undefined; },
    recordedOwnerAlive: (pid: number, identity?: string) => { sync(pid); return pid === process.pid ? !identity || identity === own : true; },
  };
});

/** Every child process a test starts (none expected: no PowerShell, ps or subst). */
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  type Fn = ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };
  const record = (fn: Fn): Fn => {
    const wrapped: Fn = (...args) => { spawned.push(String(args[0])); return fn(...args); };
    const custom = fn[promisify.custom];
    if (custom) wrapped[promisify.custom] = (...args) => { spawned.push(String(args[0])); return custom(...args); };
    return wrapped;
  };
  return { ...actual, execFile: record(actual.execFile as Fn), execFileSync: record(actual.execFileSync as Fn), spawn: record(actual.spawn as Fn),
    spawnSync: record(actual.spawnSync as Fn), exec: record(actual.exec as Fn), execSync: record(actual.execSync as Fn) };
});

type HostState = "alive" | "EPERM" | "ESRCH";
const hosts = new Map<number, HostState>();
const CLI = 2_000_391, OTHER_CLI = 2_000_392, NEXT_CLI = 2_000_393;

/** The creation identity this platform's reader reports for a process started at `ms` (epoch ms). */
function identityStartedAt(ms: number): string {
  if (process.platform === "win32") return String(BigInt(Math.floor(ms)) * 10_000n + 621_355_968_000_000_000n);
  if (process.platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))![1]);
    return `${boot}:${Math.ceil((ms - btime * 1000) / 10)}`;
  }
  // `ps -o lstart=` prints local time without a zone.
  return new Date(ms).toString().replace(/ GMT.*$/, "");
}

let env: TestEnv;
let clock: number;
let broker: Broker;
let reader: ReturnType<typeof vi.fn<(pids: number[]) => Promise<Map<number, string>>>>;
const clients: BridgeClient[] = [];

beforeEach(async () => {
  probe.syncPids.length = 0;
  spawned.length = 0;
  hosts.clear();
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    const state = hosts.get(pid);
    if (state && signal === 0) {
      if (state === "alive") return true;
      throw Object.assign(new Error(state), { code: state });
    }
    return realKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  env = makeEnv();
  clock = Date.now();
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home), () => clock);
  reader = vi.fn(async () => new Map<number, string>());
  broker.setIdentityReader(reader);
  await broker.listen();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await broker.close();
  await env.cleanup();
  vi.restoreAllMocks();
  expect(spawned.splice(0)).toEqual([]);
});

async function session(peer: Partial<PeerInfo> & { id: string; name: string; agent: AgentKind }): Promise<{ client: BridgeClient; events: Array<[string, unknown]> }> {
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  clients.push(client);
  const events: Array<[string, unknown]> = [];
  client.on("event", (ev, data) => events.push([ev, data]));
  await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
    cwd: env.home, pid: process.pid, agentPid: null, sessionId: `${peer.id}-session`, startedAt: clock, autoWake: false, activity: "idle", ...peer,
  } });
  return { client, events };
}

const sender = () => session({ id: "sender", name: "sender", agent: "codex", startedAt: clock + 1 });
/** POSIX without exact start ticks compares only the broker's own readings: the first sweep records the baseline. */
const baselineFirst = process.platform !== "win32" && process.platform !== "linux";
/** A sweep that finds `identity` on the CLI PID, after a baseline sweep of the original CLI where one is needed. */
async function sweepFinding(identity: string): Promise<void> {
  if (baselineFirst) {
    reader.mockResolvedValue(new Map([[CLI, identityStartedAt(clock - 2 * 60 * 60_000)]]));
    await broker.sweepPeerLiveness();
  }
  reader.mockResolvedValue(new Map([[CLI, identity]]));
  await broker.sweepPeerLiveness();
}
const names = async (client: BridgeClient) => (await client.request("peers", {})).map(p => p.name).sort();
/** Past the cached signal-0 probe of one request burst. */
const later = () => { clock += 5_000; };

describe("AB-399 drive aliases", () => {
  it("resolves a removed folder through its nearest existing ancestor's physical path", () => {
    const alias = resolve("/alias-drive"), physical = resolve("/physical-drive");
    const real = (path: string) => {
      if (path === alias) return physical;
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    };
    expect(physicalPath(join(alias, "repo", "removed"), real)).toBe(join(physical, "repo", "removed"));
    expect(() => physicalPath(join(resolve("/unknown-drive"), "repo"), () => { throw new Error("ENOENT"); })).toThrow("ENOENT");
  });
});

describe("AB-399 session liveness", () => {
  it("retires a session whose CLI exited, keeps its registration and queues its mail", async () => {
    hosts.set(CLI, "alive");
    const ghost = await session({ id: "ghost", name: "ghost", agent: "claude", agentPid: CLI, agentStartedAt: "cli-identity" });
    const { client } = await sender();
    const before = await client.request("peers", {});
    expect(before.find(p => p.name === "ghost")?.projectMain).toBe(true);
    hosts.set(CLI, "ESRCH");
    later();
    const after = await client.request("peers", {});
    expect(after.map(p => p.name)).toEqual(["sender"]);
    expect(after[0]?.projectMain).toBe(true);
    await vi.waitFor(() => expect(ghost.events).toContainEqual(["retired", { reason: "host_exited", agentPid: CLI }]));
    const sent = await client.request("send", { to: "ghost", body: "offline", conversationId: "ab399" });
    expect(sent.deliveredTo).toEqual([]);
    expect(sent.queuedFor).toEqual(["ghost"]);
    const retained = new DatabaseSync(env.db, { readOnly: true });
    try { expect(retained.prepare("SELECT name FROM peer_names WHERE name='ghost'").all()).toHaveLength(1); }
    finally { retained.close(); }
    expect(reader).not.toHaveBeenCalled();
    expect(probe.syncPids).not.toContain(CLI);
  });

  it("counts EPERM as alive", async () => {
    hosts.set(CLI, "EPERM");
    await session({ id: "guarded", name: "guarded", agent: "claude", agentPid: CLI, agentStartedAt: "cli-identity" });
    const { client } = await sender();
    later();
    expect(await names(client)).toEqual(["guarded", "sender"]);
    await broker.sweepPeerLiveness();
    later();
    expect(await names(client)).toEqual(["guarded", "sender"]);
  });

  it("never runs a process identity probe inline; the background sweep batches one query", async () => {
    hosts.set(CLI, "alive"); hosts.set(OTHER_CLI, "alive");
    await session({ id: "one", name: "one", agent: "claude", agentPid: CLI, agentStartedAt: "one-identity" });
    await session({ id: "two", name: "two", agent: "codex", agentPid: OTHER_CLI, agentStartedAt: "two-identity" });
    const { client } = await sender();
    for (let i = 0; i < 3; i++) { later(); await client.request("peers", {}); await client.request("send", { to: "one", body: "hi", conversationId: "ab399" }); }
    expect(reader).not.toHaveBeenCalled();
    expect(probe.syncPids.filter(pid => pid === CLI || pid === OTHER_CLI)).toEqual([]);
    await broker.sweepPeerLiveness();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]![0].sort()).toEqual([CLI, OTHER_CLI]);
  });

  it("counts a differing identity of a process that started before the hello as alive (format or time zone)", async () => {
    hosts.set(CLI, "alive");
    await session({ id: "zoned", name: "zoned", agent: "claude", agentPid: CLI, agentStartedAt: "recorded-in-another-format" });
    const { client } = await sender();
    reader.mockResolvedValue(new Map([[CLI, identityStartedAt(clock - 60 * 60_000)]]));
    await broker.sweepPeerLiveness();
    later();
    expect(await names(client)).toEqual(["sender", "zoned"]);
  });

  it("retires on proven PID reuse: the process now holding the PID started after the first hello", async () => {
    hosts.set(CLI, "alive");
    const reused = await session({ id: "reused", name: "reused", agent: "claude", agentPid: CLI, agentStartedAt: "original-identity" });
    const { client } = await sender();
    await sweepFinding(identityStartedAt(clock + 60_000));
    expect(await names(client)).toEqual(["sender"]);
    await vi.waitFor(() => expect(reused.events).toContainEqual(["retired", { reason: "pid_reused", agentPid: CLI }]));
  });

  it("keeps the first hello's CLI when a re-parented server reconnects with agentPid 1, and refuses it", async () => {
    hosts.set(CLI, "alive");
    const first = await session({ id: "orphan", name: "orphan", agent: "claude", agentPid: CLI, agentStartedAt: "cli-identity" });
    first.client.close();
    const { client } = await sender();
    await vi.waitFor(async () => expect(await names(client)).toEqual(["sender"]));
    hosts.set(CLI, "ESRCH");
    await expect(session({ id: "orphan", name: "orphan", agent: "claude", agentPid: 1, agentStartedAt: "init-identity" }))
      .rejects.toMatchObject({ code: "unauthorized", details: { retired: true, reason: "host_exited", agentPid: CLI } });
    later();
    expect(await names(client)).toEqual(["sender"]);
  });

  it("retires on PID reuse before a broker restart, using the recorded CLI start rather than the reconnect", async () => {
    hosts.set(CLI, "alive");
    // Linux identities count ticks since boot, and CI machines boot minutes before the job: keep both starts after boot.
    const bootMs = process.platform === "linux" ? Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))![1]) * 1000 : clock - 2 * 60 * 60_000;
    const span = clock - bootMs;
    // The CLI started well before; this broker first sees the session now (after its own restart).
    const restarted = await session({ id: "restarted", name: "restarted", agent: "claude", agentPid: CLI, agentStartedAt: identityStartedAt(bootMs + span / 4) });
    const { client } = await sender();
    // The PID now belongs to a later process: after the CLI, before this broker's first hello.
    reader.mockResolvedValue(new Map([[CLI, identityStartedAt(bootMs + span / 2)]]));
    await broker.sweepPeerLiveness();
    if (baselineFirst) {
      // Without exact start ticks the recorded identity may be in another time zone, so only the broker's own
      // readings count: reuse before its first reading is left to the server's own parent watch (fails safe).
      expect(await names(client)).toEqual(["restarted", "sender"]);
      expect(restarted.events.map(([ev]) => ev)).not.toContain("retired");
      return;
    }
    expect(await names(client)).toEqual(["sender"]);
    await vi.waitFor(() => expect(restarted.events).toContainEqual(["retired", { reason: "pid_reused", agentPid: CLI }]));
  });

  it("reads only hosts that still answer signal 0, and stops the sweep timer when none are left", async () => {
    hosts.set(CLI, "alive"); hosts.set(OTHER_CLI, "alive");
    await session({ id: "live-host", name: "live-host", agent: "claude", agentPid: CLI, agentStartedAt: "live-identity" });
    await session({ id: "gone-host", name: "gone-host", agent: "codex", agentPid: OTHER_CLI, agentStartedAt: "gone-identity" });
    const { client } = await sender();
    later(); await client.request("peers", {});
    const timer = () => (broker as unknown as { livenessTimer: unknown }).livenessTimer;
    expect(timer()).not.toBeNull();
    hosts.set(OTHER_CLI, "ESRCH");
    later();
    await broker.sweepPeerLiveness();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]![0]).toEqual([CLI]);
    hosts.set(CLI, "ESRCH");
    later();
    await broker.sweepPeerLiveness();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(timer()).toBeNull();
  });

  it("refuses a dead-CLI server before session recovery, replacement or mail claims", async () => {
    hosts.set(CLI, "ESRCH"); hosts.set(NEXT_CLI, "alive");
    const { client } = await sender();
    const queued = await client.request("send", { to: "agent:claude", body: "for any claude", conversationId: "ab399" });
    expect(queued.deliveredTo).toEqual([]);
    // A dead-CLI server (say, reconnecting after a broker restart) must not claim mail waiting for "any claude".
    await expect(session({ id: "dead", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: CLI, agentStartedAt: "dead-identity" }))
      .rejects.toMatchObject({ code: "unauthorized", details: { retired: true, reason: "host_exited" } });
    const live = await session({ id: "live", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: NEXT_CLI, agentStartedAt: "live-identity" });
    await vi.waitFor(() => expect(live.events.some(([ev, data]) => ev === "message" && (data as { body?: string }).body === "for any claude")).toBe(true));
    // Nor may it replace the live server of the same session.
    await expect(session({ id: "dead-again", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: CLI, agentStartedAt: "dead-identity" }))
      .rejects.toMatchObject({ code: "unauthorized", details: { retired: true, reason: "host_exited" } });
    later();
    expect(await names(client)).toEqual(["lead", "sender"]);
    expect(live.events.map(([ev]) => ev)).not.toContain("replaced");
    const sent = await client.request("send", { to: "lead", body: "still here", conversationId: "ab399" });
    expect(sent.deliveredTo).toEqual(["lead"]);
    const retained = new DatabaseSync(env.db, { readOnly: true });
    try { expect(retained.prepare("SELECT name FROM peer_names WHERE name='lead'").all().length).toBeGreaterThan(0); }
    finally { retained.close(); }
  });

  it("never retires a session connected over the loopback TCP fallback", async () => {
    const internals = broker as unknown as { accept(socket: unknown, transport?: "pipe" | "tcp"): void };
    const accept = internals.accept.bind(broker);
    internals.accept = (socket) => accept(socket, "tcp");
    hosts.set(CLI, "alive");
    const remote = await session({ id: "remote", name: "remote", agent: "claude", agentPid: CLI, agentStartedAt: "remote-identity" });
    internals.accept = accept;
    const { client } = await sender();
    hosts.set(CLI, "ESRCH");
    later();
    expect(await names(client)).toEqual(["remote", "sender"]);
    reader.mockResolvedValue(new Map([[CLI, identityStartedAt(clock + 60_000)]]));
    await broker.sweepPeerLiveness();
    expect(reader).not.toHaveBeenCalled();
    later();
    expect(await names(client)).toEqual(["remote", "sender"]);
    expect(remote.events.map(([ev]) => ev)).not.toContain("retired");
  });

  it("does not retire internal, opencode or job peers", async () => {
    hosts.set(CLI, "ESRCH"); hosts.set(OTHER_CLI, "ESRCH");
    await session({ id: "you", name: "you", agent: "other", agentPid: CLI, agentStartedAt: "dashboard" });
    await session({ id: "oc", name: "oc", agent: "opencode", agentPid: OTHER_CLI, agentStartedAt: "launcher" });
    const { client } = await sender();
    later();
    const sent = await client.request("send", { to: "oc", body: "hi", conversationId: "ab399" });
    expect(sent.deliveredTo).toEqual(["oc"]);
    const toOther = await client.request("send", { to: "you", body: "hi", conversationId: "ab399" });
    expect(toOther.deliveredTo).toEqual(["you"]);
    await broker.sweepPeerLiveness();
    expect(reader).not.toHaveBeenCalled();
  });

  it("gives a retired main its role back when the same session reconnects", async () => {
    hosts.set(CLI, "alive");
    await session({ id: "main-1", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: CLI, agentStartedAt: "cli-identity" });
    const { client } = await sender();
    expect((await client.request("peers", {})).find(p => p.name === "lead")?.projectMain).toBe(true);
    hosts.set(CLI, "ESRCH");
    later();
    expect((await client.request("peers", {})).find(p => p.name === "sender")?.projectMain).toBe(true);
    hosts.set(NEXT_CLI, "alive");
    await session({ id: "main-2", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: NEXT_CLI, agentStartedAt: "resumed-identity" });
    later();
    const peers = await client.request("peers", {});
    expect(peers.find(p => p.sessionId === "lead-session")?.projectMain).toBe(true);
    expect(peers.find(p => p.name === "sender")?.projectMain).toBe(false);
  });

  it("forgets a retired main after the grace window: the current main keeps its role", async () => {
    hosts.set(CLI, "alive");
    await session({ id: "main-1", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: CLI, agentStartedAt: "cli-identity" });
    const { client } = await sender();
    expect((await client.request("peers", {})).find(p => p.name === "lead")?.projectMain).toBe(true);
    hosts.set(CLI, "ESRCH");
    later();
    expect((await client.request("peers", {})).find(p => p.name === "sender")?.projectMain).toBe(true);
    clock += 5 * 60_000 + 1;
    hosts.set(NEXT_CLI, "alive");
    await session({ id: "main-2", name: "lead", agent: "claude", sessionId: "lead-session", agentPid: NEXT_CLI, agentStartedAt: "resumed-identity" });
    later();
    const peers = await client.request("peers", {});
    expect(peers.find(p => p.sessionId === "lead-session")?.projectMain).toBe(false);
    expect(peers.find(p => p.name === "sender")?.projectMain).toBe(true);
  });
});

/**
 * A released node that does not know the `retired` event, as in v0.30.21 node.ts: after a close it reconnects
 * with no delay (onClose), a hello refused with "unauthorized" sends it into nextBackoff (1 s doubling to 30 s),
 * and every successful hello resets that backoff. Time is simulated: the broker clock advances by each delay.
 */
async function oldNodeHellos(peer: Partial<PeerInfo> & { id: string; name: string; agent: AgentKind }, budgetMs: number, maxHellos: number) {
  let elapsed = 0, backoff = 1_000, hellos = 0, refused = 0;
  while (elapsed < budgetMs && hellos < maxHellos) {
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    clients.push(client);
    const closed = new Promise<boolean>(resolve => client.once("close", () => resolve(true)));
    hellos++;
    let delay: number;
    try {
      await client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: {
        cwd: env.home, pid: process.pid, agentPid: null, sessionId: `${peer.id}-session`, startedAt: clock, autoWake: false, activity: "idle", ...peer,
      } });
      backoff = 1_000;
      // Registered: the broker retires it at once (its CLI is gone), or it stays connected and the loop ends.
      const retired = await Promise.race([closed, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000))]);
      if (!retired) break;
      delay = 0;
    } catch (error) {
      expect(error).toMatchObject({ code: "unauthorized" });
      refused++;
      client.close();
      delay = backoff;
      backoff = Math.min(backoff * 2, 30_000);
    }
    elapsed += delay;
    clock += delay;
  }
  return { hellos, refused, elapsed };
}

describe("AB-399 nodes that ignore the retired event", () => {
  it("cannot reconnect in a tight loop after a host_exited retirement", async () => {
    hosts.set(CLI, "alive");
    const first = await session({ id: "legacy", name: "legacy", agent: "claude", agentPid: CLI, agentStartedAt: "cli-identity" });
    const { client } = await sender();
    hosts.set(CLI, "ESRCH");
    later();
    expect(await names(client)).toEqual(["sender"]);
    await vi.waitFor(() => expect(first.events).toContainEqual(["retired", { reason: "host_exited", agentPid: CLI }]));
    // Ten simulated minutes: 0 s, then 1, 2, 4, 8, 16 s and every 30 s after that, about 25 hellos in all.
    const run = await oldNodeHellos({ id: "legacy", name: "legacy", agent: "claude", agentPid: CLI, agentStartedAt: "cli-identity" }, 10 * 60_000, 200);
    expect(run.elapsed).toBeGreaterThanOrEqual(10 * 60_000);
    expect(run.hellos).toBeLessThanOrEqual(26);
    expect(run.refused).toBe(run.hellos);
    expect(await names(client)).toEqual(["sender"]);
  });

  it("cannot reconnect in a tight loop after a pid_reused retirement", async () => {
    hosts.set(CLI, "alive");
    const first = await session({ id: "reused-legacy", name: "reused-legacy", agent: "codex", agentPid: CLI, agentStartedAt: "original-identity" });
    const { client } = await sender();
    await sweepFinding(identityStartedAt(clock + 60_000));
    await vi.waitFor(() => expect(first.events).toContainEqual(["retired", { reason: "pid_reused", agentPid: CLI }]));
    const run = await oldNodeHellos({ id: "reused-legacy", name: "reused-legacy", agent: "codex", agentPid: CLI, agentStartedAt: "original-identity" }, 10 * 60_000, 200);
    expect(run.elapsed).toBeGreaterThanOrEqual(10 * 60_000);
    expect(run.hellos).toBeLessThanOrEqual(26);
    expect(run.refused).toBe(run.hellos);
    later();
    expect(await names(client)).toEqual(["sender"]);
  });
});

describe("AB-399 retired node", () => {
  it("stays off the bridge after retirement instead of reconnecting, and reports its original CLI", async () => {
    const ppid = vi.spyOn(process, "ppid", "get").mockReturnValue(CLI);
    hosts.set(CLI, "alive");
    const node = env.node("retiring", "claude");
    await node.ensureConnected();
    const { client } = await sender();
    expect(await names(client)).toEqual(["retiring", "sender"]);
    // POSIX re-parenting after the CLI ended: the node keeps reporting the CLI it was started by.
    ppid.mockReturnValue(1);
    hosts.set(CLI, "ESRCH");
    later();
    expect(await names(client)).toEqual(["sender"]);
    await vi.waitFor(() => expect(node.retirement).toBe("host_exited"));
    expect(node.wasReplaced).toBe(true);
    // Longer than the minimum reconnect backoff: no reconnect attempt follows.
    await new Promise(r => setTimeout(r, 1_500));
    expect(node.isConnected).toBe(false);
    later();
    expect(await names(client)).toEqual(["sender"]);
    expect((node as unknown as { helloArgs(): { peer: { agentPid: number | null } } }).helloArgs().peer.agentPid).toBe(CLI);
  });

  it("stays off the bridge when its hello is refused because its CLI is gone", async () => {
    vi.spyOn(process, "ppid", "get").mockReturnValue(CLI);
    hosts.set(CLI, "ESRCH");
    const node = env.node("late", "claude");
    await expect(node.ensureConnected()).rejects.toMatchObject({ code: "unauthorized", details: { retired: true } });
    expect(node.retirement).toBe("host_exited");
    const { client } = await sender();
    // Longer than the minimum reconnect backoff: no reconnect attempt follows.
    await new Promise(r => setTimeout(r, 1_500));
    expect(node.isConnected).toBe(false);
    expect(await names(client)).toEqual(["sender"]);
  });
});
