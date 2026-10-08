import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { BACKUP_INTERVAL_ENV, BACKUP_RETENTION_ENV, DEFAULT_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_RETENTION } from "./backups.js";
import { retentionLimit } from "./json-store.js";
import { storageLease } from "./storage-lock.js";

export const MESSAGE_BACKUPS_DIR = "message-backups";
export const AUTO_BACKUP_ENV = "AGENT_BRIDGE_AUTO_BACKUP";
const TABLES = {
  "bridge.db": ["messages", "archived_messages", "job_delivery_routes"],
  "archive.db": ["messages"],
  "store-compatibility.db": ["job_delivery_routes"],
} as const;
const MAX_ROWS_PER_WINDOW = 64;
const MAX_BYTES_PER_WINDOW = 256 * 1024;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface MessageBackupManifest {
  version: 1;
  kind: "message-tables";
  createdAt: number;
  restore: "merge-selected-tables-only";
  excludes: ["conversation-history", "other-tables", "json-stores"];
  files: { path: string; source: string; sourceVersion: number; sha256: string; bytes: number;
    tables: { name: string; schema: string; rows: number; sha256: string }[] }[];
}
export interface MessageBackupControl { checkpoint: () => Promise<void> }
export interface MessageBackupResult { path: string | null; skipped?: "already-running" | "not-due" }

function syncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assertPhysical(path: string): void {
  for (let at = resolve(path);; at = dirname(at)) {
    try { if (lstatSync(at).isSymbolicLink()) throw new Error("Message backup refuses linked paths"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(at) === at) break;
  }
}

function rowDigest(row: Record<string, SQLInputValue>): Buffer {
  return Buffer.from(JSON.stringify(Object.entries(row).map(([key, value]) => [key,
    value instanceof Uint8Array ? ["blob", Buffer.from(value).toString("base64")] : [typeof value, String(value)]])) + "\n");
}

export function listMessageBackups(home: string): { path: string; createdAt: number }[] {
  const root = join(home, MESSAGE_BACKUPS_DIR);
  assertPhysical(root);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => name.startsWith("messages-")).flatMap(name => {
    const path = join(root, name);
    try {
      if (lstatSync(path).isSymbolicLink()) return [];
      const manifestPath = join(path, "manifest.json");
      if (lstatSync(manifestPath).isSymbolicLink()) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return manifest.version === 1 && manifest.kind === "message-tables" && Number.isFinite(manifest.createdAt) ? [{ path, createdAt: manifest.createdAt as number }] : [];
    } catch { return []; }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}

/** Logical, WAL-inclusive snapshots never scan unrelated legacy history pages.
 * A held SQLite transaction is an OS-backed single-flight lock, automatically
 * released on process death without trusting a reused PID or removing files.
 */
export async function messageBackupIfDue(home: string, control: MessageBackupControl, now = Date.now()): Promise<MessageBackupResult> {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval) return { path: null, skipped: "not-due" };
  await control.checkpoint();
  for (const path of [home, join(home, MESSAGE_BACKUPS_DIR), join(home, ".storage-users"), join(home, "message-backup-lock.db")]) assertPhysical(path);
  const release = storageLease(home);
  let lock: DatabaseSync | undefined;
  let staging: string | undefined;
  try {
    lock = new DatabaseSync(join(home, "message-backup-lock.db"), { timeout: 0 });
    if (Number(lock.prepare("PRAGMA user_version").get()!.user_version) > 1) throw new Error("Unsupported message backup coordination schema");
    try {
      lock.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS generation(id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL, started_at INTEGER NOT NULL); PRAGMA user_version=1;");
      lock.prepare("INSERT INTO generation VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,started_at=excluded.started_at").run(process.pid, randomUUID(), now);
    } catch (error) {
      if (/database is locked|database is busy/.test(String(error))) return { path: null, skipped: "already-running" };
      throw error;
    }
    if (now - (listMessageBackups(home)[0]?.createdAt ?? 0) < interval) return { path: null, skipped: "not-due" };
    const root = join(home, MESSAGE_BACKUPS_DIR), name = `messages-${String(now).padStart(13, "0")}-${randomUUID()}`;
    staging = join(root, `.pending-${name}`);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const manifest: MessageBackupManifest = { version: 1, kind: "message-tables", createdAt: now,
      restore: "merge-selected-tables-only", excludes: ["conversation-history", "other-tables", "json-stores"], files: [] };
    const checksum = async (path: string) => {
      const file = await open(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(MAX_BYTES_PER_WINDOW);
      let bytes = 0;
      try {
        for (;;) {
          await control.checkpoint();
          const chunk = await file.read(buffer, 0, buffer.length, bytes);
          if (!chunk.bytesRead) break;
          hash.update(buffer.subarray(0, chunk.bytesRead)); bytes += chunk.bytesRead;
        }
      } finally { await file.close(); }
      return { bytes, sha256: hash.digest("hex") };
    };
    // Primary precedes monotonic archives: an archive move cannot omit both copies.
    for (const [sourceName, names] of Object.entries(TABLES)) {
      const sourcePath = join(home, sourceName);
      if (!existsSync(sourcePath)) continue;
      assertPhysical(sourcePath);
      await control.checkpoint();
      const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 100 });
      const path = sourceName.replace(/\.db$/, ".messages.db"), targetPath = join(staging, path);
      let target: DatabaseSync | undefined;
      try {
        source.exec("BEGIN");
        const sourceVersion = Number(source.prepare("PRAGMA user_version").get()!.user_version);
        const schemas = names.flatMap(name => {
          const row = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
          return typeof row?.sql === "string" ? [{ name, schema: row.sql }] : [];
        });
        if (!schemas.length) continue;
        target = new DatabaseSync(targetPath, { timeout: 100 });
        target.exec("PRAGMA synchronous=FULL;");
        const tables: MessageBackupManifest["files"][number]["tables"] = [];
        for (const { name, schema } of schemas) {
          await control.checkpoint();
          // Deliberately omit history triggers, secondary indexes, and every other table.
          target.exec(schema);
          const columns = source.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().filter(column => column.hidden === 0).map(column => String(column.name));
          const selection = `SELECT rowid AS _ab_backup_rowid,${columns.map(quote).join(",")} FROM ${quote(name)} ORDER BY rowid`;
          const read = source.prepare(selection); read.setReadBigInts(true);
          const insert = target.prepare(`INSERT INTO ${quote(name)}(rowid,${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").concat("?").join(",")})`);
          const hash = createHash("sha256"); let rows = 0, windowRows = 0, windowBytes = 0;
          target.exec("BEGIN");
          for (const raw of read.iterate()) {
            const row = raw as Record<string, SQLInputValue>, bytes = rowDigest(row);
            insert.run(row._ab_backup_rowid!, ...columns.map(column => row[column]!));
            hash.update(bytes); rows++; windowRows++; windowBytes += bytes.length;
            if (windowRows >= MAX_ROWS_PER_WINDOW || windowBytes >= MAX_BYTES_PER_WINDOW) {
              target.exec("COMMIT"); await control.checkpoint(); target.exec("BEGIN"); windowRows = 0; windowBytes = 0;
            }
          }
          target.exec("COMMIT");
          const expected = hash.digest("hex"), verification = createHash("sha256"); let verifiedRows = 0;
          const reread = target.prepare(selection); reread.setReadBigInts(true);
          windowRows = 0; windowBytes = 0;
          for (const raw of reread.iterate()) {
            const bytes = rowDigest(raw as Record<string, SQLInputValue>); verification.update(bytes); verifiedRows++; windowRows++; windowBytes += bytes.length;
            if (windowRows >= MAX_ROWS_PER_WINDOW || windowBytes >= MAX_BYTES_PER_WINDOW) { await control.checkpoint(); windowRows = 0; windowBytes = 0; }
          }
          await control.checkpoint();
          if (rows !== verifiedRows || expected !== verification.digest("hex") || target.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)!.sql !== schema) throw new Error(`Message backup table verification failed: ${sourceName}/${name}`);
          tables.push({ name, schema, rows, sha256: expected });
        }
        source.exec("ROLLBACK"); target.close(); target = undefined;
        await control.checkpoint(); syncFile(targetPath);
        const copied = await checksum(targetPath), verified = await checksum(targetPath);
        if (copied.bytes !== verified.bytes || copied.sha256 !== verified.sha256) throw new Error(`Message backup checksum verification failed: ${sourceName}`);
        manifest.files.push({ path, source: sourceName, sourceVersion, ...verified, tables });
      } finally { try { target?.close(); } finally { source.close(); } }
    }
    await control.checkpoint();
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    syncFile(join(staging, "manifest.json"));
    const published = join(root, name); renameSync(staging, published);
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const previous of listMessageBackups(home).slice(retention)) {
      await control.checkpoint();
      const archive = join(root, "archive"); assertPhysical(archive); mkdirSync(archive, { recursive: true, mode: 0o700 });
      renameSync(previous.path, join(archive, previous.path.split(/[\\/]/).at(-1)!));
    }
    lock.exec("COMMIT");
    return { path: published };
  } catch (error) {
    if (staging && existsSync(staging)) writeFileSync(join(staging, "failure.json"), JSON.stringify({ version: 1, at: Date.now(), error: String(error) }) + "\n", { flag: "wx", mode: 0o600 });
    throw error;
  } finally { try { lock?.close(); } finally { release(); } }
}
