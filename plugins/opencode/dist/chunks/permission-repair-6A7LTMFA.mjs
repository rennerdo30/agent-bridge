import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-L5PQRB3P.mjs";
import "./chunk-JXNLMFTJ.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-RKMKHOL4.mjs";
import "./chunk-6GDF27AR.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-7MIBCW54.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-NM74FW74.mjs";
import "./chunk-IPFZL227.mjs";
import "./chunk-TAWBNHBT.mjs";
import "./chunk-KZUHAZ7F.mjs";
import "./chunk-7SIT4IHS.mjs";
import "./chunk-KPDIPL3S.mjs";
import "./chunk-ZKCGUVI7.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-UZSY4QA2.mjs";
import "./chunk-7NCHHXYD.mjs";
import "./chunk-KGMXWURK.mjs";
import "./chunk-3MVB7JRO.mjs";
import "./chunk-AAH2UEC3.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/permission-repair.ts
async function runPermissionRepair(args, home, log, out) {
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (paths.length !== 1 || args.some((arg) => arg.startsWith("-") && !["--yes", "--dry-run"].includes(arg))) throw new Error("Usage: agent-bridge repair-permissions <folder> [--yes | --dry-run]");
  const result = await repairPermissions({ path: paths[0], home, log, apply: args.includes("--yes") && !args.includes("--dry-run") });
  out(`Permission-only scope: ${result.plan.root}; ${result.plan.paths.length} entries; ${result.plan.skipped.length} links skipped. Nothing is deleted.`);
  if (!result.result) {
    out("Dry run. Use --yes to restore inheritance, owner and full control for the current user.");
    return 0;
  }
  out(`Original ACL backup: ${result.backup}`);
  for (const entry of result.result.entries) if (!entry.ok) out(`Kept unchanged: ${entry.path}: ${entry.error}`);
  const failed = result.result.entries.filter((entry) => !entry.ok).length;
  out(`Repaired ${result.result.entries.length - failed}; failed ${failed}. No elevation was requested.`);
  return failed ? 1 : 0;
}
export {
  runPermissionRepair
};
