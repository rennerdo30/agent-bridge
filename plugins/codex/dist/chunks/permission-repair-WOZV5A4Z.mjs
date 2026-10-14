import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-YWJ2SGFL.mjs";
import "./chunk-24CLVBUK.mjs";
import "./chunk-B3W3QHI5.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-4KEPNGTB.mjs";
import "./chunk-PFE27QT3.mjs";
import "./chunk-EEDWAH3M.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-QPC3MXWY.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-4N7H4HNI.mjs";
import "./chunk-DZRYUILM.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-ALNAEOQM.mjs";
import "./chunk-FFMVR4KN.mjs";
import "./chunk-G5PLFO4A.mjs";
import "./chunk-FWUDSZDW.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-6KVDLO53.mjs";
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
