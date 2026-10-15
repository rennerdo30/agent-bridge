import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-I6FU3UBJ.mjs";
import "./chunk-AUN6CJPS.mjs";
import "./chunk-33RFCVTF.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-ZT3W4XMU.mjs";
import "./chunk-AR6CIXT4.mjs";
import "./chunk-KAR5Y757.mjs";
import "./chunk-EEBKADYD.mjs";
import "./chunk-RE3I7AXX.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-TDA76SDP.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-BKTTXFS6.mjs";
import "./chunk-AR4BZM3F.mjs";
import "./chunk-HIVVJXLN.mjs";
import "./chunk-VNQ4UNAO.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-DEWCC5JJ.mjs";
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
