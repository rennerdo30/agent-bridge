import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointOwnedMetadataConnections, closeMetadataDb, metadataDb, type MetadataCheckpointOwner } from "../src/core/metadata-db.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, db: DatabaseSync, second: DatabaseSync | undefined, reader: DatabaseSync | undefined, secondHome: string | undefined;
// A normal bound MessageStore creates its main DB before admitting metadata.
// The lifecycle observer must not invent an identity for a cold absent-before-open DB.
const precreate = (home: string) => { const created = new DatabaseSync(join(home, "bridge.db")); created.exec("PRAGMA user_version=0"); created.close(); };
beforeEach(() => { env = makeEnv(); precreate(env.home); db = metadataDb(env.home); db.exec("CREATE TABLE fixture_mail(id TEXT PRIMARY KEY, body BLOB); INSERT INTO fixture_mail VALUES('accepted',X'00ff01');"); });
afterEach(async () => {
  if (reader?.isTransaction) reader.exec("ROLLBACK"); reader?.close(); reader = undefined;
  if (second?.isTransaction) second.exec("ROLLBACK");
  vi.restoreAllMocks(); if (secondHome) closeMetadataDb(secondHome);
  secondHome = undefined; second = undefined; closeMetadataDb(env.home); await env.cleanup();
});
const owner = (): MetadataCheckpointOwner => ({ ownerInstance: randomUUID(), generation: 1, home: env.home, isCurrentSealed: () => true });
const deadline = () => performance.now() + 2000;

