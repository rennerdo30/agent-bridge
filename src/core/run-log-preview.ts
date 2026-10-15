import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileSignature } from "./file-cache.js";
import { activeByteSources } from "./byte-source.js";

const WINDOW_BYTES = 32 * 1024;

/** Dashboard summaries and retention decisions need the header and last complete lines,
 * never a synchronous read of a growing multi-megabyte transcript. */
export function readRunLogPreview(file: string, expectedSignature?: string): string {
  // A fully ingested log is read from its retained copy in history.db when a dashboard read routes it there (AB-383).
  const retained = activeByteSources()?.open(file);
  if (retained) {
    try { return previewOf(retained.size, (buffer, position) => retained.read(buffer, 0, buffer.length, position)); }
    finally { retained.close(); }
  }
  const fd = openSync(file, "r");
  try {
    const witnessed = fstatSync(fd, { bigint: true });
    if (!witnessed.isFile() || expectedSignature !== undefined && fileSignature(witnessed) !== expectedSignature)
      throw new Error("run log changed before its preview read");
    return previewOf(Number(witnessed.size), (buffer, position) => readSync(fd, buffer, 0, buffer.length, position));
  } finally { closeSync(fd); }
}

function previewOf(size: number, readAt: (buffer: Buffer, position: number) => number): string {
  const read = (position: number, length: number) => {
    const buffer = Buffer.alloc(length);
    const count = readAt(buffer, position);
    return buffer.subarray(0, count).toString("utf8");
  };
  if (size <= WINDOW_BYTES * 2) return read(0, size);
  const head = read(0, WINDOW_BYTES), tail = read(size - WINDOW_BYTES, WINDOW_BYTES);
  // Drop both partial boundary lines so a sliced/quoted finish marker cannot
  // become a new line and falsely prove completion.
  const headEnd = head.lastIndexOf("\n"), tailStart = tail.indexOf("\n");
  return `${headEnd < 0 ? "" : head.slice(0, headEnd + 1)}[... retained log ...]\n${tailStart < 0 ? "" : tail.slice(tailStart + 1)}`;
}
