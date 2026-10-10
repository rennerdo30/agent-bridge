import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-XISKKDBO.mjs";
import "./chunk-7Y7S3XVI.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-CKNSPGQW.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-AGEMLUYH.mjs";
import "./chunk-KLFFS5AY.mjs";
import "./chunk-2GQW7PXU.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-ZNBE7QJQ.mjs";
import "./chunk-EUVUYVJQ.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-3HR6VMN7.mjs";
import "./chunk-I6MYXRDE.mjs";
import "./chunk-WM3QOXKL.mjs";
import "./chunk-UNRS7LDN.mjs";
import "./chunk-VBHAVRFY.mjs";
import "./chunk-DLCSA3SJ.mjs";
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
