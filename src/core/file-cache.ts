import { readFileSync, statSync } from "node:fs";

/** Read-only parsed snapshots. Consumers must not mutate `value`; public projections clone it.
 * Validate every hit against file identity as well as time/size, including atomic replacement.
 * The budget bounds resident data without removing anything from disk.
 */
export interface JsonSnapshot { signature: string; value: unknown; bytes: number }
// Hot dashboard/peers paths revisit every archived job and run snapshot; a budget below that
// working set evicts on every pass and turns each poll into a full synchronous reread.
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const cache = new Map<string, JsonSnapshot & { bytes: number }>();
let bytes = 0;

export function fileSignature(st: { size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number; ino: number; dev: number }): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}

export function readJsonSnapshot(file: string): JsonSnapshot {
  const st = statSync(file), signature = fileSignature(st);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file); cache.set(file, saved);
    return saved;
  }
  if (saved) { cache.delete(file); bytes -= saved.bytes; }
  const next = { signature, value: JSON.parse(readFileSync(file, "utf8")) as unknown, bytes: st.size };
  if (st.size <= MAX_BYTES) {
    cache.set(file, next); bytes += st.size;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value!;
      bytes -= cache.get(first)!.bytes; cache.delete(first);
    }
  }
  return next;
}