describe("owned metadata checkpoint-only stage (all handles retained; no release authority)", () => {
  it("preserves cached statements and FULL/autocommit rollback-mode bytes without a fake WAL acknowledgement", () => {
    const statement = db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'"), close = vi.spyOn(db, "close");
    const result = checkpointOwnedMetadataConnections(owner(), deadline());
    expect(result).toMatchObject({ checkpointed: true, reason: "settled", ownedConnections: 1, physicalFiles: 1, nonWalFiles: 1, completedCheckpoints: 0, handlesRetained: true, ownershipReleased: false });
    expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1])); expect(close).not.toHaveBeenCalled(); expect(metadataDb(env.home)).toBe(db);
  });
  it("preflights a second actual active transaction before ANY checkpoint/close and retains its tentative accepted bytes", () => {
    db.exec("PRAGMA journal_mode=WAL"); secondHome = join(env.home, "other-owned-fixture"); mkdirSync(secondHome);
    precreate(secondHome); second = metadataDb(secondHome); second.exec("BEGIN IMMEDIATE; CREATE TABLE pending_fixture(body); INSERT INTO pending_fixture VALUES('pending bytes');");
    const prepare = vi.spyOn(db, "prepare"), close = vi.spyOn(db, "close"), secondClose = vi.spyOn(second, "close");
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: false, reason: "transaction_unknown", ownedConnections: 2, completedCheckpoints: 0, handlesRetained: true });
    expect(prepare.mock.calls.some(call => call[0].includes("wal_checkpoint"))).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(secondClose).not.toHaveBeenCalled(); expect(second.isTransaction).toBe(true);
    expect(second.prepare("SELECT body FROM pending_fixture").get()!.body).toBe("pending bytes");
    expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
  });
  it("actual WAL reader pressure refuses within the shared budget, restores lock wait and keeps exact stored bytes", () => {
    db.exec("PRAGMA journal_mode=WAL"); reader = new DatabaseSync(env.db, { readOnly: true }); reader.exec("BEGIN"); reader.prepare("SELECT * FROM fixture_mail").all();
    db.exec("INSERT INTO fixture_mail VALUES('later',X'010203');");
    const started = performance.now();
    expect(checkpointOwnedMetadataConnections(owner(), started + 2000)).toMatchObject({ checkpointed: false, reason: "busy", completedCheckpoints: 0, handlesRetained: true, ownershipReleased: false });
    expect(performance.now() - started).toBeLessThan(2000); expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
    expect(db.prepare("SELECT count(*) AS n FROM fixture_mail").get()!.n).toBe(2);
    reader.exec("ROLLBACK"); reader.close(); reader = undefined;
    // Explicit new fixture observation AFTER verified removal of its own reader; no internal retry.
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: true, physicalFiles: 1, completedCheckpoints: 1, nonWalFiles: 0 });
    expect(db.prepare("SELECT body FROM fixture_mail WHERE id='later'").get()!.body).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("does not upgrade NORMAL, use a stale owner generation, or execute checkpoints after expiry", () => {
    db.exec("PRAGMA synchronous=NORMAL");
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: false, reason: "durability_unknown" });
    expect(db.prepare("PRAGMA synchronous").get()!.synchronous).toBe(1);
    db.exec("PRAGMA synchronous=FULL"); const stale = owner(); stale.isCurrentSealed = () => { stale.generation++; return true; };
    expect(checkpointOwnedMetadataConnections(stale, deadline())).toMatchObject({ checkpointed: false, reason: "not_sealed" });
    const prepare = vi.spyOn(db, "prepare");
    expect(checkpointOwnedMetadataConnections(owner(), performance.now() - 1)).toMatchObject({ checkpointed: false, reason: "budget" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("a SIMULATED checkpoint IO fault preserves actual SQLite preflight, registry, statements and bytes", () => {
    db.exec("PRAGMA journal_mode=WAL"); const statement = db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'");
    const actual = db.prepare.bind(db), close = vi.spyOn(db, "close");
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (sql === "PRAGMA main.wal_checkpoint(FULL)") throw Object.assign(new Error("SIMULATED checkpoint IO fault"), { errcode: 10 });
      return actual(sql);
    });
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: false, reason: "checkpoint_unknown", handlesRetained: true, ownershipReleased: false });
    expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000); expect(close).not.toHaveBeenCalled(); expect(metadataDb(env.home)).toBe(db);
    expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1]));
  });
  it("cold absent-before-open ordinary metadata creation remains cached but cannot authorize lifecycle checkpoint", () => {
    secondHome = join(env.home, "cold-owned-fixture"); mkdirSync(secondHome);
    second = metadataDb(secondHome); second.exec("CREATE TABLE cold_mail(body BLOB); INSERT INTO cold_mail VALUES(X'ff0022');");
    const before = readFileSync(join(secondHome, "bridge.db")), firstPrepare = vi.spyOn(db, "prepare"), coldPrepare = vi.spyOn(second, "prepare"), close = vi.spyOn(second, "close");
    expect(checkpointOwnedMetadataConnections({ ...owner(), home: secondHome }, deadline())).toMatchObject({ checkpointed: false, reason: "identity_unknown", ownedConnections: 2, completedCheckpoints: 0, handlesRetained: true, ownershipReleased: false });
    expect([...firstPrepare.mock.calls, ...coldPrepare.mock.calls].some(call => call[0].includes("wal_checkpoint"))).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(metadataDb(secondHome)).toBe(second);
    expect(readFileSync(join(secondHome, "bridge.db"))).toEqual(before);
    expect(second.prepare("SELECT body FROM cold_mail").get()!.body).toEqual(new Uint8Array([255, 0, 34]));
    // Remove only the first fixture's registry entry, so the cold identity itself
    // (rather than different-home inventory) is the negative evidence.
    closeMetadataDb(env.home); coldPrepare.mockClear();
    expect(checkpointOwnedMetadataConnections({ ...owner(), home: secondHome }, deadline())).toMatchObject({ checkpointed: false, reason: "identity_unknown", ownedConnections: 1 });
    expect(coldPrepare).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")("actual POSIX replacement before entry refuses the cached old handle without writes or new initialization", () => {
    const statement = db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'"), retained = `${env.db}.retained`;
    renameSync(env.db, retained);
    const replacement = new DatabaseSync(env.db);
    replacement.exec("CREATE TABLE replacement_mail(body BLOB); INSERT INTO replacement_mail VALUES(X'fe00');"); replacement.close();
    const oldBytes = readFileSync(retained), newBytes = readFileSync(env.db), prepare = vi.spyOn(db, "prepare"), exec = vi.spyOn(db, "exec"), close = vi.spyOn(db, "close");
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: false, reason: "identity_unknown", ownedConnections: 1, completedCheckpoints: 0, handlesRetained: true, ownershipReleased: false });
    expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(metadataDb(env.home)).toBe(db); expect(statement.get()!.body).toEqual(new Uint8Array([0, 255, 1]));
    expect(readFileSync(retained)).toEqual(oldBytes); expect(readFileSync(env.db)).toEqual(newBytes);
  });
  it("actual ATTACH is refused before any main or attached checkpoint; all accepted bytes and handles remain", () => {
    const attachedFile = join(env.home, "attached-fixture.db"), attached = new DatabaseSync(attachedFile);
    attached.exec("PRAGMA journal_mode=WAL; CREATE TABLE attached_mail(body BLOB); INSERT INTO attached_mail VALUES(X'0055');"); attached.close();
    db.prepare("ATTACH DATABASE ? AS fixture_attached").run(attachedFile);
    db.exec("PRAGMA main.journal_mode=WAL; INSERT INTO fixture_attached.attached_mail VALUES(X'ff66');");
    const mainRows = db.prepare("SELECT id,body FROM fixture_mail ORDER BY id").all(), attachedRows = db.prepare("SELECT body FROM fixture_attached.attached_mail ORDER BY rowid").all();
    const prepare = vi.spyOn(db, "prepare"), close = vi.spyOn(db, "close"), exec = vi.spyOn(db, "exec");
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: false, reason: "identity_unknown", completedCheckpoints: 0, handlesRetained: true, ownershipReleased: false });
    expect(prepare.mock.calls.some(call => call[0].includes("wal_checkpoint"))).toBe(false);
    expect(exec.mock.calls.every(call => /^PRAGMA busy_timeout=\d+;$/.test(call[0]))).toBe(true);
    expect(close).not.toHaveBeenCalled(); expect(metadataDb(env.home)).toBe(db);
    expect(db.prepare("SELECT id,body FROM fixture_mail ORDER BY id").all()).toEqual(mainRows);
    expect(db.prepare("SELECT body FROM fixture_attached.attached_mail ORDER BY rowid").all()).toEqual(attachedRows);
  });
  it("SIMULATED SQLite no-WAL sentinel is not counted as a completed WAL checkpoint", () => {
    db.exec("PRAGMA journal_mode=WAL"); const actual = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = actual(sql);
      if (sql === "PRAGMA main.wal_checkpoint(FULL)") vi.spyOn(statement, "get").mockReturnValue({ busy: 0, log: -1, checkpointed: -1 });
      return statement;
    });
    expect(checkpointOwnedMetadataConnections(owner(), deadline())).toMatchObject({ checkpointed: true, noWalFiles: 1, completedCheckpoints: 0, nonWalFiles: 0, ownershipReleased: false, handlesRetained: true });
    expect(db.prepare("SELECT body FROM fixture_mail WHERE id='accepted'").get()!.body).toEqual(new Uint8Array([0, 255, 1]));
  });
});
