import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/history-budget.ts
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  return { bytes, budgetBytes, files, paused: budgetBytes > 0 && bytes + 8 * 1024 ** 2 >= budgetBytes, policy: "retain-and-pause" };
}

export {
  historyBudget
};
