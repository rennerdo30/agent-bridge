import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexHost, until } from "./helpers.js";
import { captureFixtureBroker } from "./fixture-teardown.js";
import { fixtureProcessExists } from "./fixture-process-generation.js";

/** Runs the bundled plugin server (npm run build first) for all five CLI kinds. */
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
const home = mkdtempSync(join(tmpdir(), "agent-bridge-e2e-"));
writeFileSync(join(home,"config.json"),JSON.stringify({questionAlerts:{sound:false,toast:false,reminderMinutes:0}}));
const servers: Array<{ client: Client; transport: StdioClientTransport }> = [];
// A native-shaped interactive host supplies Muse's injected root identity. A
// direct Node MCP launch must remain untrusted rather than bypass bootstrap.
const MUSE_HOST = join(home, "muse.mjs");
const MUSE_CHILD_PIDS = join(home, "muse-child-pids.jsonl");
writeFileSync(MUSE_HOST, `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(process.execPath, [${JSON.stringify(SERVER)}, '--agent=muse'], { cwd: process.cwd(), env: { ...process.env, MUSE_SESSION_ID: 'e2e-muse-root' }, stdio: ['pipe','pipe','inherit'] });
if (child.pid) appendFileSync(${JSON.stringify(MUSE_CHILD_PIDS)}, JSON.stringify(child.pid) + "\\n");
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
child.on('error', () => process.exit(1)); child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`);

async function spawnAgent(agent: "claude" | "codex" | "opencode" | "antigravity" | "muse", name: string, nativeMuse = true): Promise<Client> {
  const client = new Client({ name: `test-${agent}`, version: "0.0.0" });
  codexHost(client, home, agent, name);
  const transport = new StdioClientTransport({
    command: process.execPath,
    cwd: home,
    args: agent === "muse" && nativeMuse ? [MUSE_HOST] : [SERVER, `--agent=${agent}`],
    env: { ...process.env, AGENT_BRIDGE_DAEMON: "1", AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_LOG_LEVEL: "debug", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_DATA_HOME: home } as Record<string, string>,
    stderr: "ignore",
  });
  // Register before connect so a failed startup still closes its owned transport.
  servers.push({ client, transport });
  await client.connect(transport);
  if (agent === "codex") await client.callTool({ name: "peers", arguments: {} });
  return client;
}

const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

