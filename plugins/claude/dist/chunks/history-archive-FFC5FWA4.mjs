import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  assertUnlinked
} from "./chunk-VBHAVRFY.mjs";
import "./chunk-DLCSA3SJ.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/history-archive.ts
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
async function digest(file, compressed = false) {
  const hash = createHash("sha256"), input = createReadStream(file);
  for await (const bytes of compressed ? input.pipe(createGunzip()) : input) hash.update(bytes);
  return hash.digest("hex");
}
async function archiveHistory(home, root = join(home, "history-archive")) {
  if (!isAbsolute(root)) throw new Error("History archive root must be absolute; originals unchanged");
  assertUnlinked(home);
  assertUnlinked(root);
  assertUnlinked(join(home, "history.db"));
  mkdirSync(root, { recursive: true, mode: 448 });
  const snapshot = join(root, `history-v1-${Date.now()}-${randomUUID()}.db`);
  const source = new DatabaseSync(join(home, "history.db"), { readOnly: true, timeout: 100 });
  try {
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const check = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Archive integrity check failed; original and snapshot retained");
  } finally {
    check.close();
  }
  const hash = await digest(snapshot), compressed = `${snapshot}.gz`;
  await pipeline(createReadStream(snapshot), createGzip(), createWriteStream(compressed, { flags: "wx", mode: 384 }));
  if (await digest(compressed, true) !== hash) throw new Error("Archive byte verification failed; every original retained");
  const manifest = `${snapshot}.manifest.json`;
  writeFileSync(manifest, JSON.stringify({ version: 1, policy: "retain-and-pause", source: "history.db", snapshot, compressed, sha256: hash, verified: true }) + "\n", { flag: "wx", mode: 384 });
  return manifest;
}
export {
  archiveHistory
};
