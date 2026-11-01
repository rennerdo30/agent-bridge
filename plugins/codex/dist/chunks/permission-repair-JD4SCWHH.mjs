import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-OWYPTZC4.mjs";
import "./chunk-VTBALOQ6.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-6JEBVQTD.mjs";
import "./chunk-IQF4JDNE.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-R3XLUILN.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-63ALE7MW.mjs";
import "./chunk-KCELIZDL.mjs";
import "./chunk-EGBXL467.mjs";
import "./chunk-WU2EUSC5.mjs";
import "./chunk-7TGCOQY2.mjs";
import "./chunk-SIMWQAYI.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-RBBYN7QN.mjs";
import "./chunk-BA6BFOKV.mjs";
import "./chunk-K3U5YPG2.mjs";
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
