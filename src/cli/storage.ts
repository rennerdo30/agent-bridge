import { planFinalize, rollbackHistoryStore, runFinalize } from "../core/storage-finalize.js";

const USAGE = "Usage: agent-bridge storage finalize [--yes] [--json] | storage rollback-history\n" +
  "Lists the old-format data that the verified new storage replaces; with --yes it removes exactly that list and compacts bridge.db.";

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function runStorage(rest: string[], home: string, out: (text: string) => void): number {
  if (rest[0] === "rollback-history" && rest.length === 1) {
    try { out(rollbackHistoryStore(home)); return 0; } catch (err) { out(String((err as Error).message)); return 1; }
  }
  const args = new Set(rest.slice(1));
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
