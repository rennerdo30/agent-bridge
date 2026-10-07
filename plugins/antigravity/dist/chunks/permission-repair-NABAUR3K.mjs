import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-PPYTN3LZ.mjs";
import "./chunk-HWDBJOHT.mjs";
import "./chunk-YZL7MD22.mjs";
import "./chunk-Y2DALO3R.mjs";
import "./chunk-GZUPJ35X.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-MZMJORKC.mjs";
import "./chunk-G6MLDC24.mjs";
import "./chunk-SOPZATYP.mjs";
import "./chunk-AT5K4DQH.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-2EE2AGA4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-4BCYRJ3A.mjs";
import "./chunk-BOOG2SC5.mjs";
import "./chunk-X27LYYGH.mjs";
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
