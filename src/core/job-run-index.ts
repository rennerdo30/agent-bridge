import { createHash } from "node:crypto";
import { appendFileSync, existsSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { APP_VERSION, REQUEST_TIMEOUT_MS } from "./constants.js";
import { fileSignature, fileTimeMs, readJsonSnapshot } from "./file-cache.js";
import { isRecord } from "./json-store.js";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { metadataFileLease } from "./metadata-file-lease.js";
import { BridgeError } from "./protocol.js";
import { readRunLogsResponsive, type RunLogRecord } from "./run-history.js";
import { safeFile } from "./transcripts/common.js";

const HEAD = "job-run-head-v1", HISTORY = "job-run-history-v1", STATE = "job-run-index-v1";
/** Completion schema. A bump makes every older completion record unready. */
const SCHEMA = 3;
type IndexedRun = RunLogRecord & { indexRoot: "runs" | "home"; legacyCandidates?: { name: string; file: string }[] };
type Completion = { version: number; failures: string; writer?: string; observedFrom?: number; completedAt?: number };
type Reobservation = { keys: Set<string>; open: boolean; work: Promise<void>; stop: AbortController };
const pending = new Map<string, { work: Promise<void>; stop: AbortController }>();
const retries = new Map<string, { timer: NodeJS.Timeout; attempt: number }>();
const invalid = new Set<string>();
const brokerHomes = new Set<string>();
const reobservations = new Map<string, Reobservation>();
const misses = new Map<string, Map<string, { generation: string; at: number }>>();
const watermarks = new Map<string, number>();
// Leave transport/dispatch headroom inside the unchanged ten-second request budget.
export const JOB_INDEX_WAIT_MS = REQUEST_TIMEOUT_MS / 2;
/** Runner, MCP and worker processes wait at most this long for a competing bridge.db writer. */
export const JOB_INDEX_BUSY_WAIT_MS = 40;
// A per-key miss is remembered for one completion generation and briefly in time,
// so a run written later by an older process is still found by a later lookup.
const MISS_TTL_MS = 30_000, MISS_LIMIT = 4_096, MTIME_SLACK_MS = 60_000;

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
/** The broker never waits on its event loop for a competing SQLite writer; other processes wait briefly. */
function busyWait(home: string): number {
  try { return brokerHomes.has(rootKey(home)) ? 0 : JOB_INDEX_BUSY_WAIT_MS; } catch { return JOB_INDEX_BUSY_WAIT_MS; }
}
function withBusyWait<T>(home: string, action: () => T): T {
  const db = metadataDb(home), wait = busyWait(home), timeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
  if (timeout === wait) return action();
  db.exec(`PRAGMA busy_timeout=${wait}`);
  try { return action(); } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}
function value(home: string, domain: string, key: string): unknown {
  return withBusyWait(home, () => {
    const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
    return row ? JSON.parse(String(row.value)) : undefined;
  });
}
function put(home: string, domain: string, key: string, record: unknown): void {
  metadataDb(home).prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(domain, key, JSON.stringify(record), Date.now());
}
function completion(home: string): Completion | undefined {
  if (invalid.has(rootKey(home)) || !existsSync(join(home, "bridge.db"))) return undefined;
  const complete = value(home, STATE, "complete");
  return isRecord(complete) && complete.version === SCHEMA && complete.failures === failureWitness(home) ? complete as Completion : undefined;
}
function ready(home: string): boolean { return completion(home) !== undefined; }
export const jobRunIndexReady = ready;
function failureWitness(home: string): string {
  const file = join(home, "job-run-index.dirty");
  try { physicalMetadataPath(file); return fileSignature(statSync(file, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none"; throw error; }
}
function transaction<T>(home: string, action: () => T): T {
  const db = metadataDb(home);
  if (db.isTransaction) return action(); // Packing already owns the single transaction.
  return withBusyWait(home, () => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
/** An auxiliary write failure must not certify unrelated, unindexed changes. */
export function invalidateJobRunIndex(home: string): void {
  const key = rootKey(home); invalid.add(key); misses.delete(key);
  // SQLite contention must not hide invalidation from another process or a
  // restart. This small receipt is append-only and never contains run data.
  // The broker never fsyncs synchronously on its event loop.
  try {
    const file = join(home, "job-run-index.dirty"); physicalMetadataPath(file);
    if (brokerHomes.has(key)) void appendFile(file, "\n", { mode: 0o600, flush: true }).catch(() => {});
    else appendFileSync(file, "\n", { mode: 0o600, flush: true });
  } catch { /* The database fence and queued repair remain independent fallbacks. */ }
  try {
    transaction(home, () => {
      put(home, STATE, "complete", false);
      put(home, STATE, "invalidated", Number(value(home, STATE, "invalidated") ?? 0) + 1);
    });
  } catch { /* Keep the local fence and retry even when SQLite itself is unavailable. */ }
  if (!pending.has(key)) scheduleRetry(home);
}
function olderWriter(writer: unknown): boolean {
  if (typeof writer !== "string") return true;
  const a = writer.split(".").map(Number), b = APP_VERSION.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (!Number.isFinite(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}
/** Broker startup owns the zero-wait SQLite policy for this home. After an upgrade it invalidates
 * once (older processes may have written runs without index rows), then starts the eager backfill. */
export function startBrokerJobRunIndex(home: string): Promise<void> {
  try {
    if (existsSync(join(home, "bridge.db"))) {
      const complete = value(home, STATE, "complete");
      if (isRecord(complete) && (complete.version !== SCHEMA || olderWriter(complete.writer))) invalidateJobRunIndex(home);
    }
  } catch { /* The backfill below reports a persistent metadata failure. */ }
  brokerHomes.add(rootKey(home));
  return startJobRunBackfill(home);
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

/** Malformed or non-object metadata stays retained in place. Like packing, it contributes no job
 * facts; because a metadata file exists the log is not filename-only evidence either, so the run
 * is recorded with no routing key. Sharing and IO failures stay retryable. */
function usableMetadata(file: string): Record<string, unknown> {
  try { const raw = readJsonSnapshot(file).value; return isRecord(raw) ? raw : {}; }
  catch (error) { if (error instanceof SyntaxError) return {}; throw error; }
}

/** Called by feed writers, archivers and discovery, so new runs and location changes need no catalog scan.
 * It records nothing on failure; each caller decides whether a failure clears readiness. */
export function indexRunFile(home: string, file: string, metadataFile = file.replace(/\.log$/, ".json")): void {
  const root = join(home, "runs"), canonical = realpathSync.native(root);
  const actual = safeFile(root, file, canonical), meta = safeFile(root, metadataFile, canonical);
  if (!actual || !meta && existsSync(metadataFile)) throw new Error("Run index requires contained log and metadata files");
  const st = statSync(actual, { bigint: true });
  if (!st.isFile()) throw new Error("Run index requires a regular run log");
  indexJobRun(home, { name: basename(file).replace(/\.log$/, ""), file: actual, metadataFile: meta ?? undefined,
    updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs), size: Number(st.size), signature: fileSignature(st),
    archived: file !== join(root, basename(file)), meta: meta ? usableMetadata(meta) : {} });
}

/** Tiny transactions amortize FULL fsync without a long SQLite busy wait.
 * Each update's history/head read+write remains in one transaction. */
async function indexObserved(home: string, key: string, runs: RunLogRecord[], signal: AbortSignal): Promise<void> {
  for (let at = 0; at < runs.length; at += 8) {
    signal.throwIfAborted();
    transaction(home, () => {
      for (const run of runs.slice(at, at + 8)) {
        if (run.metadataFile && relative(key, run.file).split(sep)[0] === "runs") indexRunFile(home, run.file, run.metadataFile);
        else indexJobRun(home, run);
      }
    });
    await yieldTurn();
  }
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
      const before = value(home, STATE, "invalidated"), failures = failureWitness(home), observedFrom = Date.now();
      const runs = await readRunLogsResponsive(home, undefined, observed => { complete = observed; }, stop.signal, true);
      await indexObserved(home, key, runs, stop.signal);
      stop.signal.throwIfAborted();
      if (!complete) throw preparing("catalog observation incomplete");
      transaction(home, () => {
        if (value(home, STATE, "invalidated") !== before || failureWitness(home) !== failures) throw preparing("unindexed writer change");
        put(home, STATE, "complete", { version: SCHEMA, failures, writer: APP_VERSION, observedFrom, completedAt: Date.now() } satisfies Completion);
      });
      invalid.delete(key); misses.delete(key); watermarks.delete(key);
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
  brokerHomes.delete(key);
  const active = [pending.get(key), reobservations.get(key)].filter(entry => entry !== undefined);
  for (const entry of active) entry.stop.abort();
  for (const entry of active) await entry.work.catch(() => {});
}
function preparing(state: string): BridgeError {
  return new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`);
}
async function bounded(work: Promise<void>, deadline: number, state: string): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw preparing(state);
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(preparing(state)), remaining); })]); }
  finally { clearTimeout(timer); }
}

function generation(home: string): string | undefined {
  const complete = completion(home);
  return complete && JSON.stringify(complete);
}
function knownMiss(home: string, root: string, ref: string): boolean {
  const entry = misses.get(root)?.get(ref);
  return entry !== undefined && performance.now() - entry.at < MISS_TTL_MS && entry.generation === generation(home);
}
function rememberMiss(root: string, ref: string, entry: { generation: string; at: number }): void {
  const byKey = misses.get(root) ?? new Map<string, { generation: string; at: number }>();
  byKey.delete(ref); byKey.set(ref, entry);
  if (byKey.size > MISS_LIMIT) byKey.delete(byKey.keys().next().value!);
  misses.set(root, byKey);
}
function metadataTime(run: RunLogRecord): number {
  if (!run.metadataFile) return 0;
  try { return statSync(run.metadataFile).mtimeMs; } catch { return Infinity; }
}
/** A ready index re-observes one unseen key without clearing global readiness: runs whose legacy
 * filename names the key, plus runs changed since the last complete observation. */
function startReobservation(home: string, root: string, ref: string): Reobservation {
  const stop = new AbortController();
  const pass: Reobservation = { keys: new Set([ref]), open: true, stop, work: Promise.resolve() };
  pass.work = (async () => {
    await yieldTurn(); // Coalesce misses that arrive in the same turn.
    pass.open = false;
    const complete = completion(home), current = complete && JSON.stringify(complete);
    if (!complete || !current) return;
    const from = Math.max(watermarks.get(root) ?? -Infinity, (complete.observedFrom ?? 0) - MTIME_SLACK_MS), began = Date.now();
    const suffixes = [...pass.keys].flatMap(key => {
      const legacy = /^(claude|codex|opencode|antigravity|muse)-(?:job|ask)-([\w-]+)$/.exec(key);
      return legacy ? [`-${legacy[1]}-${legacy[2]}`] : [];
    });
    let observed = false;
    const runs = await readRunLogsResponsive(home, undefined, value => { observed = value; }, stop.signal, true);
    await indexObserved(home, root, runs.filter(run => suffixes.some(suffix => run.name.endsWith(suffix)) ||
      run.updatedAt >= from || metadataTime(run) >= from), stop.signal);
    if (!observed || generation(home) !== current) return;
    watermarks.set(root, Math.max(from, began - MTIME_SLACK_MS));
    const at = performance.now();
    for (const key of pass.keys) if (!value(home, HEAD, key)) rememberMiss(root, key, { generation: current, at });
  })();
  reobservations.set(root, pass);
  const done = () => { if (reobservations.get(root) === pass) reobservations.delete(root); };
  void pass.work.then(done, done);
  return pass;
}
async function reobserveKey(home: string, ref: string, deadline: number): Promise<void> {
  const root = rootKey(home);
  for (;;) {
    if (value(home, HEAD, ref) || knownMiss(home, root, ref)) return;
    let pass = reobservations.get(root);
    if (pass?.open) pass.keys.add(ref);
    else if (!pass) pass = startReobservation(home, root, ref);
    // A pass that began listing before this miss cannot cover it; wait, then start a fresh one.
    const covered = pass.keys.has(ref);
    await bounded(pass.work, deadline, "reobservation running");
    if (covered) return;
  }
}

/** Waiting never cancels the shared backfill or buys a new request budget. */
export async function waitForJobRunIndex(home: string, deadline: number, ref?: string): Promise<void> {
  try {
    if (ready(home)) {
      // Older writers and imported fixtures may introduce a previously unseen key
      // after completion. A miss re-observes that key only; readiness stays.
      if (ref) await reobserveKey(home, ref, deadline);
      return;
    }
    await bounded(startJobRunBackfill(home), deadline, "backfill running");
    if (!ready(home)) throw preparing("backfill incomplete");
  } catch (error) {
    if (error instanceof BridgeError && error.code === "job_index_preparing") throw error;
    throw preparing("backfill unavailable");
  }
}

/** One indexed head read plus exact file reads. Reobserve metadata/signatures on every recovery fence.
 * Only a moved route clears readiness; a concurrent write or unreadable bytes affect this lookup alone. */
export function indexedJobRun(home: string, ref: string, startedAt?: number): RunLogRecord[] {
  let stored: IndexedRun | undefined, root: string, canonical: string, file: string | null;
  try {
    stored = value(home, HEAD, ref) as IndexedRun | undefined;
    if (!stored) return [];
    if (legacyJobRunAmbiguous(home, ref)) return [];
    root = stored.indexRoot === "runs" ? join(home, "runs") : home; canonical = realpathSync.native(root);
    file = safeFile(root, stored.file, canonical);
  } catch { throw preparing("indexed run unavailable"); }
  const metadataFile = stored.metadataFile ?? (stored.indexRoot === "runs" && existsSync(stored.file.replace(/\.log$/, ".json"))
    ? stored.file.replace(/\.log$/, ".json") : undefined);
  const metadata = metadataFile ? safeFile(root, metadataFile, canonical) : null;
  if (!file || metadataFile && !metadata) {
    // The route moved without an index update (an older writer): repair the whole index.
    invalidateJobRunIndex(home);
    throw preparing("indexed run needs reindexing");
  }
  let st: BigIntStats, meta = stored.meta;
  try {
    st = statSync(file, { bigint: true });
    let metaSignature: string | undefined;
    if (metadata) {
      const ms = statSync(metadata, { bigint: true }); metaSignature = fileSignature(ms);
      const raw = readJsonSnapshot(metadata, { file: metadata, stat: ms }).value;
      // Malformed or non-object bytes carry no job facts, so they cannot prove this key.
      if (!isRecord(raw)) return [];
      meta = raw;
    }
    if (!st.isFile() || safeFile(root, stored.file, canonical) !== file || realpathSync.native(root) !== canonical ||
        fileSignature(statSync(file, { bigint: true })) !== fileSignature(st) || metadata &&
        (safeFile(root, metadataFile!, canonical) !== metadata || fileSignature(statSync(metadata, { bigint: true })) !== metaSignature)) throw preparing("indexed files changing");
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    // A concurrent writer or transient IO fails this lookup only; the index stays ready.
    if (error instanceof BridgeError) throw error;
    throw preparing("indexed files changing");
  }
  const expected = /^(claude|codex|opencode|antigravity|muse)-(?:job|ask)-([\w-]+)$/.exec(ref);
  if (metadata ? meta.job !== ref : Object.keys(meta).length ? meta.job !== ref :
      !expected || !stored.name.endsWith(`-${expected[1]}-${expected[2]}`)) return [];
  if (meta.jobStartedAt === undefined && (stored.legacyCandidates?.filter(candidate => existsSync(candidate.file)).length ?? 0) > 1) return [];
  if (meta.jobStartedAt !== undefined && Number.isFinite(startedAt) && meta.jobStartedAt !== startedAt) return [];
  return [{ ...stored, file, meta, signature: fileSignature(st), size: Number(st.size), updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs) }];
}
/** Retained candidates distinguish real legacy log-only ambiguity from a routing head. */
export function legacyJobRunAmbiguous(home: string, ref: string): boolean {
  const stored = value(home, HEAD, ref) as IndexedRun | undefined;
  if (stored?.meta.jobStartedAt !== undefined) return false;
  return (stored?.legacyCandidates?.filter(candidate => existsSync(candidate.file)).length ?? 0) > 1;
}
