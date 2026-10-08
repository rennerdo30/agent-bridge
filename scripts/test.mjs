import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const [lane = "fast", ...args] = process.argv.slice(2);
if (!["fast", "integration", "all"].includes(lane)) throw new Error("Unknown test lane");
const env = { ...process.env, AGENT_BRIDGE_TEST_LANE: lane };
if (process.platform === "win32") {
  const fixtureTemp = join(process.cwd(), ".agent-bridge-test", "temp");
  mkdirSync(fixtureTemp, { recursive: true });
  Object.assign(env, { TEMP: fixtureTemp, TMP: fixtureTemp, GIT_CEILING_DIRECTORIES: fixtureTemp });
}
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run", ...args], {
  stdio: "inherit", windowsHide: true, env,
});
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
