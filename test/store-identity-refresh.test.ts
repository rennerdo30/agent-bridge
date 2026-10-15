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

// Keep the real implementation by default, including the existing native AB-362 query checks below.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));

// 2026-10-10: ~20 jobs starting at once made the batch PowerShell identity query time out. Its empty result
// marked every live 0.30.6 reader "unknown, reads 0" and blocked spawn_codex behind a json 0→4 upgrade.
let env: TestEnv;
const pid = 2_000_011;
beforeEach(() => {
  env = makeEnv();
  vi.spyOn(process, "kill").mockImplementation(((target: number) => { if (target === pid) return true; throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); }) as typeof process.kill);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup(); });

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
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
  expect(direct).not.toHaveBeenCalled();
  expect(names).not.toHaveBeenCalled();
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
function simulatedProcesses(count: number) {
  const states: RunnerState[] = Array.from({ length: count }, () => ({
    pid: ++fixturePid, identity: "638960000000000000", updatedAt: Date.now(), peer: "runner", status: "running",
  }));
  const live = new Map(states.map(state => [state.pid, state.identity!]));
  vi.mocked(process.kill).mockImplementation(((pid: number) => {
    if (live.has(pid)) return true;
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  const spawns = vi.spyOn(childProcess, "execFileSync").mockImplementation(((_file: string, args: string[]) => {
    expect(_file).toBe("powershell.exe");
    const command = args.at(-1)!;
    const single = /GetProcessById\((\d+)\)/.exec(command);
    if (single) return live.get(Number(single[1])) ?? "";
    const pids = /@\(([^)]*)\)/.exec(command)![1]!.split(",").map(Number);
    return pids.filter(pid => live.has(pid)).map(pid => `${pid}|${live.get(pid)}`).join("\n");
  }) as typeof childProcess.execFileSync);
  return { states, live, spawns };
}

it.runIf(process.platform === "win32").each([1, 16, 64])("bounds an actual host poll to one spawn for %i simulated runners", count => {
  vi.useFakeTimers();
  const { states, live, spawns } = simulatedProcesses(count);
  // The pre-fix poll called this once for each job; count the actual command launches at that boundary.
  for (const state of states) expect(runnerProcessAlive(state)).toBe(true);
  expect(spawns).toHaveBeenCalledTimes(count);
  const before = spawns.mock.calls.length;
  // Expire exactly the same runners, then exercise watchHosted's real timer, not just the prewarm helper.
  vi.setSystemTime(Date.now() + 30_000);
  spawns.mockClear();
  const manager = new JobManager({ name: "host", on: vi.fn() } as never, nullLogger);
  const internals = manager as unknown as { running: Map<string, Job>; watchHosted(): void; hostTimer: NodeJS.Timeout };
  const jobs = states.map((state, i) => ({ id: String(i), name: state.peer, status: "running", host: { pid: state.pid } }) as Job);
  jobs.forEach(job => internals.running.set(job.id, job));
  const reads = vi.fn((job: Job) => states[Number(job.id)]!);
  manager.runners = { state: reads, alive: (_job, state) => runnerProcessAlive(state!), send: vi.fn(), kill: vi.fn() };
  try {
    internals.watchHosted();
    vi.advanceTimersByTime(2_000);
    expect(spawns).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(count); // consume the same snapshot that was batched
    const after = spawns.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(spawns).toHaveBeenCalledTimes(1); // warm cache: zero extra launches
    vi.advanceTimersByTime(30_000);
    expect(spawns).toHaveBeenCalledTimes(2); // one refresh, independent of N
    console.log(`AB-368 host poll N=${count}: before=${before}, after=${after}, warm=0, refresh=1`);
  } finally { clearInterval(internals.hostTimer); }
});

it.runIf(process.platform === "win32")("keeps failed and unreadable poll probes unknown and fresh kill probes authoritative", () => {
  const { states, live, spawns } = simulatedProcesses(4);
  live.set(states[0]!.pid, ""); // protected process: identity unreadable
  live.delete(states[1]!.pid); // cheap liveness notices exit without querying it
  primeRunnerProcessIdentities(states.map(state => state.pid));
  expect(spawns).toHaveBeenCalledTimes(1);
  expect(runnerProcessAlive(states[0]!)).toBe(true);
  expect(runnerProcessAlive(states[0]!, true)).toBe(false);
  expect(runnerProcessAlive(states[1]!)).toBe(false);
  // A warm match must never authorize killing a process that has since reused the PID.
  live.set(states[2]!.pid, "638970000000000000");
  expect(runnerProcessAlive(states[2]!, true)).toBe(false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 30_000);
  primeRunnerProcessIdentities(states.map(state => state.pid));
  expect(runnerProcessAlive(states[2]!)).toBe(false); // expired cache sees the replacement too
  vi.setSystemTime(Date.now() + 30_000);
  spawns.mockClear().mockImplementation(() => { throw new Error("query timed out"); });
  primeRunnerProcessIdentities(states.map(state => state.pid));
  expect(spawns).toHaveBeenCalledTimes(1);
  expect(runnerProcessAlive(states[3]!)).toBe(true);
  expect(runnerProcessAlive(states[3]!, true)).toBe(false);
  // Observing ESRCH invalidates an old match even if the numeric PID immediately returns.
  live.delete(states[3]!.pid);
  expect(runnerProcessAlive(states[3]!)).toBe(false);
  live.set(states[3]!.pid, "638970000000000000");
  expect(runnerProcessAlive(states[3]!)).toBe(true); // failed new probe stays unknown
  expect(runnerProcessAlive(states[3]!, true)).toBe(false);
});

it.runIf(process.platform === "win32")("keeps batch and single-PID identities byte-identical to persisted Get-Process UTC ticks", () => {
  const old = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
  { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  expect(old).toMatch(/^\d+$/);
  expect(Buffer.from(identity.processIdentity(process.pid)!)).toEqual(Buffer.from(old));
  expect(Buffer.from(identity.readProcessIdentitiesSync([process.pid])!.get(process.pid)!)).toEqual(Buffer.from(old));
});
