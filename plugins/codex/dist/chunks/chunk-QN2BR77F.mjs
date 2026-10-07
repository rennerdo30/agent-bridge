import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  JSON_STORE_VERSION,
  assertStoreUpgrade,
  isRecord
} from "./chunk-TPCM6ZR4.mjs";

// src/core/file-cache.ts
import { readFileSync, statSync } from "node:fs";
var MAX_BYTES = 8 * 1024 * 1024;
var MAX_ENTRIES = 2048;
var cache = /* @__PURE__ */ new Map();
var bytes = 0;
function fileSignature(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}
function readJsonSnapshot(file) {
  const st = statSync(file), signature = fileSignature(st);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file);
    cache.set(file, saved);
    return saved;
  }
  if (saved) {
    cache.delete(file);
    bytes -= saved.bytes;
  }
  const next = { signature, value: JSON.parse(readFileSync(file, "utf8")), bytes: st.size };
  if (st.size <= MAX_BYTES) {
    cache.set(file, next);
    bytes += st.size;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value;
      bytes -= cache.get(first).bytes;
      cache.delete(first);
    }
  }
  return next;
}

// src/core/job-archive.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
var snapshots = /* @__PURE__ */ new Map();
var EMPTY_SNAPSHOT = { signature: "", jobs: [] };
function readArchivedJobs(path) {
  return structuredClone(readArchivedJobSnapshot(path).jobs);
}
function readArchivedJobSnapshot(path) {
  const dir = join(dirname(path), "archive");
  if (!existsSync(dir)) return EMPTY_SNAPSHOT;
  const sources = [];
  const signatures = [];
  let bytes2 = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    const snapshot = readJsonSnapshot(join(dir, file));
    const value = snapshot.value;
    if (!isRecord(value) || value.version !== void 0 && (!Number.isInteger(value.version) || value.version < 0 || value.version > JSON_STORE_VERSION) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${file}`);
    signatures.push(`${file}:${snapshot.signature}`);
    sources.push({ value });
    bytes2 += snapshot.bytes;
  }
  const signature = signatures.join("\n"), saved = snapshots.get(path);
  if (saved?.signature === signature) return saved;
  const jobs = /* @__PURE__ */ new Map();
  for (const source of sources) for (const job of source.value.jobs) {
    if (isRecord(job) && typeof job.id === "string") jobs.set(job.id, job);
  }
  const next = { signature, jobs: [...jobs.values()] };
  snapshots.delete(path);
  if (bytes2 <= 8 * 1024 * 1024) snapshots.set(path, next);
  if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
  return next;
}
function archiveJobs(path, jobs) {
  assertStoreUpgrade(dirname(path), "json", 0, JSON_STORE_VERSION);
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 448 });
  const target = join(dir, `jobs-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify({ version: JSON_STORE_VERSION, jobs }, null, 2) + "\n", { mode: 384, flag: "wx" });
  const fd = openSync(target, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return target;
}

export {
  fileSignature,
  readJsonSnapshot,
  readArchivedJobs,
  readArchivedJobSnapshot,
  archiveJobs
};
