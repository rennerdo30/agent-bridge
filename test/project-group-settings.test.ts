import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProjectGroups } from "../src/core/project-groups.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv } from "./helpers.js";

it("refreshes group authority settings between dispatches and fails closed on malformed settings", async () => {
  const env = makeEnv();
  try {
    mkdirSync(join(env.home, ".agent-bridge"));
    const config = join(env.home, ".agent-bridge", "config.json");
    const groups = new ProjectGroups(env.home);
    const peers = ["claude", "codex", "opencode"].map((agent) => ({ agent, name: `${agent}-master`, cwd: env.home }) as PeerInfo);
    const job = { id: "settings", owner: "original", projectRoot: env.home };
    expect(groups.members(job, peers).map((p) => p.agent)).toEqual(["claude", "codex", "opencode"]);
    writeFileSync(config, '{"projectGroups":false}');
    await Promise.resolve();
    expect(groups.members(job, peers)).toEqual([]);
    writeFileSync(config, '{"projectGroups":true,"opencode":{"projectGroups":false}}');
    await Promise.resolve();
    expect(groups.members(job, peers).map((p) => p.agent)).toEqual(["claude", "codex"]);
    writeFileSync(config, '{"projectGroups":false,"codex":{"projectGroups":true}}');
    await Promise.resolve();
    expect(groups.members(job, peers).map((p) => p.agent)).toEqual(["codex"]);
    writeFileSync(config, "{broken");
    await Promise.resolve();
    expect(groups.members(job, peers)).toEqual([]);
  } finally { await env.cleanup(); }
});
