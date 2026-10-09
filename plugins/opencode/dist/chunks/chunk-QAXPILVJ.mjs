import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  archiveFile
} from "./chunk-NWPQJULH.mjs";

// src/core/archive-bundle.ts
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
var BUNDLE_MANIFEST_VERSION = 1;
var sha256 = (data) => createHash("sha256").update(data).digest("hex");
function publish(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 384);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(temp, path);
  archiveFile(temp);
}
function bundleFiles(dir, names, outDir, now = Date.now()) {
  mkdirSync(outDir, { recursive: true, mode: 448 });
  const entries = [];
  const blobs = [];
  const chunks = [];
  const known = /* @__PURE__ */ new Set();
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
  const packed = brotliCompressSync(Buffer.concat(chunks), { params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_SIZE_HINT]: offset } });
  const id = `bundle-${String(now).padStart(13, "0")}-${randomUUID()}`;
  const bundle = `${id}.br`;
  publish(join(outDir, bundle), packed);
  const manifest = { version: BUNDLE_MANIFEST_VERSION, createdAt: now, bundle, bundleSha256: sha256(packed), entries, blobs };
  const manifestPath = join(outDir, `${id}.manifest.json`);
  publish(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  verifyBundle(manifestPath);
  return manifestPath;
}
var MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
function bundleFilesBounded(dir, names, outDir, now = Date.now(), maxBytes = MAX_BUNDLE_BYTES) {
  const manifests = [];
  let batch = [], bytes = 0;
  for (const name of names) {
    if (basename(name) !== name) throw new Error(`bundle names must be plain file names: ${name}`);
    const size = lstatSync(join(dir, name)).size;
    if (batch.length && bytes + size > maxBytes) {
      manifests.push(bundleFiles(dir, batch, outDir, now));
      batch = [];
      bytes = 0;
    }
    batch.push(name);
    bytes += size;
  }
  if (batch.length) manifests.push(bundleFiles(dir, batch, outDir, now));
  return manifests;
}
function readBundleManifest(manifestPath) {
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (value.version !== BUNDLE_MANIFEST_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.blobs) || basename(value.bundle) !== value.bundle) {
    throw new Error(`unsupported bundle manifest: ${manifestPath}`);
  }
  return value;
}
function extractBundle(manifestPath) {
  const manifest = readBundleManifest(manifestPath);
  const packed = readFileSync(join(dirname(manifestPath), manifest.bundle));
  if (sha256(packed) !== manifest.bundleSha256) throw new Error(`bundle checksum mismatch: ${manifest.bundle}`);
  const raw = brotliDecompressSync(packed);
  const blobs = /* @__PURE__ */ new Map();
  for (const blob of manifest.blobs) {
    const data = raw.subarray(blob.offset, blob.offset + blob.bytes);
    if (data.length !== blob.bytes || sha256(data) !== blob.sha256) throw new Error(`bundle blob mismatch: ${blob.sha256}`);
    blobs.set(blob.sha256, data);
  }
  const out = /* @__PURE__ */ new Map();
  for (const entry of manifest.entries) {
    const data = blobs.get(entry.sha256);
    if (!data || data.length !== entry.bytes) throw new Error(`bundle entry missing: ${entry.name}`);
    out.set(entry.name, data);
  }
  return out;
}
function verifyBundle(manifestPath) {
  extractBundle(manifestPath);
}
function retireBundled(dir, manifestPath, coldDir) {
  const contents = extractBundle(manifestPath);
  mkdirSync(coldDir, { recursive: true, mode: 448 });
  const moved = [], kept = [];
  for (const [name, bytes] of contents) {
    const source = join(dir, name), target = join(coldDir, name);
    if (!existsSync(source) || existsSync(target) || !readFileSync(source).equals(bytes)) {
      kept.push(name);
      continue;
    }
    renameSync(source, target);
    moved.push(name);
  }
  return { moved, kept };
}

export {
  bundleFilesBounded,
  readBundleManifest,
  extractBundle,
  retireBundled
};
