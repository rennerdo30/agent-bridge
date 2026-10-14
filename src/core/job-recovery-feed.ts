import { open, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as yieldIO } from "node:timers/promises";

export interface RecoveryHeader { header: string; prompt: string }
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 512;
const snapshots = new Map<string, { signature: string; value: RecoveryHeader; bytes: number }>();
const pending = new Map<string, Promise<RecoveryHeader | undefined>>();
let cachedBytes = 0;
function signature(st: Stats): string { return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }

/** Preserve the exact legacy prompt, stopping at the header separator. File IO and
 * decoding yield every 64 KiB; even a very long line never repeatedly joins prefixes. */
async function scan(file: string): Promise<{ value: RecoveryHeader; signature: string }> {
  const handle = await open(file, "r");
  try {
    const identity = signature(await handle.stat()), decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024), prompt: string[] = [], fragments: string[] = [];
    let header = "", first = true, finished = false;
    const line = (text: string) => {
      if (first) { header = text; first = false; }
      else if (text.trim() === "---") finished = true;
      else prompt.push(text.replace(/^ {9}/, ""));
    };
    const consume = (text: string) => {
      let start = 0;
      while (!finished) {
        const end = text.indexOf("\n", start);
        if (end < 0) { if (start < text.length) fragments.push(text.slice(start)); break; }
        fragments.push(text.slice(start, end)); line(fragments.join("")); fragments.length = 0; start = end + 1;
      }
    };
    while (!finished) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) { consume(decoder.end()); if (!finished && fragments.length) line(fragments.join("")); break; }
      consume(decoder.write(buffer.subarray(0, bytesRead)));
      await yieldIO();
    }
    if (!finished) throw new Error("Retained run feed has no complete prompt separator");
    const value = { header, prompt: prompt.join("\n") };
    // Do not publish mixed generations if a legacy writer changed the header.
    const stable = signature(await handle.stat()) === identity && signature(await stat(file)) === identity;
    if (!stable) throw new Error("Retained run feed changed during recovery");
    return { value, signature: identity };
  } finally { await handle.close(); }
}

/** Failed/unknown reads never populate the cache: a later request retries them. */
export async function readRecoveryHeader(file: string): Promise<RecoveryHeader | undefined> {
  let identity: string;
  try { identity = signature(await stat(file)); } catch { return undefined; }
  const cached = snapshots.get(file);
  if (cached?.signature === identity) { snapshots.delete(file); snapshots.set(file, cached); return { ...cached.value }; }
  const key = `${file}\0${identity}`, active = pending.get(key);
  if (active) { const value = await active; return value ? { ...value } : undefined; }
  const read = (async () => {
    try {
      const result = await scan(file), bytes = Buffer.byteLength(result.value.header) + Buffer.byteLength(result.value.prompt);
      if (result.signature && bytes <= CACHE_BYTES) {
        const prior = snapshots.get(file); if (prior) cachedBytes -= prior.bytes;
        snapshots.delete(file); snapshots.set(file, { ...result, bytes }); cachedBytes += bytes;
        while (cachedBytes > CACHE_BYTES || snapshots.size > CACHE_ENTRIES) { const oldest = snapshots.keys().next().value!; cachedBytes -= snapshots.get(oldest)!.bytes; snapshots.delete(oldest); }
      }
      return result.value;
    } catch { return undefined; }
    finally { pending.delete(key); }
  })();
  pending.set(key, read); const value = await read; return value ? { ...value } : undefined;
}
