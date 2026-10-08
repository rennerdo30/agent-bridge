import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.js";
import { JOB_OUTCOMES_DIR, readOutcomeDecision } from "../src/core/job-outcomes.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "codex", "dist", "server.mjs");
describe("supervisor outcome MCP tool", () => {
  it("registers the contract, records holds/discards, and rejects foreign/running jobs", async () => {
    const env = makeEnv();
    let verified = false;
    const client = new Client({ name: "test-outcomes", version: "0.0.0" });
    const entries = [
      { id: "owned", owner: "supervisor", status: "done" },
      { id: "foreign", owner: "another-supervisor", status: "done" },
      { id: "unfinished", owner: "supervisor", status: "running" },
    ].map((entry) => ({ ...entry, name: `codex-job-${entry.id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), sessionId: "session", workdir: null, worktree: null }));
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify(entries));
    const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
      !entry[0].startsWith("AGENT_BRIDGE_") && typeof entry[1] === "string"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=codex"], cwd: env.home,
      env: { ...childEnv, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_NAME: "supervisor", AGENT_BRIDGE_DASHBOARD: "off" }, stderr: "ignore" });
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find((t) => t.name === "set_job_outcome");
      expect(tool?.inputSchema.required).toEqual(["job", "state"]);
      // The MCP handshake precedes broker registration and saved-job restoration.
      const peers = await client.callTool({ name: "peers", arguments: {} });
      expect(peers.isError, JSON.stringify(peers)).not.toBe(true);
      expect(JSON.stringify(peers)).toContain("supervisor");
      const retained = JSON.parse(readFileSync(join(env.home, "jobs.json"), "utf8"));
      const retainedJobs = Array.isArray(retained) ? retained : retained.jobs;
      expect(retainedJobs).toHaveLength(entries.length);
      for (const { status: _status, ...context } of entries)
        expect(retainedJobs.find((job: { id: string }) => job.id === context.id)).toMatchObject(context);
      const call = (job: string, state: string, reason?: string) => client.callTool({ name: "set_job_outcome", arguments: { job, state, ...(reason === undefined ? {} : { reason }) } });
      expect((await call("codex-job-foreign", "discarded")).isError).toBe(true);
      expect((await call("codex-job-unfinished", "discarded")).isError).toBe(true);
      expect((await call("codex-job-unknown", "discarded")).isError).toBe(true);
      expect((await call("codex-job-owned", "held", " ")).isError).toBe(true);
      const held = await call("codex-job-owned", "held", "CPU A/B");
      expect(held.isError, JSON.stringify(held)).not.toBe(true);
      expect(JSON.stringify(held)).toContain("CPU A/B");
      expect(readOutcomeDecision(env.home, entries[0]!)).toMatchObject({ state: "held", reason: "CPU A/B", by: "supervisor" });
      const discarded = await call("codex-job-owned", "discarded");
      expect(discarded.isError).not.toBe(true);
      expect(JSON.stringify(discarded)).toContain("discarded");
      expect(readOutcomeDecision(env.home, entries[0]!)).toMatchObject({ state: "discarded", reason: null, by: "supervisor" });
      expect(readOutcomeDecision(env.home, entries[1]!)).toBeNull();
      expect(readOutcomeDecision(env.home, entries[2]!)).toBeNull();
      const folder = join(env.home, JOB_OUTCOMES_DIR);
      const records = readdirSync(folder).filter(name => name.endsWith(".json"));
      expect(records).toHaveLength(1);
      const saved = JSON.parse(readFileSync(join(folder, records[0]!), "utf8"));
      expect(saved.history).toEqual([expect.objectContaining({ state: "held", reason: "CPU A/B", by: "supervisor" })]);
      expect(saved.decision).toMatchObject({ state: "discarded", reason: null, by: "supervisor" });
      verified = true;
    } finally {
      await client.close();
      if (verified) await env.cleanup();
      else console.error(`Outcome fixture retained for diagnosis: ${env.home}`);
    }
  });
});
