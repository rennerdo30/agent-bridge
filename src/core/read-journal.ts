import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { storageLease } from "./storage-lock.js";

/** Write consumption before returning context: the broker ack can be lost during a plugin reload. */
export class ReadJournal {
  private readonly dir: string;

  constructor(private readonly home: string) {
    this.dir = join(home, "read-state");
  }

  private path(identity: string): string {
    return join(this.dir, `${createHash("sha256").update(identity).digest("hex")}.jsonl`);
  }

  read(identity: string): string[] {
    return this.entries(identity).flatMap((entry) => entry.ids);
  }

  receipt(identity: string, id: string): { read: boolean; at: number | null } {
    const entries = this.entries(identity).filter((entry) => entry.ids.includes(id));
    const times = entries.flatMap((entry) => entry.at === null ? [] : [entry.at]);
    return { read: entries.length > 0, at: times.length ? Math.min(...times) : null };
  }

  private entries(identity: string): { ids: string[]; at: number | null }[] {
    let raw: string;
    try { raw = readFileSync(this.path(identity), "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const value: unknown = JSON.parse(line);
        const timed = value && typeof value === "object" && !Array.isArray(value) ? value as { ids?: unknown; at?: unknown } : null;
        const ids = timed?.ids ?? value;
        return Array.isArray(ids) ? [{ ids: ids.filter((id): id is string => typeof id === "string"), at: typeof timed?.at === "number" ? timed.at : null }] : [];
      } catch { return []; } // An interrupted final append does not invalidate earlier records.
    });
  }

  append(identity: string, ids: string[]): void {
    const release = storageLease(this.home);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.path(identity), `\n${JSON.stringify({ ids, at: Date.now() })}\n`, { mode: 0o600, flush: true });
    } finally { release(); }
  }
}
