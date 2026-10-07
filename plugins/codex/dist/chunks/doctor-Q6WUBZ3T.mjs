import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  archiveHome,
  doctor,
  fixDoctor
} from "./chunk-6F6ZGGAO.mjs";
import "./chunk-HWDBJOHT.mjs";
import "./chunk-YZL7MD22.mjs";
import "./chunk-Y2DALO3R.mjs";
import "./chunk-GZUPJ35X.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-MZMJORKC.mjs";
import "./chunk-G6MLDC24.mjs";
import {
  createBackup,
  readBackup,
  restoreBackup
} from "./chunk-4WPDYHCU.mjs";
import "./chunk-LBG7DP2E.mjs";
import "./chunk-L2G75S3E.mjs";
import "./chunk-S7VTNSOR.mjs";
import "./chunk-QBVZNCPA.mjs";
import "./chunk-SOPZATYP.mjs";
import "./chunk-AT5K4DQH.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-WXTV3GSE.mjs";
import "./chunk-2EE2AGA4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-4BCYRJ3A.mjs";
import "./chunk-BOOG2SC5.mjs";
import "./chunk-X27LYYGH.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/doctor.ts
import { createInterface } from "node:readline/promises";
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(yes|y)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
async function runDoctor(args, home, out, ask = confirm) {
  const restoreAt = args.indexOf("--restore");
  const restore = restoreAt >= 0 ? args[restoreAt + 1] : void 0;
  const actions = Number(restoreAt >= 0) + Number(args.includes("--fix")) + Number(args.includes("--archive")) + Number(args.includes("--backup"));
  const allowed = /* @__PURE__ */ new Set(["--restore", "--fix", "--archive", "--backup", "--yes", "-y", "--json"]);
  if (actions > 1 || restoreAt >= 0 && (!restore || restore.startsWith("-")) || args.some((a, i) => !allowed.has(a) && (restoreAt < 0 || i !== restoreAt + 1))) {
    out("Usage: agent-bridge doctor [--json] [--backup | --fix | --archive | --restore <backup>] [--yes]");
    return 2;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  if (restore) {
    readBackup(restore);
    const backupReport = doctor(restore);
    if (backupReport.findings.some((f) => f.severity === "error")) throw new Error("backup contains unsupported or damaged data; restore refused");
    if (!(yes || await ask(`Restore ${restore}? Current data will be preserved in a recovery backup.`))) {
      out("Restore cancelled; data unchanged.");
      return 1;
    }
    out(`Restored backup. Previous data preserved at ${restoreBackup(home, restore, true)}`);
  } else if (args.includes("--backup")) out(`Backup created: ${createBackup(home)}`);
  else if (args.includes("--fix") || args.includes("--archive")) {
    const archive = args.includes("--archive");
    if (!(yes || await ask(archive ? "Archive old data? Every record remains readable." : "Quarantine orphan temporary files? All data will be preserved."))) {
      out("Maintenance cancelled; data unchanged.");
      return 1;
    }
    out(archive ? `Archived: ${JSON.stringify(archiveHome(home, true))}` : `Preserved files: ${JSON.stringify(fixDoctor(home, true))}`);
  }
  const report = doctor(home);
  if (args.includes("--json")) out(JSON.stringify(report));
  else {
    for (const item of report.schema) out(`${item.path}: schema ${item.actual ?? "absent"}, code ${item.expected}`);
    for (const item of report.findings) out(`${item.severity.toUpperCase()} ${item.code}: ${item.path}: ${item.detail}${item.fixable ? " (--fix)" : ""}`);
    out(`Size: ${report.totalBytes} bytes across ${report.sizes.length} files. Recent backups: ${report.backups.length}.`);
    for (const item of report.sizes) out(`  ${item.bytes} bytes  ${item.path}`);
  }
  return report.ok ? 0 : 1;
}
export {
  runDoctor
};
