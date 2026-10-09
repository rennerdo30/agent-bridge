import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-MQGFL2OS.mjs";
import "./chunk-KWUM4FZP.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-KYK3XDP2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-ZBKQCI2L.mjs";
import "./chunk-Y5OCTQFF.mjs";
import "./chunk-EVQHXDRX.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-MQP6K4NJ.mjs";
import "./chunk-QI5MA53T.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-OG3EDS6T.mjs";
import "./chunk-2BSEKRNX.mjs";
import "./chunk-TFQZM67X.mjs";
import "./chunk-OMBGRGBY.mjs";
import "./chunk-ENZISWMO.mjs";
import "./chunk-Q372BWBW.mjs";
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
