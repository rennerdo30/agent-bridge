import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface HistoryBudget { bytes: number; budgetBytes: number; paused: boolean; files: number; policy: "retain-and-pause" }
export const HISTORY_BATCH_RESERVE_BYTES = 8 * 1024 ** 2;

/** Full accounting is off the live-capture path while conservatively reserved
 * headroom remains. Debits made during a scan are also charged to its result:
 * a slow walk cannot accidentally forgive concurrent ingestion. */
export class HistoryBudgetAdmission {
  private sample: HistoryBudget | null = null;
  private charged = 0;
  private activeCharge: number | null = null;
  private sampledAtCharge = 0;
  private scanning: Promise<HistoryBudget> | null = null;
  constructor(private readonly scan: () => Promise<HistoryBudget>) {}
  refresh(): Promise<HistoryBudget> {
    if (this.scanning) return this.scanning;
    // A tick may have reserved its bytes but not written them when the scan
    // starts. Carry that whole outstanding reservation into the new sample too.
    const startedAtCharge = this.activeCharge === null ? this.charged : this.activeCharge - HISTORY_BATCH_RESERVE_BYTES;
    this.scanning = Promise.resolve().then(this.scan).then(sample => {
      if (!Number.isSafeInteger(sample.bytes) || sample.bytes < 0 || !Number.isSafeInteger(sample.budgetBytes) || sample.budgetBytes < 0)
        throw new Error("History budget sample is invalid; import paused, data retained");
      this.sample = sample; this.sampledAtCharge = startedAtCharge;
      return sample;
    }).catch(error => { this.sample = null; throw error; }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
  private paused(budgetBytes: number): boolean {
    return !this.sample || this.sample.budgetBytes !== budgetBytes || this.sample.paused ||
      !Number.isSafeInteger(this.charged + HISTORY_BATCH_RESERVE_BYTES) ||
      budgetBytes > 0 && this.sample.bytes + this.charged - this.sampledAtCharge + HISTORY_BATCH_RESERVE_BYTES >= budgetBytes;
  }
  async admit(budgetBytes: number): Promise<boolean> {
    if (this.paused(budgetBytes)) await this.refresh();
    // A changed configuration is never admitted against an older quota sample.
    if (this.paused(budgetBytes)) return false;
    this.charged += HISTORY_BATCH_RESERVE_BYTES;
    this.activeCharge = this.charged;
    return true;
  }
  complete(): void { this.activeCharge = null; }
}
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
  // Include WAL, indexes (inside DB pages), retained archives and mirrors. Migration snapshots are temporary
  // copies of the legacy store; counting them would stop the very migration that makes them removable.
  for (const entry of await readdir(home)) if (/^history\.db(?:$|[-.])/.test(entry) || entry.startsWith("history-import-") ||
      ["history-archive", "project-mirrors"].includes(entry)) await visit(join(home, entry));
  for (const mirror of mirrors) await visit(mirror);
  // Reserve a bounded batch plus SQLite/index overhead before admission.
  return { bytes, budgetBytes, files, paused: budgetBytes > 0 && bytes + HISTORY_BATCH_RESERVE_BYTES >= budgetBytes, policy: "retain-and-pause" };
}
