import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metadataDb, saveMetadataValue } from "../src/core/metadata-db.js";
import { importMetadataDomain } from "../src/core/metadata-import.js";
import * as identity from "../src/core/process-identity.js";
import { assertStoreUpgrade, liveStorePeers, refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { registrationIdentity } from "../src/core/store.js";
import { withDirectoryAlias } from "./directory-alias-fixture.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { primeRunnerProcessIdentities, runnerProcessAlive } from "../src/mcp/job-host.js";
import { JobManager, type Job, type RunnerState } from "../src/mcp/jobs.js";
import { nullLogger } from "../src/core/logger.js";

// This file drives the PowerShell probe (the fallback path); the native host (AB-427) must not answer instead.
vi.mock("../src/core/windows-process-identity.js", () => ({ readNativeIdentities: () => undefined, readNativeIdentitiesSync: () => undefined }));
// Keep the real implementation by default, including the existing native AB-362 query checks below.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn(actual.execFile);
  // Node's real custom promisifier closes over its original execFile. Route through the mock
  // so tests count launches at the asynchronous OS boundary as well as the synchronous one.
  Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    (execFile as (...args: unknown[]) => unknown)(...args, (error: Error | null, stdout: string, stderr: string) => {
      if (error) reject(error); else resolve({ stdout, stderr });
    });
  }) });
  return { ...actual, execFile };
});
const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

// 2026-10-10: ~20 jobs starting at once made the batch PowerShell identity query time out. Its empty result
// marked every live 0.30.6 reader "unknown, reads 0" and blocked spawn_codex behind a json 0→4 upgrade.
let env: TestEnv;
const pid = 2_000_011;
beforeEach(() => {
  env = makeEnv();
  vi.spyOn(process, "kill").mockImplementation(((target: number) => { if (target === pid) return true; throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); }) as typeof process.kill);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  vi.mocked(childProcess.execFile).mockReset().mockImplementation(realChildProcess.execFile);
  await env.cleanup();
});

const versionOf = () => liveStorePeers(env.home).find(peer => peer.pid === pid)?.version;
const expire = () => vi.setSystemTime(Date.now() + 11_000);

it("keeps registration identity physical through drive/directory aliases", async () => {
  await withDirectoryAlias(env.home, (alias) => {
    const peer = { id: "peer", name: "codex-peer", agent: "codex", cwd: env.home, agentPid: 123, agentStartedAt: "generation-1" } as unknown as PeerInfo;
    expect(registrationIdentity({ ...peer, cwd: alias })).toBe(registrationIdentity(peer));
  });
});

it("keeps verified readers known when a later identity query fails, but not readers a successful query misses", async () => {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  saveMetadataValue(env.home, "storage-capabilities", String(pid), { schemaVersion: 1, json: 4, sqlite: 9, pid, name: "reader", version: "0.30.6", explicit: true, observedAt: Date.now(), processIdentity: "generation-1" });
  const query = vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map([[pid, "generation-1"]]));
  await refreshStorePeerIdentities(env.home);
  expect(versionOf()).toBe("0.30.6");
  vi.useFakeTimers({ toFake: ["Date"] });

  // The query fails or times out: nothing was observed, so the last verified identity stands.
  query.mockRejectedValue(Object.assign(new Error("timed out"), { code: identity.IDENTITY_QUERY_FAILED }));
  expire();
  await refreshStorePeerIdentities(env.home);
  expect(query).toHaveBeenCalledTimes(2);
  expect(versionOf()).toBe("0.30.6");
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();

  // A successful query without the PID: the cached reader is unknown again.
  query.mockResolvedValue(new Map());
  expire();
  await refreshStorePeerIdentities(env.home);
  expect(versionOf()).toBe("unknown");
  // An unreadable agent runtime remains unknown regardless of the old row's capabilities.
  const direct = vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, ""]]));
  const names = vi.spyOn(identity, "readProcessNamesSync").mockReturnValue(new Map([[pid, "node.exe"]]));
  expect(() => assertStoreUpgrade(env.home, "json", 4, 5)).toThrow(/Waiting to upgrade json store 4→5/);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  // A positively identified system process cannot be the recorded Bridge reader, even beyond its old ceiling.
  names.mockReturnValue(new Map([[pid, "svchost"]]));
  if (process.platform === "win32") {
    expect(() => assertStoreUpgrade(env.home, "json", 4, 5)).not.toThrow();
    expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
  } else {
    expect(() => assertStoreUpgrade(env.home, "json", 4, 5)).toThrow(/Waiting to upgrade json store 4→5/);
    expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  }
  // No name evidence means the reader is still unknown.
  names.mockReturnValue(undefined);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  // ...a failed direct query keeps blocking...
  direct.mockReturnValue(undefined);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  // ...an unlisted PID that still answers a signal normally is a race and keeps blocking...
  direct.mockReturnValue(new Map());
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  // ...while an exited reader whose PID a lingering handle keeps answering (EPERM, not listed) is gone.
  vi.mocked(process.kill).mockImplementation(((target: number) => { throw Object.assign(new Error(target === pid ? "EPERM" : "ESRCH"), { code: target === pid ? "EPERM" : "ESRCH" }); }) as typeof process.kill);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
});

