import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-JQ5JT3RK.mjs";
import "./chunk-S7A3QKFE.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-22WDFJOY.mjs";
import "./chunk-KW6LIBI7.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-YGG2GNCU.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-KEE3XHEU.mjs";
import "./chunk-SKHIGNLE.mjs";
import "./chunk-VAAHNP24.mjs";
import "./chunk-JR5WUYK2.mjs";
import "./chunk-ASTYETXU.mjs";
import "./chunk-XOWKRTDA.mjs";
import "./chunk-SYQVZHDB.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-MPE4JJY6.mjs";
import "./chunk-7NCHHXYD.mjs";
import "./chunk-4RLE2X5P.mjs";
import "./chunk-S4LREWMY.mjs";
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
