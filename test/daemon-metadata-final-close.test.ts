import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataCloseObservation } from "../src/core/metadata-db.js";

// Hosted-only actual SQLite fixtures. Positive lifecycle retirement, partial
// close, statement invalidation and lease-release assertions are UNREACHABLE
// until the separately reviewed canonical issuer/guarded consumers are wired.
// Ordinary fixture setup/teardown uses legacy close and operation lease release;
// neither is presented as native lifecycle closure or durability acceptance.
const leaseFixture = vi.hoisted(() => ({ onRelease: undefined as (() => void) | undefined,
 held: new Set<() => void>() }));
vi.mock("../src/core/storage-lock.js", async importOriginal => {
 const actual = await importOriginal<typeof import("../src/core/storage-lock.js")>();
 return { ...actual, storageLease: (home: string) => {
  const release = actual.storageLease(home);
  leaseFixture.held.add(release);
  return () => { leaseFixture.onRelease?.(); release(); leaseFixture.held.delete(release); };
 } };
});

let api: typeof import("../src/core/metadata-db.js"), home: string, file: string, db: DatabaseSync;
const ownedHomes: string[] = [];
const independent: DatabaseSync[] = [];
const unregisteredNative: DatabaseSync[] = [];
const deadline = () => performance.now() + 2000; // One original write-phase deadline per explicit fixture observation.
function established(path: string): void {
 mkdirSync(path, { recursive: true });
 // This helper owns a fresh scratch file, not a historical component-1 store.
 // Mint the current component from the canonical version before establishing
 // the pre-open identity needed by these non-authorizing observations. An extra
 // production open/close here would contaminate the lifecycle counts under test.
 expect(existsSync(join(path, "bridge.db"))).toBe(false);
 const created = new DatabaseSync(join(path, "bridge.db"));
 created.exec(`CREATE TABLE bridge_components(name TEXT PRIMARY KEY, version INTEGER NOT NULL); CREATE TABLE bridge_metadata(domain TEXT,key TEXT,value TEXT,updated_at INTEGER,PRIMARY KEY(domain,key));`);
 created.prepare("INSERT INTO bridge_components VALUES('metadata',?)").run(api.METADATA_STORE_VERSION);
 expect(created.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version).toBe(api.METADATA_STORE_VERSION);
 created.exec("CREATE TABLE fixture_mail(id TEXT PRIMARY KEY,body BLOB); INSERT INTO fixture_mail VALUES('accepted',X'00ff01');");
 created.close();
}
function observe(): MetadataCloseObservation { return api.observeMetadataClosePrerequisites(deadline()); }
function retained(result: MetadataCloseObservation): void {
 expect(result).toMatchObject({ authority: false, reason: "owner_unsupported", handlesRetained: true, ownershipReleased: false });
 expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.blockers)).toBe(true); expect(Object.isFrozen(result.outcomes)).toBe(true);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
 const serialized = JSON.stringify(result);
 expect(serialized).not.toContain(home); expect(serialized).not.toContain("accepted");
 expect(result.membershipDigest === null || /^[a-f0-9]{64}$/.test(result.membershipDigest)).toBe(true);
 expect(result.schemaDigest).toBeNull(); // No reviewed non-recovering schema-read path exists.
}
function noEffects() {
 const close = vi.spyOn(db, "close"), exec = vi.spyOn(db, "exec"), prepare = vi.spyOn(db, "prepare");
 return () => {
  expect(close).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled(); // Even a PRAGMA prepare may recover a hot journal.
 };
}
beforeEach(async () => {
 vi.resetModules(); leaseFixture.onRelease = undefined; leaseFixture.held.clear();
 api = await import("../src/core/metadata-db.js");
 home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-metadata-observe-"))); file = join(home, "bridge.db");
 established(home); ownedHomes.push(home); db = api.metadataDb(home);
 // FIXTURE policy: the observer itself MUST NOT lower this or upgrade FULL.
 db.exec("PRAGMA busy_timeout=25");
});
afterEach(async () => {
 leaseFixture.onRelease = undefined; for (const release of leaseFixture.held) release(); leaseFixture.held.clear(); vi.restoreAllMocks();
 for (const handle of unregisteredNative.splice(0)) if (handle.isOpen) handle.close();
 for (const reader of independent.splice(0)) { if (reader.isTransaction) reader.exec("ROLLBACK"); reader.close(); }
 for (const path of ownedHomes.splice(0)) {
  const handle = api.existingMetadataDb(path);
  if (handle?.isOpen) { if (handle.isTransaction) handle.exec("ROLLBACK"); api.closeMetadataDb(path); }
 }
 await rm(home, { recursive: true, force: true });
});

