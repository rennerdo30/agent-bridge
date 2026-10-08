import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { metadataFileLease } from "./metadata-file-lease.js";
import { archiveJobs } from "./job-archive.js";
import { assertWritableStore, backupPath, isRecord, readJsonStore, writeJsonStore } from "./json-store.js";
import { readHistoryJson } from "./run-history.js";
import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

/** A completion receipt is retained separately so a stale registry writer cannot erase it. */
export function recordAskCompletion(home: string, job: { id: string; name: string; startedAt: number; finishedAt?: number; status: string; sessionId?: string | null }): void {
  if (!job.name.includes("-ask-") || !["done", "failed", "cancelled"].includes(job.status)) return;
  const path = join(home, "ask-completions", `${job.id}-${job.startedAt}.json`);
  writeJsonStore(path, { receiptVersion: 1, ...job }, readHistoryJson(path));
}

/** Worker-only recovery from paired native tool call/result records already retained by import. */
export function observeAskToolRecord(db: DatabaseSync, home: string, source: string, generation: number, raw: Buffer, at: number, offset?: number): void {
  if (offset === undefined) {
    for (const line of raw.toString("utf8").split("\n")) observeAskRow(db, home, source, generation, line, at);
    return;
  }
  const key = `ask-jsonl-fragment:${source}:${generation}`;
  const saved = JSON.parse(String(db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(key)?.cursor ?? "{}"));
  const lines = ((saved.after === offset ? saved.tail ?? "" : "") + raw.toString("utf8")).split("\n");
  let tail = lines.pop() ?? "";
  for (const line of lines) observeAskRow(db, home, source, generation, line, at);
  try { JSON.parse(tail); observeAskRow(db, home, source, generation, tail, at); tail = ""; } catch { /* Resume an incomplete native record in the next chunk. */ }
  if (Buffer.byteLength(tail) > 1024 * 1024) tail = ""; // Raw bytes remain retained; oversized metadata cannot authorize recovery.
  db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor")
    .run(key, JSON.stringify({ after: offset + raw.length, tail }));
}
function observeAskRow(db: DatabaseSync, home: string, source: string, generation: number, line: string, at: number): void {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  if (!isRecord(row) || !isRecord(row.message) || !Array.isArray(row.message.content)) return;
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : row.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) at = timestamp;
  for (const block of row.message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const target = /(?:^|__)ask_(codex|claude|opencode|antigravity)$/.exec(block.name)?.[1];
      if (target) db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor")
        .run(`ask-tool:${source}:${generation}:${block.id}`, JSON.stringify({ target, at }));
    }
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const call = db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(`ask-tool:${source}:${generation}:${block.tool_use_id}`);
    if (!call) continue;
    const paired = JSON.parse(String(call.cursor));
    let text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
      ? block.content.filter(isRecord).map(item => typeof item.text === "string" ? item.text : "").join("\n") : "";
    let failed = block.is_error === true;
    try {
      const wrapped = JSON.parse(text);
      if (isRecord(wrapped) && Array.isArray(wrapped.content)) {
        text = wrapped.content.filter(isRecord).map(item => item.text ?? "").join("\n");
        failed ||= wrapped.isError === true;
      }
    } catch { /* Older native logs retain the formatted tool response directly. */ }
    const match = /^Job: ((codex|claude|opencode|antigravity)-ask-([\w-]+))\r?\n/.exec(text);
    if (!match || match[2] !== paired.target) continue;
    const registry = readHistoryJson(join(home, "jobs.json"));
    const jobs = Array.isArray(registry) ? registry : isRecord(registry) && Array.isArray(registry.jobs) ? registry.jobs : [];
    const job = jobs.find(job => isRecord(job) && job.name === match[1]);
    if (!isRecord(job) || typeof job.startedAt !== "number" || job.startedAt < paired.at || job.startedAt > at) continue;
    recordAskCompletion(home, { id: match[3]!, name: match[1]!, startedAt: job.startedAt, finishedAt: at, status: failed ? "failed" : "done" });
  }
}

/** Async read-only projection when the owner's worker kill switch is enabled. */
export async function projectAskCompletions(path: string, jobs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (const job of jobs) {
    if (job.status !== "running" || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.name !== "string" || !job.name.includes("-ask-")) { result.push(job); continue; }
    try {
      const receipt = JSON.parse(await readFile(join(dirname(path), "ask-completions", `${job.id}-${job.startedAt}.json`), "utf8"));
      result.push(receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt &&
        ["done", "failed", "cancelled"].includes(receipt.status) && receipt.finishedAt >= Number(job.startedAt)
        ? { ...job, status: receipt.status, finishedAt: receipt.finishedAt, host: null } : job);
    } catch { result.push(job); }
  }
  return result;
}

/** Reconcile only a matching turn with definitive terminal evidence. Keep the original in an archive. */
export function reconcileAskCompletions(path: string): number {
  const release = metadataFileLease(`${path}.lock`, 0, true);
  try {
    const previous = readJsonStore(path, undefined, value => Array.isArray(value) || isRecord(value));
    assertWritableStore(previous);
    const entries = Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : [];
    const originals: Record<string, unknown>[] = [];
    const jobs = entries.map(job => {
      if (!isRecord(job) || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) ||
          typeof job.name !== "string" || !job.name.includes("-ask-") || job.status !== "running" || typeof job.startedAt !== "number") return job;
      const receipt = readHistoryJson(join(dirname(path), "ask-completions", `${job.id}-${job.startedAt}.json`));
      const state = readHistoryJson(join(dirname(path), "jobs", `${job.id}.json`));
      const final = isRecord(receipt) && receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt ? receipt
        : isRecord(state) && state.startedAt === job.startedAt ? state : undefined;
      if (!final || !["done", "failed", "cancelled"].includes(String(final.status)) ||
          typeof (final.finishedAt ?? final.updatedAt) !== "number" || Number(final.finishedAt ?? final.updatedAt) < job.startedAt) return job;
      originals.push(job);
      return { ...job, status: final.status, finishedAt: final.finishedAt ?? final.updatedAt, host: null,
        completionReceipt: { version: 1, startedAt: job.startedAt, status: final.status } };
    });
    if (!originals.length) return 0;
    copyFileSync(path, backupPath(path));
    archiveJobs(path, originals);
    writeJsonStore(path, { ...(isRecord(previous) ? previous : {}), jobs }, previous);
    return originals.length;
  } finally { release(); }
}
