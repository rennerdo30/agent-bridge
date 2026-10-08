import { createInterface } from "node:readline/promises";
import { doctor, archiveHome, fixDoctor } from "../core/doctor.js";
import { createBackup, readBackup, restoreBackup } from "../core/backups.js";
import { inspectPluginVersions, listServerProcesses, pluginDoctorPaths } from "./plugin-doctor.js";
import { brokerFailureState, formatHealth, probeBrokerHealth } from "../core/health.js";
import { resolvePipePath } from "../core/paths.js";
import { nullLogger } from "../core/logger.js";

export type ConfirmDoctor = (question: string) => Promise<boolean>;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(yes|y)$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); }
}

export async function runDoctor(args: string[], home: string, out: (text: string) => void, ask: ConfirmDoctor = confirm): Promise<number> {
  const restoreAt = args.indexOf("--restore");
  const restore = restoreAt >= 0 ? args[restoreAt + 1] : undefined;
  const actions = Number(restoreAt >= 0) + Number(args.includes("--fix")) + Number(args.includes("--archive")) + Number(args.includes("--backup"));
  const allowed = new Set(["--restore", "--fix", "--archive", "--backup", "--yes", "-y", "--json"]);
  if (actions > 1 || restoreAt >= 0 && (!restore || restore.startsWith("-")) || args.some((a, i) => !allowed.has(a) && (restoreAt < 0 || i !== restoreAt + 1))) {
    out("Usage: agent-bridge doctor [--json] [--backup | --fix | --archive | --restore <backup>] [--yes]");
    return 2;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  if (restore) {
    readBackup(restore);
    const backupReport = doctor(restore);
    if (backupReport.findings.some((f) => f.severity === "error")) throw new Error("backup contains unsupported or damaged data; restore refused");
    if (!(yes || await ask(`Restore ${restore}? Current data will be preserved in a recovery backup.`))) { out("Restore cancelled; data unchanged."); return 1; }
    out(`Restored backup. Previous data preserved at ${restoreBackup(home, restore, true)}`);
  } else if (args.includes("--backup")) out(`Backup created: ${createBackup(home)}`);
  else if (args.includes("--fix") || args.includes("--archive")) {
    const archive = args.includes("--archive");
    if (!(yes || await ask(archive ? "Archive old data? Every record remains readable." : "Quarantine orphan temporary files? All data will be preserved."))) { out("Maintenance cancelled; data unchanged."); return 1; }
    out(archive ? `Archived: ${JSON.stringify(archiveHome(home, true))}` : `Preserved files: ${JSON.stringify(fixDoctor(home, true))}`);
  }
  const report = doctor(home);
  report.brokerHealth = await probeBrokerHealth(resolvePipePath(home), nullLogger).catch(error => {
    if (brokerFailureState(error) !== "offline") report.findings.push({ severity: "warning", code: "broker-health-unconfirmed", path: home,
      detail: brokerFailureState(error) === "slow" ? "Bridge responding slowly; history-import progress could not be refreshed." : "Bridge health unavailable; broker absence is not confirmed.", fixable: false });
    return null;
  });
  const processes = await listServerProcesses();
  report.findings.push(...inspectPluginVersions(pluginDoctorPaths(home), processes ?? []));
  if (processes === null) report.findings.push({ severity: "warning", code: "plugin-process-unavailable", path: home, detail: "Running server process lookup unavailable; rerun agent-bridge doctor from the host account.", fixable: false });
  if (args.includes("--json")) out(JSON.stringify(report));
  else {
    if (report.brokerHealth) out(formatHealth(report.brokerHealth));
    for (const item of report.schema) out(`${item.path}: schema ${item.actual ?? "absent"}, code ${item.expected}`);
    for (const item of report.findings) out(`${item.severity.toUpperCase()} ${item.code}: ${item.path}: ${item.detail}${item.fixable ? " (--fix)" : ""}`);
    out(`Size: ${report.totalBytes} bytes across ${report.sizes.length} files. Recent backups: ${report.backups.length}.`);
    for (const item of report.sizes) out(`  ${item.bytes} bytes  ${item.path}`);
  }
  return report.ok ? 0 : 1;
}
