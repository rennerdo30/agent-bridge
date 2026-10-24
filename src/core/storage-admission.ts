import type { DatabaseSync } from "node:sqlite";

/** One synchronous effect scope. No approval is cached by home or carried into
 * another turn. Nested scopes cannot extend their parent's original deadline. */
type SqliteOwner = {
  db: DatabaseSync; exec: DatabaseSync["exec"]; revision: number; generation: number; users: number;
  wrappers: Map<"exec" | "close" | "open", Function>; descriptors: Map<string, PropertyDescriptor | undefined>;
};
type Policy = { owner: SqliteOwner; restore: number; temporary: number; revision: number; generation: number };
type Scope = { check: () => number; parent?: Scope; policies: Map<DatabaseSync, Policy> };
let active: Scope | undefined;
const sqliteOwners = new WeakMap<DatabaseSync, SqliteOwner>();
export function storageAdmissionRemaining(): number | undefined {
  let left: number | undefined;
  for (let scope = active; scope; scope = scope.parent) left = Math.min(left ?? Infinity, scope.check());
  return left;
}
export function storageAdmissionTimeout(normal: number): number {
  const left = storageAdmissionRemaining();
  return left === undefined ? normal : Math.max(0, Math.min(normal, Math.floor(left)));
}

function ownSqlitePolicy(db: DatabaseSync): SqliteOwner {
  const existing = sqliteOwners.get(db); if (existing) return existing;
  const owner: SqliteOwner = { db, exec: db.exec, revision: 0, generation: 0, users: 0, wrappers: new Map(), descriptors: new Map() };
  // Observe reentrant policy changes (including an explicit zero) and native
  // close/reopen, without confusing them with this scope's temporary policy.
  const exec = function(this: DatabaseSync, sql: string) {
    try { return owner.exec.call(this, sql); }
    finally { if (this === db && /\bPRAGMA\s+(?:main\.)?busy_timeout\b/i.test(sql)) owner.revision++; }
  };
  owner.wrappers.set("exec", exec);
  for (const method of ["close", "open"] as const) {
    const original = db[method];
    owner.wrappers.set(method, function(this: DatabaseSync) {
      if (this === db) owner.generation++; // Even uncertain closure invalidates old restoration authority.
      return original.call(this);
    });
  }
  try {
    for (const [method, wrapper] of owner.wrappers) {
      owner.descriptors.set(method, Object.getOwnPropertyDescriptor(db, method));
      Object.defineProperty(db, method, { configurable: true, writable: true, value: wrapper });
    }
  } catch (error) { detach(owner); throw error; }
  sqliteOwners.set(db, owner); return owner;
}
function detach(owner: SqliteOwner): void {
  for (const [method, wrapper] of owner.wrappers) if (owner.db[method] === wrapper) {
    const descriptor = owner.descriptors.get(method);
    if (descriptor) Object.defineProperty(owner.db, method, descriptor); else Reflect.deleteProperty(owner.db, method);
  }
  if (sqliteOwners.get(owner.db) === owner) sqliteOwners.delete(owner.db);
}
const busy = (db: DatabaseSync) => Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);

/** Capture the exact existing policy, or the intended ordinary policy of a new
 * handle. Temporary writes bypass only our observer; all other SQL is unchanged. */
export function admissionSqliteBusy(db: DatabaseSync, normal?: number, newlyCreated = false): void {
  storageAdmissionRemaining();
  if (!active) { if (normal !== undefined) db.exec(`PRAGMA busy_timeout=${normal}`); return; }
  const owner = ownSqlitePolicy(db);
  const capture = (scope: Scope): void => {
    if (scope.parent) capture(scope.parent);
    const prior = scope.policies.get(db);
    if (!prior) {
      const restore = newlyCreated && scope.parent === undefined ? normal! : busy(db);
      if (!Number.isInteger(restore) || restore < 0 || restore > 0x7fffffff) throw new Error("SQLite busy policy is unproven; admission refused.");
      scope.policies.set(db, { owner, restore, temporary: 0, revision: owner.revision, generation: owner.generation }); owner.users++;
    } else if (prior.generation !== owner.generation || prior.revision !== owner.revision) {
      prior.restore = busy(db); prior.revision = owner.revision; prior.generation = owner.generation;
    }
    const policy = scope.policies.get(db)!;
    policy.temporary = storageAdmissionTimeout(normal ?? policy.restore);
    owner.exec.call(db, `PRAGMA busy_timeout=${policy.temporary}`);
  };
  try { capture(active); }
  catch (error) { if (!owner.users) detach(owner); throw error; }
}

export function withStorageAdmission<T>(check: () => number, effect: () => T): T {
  const scope: Scope = { check, parent: active, policies: new Map() }; active = scope;
  let value!: T, failure: unknown, failed = false;
  try { storageAdmissionRemaining(); value = effect(); storageAdmissionRemaining(); }
  catch (error) { failure = error; failed = true; }
  finally {
    active = scope.parent;
    const cleanup: unknown[] = [];
    for (const policy of [...scope.policies.values()].reverse()) {
      const { owner } = policy;
      try {
        // No deadline check during owned cleanup. Never step a closed/reopened
        // connection, a replaced method, or a reentrant policy owner's value.
        if (policy.generation === owner.generation && policy.revision === owner.revision && owner.db.exec === owner.wrappers.get("exec") && owner.db.isOpen && busy(owner.db) === policy.temporary)
          owner.exec.call(owner.db, `PRAGMA busy_timeout=${policy.restore}`);
      } catch (error) { cleanup.push(error); }
      finally { if (--owner.users === 0) { try { detach(owner); } catch (error) { cleanup.push(error); } } }
    }
    if (cleanup.length) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, "Storage admission policy cleanup failed; original operation evidence is retained.");
  }
  if (failed) throw failure;
  return value;
}
