import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-22F7XKTT.mjs";
import "./chunk-QC3YST6Y.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-KGZHHPZZ.mjs";
import "./chunk-W2CLZM7I.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-OWLLQWIK.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-PYFNVHKK.mjs";
import "./chunk-ZX3H3PWB.mjs";
import "./chunk-LL47EW3A.mjs";
import "./chunk-XCZJPFYD.mjs";
import "./chunk-AGFXJQKM.mjs";
import "./chunk-I32N5HZ3.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-GFZ2RP3V.mjs";
import "./chunk-CJ3HJAO6.mjs";
import "./chunk-EQJFXDE5.mjs";
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
