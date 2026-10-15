import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
