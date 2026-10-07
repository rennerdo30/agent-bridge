import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-AKFVL2XA.mjs";
import "./chunk-EIBZH3O5.mjs";
import "./chunk-IPKKN3K5.mjs";
import "./chunk-7AVTRJEE.mjs";
import "./chunk-XDKYTCHM.mjs";
import "./chunk-GZUPJ35X.mjs";
import "./chunk-65JBLLER.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-QN2BR77F.mjs";
import "./chunk-SOPZATYP.mjs";
import "./chunk-H2JCI6FF.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-VNX2WF5E.mjs";
import "./chunk-TPCM6ZR4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-SKREW3F6.mjs";
import "./chunk-6PRX5EOQ.mjs";
import "./chunk-HHAVWD7J.mjs";

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
