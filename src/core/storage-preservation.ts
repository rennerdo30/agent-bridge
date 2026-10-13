import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sidecarSuffixes = ["-wal", "-shm", "-journal"];
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = () => new Error("Storage archive path or identity is unsafe or unavailable; all originals are retained.");
function entry(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function regular(st: BigIntStats | undefined): asserts st is BigIntStats {
  if (!st?.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.ino <= 0n || st.dev < 0n) throw fail();
}
const identical = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

/** Physical ancestors are checked by identity, allowing drive aliases that resolve to the same directories. */
function ancestors(path: string): () => void {
  const witnessed: [string, BigIntStats][] = [];
  for (let at = dirname(resolve(path)); ; at = dirname(at)) {
    const st = entry(at);
    if (!st?.isDirectory() || st.isSymbolicLink() || st.ino <= 0n || st.dev < 0n) throw fail();
    witnessed.push([at, st]);
    if (dirname(at) === at) break;
  }
  return () => {
    for (const [at, before] of witnessed) {
      const now = entry(at);
      if (!now?.isDirectory() || now.isSymbolicLink() || !identical(before, now)) throw fail();
    }
  };
}

/** Call-scoped archive admission under the cooperating maintenance lease.
 * Node SQLite reopens a pathname, not this descriptor. Rechecks detect observed replacements;
 * they cannot fence an unbounded external actor replacing paths between checks and SQLite opens. */
export function preserveArchiveTarget(path: string, home: string): { path: string; created: boolean; check(): void; close(): void } {
  const checkParents = ancestors(path), canonicalHome = realpathSync.native(home);
  const canonicalPath = join(canonicalHome, "archive.db");
  if (!samePath(realpathSync.native(dirname(path)), canonicalHome) ||
      !samePath(resolve(path), join(resolve(home), "archive.db")) ||
      canonicalHome.split(/[\\/]/).some(part => [".migration-snapshots", "backups", "cold-storage", "archive"].includes(part.toLowerCase()))) throw fail();
  const before = entry(path);
  if (before) regular(before);
  const sidecars = new Map<string, BigIntStats>();
  const checkSidecars = () => {
    for (const suffix of sidecarSuffixes) {
      const side = canonicalPath + suffix, now = entry(side), prior = sidecars.get(side);
      if (!now) { if (prior) throw fail(); continue; }
      regular(now);
      if (!samePath(realpathSync.native(side), side) || (prior && !identical(prior, now))) throw fail();
      sidecars.set(side, now);
    }
  };
  checkParents(); checkSidecars();
  if (!before && sidecars.size) throw fail();
  if (before && !samePath(realpathSync.native(path), canonicalPath)) throw fail();
  const fd = openSync(canonicalPath, before ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const owned = fstatSync(fd, { bigint: true }); regular(owned);
    if (before && !identical(before, owned)) throw fail();
    const check = () => {
      checkParents();
      if (!samePath(realpathSync.native(home), canonicalHome)) throw fail();
      const now = entry(canonicalPath), held = fstatSync(fd, { bigint: true });
      regular(now); regular(held);
      if (!identical(owned, now) || !identical(owned, held) || !samePath(realpathSync.native(canonicalPath), canonicalPath)) throw fail();
      checkSidecars();
    };
    check();
    return { path: canonicalPath, created: !before, check, close: () => closeSync(fd) };
  } catch (error) { closeSync(fd); throw error; }
}

/** Never open retained WAL/sidecar/unknown candidates through SQLite: even a read-only connection can write SHM. */
export function candidateReadProblem(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const checkParents = ancestors(path), before = entry(path); regular(before);
    if (sidecarSuffixes.some(suffix => entry(path + suffix))) return "candidate has sidecars; retained without a SQLite open";
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const held = fstatSync(fd, { bigint: true }); regular(held);
    if (!identical(before, held)) throw fail();
    const header = Buffer.alloc(100), n = readSync(fd, header, 0, header.length, 0);
    checkParents();
    const after = entry(path); regular(after);
    if (!identical(held, after) || sidecarSuffixes.some(suffix => entry(path + suffix))) throw fail();
    if (n !== 100 || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) return "candidate header is unavailable; retained without a SQLite open";
    if (header[18] === 2 || header[19] === 2) return "candidate uses WAL; retained without a SQLite open";
    if (header[18] !== 1 || header[19] !== 1) return "candidate header is unsupported; retained without a SQLite open";
  } catch { return "candidate path or identity is unsafe or unavailable; retained without a SQLite open"; }
  finally { if (fd !== undefined) closeSync(fd); }
}
