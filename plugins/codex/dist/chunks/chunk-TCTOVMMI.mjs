import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isRecord,
  readJsonStore,
  storageLease,
  writeJsonStore
} from "./chunk-GN275QYC.mjs";

// src/core/read-journal.ts
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
var ReadJournal = class {
  constructor(home) {
    this.home = home;
    this.dir = join(home, "read-state");
  }
  home;
  dir;
  path(identity) {
    return join(this.dir, `${createHash("sha256").update(identity).digest("hex")}.jsonl`);
  }
  read(identity) {
    return this.entries(identity).flatMap((entry) => entry.ids);
  }
  receipt(identity, id) {
    const entries = this.entries(identity).filter((entry) => entry.ids.includes(id));
    const times = entries.flatMap((entry) => entry.at === null ? [] : [entry.at]);
    return { read: entries.length > 0, at: times.length ? Math.min(...times) : null };
  }
  entries(identity) {
    let raw;
    try {
      raw = readFileSync(this.path(identity), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
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
  append(identity, ids) {
    const release = storageLease(this.home);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 448 });
      appendFileSync(this.path(identity), `
${JSON.stringify({ ids, at: Date.now() })}
`, { mode: 384, flush: true });
    } finally {
      release();
    }
  }
};

// src/core/local-result-receipts.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";
var RESULT_HEADER = /^Subagent .+ (?:done|failed|cancelled) after \d+s\./;
var LOCAL_RESULTS_DIR = "local-result-receipts";
var key = (name) => createHash2("sha256").update(name).digest("hex");
function recordLocalResult(home, message) {
  if (!message.from.id.startsWith("job:") || !RESULT_HEADER.test(message.body.split("\n")[0])) return;
  const path = join2(home, LOCAL_RESULTS_DIR, key(message.from.name), `${key(message.id)}.json`);
  const previous = readJsonStore(path);
  if (previous) return;
  writeJsonStore(path, { id: message.id, name: message.from.name, recipient: message.recipient, deliveredAt: message.createdAt }, previous);
}
function localResultReceipt(home, name, owner, after, before) {
  const dir = join2(home, LOCAL_RESULTS_DIR, key(name));
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJsonStore(join2(dir, f))).filter((r) => isRecord(r) && typeof r.id === "string" && typeof r.recipient === "string" && typeof r.deliveredAt === "number" && (!owner || r.recipient === owner) && r.deliveredAt >= after && r.deliveredAt < before).sort((a, b) => b.deliveredAt - a.deliveredAt);
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
