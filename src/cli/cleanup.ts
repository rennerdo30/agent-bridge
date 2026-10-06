import { join } from "node:path";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import { cleanupWorktrees } from "../core/worktree-cleanup.js";

export async function runCleanup(args: string[], opts: { home: string; cwd: string; log: Logger; out: (line: string) => void }): Promise<number> {
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") {
      if (repo || !args[i + 1] || args[i + 1]!.startsWith("-")) throw new Error("--repo requires one repository path.");
      repo = args[++i];
    } else if (!["--all", "--yes", "-y", "--dry-run"].includes(args[i]!)) throw new Error(`Unknown cleanup option: ${args[i]}`);
  }
  const all = args.includes("--all");
  const apply = (args.includes("--yes") || args.includes("-y")) && !args.includes("--dry-run");
  const entries = await cleanupWorktrees({ ...opts, repo, all, apply, onScope: (scope) => {
    opts.out(`Cleanup scope: ${scope.all ? "all repositories" : scope.repository} (${apply ? "apply" : "dry run"})`);
    for (const project of scope.projects) {
      opts.out(`Repository: ${project.repository ?? "unknown (orphan folders)"}; ${project.paths.length} worktree(s)`);
      for (const path of project.paths) opts.out(`  ${path}`);
    }
  } });
  if (!entries.length) opts.out(t("cli.cleanup.none", { dir: join(opts.home, "worktrees") }));
  for (const e of entries) opts.out(t("cli.cleanup.line", { action: e.action.padEnd(12), path: e.path, branch: e.branch ?? "-", reason: e.reason }));
  const count = (action: string) => entries.filter((e) => e.action === action).length;
  opts.out(t("cli.cleanup.summary", { removed: count("removed"), would: count("would remove"), kept: count("kept"), failed: count("failed") }));
  if (count("would remove")) opts.out(t("cli.cleanup.dryRun"));
  return count("failed") ? 1 : 0;
}