it("keeps identityless readers deferred while discovery is pending", () => {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map());
  saveMetadataValue(env.home, "storage-capabilities", String(pid), { schemaVersion: 1, json: 4, sqlite: 9, pid, name: "reader", version: "0.30.6", explicit: true, observedAt: Date.now() });
  const direct = vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, "new-generation"]]));
  const names = vi.spyOn(identity, "readProcessNamesSync").mockReturnValue(new Map([[pid, "svchost"]]));
  // AB-390: the immediate query now covers identityless rows, but an identity that proves no start time keeps blocking.
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  expect(direct).toHaveBeenCalledWith([pid]);
  expect(names).not.toHaveBeenCalled();
});

// AB-390 (2026-10-15): an exited session's identityless row (observedAt only) blocked every job start while a
// conhost started 43 minutes later held its PID. Identities in the live format of each platform:
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function startedAt(ms: number): string {
  if (process.platform === "win32") return String(BigInt(ms) * 10000n + 621355968000000000n);
  if (process.platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))![1]);
    return `${boot}:${Math.floor((ms - btime * 1000) / 10)}`;
  }
  // `ps -o lstart=` with LC_ALL=C prints local time, e.g. "Thu Oct 15 22:52:51 2026".
  const d = new Date(ms), two = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}
function identitylessReader(extra: Record<string, unknown> = {}) {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map());
  const record = { schemaVersion: 1, json: 4, sqlite: 9, jobArchive: 1, pid, name: "claude-animal-catch-game-2", version: "0.30.21", explicit: true, ...extra };
  saveMetadataValue(env.home, "storage-capabilities", String(pid), record);
  return metadataDb(env.home).prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid));
}

it("stops blocking on an identityless reader whose PID now belongs to a process started after the observation", () => {
  const observedAt = Date.now() - 43 * 60_000;
  const before = identitylessReader({ observedAt });
  const direct = vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, startedAt(observedAt + 43 * 60_000)]]));
  expect(versionOf()).toBe("unknown");
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
  expect(() => assertStoreUpgrade(env.home, "json", 4, 5)).not.toThrow();
  expect(direct).toHaveBeenCalledWith([pid]);
  // The row is evidence, never removed or rewritten.
  expect(metadataDb(env.home).prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid))).toEqual(before);
});

it("judges an identityless imported row without observedAt by its row time", () => {
  identitylessReader();
  vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, startedAt(Date.now() + 60_000)]]));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
});

it("keeps blocking on an identityless reader whose PID's process started before the observation", () => {
  const observedAt = Date.now() - 60_000;
  identitylessReader({ observedAt });
  const direct = vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, startedAt(observedAt - 10 * 60_000)]]));
  // It may be the recorded reader: the async refresh, not the immediate check, verifies it.
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4: claude-animal-catch-game-2 \(vunknown, pid 2000011/);
  // Within the one-second start-time slack it is not provably later either.
  direct.mockReturnValue(new Map([[pid, startedAt(observedAt + 500)]]));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
});

