import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-JQMM2KT5.mjs";
import "./chunk-M5XY6MWN.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-F2J2GD3I.mjs";
import "./chunk-AVFP4VLR.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-XIY6YUWX.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-LOV5TPO7.mjs";
import "./chunk-7AVL5VO2.mjs";
import "./chunk-PQTSSDXI.mjs";
import "./chunk-UTSHXRSC.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-7ILYHEEI.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-K2KQEUNB.mjs";
import "./chunk-BVMWTWQA.mjs";
import "./chunk-O26G5HFG.mjs";
import "./chunk-ARGAVNKJ.mjs";
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
