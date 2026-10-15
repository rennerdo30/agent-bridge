import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** A read-only view of a file's bytes: the file itself, or its retained copy in the history store (AB-383). */
export interface ByteSource {
  readonly size: number;
  read(buffer: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

/** What the history store already knows about a Claude native subagent file, derived while it was ingested. */
export interface ClaudeChildFacts { title: string | null; startedAt: number; status: "done" | "unknown" }

/** Supplies retained copies of source files. Every answer must equal what the file itself would give. */
export interface ByteSourceResolver {
  /** The retained bytes of this file, or null to read the file itself. */
  open(file: string): ByteSource | null;
  /** Head/tail facts of a fully ingested Claude subagent file; null means "compute them from the bytes". */
  claudeChild?(file: string, tailBytes: number): ClaudeChildFacts | null;
  /** True only when the store proves this fully ingested Claude transcript holds no inline sidechain record. */
  noInlineSidechains?(file: string): boolean;
}

let active: ByteSourceResolver | null = null;
let rawOpens = 0;

/** Raw source file opens through openByteSource since start; tests assert indexed reads leave it unchanged. */
export function rawSourceReads(): number { return rawOpens; }

/** Route source reads to a resolver for one synchronous call. Never spans an await. */
export function withByteSources<T>(resolver: ByteSourceResolver | null, read: () => T): T {
  if (!resolver) return read();
  const previous = active;
  active = resolver;
  try {
    const result = read();
    if (result instanceof Promise) throw new Error("withByteSources needs a synchronous reader");
    return result;
  } finally { active = previous; }
}

export function activeByteSources(): ByteSourceResolver | null { return active; }

/** The file itself, read through one descriptor. */
export function openFileSource(file: string): ByteSource {
  const fd = openSync(file, "r");
  rawOpens++;
  let size: number;
  try { size = fstatSync(fd).size; } catch (err) { closeSync(fd); throw err; }
  let open = true;
  return {
    size,
    read: (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close: () => { if (open) { open = false; closeSync(fd); } },
  };
}

/** The active resolver's retained copy when it has one, otherwise the file. Throws like openSync. */
export function openByteSource(file: string): ByteSource {
  return active?.open(file) ?? openFileSource(file);
}
