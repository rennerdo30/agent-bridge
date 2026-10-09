import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { hostedStartRetryMs, JobManager } from "../src/mcp/jobs.js";

// AB-247: retaining a late detached start backs off instead of retrying every 50 ms forever.
it("backs off from 50 ms to at most 5 s", () => {
  expect([0, 1, 2, 3, 6, 7, 50].map(hostedStartRetryMs)).toEqual([50, 100, 200, 400, 3_200, 5_000, 5_000]);
});

it("still retains the start once the job store lock is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-hosted-retry-")), path = join(dir, "jobs.json"), lock = `${path}.lock`;
  try {
    const node = Object.assign(new EventEmitter(), { name: "owner", id: "owner-id", currentSessionId: "s", deliverLocal: () => {} });
    const manager = new JobManager(node as never, nullLogger, path);
    const tracked = manager.track("codex", null, "task");
    manager.persist();
    writeFileSync(lock, "");
    const turn = JSON.parse(readFileSync(path, "utf8")).jobs[0];
    const retained = (manager as unknown as { retainHostedStart: (t: unknown, h: unknown, e: string) => Promise<void> })
      .retainHostedStart(turn, { pid: 1, peer: turn.name, startedAt: Date.now() }, "owner");
    await new Promise((r) => setTimeout(r, 400));
    rmSync(lock);
    await retained;
    expect(JSON.parse(readFileSync(path, "utf8")).retainedHostedStarts).toHaveLength(1);
    tracked.end();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
