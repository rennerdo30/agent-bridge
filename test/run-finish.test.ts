import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { archiveRun, finishedRunLine } from "../src/core/run-archive.js";
import { finishedRunOutcomes } from "../src/core/dashboard-read.js";
import { nullLogger } from "../src/core/logger.js";
import { watchRunLog } from "../src/cli/watch.js";
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

it("keeps quoted live runs out of finished outcome projection", async () => {
  const env = makeEnv();
  try {
    const dir = join(env.home, "runs"), name = "2026-10-07-14-21-11-codex-fixture";
    mkdirSync(dir);
    writeFileSync(join(dir, `${name}.log`), '12:00:00 source: "06:32:40 finished after 22s · done\\n"\n');
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ job: "codex-job-fixture", jobStartedAt: Date.now() }));
    expect(await finishedRunOutcomes(env.home, nullLogger)).toEqual({});
  } finally { await env.cleanup(); }
});

it("watches past quoted and nonterminal finish markers to the actual terminal marker", async () => {
  const env = makeEnv();
  try {
    const file = join(env.home, "fixture.log"), lines: string[] = [];
    const quote = '12:00:00 source: "06:32:40 finished after 22s · done\\n"';
    writeFileSync(file, `${quote}\n06:32:40 finished after 22s · done\n12:00:01 still working\n${"x".repeat(70_000)}\n12:00:02 finished after 24s · done\n`);
    await watchRunLog(file, (line) => lines.push(line));
    expect(lines).toContain("12:00:01 still working");
    expect(lines.at(-1)).toBe("12:00:02 finished after 24s · done");
  } finally { await env.cleanup(); }
});
