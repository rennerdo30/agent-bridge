import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools } from "../src/mcp/server.js";

// AB-398: the pause_subagent and resume_subagent tool layer (argument refusals, results, nested supervisors).
const managers: JobManager[] = [], clients: Client[] = [], servers: McpServer[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.setDormant(true); manager.cancelAll(); }
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

const answer = { text: "finished", sessionId: "native-session", isError: false, details: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const abortable = (): Run => signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ ...answer, status: "cancelled" }), { once: true }));

async function connect(nested = false) {
  const home = mkdtempSync(join(tmpdir(), "ab-pause-tools-"));
  const path = join(home, "jobs.json");
  const node = new LocalCoordinator("owner", "root-session");
  Object.assign(node, { setNotificationWaitHandlers: vi.fn(), jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null });
  const jobs = new JobManager(node, nullLogger, path, 3,
    nested ? { parentJob: "codex-job-parent", rootSession: "root-session", rootName: "owner", escalate: async () => {} } : undefined);
  managers.push(jobs);
  const server = new McpServer({ name: "pause-tools-test", version: "0" }); servers.push(server);
  registerTools(server, { agent: "codex", cfg: { ...DEFAULT_CONFIG }, node: nested ? null : node as unknown as BridgeNode, jobs,
    home, cwd: () => home, channelActive: () => false, log: nullLogger }, []);
  const client = new Client({ name: "pause-tools-test", version: "0" }); clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError === true, text: result.content.map(c => c.text).join("\n") };
  };
  return { jobs, client, call };
}

it("refuses ambiguous, unknown and finished targets", async () => {
  const { jobs, call } = await connect();
  for (const name of ["pause_subagent", "resume_subagent"]) {
    expect(await call(name, {})).toMatchObject({ isError: true, text: expect.stringContaining("Supply one job or all: true.") });
    expect(await call(name, { job: "codex-job-x", all: true })).toMatchObject({ isError: true, text: expect.stringContaining("Supply one job or all: true.") });
    expect(await call(name, { job: "codex-job-missing" })).toMatchObject({ isError: true, text: expect.stringContaining("Unknown or unauthorized job codex-job-missing.") });
  }
  const done = jobs.start("codex", null, "quick", async () => answer);
  await flush();
  expect(done.status).toBe("done");
  expect(await call("pause_subagent", { job: done.name })).toMatchObject({ isError: true, text: expect.stringContaining(`${done.name} already finished (done)`) });
  expect(await call("resume_subagent", { job: done.name })).toMatchObject({ isError: true, text: expect.stringContaining(`${done.name} is not paused.`) });
  expect((await call("pause_subagent", { job: done.name, reason: "x".repeat(501) })).isError).toBe(true);
});

it("pauses and resumes one job or all jobs and returns per-job results", async () => {
  const { jobs, call } = await connect();
  const resume = vi.fn((): Run => async () => answer);
  const one = jobs.start("codex", null, "one", abortable(), resume);
  const two = jobs.start("codex", null, "two", abortable(), resume);
  expect(JSON.parse((await call("pause_subagent", { job: one.name, reason: "owner build" })).text)).toEqual({ paused: [one.name], failed: [] });
  expect(one).toMatchObject({ status: "paused", pauseReason: "owner build" });
  expect(JSON.parse((await call("pause_subagent", { all: true })).text)).toEqual({ paused: [two.name], failed: [] });
  await flush();
  expect(JSON.parse((await call("resume_subagent", { all: true })).text)).toEqual({ resumed: [one.name, two.name], failed: [] });
  await flush();
  expect(resume).toHaveBeenCalledTimes(2);
  // Nothing left to pause: an all-call is an error only when every job failed, and here none was eligible.
  expect(JSON.parse((await call("pause_subagent", { all: true })).text)).toEqual({ paused: [], failed: [] });
});

it("offers pause and resume to a nested supervisor without independent-session tools", async () => {
  const { client } = await connect(true);
  const names = (await client.listTools()).tools.map(t => t.name);
  expect(names).toEqual(expect.arrayContaining(["pause_subagent", "resume_subagent", "cancel_subagent", "message_subagent"]));
  expect(names).not.toContain("max_subagents");
});
