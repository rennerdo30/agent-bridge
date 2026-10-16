import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv | undefined;
afterEach(async () => { await env?.cleanup(); env = undefined; });
const events = [
  ["session-start", "SessionStart"], ["user-prompt", "UserPromptSubmit"], ["pre-tool", "PreToolUse"],
  ["pre-llm", "PreLLMCall"], ["stop", "Stop"],
  ["stop-failure", "StopFailure"], ["session-end", "SessionEnd"],
];
function fixture(cli?: string) {
  env = makeEnv();
  mkdirSync(join(env.home, "hooks")); mkdirSync(join(env.home, "dist"));
  for (const name of ["run", ...events.map(([name]) => name!)]) copyFileSync(join(import.meta.dirname, `../plugins/muse/hooks/${name}.mjs`), join(env.home, `hooks/${name}.mjs`));
  if (cli) writeFileSync(join(env.home, "dist/cli.mjs"), cli);
  return env.home;
}
async function invoke(home: string, name: string) {
  let pid: number | undefined;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [join(home, `hooks/${name}.mjs`)], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    pid = child.pid;
  });
  return { pid, output: JSON.parse(stdout) };
}

describe("Muse hook wrapper process", () => {
  it("dispatches every hook in the launched process with the original parent", async () => {
    const home = fixture("console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,args:process.argv.slice(2)}));");
    for (const [name, event] of events) {
      const { pid, output } = await invoke(home, name!);
      expect(output).toEqual({ pid, ppid: process.pid, args: ["muse-hook", event] });
    }
  });
  it("fails closed for a gated hook if the CLI cannot load", async () => {
    const home = fixture();
    expect((await invoke(home, "pre-tool")).output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect((await invoke(home, "pre-llm")).output).toEqual({});
  });
});
