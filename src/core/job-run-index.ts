import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { REQUEST_TIMEOUT_MS } from "./constants.js";
import { fileSignature, fileTimeMs, readJsonSnapshot } from "./file-cache.js";
import { isRecord } from "./json-store.js";
import { metadataDb } from "./metadata-db.js";
import { metadataFileLease } from "./metadata-file-lease.js";
import { BridgeError } from "./protocol.js";
import { readRunLogsResponsive, type RunLogRecord } from "./run-history.js";
import { safeFile } from "./transcripts/common.js";

const HEAD = "job-run-head-v1", HISTORY = "job-run-history-v1", STATE = "job-run-index-v1";
type IndexedRun = RunLogRecord & { indexRoot: "runs" | "home" };
const pending = new Map<string, { work: Promise<void>; stop: AbortController }>();
// Leave transport/dispatch headroom inside the unchanged ten-second request budget.
export const JOB_INDEX_WAIT_MS = REQUEST_TIMEOUT_MS / 2;

function rootKey(home: string): string { return realpathSync.native(home); }
function roots(home: string): string {
  return [join(home, "runs"), join(home, "runs", "archive")].map(path => {
    try { return `${realpathSync.native(path)}:${fileSignature(statSync(path, { bigint: true }))}`; }
    catch { return "missing"; }
  }).join("|");
}
function start(run: RunLogRecord): number {
  if (Number.isFinite(run.meta.jobStartedAt)) return run.meta.jobStartedAt!;
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : run.updatedAt;
}
function keys(run: RunLogRecord): string[] {
  const out = typeof run.meta.job === "string" ? [run.meta.job] : [];
  const match = /-(claude|codex|opencode|antigravity|muse)-([\w-]+)$/.exec(run.name);
  if (match) out.push(`${match[1]}-job-${match[2]}`, `${match[1]}-ask-${match[2]}`);
  return [...new Set(out)];
}
function value(home: string, domain: string, key: string): unknown {
  const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
  return row ? JSON.parse(String(row.value)) : undefined;
}
function put(home: string, domain: string, key: string, record: unknown): void {
  metadataDb(home).prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(domain, key, JSON.stringify(record), Date.now());
}
function ready(home: string): boolean { return existsSync(join(home, "bridge.db")) && value(home, STATE, "complete") === roots(home); }
export const jobRunIndexReady = ready;
export function markJobRunIndexReady(home: string): void { put(home, STATE, "complete", roots(home)); }

/** Append every distinct observation; replace only a routing head, never retained evidence or source files. */
export function indexJobRun(home: string, run: RunLogRecord): void {
  // Packing retains malformed metadata bytes too; they contribute no job facts.
  run = { ...run, meta: isRecord(run.meta) ? run.meta : {} };
  const json = JSON.stringify(run), digest = createHash("sha256").update(json).digest("hex");
  const db = metadataDb(home);
  db.prepare("INSERT OR IGNORE INTO bridge_metadata VALUES (?,?,?,?)").run(HISTORY, digest, json, Date.now());
  for (const key of keys(run)) {
    const previous = value(home, HEAD, key) as RunLogRecord | undefined;
    if (!previous || start(run) > start(previous) || start(run) === start(previous) &&
        (run.name === previous.name || run.updatedAt >= previous.updatedAt)) put(home, HEAD, key, {
          ...run, indexRoot: relative(rootKey(home), run.file).split(sep)[0] === "runs" ? "runs" : "home",
        });
  }
}

/** Called by feed writers and archivers, so new runs and location changes need no catalog scan. */
export function indexRunFile(home: string, file: string, metadataFile = file.replace(/\.log$/, ".json")): void {
  const wasReady = ready(home);
  const root = join(home, "runs"), canonical = realpathSync.native(root);
  const actual = safeFile(root, file, canonical), meta = safeFile(root, metadataFile, canonical);
  if (!actual || !meta && existsSync(metadataFile)) throw new Error("Run index requires contained log and metadata files");
  const st = statSync(actual, { bigint: true }), raw = meta ? readJsonSnapshot(meta).value : {};
  if (!st.isFile() || !isRecord(raw)) throw new Error("Run index requires intact run metadata");
  indexJobRun(home, { name: basename(file).replace(/\.log$/, ""), file: actual, metadataFile: meta ?? undefined,
    updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs), size: Number(st.size), signature: fileSignature(st),
    archived: file !== join(root, basename(file)), meta: raw });
  if (wasReady) put(home, STATE, "complete", roots(home));
}

