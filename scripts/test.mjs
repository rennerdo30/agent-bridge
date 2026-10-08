import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [lane = "fast", ...args] = process.argv.slice(2);
if (!["fast", "integration", "all"].includes(lane)) throw new Error("Unknown test lane");
const env = { ...process.env, AGENT_BRIDGE_TEST_LANE: lane };
const fixtureRoot = join(process.cwd(), ".agent-bridge-test");
mkdirSync(fixtureRoot, { recursive: true });
env.AGENT_BRIDGE_HOME = join(fixtureRoot, "default-home");
delete env.AGENT_BRIDGE_PIPE;
const fixturePackage = join(fixtureRoot, "package.json");
try { writeFileSync(fixturePackage, '{"private":true,"type":"commonjs"}\n', { flag: "wx" }); }
catch (error) {
  if (error.code !== "EEXIST" || JSON.parse(readFileSync(fixturePackage, "utf8")).type !== "commonjs") throw error;
}
env.GIT_CEILING_DIRECTORIES = fixtureRoot;
if (process.platform === "win32") {
  const fixtureTemp = join(fixtureRoot, "temp");
  mkdirSync(fixtureTemp, { recursive: true });
  Object.assign(env, { TEMP: fixtureTemp, TMP: fixtureTemp });
}
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run", ...args], {
  stdio: "inherit", windowsHide: true, env,
});
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
