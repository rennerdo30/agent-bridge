import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs"), "muse-hook", "SessionStart"], { stdio: "inherit" });
child.on("error", () => process.stdout.write("{}"));
child.on("close", (code) => process.exit(code ?? 0));
