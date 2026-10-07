import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface ContextEvent {
  kind: "progress" | "report" | "approval";
  agent: string;
  job?: string;
  session?: string;
  project?: string;
  at?: number;
  payload: unknown;
}
const writes = new Map<string, Promise<void>>();
/** A new versioned append-only spool; SQLite writes are deferred to the elected worker. */
export async function appendContextEvent(
  home: string,
  event: ContextEvent,
): Promise<void> {
  const dir = join(home, "context-events");
  const file = join(
    dir,
    `${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`,
  );
  const write = (writes.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const fd = await open(file, "wx", 0o600);
        try {
          await fd.writeFile('{"version":1,"format":"context-events"}\n');
          await fd.sync();
        } finally {
          await fd.close();
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      await appendFile(
        file,
        JSON.stringify({ ...event, at: event.at ?? Date.now() }) + "\n",
      );
      const fd = await open(file, "a");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    });
  writes.set(file, write);
  try {
    await write;
  } finally {
    if (writes.get(file) === write) writes.delete(file);
  }
}
