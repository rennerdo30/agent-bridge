import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DB_FILE_NAME } from "./constants.js";
import { isRecord, retentionLimit } from "./json-store.js";
import { ARCHIVE_DB_NAME, snapshotDatabase } from "./sqlite-maintenance.js";
import { maintenanceLock, storageLease } from "./storage-lock.js";
import { closeMetadataDb } from "./metadata-db.js";
import * as sqlite from "node:sqlite";
import { open } from "node:fs/promises";
import { assertUnboundFullRestore, bootstrapHomeIdentity, captureBootstrapPreservation, sameBootstrapIdentity, syncBootstrapDirectory, syncBootstrapHomeChain, verifyBootstrapPreservationCopy, type BootstrapPreservation } from "./store-bootstrap-journal.js";

export const BACKUPS_DIR_NAME = "backups";
export const BACKUP_MANIFEST_VERSION = 1;
export const DEFAULT_BACKUP_RETENTION = 7;
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const BACKUP_RETENTION_ENV = "AGENT_BRIDGE_BACKUP_RETENTION";
export const BACKUP_INTERVAL_ENV = "AGENT_BRIDGE_BACKUP_INTERVAL_MS";
const MANIFEST_NAME = "manifest.json";
const PUBLICATION_NAME = "publication.json";
const BACKUP_PREFIX = "snapshot-";
const USER_DATABASES = [DB_FILE_NAME, ARCHIVE_DB_NAME, "history.db", "store-compatibility.db", "owner-questions.db"] as const;

export interface BackupManifest {
  version: number;
  createdAt: number;
  files: { path: string; sha256: string; bytes: number }[];
  /** Preservation only; original inode-bound authority is never reconstructed. */
  bootstrap?: BootstrapPreservation;
}

function digest(path: string): string {
  const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.allocUnsafe(256 * 1024);
  try { for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, bytes)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

function syncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** All primary mailboxes precede their monotonic shared archive. Discovery is
 * captured once under the storage lease and checked again before publication. */
function databaseOrder(group: BootstrapPreservation): string[] {
  const primaries = group.mailboxes.map(mailbox => mailbox.path);
  return [...primaries, ...group.databases.filter(name => !primaries.includes(name) && name !== ARCHIVE_DB_NAME), ...group.databases.filter(name => name === ARCHIVE_DB_NAME)];
}
function syncBackupTree(path: string, check: () => void): void {
  check();
  for (const name of readdirSync(path)) {
    check(); const child = join(path, name), st = lstatSync(child);
    if (st.isSymbolicLink()) throw new Error("Unsafe backup publication entry");
    if (st.isDirectory()) syncBackupTree(child, check);
  }
  check(); syncBootstrapDirectory(path); check();
}
function publishBackup(home: string, root: string, staging: string, name: string, manifest: BackupManifest, check = () => {}): string {
  const published = join(root, name);
  try {
    check(); writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    check(); syncFile(join(staging, MANIFEST_NAME)); check(); syncBackupTree(staging, check);
    // Publish the staging entry and any newly created backups parent before
    // renaming, then make the final entry durable before success or rotation.
    syncBootstrapDirectory(root); check(); syncBootstrapDirectory(home); check();
    renameSync(staging, published); check(); syncBootstrapDirectory(root); check();
    // This marker is created only AFTER the full proof group and final parent
    // entry are durable. A missing marker is never upgraded from cached state.
    writeFileSync(join(published, PUBLICATION_NAME), JSON.stringify({ version: 1, manifest: digest(join(published, MANIFEST_NAME)) }) + "\n", { flag: "wx", mode: 0o600 });
    check(); syncFile(join(published, PUBLICATION_NAME)); check(); syncBootstrapDirectory(published); check();
    return published;
  } catch (error) {
    const retained = existsSync(staging) ? staging : existsSync(published) ? published : undefined;
    // Keep every original snapshot/proof. The marker also prevents this process
    // from offering an uncertain completed rename as a verified backup.
    if (retained) { try { writeFileSync(join(retained, "failure.json"), '{"version":1,"stage":"directory-publication","unsettled":true}\n', { flag: "wx", mode: 0o600 }); } catch { /* Original failure remains authoritative. */ } }
    throw error;
  }
}

/** Enumerate data only, never credentials, sockets or symlink targets. Active jobs precede archives. */
export function jsonStoreFiles(home: string): string[] {
  if (!existsSync(home)) return [];
  const files: string[] = [];
  const visit = (dir: string, recurse: boolean) => {
    if (!existsSync(dir)) return;
    const root = lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && recurse) visit(path, true);
      else if (st.isFile() && name !== "dashboard.json" && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(name)) files.push(path);
    }
  };
  visit(home, false);
  for (const dir of ["jobs", "runs", "archive", "read-state", "job-outcomes", "local-result-receipts", ".store-bootstrap"]) visit(join(home, dir), true);
  return files;
}

