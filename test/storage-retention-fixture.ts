import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHistoryFunctions } from "../src/core/history-codec.js";

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Capture every original path and file hash, including sidecars and nested candidate files. */
export function originalFiles(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string) => {
    const st = lstatSync(path);
    if (st.isDirectory()) {
      result[path] = "directory";
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else result[path] = sha256File(path);
  };
  for (const path of paths) visit(path);
  return result;
}

/** Inventory full schema, row counts and every stored value with its SQL type and byte witness.
 * This reads original tables directly; it does not rely on finalize/absorb's equivalence rules. */
export function storedInventory(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  registerHistoryFunctions(db);
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = schema.filter(r => r.type === "table").map(r => String(r.name));
    const data = tables.map(table => {
      const columns = db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => String(r.name));
      const projection = columns.flatMap((c, i) => [`${q(c)} AS value_${i}`, `typeof(${q(c)}) AS type_${i}`, `hex(${q(c)}) AS bytes_${i}`]);
      const query = db.prepare(`SELECT ${projection.join(",")} FROM ${q(table)}`);
      query.setReadBigInts(true);
      return { table, rows: query.all() };
    });
    return JSON.stringify({ schema, data }, (_, value: unknown) =>
      typeof value === "bigint" ? { integer: value.toString() } :
        value instanceof Uint8Array ? { blob: Buffer.from(value).toString("hex") } : value);
  } finally { db.close(); }
}

/** Test setup only. Commands never checkpoint, convert, extract or repair an input.
 * Original proof/failure fixtures use cold physical stores; separate raw command
 * fixtures explicitly verify unavailable WAL/linked/sidecar input preservation. */
export function coldCommandInputs(home: string, handles: readonly DatabaseSync[] = []): void {
  for (const name of ["bridge.db", "history.db", "archive.db", "job-archive.db"]) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) continue;
    const sides = ["-wal", "-shm", "-journal"].map(s => path + s);
    if (sides.some(side => {
      try { const st = lstatSync(side); return !st.isFile() || st.isSymbolicLink() || st.nlink !== 1; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    })) continue;
    if (readFileSync(path)[18] === 1 && !sides.some(existsSync)) continue;
    const held = handles.find(db => {
      try {
        const file = String(db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file);
        return process.platform === "win32" ? file.toLowerCase() === path.toLowerCase() : file === path;
      } catch { return false; }
    });
    const db = held ?? new DatabaseSync(path);
    try { db.exec("PRAGMA journal_mode=DELETE"); } finally { if (!held) db.close(); }
  }
}