it("keeps blocking on an identityless reader when the identity lookup fails, and says so", () => {
  identitylessReader({ observedAt: Date.now() - 43 * 60_000 });
  vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(undefined);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4: .*pid 2000011.*Liveness of pid 2000011 is unknown: the process identity lookup failed/);
});

it("names a failed background identity refresh in the wait and clears it after a successful one", async () => {
  const observedAt = Date.now() - 60_000;
  identitylessReader({ observedAt });
  const query = vi.mocked(identity.readProcessIdentities).mockRejectedValue(Object.assign(new Error("process identity query failed: timed out"), { code: identity.IDENTITY_QUERY_FAILED }));
  await refreshStorePeerIdentities(env.home);
  expect(query).toHaveBeenCalledTimes(1);
  vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, startedAt(observedAt - 60_000)]]));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/The background process identity refresh last failed: process identity query failed: timed out/);
  query.mockResolvedValue(new Map([[pid, startedAt(observedAt - 60_000)]]));
  await refreshStorePeerIdentities(env.home);
  // Verified as the observed reader with sufficient capabilities: no longer a blocker, and no stale failure text.
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
  expect(() => assertStoreUpgrade(env.home, "json", 4, 5)).toThrow(/^(?!.*refresh last failed).*Waiting to upgrade json store 4→5/);
});

it("queries only PIDs that still exist in the background refresh", async () => {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  const gone = pid + 1;
  for (const target of [pid, gone]) saveMetadataValue(env.home, "storage-capabilities", String(target), { schemaVersion: 1, json: 4, sqlite: 9, pid: target, name: `reader-${target}`, version: "0.30.6", explicit: true, observedAt: Date.now(), processIdentity: `generation-${target}` });
  const query = vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map([[pid, `generation-${pid}`]]));
  await refreshStorePeerIdentities(env.home);
  expect(query).toHaveBeenCalledWith([pid]);
  expect(versionOf()).toBe("0.30.6");
});

function unreadableReader() {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  vi.spyOn(identity, "readProcessIdentities").mockResolvedValue(new Map());
  const record = { schemaVersion: 1, json: 4, sqlite: 9, jobArchive: 1, pid, name: "finished-reader", version: "0.30.6", explicit: true, observedAt: Date.now(), processIdentity: "old-generation" };
  saveMetadataValue(env.home, "storage-capabilities", String(pid), record);
  vi.spyOn(identity, "readProcessIdentitiesSync").mockReturnValue(new Map([[pid, ""]]));
  return record;
}

it.runIf(process.platform === "win32").each(["svchost", "WmiPrvSE.EXE", "C:\\Windows\\System32\\SearchFilterHost.exe", "SearchProtocolHost", "SearchIndexer", "MsMpEng", "dllhost", "RuntimeBroker", "csrss", "lsass", "services", "wininit", "smss"])("unblocks a positively identified OS host replacement %s without changing records", name => {
  unreadableReader();
  const db = metadataDb(env.home);
  const before = db.prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid));
  const names = vi.spyOn(identity, "readProcessNamesSync").mockReturnValue(new Map([[pid, name]]));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).not.toThrow();
  expect(names).toHaveBeenCalledWith([pid]);
  expect(db.prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid))).toEqual(before);
});

it.each(["node.exe", "node22", "unknown-host", "BUN", "deno", "claude", "codex", "opencode", "agy", "antigravity", "/usr/local/bin/MUSE"])("keeps unreadable runtime or unknown name %s blocked despite sufficient old capabilities and shadowed legacy publication", name => {
  unreadableReader();
  const path = join(env.home, "storage-capabilities", `${pid}.json`);
  mkdirSync(join(env.home, "storage-capabilities"), { recursive: true });
  const legacy = JSON.stringify({ schemaVersion: 1, json: 3, sqlite: 8, pid, name: "legacy-reader", version: "0.29.12", explicit: true, processIdentity: "new-generation" }) + "\n";
  writeFileSync(path, legacy);
  vi.spyOn(identity, "readProcessNamesSync").mockReturnValue(new Map([[pid, name]]));
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  expect(() => assertStoreUpgrade(env.home, "sqlite", 8, 9)).toThrow(/Waiting to upgrade sqlite store 8→9/);
  expect(() => assertStoreUpgrade(env.home, "jobArchive", 0, 1)).toThrow(/Waiting to upgrade jobArchive store 0→1/);
  expect(readFileSync(path, "utf8")).toBe(legacy);
});

