import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  HISTORY_STORE_VERSION,
  HISTORY_V1_PREFIX,
  decodeHistoryRow,
  historyDbPath,
  historyReady,
  openHistoryReader,
  openHistoryStore
} from "./chunk-GXD6MOY6.mjs";
import {
  extractBundle
} from "./chunk-XFCSUQ7M.mjs";
import {
  jobArchivePath,
  maintenanceLock,
  openJobArchive
} from "./chunk-EVPBD2NK.mjs";
import "./chunk-SFW3GO73.mjs";
import {
  DB_FILE_NAME
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/core/storage-finalize.ts
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var LEGACY_BRIDGE_TABLES = ["history_fts", "history_documents", "history_tags", "history_files", "history_sessions", "conversation_records", "conversation_sources", "conversation_parts", "conversations", "conversation_projects", "conversation_memberships"];
function size(path) {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + size(join(path, name)), 0);
}
function tableBytes(db, name) {
  try {
    return Number(db.prepare("SELECT coalesce(sum(pgsize),0) n FROM dbstat WHERE name=? OR name LIKE ?").get(name, `${name}_%`).n);
  } catch {
    return 0;
  }
}
function jobArchiveComplete(home) {
  if (!existsSync(jobArchivePath(join(home, "jobs.json")))) return false;
  const db = openJobArchive(join(home, "jobs.json"));
  try {
    return db?.prepare("SELECT state FROM archive_migrations WHERE version=1").get()?.state === "complete";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
function verifiedBundleOriginals(dir) {
  if (!existsSync(dir)) return [];
  const manifests = readdirSync(dir).filter((name) => name.endsWith(".manifest.json"));
  if (!manifests.length) return [];
  for (const manifest of manifests) extractBundle(join(dir, manifest));
  return ["archive-originals", "root-originals"].map((name) => join(dir, name)).filter(existsSync);
}
function planFinalize(home) {
  const blockers = [], items = [];
  const bridge = join(home, DB_FILE_NAME), history = historyDbPath(bridge);
  let historyVerified = false;
  if (existsSync(history)) {
    const db = new DatabaseSync(history, { readOnly: true, timeout: 1e3 });
    try {
      historyVerified = historyReady(db);
      if (historyVerified) {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\')").all(`${HISTORY_V1_PREFIX}%`)) {
          const name = String(row.name);
          if (/_(data|idx|docsize|config|content)$/.test(name) && !name.startsWith("retained_")) continue;
          items.push({ kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt, superseded by the verified v2 copy" });
        }
      }
    } finally {
      db.close();
    }
  }
  if (!historyVerified) blockers.push("History store v2 is not verified yet; nothing in the old format may be removed.");
  if (!jobArchiveComplete(home)) blockers.push("Job archive import is not complete yet; job copies stay.");
  if (historyVerified && existsSync(bridge)) {
    const db = new DatabaseSync(bridge, { readOnly: true, timeout: 1e3 });
    try {
      for (const name of LEGACY_BRIDGE_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
        items.push({ kind: "table", path: `bridge.db:${name}`, bytes: tableBytes(db, name), reason: "legacy history, copied into history.db and verified" });
    } finally {
      db.close();
    }
  }
  if (historyVerified) {
    const snapshots = join(home, ".migration-snapshots");
    if (existsSync(snapshots)) for (const name of readdirSync(snapshots))
      items.push({ kind: statSync(join(snapshots, name)).isDirectory() ? "directory" : "file", path: join(snapshots, name), bytes: size(join(snapshots, name)), reason: "pre-migration snapshot; the migrations it protected are verified" });
    for (const name of existsSync(home) ? readdirSync(home) : []) if (/^bridge\.db\.backup-/.test(name))
      items.push({ kind: "file", path: join(home, name), bytes: size(join(home, name)), reason: "old whole-database backup from earlier migrations" });
    const archive = join(home, "archive");
    if (existsSync(archive)) {
      for (const name of readdirSync(archive)) if (/^bridge\.db\.backup/.test(name))
        items.push({ kind: "file", path: join(archive, name), bytes: size(join(archive, name)), reason: "old whole-database backup from earlier migrations" });
    }
    const backups = join(home, "backups");
    if (existsSync(backups)) {
      for (const name of readdirSync(backups)) if (name.startsWith(".pending-"))
        items.push({ kind: "directory", path: join(backups, name), bytes: size(join(backups, name)), reason: "incomplete automatic backup (never published)" });
    }
  }
  if (!blockers.length) {
    try {
      for (const dir of verifiedBundleOriginals(join(home, "cold-storage", "jobs-v1")))
        items.push({ kind: "directory", path: dir, bytes: size(dir), reason: "job copy originals; their bundle restores byte-exact" });
    } catch (err) {
      blockers.push(`A job copy bundle no longer verifies (${err.message}); its originals stay.`);
    }
  }
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0) };
}
var PRESENCE_KEYS = {
  conversations: ["id"],
  conversation_sources: ["id"],
  conversation_parts: ["source", "part"],
  conversation_projects: ["project"],
  conversation_memberships: ["project", "conversation"],
  history_documents: ["id"],
  history_tags: ["id", "type", "value"],
  history_files: ["path"],
  history_sessions: ["alias"]
};
function verifyBeforeFinalize(home, report = () => {
}) {
  const blockers = [];
  const bridgeFile = join(home, DB_FILE_NAME), historyFile = historyDbPath(bridgeFile);
  if (!existsSync(historyFile)) return ["history.db does not exist."];
  const history = openHistoryReader(historyFile, 5e3);
  const bridge = new DatabaseSync(bridgeFile, { readOnly: true, timeout: 5e3 });
  try {
    if (!historyReady(history)) return ["History store v2 is not verified."];
    report("checking history.db integrity\u2026");
    if (history.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) blockers.push("history.db failed quick_check.");
    const has = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has(bridge, "conversation_records")) {
      report("comparing every legacy transcript record byte-for-byte\u2026");
      const same = history.prepare("SELECT * FROM conversation_records WHERE id=?");
      const mapped = history.prepare("SELECT target_id FROM history_legacy_tail WHERE source_id=?");
      let checked = 0, missing = 0, different = 0;
      for (const row of bridge.prepare("SELECT * FROM conversation_records ORDER BY id").iterate()) {
        let target = same.get(row.id);
        if (!target || target.source !== row.source || target.generation !== row.generation || target.offset !== row.offset) {
          const tail = mapped.get(row.id);
          target = tail ? same.get(tail.target_id) : void 0;
        }
        if (!target) missing++;
        else {
          const decoded = decodeHistoryRow("conversation_records", target);
          if (!decoded.raw.equals(Buffer.from(row.raw)) || decoded.conversation !== row.conversation || decoded.source !== row.source) different++;
        }
        if (++checked % 5e4 === 0) report(`  ${checked.toLocaleString("en")} records checked`);
      }
      if (missing) blockers.push(`${missing} legacy transcript records are not in history.db yet (the legacy tail has not caught up).`);
      if (different) blockers.push(`${different} legacy transcript records differ from their copy in history.db.`);
      report(`  ${checked.toLocaleString("en")} records checked, ${missing} missing, ${different} different`);
    }
    for (const [table, keys] of Object.entries(PRESENCE_KEYS)) {
      if (!has(bridge, table)) continue;
      if (!has(history, table)) {
        blockers.push(`history.db has no ${table} table.`);
        continue;
      }
      report(`checking that every ${table} row exists in history.db\u2026`);
      const where = keys.map((k) => `"${k}"=?`).join(" AND ");
      const lookup = history.prepare(`SELECT 1 FROM "${table}" WHERE ${where}`);
      let missing = 0;
      for (const row of bridge.prepare(`SELECT ${keys.map((k) => `"${k}"`).join(",")} FROM "${table}"`).iterate())
        if (!lookup.get(...keys.map((k) => row[k]))) missing++;
      if (missing && table !== "history_documents") blockers.push(`${missing} ${table} rows exist only in bridge.db.`);
      else if (missing) report(`  ${missing} legacy search documents were re-derived after a reindex; their source records are verified above.`);
    }
    const unfinished = history.prepare("SELECT count(*) n FROM history_copy_state WHERE verified=0").get().n;
    if (Number(unfinished)) blockers.push("The history copy has unverified tables.");
  } finally {
    history.close();
    bridge.close();
  }
  try {
    verifiedBundleOriginals(join(home, "cold-storage", "jobs-v1"));
  } catch (err) {
    blockers.push(`A job copy bundle no longer restores (${err.message}).`);
  }
  return blockers;
}
function runFinalize(home, report) {
  const release = maintenanceLock(home);
  try {
    const planned = planFinalize(home);
    if (!planned.ready) return planned;
    const verification = verifyBeforeFinalize(home, report);
    if (verification.length) return { ...planned, ready: false, blockers: verification };
    report("verification passed; removing the listed old-format data\u2026");
    const plan = planned;
    const bridgeTables = plan.items.filter((i) => i.kind === "table" && i.path.startsWith("bridge.db:")).map((i) => i.path.slice("bridge.db:".length));
    const historyTables = plan.items.filter((i) => i.kind === "table" && i.path.startsWith("history.db:")).map((i) => i.path.slice("history.db:".length));
    if (bridgeTables.length) {
      const db = new DatabaseSync(join(home, DB_FILE_NAME), { timeout: 3e4 });
      try {
        for (const name of bridgeTables) {
          db.exec("BEGIN IMMEDIATE");
          try {
            db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          report(`removed bridge.db table ${name}`);
        }
        report("compacting bridge.db (only the remaining core data is rewritten)\u2026");
        db.exec("VACUUM");
      } finally {
        db.close();
      }
    }
    if (historyTables.length) {
      const db = openHistoryStore(historyDbPath(join(home, DB_FILE_NAME)));
      try {
        for (const name of historyTables) {
          db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
          report(`removed history.db table ${name}`);
        }
        db.exec("VACUUM");
      } finally {
        db.close();
      }
    }
    for (const item of plan.items.filter((i) => i.kind !== "table")) {
      rmSync(item.path, { recursive: true, force: true });
      report(`removed ${item.path}`);
    }
    return plan;
  } finally {
    release();
  }
}
function rollbackHistoryStore(home) {
  const bridge = join(home, DB_FILE_NAME);
  const legacy = new DatabaseSync(bridge, { readOnly: true, timeout: 5e3 });
  try {
    if (!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_records'").get())
      throw new Error("The legacy history in bridge.db was already removed by storage finalize; rollback is no longer possible.");
  } finally {
    legacy.close();
  }
  const db = openHistoryStore(historyDbPath(bridge));
  try {
    const state = db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (!state) return "No history migration has started; readers already use the legacy history.";
    db.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: "History store rolled back by the owner; legacy history in bridge.db is in use. Run agent-bridge reindex to migrate again.", resumeStatus: "copying", rolledBackFrom: state.status }), HISTORY_STORE_VERSION);
    return "Rolled back: search and transcripts read the legacy history in bridge.db again. The new copy in history.db is kept.";
  } finally {
    db.close();
  }
}

