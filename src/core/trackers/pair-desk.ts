import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { formatEvent, type TrackerAdapter, type WorkItemEvent, type WorkItemRef } from "../work-items.js";

const execFileAsync = promisify(execFile);

/** Default timeout for a single `pair-desk comment` call. */
export const PAIR_DESK_TIMEOUT_MS = 15000;

export interface PairDeskAdapterOptions {
  command: string;
  timeoutMs?: number;
  /** Extra argv prepended before the fixed `comment ...` args (e.g. ["-m", "pair_desk"] for a python entry point). */
  argsPrefix?: string[];
}

/**
 * Posts work-item events via `pair-desk comment --author agent-bridge --text-file <file> -- <id>`.
 *
 * Note on Windows: `command` must be a real executable (pair-desk.exe, a
 * python path or similar). `.cmd`/`.bat` wrappers need `shell: true` with
 * execFile, which this adapter deliberately does not use (no shell), so such
 * commands are rejected with a clear error before spawning.
 */
export class PairDeskAdapter implements TrackerAdapter {
  readonly type = "pair-desk";
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly argsPrefix: string[];

  constructor(opts: PairDeskAdapterOptions) {
    this.command = opts.command;
    this.timeoutMs = opts.timeoutMs ?? PAIR_DESK_TIMEOUT_MS;
    this.argsPrefix = [...(opts.argsPrefix ?? [])];
  }

  async post(ref: WorkItemRef, event: WorkItemEvent): Promise<void> {
    if (/\.(cmd|bat)$/i.test(this.command)) {
      throw new Error(
        `pair-desk tracker command ${JSON.stringify(this.command)} must be an executable (pair-desk.exe, a python path or similar): .cmd/.bat wrappers require a shell and are not supported`,
      );
    }
    // A fresh temp dir per post, so cleanup can only delete what this call made.
    const dir = await mkdtemp(join(tmpdir(), "agent-bridge-pair-desk-"));
    const file = join(dir, "event.md");
    try {
      await writeFile(file, formatEvent(event), "utf8");
      await execFileAsync(
        this.command,
        // Options first, then "--", so the id can never be parsed as an option (e.g. a verdict).
        [...this.argsPrefix, "comment", "--author", "agent-bridge", "--text-file", file, "--", ref.id],
        { timeout: this.timeoutMs },
      );
    } finally {
      // Deletes only the temp dir created above.
      await rm(dir, { recursive: true, force: true });
    }
  }
}