it.each([undefined, new Map<number, string>(), new Map([[pid, " "]])])("keeps unreadable readers blocked without positive name evidence %s", result => {
  unreadableReader();
  vi.spyOn(identity, "readProcessNamesSync").mockReturnValue(result);
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
});

it("does not apply process evidence to a record replaced during the name query", () => {
  const record = unreadableReader();
  const replacement = { ...record, name: "new-reader", processIdentity: "new-generation", json: 3 };
  vi.spyOn(identity, "readProcessNamesSync").mockImplementation(() => {
    saveMetadataValue(env.home, "storage-capabilities", String(pid), replacement);
    return new Map([[pid, "svchost"]]);
  });
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  expect(metadataDb(env.home).prepare("SELECT value FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(pid))?.value).toBe(JSON.stringify(replacement));
});

it("reads this runtime's OS process name with a single bounded name query", () => {
  const names = identity.readProcessNamesSync([process.pid, process.pid, -1, Number.NaN]);
  expect(names?.size).toBe(1);
  const name = names?.get(process.pid);
  if (process.platform === "win32") {
    expect(name?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase()).toBe("node");
  } else if (process.platform === "linux") {
    // Linux comm may name the Node worker thread (e.g. MainThread), rather than the executable.
    expect(name).toBe(readFileSync(`/proc/${process.pid}/comm`, "utf8").trim());
  } else {
    expect(name).toEqual(expect.any(String));
    expect(name?.trim().length).toBeGreaterThan(0);
  }
});

it.runIf(process.platform === "win32")("reports a failed batch query instead of an empty result", async () => {
  // An invalid executable path makes the PowerShell launch itself fail.
  vi.stubEnv("SystemRoot", "Z:\\nonexistent");
  vi.stubEnv("PATH", "Z:\\nonexistent");
  try {
    await expect(identity.readProcessIdentities([process.pid])).rejects.toMatchObject({ code: identity.IDENTITY_QUERY_FAILED });
    expect(identity.readProcessNamesSync([process.pid])).toBeUndefined();
  }
  finally { vi.unstubAllEnvs(); }
});

let fixturePid = 3_000_000;
function simulatedProcesses(count: number, delayMs = 0) {
  const states: RunnerState[] = Array.from({ length: count }, () => ({
    pid: ++fixturePid, identity: "638960000000000000", updatedAt: Date.now(), peer: "runner", status: "running",
  }));
  const live = new Map(states.map(state => [state.pid, state.identity!]));
  vi.mocked(process.kill).mockImplementation(((pid: number) => {
    if (live.has(pid)) return true;
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  const commandOutput = (_file: string, args: string[]) => {
    expect(_file).toBe("powershell.exe");
    const command = args.at(-1)!;
    const single = /GetProcessById\((\d+)\)/.exec(command);
    if (single) return live.get(Number(single[1])) ?? "";
    const pids = /@\(([^)]*)\)/.exec(command)![1]!.split(",").map(Number);
    return pids.filter(pid => live.has(pid)).map(pid => `${pid}|${live.get(pid)}`).join("\n");
  };
  const syncSpawns = vi.spyOn(childProcess, "execFileSync").mockImplementation(commandOutput as typeof childProcess.execFileSync);
  const spawns = vi.mocked(childProcess.execFile).mockClear().mockImplementation(((file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    expect(options.timeout).toBe(15_000);
    const output = commandOutput(file, args);
    if (delayMs) setTimeout(() => callback(null, output, ""), delayMs);
    else callback(null, output, "");
    return {};
  }) as typeof childProcess.execFile);
  return { states, live, spawns, syncSpawns };
}

it.runIf(process.platform === "win32").each([1, 16, 64])("bounds an actual host poll to one spawn for %i simulated runners", async count => {
  vi.useFakeTimers();
  const { states, spawns, syncSpawns } = simulatedProcesses(count);
  // Fresh single-PID calls reproduce the original unbatched launch boundary.
  for (const state of states) expect(runnerProcessAlive(state, true)).toBe(true);
  expect(syncSpawns).toHaveBeenCalledTimes(count);
  const before = syncSpawns.mock.calls.length;
  // Expire exactly the same runners, then exercise watchHosted's real timer, not just the prewarm helper.
  vi.setSystemTime(Date.now() + 30_000);
  spawns.mockClear();
  syncSpawns.mockClear();
  const manager = new JobManager({ name: "host", on: vi.fn() } as never, nullLogger);
  const internals = manager as unknown as { running: Map<string, Job>; watchHosted(): void; hostTimer: NodeJS.Timeout };
  const jobs = states.map((state, i) => ({ id: String(i), name: state.peer, status: "running", host: { pid: state.pid } }) as Job);
  jobs.forEach(job => internals.running.set(job.id, job));
  const reads = vi.fn((job: Job) => states[Number(job.id)]!);
  manager.runners = { state: reads, alive: (_job, state, deferred) => runnerProcessAlive(state!, false, deferred), send: vi.fn(), kill: vi.fn() };
  try {
    internals.watchHosted();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawns).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(count); // consume the same snapshot that was batched
    const after = spawns.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawns).toHaveBeenCalledTimes(1); // warm cache: zero extra launches
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawns).toHaveBeenCalledTimes(2); // one refresh, independent of N
    expect(syncSpawns).not.toHaveBeenCalled();
    console.log(`AB-368 host poll N=${count}: before=${before}, after=${after}, warm=0, refresh=1`);
  } finally { clearInterval(internals.hostTimer); }
});

it.runIf(process.platform === "win32")("keeps failed and unreadable poll probes unknown and fresh kill probes authoritative", async () => {
  const { states, live, spawns, syncSpawns } = simulatedProcesses(4);
  live.set(states[0]!.pid, ""); // protected process: identity unreadable
  live.delete(states[1]!.pid); // cheap liveness notices exit without querying it
  primeRunnerProcessIdentities(states.map(state => state.pid));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(spawns).toHaveBeenCalledTimes(1);
  syncSpawns.mockImplementation(() => { throw new Error("identity unreadable"); });
  expect(runnerProcessAlive(states[0]!)).toBe(true);
  expect(runnerProcessAlive(states[0]!, true)).toBe(false);
  expect(runnerProcessAlive(states[1]!)).toBe(false);
  // A warm match must never authorize killing a process that has since reused the PID.
  live.set(states[2]!.pid, "638970000000000000");
  expect(runnerProcessAlive(states[2]!, true)).toBe(false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 30_000);
  primeRunnerProcessIdentities(states.map(state => state.pid));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(runnerProcessAlive(states[2]!)).toBe(false); // expired cache sees the replacement too
  vi.setSystemTime(Date.now() + 30_000);
  spawns.mockClear().mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
    callback(new Error("query timed out")); return {};
  }) as typeof childProcess.execFile);
  primeRunnerProcessIdentities(states.map(state => state.pid));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(spawns).toHaveBeenCalledTimes(1);
  expect(runnerProcessAlive(states[3]!)).toBe(true);
  expect(runnerProcessAlive(states[3]!, true)).toBe(false);
  // Observing ESRCH invalidates an old match even if the numeric PID immediately returns.
  live.delete(states[3]!.pid);
  expect(runnerProcessAlive(states[3]!)).toBe(false);
  live.set(states[3]!.pid, "638970000000000000");
  expect(runnerProcessAlive(states[3]!, false, true)).toBe(true); // failed new probe stays unknown
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(runnerProcessAlive(states[3]!, true)).toBe(false);
});