export function listBackups(home: string): { path: string; createdAt: number }[] {
  const dir = join(home, BACKUPS_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(BACKUP_PREFIX)).flatMap((f) => {
    const path = join(dir, f);
    try {
      if (existsSync(join(path, "failure.json"))) return [];
      const manifest = JSON.parse(readFileSync(join(path, MANIFEST_NAME), "utf8")) as BackupManifest;
      if (manifest.bootstrap && !existsSync(join(path, PUBLICATION_NAME))) return [];
      return [{ path, createdAt: manifest.createdAt }];
    } catch { return []; }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}

/** Each SQLite file is a consistent snapshot; each JSON file is captured as an atomic byte sequence.
 * Active data is captured before monotonic archives, so an archive move cannot lose the only copy.
 */
export function createBackup(home: string, now = Date.now(), rotate = true): string {
  const release = storageLease(home);
  try { return createBackupUnlocked(home, now, rotate); } finally { release(); }
}

function createBackupUnlocked(home: string, now: number, rotate: boolean): string {
  const bootstrap = captureBootstrapPreservation(home);
  syncBootstrapHomeChain(home, () => {});
  const root = join(home, BACKUPS_DIR_NAME);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = `${BACKUP_PREFIX}${String(now).padStart(13, "0")}-${randomUUID()}`;
  const staging = join(root, `.pending-${name}`);
  mkdirSync(staging, { mode: 0o700 });
  const manifest: BackupManifest = { version: BACKUP_MANIFEST_VERSION, createdAt: now, files: [], bootstrap };
  const capture = (source: string, sqlite: boolean) => {
    const path = relative(home, source).split(sep).join("/");
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (sqlite) snapshotDatabase(source, target);
    else copyFileSync(source, target);
    syncFile(target);
    manifest.files.push({ path, sha256: digest(target), bytes: statSync(target).size });
  };
  // The archive only grows. Capture it after the primary, even while the broker is archiving.
  for (const name of databaseOrder(bootstrap)) capture(join(home, name), true);
  for (const file of jsonStoreFiles(home)) capture(file, false);
  verifyBootstrapPreservationCopy(staging, bootstrap);
  if (!sameBootstrapIdentity(captureBootstrapPreservation(home), bootstrap)) throw new Error("Backup source provenance changed; unpublished snapshot retained");
  const published = publishBackup(home, root, staging, name, manifest);
  if (rotate) {
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const backup of listBackups(home).slice(retention)) {
      const cold = join(root, "archive");
      mkdirSync(cold, { recursive: true, mode: 0o700 });
      renameSync(backup.path, join(cold, backup.path.split(/[\\/]/).at(-1)!));
      syncBootstrapDirectory(cold); syncBootstrapDirectory(root);
    }
  }
  return published;
}

export function backupIfDue(home: string, now = Date.now()): string | null {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval || now - (listBackups(home)[0]?.createdAt ?? 0) < interval) return null;
  return createBackup(home, now);
}

export interface BackgroundBackupControl {
  /** Runs in the backup worker, yielding/throttling and observing shared broker pressure. */
  checkpoint: () => void;
}

