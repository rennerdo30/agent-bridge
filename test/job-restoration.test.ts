import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager, type JobCoordinator } from "../src/mcp/jobs.js";
import { JSON_STORE_VERSION } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import { verifiedGoneJobOwners } from "../src/core/job-restoration.js";
import { processIdentity } from "../src/core/process-identity.js";
import { closeMetadataDbs, existingMetadataDb, metadataDb, saveMetadataValue } from "../src/core/metadata-db.js";
import { importMetadataDomain } from "../src/core/metadata-import.js";

let home: string;
const managers: JobManager[] = [];
beforeEach(() => { const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true }); home = mkdtempSync(join(root, "restore-policy-")); });
afterEach(() => { managers.splice(0).forEach(manager => manager.cancelAll()); vi.unstubAllEnvs(); vi.restoreAllMocks(); closeMetadataDbs(); rmSync(home, { recursive: true, force: true }); });
function manager(allowed: () => boolean, handoff = () => true, name = "claude-project") {
  const events = new EventEmitter();
  const node = Object.assign(events, { name, id: "peer-instance", currentSessionId: "session", deliverLocal: vi.fn() }) as JobCoordinator & EventEmitter;
  const jobs = new JobManager(node, nullLogger, join(home, "jobs.json"), 3, undefined, { canRestore: allowed, canReceiveHandoff: handoff });
  jobs.runners = { alive: () => true, state: () => ({ pid: process.pid, peer: "codex-job-running", status: "running", updatedAt: Date.now(), sessionId: "native-context" }), send: vi.fn(), kill: vi.fn() };
  managers.push(jobs);
  return { jobs, node };
}
function records() {
  return Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, name: `codex-job-${i}`, agent: "codex", owner: "claude-project", rootName: "claude-project", supervisor: "main-session", rootSession: "main-session", status: i < 5 ? "running" : "done", startedAt: 1 + i, finishedAt: 1, prompt: "original", sessionId: "native-context", ...(i < 5 ? { host: { pid: process.pid, peer: `codex-job-${i}`, startedAt: 1 } } : {}) }));
}