it.runIf(process.platform === "win32")("keeps host ticks and dead-runner settlement independent of a five-second batch", async () => {
  vi.useFakeTimers();
  const { states, live, spawns, syncSpawns } = simulatedProcesses(16, 5_000);
  const dead = states[0]!;
  const protectedState = states[1]!;
  live.set(protectedState.pid, "");
  const kill = vi.mocked(process.kill).getMockImplementation()!;
  vi.mocked(process.kill).mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === protectedState.pid) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return kill(pid, signal);
  }) as typeof process.kill);
  const delivered = vi.fn();
  const manager = new JobManager({ name: "host", on: vi.fn(), deliverLocal: delivered } as never, nullLogger);
  const internals = manager as unknown as { running: Map<string, Job>; watchHosted(): void; hostTimer: NodeJS.Timeout };
  const addJob = (state: RunnerState) => {
    const job = { id: String(state.pid), name: state.peer, agent: "codex", status: "running", host: { pid: state.pid },
      startedAt: Date.now(), sessionId: null, queue: [], controller: new AbortController() } as unknown as Job;
    internals.running.set(job.id, job);
    return job;
  };
  const deadJob = addJob(dead);
  states.slice(1).forEach(addJob);
  const reads = vi.fn((job: Job) => states.find(state => state.pid === Number(job.id))!);
  manager.runners = { state: reads, alive: (_job, state, deferred) => runnerProcessAlive(state!, false, deferred), send: vi.fn(), kill: vi.fn() };
  try {
    internals.watchHosted();
    await vi.advanceTimersByTimeAsync(2_000); // batch starts now and will finish at t=7 s
    expect(spawns).toHaveBeenCalledTimes(1);
    live.delete(dead.pid);
    // An overlapping poll also sees a new PID not included in the running batch.
    const newcomer = { ...dead, pid: ++fixturePid };
    states.push(newcomer); live.set(newcomer.pid, newcomer.identity!); addJob(newcomer);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deadJob.status).toBe("failed");
    expect(deadJob.host).toBeNull();
    expect(internals.running.has(deadJob.id)).toBe(false);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(spawns).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000); // third poll still runs before batch completion
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(16 * 3);
    expect(internals.running.has(String(protectedState.pid))).toBe(true); // EPERM stays conservative
    expect(syncSpawns).not.toHaveBeenCalled();
    expect(spawns).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // late result cannot resurrect the dead runner
    expect(runnerProcessAlive(dead)).toBe(false);
    expect(spawns).toHaveBeenCalledTimes(1);
  } finally { clearInterval(internals.hostTimer); }
});

