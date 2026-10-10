import { DatabaseSync } from "node:sqlite";

/** Test-only census of in-process SQLite handles (see AB-255).
 *
 * node:sqlite gives no API to enumerate open handles, and Windows reports a
 * leaked handle only as "held by this test process". The prototype hooks below
 * record every DatabaseSync instance on first use (via PRAGMA database_list)
 * and drop it on close, so a cleanup failure can name the file AND the code
 * that opened it. Worker threads have their own prototypes and are not
 * tracked: an empty census with a held file points at a worker thread.
 */
interface Entry { file: string; stack: string; ref: WeakRef<DatabaseSync> }
// Weak: the census must never keep a dropped handle (and its file) alive past garbage collection.
const entries = new WeakMap<DatabaseSync, Entry>();
const open = new Set<Entry>();

type AnyMethod = (this: DatabaseSync, ...args: never[]) => unknown;
type LooseMethod = (this: DatabaseSync, ...args: string[]) => unknown;
const proto = DatabaseSync.prototype as unknown as Record<"prepare" | "exec" | "close", AnyMethod>;
const origPrepare = proto.prepare as unknown as LooseMethod;
const origExec = proto.exec as unknown as LooseMethod;
const origClose = proto.close;

function register(db: DatabaseSync): void {
  if (entries.has(db)) return;
  let file = "<unreadable>";
  try {
    const statement = origPrepare.call(db, "PRAGMA database_list") as unknown as { all(): { name: string; file: string }[] };
    file = statement.all().find((row) => row.name === "main")?.file ?? "<unknown>";
  } catch { /* A failed open registers without a path. */ }
  const entry = { file, stack: new Error("db opened").stack ?? "", ref: new WeakRef(db) };
  entries.set(db, entry);
  open.add(entry);
}

proto.prepare = function (this: DatabaseSync, ...args: never[]): unknown {
  register(this);
  return origPrepare.apply(this, args);
};

proto.exec = function (this: DatabaseSync, ...args: never[]): unknown {
  register(this);
  return origExec.apply(this, args);
};

proto.close = function (this: DatabaseSync, ...args: never[]): unknown {
  const entry = entries.get(this);
  if (entry) { open.delete(entry); entries.delete(this); }
  return origClose.apply(this, args);
};

/** One entry per open handle: file plus the first-use call site. */
export function describeOpenDatabases(onlyUnder?: string): string {
  const lines: string[] = [];
  for (const entry of open) {
    if (!entry.ref.deref()) { open.delete(entry); continue; }
    const { file, stack } = entry;
    if (file === "") continue; // :memory:
    if (onlyUnder && !(file === onlyUnder || file.startsWith(`${onlyUnder}\\`) || file.startsWith(`${onlyUnder}/`))) continue;
    const site = stack.split("\n").slice(2, 6).join("\n");
    lines.push(`${file || "<memory>"}\n${site}`);
  }
  return lines.join("\n");
}
