import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import "./chunk-HHAVWD7J.mjs";

// src/core/migration-plan.ts
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
function inventory(home, path) {
  const result = { path, files: 0, bytes: 0, linked: 0, unreadable: 0 };
  const visit = (file) => {
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") result.unreadable++;
      return;
    }
    if (stat.isSymbolicLink()) {
      result.linked++;
      return;
    }
    if (stat.isFile()) {
      result.files++;
      result.bytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    try {
      for (const child of readdirSync(file)) visit(join(file, child));
    } catch {
      result.unreadable++;
    }
  };
  visit(join(home, path));
  return result;
}
function migrationPlan(home) {
  home = resolve(home);
  if (existsSync(home) && lstatSync(home).isSymbolicLink()) throw new Error("Migration planner refuses a linked bridge home");
  const paths = ["bridge.db", "bridge.db-wal", "history.db", "history.db-wal", "jobs.json", "jobs", "archive", "runs", "job-outcomes", "local-result-receipts", "read-state", "storage-capabilities", "worktree-leases", "worktree-state", ".migration-snapshots", "backups"];
  const roots = existsSync(home) ? readdirSync(home).filter((name) => /^bridge\.db\.backup/.test(name)) : [];
  const details = [];
  for (const dir of [".migration-snapshots", "backups", "archive"]) {
    const folder = join(home, dir);
    if (!existsSync(folder) || lstatSync(folder).isSymbolicLink()) continue;
    for (const name of readdirSync(folder)) if (dir === ".migration-snapshots" || dir === "backups" && name.startsWith(".pending-") || dir === "archive" && /^bridge\.db\.backup/.test(name)) details.push(`${dir}/${name}`);
  }
  const found = [...paths, ...roots, ...details].map((path) => inventory(home, path));
  const step = (order, name, paths2, backup) => {
    const selected = found.filter((item) => paths2.includes(item.path)), files = selected.reduce((n, item) => n + item.files, 0), bytes = selected.reduce((n, item) => n + item.bytes, 0);
    return { order, name, paths: paths2, files, bytes, estimatedSeconds: { min: Math.ceil(bytes / (100 * 1024 * 1024) + files * 5e-4), max: Math.ceil(bytes / (10 * 1024 * 1024) + files * 0.01) }, backup, admission: "Unknown or incompatible live readers defer this step; heartbeat age grants no authority." };
  };
  const decisions = found.filter((item) => item.path === ".migration-snapshots" || item.path === "backups" || /^bridge\.db\.backup/.test(item.path) || item.path === "archive" || details.includes(item.path)).map((item) => ({ path: item.path, files: item.files, bytes: item.bytes, newerCopyVerified: false, recommendation: "Keep unchanged. Verify hashes and restore coverage on the rehearsal copy, then offer cold storage or a compressed bundle only with explicit owner confirmation." }));
  return { version: 1, readOnly: true, capturedAt: (/* @__PURE__ */ new Date()).toISOString(), home, inventory: found, steps: [
    step(1, "AB-208 metadata tables", ["bridge.db"], "Verified protected schema/metadata snapshot before additive DDL; reuse a proven full snapshot when required."),
    step(2, "AB-206 job rows and jobs-copy archive bundle", ["jobs.json", "archive"], "Byte-exact SHA256 bundle and versioned SQLite archive backup before cold moves."),
    step(3, "AB-208 small-file import", ["jobs", "runs", "job-outcomes", "local-result-receipts", "read-state", "storage-capabilities", "worktree-leases", "worktree-state"], "Verified compressed raw-byte manifests before row projection and cold moves; unknown leases stay protected."),
    step(4, "Resumable throttled history import", ["bridge.db", "history.db"], "Consistent SQLite snapshot; checkpoints and count/hash verification before history.ingest is enabled."),
    step(5, "AB-176 history budget", ["history.db"], "Verified history snapshot and retained archive before any budget operation.")
  ], ownerDecisions: [...decisions, { path: "cold/originals", files: null, bytes: null, newerCopyVerified: false, recommendation: "Retain imported originals until the owner verifies bundle restore coverage and explicitly chooses cold retention." }, { path: "worktrees", files: null, bytes: null, newerCopyVerified: false, recommendation: "Not traversed or touched by this planner. Finished-worktree retention remains an owner decision after process and provenance evidence." }], notices: ["This planner reads directory entries and file metadata only; it never opens credential files or SQLite databases.", "Duration ranges are uncalibrated IO estimates, not measured rehearsal times. Broker p95 must be measured on the consistent D: copy.", "The real store is never migrated by this command. dbstat and content hash/count checks run only on the consistent rehearsal copy.", "Linked/unreadable paths are retained and require review. No item is deleted or automatically reconciled."] };
}
export {
  migrationPlan
};
