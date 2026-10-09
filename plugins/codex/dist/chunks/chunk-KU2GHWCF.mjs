import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  readHistoryJson,
  readRunnerStateRecord
} from "./chunk-LYYIJWEF.mjs";
import {
  assertWritableStore,
  backupPath,
  cloneJson,
  isRecord,
  metadataFileLease,
  readIndexedJobs,
  readJsonStore,
  storeJobRecords,
  writeJsonStore
} from "./chunk-ATZFJWXN.mjs";

// src/core/job-archive.ts
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
function readArchivedJobs(path) {
  return cloneJson(readArchivedJobSnapshot(path).jobs);
}
function readArchivedJobSnapshot(path, selection = {}) {
  return readIndexedJobs(path, selection);
}
function* readArchivedJobSteps(path, responsive = false, selection = {}) {
  let canonical;
  try {
    canonical = realpathSync.native(dirname(path));
  } catch {
  }
  if (responsive) yield;
  if (canonical && realpathSync.native(dirname(path)) !== canonical) throw new Error("job archive ancestor changed during traversal; data kept unchanged");
  return readArchivedJobSnapshot(path, selection);
}
function archiveJobs(path, jobs) {
  return storeJobRecords(path, jobs, true);
}

// src/core/ask-completion.ts
import { closeSync, constants as fsConstants, copyFileSync, fsyncSync, openSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
import { readFile } from "node:fs/promises";
function recordAskCompletion(home, job) {
  if (!job.name.includes("-ask-") || !["done", "failed", "cancelled"].includes(job.status)) return;
  const path = join(home, "ask-completions", `${job.id}-${job.startedAt}.json`);
  writeJsonStore(path, { receiptVersion: 1, ...job }, readHistoryJson(path));
}
function observeAskToolRecord(db, home, source, generation, raw, at, offset) {
  if (offset === void 0) {
    for (const line of raw.toString("utf8").split("\n")) observeAskRow(db, home, source, generation, line, at);
    return;
  }
  const key = `ask-jsonl-fragment:${source}:${generation}`;
  const saved = JSON.parse(String(db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(key)?.cursor ?? "{}"));
  const lines = ((saved.after === offset ? saved.tail ?? "" : "") + raw.toString("utf8")).split("\n");
  let tail = lines.pop() ?? "";
  for (const line of lines) observeAskRow(db, home, source, generation, line, at);
  try {
    JSON.parse(tail);
    observeAskRow(db, home, source, generation, tail, at);
    tail = "";
  } catch {
  }
  if (Buffer.byteLength(tail) > 1024 * 1024) tail = "";
  db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(key, JSON.stringify({ after: offset + raw.length, tail }));
}
function observeAskRow(db, home, source, generation, line, at) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(row) || !isRecord(row.message) || !Array.isArray(row.message.content)) return;
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : row.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) at = timestamp;
  for (const block of row.message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const target = /(?:^|__)ask_(codex|claude|opencode|antigravity)$/.exec(block.name)?.[1];
      if (target) db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(`ask-tool:${source}:${generation}:${block.id}`, JSON.stringify({ target, at }));
    }
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const call = db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(`ask-tool:${source}:${generation}:${block.tool_use_id}`);
    if (!call) continue;
    const paired = JSON.parse(String(call.cursor));
    let text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.filter(isRecord).map((item) => typeof item.text === "string" ? item.text : "").join("\n") : "";
    let failed = block.is_error === true;
    try {
      const wrapped = JSON.parse(text);
      if (isRecord(wrapped) && Array.isArray(wrapped.content)) {
        text = wrapped.content.filter(isRecord).map((item) => item.text ?? "").join("\n");
        failed ||= wrapped.isError === true;
      }
    } catch {
    }
    const match = /^Job: ((codex|claude|opencode|antigravity)-ask-([\w-]+))\r?\n/.exec(text);
    if (!match || match[2] !== paired.target) continue;
    const registry = readHistoryJson(join(home, "jobs.json"));
    const jobs = Array.isArray(registry) ? registry : isRecord(registry) && Array.isArray(registry.jobs) ? registry.jobs : [];
    const job = jobs.find((job2) => isRecord(job2) && job2.name === match[1]);
    if (!isRecord(job) || typeof job.startedAt !== "number" || job.startedAt < paired.at || job.startedAt > at) continue;
    recordAskCompletion(home, { id: match[3], name: match[1], startedAt: job.startedAt, finishedAt: at, status: failed ? "failed" : "done" });
  }
}
async function projectAskCompletions(path, jobs) {
  const result = [];
  for (const job of jobs) {
    if (job.status !== "running" || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.name !== "string" || !job.name.includes("-ask-")) {
      result.push(job);
      continue;
    }
    try {
      const receipt = JSON.parse(await readFile(join(dirname2(path), "ask-completions", `${job.id}-${job.startedAt}.json`), "utf8"));
      result.push(receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt && ["done", "failed", "cancelled"].includes(receipt.status) && receipt.finishedAt >= Number(job.startedAt) ? { ...job, status: receipt.status, finishedAt: receipt.finishedAt, host: null } : job);
    } catch {
      result.push(job);
    }
  }
  return result;
}
function reconcileAskCompletions(path) {
  const release = metadataFileLease(`${path}.lock`, 0, true);
  try {
    const previous = readJsonStore(path, void 0, (value) => Array.isArray(value) || isRecord(value));
    assertWritableStore(previous);
    const entries = Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : [];
    const originals = [];
    const jobs = entries.map((job) => {
      if (!isRecord(job) || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.name !== "string" || !job.name.includes("-ask-") || job.status !== "running" || typeof job.startedAt !== "number") return job;
      const receipt = readHistoryJson(join(dirname2(path), "ask-completions", `${job.id}-${job.startedAt}.json`));
      const state = readRunnerStateRecord(dirname2(path), job.id);
      const final = isRecord(receipt) && receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt ? receipt : isRecord(state) && state.startedAt === job.startedAt ? state : void 0;
      if (!final || !["done", "failed", "cancelled"].includes(String(final.status)) || typeof (final.finishedAt ?? final.updatedAt) !== "number" || Number(final.finishedAt ?? final.updatedAt) < job.startedAt) return job;
      originals.push(job);
      return {
        ...job,
        status: final.status,
        finishedAt: final.finishedAt ?? final.updatedAt,
        host: null,
        completionReceipt: { version: 1, startedAt: job.startedAt, status: final.status }
      };
    });
    if (!originals.length) return 0;
    const backup = backupPath(path);
    copyFileSync(path, backup, fsConstants.COPYFILE_EXCL);
    const fd = openSync(backup, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    archiveJobs(path, originals);
    const completedIds = new Set(originals.map((job) => job.id));
    archiveJobs(path, jobs.filter((job) => isRecord(job) && completedIds.has(job.id)));
    writeJsonStore(path, { ...isRecord(previous) ? previous : {}, jobs }, previous);
    return originals.length;
  } finally {
    release();
  }
}

export {
  readArchivedJobs,
  readArchivedJobSnapshot,
  readArchivedJobSteps,
  archiveJobs,
  recordAskCompletion,
  observeAskToolRecord,
  projectAskCompletions,
  reconcileAskCompletions
};
