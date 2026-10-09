import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { metadataDb, saveMetadataValue } from "../src/core/metadata-db.js";
import { importMetadataDomain } from "../src/core/metadata-import.js";
import * as identity from "../src/core/process-identity.js";
import { assertStoreUpgrade, liveStorePeers, refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { makeEnv, type TestEnv } from "./helpers.js";

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

  // A successful query without the PID: that reader is unknown again and blocks the upgrade.
  query.mockResolvedValue(new Map());
  expire();
  await refreshStorePeerIdentities(env.home);
  expect(versionOf()).toBe("unknown");
  expect(() => assertStoreUpgrade(env.home, "json", 0, 4)).toThrow(/Waiting to upgrade json store 0→4/);
});

it.runIf(process.platform === "win32")("reports a failed batch query instead of an empty result", async () => {
  // An invalid executable path makes the PowerShell launch itself fail.
  vi.stubEnv("SystemRoot", "Z:\\nonexistent");
  vi.stubEnv("PATH", "Z:\\nonexistent");
  try { await expect(identity.readProcessIdentities([process.pid])).rejects.toMatchObject({ code: identity.IDENTITY_QUERY_FAILED }); }
  finally { vi.unstubAllEnvs(); }
});