/** Incremental full snapshots for explicit/offline callers; automatic daily backups use message-backups.ts. */
export async function backupIfDueBackground(home: string, control: BackgroundBackupControl, now = Date.now()): Promise<string | null> {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval || now - (listBackups(home)[0]?.createdAt ?? 0) < interval) return null;
  control.checkpoint();
  if (typeof sqlite.backup !== "function") throw new Error("Automatic backup deferred: incremental SQLite backup requires a newer Node runtime; existing data is untouched");
  const release = storageLease(home);
  let bootstrap: BootstrapPreservation;
  try { bootstrap = captureBootstrapPreservation(home); syncBootstrapHomeChain(home, control.checkpoint); } catch (error) { release(); throw error; }
  const root = join(home, BACKUPS_DIR_NAME);
  const name = `${BACKUP_PREFIX}${String(now).padStart(13, "0")}-${randomUUID()}`;
  const staging = join(root, `.pending-${name}`);
  const manifest: BackupManifest = { version: BACKUP_MANIFEST_VERSION, createdAt: now, files: [], bootstrap };
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const checksum = async (file: string) => {
      const handle = await open(file, "r");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let bytes = 0;
      try {
        for (;;) {
          control.checkpoint();
          const read = await handle.read(buffer, 0, buffer.length, bytes);
          if (!read.bytesRead) break;
          hash.update(buffer.subarray(0, read.bytesRead)); bytes += read.bytesRead;
        }
      } finally { await handle.close(); }
      return { bytes, sha256: hash.digest("hex") };
    };
    const capture = async (source: string, database: boolean) => {
      control.checkpoint();
      const path = relative(home, source).split(sep).join("/");
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (database) {
        const db = new sqlite.DatabaseSync(source, { readOnly: true, timeout: 100 });
        try {
          // Pin a WAL-inclusive source view; sustained pressure aborts and releases it.
          db.exec("BEGIN"); db.prepare("PRAGMA schema_version").get();
          const version = db.prepare("PRAGMA user_version").get()!.user_version;
          await sqlite.backup(db, target, { rate: 32, progress: () => control.checkpoint() });
          db.exec("ROLLBACK");
          const copied = new sqlite.DatabaseSync(target, { readOnly: true, timeout: 100 });
          try {
            if (copied.prepare("PRAGMA user_version").get()!.user_version !== version) throw new Error(`Backup version verification failed: ${path}`);
            copied.prepare("SELECT count(*) FROM sqlite_master").get();
          } finally { copied.close(); }
        } finally { db.close(); }
      } else {
        const sourceHandle = await open(source, "r");
        let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          targetHandle = await open(target, "wx", 0o600);
          const length = (await sourceHandle.stat()).size;
          const buffer = Buffer.allocUnsafe(256 * 1024);
          for (let at = 0; at < length;) {
            control.checkpoint();
            const chunk = await sourceHandle.read(buffer, 0, Math.min(buffer.length, length - at), at);
            if (!chunk.bytesRead) throw new Error(`Backup source shortened during capture: ${path}`);
            for (let written = 0; written < chunk.bytesRead;) {
              const result = await targetHandle.write(buffer, written, chunk.bytesRead - written, at + written);
              if (!result.bytesWritten) throw new Error(`Backup write made no progress: ${path}`);
              written += result.bytesWritten;
            }
            at += chunk.bytesRead;
          }
          await targetHandle.sync();
        } finally { await sourceHandle.close(); await targetHandle?.close(); }
      }
      control.checkpoint(); syncFile(target);
      const first = await checksum(target);
      const verified = await checksum(target);
      if (first.bytes !== verified.bytes || first.sha256 !== verified.sha256) throw new Error(`Backup checksum verification failed: ${path}`);
      manifest.files.push({ path, ...verified });
    };
    // Source files are immutable snapshots before checksums; archives follow primary capture.
    for (const name of databaseOrder(bootstrap)) await capture(join(home, name), true);
    for (const file of jsonStoreFiles(home)) await capture(file, false);
    control.checkpoint();
    verifyBootstrapPreservationCopy(staging, bootstrap);
    if (!sameBootstrapIdentity(captureBootstrapPreservation(home), bootstrap)) throw new Error("Backup source provenance changed; unpublished snapshot retained");
    control.checkpoint();
    const published = publishBackup(home, root, staging, name, manifest, control.checkpoint);
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const previous of listBackups(home).slice(retention)) {
      control.checkpoint();
      const cold = join(root, "archive"); mkdirSync(cold, { recursive: true, mode: 0o700 });
      renameSync(previous.path, join(cold, previous.path.split(/[\\/]/).at(-1)!));
      control.checkpoint(); syncBootstrapDirectory(cold); control.checkpoint(); syncBootstrapDirectory(root);
    }
    return published;
  } catch (error) {
    if (existsSync(staging) && !existsSync(join(staging, "failure.json"))) writeFileSync(join(staging, "failure.json"), JSON.stringify({ version: 1, at: Date.now(), stage: "capture", unsettled: true }) + "\n", { flag: "wx", mode: 0o600 });
    throw error;
  } finally { release(); }
}

