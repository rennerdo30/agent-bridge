import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface HistoryBudget { bytes: number; budgetBytes: number; paused: boolean; files: number; policy: "retain-and-pause" }
/** Worker-only accounting. Links and unreadable paths fail closed instead of hiding stored bytes. */
export async function historyBudget(home: string, budgetBytes: number, mirrors: string[] = []): Promise<HistoryBudget> {
  let bytes = 0, files = 0;
  const seen = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    let st;
    try { st = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (st.isSymbolicLink()) throw new Error("History budget cannot account for linked storage; import paused, data retained");
    if (st.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (st.isFile()) { bytes += st.size; files++; }
  };
  // Include WAL, indexes (inside DB pages), migration snapshots, retained backups and mirrors.
  for (const entry of await readdir(home)) if (/^history\.db(?:$|[-.])/.test(entry) || entry.startsWith("history-import-") ||
      [".migration-snapshots", "history-archive", "project-mirrors"].includes(entry)) await visit(join(home, entry));
  for (const mirror of mirrors) await visit(mirror);
  // Reserve a bounded batch plus SQLite/index overhead before admission.
  return { bytes, budgetBytes, files, paused: budgetBytes > 0 && bytes + 8 * 1024 ** 2 >= budgetBytes, policy: "retain-and-pause" };
}
