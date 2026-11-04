// Entry points of the plugin bundles, shared by scripts/build.mjs and scripts/third-party-notices.mjs.
export const ENTRIES = {
  server: "src/mcp/launcher.ts",
  worker: "src/mcp/main.ts",
  cli: "src/cli/main.ts",
  "history-worker": "src/core/history-worker.ts",
  "backup-worker": "src/core/backup-worker.ts",
  "outcome-worker": "src/core/outcome-worker.ts",
  "job-archive-worker": "src/core/job-archive-worker.ts",
};
// The opencode plugin runs inside opencode (Bun) and spawns dist/server.mjs with Node.
export const OPENCODE_ENTRY = "src/opencode/plugin.ts";
export const EXTERNAL = ["node:*"];
