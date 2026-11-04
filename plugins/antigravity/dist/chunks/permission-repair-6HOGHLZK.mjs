import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-6SQS7L3A.mjs";
import "./chunk-JK3TYY7G.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-DWQBRZGB.mjs";
import "./chunk-S34KX23Z.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-4VXELNJD.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-NM74FW74.mjs";
import "./chunk-KQ7NKBC4.mjs";
import "./chunk-YOEUT2KG.mjs";
import "./chunk-QQ5RWAUC.mjs";
import "./chunk-7SIT4IHS.mjs";
import "./chunk-GRM4AKTE.mjs";
import "./chunk-MOQBNRQQ.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-KG7DR45B.mjs";
import "./chunk-7NCHHXYD.mjs";
import "./chunk-6LM3CELI.mjs";
import "./chunk-BSOFWTS3.mjs";
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
