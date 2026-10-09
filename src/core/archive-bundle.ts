import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { archiveFile } from "./json-store.js";

/** Lossless cold storage for archive copies: byte-exact originals, deduplicated by content, in one compressed file. */
export const BUNDLE_MANIFEST_VERSION = 1;
/** Legacy per-save job archives (`jobs-<ms>-<uuid>.json`); content-addressed archives are left in place. */
const LEGACY_JOB_COPY = /^jobs-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export interface BundleEntry { name: string; bytes: number; sha256: string; mtimeMs: number }
export interface BundleBlob { sha256: string; offset: number; bytes: number }
export interface BundleManifest {
  version: number;
  createdAt: number;
  bundle: string;
  bundleSha256: string;
  entries: BundleEntry[];
  blobs: BundleBlob[];
}

const sha256 = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");

export function legacyJobCopies(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => LEGACY_JOB_COPY.test(name) && lstatSync(join(dir, name)).isFile()).sort();
}

/** fsynced, never replaces an existing file. */
function publish(path: string, data: Buffer | string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  linkSync(temp, path);
  // Retain even staging bytes. This is a rename of the link, never a data unlink.
  archiveFile(temp);
}

/** Pack `names` from `dir` into `outDir`. Originals are untouched. Returns the manifest path. */
export function bundleFiles(dir: string, names: readonly string[], outDir: string, now = Date.now()): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const entries: BundleEntry[] = [];
  const blobs: BundleBlob[] = [];
  const chunks: Buffer[] = [];
  const known = new Set<string>();
  let offset = 0;
  for (const name of names) {
    if (basename(name) !== name) throw new Error(`bundle names must be plain file names: ${name}`);
    const path = join(dir, name);
    const before = lstatSync(path);
    if (!before.isFile()) throw new Error(`not a regular file: ${name}`);
    const data = readFileSync(path);
    const after = lstatSync(path);
    if (after.mtimeMs !== before.mtimeMs || after.size !== data.length) throw new Error(`file changed while bundling: ${name}`);
    const hash = sha256(data);
    entries.push({ name, bytes: data.length, sha256: hash, mtimeMs: before.mtimeMs });
    if (known.has(hash)) continue;
    known.add(hash);
    blobs.push({ sha256: hash, offset, bytes: data.length });
    chunks.push(data);
    offset += data.length;
  }
  const packed = brotliCompressSync(Buffer.concat(chunks), { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: offset } });
  const id = `bundle-${String(now).padStart(13, "0")}-${randomUUID()}`;
  const bundle = `${id}.br`;
  publish(join(outDir, bundle), packed);
  const manifest: BundleManifest = { version: BUNDLE_MANIFEST_VERSION, createdAt: now, bundle, bundleSha256: sha256(packed), entries, blobs };
  const manifestPath = join(outDir, `${id}.manifest.json`);
  publish(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  verifyBundle(manifestPath);
  return manifestPath;
}

export function readBundleManifest(manifestPath: string): BundleManifest {
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
  if (value.version !== BUNDLE_MANIFEST_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.blobs) || basename(value.bundle) !== value.bundle) {
    throw new Error(`unsupported bundle manifest: ${manifestPath}`);
  }
  return value;
}

/** Decompress the whole bundle and return every original's exact bytes, keyed by name. Throws on any mismatch. */
export function extractBundle(manifestPath: string): Map<string, Buffer> {
  const manifest = readBundleManifest(manifestPath);
  const packed = readFileSync(join(dirname(manifestPath), manifest.bundle));
  if (sha256(packed) !== manifest.bundleSha256) throw new Error(`bundle checksum mismatch: ${manifest.bundle}`);
  const raw = brotliDecompressSync(packed);
  const blobs = new Map<string, Buffer>();
  for (const blob of manifest.blobs) {
    const data = raw.subarray(blob.offset, blob.offset + blob.bytes);
    if (data.length !== blob.bytes || sha256(data) !== blob.sha256) throw new Error(`bundle blob mismatch: ${blob.sha256}`);
    blobs.set(blob.sha256, data);
  }
  const out = new Map<string, Buffer>();
  for (const entry of manifest.entries) {
    const data = blobs.get(entry.sha256);
    if (!data || data.length !== entry.bytes) throw new Error(`bundle entry missing: ${entry.name}`);
    out.set(entry.name, data);
  }
  return out;
}

export function verifyBundle(manifestPath: string): void { extractBundle(manifestPath); }

/**
 * Move bundled originals out of the scanned directory into `coldDir` after a fresh verification.
 * Nothing is deleted: a file whose bytes no longer match the manifest stays where it is and is reported.
 */
export function retireBundled(dir: string, manifestPath: string, coldDir: string): { moved: string[]; kept: string[] } {
  const contents = extractBundle(manifestPath);
  mkdirSync(coldDir, { recursive: true, mode: 0o700 });
  const moved: string[] = [], kept: string[] = [];
  for (const [name, bytes] of contents) {
    const source = join(dir, name), target = join(coldDir, name);
    if (!existsSync(source) || existsSync(target) || !readFileSync(source).equals(bytes)) { kept.push(name); continue; }
    renameSync(source, target);
    moved.push(name);
  }
  return { moved, kept };
}
