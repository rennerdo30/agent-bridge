import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { physicalMetadataPath } from "./metadata-db.js";
import { hasUnsettledRunnerRetention, RunnerRetentionUnsettled } from "../mcp/runner-delivery-retention.js";

const PROOFS = "runner-retention-proof", INDEX = "runner-retention-index", ARCHIVE = "job-state-archive";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const fail = () => new RunnerRetentionUnsettled("invalid-evidence");
const budget = () => Object.assign(new RunnerRetentionUnsettled("invalid-evidence"), { recovery: "archive-inspection-budget", message: "Runner archive recovery inspection reached its bounded budget; new turns remain blocked. Owner-coordinated offline evidence inspection is required." });
function parse(raw: string): any { try { return JSON.parse(raw); } catch { throw fail(); } }
function inputItem(state: any): {messageId: string; record: string} | undefined {
  const input = state.retainedRunnerInputs;
  if (!input) return undefined;
  if (typeof input.generation !== "string" || !Array.isArray(input.bodies) || input.bodies.length > 128 || !input.bodies.every((v: unknown) => typeof v === "string") ||
      !Array.isArray(input.controls) || input.controls.length > 128 || !input.controls.every((v: any) => typeof v?.cid === "string" && typeof v.body === "string")) throw fail();
  return { messageId: `input:${input.generation}`, record: JSON.stringify([input.generation, input.bodies, input.controls]) };
}
/** Older file projections are evidence too. Do not let a reset/import marker
 * hide unprojected pending records. This census never moves or rewrites files. */