describe("metadata close prerequisites: observations only; canonical issuer UNWIRED", () => {
 it("keeps actual accepted BLOBs, cached statements and independent RO bytes intact", () => {
  const statement = db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'");
  const reader = new DatabaseSync(file, { readOnly: true }); independent.push(reader);
  reader.exec("PRAGMA query_only=ON");
  const before = readFileSync(file), rows = reader.prepare("SELECT id,body FROM fixture_mail").all();
  expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1]));
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("consumer_unknown"); expect(result.outcomes.unattempted).toBe(1);
  expect(api.metadataDb(home)).toBe(db); expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1]));
  expect(reader.prepare("SELECT id,body FROM fixture_mail").all()).toEqual(rows); expect(readFileSync(file)).toEqual(before);
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(25);
 });
 it("does not accept a raw borrower or a copied declaration as consumer completeness", () => {
  const borrower = api.existingMetadataDb(home)!; expect(borrower).toBe(db);
  const statement = borrower.prepare("SELECT body FROM fixture_mail"); const unchanged = noEffects();
  const original = observe(), copied = { ...original, authority: true, complete: true, sealed: true };
  const call = api.observeMetadataClosePrerequisites as (deadline: number, ignored?: unknown) => MetadataCloseObservation;
  const result = call(deadline(), copied); retained(result); unchanged(); expect(result.blockers).toContain("consumer_unknown");
  expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1]));
  expect("prepareMetadataFinalClose" in api).toBe(false); expect("retireOwnedMetadataConnections" in api).toBe(false);
 });
 it("preflights a second real transaction without rollback, close or partial retirement", () => {
  const secondHome = join(home, "second"); established(secondHome); ownedHomes.push(secondHome);
  const second = api.metadataDb(secondHome); second.exec("PRAGMA busy_timeout=25; BEGIN IMMEDIATE; INSERT INTO fixture_mail VALUES('pending',X'ff22');");
  const secondClose = vi.spyOn(second, "close"), secondExec = vi.spyOn(second, "exec"), unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("transaction_active");
  expect(result.outcomes.registeredHandles).toBe(2); expect(secondClose).not.toHaveBeenCalled(); expect(secondExec).not.toHaveBeenCalled();
  expect(second.isTransaction).toBe(true); expect(second.prepare("SELECT body FROM fixture_mail WHERE id='pending'").get()!.body).toEqual(new Uint8Array([255, 34]));
 });
 it("keeps two actual aliased-file handles distinct and refuses their unproved identities", () => {
  const aliasHome = join(home, "alias"); mkdirSync(aliasHome); linkSync(file, join(aliasHome, "bridge.db")); ownedHomes.push(aliasHome);
  const alias = api.metadataDb(aliasHome); expect(alias).not.toBe(db); alias.exec("PRAGMA busy_timeout=25; BEGIN IMMEDIATE");
  const close = vi.spyOn(alias, "close"), exec = vi.spyOn(alias, "exec"), unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.outcomes.registeredHandles).toBe(2);
  expect(result.blockers).toContain("identity_unknown"); expect(result.blockers).toContain("transaction_active");
  expect(alias.isTransaction).toBe(true); expect(close).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
 });
 it("a genuinely closed native handle makes transaction state unavailable without redefining its accessor", () => {
  db.close(); // Actual raw borrower close, outside the observer; its native identity stays registered.
  expect(db.isOpen).toBe(false); expect(() => db.isTransaction).toThrow();
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("transaction_unknown"); expect(result.blockers).toContain("handle_unknown");
  expect(result.outcomes.registeredHandles).toBe(1); expect(api.metadataDb(home)).toBe(db);
 });
 it("leaves actual ATTACH coverage UNPROVED without measuring or changing either store", () => {
  const initial = observe(); const attached = join(home, "attached.db"), created = new DatabaseSync(attached);
  created.exec("CREATE TABLE attached_mail(body BLOB); INSERT INTO attached_mail VALUES(X'ff66')"); created.close();
  db.prepare("ATTACH DATABASE ? AS fixture_attached").run(attached);
  const mainBefore = readFileSync(file), attachedBefore = readFileSync(attached), unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("schema_unknown");
  expect(result.blockers).toContain("nonrecovering_read_unproved"); expect(result.schemaDigest).toBeNull(); expect(initial.schemaDigest).toBeNull();
  expect(db.prepare("SELECT body FROM fixture_attached.attached_mail").get()!.body).toEqual(new Uint8Array([255, 102]));
  expect(readFileSync(file)).toEqual(mainBefore); expect(readFileSync(attached)).toEqual(attachedBefore);
 });
 it("leaves actual main-schema changes UNPROVED without a recovering page probe", () => {
  const initial = observe(); db.exec("CREATE TABLE new_fixture(body BLOB)"); const before = readFileSync(file), unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("schema_unknown");
  expect(result.schemaDigest).toBeNull(); expect(initial.schemaDigest).toBeNull(); expect(readFileSync(file)).toEqual(before);
  expect(db.prepare("SELECT count(*) AS n FROM new_fixture").get()!.n).toBe(0); // Ordinary cold-fixture SQL, outside observer.
 });
 it("leaves actual NORMAL policy UNPROVED without measuring or upgrading it", () => {
  db.exec("PRAGMA synchronous=NORMAL"); const unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("durability_unknown");
  expect(db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(1);
 });
 it("retains actual SQLite exclusive-lock pressure without a page read to measure it", () => {
  const holder = new DatabaseSync(file); independent.push(holder);
  holder.exec("BEGIN EXCLUSIVE; INSERT INTO fixture_mail VALUES('locked-pending',X'3344')");
  const holderClose = vi.spyOn(holder, "close"), holderExec = vi.spyOn(holder, "exec"), unchanged = noEffects();
  const before = readFileSync(file), journal = readFileSync(`${file}-journal`);
  const end = deadline(), result = api.observeMetadataClosePrerequisites(end); retained(result); unchanged();
  expect(result.blockers).toContain("nonrecovering_read_unproved"); expect(result.blockers).toContain("durability_unknown"); expect(holder.isTransaction).toBe(true);
  expect(holderClose).not.toHaveBeenCalled(); expect(holderExec).not.toHaveBeenCalled();
  expect(readFileSync(file)).toEqual(before); expect(readFileSync(`${file}-journal`)).toEqual(journal);
 });
 it("retains real WAL reader pressure as explicitly UNPROVED without issuing any checkpoint", () => {
  db.exec("PRAGMA journal_mode=WAL"); const reader = new DatabaseSync(file, { readOnly: true }); independent.push(reader);
  reader.exec("BEGIN"); const oldRows = reader.prepare("SELECT id,body FROM fixture_mail ORDER BY id").all();
  db.exec("INSERT INTO fixture_mail VALUES('later',X'010203')");
  const before = [file, `${file}-wal`, `${file}-shm`].map(path => readFileSync(path));
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("wal_pressure_unproved"); expect(reader.isTransaction).toBe(true);
  expect(readFileSync(file)).toEqual(before[0]); expect(readFileSync(`${file}-wal`)).toEqual(before[1]);
  expect(readFileSync(`${file}-shm`)).toEqual(before[2]); // Before any ordinary post-observer SQL.
  expect(reader.prepare("SELECT id,body FROM fixture_mail ORDER BY id").all()).toEqual(oldRows);
  expect(db.prepare("SELECT body FROM fixture_mail WHERE id='later'").get()!.body).toEqual(new Uint8Array([1, 2, 3]));
 });
 it("retains a genuine owned-child hot rollback journal beside the actual idle RW handle", async () => {
  const statement = db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'");
  expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1])); expect(db.isTransaction).toBe(false);
  const originalMain = readFileSync(file);
  // Hosted ONLY: this exact child deliberately exits mid-transaction. Cache4
  // forces real page/journal spill; no fabricated header, signal/kill or model.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
   import { DatabaseSync } from 'node:sqlite';
   const writer = new DatabaseSync(process.argv[1]);
   writer.exec('PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA cache_size=4; BEGIN IMMEDIATE');
   const insert = writer.prepare('INSERT INTO fixture_mail(id,body) VALUES(?,?)');
   for (let n=0;n<512;n++) insert.run('hot-'+n,new Uint8Array(8192).fill(33));
   process.exit(23);
  `, file], { stdio: "ignore", windowsHide: true });
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
   child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  expect(exit).toEqual({ code: 23, signal: null }); // Natural observed exit of the exact owned child.
  // Snapshot BEFORE observer; no SQL, new reader or cached-statement use after
  // child exit. Ordinary SQL here would itself recover and destroy the evidence.
  const main = readFileSync(file), journalFile = `${file}-journal`, journal = readFileSync(journalFile);
  expect(journal.length).toBeGreaterThan(512); expect(journal.subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
  expect(journal.readUInt32BE(16)).toBeGreaterThan(0); expect(journal.readUInt32BE(24)).toBeGreaterThanOrEqual(512);
  expect(main.equals(originalMain)).toBe(false); // Actual uncommitted database spill, not only an inert journal file.
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("nonrecovering_read_unproved"); expect(result.blockers).toContain("schema_unknown");
  expect(result.blockers).toContain("durability_unknown"); expect(result.schemaDigest).toBeNull();
  expect(api.metadataDb(home)).toBe(db); expect(db.isOpen).toBe(true); expect(db.isTransaction).toBe(false);
  expect(readFileSync(file)).toEqual(main); expect(readFileSync(journalFile)).toEqual(journal);
  // Do NOT call statement.get() or inspect rows. It is retained but its safe use
  // is UNPROVED in this hot state. Teardown uses native close only, then fixture
  // deletion; neither is an assertion of recovery, accepted bytes or retirement.
 });
 it("retains actual changed linkage while current admission identity remains UNPROVED", () => {
  linkSync(file, join(home, "same-file-alias.db")); const before = readFileSync(file), unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("identity_unknown");
  expect(api.metadataDb(home)).toBe(db); expect(readFileSync(file)).toEqual(before);
 });
 it("never backfills a cold absent-before-open admission", () => {
  const coldHome = join(home, "cold"); mkdirSync(coldHome); ownedHomes.push(coldHome);
  const cold = api.metadataDb(coldHome); cold.exec("PRAGMA busy_timeout=25; CREATE TABLE cold_mail(body BLOB); INSERT INTO cold_mail VALUES(X'ff0022')");
  const close = vi.spyOn(cold, "close"), result = observe(); retained(result);
  expect(result.blockers).toContain("identity_unknown"); expect(close).not.toHaveBeenCalled(); expect(api.metadataDb(coldHome)).toBe(cold);
  expect(cold.prepare("SELECT body FROM cold_mail").get()!.body).toEqual(new Uint8Array([255, 0, 34]));
 });
 it("observes retained readers and actual registry mutation during a SIMULATED clock reentry", () => {
  const releaseReader = api.retainMetadataReader(home); const before = observe(); expect(before.blockers).toContain("readers_retained");
  let laterReader: (() => void) | undefined, calls = 0; const end = deadline(), actualNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => {
   if (++calls === 2) laterReader = api.retainMetadataReader(home);
   return actualNow();
  });
  const unchanged = noEffects(), close = vi.spyOn(db, "close"), result = api.observeMetadataClosePrerequisites(end); retained(result); unchanged(); expect(result.blockers).toContain("registry_changed");
  expect(result.membershipDigest).toBeNull(); expect(close).not.toHaveBeenCalled(); expect(result.registryGeneration).toBe(before.registryGeneration);
  vi.restoreAllMocks(); laterReader!(); releaseReader(); // Ordinary fixture teardown, outside observation.
 });
 it("records operation lease callback outcomes without claiming exact nonce release", () => {
  let during: MetadataCloseObservation | undefined, releases = 0; const close = vi.spyOn(db, "close");
  leaseFixture.onRelease = () => { releases++; during = observe(); }; // Actual storage lease is still held inside its original finally.
  api.saveMetadataValue(home, "fixture", "accepted", { bytes: "preserved" }); leaseFixture.onRelease = undefined;
  expect(during!.blockers).toContain("lease_active"); expect(during!.blockers).toContain("lease_unknown"); retained(during!);
  const result = observe(); retained(result); expect(result.outcomes.leaseCallbackReturns).toBe(1);
  expect(result.blockers).toContain("lease_unknown"); expect(close).not.toHaveBeenCalled();
  expect(releases).toBe(1); // Observation did not call the real release callback recursively.
  expect(api.metadataValue(home, "fixture", "accepted")).toEqual({ bytes: "preserved" });
 });
 it("labels SIMULATED lease callback failure and retains unknown lease bookkeeping", () => {
  leaseFixture.onRelease = () => { throw Error("SIMULATED release failure before actual callback"); };
  expect(() => api.saveMetadataValue(home, "fixture", "accepted", { bytes: "preserved" })).toThrow("SIMULATED release failure");
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("lease_unknown"); expect(result.outcomes.leaseCallbackReturns).toBe(0);
  expect(leaseFixture.held.size).toBe(1); expect(result.outcomes.retainedLeaseFailures).toBe(1);
  expect(api.metadataValue(home, "fixture", "accepted")).toEqual({ bytes: "preserved" });
  // The fixture releases its own actual storage lease in afterEach. Synthetic
  // ledger failure is not a native release fault or lifecycle closure proof.
 });
 it("labels SIMULATED legacy-close failure bookkeeping and retains the actual handle", () => {
  vi.spyOn(db, "close").mockImplementation(() => { throw Error("SIMULATED legacy close failure, no native close issued"); });
  expect(() => api.closeMetadataDb(home)).toThrow("SIMULATED legacy close failure");
  const result = observe(); retained(result); expect(result.outcomes.failed).toBe(1); expect(result.blockers).toContain("handle_unknown");
  expect(result.outcomes.retainedHandleFailures).toBe(1);
  expect(api.metadataDb(home)).toBe(db); expect(db.prepare("SELECT body FROM fixture_mail").get()!.body).toEqual(new Uint8Array([0, 255, 1]));
 });
 it("never reuses actual admitted-handle IDs after ordinary fixture close/reopen", () => {
  const first = observe(); api.closeMetadataDb(home); db = api.metadataDb(home); db.exec("PRAGMA busy_timeout=25");
  const result = observe(); retained(result); expect(result.admissionGeneration).toBeGreaterThan(first.admissionGeneration);
  expect(result.membershipDigest).not.toBe(first.membershipDigest); expect(result.outcomes.legacyCloseReturns).toBe(1);
  expect(result.outcomes.unattempted).toBe(1); expect(result.blockers).toContain("consumer_unknown");
 });
 it("missing, forged, copied and expired authority cannot issue observation SQL or any effect", () => {
  const fake = Object.freeze({ authority: true, complete: true, seal: "sealed", permit: "committed", generation: 1 });
  const coercion = { valueOf: () => { throw Error("caller-owned authority must not be coerced"); } };
  const unchanged = noEffects(), prepare = vi.spyOn(db, "prepare");
  for (const input of [undefined, fake, { ...fake }, coercion, NaN, Infinity, performance.now() - 1]) {
   const result = api.observeMetadataClosePrerequisites(input as unknown as number); retained(result); expect(result.blockers).toContain("budget");
  }
  expect(prepare).not.toHaveBeenCalled(); unchanged();
 });
 it("preserves default lock-wait policy and leaves its value UNPROVED without any SQL", () => {
  db.exec("PRAGMA busy_timeout=5000"); const unchanged = noEffects();
  const result = observe(); retained(result); unchanged(); expect(result.blockers).toContain("nonrecovering_read_unproved");
  expect(result.blockers).toContain("schema_unknown"); expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
 });
 it("uses the original budget when a SIMULATED in-memory observation clock returns late", () => {
  const started = performance.now(), end = started + 2000; let calls = 0;
  vi.spyOn(performance, "now").mockImplementation(() => ++calls >= 4 ? end + 1 : started);
  const unchanged = noEffects(), prepare = vi.spyOn(db, "prepare"), result = api.observeMetadataClosePrerequisites(end);
  retained(result); expect(result.blockers).toContain("budget"); expect(result.membershipDigest).toBeNull();
  expect(result.outcomes.observedHandles).toBe(1); expect(prepare).not.toHaveBeenCalled(); unchanged();
 });
 it("refuses a real membership overflow without truncating a purported complete census", () => {
  // No extra SQLite opens required: these are real reader registrations, never grants.
  const releases: (() => void)[] = [];
  for (let index = 0; index < 128; index++) releases.push(api.retainMetadataReader(join(home, `reader-${index}`)));
  const unchanged = noEffects(), prepare = vi.spyOn(db, "prepare"), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("bound"); expect(result.membershipDigest).toBeNull(); expect(prepare).not.toHaveBeenCalled();
  expect(result.outcomes.retainedReaders).toBeNull(); expect(result.outcomes.observedHandles).toBe(0);
  for (const release of releases) release();
 });
 it("retains the actual129th init/close-failed native reference and a distinct130th attempt beyond the manifest", () => {
  for (let index = 0; index < 127; index++) {
   const path = join(home, `owned-${index}`); established(path); ownedHomes.push(path); api.metadataDb(path);
  }
  const baseline = observe(); expect(baseline.outcomes.registeredHandles).toBe(128);
  const failedHome = join(home, "overflow-failed"), failedFile = join(failedHome, "bridge.db"); established(failedHome);
  const actualExec = DatabaseSync.prototype.exec, actualClose = DatabaseSync.prototype.close;
  const preflightClosed: DatabaseSync[] = [];
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
   const result = actualExec.call(this, sql);
   if (this.location("main") === failedFile) {
    unregisteredNative.push(this);
    throw Error("SIMULATED init failure after actual ordinary SQL on overflow native handle");
   }
   return result;
  });
  const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
   // Only the exact writer captured by the initialization fault owns this
   // injected close failure. The new read-only compatibility inspection must
   // finish closing before that distinct writable admission can even exist.
   if (unregisteredNative.includes(this)) throw Error("SIMULATED overflow close failure before actual close");
   if (this.location("main") === failedFile) { actualClose.call(this); preflightClosed.push(this); return; }
   return actualClose.call(this);
  });
  expect(() => api.metadataDb(failedHome)).toThrow("SIMULATED overflow close failure");
  expect(preflightClosed).toHaveLength(1); expect(preflightClosed[0]).toBeInstanceOf(DatabaseSync); expect(preflightClosed[0]!.isOpen).toBe(false);
  const first = unregisteredNative[0]!; expect(first).toBeInstanceOf(DatabaseSync); expect(first.isOpen).toBe(true);
  expect(first).not.toBe(preflightClosed[0]);
  exec.mockClear(); close.mockClear(); const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), result = observe(); retained(result);
  expect(result.blockers).toContain("bound"); expect(result.outcomes.registeredHandles).toBe(129);
  expect(result.outcomes.retainedHandleFailures).toBe(1); expect(result.outcomes.observedHandles).toBe(0);
  expect(result.admissionGeneration).toBe(baseline.admissionGeneration + 1); expect(result.membershipDigest).toBeNull();
  expect(exec).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(() => api.metadataDb(failedHome)).toThrow("SIMULATED overflow close failure");
  expect(preflightClosed).toHaveLength(2); expect(preflightClosed[1]).not.toBe(preflightClosed[0]); expect(preflightClosed[1]!.isOpen).toBe(false);
  expect(unregisteredNative[1]).not.toBe(first); expect(unregisteredNative[1]!.isOpen).toBe(true);
  expect(unregisteredNative[1]).not.toBe(preflightClosed[1]);
  exec.mockClear(); close.mockClear(); prepare.mockClear(); const later = observe(); retained(later);
  expect(later.outcomes.registeredHandles).toBe(130); expect(later.outcomes.retainedHandleFailures).toBe(2);
  expect(later.admissionGeneration).toBe(result.admissionGeneration + 1); expect(later.membershipDigest).toBeNull();
  expect(exec).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  // Public counts are non-authorizing bookkeeping. Native objects/methods stay
  // actual; the private ledger stores each exact reference/nonreused ID even
  // though initialization never reached connections. No close/release proof.
 });
 it("retains129 actual held lease callbacks after SIMULATED release failures without truncating evidence", () => {
  leaseFixture.onRelease = () => { throw Error("SIMULATED overflow lease release failure before actual callback"); };
  for (let index = 0; index < 129; index++) {
   expect(() => api.saveMetadataValue(home, "overflow", String(index), { accepted: index })).toThrow("SIMULATED overflow lease release failure");
  }
  const unchanged = noEffects(), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("bound"); expect(result.blockers).toContain("lease_unknown");
  expect(result.outcomes.retainedLeaseFailures).toBe(129); expect(leaseFixture.held.size).toBe(129);
  expect(result.outcomes.leaseCallbackReturns).toBe(0); expect(result.membershipDigest).toBeNull();
  expect(api.metadataValue(home, "overflow", "128")).toEqual({ accepted: 128 });
  // afterEach releases only these fixture-owned actual callbacks outside the
  // observer. This does not prove exact lifecycle lease/owner retirement.
 });
 it("refuses actual reader-descriptor overflow of the shared64KiB envelope", () => {
  const releases: (() => void)[] = [];
  for (let index = 0; index < 100; index++) releases.push(api.retainMetadataReader(join(home, `${index}-${"x".repeat(700)}`)));
  const unchanged = noEffects(), prepare = vi.spyOn(db, "prepare"), result = observe(); retained(result); unchanged();
  expect(result.blockers).toContain("bound"); expect(result.membershipDigest).toBeNull(); expect(prepare).not.toHaveBeenCalled();
  expect(result.outcomes.retainedReaders).toBeNull();
  for (const release of releases) release(); // Reader bookkeeping only; no corresponding files were created.
 });
});
