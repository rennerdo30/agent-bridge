import { AUDIT_LIMITS, AUDIT_MAXIMUMS, auditStorage } from "../core/storage-audit.js";

export const AUDIT_USAGE = "Usage: agent-bridge storage audit --root <path> [--root <path> ...] [--json] [--max-depth N] [--max-entries N] [--max-ms N] [--max-records N]\n" +
  "Read-only explicit-root inventory; no broker, cleanup or migration. Exit 0: inventory complete, 1: partial/error, 2: invalid arguments.\n" +
  `Defaults: depth ${AUDIT_LIMITS.maxDepth}, entries ${AUDIT_LIMITS.maxEntries}, ms ${AUDIT_LIMITS.maxMs}, attribution records ${AUDIT_LIMITS.maxRecords}.`;

export function runStorageAudit(args: string[], out: (line: string) => void): number {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { out(AUDIT_USAGE); return 0; }
  const roots: string[] = [], options: Partial<typeof AUDIT_LIMITS> = {};
  const flags = { "--max-depth": "maxDepth", "--max-entries": "maxEntries", "--max-ms": "maxMs", "--max-records": "maxRecords" } as const;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" && !json) { json = true; continue; }
    const value = args[++i];
    if (arg === "--root" && value?.trim() && !value.startsWith("--")) { roots.push(value); continue; }
    const key = flags[arg as keyof typeof flags];
    if (!key || !value || !/^\d+$/.test(value) || options[key] !== undefined || Number(value) < (key === "maxDepth" ? 0 : 1) || Number(value) > AUDIT_MAXIMUMS[key]) { out(AUDIT_USAGE); return 2; }
    options[key] = Number(value);
  }
  if (!roots.length || roots.length > 32) { out(AUDIT_USAGE); return 2; }
  const result = auditStorage(roots, options);
  if (json) out(JSON.stringify(result, null, 2));
  else {
    out(`Storage audit: ${result.complete ? "complete" : "partial"}; ${result.entries} entries observed. Read-only.`);
    out(result.sizeMeaning);
    for (const item of result.directories) {
      out(`${JSON.stringify(item.path)}: ${item.bytes} bytes (${item.directBytes} direct), ${item.files} files, ${item.complete ? "complete" : "partial"}`);
      out(`  Created ${item.createdAt ?? "unknown"}; modified ${item.modifiedAt}. Historical cause: unknown.`);
      out(`  Current root ${JSON.stringify(item.project.canonicalRoot)}; nested under same Git root: ${item.project.nestedUnderSameGitRoot ?? "unknown"}. ${item.project.reason}`);
      out(`  Attribution: ${item.attribution.status}, ${item.attribution.records.length} associations. ${item.attribution.meaning}`);
      for (const row of item.attribution.records) out(`    ${JSON.stringify(row)}`);
      for (const p of item.attribution.problems) out(`    ${p.code}: ${JSON.stringify(p.path)}`);
    }
    for (const p of result.problems) out(`  ${p.code}: ${JSON.stringify(p.path)}`);
  }
  return result.complete ? 0 : 1;
}