export function inspectRunnerFileArchives(home: string, job: string): void {
  const start = performance.now(); let records = 0, bytes = 0;
  for (const folder of [join(home, "jobs", "archive"), join(home, "jobs", ".import")]) {
    physicalMetadataPath(folder);
    let directory;
    try { directory = opendirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw fail(); }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++records > 128 || performance.now() - start > 25) throw budget();
        if (!entry.name.startsWith(`${job}.json-`) && !entry.name.startsWith(`${job}.json~`)) continue;
        const path = join(folder, entry.name); physicalMetadataPath(path);
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(8 * 1024 * 1024 - bytes)) throw fail();
        bytes += Number(before.size);
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = fstatSync(descriptor, { bigint: true });
          const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
          if (identity(before) !== identity(opened)) throw fail();
          const text = readFileSync(descriptor, "utf8"), state = parse(text);
          if (!state || typeof state !== "object" || typeof state.pid !== "number" || typeof state.status !== "string" ||
              Buffer.byteLength(text) !== Number(before.size) || identity(opened) !== identity(fstatSync(descriptor, { bigint: true })) ||
              identity(opened) !== identity(lstatSync(path, { bigint: true })) || hasUnsettledRunnerRetention(state)) throw fail();
        } finally { closeSync(descriptor); }
        physicalMetadataPath(path);
      }
    } finally { directory.closeSync(); }
  }
}
const value = (db: DatabaseSync, domain: string, key: string) => db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key)?.value;
function insert(db: DatabaseSync, domain: string, key: string, data: unknown): void {
  db.prepare("INSERT INTO bridge_metadata VALUES(?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(domain, key, JSON.stringify(data), Date.now());
}
export function runnerEvidenceNamespace(db: DatabaseSync, create: boolean): string {
  const existing = value(db, INDEX, "namespace");
  if (existing !== undefined) {
    const parsed = parse(String(existing));
    if (parsed?.version !== 1 || typeof parsed.namespace !== "string" || !/^[a-f0-9]{64}$/.test(parsed.namespace)) throw fail();
    return parsed.namespace;
  }
  if (!create || db.prepare("SELECT 1 FROM bridge_metadata WHERE domain IN ('job-state','job-state-archive') AND instr(value,'\"deliveryLedger\"')>0 LIMIT 1").get()) throw fail();
  const namespace = randomBytes(32).toString("hex"); insert(db, INDEX, "namespace", { version: 1, namespace }); return namespace;
}
function itemKey(job: string, ledger: any, item: any): string {
  if (!ledger || ledger.version !== 1 || ledger.job !== job || typeof ledger.generation !== "string" || typeof ledger.principal !== "string" ||
      typeof ledger.namespace !== "string" || !/^[a-f0-9]{64}$/.test(ledger.namespace) || typeof item?.messageId !== "string" || typeof item.record !== "string") throw fail();
  return `${job}/${digest(JSON.stringify([ledger.namespace, ledger.principal, ledger.generation, item.messageId, digest(item.record)]))}`;
}
/** Authoritative append-only retained proof, in the same transaction as its full original archive. */
export function proveRunnerRetained(db: DatabaseSync, job: string, before: any, after: any, sourceKey: string): void {
  const ledger = before.deliveryLedger, next = after.deliveryLedger;
  if (!Array.isArray(ledger?.entries)) return;
  const source = value(db, ARCHIVE, sourceKey);
  if (typeof source !== "string") throw fail();
  const removed = ledger.entries.filter((item: any) => !next?.entries?.some((entry: any) => entry.messageId === item.messageId));
  const input = inputItem(before);
  if (input && !["evidence", "consumed"].includes(before.retainedRunnerInputs.phase) && ["evidence", "consumed"].includes(after.retainedRunnerInputs?.phase)) removed.push(input);
  for (const item of removed) {
    const key = itemKey(job, ledger, item);
    if (ledger.namespace !== runnerEvidenceNamespace(db, false)) throw fail();
    insert(db, PROOFS, key, { version: 1, state: "retained-evidence-only", job, incarnation: ledger.generation, namespace: ledger.namespace,
      principal: ledger.principal, messageId: item.messageId, content: digest(item.record), sourceKey, sourceDigest: digest(source) });
  }
}
/** One stable transaction, capped over originals AND referenced proof sources.
 * The async admission caller yields before entering this final effect fence. */
export function inspectRunnerArchives(db: DatabaseSync, job: string): void {
  const start = performance.now(), sources = new Map<string, any>();
  let bytes = 0, count = 0;
  const timely = () => { if (performance.now() - start > 25) throw budget(); };
  const source = (key: string): any => {
    if (sources.has(key)) return sources.get(key);
    const size = db.prepare("SELECT length(CAST(value AS BLOB)) AS bytes FROM bridge_metadata WHERE domain=? AND key=?").get(ARCHIVE, key)?.bytes;
    if (typeof size !== "number" || size < 0 || !Number.isSafeInteger(size) || (bytes += size) > 8 * 1024 * 1024 || ++count > 64) throw budget();
    timely();
    const raw = value(db, ARCHIVE, key);
    if (typeof raw !== "string" || Buffer.byteLength(raw) !== size) throw fail();
    const loaded = { raw, data: parse(raw), digest: digest(raw) }; sources.set(key, loaded); return loaded;
  };
  const verified = (ledger: any, item: any) => {
    const key = itemKey(job, ledger, item), raw = value(db, PROOFS, key);
    if (typeof raw !== "string" || raw.length > 16_384) return false;
    const proof = parse(raw);
    if (!proof || typeof proof !== "object") return false;
    if (proof.version !== 1 || proof.state !== "retained-evidence-only" || proof.job !== job || proof.incarnation !== ledger.generation ||
        proof.namespace !== ledger.namespace || proof.namespace !== runnerEvidenceNamespace(db, false) || proof.principal !== ledger.principal ||
        proof.messageId !== item.messageId || proof.content !== digest(item.record) || typeof proof.sourceKey !== "string" || !proof.sourceKey.startsWith(`${job}/`)) return false;
    const original = source(proof.sourceKey);
    if (original.digest !== proof.sourceDigest || original.data.deliveryLedger?.namespace !== ledger.namespace ||
        original.data.deliveryLedger?.generation !== ledger.generation || original.data.deliveryLedger?.principal !== ledger.principal) return false;
    const input = inputItem(original.data);
    return original.data.deliveryLedger?.entries?.some((entry: any) => entry.messageId === item.messageId && entry.record === item.record) ||
      input?.messageId === item.messageId && input?.record === item.record;
  };
  const rows = db.prepare("SELECT key FROM bridge_metadata WHERE domain=? AND key>=? AND key<? ORDER BY key").iterate(ARCHIVE, `${job}/`, `${job}/~`);
  for (const row of rows) {
    const loaded = source(String(row.key)), state = loaded.data;
    if (!state || typeof state !== "object" || typeof state.pid !== "number" || typeof state.status !== "string") throw fail();
    const ledger = state.deliveryLedger, pending = state.pendingDeliveryRetention;
    if (pending !== undefined && !Array.isArray(pending) ||
        ledger !== undefined && (!ledger || ledger.version !== 1 || !Array.isArray(ledger.entries))) throw fail();
    if (ledger !== undefined) {
      itemKey(job, ledger, { messageId: "header", record: "" });
      if (ledger.namespace !== runnerEvidenceNamespace(db, false)) throw fail();
    }
    if ((ledger?.entries?.length ?? 0) + (pending?.length ?? 0) > 258) throw budget();
    const all = [...ledger?.entries ?? [], ...pending ?? []];
    for (const item of all) { timely(); if (!verified(ledger, item)) throw fail(); }
    if (state.retainedRunnerInputs && !["evidence", "consumed"].includes(state.retainedRunnerInputs.phase) && !verified(ledger, inputItem(state))) throw fail();
    if (state.deliveryRetentionFailure && !all.length && !state.retainedRunnerInputs) throw fail();
    // Derived only: loss or staleness never replaces validation of the originals.
    insert(db, INDEX, `${job}/${digest(String(row.key))}`, { version: 1, sourceKey: row.key, sourceDigest: loaded.digest, records: all.length });
    timely();
  }
}