it.runIf(process.platform === "win32")("does not let a slow batch overwrite a newer fresh identity probe", async () => {
  vi.useFakeTimers();
  const { states, live, spawns } = simulatedProcesses(1, 5_000);
  const state = states[0]!;
  primeRunnerProcessIdentities([state.pid]);
  live.set(state.pid, "638970000000000000");
  expect(runnerProcessAlive(state, true)).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(spawns).toHaveBeenCalledTimes(1);
  expect(runnerProcessAlive(state)).toBe(false);
});

it.runIf(process.platform === "win32")("ignores a slow A batch after an ordinary poll observes runner B at the same live PID", async () => {
  vi.useFakeTimers();
  const { states, live, spawns, syncSpawns } = simulatedProcesses(1, 5_000);
  const a = states[0]!;
  expect(runnerProcessAlive(a, false, true)).toBe(true); // starts a batch that captures A immediately
  const b = { ...a, identity: "638970000000000000" };
  live.set(b.pid, b.identity);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(runnerProcessAlive(b, false, true)).toBe(true); // no ESRCH or fresh probe between A and B
  expect(spawns).toHaveBeenCalledTimes(1); // replacement still shares the pending batch
  await vi.advanceTimersByTimeAsync(3_000);
  expect(runnerProcessAlive(b, false, true)).toBe(true); // A's late result must not mark B dead
  expect(spawns).toHaveBeenCalledTimes(2); // query B only after the old batch finishes
  await vi.advanceTimersByTimeAsync(5_000);
  expect(runnerProcessAlive(b, false, true)).toBe(true);
  expect(spawns).toHaveBeenCalledTimes(2); // B's applicable evidence remains warm
  expect(syncSpawns).not.toHaveBeenCalled();
});

it.runIf(process.platform === "win32")("keeps batch and single-PID identities byte-identical to persisted Get-Process UTC ticks", () => {
  const old = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
  { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  expect(old).toMatch(/^\d+$/);
  expect(Buffer.from(identity.processIdentity(process.pid)!)).toEqual(Buffer.from(old));
  expect(Buffer.from(identity.readProcessIdentitiesSync([process.pid])!.get(process.pid)!)).toEqual(Buffer.from(old));
});
