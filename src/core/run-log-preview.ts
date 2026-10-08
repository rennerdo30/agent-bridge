import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const WINDOW_BYTES = 32 * 1024;

/** Dashboard summaries and retention decisions need the header and last complete lines,
 * never a synchronous read of a growing multi-megabyte transcript. */
export function readRunLogPreview(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, count).toString("utf8");
    };
    if (size <= WINDOW_BYTES * 2) return read(0, size);
    const head = read(0, WINDOW_BYTES), tail = read(size - WINDOW_BYTES, WINDOW_BYTES);
    // Drop both partial boundary lines so a sliced/quoted finish marker cannot
    // become a new line and falsely prove completion.
    const headEnd = head.lastIndexOf("\n"), tailStart = tail.indexOf("\n");
    return `${headEnd < 0 ? "" : head.slice(0, headEnd + 1)}[... retained log ...]\n${tailStart < 0 ? "" : tail.slice(tailStart + 1)}`;
  } finally { closeSync(fd); }
}
