import { planFinalize, rollbackHistoryStore, runFinalize } from "../core/storage-finalize.js";
import { runAbsorb } from "../core/storage-absorb.js";

const USAGE = "Usage: agent-bridge storage finalize [--yes] [--json] | storage absorb [--yes] [--json] | storage rollback-history\n" +
  "finalize lists the old-format data that the verified new storage replaces; with --yes it removes exactly that list and compacts bridge.db.\n" +
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
  if (rest[0] !== "finalize" || [...args].some(a => a !== "--yes" && a !== "--json")) { out(USAGE); return 2; }
  const plan = args.has("--yes") ? runFinalize(home, line => { if (!args.has("--json")) out(line); }) : planFinalize(home);
  if (args.has("--json")) { out(JSON.stringify({ ...plan, removed: args.has("--yes") && plan.ready }, null, 2)); return plan.ready ? 0 : 1; }
  if (!plan.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan.blockers) out(`  - ${blocker}`);
    return 1;
  }
  const kept = () => {
    if (!plan.kept.length) return;
    out("Kept, because they are not proven redundant row by row:");
    for (const item of plan.kept) out(`  ${gib(item.bytes).padStart(10)}  ${item.path}  (${item.reason})`);
  };
  if (!args.has("--yes")) {
    for (const item of plan.items) out(`  ${gib(item.bytes).padStart(10)}  ${item.path}  (${item.reason})`);
    kept();
    out(`${plan.items.length} items, ${gib(plan.bytes)}. Run again with --yes to remove them.`);
    return 0;
  }
  kept();
  out(`Removed ${plan.items.length} items, ${gib(plan.bytes)}.`);
  return 0;
}
