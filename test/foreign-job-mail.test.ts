import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
it("visibly refuses cross-project ordinary job mail before storage", async () => {
  const sender = env.node("foreign-main"); await sender.start();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "foreign", name: "codex-job-foreign", owner: "another-main", status: "running", startedAt: 1 }] }));
  const error = await sender.send({ to: "codex-job-foreign", body: "must not silently disappear" }).catch(error => error);
  expect(error.message).toContain("Ask its supervisor");
  expect(error.message).toContain("No message was stored");
  const broker = (sender as any).broker;
  expect(broker.store.unread("codex-job-foreign", 10)).toHaveLength(0);
});