// src/cli/storage.ts
var USAGE = "Usage: agent-bridge storage finalize [--yes] [--json] | storage rollback-history\nLists the old-format data that the verified new storage replaces; with --yes it removes exactly that list and compacts bridge.db.";
var gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
function runStorage(rest, home, out) {
  if (rest[0] === "rollback-history" && rest.length === 1) {
    try {
      out(rollbackHistoryStore(home));
      return 0;
    } catch (err) {
      out(String(err.message));
      return 1;
    }
  }
  const args = new Set(rest.slice(1));
  if (rest[0] !== "finalize" || [...args].some((a) => a !== "--yes" && a !== "--json")) {
    out(USAGE);
    return 2;
  }
  const plan = args.has("--yes") ? runFinalize(home, (line) => {
    if (!args.has("--json")) out(line);
  }) : planFinalize(home);
  if (args.has("--json")) {
    out(JSON.stringify({ ...plan, removed: args.has("--yes") && plan.ready }, null, 2));
    return plan.ready ? 0 : 1;
  }
  if (!plan.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan.blockers) out(`  - ${blocker}`);
    return 1;
  }
  if (!args.has("--yes")) {
    for (const item of plan.items) out(`  ${gib(item.bytes).padStart(10)}  ${item.path}  (${item.reason})`);
    out(`${plan.items.length} items, ${gib(plan.bytes)}. Run again with --yes to remove them.`);
    return 0;
  }
  out(`Removed ${plan.items.length} items, ${gib(plan.bytes)}.`);
  return 0;
}
export {
  runStorage
};
