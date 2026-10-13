import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export const NATIVE_LIFECYCLE_ROUTE_LIMIT = 128;
export interface NativeRouteSnapshot { ownerInstance: string; generation: number; requestNonce: string; active: number; digest: string }
export function nativeRouteDigest(routes: { address: string; parent: string }[]): string {
  return createHash("sha256").update(JSON.stringify(routes.map(({ address, parent }) => [address, parent]).sort((a, b) => a[0]!.localeCompare(b[0]!, "en")))).digest("hex");
}

// Read-only observation, not a store initializer. Inline worker source ships in
// the existing bundle; no compiler or additional runtime dependency is needed.
const SOURCE = String.raw`
const { parentPort, workerData: w } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { lstatSync } = require('node:fs');
let db, result;
try {
  const before = lstatSync(w.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw Error();
  db = new DatabaseSync(w.path, { readOnly: true, timeout: 25 });
  db.exec('PRAGMA query_only=ON');
  db.exec('BEGIN');
  let routes = [];
  const objects = db.prepare("SELECT type FROM sqlite_master WHERE name='native_child_routes' COLLATE NOCASE LIMIT 2").all();
  if (objects.length) {
    if (objects.length !== 1 || objects[0].type !== 'table') throw Error();
    const columns = db.prepare("SELECT name,type,[notnull],pk,hidden FROM pragma_table_xinfo('native_child_routes') LIMIT 4").all();
    if (columns.length !== 3 || columns.some(c => c.hidden !== 0) || columns[0].name !== 'address' || columns[0].type !== 'TEXT' || columns[0].pk !== 1 ||
        columns[1].name !== 'parent' || columns[1].type !== 'TEXT' || columns[1].notnull !== 1 || columns[1].pk !== 0 ||
        columns[2].name !== 'active' || columns[2].type !== 'INTEGER' || columns[2].notnull !== 1 || columns[2].pk !== 0) throw Error();
    // Canonical old DDL has no CHECK constraint. Ignoring unsupported retained
    // values would fabricate zero activity; absence and inactive INTEGER0 differ.
    if (db.prepare("SELECT 1 FROM native_child_routes WHERE typeof(active)!='integer' OR active NOT IN(0,1) OR typeof(address)!='text' OR typeof(parent)!='text' LIMIT 1").get()) throw Error();
    const count = db.prepare('SELECT COUNT(*) n, MAX(length(address)) a, MAX(length(parent)) p FROM native_child_routes WHERE active=1').get();
    if (!Number.isSafeInteger(count.n) || count.n < 0 || count.n > 128 || count.a > 256 || count.p > 64) throw Error();
    routes = db.prepare('SELECT address,parent FROM native_child_routes WHERE active=1 LIMIT 129').all();
    if (routes.length !== count.n || routes.some(r => typeof r.address !== 'string' || typeof r.parent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/sub:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.address) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.parent))) throw Error();
  }
  const digest = createHash('sha256').update(JSON.stringify(routes.map(r => [r.address, r.parent]).sort((a, b) => a[0].localeCompare(b[0], 'en')))).digest('hex');
  db.exec('COMMIT');
  const after = lstatSync(w.path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino) throw Error();
  result = { ownerInstance: w.ownerInstance, generation: w.generation, requestNonce: w.requestNonce, active: routes.length, digest };
} catch { result = { unavailable: true }; }
finally { try { if (db?.isTransaction === true) db.exec('ROLLBACK'); db?.close(); } catch { result = { unavailable: true }; } }
parentPort.postMessage(result);
`;

/** At most one outstanding read. Late results/worker exit never turn a timeout into eligibility. */
export class NativeLifecycleReader {
  private worker: Worker | null = null;
  pending(): number { return this.worker ? 1 : 0; }
  read(path: string, ownerInstance: string, generation: number, deadline: number): Promise<NativeRouteSnapshot> {
    if (this.worker || !Number.isFinite(deadline) || performance.now() >= deadline || !Number.isSafeInteger(generation)) return Promise.reject(new Error("native_state_unknown"));
    const requestNonce = randomUUID();
    const worker = new Worker(SOURCE, { eval: true, execArgv: [], workerData: { path, ownerInstance, generation, requestNonce } });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let result: NativeRouteSnapshot | undefined, settled = false;
      const refuse = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("native_state_unknown")); } };
      const timer = setTimeout(refuse, Math.max(0, deadline - performance.now()));
      worker.on("message", value => {
        if (!value || value.ownerInstance !== ownerInstance || value.generation !== generation || value.requestNonce !== requestNonce || !Number.isSafeInteger(value.active) || value.active < 0 || value.active > NATIVE_LIFECYCLE_ROUTE_LIMIT || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) return refuse();
        result = value;
      });
      worker.on("error", refuse);
      worker.once("exit", code => {
        if (this.worker === worker) this.worker = null;
        if (settled) return;
        if (code !== 0 || !result || performance.now() >= deadline) return refuse();
        settled = true; clearTimeout(timer); resolve(result);
      });
      worker.unref();
    });
  }
}
