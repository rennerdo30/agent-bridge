import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { archiveRun, finishedRunLine } from "../src/core/run-archive.js";
import { makeEnv } from "./helpers.js";

it("archives only a terminal runner finish marker, preserving quoted live output", async () => {
  const env = makeEnv();
  const dir = join(env.home, "runs"), file = join(dir, "fixture.log");
  try {
    mkdirSync(dir);
    const quote = '12:00:00 source: "06:32:40 finished after 22s · done\\n"';
    writeFileSync(file, `${quote}\n`);
    expect(finishedRunLine(`${quote}\n`)).toBeNull();
    archiveRun(file);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, "06:32:40 finished after 22s · done\n12:00:01 still working\n");
    archiveRun(file);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, `${quote}\n12:00:02 finished after 24s · done\n`);
    archiveRun(file);
    expect(existsSync(join(dir, "archive", "fixture.log"))).toBe(true);
  } finally { await env.cleanup(); }
});