describe("transient coordinator restoration", () => {
  it("headless/unclassified join restores and archives none of the main's fifty jobs", () => {
    vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
    const raw = JSON.stringify({ version: JSON_STORE_VERSION, custom: "retain", jobs: records() });
    const path = join(home, "jobs.json"); writeFileSync(path, raw);
    const { jobs, node } = manager(() => false);
    jobs.restore(() => undefined);
    node.emit("connected"); node.emit("jobs_changed");
    jobs.refreshOwnership(); jobs.persist();
    expect(jobs.hookJobs()).toEqual([]);
    expect(jobs.runners!.send).not.toHaveBeenCalled();
    expect(jobs.adoptStandIns(new Set(), new Set(["claude-project"]))).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(join(home, "archive"))).toBe(false);
    expect(readdirSync(home)).toEqual(["jobs.json"]);
  });

  it("an empty secondary joining with no owned jobs cannot publish global retention changes", () => {
    vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
    const raw = JSON.stringify({ version: JSON_STORE_VERSION, jobs: records() });
    const path = join(home, "jobs.json"); writeFileSync(path, raw);
    const { jobs } = manager(() => true, () => true, "claude-project-2");
    jobs.restore(() => undefined);
    jobs.persist();
    expect(jobs.runners!.send).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(join(home, "archive"))).toBe(false);
    expect(jobs.adoptStandIns(new Set(["claude-project-2"]))).toEqual([]);
  });

  it("restores an old live runner to an eligible reloaded suffix only after its base owner is verified gone", () => {
    const job = { ...records()[0]!, supervisor: "session", rootSession: "session", nativeContext: { preserve: "old runner context" } };
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: JSON_STORE_VERSION, jobs: [job] }));
    const { jobs } = manager(() => true, () => true, "claude-project-2");
    jobs.restore(() => undefined);
    expect(jobs.list()).toEqual([]);
    expect(jobs.standInOwners(new Set(["claude-project-2"]))).toEqual(["claude-project"]);
    expect(jobs.adoptStandIns(new Set(["claude-project-2"]))).toEqual([]);
    expect(jobs.runners!.send).not.toHaveBeenCalled();
    expect(jobs.adoptStandIns(new Set(["claude-project-2"]), new Set(["claude-project"]))).toEqual(["claude-project"]);
    expect(jobs.find(job.name)).toMatchObject({ owner: "claude-project-2", rootSession: "session", status: "running", sessionId: "native-context", nativeContext: { preserve: "old runner context" } });
    expect(jobs.list()).toHaveLength(1);
  });

  it("an ineligible second session cannot restore or attach the old main runner even with owner death proof", () => {
    const raw = JSON.stringify({ version: JSON_STORE_VERSION, jobs: [records()[0]!] });
    const path = join(home, "jobs.json"); writeFileSync(path, raw);
    const { jobs } = manager(() => false, () => true, "claude-project-2");
    jobs.restore(() => undefined);
    expect(jobs.standInOwners(new Set(["claude-project-2"]))).toEqual([]);
    expect(jobs.adoptStandIns(new Set(["claude-project-2"]), new Set(["claude-project"]))).toEqual([]);
    jobs.refreshOwnership(); jobs.persist();
    expect(jobs.list()).toEqual([]);
    expect(jobs.hookJobs()).toEqual([]);
    expect(jobs.runners!.send).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it.each(["session", "peer-instance"])("a durable explicit handoff bound to %s can authorize a connected transient target", (session) => {
    const job = { ...records()[0]!, owner: "claude-project-2", rootName: "claude-project-2", supervisor: session, rootSession: session,
      ownershipHistory: [{ id: "handoff", at: Date.now(), from: "claude-project", to: "claude-project-2", reason: "explicit-handoff", rootName: "claude-project-2", rootSession: session }] };
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: JSON_STORE_VERSION, jobs: [job] }));
    const { jobs } = manager(() => false, () => true, "claude-project-2");
    jobs.restore(() => undefined);
    expect(jobs.hookJobs()).toContainEqual(expect.objectContaining({ id: job.id, owner: "claude-project-2", status: "running", sessionId: "native-context" }));
  });

  it("a reused vacant name cannot inherit a historical handoff to a different session", () => {
    const job = { ...records()[0]!, ownershipHistory: [{ id: "old-handoff", at: 1, from: "claude-other", to: "claude-project",
      reason: "explicit-handoff", rootName: "claude-project", rootSession: "prior-session" }] };
    const path = join(home, "jobs.json"); const raw = JSON.stringify({ version: JSON_STORE_VERSION, jobs: [job] }); writeFileSync(path, raw);
    const { jobs } = manager(() => false);
    jobs.restore(() => undefined); jobs.refreshOwnership(); jobs.persist();
    expect(jobs.hookJobs()).toEqual([]);
    expect(jobs.runners!.send).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("broker absence alone cannot authorize stand-in adoption while its recorded process lives", async () => {
    mkdirSync(join(home, "storage-capabilities"));
    writeFileSync(join(home, "storage-capabilities", `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "claude-project", processIdentity: processIdentity(process.pid) }));
    expect(await verifiedGoneJobOwners(home, ["claude-project", "unknown"])).toEqual(new Set());
  });

  it("proves a recorded coordinator exited without treating a missing record as proof", async () => {
    const exitedPid = 2_000_000_001;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === exitedPid) throw Object.assign(new Error("exited"), { code: "ESRCH" });
      return true;
    });
    mkdirSync(join(home, "storage-capabilities"));
    writeFileSync(join(home, "storage-capabilities", `${exitedPid}.json`), JSON.stringify({ pid: exitedPid, name: "claude-project-2" }));
    expect(await verifiedGoneJobOwners(home, ["claude-project-2", "missing"])).toEqual(new Set(["claude-project-2"]));
    expect(kill).toHaveBeenCalledWith(exitedPid, 0);
  });

  it("recovers a reused PID only with a different verified process identity", async () => {
    mkdirSync(join(home, "storage-capabilities"));
    const record = join(home, "storage-capabilities", `${process.pid}.json`);
    writeFileSync(record, JSON.stringify({ pid: process.pid, name: "claude-project-2", processIdentity: "old-start:unrelated" }));
    expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set(["claude-project-2"]));
    writeFileSync(record, JSON.stringify({ pid: process.pid, name: "claude-project-2" }));
    expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set());
  });
  describe("database presence (AB-208 layout)", () => {
    /** The layout every 0.30.4+ home reaches: the storage-capabilities import ran and its files moved to cold storage. */
    function databasePresence(pid: number, record: Record<string, unknown>, updatedAt?: number): void {
      metadataDb(home); importMetadataDomain(home, "storage-capabilities");
      saveMetadataValue(home, "storage-capabilities", String(pid), { schemaVersion: 1, json: 4, sqlite: 9, version: "0.30.6", explicit: true, observedAt: Date.now(), pid, ...record });
      if (updatedAt !== undefined) existingMetadataDb(home)!.prepare("UPDATE bridge_metadata SET updated_at=? WHERE domain='storage-capabilities' AND key=?").run(updatedAt, String(pid));
      expect(existsSync(join(home, "storage-capabilities"))).toBe(false);
    }

    it("proves an exited stand-in from its database row so the reloaded session can adopt its jobs", async () => {
      const exitedPid = 2_000_000_003;
      vi.spyOn(process, "kill").mockImplementation(pid => {
        if (pid === exitedPid) throw Object.assign(new Error("exited"), { code: "ESRCH" });
        return true;
      });
      databasePresence(exitedPid, { name: "claude-project-2" });
      expect(await verifiedGoneJobOwners(home, ["claude-project-2", "missing"])).toEqual(new Set(["claude-project-2"]));
    });

    it("never adopts from a stand-in whose database row names a live process", async () => {
      databasePresence(process.pid, { name: "claude-project-2", processIdentity: processIdentity(process.pid) });
      expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set());
    });

    it("proves a reused PID from a different recorded identity in the database", async () => {
      databasePresence(process.pid, { name: "claude-project-2", processIdentity: "old-start:unrelated" });
      expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set(["claude-project-2"]));
    });

    it("treats presence written before this boot as exited even when its PID now belongs to an unidentifiable process", async () => {
      databasePresence(process.pid, { name: "claude-project-2" });
      expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set());
      existingMetadataDb(home)!.prepare("UPDATE bridge_metadata SET updated_at=1 WHERE domain='storage-capabilities'").run();
      expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set(["claude-project-2"]));
    });

    it("requires every recorded process of a stand-in to be gone", async () => {
      const exitedPid = 2_000_000_005;
      vi.spyOn(process, "kill").mockImplementation(pid => {
        if (pid === exitedPid) throw Object.assign(new Error("exited"), { code: "ESRCH" });
        return true;
      });
      databasePresence(exitedPid, { name: "claude-project-2" });
      saveMetadataValue(home, "storage-capabilities", String(process.pid), { schemaVersion: 1, json: 4, sqlite: 9, pid: process.pid, name: "claude-project-2", version: "0.30.6", explicit: true, processIdentity: processIdentity(process.pid) });
      expect(await verifiedGoneJobOwners(home, ["claude-project-2"])).toEqual(new Set());
    });
  });
});