async function waitFor(fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!existsSync(SERVER))("bundled MCP server end-to-end", () => {
  let claude: Client;
  let codex: Client;
  let antigravity: Client;
  let opencode: Client;
  let muse: Client;

  beforeAll(async () => {
    claude = await spawnAgent("claude", "claude-e2e");
    codex = await spawnAgent("codex", "codex-e2e");
    antigravity = await spawnAgent("antigravity", "antigravity-e2e");
    opencode = await spawnAgent("opencode", "opencode-e2e");
    muse = await spawnAgent("muse", "muse-e2e");
    await waitFor(async () => textOf(await claude.callTool({ name: "peers", arguments: {} })).includes("codex-e2e"));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    const pids = servers.flatMap(({ transport }) => transport.pid ? [transport.pid] : []);
    // The native-shaped Muse host owns a second MCP process. Register both
    // before capture, and again after closing producers in case startup raced.
    const captureMuseChildren = () => {
      // Missing evidence cannot prove that the host failed before spawning.
      if (!existsSync(MUSE_CHILD_PIDS)) throw new Error("Fixture Muse child PID record is missing; child exit is unproved");
      const records = readFileSync(MUSE_CHILD_PIDS, "utf8").trim().split("\n").filter(Boolean);
      if (!records.length) throw new Error("Fixture Muse child PID record is empty; child exit is unproved");
      for (const line of records) {
        const pid: unknown = JSON.parse(line);
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Fixture Muse child PID is invalid");
        if (!pids.includes(pid)) pids.push(pid);
      }
    };
    await attempt(async () => { captureMuseChildren(); });
    let stopBroker: (() => Promise<void>) | undefined;
    await attempt(async () => { stopBroker = await captureFixtureBroker(home, pids); });
    for (const { client, transport } of servers) {
      await attempt(() => client.close());
      await attempt(() => transport.close());
    }
    await attempt(async () => { captureMuseChildren(); });
    await attempt(() => until(() => pids.every(pid => !fixtureProcessExists(pid, "Fixture MCP server exit is unavailable"))));
    // A failed producer close must not race a signal with demand-start.
    if (!errors.length) await attempt(async () => { await stopBroker?.(); });
    // Keep the original failures and fixture when ownership/exit is uncertain.
    if (errors.length) throw new AggregateError(errors, `e2e fixture teardown failed; retained ${home}`);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("exposes the expected tools per agent", async () => {
    const c = (await claude.listTools()).tools.map((t) => t.name).sort();
    const x = (await codex.listTools()).tools.map((t) => t.name).sort();
    const g = (await antigravity.listTools()).tools.map((t) => t.name).sort();
    const o = (await opencode.listTools()).tools.map((t) => t.name).sort();
    expect(c).toEqual([...x, "native_child_grant"].sort());
    expect(g).toEqual(x);
    expect(o).toEqual(x);
    expect((await muse.listTools()).tools.map(t => t.name).sort()).toEqual(x);
    for (const client of [claude, codex, opencode, antigravity, muse]) {
      expect(client.getInstructions()).toContain("Any CLI can delegate to any CLI, including its own kind.");
      for (const agent of ["claude", "codex", "opencode", "antigravity", "muse"]) expect(client.getInstructions()).toContain(`ask_${agent}`);
    }
    expect(x).toEqual(["ask_antigravity", "ask_claude", "ask_codex", "ask_muse", "ask_opencode", "ask_owner", "auto_wake", "cancel_subagent", "cancel_transfer", "coordinator_availability", "dashboard", "decide", "decisions", "fetch_files", "get_conversation", "handoff_subagents", "health", "hook_event", "inbox", "list_models", "max_subagents", "message_subagent", "network_status", "pause_subagent", "peers", "project_main", "resource_slots", "resume_subagent", "search_history", "send", "send_files", "send_status", "set_job_outcome", "spawn_antigravity", "spawn_claude", "spawn_codex", "spawn_muse", "spawn_opencode", "usage_limits", "wait_for_message", "withdraw_owner_question"]);
  });

  it("declares the Claude channel capability only for Claude", () => {
    expect(claude.getServerCapabilities()?.experimental?.["claude/channel"]).toEqual({});
    expect(codex.getServerCapabilities()?.experimental?.["claude/channel"]).toBeUndefined();
  });

  it("refuses main-peer authority for a direct Muse MCP launch under an unknown host", async () => {
    const unknown = await spawnAgent("muse", "muse-unknown-host", false);
    try {
      const tools = (await unknown.listTools()).tools.map(tool => tool.name);
      for (const tool of ["ask_muse", "spawn_muse", "decide", "report_progress"]) expect(tools).not.toContain(tool);
      expect((await unknown.callTool({ name: "peers", arguments: {} })).isError).toBe(true);
      expect((await unknown.callTool({ name: "send", arguments: { to: "claude-e2e", message: "unauthenticated fixture message" } })).isError).toBe(true);
      expect(textOf(await claude.callTool({ name: "peers", arguments: {} }))).not.toContain("muse-unknown-host");
    } finally { await unknown.close(); }
  });

  it("files notify-mode owner questions through every bundled CLI without waiting for an answer",async () => {
    const args={title:"Fixture owner scope?",topic:"e2e-owner-scope",context:"Synthetic MCP contract check",options:[{id:"small",label:"Small",consequence:"Ships sooner",recommended:true},{id:"large",label:"Large",consequence:"Ships later",recommended:false}],blocking:true,blocks:"Fixture scope",meanwhile:"Run independent checks"};
    const results=[];
    for (const client of [claude,codex,antigravity]) results.push(JSON.parse(textOf(await client.callTool({name:"ask_owner",arguments:args}))));
    expect(results.map(r => r.merged)).toEqual([false,true,true]);
    expect(new Set(results.map(r => r.question.id)).size).toBe(1);
    expect(results[2].question).toMatchObject({kind:"question",status:"open",deliveries:[]});
    expect(results[2].question.askers).toHaveLength(3);
  });

  it("round-trips a question and a threaded answer", async () => {
    const sent = textOf(await claude.callTool({ name: "send", arguments: { to: "codex", message: "What is 2+2?" } }));
    expect(sent).toContain("codex-e2e");
    const id = /Message (\S+) sent/.exec(sent)![1]!;

    // Codex sees it through its UserPromptSubmit hook.
    // Keep the native host's admitted session: this is an active-turn delivery
    // check, not a session replacement inside the hook's 1500ms budget.
    const hook = JSON.parse(textOf(await codex.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: "fixture-codex-e2e" } })));
    expect(hook.hookSpecificOutput.additionalContext).toContain("What is 2+2?");

    const waiting = claude.callTool({ name: "wait_for_message", arguments: { timeout_sec: 10, reply_to: id } });
    await codex.callTool({ name: "send", arguments: { to: "claude-e2e", message: "4", reply_to: id } });
    const answer = textOf(await waiting);
    expect(answer).toContain(`reply_to="${id}"`);
    expect(answer).toContain("\n4\n");
    expect(answer).toContain('hop="1"');
  });

  it("auto-wake turns a Stop into a continuation", async () => {
    await codex.callTool({ name: "auto_wake", arguments: { enabled: true } });
    await claude.callTool({ name: "send", arguments: { to: "codex-e2e", message: "one more thing" } });
    await waitFor(async () => {
      const out = JSON.parse(textOf(await codex.callTool({ name: "hook_event", arguments: { event: "Stop", stop_hook_active: false } })));
      return out.decision === "block" && out.reason.includes("one more thing");
    });
  });

  it("reports an empty inbox after everything was consumed", async () => {
    expect(textOf(await codex.callTool({ name: "inbox", arguments: {} }))).toContain("No unread messages");
  });

  it("rebuilds through the bundled CLI and searches bounded linked hits through MCP", async () => {
    const sent = textOf(await claude.callTool({ name: "send", arguments: { to: "codex-e2e", message: "walnut bundled history" } }));
    const id = /Message (\S+) sent/.exec(sent)![1]!;
    const cli = join(import.meta.dirname, "..", "plugins", "claude", "dist", "cli.mjs");
    await claude.callTool({ name: "decide", arguments: { topic: "Maintenance", text: "Keep source data", scope: "all" } });
    const source = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      const before = source.prepare("SELECT id,recipient,body,read_at FROM messages ORDER BY id,recipient").all();
      const result = await promisify(execFile)(process.execPath, [cli, "reindex"], { cwd: home, env: { ...process.env, AGENT_BRIDGE_DAEMON: "1", AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_DASHBOARD: "off", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_DATA_HOME: home }, timeout: 30_000 });
      expect(result.stdout).toContain("History index rebuilt");
      expect(source.prepare("SELECT id,recipient,body,read_at FROM messages ORDER BY id,recipient").all()).toEqual(before);
    } finally { source.close(); }
    const found = JSON.parse(textOf(await codex.callTool({ name: "search_history", arguments: { query: "walnut bundled", filters: { kind: "message", agent: "claude" }, limit: 1 } })));
    expect(found.hits).toMatchObject([{ message: id, snippet: "walnut bundled history" }]);
    expect(found.hits[0].sourceLink).toBe(`/api/history/${encodeURIComponent(found.hits[0].id)}`);
    expect(found.hits[0].id).toMatch(new RegExp(`^(message:${id}|durable:\\d+)$`));
    expect(found.answer).toBeUndefined();
    const empty = JSON.parse(textOf(await codex.callTool({ name: "search_history", arguments: { query: "unfindable-query-xyz", answer: true } })));
    expect(empty.answer).toMatchObject({ agent: null, model: null, sources: [] });
    const invalid = await codex.callTool({ name: "search_history", arguments: { query: "walnut", filters: { since: 200, until: 100 } } });
    expect(invalid.isError).toBe(true);
  });

  it("returns structured decision revisions and searchable history through MCP", async () => {
    const tool = (await claude.listTools()).tools.find((t) => t.name === "decisions")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const first = JSON.parse(textOf(await claude.callTool({ name: "decide", arguments: { topic: "Test decision", text: "Original choice", scope: "all" } })));
    expect(first.decision).toMatchObject({ topic: "test decision", text: "Original choice", current: true, author: { name: "claude-e2e" }, sourceMessageId: null });
    expect(first.deliveredTo).toContain("codex-e2e");
    const second = JSON.parse(textOf(await codex.callTool({ name: "decide", arguments: { topic: "TEST DECISION", text: "Updated choice", scope: "all" } })));
    expect(second.decision.supersedes).toBe(first.decision.id);
    const current = JSON.parse(textOf(await claude.callTool({ name: "decisions", arguments: { query: "CHOICE", scope: "all" } })));
    expect(current).toHaveLength(1);
    expect(current[0].text).toBe("Updated choice");
    const history = JSON.parse(textOf(await codex.callTool({ name: "decisions", arguments: { query: "test decision", scope: "all", history: true } })));
    expect(history.map((d: any) => d.current)).toEqual([true, false]);
    const invalid = await claude.callTool({ name: "decide", arguments: { topic: "invalid source", text: "choice", source_message_id: "missing" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("Source message does not exist");
  });
});
