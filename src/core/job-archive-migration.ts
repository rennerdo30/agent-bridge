import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { bundleFilesBounded, extractBundle, retireBundled } from "./archive-bundle.js";
import { JSON_STORE_VERSION } from "./json-store.js";
import { archivedRecordId, jobArchivePath, jobDigest, markJobProjection, openJobArchive, physicalArchivePath, putJobRecords } from "./job-archive-index.js";
import { migrationLock } from "./migration-lock.js";
import { estimatedJsonBytes, fileSignature } from "./file-cache.js";
import { assertStoreUpgrade, refreshStorePeerIdentities } from "./store-compatibility.js";
import { setTimeout as yieldWriter } from "node:timers/promises";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const acceptArchive = (name: string) => /^jobs-.*\.json$/.test(name) || /^jobs\.json(?:-|\.(?:overflow\.json|backup)-)/.test(name);
function records(raw: Buffer, file: string): unknown[] {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (isRecord(value) && value.version !== undefined && (!Number.isInteger(value.version) || Number(value.version) < 0 || Number(value.version) > JSON_STORE_VERSION))
    throw new Error(`unsupported job archive: ${basename(file)}; originals retained`);
  const jobs = Array.isArray(value) ? value : isRecord(value) ? value.jobs : undefined;
  if (!Array.isArray(jobs)) throw new Error(`invalid job archive: ${basename(file)}; originals retained`);
  return jobs;
}

export interface ArchiveMigrationResult { imported: number; moved: number; kept: number; deferred: boolean; manifests: string[] }
/** Only the elected broker worker calls this scanner. Readers never discover files. */
export async function migrateJobArchives(path: string): Promise<ArchiveMigrationResult> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  physicalArchivePath(path);
  const release = migrationLock(`${jobArchivePath(path)}.legacy`);
  let close = () => {};
  const result: ArchiveMigrationResult = { imported: 0, moved: 0, kept: 0, deferred: false, manifests: [] };
  try {
    const db = openJobArchive(path, true)!;
    close = () => db.close();
    const state = db.prepare("SELECT state FROM archive_migrations WHERE version=1").get();
    if (state?.state === "complete") return result;
    const groups: { dir: string; names: string[] }[] = [];
    for (const dir of [join(dirname(path), "archive"), dirname(path)]) {
      if (!existsSync(dir)) continue;
      physicalArchivePath(dir);
      const names = readdirSync(dir).filter(name => dir === dirname(path)
        ? /^jobs\.json\.backup-/.test(name) || name === "jobs.json.overflow.json"
        : acceptArchive(name));
      names.sort((a, b) => {
        const time = (n: string) => Number(/(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(n)?.[1] ?? lstatSync(join(dir, n)).mtimeMs);
        return time(a) - time(b) || a.localeCompare(b);
      });
      groups.push({ dir, names });
    }
    // Raw originals are the backup during import. No movement can happen until
    // every distinct record is committed and verified against those exact bytes.
    const imported = new Map<string, unknown[]>();
    const verified = new Set<string>();
    let parsedBytes = 0;
    const importSource = (file: string, raw: Buffer) => {
      const digest = jobDigest(raw);
      if (db.prepare("SELECT 1 FROM archive_sources WHERE path=? AND sha256=?").get(file, digest)) return;
      let jobs = imported.get(digest);
      if (!jobs) {
        jobs = records(raw, file);
        const cost = estimatedJsonBytes(jobs, 16 * 1024 * 1024);
        if (cost + parsedBytes <= 16 * 1024 * 1024) { imported.set(digest, jobs); parsedBytes += cost; }
      }
      const ownTransaction = !db.isTransaction;
      if (ownTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        {
          const stamp = /(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(basename(file))?.[1];
          putJobRecords(db, jobs, stamp ? Number(stamp) : lstatSync(file).mtimeMs, false, true);
          // Verify stored serialized bytes, including unknown fields and all versions.
          const query = db.prepare("SELECT payload FROM job_versions WHERE id=? AND sha256=?");
          for (const job of verified.has(digest) ? [] : jobs) if (isRecord(job) && archivedRecordId(job) !== undefined) {
            const json = JSON.stringify(job), row = query.get(archivedRecordId(job)!, jobDigest(json));
            if (!row || row.payload !== json) throw new Error("job archive import verification failed; originals retained");
          }
          verified.add(digest);
        }
        db.prepare("INSERT INTO archive_sources(path,sha256,imported_at) VALUES(?,?,?)").run(file, digest, Date.now());
        if (ownTransaction) db.exec("COMMIT"); result.imported++;
      } catch (error) { if (ownTransaction && db.isTransaction) db.exec("ROLLBACK"); throw error; }
    };
    for (const group of groups) for (let offset = 0; offset < group.names.length; offset += 32) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const name of group.names.slice(offset, offset + 32)) {
          const file = join(group.dir, name); physicalArchivePath(file);
          const st = lstatSync(file); if (!st.isFile()) throw new Error("job archive entry must be a physical file");
          importSource(file, readFileSync(file));
        }
        db.exec("COMMIT");
        // Give live writers a real scheduling window between bounded batches.
        // Without it a fast importer can reacquire SQLite before every waiter.
        await yieldWriter(5);
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    }
    if (existsSync(path)) {
      physicalArchivePath(path);
      const before = lstatSync(path), jobs = records(readFileSync(path), path);
      if (fileSignature(lstatSync(path)) !== fileSignature(before)) throw new Error("active jobs changed during archive import; retry later");
      db.exec("BEGIN IMMEDIATE");
      try { putJobRecords(db, jobs, before.mtimeMs); db.exec("COMMIT"); }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
      markJobProjection(path, jobs, fileSignature(before));
    }
    db.prepare("INSERT INTO archive_migrations(version,state) VALUES(1,'imported') ON CONFLICT(version) DO UPDATE SET state='imported'").run();
    await refreshStorePeerIdentities(dirname(path));
    try { assertStoreUpgrade(dirname(path), "jobArchive", 0, 1); }
    catch (error) { if ((error as { code?: string }).code !== "STORE_UPGRADE_DEFERRED") throw error; result.deferred = true; return result; }
    const cold = join(dirname(path), "cold-storage", "jobs-v1");
    physicalArchivePath(cold); mkdirSync(cold, { recursive: true, mode: 0o700 });
    physicalArchivePath(join(cold, "archive"));
    for (const group of groups) {
      if (!group.names.length) continue;
      // Bounded bundles: memory for bundling and verification stays below MAX_BUNDLE_BYTES per step.
      for (const manifest of bundleFilesBounded(group.dir, group.names, cold)) {
        result.manifests.push(manifest);
        // A file may change between import and bundling. Import and verify the
        // bundled version too; retireBundled rechecks once more before any rename.
        for (const [name, raw] of extractBundle(manifest)) importSource(join(group.dir, name), raw);
        const originals = join(cold, group.dir === dirname(path) ? "root-originals" : "archive-originals");
        physicalArchivePath(originals);
        const moved = retireBundled(group.dir, manifest, originals);
        result.moved += moved.moved.length; result.kept += moved.kept.length;
      }
    }
    if (!result.kept) db.prepare("UPDATE archive_migrations SET state='complete' WHERE version=1").run();
    return result;
  } finally { try { close(); } finally { release(); } }
}
