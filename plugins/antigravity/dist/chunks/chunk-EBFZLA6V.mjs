import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/history-budget.ts
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
var HISTORY_BATCH_RESERVE_BYTES = 8 * 1024 ** 2;
var HistoryBudgetAdmission = class {
  constructor(scan) {
    this.scan = scan;
  }
  scan;
  sample = null;
  charged = 0;
  activeCharge = null;
  sampledAtCharge = 0;
  scanning = null;
  refresh() {
    if (this.scanning) return this.scanning;
    const startedAtCharge = this.activeCharge === null ? this.charged : this.activeCharge - HISTORY_BATCH_RESERVE_BYTES;
    this.scanning = Promise.resolve().then(this.scan).then((sample) => {
      if (!Number.isSafeInteger(sample.bytes) || sample.bytes < 0 || !Number.isSafeInteger(sample.budgetBytes) || sample.budgetBytes < 0)
        throw new Error("History budget sample is invalid; import paused, data retained");
      this.sample = sample;
      this.sampledAtCharge = startedAtCharge;
      return sample;
    }).catch((error) => {
      this.sample = null;
      throw error;
    }).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }
  paused(budgetBytes) {
    return !this.sample || this.sample.budgetBytes !== budgetBytes || this.sample.paused || !Number.isSafeInteger(this.charged + HISTORY_BATCH_RESERVE_BYTES) || budgetBytes > 0 && this.sample.bytes + this.charged - this.sampledAtCharge + HISTORY_BATCH_RESERVE_BYTES >= budgetBytes;
  }
  async admit(budgetBytes) {
    if (this.paused(budgetBytes)) await this.refresh();
    if (this.paused(budgetBytes)) return false;
    this.charged += HISTORY_BATCH_RESERVE_BYTES;
    this.activeCharge = this.charged;
    return true;
  }
  complete() {
    this.activeCharge = null;
  }
};
async function historyBudget(home, budgetBytes, mirrors = []) {
  let bytes = 0, files = 0;
  const seen = /* @__PURE__ */ new Set();
  const visit = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    let st;
    try {
      st = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (st.isSymbolicLink()) throw new Error("History budget cannot account for linked storage; import paused, data retained");
    if (st.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (st.isFile()) {
      bytes += st.size;
      files++;
    }
  };
  for (const entry of await readdir(home)) if (/^history\.db(?:$|[-.])/.test(entry) || entry.startsWith("history-import-") || ["history-archive", "project-mirrors"].includes(entry)) await visit(join(home, entry));
  for (const mirror of mirrors) await visit(mirror);
  return { bytes, budgetBytes, files, paused: budgetBytes > 0 && bytes + HISTORY_BATCH_RESERVE_BYTES >= budgetBytes, policy: "retain-and-pause" };
}

export {
  HistoryBudgetAdmission,
  historyBudget
};
