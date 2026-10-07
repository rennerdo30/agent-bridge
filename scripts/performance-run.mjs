import { build } from "esbuild";
import { mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".agent-bridge-test");
mkdirSync(output, { recursive: true });
const banner = { js: "import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);" };
for (const [entry, name] of [["scripts/performance.ts", "performance.mjs"], ["src/core/history-worker.ts", "history-worker.mjs"]]) {
  if (!existsSync(join(root, entry))) continue;
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(output, name), bundle: true,
    platform: "node", format: "esm", target: "node22", external: ["node:*"], banner });
}
const child = spawn(process.execPath, ["--no-warnings", join(output, "performance.mjs")], { cwd: root, stdio: "inherit" });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
