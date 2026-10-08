import { readFileSync, statSync } from "node:fs";

/** Read-only parsed snapshots. Consumers must not mutate `value`; public projections clone it.
 * Validate every hit against file identity as well as time/size, including atomic replacement.
 * The budget bounds resident data without removing anything from disk.
 */
export interface JsonSnapshot { signature: string; value: unknown; bytes: number }
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const cache = new Map<string, JsonSnapshot & { bytes: number }>();
const damaged = new Map<string, { signature: string; error: SyntaxError }>();
let bytes = 0;

/** Clone JSON containers without serializing/copying large immutable prompt strings.
 * Only use for parsed JSON and JSON-shaped projections, not arbitrary class instances.
 */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneJson(item)) as T;
  if (value !== null && typeof value === "object") {
    const copied: Record<string, unknown> = {};
    // Avoid temporary entry arrays for every field in large registry projections.
    for (const key of Object.keys(value)) {
      const item = cloneJson((value as Record<string, unknown>)[key]);
      if (key === "__proto__") Object.defineProperty(copied, key, { value: item, writable: true, configurable: true, enumerable: true });
      else copied[key] = item;
    }
    return copied as T;
  }
  return value;
}

export function fileSignature(st: { size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number; ino: number; dev: number }): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}

export function readJsonSnapshot(file: string): JsonSnapshot {
  const st = statSync(file), signature = fileSignature(st);
  const failure = damaged.get(file);
  if (failure?.signature === signature) throw failure.error;
  damaged.delete(file);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file); cache.set(file, saved);
    return saved;
  }
  if (saved) { cache.delete(file); bytes -= saved.bytes; }
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    // Stable malformed bytes must not be reread at every poll. Sharing/IO failures
    // stay retryable, and a changed file identity always invalidates this witness.
    if (error instanceof SyntaxError) {
      damaged.set(file, { signature, error });
      if (damaged.size > 128) damaged.delete(damaged.keys().next().value!);
    }
    throw error;
  }
  const next = { signature, value, bytes: st.size };
  if (st.size <= MAX_BYTES) {
    cache.set(file, next); bytes += st.size;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value!;
      bytes -= cache.get(first)!.bytes; cache.delete(first);
    }
  }
  return next;
}
