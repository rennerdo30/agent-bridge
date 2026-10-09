import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { archiveFile, isRecord } from "./json-store.js";
import { isProcessIdentityAlive, processIdentity, readProcessIdentity } from "./process-identity.js";

const VERSION = 2;
const RETRY_MS = 20;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKER = /^(?:owner|claim)-v1\.(\d+)\.([A-Za-z0-9_-]+)\.([a-f0-9-]{36})\.json$/;
const busy = () => Object.assign(new Error("metadata lease has a live or unknown owner"), { code: "ELEASEBUSY" });
const exitedIdentities = new Set<string>();
const identityProbes = new Set<string>();

/** Zero-wait broker operations must not run a synchronous foreign process query. */
function nonBlockingAlive(owner: Owner): boolean | undefined {
  if (owner.pid === process.pid) return isProcessIdentityAlive(owner.pid, owner.identity);
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  const key = `${owner.pid}:${owner.identity}`;
  if (exitedIdentities.has(key)) return false;
  if (!identityProbes.has(key)) {
    identityProbes.add(key);
    void readProcessIdentity(owner.pid).then(current => {
      // A verified different creation identity proves this specific old owner is
      // gone permanently. A cached live result is never used to authorize recovery.
      if (current !== null && current !== owner.identity) {
        if (exitedIdentities.size >= 512) exitedIdentities.delete(exitedIdentities.values().next().value!);
        exitedIdentities.add(key);
      }
    }).catch(() => {}).finally(() => identityProbes.delete(key));
  }
  return undefined;
}

function physicalDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
}

/** Check every existing ancestor before recursive mkdir can traverse an internal link. */
function physicalAncestors(path: string): void {
  let current = resolve(path);
  for (;;) {
    try { physicalDirectory(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function markerName(identity: string, claim = false): string {
  return `${claim ? "claim" : "owner"}-v1.${process.pid}.${Buffer.from(identity).toString("base64url")}.${randomUUID()}.json`;
}

function fileIdentity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
  // Darwin utimes may change birthtime on the same inode. The retained marker
  // hard link pins this inode; its immutable directory and nonce fence each
  // owner generation separately from mutable filesystem timestamps.
  return `${stat.dev}:${stat.ino}`;
}

interface Owner {
  dir: string;
  marker: string;
  pid: number;
  identity: string;
  file: string;
}

/** A canonical lock is a hard link to complete immutable metadata, never an opening empty file. */
function readOwner(path: string, registry: string): Owner | null {
  try {
    const file = fileIdentity(path);
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || value.version !== VERSION || typeof value.ownerDirectory !== "string" || !UUID.test(value.ownerDirectory)) return null;
    physicalDirectory(registry);
    const dir = join(registry, value.ownerDirectory);
    physicalDirectory(dir);
    const files = readdirSync(dir);
    if (files.length !== 1) return null;
    const marker = files[0]!;
    const match = MARKER.exec(marker);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !UUID.test(match[3]!)) return null;
    const identity = Buffer.from(match[2]!, "base64url").toString("utf8");
    if (!identity || Buffer.from(identity).toString("base64url") !== match[2]) return null;
    if (fileIdentity(join(dir, marker)) !== file || fileIdentity(path) !== file) return null;
    return { dir, marker, pid, identity, file };
  } catch { return null; }
}

/** Rename the exact immutable nonce to choose one claimant; a dead claimant is recoverable too. */
function archiveOwned(path: string, registry: string, owner: Owner, identity: string): void {
  const current = readOwner(path, registry);
  if (!current || current.file !== owner.file || current.marker !== owner.marker || current.dir !== owner.dir) throw busy();
  const claim = markerName(identity, true);
  renameSync(join(owner.dir, owner.marker), join(owner.dir, claim));
  // Until this canonical link is archived, every other acquisition is still excluded.
  if (fileIdentity(path) !== owner.file) throw busy();
  renameSync(path, join(owner.dir, `released-v2.${randomUUID()}.json`));
  archiveFile(owner.dir);
}

/**
 * Publish fully written metadata with an exclusive hard link, then archive on release/recovery.
 * Staging crashes cannot pin the canonical lock. Live, unverifiable and legacy owners are retained.
 * Hard-link support is required; unsupported filesystems fail closed without a weaker fallback.
 */
export function metadataFileLease(path: string, waitMs = 0, nonBlockingRecovery = false): () => void {
  const identity = processIdentity(process.pid);
  if (!identity) throw busy();
  const parent = dirname(path);
  physicalAncestors(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  physicalDirectory(parent);
  const namespace = join(parent, ".metadata-leases");
  mkdirSync(namespace, { recursive: true, mode: 0o700 });
  physicalDirectory(namespace);
  const registry = join(namespace, createHash("sha256").update(basename(path)).digest("hex"));
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  physicalDirectory(registry);
  // Keep high-frequency lock metadata out of the job/run snapshot archive directory.
  const archive = join(registry, "archive");
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  physicalDirectory(archive);
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let staged: Owner | undefined;
  try {
    for (;;) {
      let absent = false;
      try { lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw error; }
      if (absent) {
        if (!staged) {
          const ownerDirectory = randomUUID();
          const dir = join(registry, ownerDirectory);
          mkdirSync(dir, { mode: 0o700 });
          const marker = markerName(identity);
          const source = join(dir, marker);
          try {
            const fd = openSync(source, "wx", 0o600);
            try {
              writeFileSync(fd, `${JSON.stringify({ version: VERSION, pid: process.pid, identity, nonce: marker, ownerDirectory, createdAt: Date.now() })}\n`);
              fsyncSync(fd);
            } finally { closeSync(fd); }
            staged = { dir, marker, pid: process.pid, identity, file: fileIdentity(source) };
          } catch (error) { archiveFile(dir); throw error; }
        }
        try {
          linkSync(join(staged.dir, staged.marker), path);
          const acquired = staged;
          staged = undefined;
          let released = false;
          return () => {
            if (released) return;
            const owner = readOwner(path, registry);
            if (!owner || owner.file !== acquired.file || owner.dir !== acquired.dir || owner.marker !== acquired.marker) return;
            archiveOwned(path, registry, owner, identity);
            released = true;
          };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const owner = readOwner(path, registry);
      if (owner && (nonBlockingRecovery ? nonBlockingAlive(owner) : isProcessIdentityAlive(owner.pid, owner.identity)) === false) {
        try { archiveOwned(path, registry, owner, identity); continue; }
        catch { /* A winning claimant or an inaccessible archive is retained. */ }
      }
      if (Date.now() >= deadline) throw busy();
      Atomics.wait(pause, 0, 0, RETRY_MS);
    }
  } finally { if (staged) archiveFile(staged.dir); }
}
