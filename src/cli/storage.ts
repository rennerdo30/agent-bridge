import { planFinalize, rollbackHistoryStore, runFinalize } from "../core/storage-finalize.js";
import { runAbsorb } from "../core/storage-absorb.js";

const USAGE = "Usage: agent-bridge storage finalize [--check | --yes] [--json] | storage absorb [--yes] [--json] | storage rollback-history\n" +
  "finalize lists the old-format data that the verified new storage replaces (quick: nothing is read row by row); --check proves every item\n" +
  "and retains everything; --yes runs the same checks under maintenance admission and retains all originals without compaction.\n" +
  "absorb copies into archive.db with --yes, retaining all originals; an existing archive requiring migration is refused.";

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
    if (json) { out(JSON.stringify({ ...result, removed: false, removedItems: 0, freedBytes: 0 }, null, 2)); return result.blockers.length ? 1 : 0; }
    if (result.blockers.length) { out("Not ready; nothing was imported:"); for (const blocker of result.blockers) out(`  - ${blocker}`); return 1; }
    out(`${result.rows} rows and ${result.files} files ${result.applied ? "imported into archive.db" : "exist only in old copies"}; ${result.conflicts} conflicting rows (their copies stay).`);
    out("Removed 0 items, 0.00 GiB; all originals retained.");
    if (!result.applied) out("Run again with --yes to import them (stop all bridge processes first), then agent-bridge storage finalize.");
    return 0;
  }
  const finalizeFlags = new Set(["--yes", "--json", "--check"]);
  if (rest[0] !== "finalize" || [...args].some(a => !finalizeFlags.has(a)) || (args.has("--yes") && args.has("--check"))) { out(USAGE); return 2; }
  const json = args.has("--json"), check = args.has("--check"), apply = args.has("--yes");
  const report = (line: string) => { if (!json) out(line); };
  const plan = apply ? runFinalize(home, report) : check ? runFinalize(home, report, { dryRun: true }) : planFinalize(home);
  if (json) { out(JSON.stringify({ ...plan, removed: false, removedItems: 0, freedBytes: 0 }, null, 2)); return plan.ready ? 0 : 1; }
  if (!plan.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan.blockers) out(`  - ${blocker}`);
    return 1;
  }
  // Table sizes need a full page walk, so the quick plan leaves them to the proving run.
  const shown = (item: { kind: string; bytes: number }) => item.kind === "table" ? "-".padStart(10) : gib(item.bytes).padStart(10);
  const kept = () => {
    if (!plan.kept.length) return;
    out("Retained originals (including candidates whose proof passes):");
    for (const item of plan.kept) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
  };
  if (!apply) {
    for (const item of plan.items) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
    kept();
    out(check
      ? `${plan.kept.length} items retained after checks. Removed 0 items, 0.00 GiB.`
      : `${plan.items.length} candidates, ${gib(plan.bytes)} in files. --check and --yes check proofs and retain all originals; neither frees space.`);
    return 0;
  }
  kept();
  out(`Removed 0 items, 0.00 GiB; ${plan.kept.length} items retained.`);
  return 0;
}
