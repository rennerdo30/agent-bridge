import { planFinalize, rollbackHistoryStore, runFinalize } from "../core/storage-finalize.js";
import { runAbsorb } from "../core/storage-absorb.js";

const USAGE = "Usage: agent-bridge storage finalize [--check | --yes] [--json] | storage absorb [--yes] [--json] | storage rollback-history\n" +
  "finalize lists the old-format data that the verified new storage replaces (quick: nothing is read row by row); --check proves every item\n" +
  "and removes nothing; --yes proves again and removes exactly the proven items, then compacts bridge.db.\n" +
  "absorb lists rows and files that exist only in old backups and snapshots; with --yes it imports them losslessly into archive.db.";

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function runStorage(rest: string[], home: string, out: (text: string) => void): number {
  if (rest[0] === "rollback-history" && rest.length === 1) {
    try { out(rollbackHistoryStore(home)); return 0; } catch (err) { out(String((err as Error).message)); return 1; }
  }
  const args = new Set(rest.slice(1));
  if (rest[0] === "absorb" && [...args].every(a => a === "--yes" || a === "--json")) {
    const json = args.has("--json");
    let result;
    try { result = runAbsorb(home, { apply: args.has("--yes"), report: line => { if (!json) out(line); } }); }
    catch (err) { out(String((err as Error).message)); return 1; }
    if (json) { out(JSON.stringify(result, null, 2)); return result.blockers.length ? 1 : 0; }
    if (result.blockers.length) { out("Not ready; nothing was imported:"); for (const blocker of result.blockers) out(`  - ${blocker}`); return 1; }
    out(`${result.rows} rows and ${result.files} files ${result.applied ? "imported into archive.db" : "exist only in old copies"}; ${result.conflicts} conflicting rows (their copies stay).`);
    if (!result.applied) out("Run again with --yes to import them (stop all bridge processes first), then agent-bridge storage finalize.");
    return 0;
  }
  const finalizeFlags = new Set(["--yes", "--json", "--check"]);
  if (rest[0] !== "finalize" || [...args].some(a => !finalizeFlags.has(a)) || (args.has("--yes") && args.has("--check"))) { out(USAGE); return 2; }
  const json = args.has("--json"), check = args.has("--check"), apply = args.has("--yes");
  const report = (line: string) => { if (!json) out(line); };
  const plan = apply ? runFinalize(home, report) : check ? runFinalize(home, report, { dryRun: true }) : planFinalize(home);
  if (json) { out(JSON.stringify({ ...plan, removed: apply && plan.ready }, null, 2)); return plan.ready ? 0 : 1; }
  if (!plan.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan.blockers) out(`  - ${blocker}`);
    return 1;
  }
  // Table sizes need a full page walk, so the quick plan leaves them to the proving run.
  const shown = (item: { kind: string; bytes: number }) => item.kind === "table" ? "-".padStart(10) : gib(item.bytes).padStart(10);
  const kept = () => {
    if (!plan.kept.length) return;
    out("Kept, because they are not proven redundant row by row:");
    for (const item of plan.kept) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
  };
  if (!apply) {
    for (const item of plan.items) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
    kept();
    out(check
      ? `${plan.items.length} items, ${gib(plan.bytes)}, proven redundant; nothing was removed. Run with --yes to remove them (they are proven again then).`
      : `${plan.items.length} candidates, ${gib(plan.bytes)} in files. Nothing was read row by row yet: --check proves them without removing anything, --yes proves and removes.`);
    return 0;
  }
  kept();
  out(`Removed ${plan.items.length} items, ${gib(plan.bytes)}.`);
  return 0;
}
