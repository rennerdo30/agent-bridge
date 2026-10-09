import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-DUY4IIDH.mjs";
import "./chunk-DA3NEIET.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-7KTHVLBQ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-VXB3HNK5.mjs";
import "./chunk-DRJZYGXY.mjs";
import "./chunk-RA27PPKI.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-FPUUFY3W.mjs";
import "./chunk-QPCSPJ2N.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-PAXZLLSZ.mjs";
import "./chunk-KPZXS4LN.mjs";
import "./chunk-TFQZM67X.mjs";
import "./chunk-B5SDVTIU.mjs";
import "./chunk-7L26L4EN.mjs";
import "./chunk-FOXOPMFN.mjs";
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
