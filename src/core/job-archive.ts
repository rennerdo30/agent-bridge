import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { archiveFile, isRecord, JSON_STORE_VERSION } from "./json-store.js";
import { cloneJson, fileSignature, readJsonSnapshot } from "./file-cache.js";
import { assertStoreUpgrade } from "./store-compatibility.js";
import { drainScan } from "./responsive-scan.js";

interface ArchivedJobSnapshot { signature: string; jobs: Record<string, unknown>[] }
const snapshots = new Map<string, ArchivedJobSnapshot>();
const EMPTY_SNAPSHOT: ArchivedJobSnapshot = { signature: "", jobs: [] };
function physicalDirectory(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("job archive directory must be physical; data kept unchanged");
}
function physicalFile(file: string): Stats {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("job archive file must be physical; data kept unchanged");
  return st;
}

/** Bind yielding reads to the original physical ancestors, not just final entries.
 * Directory content timestamps can change normally; creation identity cannot. */
function archiveDirectoryWitness(dir: string): () => void {
  const home = dirname(dir), canonicalHome = realpathSync.native(home), canonicalArchive = realpathSync.native(dir);
  if (canonicalArchive !== join(canonicalHome, "archive")) throw new Error("job archive escaped its home; data kept unchanged");
  const identity = (st: Stats) => `${st.dev}:${st.ino}:${st.birthtimeMs}`;
  const ancestors: { path: string; identity: string }[] = [];
  // Initial OS aliases are valid; bind physical identities along the resolved
  // chain and separately require the caller's aliases to keep resolving there.
  for (let at = canonicalArchive; ; at = dirname(at)) {
    const st = lstatSync(at);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("job archive ancestors must be physical; data kept unchanged");
    ancestors.push({ path: at, identity: identity(st) });
    if (dirname(at) === at) break;
  }
  return () => {
    for (const ancestor of ancestors) {
      const st = lstatSync(ancestor.path);
      if (!st.isDirectory() || st.isSymbolicLink() || identity(st) !== ancestor.identity)
        throw new Error("job archive ancestor changed during traversal; data kept unchanged");
    }
    if (realpathSync.native(home) !== canonicalHome || realpathSync.native(dir) !== canonicalArchive)
      throw new Error("job archive path changed during traversal; data kept unchanged");
  };
}

export function readArchivedJobs(path: string): Record<string, unknown>[] {
  return cloneJson(readArchivedJobSnapshot(path).jobs);
}

/** Validate file identities before reusing the projection; parse only a changed corpus. */
export function readArchivedJobSnapshot(path: string): ArchivedJobSnapshot {
  return drainScan(readArchivedJobSteps(path));
}

/** Shared immutable traversal; responsive readers yield between file/job steps. */
export function* readArchivedJobSteps(path: string, responsive = false): Generator<void, ArchivedJobSnapshot> {
  const dir = join(dirname(path), "archive");
  if (!existsSync(dir)) return EMPTY_SNAPSHOT;
  physicalDirectory(dir);
  const validateDirectory = responsive ? archiveDirectoryWitness(dir) : undefined;
  const files: { path: string; time: number; st: Stats }[] = [];
  const signatures: string[] = [];
  let bytes = 0;
  for (const file of readdirSync(dir).sort()) {
    yield;
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    validateDirectory?.();
    const full = join(dir, file), st = physicalFile(full);
    const stamp = /(?:^jobs-|\.overflow\.json-)(\d+)-/.exec(file)?.[1];
    signatures.push(`${file}:${fileSignature(st)}`); files.push({ path: full, time: stamp ? Number(stamp) : st.mtimeMs, st }); bytes += st.size;
  }
  const signature = signatures.join("\n"), saved = snapshots.get(path);
  if (saved?.signature === signature) {
    if (responsive) for (const file of files) { yield; validateDirectory!(); if (fileSignature(physicalFile(file.path)) !== fileSignature(file.st)) throw new Error("job archive changed during traversal"); }
    validateDirectory?.();
    return saved;
  }
  const jobs = new Map<string, Record<string, unknown>>();
  files.sort((a, b) => a.time - b.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path: file, st } of files) {
    yield;
    if (responsive) {
      validateDirectory!();
      if (fileSignature(physicalFile(file)) !== fileSignature(st)) throw new Error("job archive changed during traversal");
    }
    // A damaged archive must be reported, never silently forgotten or renamed by a read.
    const value = readJsonSnapshot(file, { file, stat: st }).value;
    if (!isRecord(value) || (value.version !== undefined && (!Number.isInteger(value.version) || (value.version as number) < 0 || (value.version as number) > JSON_STORE_VERSION)) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${basename(file)}`);
    for (const job of value.jobs) { yield; if (isRecord(job) && typeof job.id === "string") jobs.set(job.id, job); }
  }
  if (responsive) for (const file of files) { yield; validateDirectory!(); if (fileSignature(physicalFile(file.path)) !== fileSignature(file.st)) throw new Error("job archive changed during traversal"); }
  validateDirectory?.();
  const next = { signature, jobs: [...jobs.values()] };
  snapshots.delete(path);
  if (bytes <= 256 * 1024 * 1024) snapshots.set(path, next);
  if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value!);
  return next;
}

/** Full raw records, including unknown fields. Publish before replacing the active jobs store. */
export function archiveJobs(path: string, jobs: unknown[]): string {
  assertStoreUpgrade(dirname(path), "json", 0, JSON_STORE_VERSION);
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  physicalDirectory(dir);
  const retained = join(dir, "archive");
  mkdirSync(retained, { recursive: true, mode: 0o700 });
  physicalDirectory(retained);
  // Stable content identity makes concurrent/retried publication idempotent. Existing
  // files are never replaced, including archives produced by older releases.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const records = jobs.map(canonical).sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });
  const contents = JSON.stringify({ version: JSON_STORE_VERSION, jobs: records }, null, 2) + "\n";
  const digest = createHash("sha256").update(contents).digest("hex");
  const target = join(dir, `jobs-content-${digest}.json`);
  const temp = join(dir, `.jobs-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    // Atomic no-overwrite publication: readers can see only a complete fsynced file.
    // A killed writer leaves an excluded staging artifact, never a malformed archive.
    try { linkSync(temp, target); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      physicalFile(target);
      const existing = readJsonSnapshot(target).value;
      if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical({ version: JSON_STORE_VERSION, jobs: records }))) throw new Error("job archive identity conflict; active jobs retained");
    }
    if (process.platform !== "win32") {
      const directory = openSync(dir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    // Retain even staging bytes. This is a rename of the link, never a data unlink.
    archiveFile(temp);
  }
  return target;
}
