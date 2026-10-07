import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEEP_STORE_BACKUPS, retainBackups } from "../src/core/json-store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";

const mocks = vi.hoisted(() => ({ rename: vi.fn(), originalRename: null as typeof import("node:fs").renameSync | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  mocks.originalRename = fs.renameSync;
  mocks.rename.mockImplementation(fs.renameSync);
  return { ...fs, renameSync: mocks.rename };
});
const homes: string[] = [];
afterEach(() => { mocks.rename.mockClear(); for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "ab-backup-contention-")); homes.push(dir); return dir; };

describe("mixed-session backup contention", () => {
  it.each(["EBUSY", "EPERM", "EACCES", "ENOENT"])("retains snapshots instead of failing migration on %s", (code) => {
    const dir = home(), path = join(dir, "bridge.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE owner_data (body TEXT); INSERT INTO owner_data VALUES ('keep'); PRAGMA user_version = 1;");
    for (let i = 0; i < KEEP_STORE_BACKUPS + 2; i++) writeFileSync(`${path}.backup-000${i}`, `snapshot ${i}`);
    mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error("snapshot held by another session"), { code }); });
    try {
      expect(() => migrateSqlite(db, path, true, 2, [{ version: 2, sql: "CREATE TABLE additive (id TEXT); PRAGMA user_version = 2;" }], nullLogger)).not.toThrow();
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      expect(db.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep");
      const files = readdirSync(dir).filter((file) => file.startsWith(`${basename(path)}.backup-`));
      const archive = readdirSync(join(dir, "archive"));
      expect(files.length + archive.length).toBe(KEEP_STORE_BACKUPS + 3);
      const snapshot = files.find((file) => !/backup-000/.test(file))!;
      expect(readdirSync(join(dir, ".migration-snapshots"))).toHaveLength(1);
      const before = new DatabaseSync(join(dir, snapshot), { readOnly: true });
      try { expect(before.prepare("PRAGMA user_version").get()!.user_version).toBe(1); expect(before.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep"); }
      finally { before.close(); }
    } finally { db.close(); }
  });

  it("still surfaces unexpected storage errors without deleting the snapshot", () => {
    const dir = home(), path = join(dir, "config.json"); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < KEEP_STORE_BACKUPS + 1; i++) writeFileSync(`${path}.backup-000${i}`, "unique");
    mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); });
    expect(() => retainBackups(path)).toThrow("I/O failure");
    expect(readFileSync(`${path}.backup-0000`, "utf8")).toBe("unique");
  });

  it("recovers from a protected snapshot even if a legacy rotator moves the public copy", () => {
    const dir = home(), path = join(dir, "bridge.db"), db = new DatabaseSync(path);
    db.exec("CREATE TABLE owner_data (body TEXT); INSERT INTO owner_data VALUES ('original'); PRAGMA user_version = 1;");
    // Simulate an older process rotating the just-created public snapshot before rollback.
    let publicArchived = false;
    mocks.rename.mockImplementationOnce(() => {
      const publicSnapshot = readdirSync(dir).find((file) => /^bridge\.db\.backup-\d{13}-/.test(file))!;
      mocks.originalRename!(join(dir, publicSnapshot), join(dir, "retained-public.db"));
      publicArchived = true;
      throw Object.assign(new Error("another writer archived the public backup"), { code: "ENOENT" });
    });
    for (let i = 0; i < KEEP_STORE_BACKUPS + 1; i++) writeFileSync(`${path}.backup-000${i}`, "old backup");
    const log = { ...nullLogger, warn: vi.fn() };
    try {
      expect(() => migrateSqlite(db, path, true, 2, [{ version: 2, sql: "UPDATE owner_data SET body='changed'; CREATE TABLE broken(;" }], log)).toThrow("syntax error");
      expect(publicArchived).toBe(true);
      expect(log.warn).toHaveBeenCalledWith("failed migration restored its backup", expect.objectContaining({ backup: expect.stringContaining(".migration-snapshots") }));
      expect(db.prepare("SELECT body FROM owner_data").get()!.body).toBe("original");
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
      expect(readdirSync(join(dir, ".migration-snapshots"))).toHaveLength(1);
    } finally { db.close(); }
  });
});
