import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Write consumption before returning context: the broker ack can be lost during a plugin reload. */
export class ReadJournal {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "read-state");
  }

  private path(identity: string): string {
    return join(this.dir, `${createHash("sha256").update(identity).digest("hex")}.jsonl`);
  }

  read(identity: string): string[] {
    let raw: string;
    try { raw = readFileSync(this.path(identity), "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const ids: unknown = JSON.parse(line);
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      } catch { return []; } // An interrupted final append does not invalidate earlier records.
    });
  }

  append(identity: string, ids: string[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.path(identity), `\n${JSON.stringify(ids)}\n`, { mode: 0o600, flush: true });
  }
}
