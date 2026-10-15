import { createHash } from "node:crypto";
import { appendFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { REQUEST_TIMEOUT_MS } from "./constants.js";
import { fileSignature, fileTimeMs, readJsonSnapshot } from "./file-cache.js";
import { isRecord } from "./json-store.js";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { metadataFileLease } from "./metadata-file-lease.js";
import { BridgeError } from "./protocol.js";
import { readRunLogsResponsive, type RunLogRecord } from "./run-history.js";
import { safeFile } from "./transcripts/common.js";

const HEAD = "job-run-head-v1", HISTORY = "job-run-history-v1", STATE = "job-run-index-v1";
type IndexedRun = RunLogRecord & { indexRoot: "runs" | "home"; legacyCandidates?: { name: string; file: string }[] };
const pending = new Map<string, { work: Promise<void>; stop: AbortController }>();
const retries = new Map<string, { timer: NodeJS.Timeout; attempt: number }>();
const invalid = new Set<string>();
// Leave transport/dispatch headroom inside the unchanged ten-second request budget.
export const JOB_INDEX_WAIT_MS = REQUEST_TIMEOUT_MS / 2;

function rootKey(home: string): string { return realpathSync.native(home); }
function start(run: RunLogRecord): number {
  if (Number.isFinite(run.meta.jobStartedAt)) return run.meta.jobStartedAt!;
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : run.updatedAt;
}
function keys(run: RunLogRecord): string[] {
  if (typeof run.meta.job === "string") return [run.meta.job];
  // A filename is evidence only for a log without metadata.
  if (run.metadataFile || Object.keys(run.meta).length) return [];
  const out: string[] = [];
  const match = /-(claude|codex|opencode|antigravity|muse)-([\w-]+)$/.exec(run.name);
  if (match) out.push(`${match[1]}-job-${match[2]}`, `${match[1]}-ask-${match[2]}`);
  return [...new Set(out)];
}
function value(home: string, domain: string, key: string): unknown {
  const db = metadataDb(home), timeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
  if (timeout) db.exec("PRAGMA busy_timeout=0");
  try {
    const row = db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
    return row ? JSON.parse(String(row.value)) : undefined;
  } finally { if (timeout) db.exec(`PRAGMA busy_timeout=${timeout}`); }
}
function put(home: string, domain: string, key: string, record: unknown): void {
  metadataDb(home).prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(domain, key, JSON.stringify(record), Date.now());
}
function ready(home: string): boolean {
  if (invalid.has(rootKey(home)) || !existsSync(join(home, "bridge.db"))) return false;
  const complete = value(home, STATE, "complete");
  return isRecord(complete) && complete.version === 2 && complete.failures === failureWitness(home);
}
export const jobRunIndexReady = ready;
function failureWitness(home: string): string {
  const file = join(home, "job-run-index.dirty");
  try { physicalMetadataPath(file); return fileSignature(statSync(file, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none"; throw error; }
}
function transaction<T>(home: string, action: () => T): T {
  const db = metadataDb(home);
  if (db.isTransaction) return action(); // Packing already owns the single transaction.
  const timeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
  // Never spend the broker's dashboard interval waiting for a competing writer.
  db.exec("PRAGMA busy_timeout=0");
  try {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}
/** An auxiliary write failure must not certify unrelated, unindexed changes. */
export function invalidateJobRunIndex(home: string): void {
  const key = rootKey(home); invalid.add(key);
  // SQLite contention must not hide invalidation from another process or a
  // restart. This small receipt is append-only and never contains run data.
  try {
    const file = join(home, "job-run-index.dirty"); physicalMetadataPath(file);
    appendFileSync(file, "\n", { mode: 0o600, flush: true });
  } catch { /* The database fence and queued repair remain independent fallbacks. */ }
  try {
    transaction(home, () => {
      put(home, STATE, "complete", false);
      put(home, STATE, "invalidated", Number(value(home, STATE, "invalidated") ?? 0) + 1);
    });
  } catch { /* Keep the local fence and retry even when SQLite itself is unavailable. */ }
  if (!pending.has(key)) scheduleRetry(home);
}
function scheduleRetry(home: string, attempt = 0): void {
  let key: string;
  try { key = rootKey(home); } catch { return; } // Removed isolated homes have no repair work.
  if (retries.has(key)) return;
  const timer = setTimeout(() => {
    retries.delete(key);
    void Promise.resolve().then(() => startJobRunBackfill(home, attempt + 1)).catch(() => {});
  }, Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)));
  timer.unref(); retries.set(key, { timer, attempt });
}
function routingFacts(run: RunLogRecord): string {
  return JSON.stringify([run.name, run.file, run.metadataFile ?? null, run.meta.job ?? null, run.meta.jobStartedAt ?? null]);
}

/** Append every distinct observation; replace only a routing head, never retained evidence or source files. */
export function indexJobRun(home: string, run: RunLogRecord): void {
  // Packing retains malformed metadata bytes too; they contribute no job facts.
  run = { ...run, meta: isRecord(run.meta) ? run.meta : {} };
  const json = JSON.stringify(run), digest = createHash("sha256").update(routingFacts(run)).digest("hex");
  const db = metadataDb(home);
  transaction(home, () => {
  if (!value(home, HISTORY, digest)) db.prepare("INSERT OR IGNORE INTO bridge_metadata VALUES (?,?,?,?)").run(HISTORY, digest, json, Date.now());
  for (const key of keys(run)) {
    const previous = value(home, HEAD, key) as IndexedRun | undefined;
    if (previous && routingFacts(previous) === routingFacts(run)) continue;
    const candidates = [...(previous?.legacyCandidates ?? (previous ? [{ name: previous.name, file: previous.file }] : []))];
    if (!candidates.some(candidate => candidate.file === run.file)) candidates.push({ name: run.name, file: run.file });
    const replace = !previous || start(run) > start(previous) || start(run) === start(previous) &&
      (run.name === previous.name || run.updatedAt >= previous.updatedAt);
    const head = replace ? run : previous!;
    const next = { ...head, indexRoot: relative(rootKey(home), head.file).split(sep)[0] === "runs" ? "runs" : "home", legacyCandidates: candidates };
    if (JSON.stringify(previous) !== JSON.stringify(next)) put(home, HEAD, key, next);
  }
  });
}

/** Called by feed writers and archivers, so new runs and location changes need no catalog scan. */
export function indexRunFile(home: string, file: string, metadataFile = file.replace(/\.log$/, ".json")): void {
  try {
  const root = join(home, "runs"), canonical = realpathSync.native(root);
  const actual = safeFile(root, file, canonical), meta = safeFile(root, metadataFile, canonical);
  if (!actual || !meta && existsSync(metadataFile)) throw new Error("Run index requires contained log and metadata files");
  const st = statSync(actual, { bigint: true }), raw = meta ? readJsonSnapshot(meta).value : {};
  if (!st.isFile() || !isRecord(raw)) throw new Error("Run index requires intact run metadata");
  indexJobRun(home, { name: basename(file).replace(/\.log$/, ""), file: actual, metadataFile: meta ?? undefined,
    updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs), size: Number(st.size), signature: fileSignature(st),
    archived: file !== join(root, basename(file)), meta: raw });
  } catch (error) { invalidateJobRunIndex(home); throw error; }
}

/** One eager, shared background operation per broker home. Partial observations are durable;
 * a crash simply resumes idempotent upserts. No source bytes are moved or removed by backfill. */
export function startJobRunBackfill(home: string, attempt = 0): Promise<void> {
  const key = rootKey(home), active = pending.get(key);
  if (active) return active.work;
  const retry = retries.get(key); if (retry) { clearTimeout(retry.timer); retries.delete(key); }
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
      const before = value(home, STATE, "invalidated"), failures = failureWitness(home);
      const runs = await readRunLogsResponsive(home, undefined, observed => { complete = observed; }, stop.signal, true);
      for (let at = 0; at < runs.length; at += 8) {
        stop.signal.throwIfAborted();
        // Tiny transactions amortize FULL fsync without a long SQLite busy wait.
        // Each update's history/head read+write remains in one transaction.
        transaction(home, () => {
          for (const run of runs.slice(at, at + 8)) {
            if (run.metadataFile && relative(key, run.file).split(sep)[0] === "runs") indexRunFile(home, run.file, run.metadataFile);
            else indexJobRun(home, run);
          }
        });
        await yieldTurn();
      }
      stop.signal.throwIfAborted();
      if (!complete) throw preparing("catalog observation incomplete");
      transaction(home, () => {
        if (value(home, STATE, "invalidated") !== before || failureWitness(home) !== failures) throw preparing("unindexed writer change");
        put(home, STATE, "complete", { version: 2, failures });
      });
      invalid.delete(key);
    } finally { release(); }
  })();
  pending.set(key, { work, stop });
  void work.then(() => pending.delete(key), () => { pending.delete(key); if (!stop.signal.aborted) scheduleRetry(home, attempt); });
  return work;
}
/** Broker shutdown stops discovery between bounded scan/batch steps before closing metadata handles. */
export async function stopJobRunBackfill(home: string): Promise<void> {
  const key = rootKey(home), retry = retries.get(key);
  if (retry) { clearTimeout(retry.timer); retries.delete(key); }
  const active = pending.get(key);
  if (!active) return;
  active.stop.abort();
  await active.work.catch(() => {});
}
function preparing(state: string): BridgeError {
  return new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`);
}

/** Waiting never cancels the shared backfill or buys a new request budget. */
export async function waitForJobRunIndex(home: string, deadline: number, ref?: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (ready(home)) {
      if (!ref || value(home, HEAD, ref)) return;
      // Older writers and imported fixtures may introduce a previously unseen
      // key after completion. A miss gets one bounded reobservation, never a
      // permanently ready negative cache.
      invalidateJobRunIndex(home);
    }
    const work = startJobRunBackfill(home), remaining = deadline - performance.now();
    if (remaining <= 0) throw preparing("backfill running");
    await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(preparing("backfill running")), remaining); })]);
    if (!ready(home)) throw preparing("backfill incomplete");
  } catch (error) {
    if (error instanceof BridgeError && error.code === "job_index_preparing") throw error;
    throw preparing("backfill unavailable");
  } finally { clearTimeout(timer); }
}

/** One indexed head read plus exact file reads. Reobserve metadata/signatures on every recovery fence. */
export function indexedJobRun(home: string, ref: string, startedAt?: number): RunLogRecord[] {
  try {
  const stored = value(home, HEAD, ref) as IndexedRun | undefined;
  if (!stored) return [];
  if (legacyJobRunAmbiguous(home, ref)) return [];
  const root = stored.indexRoot === "runs" ? join(home, "runs") : home, canonical = realpathSync.native(root);
  const file = safeFile(root, stored.file, canonical);
  if (!file) throw preparing("indexed run location unavailable");
  const st = statSync(file, { bigint: true });
  let meta = stored.meta, metaSignature: string | undefined, metadata: string | null = null;
  const metadataFile = stored.metadataFile ?? (stored.indexRoot === "runs" && existsSync(stored.file.replace(/\.log$/, ".json"))
    ? stored.file.replace(/\.log$/, ".json") : undefined);
  if (metadataFile) {
    metadata = safeFile(root, metadataFile, canonical);
    if (!metadata) throw preparing("indexed metadata unavailable");
    const ms = statSync(metadata, { bigint: true }); metaSignature = fileSignature(ms);
    const raw = readJsonSnapshot(metadata, { file: metadata, stat: ms }).value;
    if (!isRecord(raw)) throw preparing("indexed metadata unreadable");
    meta = raw;
  }
  if (!st.isFile() || safeFile(root, stored.file, canonical) !== file || realpathSync.native(root) !== canonical ||
      fileSignature(statSync(file, { bigint: true })) !== fileSignature(st) || metadata &&
      (safeFile(root, metadataFile!, canonical) !== metadata || fileSignature(statSync(metadata, { bigint: true })) !== metaSignature)) throw preparing("indexed files changed");
  const expected = /^(claude|codex|opencode|antigravity|muse)-(?:job|ask)-([\w-]+)$/.exec(ref);
  if (metadata ? meta.job !== ref : Object.keys(meta).length ? meta.job !== ref :
      !expected || !stored.name.endsWith(`-${expected[1]}-${expected[2]}`)) return [];
  if (meta.jobStartedAt === undefined && (stored.legacyCandidates?.filter(candidate => existsSync(candidate.file)).length ?? 0) > 1) return [];
  if (meta.jobStartedAt !== undefined && Number.isFinite(startedAt) && meta.jobStartedAt !== startedAt) return [];
  return [{ ...stored, file, meta, signature: fileSignature(st), size: Number(st.size), updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs) }];
  } catch {
    invalidateJobRunIndex(home);
    throw preparing("indexed run needs reindexing");
  }
}
/** Retained candidates distinguish real legacy log-only ambiguity from a routing head. */
export function legacyJobRunAmbiguous(home: string, ref: string): boolean {
  const stored = value(home, HEAD, ref) as IndexedRun | undefined;
  if (stored?.meta.jobStartedAt !== undefined) return false;
  return (stored?.legacyCandidates?.filter(candidate => existsSync(candidate.file)).length ?? 0) > 1;
}
