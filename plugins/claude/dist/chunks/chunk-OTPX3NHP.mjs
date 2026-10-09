import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  closeMetadataDb,
  importMetadataDomain,
  isRecord,
  metadataDb,
  metadataDbOpen,
  metadataReaderRetained,
  physicalMetadataPath,
  retainMetadataFiles,
  storageLease
} from "./chunk-B5SDVTIU.mjs";

// src/core/read-journal.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var DEFERRED_CODES = /* @__PURE__ */ new Set(["ELEASEBUSY", "STORE_UPGRADE_DEFERRED"]);
var FIRST_RETRY_MS = 1e3;
var MAX_RETRY_MS = 6e4;
var deferrals = /* @__PURE__ */ new Map();
var ReadJournal = class {
  constructor(home, log) {
    this.home = home;
    this.log = log;
  }
  home;
  log;
  memory;
  key(identity) {
    return createHash("sha256").update(identity).digest("hex");
  }
  insert(db, identity, id, at) {
    db.prepare(`INSERT INTO bridge_read_receipts VALUES (?,?,?) ON CONFLICT(identity,message_id)
   DO UPDATE SET read_at=CASE WHEN read_at IS NULL THEN excluded.read_at
   WHEN excluded.read_at IS NULL THEN read_at ELSE MIN(read_at,excluded.read_at) END`).run(identity, id, at);
  }
  database() {
    if (this.home === ":memory:") {
      if (!this.memory) {
        this.memory = new DatabaseSync(":memory:");
        this.memory.exec("CREATE TABLE bridge_read_receipts(identity TEXT NOT NULL,message_id TEXT NOT NULL,read_at INTEGER,PRIMARY KEY(identity,message_id))");
      }
      return this.memory;
    }
    const db = metadataDb(this.home);
    if (db.prepare("SELECT 1 FROM bridge_components WHERE name='import:read-state'").get()) return db;
    const dir = join(this.home, "read-state");
    physicalMetadataPath(dir);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.jsonl$/.test(f)).map((f) => join(dir, f)) : [];
    retainMetadataFiles(this.home, files, (store, path, raw) => {
      const identity = path.slice("read-state/".length, -".jsonl".length);
      for (const line of raw.toString("utf8").split("\n")) {
        try {
          const value = JSON.parse(line);
          const timed = value && typeof value === "object" && !Array.isArray(value) ? value : null;
          const ids = timed?.ids ?? value;
          if (Array.isArray(ids)) {
            for (const id of ids) if (typeof id === "string") this.insert(store, identity, id, typeof timed?.at === "number" ? timed.at : null);
          }
        } catch {
        }
      }
    });
    db.prepare("INSERT INTO bridge_components VALUES ('import:read-state',1) ON CONFLICT(name) DO NOTHING").run();
    return db;
  }
  /**
   * The metadata store, or undefined while it is deferred. Until then read marks use the
   * pre-AB-208 journal files, which the store imports verbatim as soon as it opens: a deferral
   * only happens before the read-state import, so nothing written meanwhile is missed.
   */
  available() {
    if (this.home === ":memory:") return this.database();
    const deferred = deferrals.get(this.home);
    if (deferred && Date.now() < deferred.until) return void 0;
    try {
      const db = this.database();
      if (deferred) {
        if (deferred.timer) clearTimeout(deferred.timer);
        deferrals.delete(this.home);
        this.log?.info("metadata store available: read marks from the journal files were imported");
      }
      return db;
    } catch (error) {
      if (!DEFERRED_CODES.has(String(error.code))) throw error;
      const delay = deferred ? Math.min(MAX_RETRY_MS, deferred.delay * 2) : FIRST_RETRY_MS;
      if (!deferred) this.log?.warn("metadata store deferred; read marks are kept in the read-state journal files until it opens", { err: String(error.message ?? error) });
      if (deferred?.timer) clearTimeout(deferred.timer);
      const timer = setTimeout(() => {
        const due = deferrals.get(this.home);
        if (due?.timer === timer) due.until = 0;
        const opened = !metadataDbOpen(this.home);
        try {
          this.available();
        } catch {
        } finally {
          if (opened && !metadataReaderRetained(this.home)) closeMetadataDb(this.home);
        }
      }, delay);
      timer.unref();
      deferrals.set(this.home, { until: Date.now() + delay, delay, timer });
      return void 0;
    }
  }
  legacyPath(identity) {
    return join(this.home, "read-state", `${this.key(identity)}.jsonl`);
  }
  legacyEntries(identity) {
    let raw;
    try {
      raw = readFileSync(this.legacyPath(identity), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return raw.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const value = JSON.parse(line);
        const timed = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        const ids = timed?.ids ?? value;
        return Array.isArray(ids) ? [{ ids: ids.filter((id) => typeof id === "string"), at: typeof timed?.at === "number" ? timed.at : null }] : [];
      } catch {
        return [];
      }
    });
  }
  read(identity) {
    const db = this.available();
    if (!db) return [...new Set(this.legacyEntries(identity).flatMap((entry) => entry.ids))];
    return db.prepare("SELECT message_id FROM bridge_read_receipts WHERE identity=? ORDER BY rowid").all(this.key(identity)).map((r) => String(r.message_id));
  }
  receipt(identity, id) {
    const db = this.available();
    if (!db) {
      const entries = this.legacyEntries(identity).filter((entry) => entry.ids.includes(id));
      const times = entries.flatMap((entry) => entry.at === null ? [] : [entry.at]);
      return { read: entries.length > 0, at: times.length ? Math.min(...times) : null };
    }
    const row = db.prepare("SELECT read_at FROM bridge_read_receipts WHERE identity=? AND message_id=?").get(this.key(identity), id);
    return { read: !!row, at: row && row.read_at !== null ? Number(row.read_at) : null };
  }
  append(identity, ids) {
    const release = this.home === ":memory:" ? () => {
    } : storageLease(this.home);
    try {
      const db = this.available();
      if (db) this.appendRows(db, identity, ids);
      else {
        const dir = join(this.home, "read-state");
        physicalMetadataPath(dir);
        mkdirSync(dir, { recursive: true, mode: 448 });
        appendFileSync(this.legacyPath(identity), `
${JSON.stringify({ ids, at: Date.now() })}
`, { mode: 384, flush: true });
      }
    } finally {
      release();
    }
  }
  appendRows(db, identity, ids) {
    const key2 = this.key(identity), now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) this.insert(db, key2, id, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

// src/core/local-result-receipts.ts
import { createHash as createHash2 } from "node:crypto";
var RESULT_HEADER = /^Subagent .+ (?:done|failed|cancelled) after \d+s\./;
var LOCAL_RESULTS_DIR = "local-result-receipts";
var key = (name) => createHash2("sha256").update(name).digest("hex");
function recordLocalResult(home, message) {
  if (!message.from.id.startsWith("job:") || !RESULT_HEADER.test(message.body.split("\n")[0])) return;
  importMetadataDomain(home, LOCAL_RESULTS_DIR, ".json", true);
  const value = { id: message.id, name: message.from.name, recipient: message.recipient, deliveredAt: message.createdAt, envelope: message };
  const release = storageLease(home);
  try {
    metadataDb(home).prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(LOCAL_RESULTS_DIR, `${key(message.from.name)}/${key(message.id)}`, JSON.stringify(value), Date.now());
  } finally {
    release();
  }
}
function localResultReceipt(home, name, owner, after, before) {
  importMetadataDomain(home, LOCAL_RESULTS_DIR, ".json", true);
  const prefix = key(name);
  const records = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key>=? AND key<?").all(LOCAL_RESULTS_DIR, `${prefix}/`, `${prefix}0`).map((row) => JSON.parse(String(row.value))).filter((r) => isRecord(r) && typeof r.id === "string" && typeof r.recipient === "string" && typeof r.deliveredAt === "number" && (!owner || r.recipient === owner) && r.deliveredAt >= after && r.deliveredAt < before).sort((a, b) => b.deliveredAt - a.deliveredAt);
  const record = records[0];
  if (!record) return null;
  const receipt = new ReadJournal(home).receipt(`name:${record.recipient}`, record.id);
  return {
    status: receipt.read ? "read" : "delivered",
    messageId: record.id,
    recipient: record.recipient,
    deliveredAt: record.deliveredAt,
    readAt: receipt.at
  };
}

export {
  ReadJournal,
  RESULT_HEADER,
  recordLocalResult,
  localResultReceipt
};