/** One eager, shared background operation per broker home. Partial observations are durable;
 * a crash simply resumes idempotent upserts. No source bytes are moved or removed by backfill. */
export function startJobRunBackfill(home: string): Promise<void> {
  const key = rootKey(home), active = pending.get(key);
  if (active) return active.work;
  const stop = new AbortController();
  const work = (async () => {
    await yieldTurn(); // Never discover a catalog inline in a request handler.
    stop.signal.throwIfAborted();
    if (ready(home)) return;
    // The broker and a fallback MCP reader may live in different processes.
    // Share the existing crash-recoverable, archive-on-release lease protocol.
    let release: (() => void) | undefined;
    while (!release) {
      stop.signal.throwIfAborted();
      if (ready(home)) return;
      try { release = metadataFileLease(join(key, "job-run-index.lease"), 0, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELEASEBUSY") throw error;
        await delay(250, undefined, { signal: stop.signal });
      }
    }
    try {
      if (ready(home)) return;
      let complete = false;
      const before = roots(home), runs = await readRunLogsResponsive(home, undefined, observed => { complete = observed; }, stop.signal);
      for (let at = 0; at < runs.length; at += 32) {
        stop.signal.throwIfAborted();
        const db = metadataDb(home);
        db.exec("BEGIN IMMEDIATE");
        try { for (const run of runs.slice(at, at + 32)) indexJobRun(home, run); db.exec("COMMIT"); }
        catch (error) { db.exec("ROLLBACK"); throw error; }
        await yieldTurn();
      }
      stop.signal.throwIfAborted();
      if (roots(home) !== before) throw preparing("catalog changed during backfill");
      if (!complete) throw preparing("catalog observation incomplete");
      put(home, STATE, "complete", before);
    } finally { release(); }
  })();
  pending.set(key, { work, stop });
  void work.then(() => pending.delete(key), () => pending.delete(key));
  return work;
}
/** Broker shutdown stops discovery between bounded scan/batch steps before closing metadata handles. */
export async function stopJobRunBackfill(home: string): Promise<void> {
  const active = pending.get(rootKey(home));
  if (!active) return;
  active.stop.abort();
  await active.work.catch(() => {});
}
function preparing(state: string): BridgeError {
  return new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`);
}

/** Waiting never cancels the shared backfill or buys a new request budget. */
export async function waitForJobRunIndex(home: string, deadline: number): Promise<void> {
  if (ready(home)) return;
  const work = startJobRunBackfill(home), remaining = deadline - performance.now();
  if (remaining <= 0) throw preparing("backfill running");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(preparing("backfill running")), remaining); })]);
  } finally { clearTimeout(timer); }
  if (!ready(home)) throw preparing("backfill incomplete");
}

/** One indexed head read plus exact file reads. Reobserve metadata/signatures on every recovery fence. */
export function indexedJobRun(home: string, ref: string): RunLogRecord[] {
  const stored = value(home, HEAD, ref) as IndexedRun | undefined;
  if (!stored) return [];
  const root = stored.indexRoot === "runs" ? join(home, "runs") : home, canonical = realpathSync.native(root);
  const file = safeFile(root, stored.file, canonical);
  if (!file) throw preparing("indexed run location unavailable");
  const st = statSync(file, { bigint: true });
  let meta = stored.meta, metaSignature: string | undefined, metadata: string | null = null;
  if (stored.metadataFile) {
    metadata = safeFile(root, stored.metadataFile, canonical);
    if (!metadata) throw preparing("indexed metadata unavailable");
    const ms = statSync(metadata, { bigint: true }); metaSignature = fileSignature(ms);
    const raw = readJsonSnapshot(metadata, { file: metadata, stat: ms }).value;
    if (!isRecord(raw)) throw preparing("indexed metadata unreadable");
    meta = raw;
  }
  if (!st.isFile() || safeFile(root, stored.file, canonical) !== file || realpathSync.native(root) !== canonical ||
      fileSignature(statSync(file, { bigint: true })) !== fileSignature(st) || metadata &&
      (safeFile(root, stored.metadataFile!, canonical) !== metadata || fileSignature(statSync(metadata, { bigint: true })) !== metaSignature)) throw preparing("indexed files changed");
  return [{ ...stored, file, meta, signature: fileSignature(st), size: Number(st.size), updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs) }];
}
