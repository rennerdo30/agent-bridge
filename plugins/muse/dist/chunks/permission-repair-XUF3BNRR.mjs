import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-3BLJYLHJ.mjs";
import "./chunk-RQVG3DTE.mjs";
import "./chunk-YXP3D4N7.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-QE5Y5JCD.mjs";
import "./chunk-2UCPNPKV.mjs";
import "./chunk-BEZD7FHM.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-GT6BLZHK.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-VXKZ7TFV.mjs";
import "./chunk-4S5VWBNU.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-SCPRRSA3.mjs";
import "./chunk-GGCBZOQR.mjs";
import "./chunk-G5PLFO4A.mjs";
import "./chunk-VWILPC5Y.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-FG32ZSGV.mjs";
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
