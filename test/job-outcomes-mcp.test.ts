import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
describe("supervisor outcome MCP tool", () => {
  it("registers the contract, records holds/discards, and rejects foreign/running jobs", async () => {
    const env = makeEnv();
    const client = new Client({ name: "test-outcomes", version: "0.0.0" });
    const entries = [
      { id: "owned", owner: "supervisor", status: "done" },
      { id: "foreign", owner: "another-supervisor", status: "done" },
      { id: "unfinished", owner: "supervisor", status: "running" },
    ].map((entry) => ({ ...entry, name: `codex-job-${entry.id}`, agent: "codex", model: null, prompt: "task", startedAt: Date.now(), sessionId: "session", workdir: null, worktree: null }));
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify(entries));
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=claude"],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: "supervisor", AGENT_BRIDGE_DASHBOARD: "off" } as Record<string, string>, stderr: "ignore" });
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find((t) => t.name === "set_job_outcome");
      expect(tool?.inputSchema.required).toEqual(["job", "state"]);
      const call = (job: string, state: string, reason?: string) => client.callTool({ name: "set_job_outcome", arguments: { job, state, ...(reason === undefined ? {} : { reason }) } });
      expect((await call("codex-job-foreign", "discarded")).isError).toBe(true);
      expect((await call("codex-job-unfinished", "discarded")).isError).toBe(true);
      expect((await call("codex-job-unknown", "discarded")).isError).toBe(true);
      expect((await call("codex-job-owned", "held", " ")).isError).toBe(true);
      const held = await call("codex-job-owned", "held", "CPU A/B");
      expect(held.isError).not.toBe(true);
      expect(JSON.stringify(held)).toContain("CPU A/B");
      const discarded = await call("codex-job-owned", "discarded");
      expect(discarded.isError).not.toBe(true);
      expect(JSON.stringify(discarded)).toContain("discarded");
    } finally { await client.close(); await env.cleanup(); }
  });
});
