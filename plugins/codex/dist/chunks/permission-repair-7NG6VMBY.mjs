import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-I6ESJXMD.mjs";
import "./chunk-CFVZB6LI.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-65ZSD2AN.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-OXGIH2UU.mjs";
import "./chunk-6HI567DZ.mjs";
import "./chunk-ENIEXOVX.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-4BXG6RBC.mjs";
import "./chunk-KIW2YSIK.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-OYWC2NG3.mjs";
import "./chunk-NJ4I2XXU.mjs";
import "./chunk-TFQZM67X.mjs";
import "./chunk-2BBQZ46F.mjs";
import "./chunk-P6KUA2PD.mjs";
import "./chunk-GWP4RZPO.mjs";
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
