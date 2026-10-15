import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-YSZ757I7.mjs";
import "./chunk-CQH5LJAT.mjs";
import "./chunk-M34A7LGX.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-XLNILXGE.mjs";
import "./chunk-F33G6ABL.mjs";
import "./chunk-DQIXEQP6.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-5UHHJGHO.mjs";
import "./chunk-RE3I7AXX.mjs";
import "./chunk-YBTOXVMR.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-BCH7R2VO.mjs";
import "./chunk-QC3YTNDQ.mjs";
import "./chunk-HIVVJXLN.mjs";
import "./chunk-BCZF4EL6.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-QT7RNNGD.mjs";
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
