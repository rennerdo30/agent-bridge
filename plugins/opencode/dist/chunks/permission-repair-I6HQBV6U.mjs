import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  repairPermissions
} from "./chunk-ZI7QR6JF.mjs";
import "./chunk-ILN2V2BA.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-DXEWIZM4.mjs";
import "./chunk-T3Y747W7.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-3L5NAV5P.mjs";
import "./chunk-6B2AZPTL.mjs";
import "./chunk-KT6UGBZN.mjs";
import "./chunk-HSYLC53O.mjs";
import "./chunk-3ONQFYIQ.mjs";
import "./chunk-JKWPEEII.mjs";
import "./chunk-VUZ3I7UH.mjs";
import "./chunk-5NPKKVPB.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-6QSR4FTZ.mjs";
import "./chunk-YEN6TM2D.mjs";
import "./chunk-FJ2TGOLZ.mjs";
import "./chunk-EMDJN7RB.mjs";
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