function allowedPath(path: string, bootstrap?: BootstrapPreservation): boolean {
  return USER_DATABASES.some(name => path === name) ||
    (/^[\w.-]+\.db$/.test(path) && !!bootstrap?.databases.includes(path)) ||
    /^\.store-bootstrap\/[a-f0-9-]{36}\.(preparing|prepared|exited)\.json$/.test(path) ||
    (/^[\w.-]+\.json$/.test(path) && !["dashboard.json"].includes(path)) ||
    /^(jobs|runs|archive|read-state|job-outcomes|local-result-receipts)\/[\w./-]+$/.test(path) && !path.split("/").some((s) => s === ".." || s === ".") &&
      /\.jsonl?(?:-\d+-[\w-]+)?$/.test(path);
}

/** Preserve damaged databases as raw bytes and sidecars. Recovery sets are never rotated. */
function createRecovery(home: string): string {
  const root = join(home, BACKUPS_DIR_NAME, `recovery-${Date.now()}-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = jsonStoreFiles(home);
  for (const name of USER_DATABASES) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = join(home, name + suffix);
    if (existsSync(file)) files.push(file);
  }
  for (const source of files) {
    const target = join(root, relative(home, source));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    syncFile(target);
  }
  return root;
}

export function readBackup(path: string): BackupManifest {
  if (existsSync(join(path, "failure.json"))) throw new Error("Unsettled backup publication; original snapshot retained");
  const manifestBytes = readFileSync(join(path, MANIFEST_NAME)), manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  const value: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!isRecord(value) || value.kind !== undefined && value.kind !== "full" || value.version !== BACKUP_MANIFEST_VERSION || !Number.isFinite(value.createdAt) || !Array.isArray(value.files)) throw new Error("unsupported full backup manifest; scoped message snapshots require a table merge");
  const seen = new Set<string>();
  const bootstrap = value.bootstrap as BootstrapPreservation | undefined;
  if (bootstrap && (!isRecord(bootstrap.metadata) || !Array.isArray(bootstrap.databases) || bootstrap.databases.length > 64 ||
    !Array.isArray(bootstrap.mailboxes) || bootstrap.mailboxes.length > 64 || !bootstrap.mailboxes.every(mailbox => isRecord(mailbox) && typeof mailbox.path === "string" && typeof mailbox.namespace === "string") || !isRecord(bootstrap.sources) ||
    !bootstrap.databases.every(name => typeof name === "string" && /^[\w.-]+\.db$/.test(name)) || !Array.isArray(bootstrap.evidence) || bootstrap.evidence.length > 49 ||
    !bootstrap.evidence.every(file => isRecord(file) && typeof file.path === "string" && typeof file.digest === "string" && /^[a-f0-9]{64}$/.test(file.digest) &&
      (file.path === ".store-bootstrap.expected.json" || /^\.store-bootstrap\/[a-f0-9-]{36}\.(preparing|prepared|exited)\.json$/.test(file.path))))) throw new Error("invalid backup preservation evidence");
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !allowedPath(file.path, bootstrap) || seen.has(file.path)) throw new Error("unsafe or duplicate backup path");
    seen.add(file.path);
    const source = resolve(path, file.path);
    if (!source.startsWith(resolve(path) + sep) || lstatSync(source).isSymbolicLink() || digest(source) !== file.sha256) throw new Error(`backup checksum mismatch: ${file.path}`);
    for (let dir = dirname(source); dir !== resolve(path); dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error("unsafe backup directory");
    }
  }
  if (bootstrap) {
    const marker = join(path, PUBLICATION_NAME), state = lstatSync(marker);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 256) throw new Error("Unproven backup publication");
    const publication: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (!isRecord(publication) || publication.version !== 1 || publication.manifest !== manifestDigest) throw new Error("Unproven backup publication");
    const checksummedDatabases = [...seen].filter(name => name.endsWith(".db")).sort();
    if (!sameBootstrapIdentity(checksummedDatabases, bootstrap.databases.slice().sort())) throw new Error("Incomplete full backup database group");
    for (const file of bootstrap.evidence) if (!seen.has(file.path)) throw new Error("incomplete backup preservation evidence");
    verifyBootstrapPreservationCopy(path, bootstrap);
  } else {
    // A legacy checksum-only manifest cannot certify a current bound snapshot.
    assertUnboundFullRestore(path);
  }
  if (digest(join(path, MANIFEST_NAME)) !== manifestDigest) throw new Error("Backup manifest changed during verification");
  return value as unknown as BackupManifest;
}

/** Confirmation is checked in core too. Every displaced byte remains in the recovery directory. */
export function restoreBackup(home: string, backup: string, confirmed: boolean): string {
  if (!confirmed) throw new Error("restore requires confirmation");
  const manifest = readBackup(backup);
  // BEFORE the maintenance lease, metadata close, recovery mkdir or rename.
  // Confirmation cannot convert preserved proof into a new restore generation.
  assertUnboundFullRestore(home); assertUnboundFullRestore(backup);
  const expectedDestination = restoreBoundary(home), expectedSource = restoreBoundary(backup);
  const unlock = maintenanceLock(home);
  try {
    // The earlier cheap refusal is not an authority grant across lock admission.
    assertUnboundFullRestore(home); assertUnboundFullRestore(backup);
    if (!sameBootstrapIdentity(expectedDestination, restoreBoundary(home)) || !sameBootstrapIdentity(expectedSource, restoreBoundary(backup)) ||
        !sameBootstrapIdentity(manifest, readBackup(backup))) throw new Error("Restore authority changed before exclusion; no files were displaced");
    closeMetadataDb(home);
    const recovery = createRecovery(home);
    const displaced = join(recovery, "displaced");
    mkdirSync(displaced, { mode: 0o700 });
    const restored: string[] = [];
    const moved: { source: string; target: string }[] = [];
    try {
      for (const file of manifest.files) {
        const target = resolve(home, file.path);
        // Reject symlinked ancestors, including links installed after manifest validation.
        for (let dir = dirname(target); dir !== resolve(home); dir = dirname(dir)) {
          if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("unsafe restore directory");
        }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const paths = target.endsWith(".db") ? [target, `${target}-wal`, `${target}-shm`, `${target}-journal`] : [target];
        for (const source of paths) if (existsSync(source)) {
          const preserved = join(displaced, relative(home, source));
          mkdirSync(dirname(preserved), { recursive: true, mode: 0o700 });
          renameSync(source, preserved);
          moved.push({ source, target: preserved });
        }
        const tmp = `${target}.${randomUUID()}.restore`;
        copyFileSync(join(backup, file.path), tmp);
        syncFile(tmp);
        if (digest(tmp) !== file.sha256) throw new Error("backup changed during restore");
        renameSync(tmp, target);
        restored.push(target);
      }
    } catch (err) {
      // Preserve partially restored data too, then return every original file to its place.
      for (const target of restored) renameSync(target, `${target}.failed-restore-${randomUUID()}`);
      for (const entry of moved.reverse()) renameSync(entry.target, entry.source);
      throw err;
    }
    return recovery;
  } finally { unlock(); }
}

function restoreBoundary(home: string): unknown {
  const files = [...new Set([...jsonStoreFiles(home), ...readdirSync(home).filter(name => /^[\w.-]+\.db(?:-wal|-shm|-journal)?$/.test(name)).map(name => join(home, name))])].sort();
  if (files.length > 4096) throw new Error("Restore evidence exceeds the bounded admission inventory");
  return { home: bootstrapHomeIdentity(home), files: files.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("Unproven restore file identity");
    return { path: relative(home, path), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs) };
  }) };
}
