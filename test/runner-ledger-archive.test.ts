import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb, METADATA_STORE_VERSION } from "../src/core/metadata-db.js";
import { maintenanceLock, storageLease } from "../src/core/storage-lock.js";
import { snapshotMetadataTables } from "../src/core/metadata-snapshot.js";
import * as snapshots from "../src/core/metadata-snapshot.js";
import { assertRunnerArchiveAdmission, publishRunnerSpec, readOriginalRunnerSpec, readRunnerStateRecord, runnerLedgerNamespace, writeRunnerStateRecord } from "../src/core/runner-store.js";
import { projectRunnerInputs, runnerLedgerPrincipal } from "../src/mcp/runner-delivery-retention.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { JobManager } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

vi.mock("../src/core/metadata-snapshot.js", async original => ({ ...await original<typeof import("../src/core/metadata-snapshot.js")>() }));
let env: TestEnv;
afterEach(async () => { vi.restoreAllMocks(); if (env) await env.cleanup(); });
it("initializes a proven fresh home directly at the current metadata component without offline admission", () => {
  env = makeEnv();
  expect(existsSync(join(env.home, "bridge.db"))).toBe(false);
  const db = metadataDb(env.home);
  expect(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version).toBe(METADATA_STORE_VERSION);
  db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("fixture", "accepted", "exact original bytes", 1);
  closeMetadataDb(env.home);
  const before = readFileSync(join(env.home, "bridge.db"));
  expect(metadataDb(env.home).prepare("SELECT value FROM bridge_metadata WHERE domain='fixture'").get()?.value).toBe("exact original bytes");
  expect(readFileSync(join(env.home, "bridge.db"))).toEqual(before);
  expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(false);
});
function fixture() {
  env = makeEnv();
  const spec = { owner: "original-supervisor", job: { id: "ledger-job", name: "codex-job-ledger", agent: "codex", startedAt: 10, supervisor: "original-session", rootSession: "root" } };
  publishRunnerSpec(env.home, spec.job.id, spec);
  const namespace = runnerLedgerNamespace(env.home, true);
  const item = { messageId: "original-item", record: JSON.stringify({ namespace, body: "Exact original private bytes", intent: "original-supervisor" }) };
  const ledger = { version: 1, namespace, generation: "original-incarnation", job: spec.job.id, principal: runnerLedgerPrincipal(spec), entries: [item] };
  const state = { pid: 2147483647, identity: "original-process", status: "done", report: "Original final", reportId: "original-final", deliveryLedger: ledger, pendingDeliveryRetention: [item] };
  writeRunnerStateRecord(env.home, spec.job.id, state);
  return { spec, ledger, item, state, db: metadataDb(env.home) };
}
it("blocks actual same-ID start/publication when b206 already archived unresolved evidence, preserving reset and archives", () => {
  const f = fixture();
  const legacy = JSON.stringify({ ...f.state, deliveryLedger: undefined });
  f.db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("job-state-archive", "ledger-job/b206", legacy, 1);
  // Recreate the old writer's already-committed reset without calling the fixed publisher.
  f.db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state' AND key='ledger-job'").run(JSON.stringify({ version: 4, turnResetAt: 20 }));
  const before = f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  const host = new JobRunners({} as any, env.home, "unused-cli", nullLogger);
  expect(() => host.start({ ...f.spec.job, controller: new AbortController() } as any, { args: {} } as any)).toThrow(/retention.*unsettled/i);
  expect(() => publishRunnerSpec(env.home, f.spec.job.id, { owner: "different-owner" })).toThrow(/retention.*unsettled/i);
  const jobs = new JobManager(new LocalCoordinator(f.spec.owner, "original-session"), nullLogger, join(env.home, "jobs.json"));
  jobs.runners = host;
  const job = { ...f.spec.job, owner: f.spec.owner, status: "done", queue: ["Accepted unconsumed continuation"], controller: new AbortController() } as any;
  expect((jobs as any).claimTurn(job)).toBe(false);
  expect(job).toMatchObject({ startedAt: f.spec.job.startedAt, status: "done", queue: ["Accepted unconsumed continuation"] });
  jobs.setDormant(true);
  expect(f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(before);
  expect(readOriginalRunnerSpec(env.home, f.spec.job.id)?.owner).toBe(f.spec.owner);
});
it("archives original item/proof atomically, rebuilds a lost derived index, and refuses a lost or changed proof/source", () => {
  const f = fixture();
  writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, deliveryLedger: { ...f.ledger, entries: [] }, pendingDeliveryRetention: [] });
  const archive = f.db.prepare("SELECT key,value FROM bridge_metadata WHERE domain='job-state-archive'").get()!;
  expect(JSON.parse(String(archive.value))).toEqual(expect.objectContaining({ deliveryLedger: f.ledger, pendingDeliveryRetention: [f.item] }));
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).not.toThrow();
  f.db.prepare("DELETE FROM bridge_metadata WHERE domain='runner-retention-index' AND key<>'namespace'").run();
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).not.toThrow();
  f.db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state-archive' AND key=?").run(String(archive.value).replace("Exact original", "Wrong original"), archive.key!);
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).toThrow(/unsettled/);
  f.db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state-archive' AND key=?").run(archive.value!, archive.key!);
  f.db.prepare("DELETE FROM bridge_metadata WHERE domain='runner-retention-proof'").run();
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).toThrow(/unsettled/);
  expect(readRunnerStateRecord(env.home, f.spec.job.id)?.report).toBe("Original final");
});
it("rolls back archive/proof/active changes together when confirmation cannot commit", () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER reject_proof BEFORE INSERT ON bridge_metadata WHEN NEW.domain='runner-retention-proof' BEGIN SELECT RAISE(ABORT,'controlled proof failure'); END");
  expect(() => writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, deliveryLedger: { ...f.ledger, entries: [] }, pendingDeliveryRetention: [] })).toThrow("controlled proof failure");
  expect(readRunnerStateRecord(env.home, f.spec.job.id)?.deliveryLedger).toEqual(f.ledger);
  expect(f.db.prepare("SELECT * FROM bridge_metadata WHERE domain IN ('runner-retention-proof','job-state-archive')").all()).toEqual([]);
});
it("refuses same-UUID byte changes and store/incarnation replacement at the production writer", () => {
  const f = fixture(), before = f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  for (const ledger of [{ ...f.ledger, entries: [{ ...f.item, record: "same UUID with substituted bytes" }] },
    { ...f.ledger, namespace: "f".repeat(64) }, { ...f.ledger, generation: "replacement-incarnation" }]) {
    expect(() => writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, deliveryLedger: ledger })).toThrow(/unsettled/);
    expect(f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(before);
  }
});
it("restores namespace, original spec/archive and proof/index in one consistent backup", () => {
  const f = fixture();
  writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, deliveryLedger: { ...f.ledger, entries: [] }, pendingDeliveryRetention: [] });
  assertRunnerArchiveAdmission(env.home, f.spec.job.id);
  const before = f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  const backup = join(env.home, "retention-backup.db");
  snapshotMetadataTables(f.db, backup, ["bridge_components", "bridge_metadata"], "metadata", METADATA_STORE_VERSION);
  closeMetadataDb(env.home); copyFileSync(backup, join(env.home, "bridge.db"));
  expect(metadataDb(env.home).prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(before);
  expect(runnerLedgerNamespace(env.home)).toBe(f.ledger.namespace);
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).not.toThrow();
});
it.each([{ version: 0, evidence: "pre-component" }, { version: 1, evidence: "shipping" }, { version: 1, evidence: "b206" }, { version: 2, evidence: "80e" }, { version: 3, evidence: "6b-unreleased" }])("upgrades $evidence metadata component $version additively after interrupted backup, with old reader exclusion", ({ version, evidence }) => {
  env = makeEnv(); const db = metadataDb(env.home);
  const original = JSON.stringify({ pid: 0, status: "done", report: "original archived bytes", originalProof: "do-not-reclassify",
    ...(["b206", "80e"].includes(evidence) ? { pendingDeliveryRetention: [{ messageId: "old-uuid", record: "original archived bytes" }] } : {}) });
  db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("job-state-archive", "legacy/old", original, 1);
  db.prepare("UPDATE bridge_components SET version=? WHERE name='metadata'").run(version);
  closeMetadataDb(env.home);
  if (version > 0 && version < METADATA_STORE_VERSION) {
    const originalBytes = readFileSync(join(env.home, "bridge.db"));
    expect(() => metadataDb(env.home)).toThrow(new RegExp(`component${version} cached writers`));
    expect(readFileSync(join(env.home, "bridge.db"))).toEqual(originalBytes);
    expect(() => metadataDb(env.home, { kind: "offline-isolated", home: join(env.home, "other") })).toThrow(new RegExp(`component${version} cached writers`));
  }
  const release = storageLease(env.home);
  const dir = join(env.home, ".storage-users"), leases = readdirSync(dir);
  expect(leases).toHaveLength(1);
  const lease = join(dir, leases[0]!); const owner = JSON.parse(readFileSync(lease, "utf8"));
  writeFileSync(lease, JSON.stringify({ ...owner, mailboxProtocol: 7 }));
  expect(() => metadataDb(env.home, { kind: "offline-isolated", home: env.home })).toThrow(/storage is in use/);
  const retained = new DatabaseSync(join(env.home, "bridge.db"), { readOnly: true });
  expect(retained.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version).toBe(version); retained.close();
  writeFileSync(lease, JSON.stringify(owner)); release();
  const snapshot = vi.spyOn(snapshots, "snapshotMetadataTables").mockImplementationOnce(() => { throw new Error("controlled snapshot interruption"); });
  expect(() => metadataDb(env.home, { kind: "offline-isolated", home: env.home })).toThrow("controlled snapshot interruption"); snapshot.mockRestore();
  const upgraded = metadataDb(env.home, { kind: "offline-isolated", home: env.home });
  expect(upgraded.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version).toBe(METADATA_STORE_VERSION);
  expect(upgraded.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state-archive'").get()?.value).toBe(original);
  if (["b206", "80e"].includes(evidence)) expect(() => assertRunnerArchiveAdmission(env.home, "legacy")).toThrow(/unsettled/);
  else expect(() => assertRunnerArchiveAdmission(env.home, "legacy")).not.toThrow();
  closeMetadataDb(env.home);
  expect(metadataDb(env.home).prepare("SELECT value FROM bridge_metadata WHERE domain='job-state-archive'").get()?.value).toBe(original);
  const exclusive = maintenanceLock(env.home); exclusive();
  // The fixture home is owned; no real process or installed store participates.
});
it.each([1, 2, 3])("keeps component%s and every original row when migration aborts after its verified backup, then retries idempotently", version => {
  env = makeEnv(); const db = metadataDb(env.home);
  db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("job-state", "old", JSON.stringify({ pid: 0, status: "done", report: "unique shipping bytes" }), 1);
  const original = db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  db.exec(`UPDATE bridge_components SET version=${version} WHERE name='metadata'; CREATE TRIGGER interrupt_metadata BEFORE UPDATE ON bridge_components WHEN NEW.name='metadata' AND NEW.version=${METADATA_STORE_VERSION} BEGIN SELECT RAISE(ABORT,'controlled DDL interruption'); END`);
  closeMetadataDb(env.home);
  expect(() => metadataDb(env.home, { kind: "offline-isolated", home: env.home })).toThrow("controlled DDL interruption");
  const check = new DatabaseSync(join(env.home, "bridge.db"));
  expect(check.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version).toBe(version);
  expect(check.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(original);
  const backups = readdirSync(join(env.home, ".migration-snapshots")).filter(file => file.endsWith(".db"));
  expect(backups).toHaveLength(1);
  const backup = new DatabaseSync(join(env.home, ".migration-snapshots", backups[0]!), { readOnly: true });
  expect(backup.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(original); backup.close();
  check.exec("DROP TRIGGER interrupt_metadata"); check.close();
  const upgraded = metadataDb(env.home, { kind: "offline-isolated", home: env.home });
  expect(upgraded.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version).toBe(METADATA_STORE_VERSION);
  expect(upgraded.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(original);
});

it("refuses unresolved file archives before actual spec reset and preserves every original byte", () => {
  const f = fixture();
  const folder = join(env.home, "jobs", "archive"); mkdirSync(folder, { recursive: true });
  const file = join(folder, `${f.spec.job.id}.json-123-original`), raw = JSON.stringify(f.state);
  writeFileSync(file, raw);
  writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, pendingDeliveryRetention: [], deliveryLedger: { ...f.ledger, entries: [] } });
  const spec = readOriginalRunnerSpec(env.home, f.spec.job.id);
  expect(() => publishRunnerSpec(env.home, f.spec.job.id, { owner: "new-owner" })).toThrow(/unsettled/);
  expect(readFileSync(file, "utf8")).toBe(raw); expect(readOriginalRunnerSpec(env.home, f.spec.job.id)).toEqual(spec);
});
it.each(["incomplete", "budget"])("fails closed on %s archive evidence before publication without partial index changes", mode => {
  const f = fixture();
  writeRunnerStateRecord(env.home, f.spec.job.id, { ...f.state, pendingDeliveryRetention: [], deliveryLedger: { ...f.ledger, entries: [] } });
  if (mode === "incomplete") f.db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?)").run("job-state-archive", "ledger-job/incomplete", "{", 2);
  const before = f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  if (mode === "budget") { let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock += 100); }
  expect(() => publishRunnerSpec(env.home, f.spec.job.id, { owner: "replacement" })).toThrow(/unsettled|bounded budget/);
  expect(f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(before);
});

it("rolls back exact executing-input completion archives and proof together, then rejects a changed completion source", () => {
  const f = fixture();
  const batch = { batch: randomUUID(), generation: f.ledger.generation, phase: "provider-admitted" as const, bodies: ["Exact accepted continuation"],
    controls: [{ cid: "original-control", body: "Exact accepted continuation" }], admission: { startedAt: 10, sessionId: "original-session" } };
  const original = { ...f.state, deliveryLedger: { ...f.ledger, entries: [] }, pendingDeliveryRetention: [],
    retainedRunnerInputs: projectRunnerInputs(batch.generation, [batch]) };
  writeRunnerStateRecord(env.home, f.spec.job.id, original);
  const before = f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all();
  const result = { reportId: randomUUID(), report: "Exact admitted C1 result", status: "done" };
  const completed = { ...original, retainedRunnerInputs: projectRunnerInputs(batch.generation, [{ ...batch, phase: "consumed", result }]) };
  f.db.exec("CREATE TRIGGER interrupt_input_proof BEFORE INSERT ON bridge_metadata WHEN NEW.domain='runner-retention-proof' BEGIN SELECT RAISE(ABORT,'controlled input proof interruption'); END");
  expect(() => writeRunnerStateRecord(env.home, f.spec.job.id, completed)).toThrow("controlled input proof interruption");
  expect(f.db.prepare("SELECT * FROM bridge_metadata ORDER BY domain,key").all()).toEqual(before);
  f.db.exec("DROP TRIGGER interrupt_input_proof");
  writeRunnerStateRecord(env.home, f.spec.job.id, completed);
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).not.toThrow();
  const proof = f.db.prepare("SELECT value FROM bridge_metadata WHERE domain='runner-retention-proof'").all()
    .map(row => JSON.parse(String(row.value))).find(row => row.messageId === `input:${batch.batch}`)!;
  expect(proof.completionSourceKey).toEqual(expect.any(String));
  const completion = String(f.db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state-archive' AND key=?").get(proof.completionSourceKey)!.value);
  const altered = JSON.parse(completion); altered.retainedRunnerInputs.batches[0].result.report = "Wrong completion context";
  f.db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state-archive' AND key=?").run(JSON.stringify(altered), proof.completionSourceKey);
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).toThrow(/unsettled/);
  f.db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state-archive' AND key=?").run(completion, proof.completionSourceKey);
  closeMetadataDb(env.home);
  expect(() => assertRunnerArchiveAdmission(env.home, f.spec.job.id)).not.toThrow();
});
