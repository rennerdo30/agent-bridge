import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArchive, archiveInitializationObservation } from "../src/core/sqlite-maintenance.js";
import { openHistoryStore, historyInitializationObservation } from "../src/core/history-store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// Actual isolated native resources only. Fixture disposal is not a production
// force-close API or evidence the source's unknown close had succeeded.
const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
const owned = new Map<DatabaseSync, { actuallyClosed: boolean }>();
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [db, outcome] of owned) {
    if (!outcome.actuallyClosed) { nativeClose.call(db); outcome.actuallyClosed = true; }
    owned.delete(db);
  }
  await env.cleanup();
});
function dispose(db: DatabaseSync): void { nativeClose.call(db); owned.get(db)!.actuallyClosed = true; }
const kinds = [
  { name: "archive", open: openArchive, observe: archiveInitializationObservation, initialSql: "PRAGMA busy_timeout = 3000" },
  { name: "history", open: openHistoryStore, observe: historyInitializationObservation, initialSql: "PRAGMA busy_timeout=3000" },
] as const;
function initialized(kind: typeof kinds[number], name: string) {
  const file = join(env.home, name), db = kind.open(file); owned.set(db, { actuallyClosed: false });
  db.exec("CREATE TABLE owned_closure_fixture(id INTEGER PRIMARY KEY, body BLOB NOT NULL); INSERT INTO owned_closure_fixture VALUES(1,x'00ff04');");
  dispose(db); return { file, bytes: readFileSync(file) };
}
function retainedRow(file: string) {
  const db = new DatabaseSync(file, { readOnly: true }); owned.set(db, { actuallyClosed: false });
  try { db.exec("PRAGMA query_only=ON"); return [...db.prepare("SELECT body FROM owned_closure_fixture WHERE id=1").get()!.body as Uint8Array]; }
  finally { dispose(db); }
}
describe("owned opener capture dependency (not producer drain or final-close authority)", () => {
  for (const kind of kinds) {
    it(`${kind.name} records the actual initialized handle without native SQL or owner/retirement certification`, () => {
      const db = kind.open(join(env.home, `${kind.name}.db`)); owned.set(db, { actuallyClosed: false });
      const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(kind.observe(db)).toEqual({ captured: true, initialization: "returned", close: "not_attempted", retained: false,
        overflow: false, ownerBound: false, ownershipReleased: false });
      expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
      expect(kind.observe({ ...db } as unknown as DatabaseSync)).toMatchObject({ captured: false, initialization: "unavailable", ownerBound: false, ownershipReleased: false });
      exec.mockRestore(); prepare.mockRestore(); dispose(db);
      // This is explicitly historical initialization evidence, not a fabricated
      // acknowledgement of a later caller's close or current owner completeness.
      expect(kind.observe(db)).toMatchObject({ initialization: "returned", close: "not_attempted", ownershipReleased: false });
    });
    it(`${kind.name} preserves a real initialized database when SIMULATED initialization fails and actual close returns`, () => {
      const fixture = initialized(kind, `${kind.name}-closed.db`), failure = new Error("SIMULATED initialization error after real native SQL");
      let captured: DatabaseSync | undefined;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
        const result = nativeExec.call(this, sql);
        if (sql === kind.initialSql) {
          expect(kind.observe(this)).toMatchObject({ captured: true, initialization: "initializing", close: "not_attempted", ownerBound: false });
          captured = this; owned.set(this, { actuallyClosed: false }); throw failure;
        }
        return result;
      });
      const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
        const result = nativeClose.call(this); if (this === captured) owned.get(this)!.actuallyClosed = true; return result;
      });
      expect(() => kind.open(fixture.file)).toThrow(failure); expect(close).toHaveBeenCalledTimes(1);
      expect(kind.observe(captured!)).toMatchObject({ initialization: "failed", close: "returned", retained: true, ownerBound: false, ownershipReleased: false });
      vi.restoreAllMocks(); expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
    });
    it(`${kind.name} strongly retains exact failed native capture when SIMULATED close throws before or after actual close`, () => {
      for (const when of ["before", "after"] as const) {
        const fixture = initialized(kind, `${kind.name}-${when}.db`);
        const initializationFailure = new Error("SIMULATED initialization failure"), closeFailure = new Error("SIMULATED native close outcome error");
        let captured: DatabaseSync | undefined;
        vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
          const result = nativeExec.call(this, sql);
          if (sql === kind.initialSql) {
            expect(kind.observe(this)).toMatchObject({ captured: true, initialization: "initializing", close: "not_attempted", ownerBound: false });
            captured = this; owned.set(this, { actuallyClosed: false }); throw initializationFailure;
          }
          return result;
        });
        const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
          if (this !== captured) return nativeClose.call(this);
          if (when === "after") { nativeClose.call(this); owned.get(this)!.actuallyClosed = true; }
          throw closeFailure;
        });
        // Existing helper semantics throw its actual close error if close fails.
        expect(() => kind.open(fixture.file)).toThrow(closeFailure); expect(close).toHaveBeenCalledTimes(1);
        expect(kind.observe(captured!)).toMatchObject({ captured: true, initialization: "failed", close: "unknown", retained: true,
          ownerBound: false, ownershipReleased: false });
        vi.restoreAllMocks();
        if (!owned.get(captured!)!.actuallyClosed) dispose(captured!);
        expect(kind.observe(captured!)).toMatchObject({ close: "unknown", retained: true, ownershipReleased: false });
        expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
      }
    });
  }
  it("retains every actual failed capture beyond the bounded census limit without reusing native identities", () => {
    const kind = kinds[0], fixture = initialized(kind, "archive-overflow.db"), captures: DatabaseSync[] = [];
    const initializationFailure = new Error("SIMULATED initialization failure"), closeFailure = new Error("SIMULATED error after actual native close");
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      const result = nativeExec.call(this, sql);
      if (sql === kind.initialSql) { captures.push(this); owned.set(this, { actuallyClosed: false }); throw initializationFailure; }
      return result;
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      nativeClose.call(this); owned.get(this)!.actuallyClosed = true; throw closeFailure;
    });
    for (let n = 0; n < 129; n++) expect(() => kind.open(fixture.file)).toThrow(closeFailure);
    expect(new Set(captures).size).toBe(129);
    for (const db of captures) expect(kind.observe(db)).toMatchObject({ initialization: "failed", close: "unknown", retained: true,
      overflow: true, ownerBound: false, ownershipReleased: false });
    vi.restoreAllMocks(); expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
  });
});
