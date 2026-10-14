import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-M4TGTZAM.mjs";
import "./chunk-Z65S3WI4.mjs";
import "./chunk-EL2JUENV.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-NE6GQ2GI.mjs";
import "./chunk-PC26HO4O.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-7NH7XSAT.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-6WACHX2M.mjs";
import "./chunk-CWCDN2JJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-5US2OQUB.mjs";
import "./chunk-NU7S2DHP.mjs";
import "./chunk-G5PLFO4A.mjs";
import "./chunk-LU5OH4AB.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-4O6KB7UQ.mjs";
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
