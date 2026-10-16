import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { MAX_BODY_CHARS, MAX_FRAME_BYTES } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeError, type BridgeMessage } from "../src/core/protocol.js";
import type { BridgeNode } from "../src/core/node.js";
import { buildHookResponse, claudeWakeCandidate, noteOversizedMessages, oversizedMessageNoted } from "../src/mcp/hooks.js";
import { reportModActivity } from "../src/mcp/hook-ownership.js";
import { pageProjectJobSummaries } from "../src/core/project-job-summary.js";
import { RewakeEndpoint, sessionFile, WAKE_HEADER } from "../src/mcp/rewake.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { JobManager } from "../src/mcp/jobs.js";
import { mcpContentBytes, MCP_RESULT_BUDGET_BYTES } from "../src/mcp/output-bounds.js";
import { channelPusher, registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); await env.cleanup(); vi.restoreAllMocks(); });

/** The real tool handlers behind a real MCP client, so results are serialized as the transport sends them. */
async function mcp(ctx: ServerContext) {
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, ctx, []);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  closers.push(async () => { await client.close(); await server.close(); });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(mcpContentBytes(result.content.map((c) => c.text))).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  };
}
const context = (node: BridgeNode, extra: Partial<ServerContext> = {}): ServerContext => ({ agent: "claude", node, home: env.home,
  cfg: { ...DEFAULT_CONFIG, lingerSec: 0 }, log: nullLogger, cwd: () => env.home, channelActive: () => false, ...extra });
const big = (tag: string) => `${tag} ${"x".repeat(MAX_BODY_CHARS - tag.length - 1)}`;

describe("AB-404 peers: the real cause is a projectJobs response over the broker frame", () => {
  it("refuses full records over 4 MiB as too_large, while slim summary pages list every job in peers", async () => {
    // A fake registry: twelve jobs whose full records keep their inline delivery history (about 5.4 MB in all).
    const envelope = (i: number, n: number) => ({ id: `m-${i}-${n}`, from: { id: "x", name: "claude-main", agent: "claude" }, to: `codex-job-${i}`,
      body: "d".repeat(150_000), conversationId: "c", hop: 0, createdAt: 1 });
    const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: `codex-job-${String(i).padStart(2, "0")}`, agent: "codex",
      model: null, prompt: "task", startedAt: Date.now(), status: i ? "done" : "running", sessionId: i % 2 ? `s-${i}` : null,
      workdir: env.home, worktree: null, owner: "claude-main", rootName: "claude-main", supervisor: "first", args: { title: `Job ${i}` },
      deliveryHistory: [0, 1, 2].map((n) => envelope(i, n)) }));
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs }));
    const node = env.node("claude-main"); await node.start();
    const refused = await node.projectJobs().then(() => null, (err: unknown) => err);
    expect(refused).toBeInstanceOf(BridgeError);
    expect(refused).toMatchObject({ code: "too_large", details: { limit: MAX_FRAME_BYTES } });
    expect((refused as BridgeError).details!.bytes as number).toBeGreaterThan(MAX_FRAME_BYTES);

    const summaries = await node.projectJobSummaries();
    expect(summaries.map((j) => j.name)).toEqual(jobs.map((j) => j.name));
    expect(summaries[1]).toMatchObject({ agent: "codex", status: "done", owner: "claude-main", title: "Job 1", hasSession: true, workdir: env.home });
    expect(JSON.stringify(summaries)).not.toContain("ddddd");

    const call = await mcp(context(node, { agent: "codex" }));
    const peers = await call("peers");
    expect(peers.isError).toBe(false);
    expect(peers.text).not.toContain("Message too large");
    for (const job of jobs) expect(peers.text).toContain(`- ${job.name} (codex, ${job.status}; primary claude-main) "${job.args.title}"`);
  });

  it("falls back to full records on an older broker and reports a refused frame truthfully", async () => {
    const node = env.node("claude-old");
    const requests: string[] = [];
    Object.assign(node, { withClient: async (fn: (client: unknown) => unknown) => fn({ request: async (op: string) => {
      requests.push(op);
      if (op === "projectJobSummaries") throw new BridgeError("protocol_mismatch", "Broker v1 does not support projectJobSummaries required by server", { operation: op });
      return [{ name: "b-job", agent: "codex", status: "done", prompt: "full", args: { title: "B" } }, { name: "a-job", agent: "codex", status: "running" }];
    } }) });
    expect((await node.projectJobSummaries()).map((j) => j.name)).toEqual(["a-job", "b-job"]);
    expect(requests).toEqual(["projectJobSummaries", "projectJobs"]);

    // A broker that refuses its own oversized response: peers stays usable and names the frame limit.
    const frame = new BridgeError("too_large", `response is 5000000 bytes, over the ${MAX_FRAME_BYTES}-byte frame limit`, { bytes: 5_000_000, limit: MAX_FRAME_BYTES, retryable: false });
    const fake = { id: "self", name: "self", isBroker: false, autoWakeEnabled: false, wasReplaced: false, isConnected: true,
      setNotificationWaitHandlers: () => {}, peers: async () => [], health: async () => null, refreshPending: async () => {},
      projectJobSummaries: async () => { throw frame; }, unread: () => [], brokerLoad: async () => null, nativeChildren: async () => [] };
    const call = await mcp(context(fake as unknown as BridgeNode, { agent: "codex" }));
    const peers = await call("peers");
    expect(peers.isError).toBe(false);
    // Numbers are formatted for the user's locale.
    expect(peers.text).toMatch(/Project jobs are not shown: The bridge's response to this call is 5\D?000\D?000 bytes, over the 4\D?194\D?304-byte frame limit/);
    expect(peers.text).not.toContain("Message too large");
    fake.peers = async () => { throw frame; };
    const failed = await call("peers");
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/over the 4\D?194\D?304-byte frame limit/);
    expect(failed.text).not.toMatch(/200\D?000 characters/);
  });

  it("walks every summary page in order when a page holds only a few jobs", async () => {
    const records = Array.from({ length: 23 }, (_, i) => ({ id: `id-${i}`, name: `job-${String(22 - i).padStart(2, "0")}`, agent: "codex",
      status: i % 3 ? "done" : "running", sessionId: `s-${i}`, args: { title: `Title ${i} ${"t".repeat(40)}` }, prompt: "p".repeat(5_000) }));
    const node = env.node("claude-pages");
    const offsets: number[] = [], sizes: number[] = [];
    Object.assign(node, { withClient: async (fn: (client: unknown) => unknown) => fn({ request: async (op: string, args: { offset?: number }) => {
      expect(op).toBe("projectJobSummaries");
      offsets.push(args.offset ?? 0);
      const page = pageProjectJobSummaries(records, args, 400);
      sizes.push(page.jobs.length);
      return page;
    } }) });
    const all = await node.projectJobSummaries();
    expect(all.map((j) => j.name)).toEqual(records.map((r) => r.name).sort());
    expect(new Set(all.map((j) => j.id)).size).toBe(records.length);
    expect(JSON.stringify(all)).not.toContain("ppppp");
    expect(offsets.length).toBeGreaterThan(4);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBe(offsets[i - 1]! + sizes[i - 1]!);
    expect(sizes.every((n) => n > 0)).toBe(true);
  });

  it("a native child's peers reports a refused full listing from an older broker instead of failing", async () => {
    const parent = env.node("claude-parent");
    await parent.setSessionId("parent-session"); await parent.start();
    await parent.nativeChild({ action: "start", agentId: "worker" });
    vi.spyOn(parent, "projectJobSummaries").mockRejectedValue(new BridgeError("too_large",
      `response is 5000000 bytes, over the ${MAX_FRAME_BYTES}-byte frame limit`, { bytes: 5_000_000, limit: MAX_FRAME_BYTES, retryable: false }));
    const call = await mcp(context(parent));
    const peers = await call("peers", { native_child: "worker" });
    expect(peers.isError).toBe(false);
    expect(peers.text).toContain("Your native child bridge address is claude-parent/sub:worker.");
    expect(peers.text).toMatch(/Project jobs are not shown: .*over the 4\D?194\D?304-byte frame limit/);
    expect(peers.text).toContain("Explicit send_to grants:");
  });
});

describe("AB-404 mail is marked read only when shown in full", () => {
  it("inbox lists a too-large message by id, delivers the rest, and reads it in pages", async () => {
    const reader = env.node("claude-reader"), sender = env.node("codex-sender", "codex");
    await reader.start(); await sender.start();
    await sender.send({ to: reader.name, body: big("BIG-ONE") });
    await sender.send({ to: reader.name, body: "small after the big one" });
    await until(() => reader.unread().length === 2);
    const bigId = reader.unread().find((m) => m.body.startsWith("BIG-ONE"))!.id;
    const markRead = vi.spyOn(reader, "markRead");
    const call = await mcp(context(reader));

    const first = await call("inbox");
    expect(first.text).toContain("small after the big one");
    expect(first.text).toContain(`Message ${bigId} from codex-sender (${MAX_BODY_CHARS} characters) is too large to show in one result; it stays unread.`);
    expect(first.text).toContain(`inbox(id="${bigId}", offset=0)`);
    expect(reader.unread().map((m) => m.id)).toEqual([bigId]);
    for (const [ids] of markRead.mock.calls) expect(ids).not.toContain(bigId);

    // Jumping to a later page does not count as reading the whole message, and the last page says so.
    const tail = await call("inbox", { id: bigId, offset: MAX_BODY_CHARS - 10 });
    expect(tail.text).not.toContain(`End of message ${bigId}.`);
    expect(tail.text).toContain(`This is the last page, but message ${bigId} stays unread: characters 0-${MAX_BODY_CHARS - 10} were not read yet.`);
    expect(tail.text).toContain(`Continue with inbox(id="${bigId}", offset=0).`);
    expect(reader.unread().map((m) => m.id)).toEqual([bigId]);

    let offset = 0, pages = 0, body = "";
    for (;;) {
      const page = await call("inbox", { id: bigId, offset });
      pages++;
      body += /<agent-bridge-message[^>]*>\n([\s\S]*)\n<\/agent-bridge-message>/.exec(page.text)![1];
      const next = /offset=(\d+)\)\. The message stays unread/.exec(page.text);
      if (!next) { expect(page.text).toContain(`End of message ${bigId}.`); break; }
      expect(reader.unread().map((m) => m.id)).toEqual([bigId]);
      offset = Number(next[1]);
    }
    expect(pages).toBeGreaterThan(1);
    expect(body).toBe(big("BIG-ONE"));
    expect(reader.unread()).toEqual([]);
    expect((await call("inbox", { id: bigId })).text).toContain(`No unread message ${bigId}`);
  });

  it("wait_for_message leaves a too-large message unread in block and notify mode", async () => {
    const reader = env.node("claude-waiter"), sender = env.node("codex-sender", "codex");
    await reader.start(); await sender.start();
    const call = await mcp(context(reader));
    await sender.send({ to: reader.name, body: big("BLOCKED") });
    await until(() => reader.unread().length === 1);
    const blocked = await call("wait_for_message", { mode: "block", from: "codex-sender", timeout_sec: 5 });
    expect(blocked.text).toContain("is too large to show in one result; it stays unread");
    expect(reader.unread()).toHaveLength(1);

    await sender.send({ to: reader.name, body: big("NOTIFY") });
    await until(() => reader.unread().length === 2);
    const notify = await call("wait_for_message", { mode: "notify", from: "codex-sender" });
    expect(notify.text).toContain("is too large to show in one result; it stays unread");
    expect(reader.unread()).toHaveLength(2);

    await sender.send({ to: reader.name, body: "fits" });
    await until(() => reader.unread().length === 3);
    // Messages already listed as too large do not answer later waits; a fitting one is consumed as before.
    const small = await call("wait_for_message", { mode: "block", from: "codex-sender", timeout_sec: 5 });
    expect(small.text).toContain("[agent-bridge] Message received.");
    expect(small.text).toContain("fits");
    expect(reader.unread().map((m) => m.body.slice(0, 7)).sort()).toEqual(["BLOCKED", "NOTIFY "]);
  });

  it("a nested child's wait_for_message delivers what fits and keeps the big message unread", async () => {
    const inbox = new LocalCoordinator("nested", "root");
    const message = (id: string, body: string): BridgeMessage => ({ id, from: { id: "job:x", name: "codex-job-x", agent: "codex" }, to: "nested",
      body, conversationId: "c", hop: 0, createdAt: Date.now() } as BridgeMessage);
    inbox.deliverLocal(message("big", big("CHILD-BIG")));
    inbox.deliverLocal(message("small", "child small"));
    const jobs = new JobManager(inbox, nullLogger);
    closers.push(async () => jobs.cancelAll());
    const call = await mcp({ agent: "codex", node: null as unknown as BridgeNode, childInbox: inbox, jobs,
      home: env.home, cfg: DEFAULT_CONFIG, log: nullLogger, cwd: () => env.home, channelActive: () => false });
    const result = await call("wait_for_message", { mode: "block" });
    expect(result.text).toContain("child small");
    expect(result.text).toContain('inbox(id="big", offset=0)');
    expect(inbox.unread().map((m) => m.id)).toEqual(["big"]);
  });

  it("hooks hand out only messages shown in full and list a big one once", async () => {
    const reader = env.node("claude-hooked"), sender = env.node("codex-sender", "codex");
    await reader.start(); await sender.start();
    const ctx = context(reader);
    await sender.send({ to: reader.name, body: big("HOOK-BIG") });
    await sender.send({ to: reader.name, body: "hook small" });
    await until(() => reader.unread().length === 2);
    const bigId = reader.unread().find((m) => m.body.startsWith("HOOK-BIG"))!.id;
    const first = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
    const handed = JSON.stringify(first);
    expect(mcpContentBytes([handed])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    expect(handed).toContain("hook small");
    expect(handed).toContain(`Message ${bigId}`);
    expect(handed).not.toContain("HOOK-BIG x");
    expect(reader.unread().map((m) => m.id)).toEqual([bigId]);
    // Listed once: later hooks neither repeat it nor block a Stop on it, and it stays unread for inbox paging.
    expect(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false })).toEqual({});
    expect(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })).toEqual({});
    expect(reader.unread().map((m) => m.id)).toEqual([bigId]);
  });

  it("a nested child's large parent-link text defers a normal child message instead of listing it as too large", async () => {
    const inbox = new LocalCoordinator("nested", "root");
    const child = (id: string, body: string): BridgeMessage => ({ id, from: { id: "job:x", name: "codex-job-x", agent: "codex" }, to: "nested",
      body, conversationId: "c", hop: 0, createdAt: Date.now() } as BridgeMessage);
    const jobs = new JobManager(inbox, nullLogger);
    closers.push(async () => jobs.cancelAll());
    let reads = 0;
    // Parent-link mail is consumed when fetched; a child result arrives while that fetch is in flight.
    const parent = { name: "root-session", send: vi.fn(), progress: vi.fn(), siblings: { peers: async () => [], send: vi.fn() },
      inbox: async () => {
        if (++reads > 1) return [];
        await new Promise((resolve) => setTimeout(resolve, 10));
        inbox.deliverLocal(child("child-1", `CHILD ${"c".repeat(20_000)}`));
        return [{ id: "p1", body: `PARENT ${"p".repeat(40_000)}` }, { id: "p2", body: `PARENT ${"q".repeat(40_000)}` }];
      } };
    const ctx = { agent: "codex", node: null as unknown as BridgeNode, childInbox: inbox, jobs, parent, home: env.home,
      cfg: DEFAULT_CONFIG, log: nullLogger, cwd: () => env.home, channelActive: () => false } as unknown as ServerContext;
    const first = JSON.stringify(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false }));
    expect(mcpContentBytes([first])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    expect(first).toContain("PARENT pppp");
    expect(first).not.toContain("CHILD cccc");
    expect(first).not.toContain("too large");
    expect(inbox.unread().map((m) => m.id)).toEqual(["child-1"]);
    // Not listed as oversized: the next hook, without the one-time parent text, shows it in full and reads it.
    const second = JSON.stringify(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false }));
    expect(second).toContain("CHILD cccc");
    expect(second).not.toContain("too large");
    expect(inbox.unread()).toEqual([]);
  });

  it("a mod wake-up hands out only what fits; a big message is listed once and stays unread (AB-396 path)", async () => {
    const me = env.node("claude-modded", "claude"), peer = env.node("codex-sender", "codex");
    await me.start(); await peer.start(); await me.setSessionId("sess-404");
    const ctx = context(me, { rewakeAvailable: true });
    const rewake = new RewakeEndpoint(env.home, me, (m) => claudeWakeCandidate(ctx, m), nullLogger, (event) => reportModActivity(ctx, event), undefined,
      { noted: (id) => oversizedMessageNoted(ctx, id), note: (ids) => noteOversizedMessages(ctx, ids) });
    await rewake.start();
    closers.push(() => rewake.stop());
    rewake.register("sess-404");
    ctx.wakeDelivery = rewake.delivery();
    const reg = JSON.parse(readFileSync(sessionFile(env.home, "sess-404"), "utf8")) as { port: number; secret: string };
    const modPoll = async () => ((await (await fetch(`http://127.0.0.1:${reg.port}/wait?role=mod`,
      { headers: { authorization: `Bearer ${reg.secret}` }, signal: AbortSignal.timeout(3_000) })).json()) as { text: string }).text;
    const markRead = vi.spyOn(me, "markRead");

    await peer.send({ to: me.name, body: big("MOD-BIG") });
    await peer.send({ to: me.name, body: "mod small" });
    await until(() => me.unread().length === 2);
    const bigId = me.unread().find((m) => m.body.startsWith("MOD-BIG"))!.id;
    const wake = await modPoll();
    expect(mcpContentBytes([wake])).toBeLessThanOrEqual(MCP_RESULT_BUDGET_BYTES);
    expect(wake.startsWith(WAKE_HEADER)).toBe(true);
    expect(wake).toContain("mod small");
    expect(wake).toContain(`Message ${bigId} from codex-sender (${MAX_BODY_CHARS} characters) is too large to show in one result; it stays unread.`);
    expect(wake).not.toContain("MOD-BIG x");
    expect(me.unread()).toHaveLength(2);
    // The wake-up's own prompt reads only what it showed in full.
    await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: "sess-404", promptId: "wake-1", stopHookActive: false, prompt: wake });
    expect(me.unread().map((m) => m.id)).toEqual([bigId]);
    await buildHookResponse(ctx, { event: "Stop", sessionId: "sess-404", promptId: "wake-1", stopHookActive: false });
    // Listed once: the next wake-up carries only new mail, and the big message is never marked read.
    await peer.send({ to: me.name, body: "later small" });
    await until(() => me.unread().length === 2);
    const next = await modPoll();
    expect(next).toContain("later small");
    expect(next).not.toContain(bigId);
    for (const [ids] of markRead.mock.calls) expect(ids).not.toContain(bigId);
    expect(me.unread().map((m) => m.id)).toContain(bigId);
  });

  it("the channel announces a too-large message by id, leaves it unread and does not push it again", async () => {
    const reader = env.node("claude-channel"), sender = env.node("codex-sender", "codex");
    await reader.start(); await sender.start();
    const ctx = context(reader, { channelActive: () => true });
    const pushed: { content: string; meta: Record<string, string> }[] = [];
    const push = channelPusher(ctx, () => true, async (params) => { pushed.push(params); });
    await sender.send({ to: reader.name, body: big("CHANNEL-BIG") });
    await sender.send({ to: reader.name, body: "channel small" });
    await until(() => reader.unread().length === 2);
    const bigMessage = reader.unread().find((m) => m.body.startsWith("CHANNEL-BIG"))!;
    const small = reader.unread().find((m) => m.body === "channel small")!;
    await push(bigMessage); await push(small);
    expect(pushed.map((p) => p.meta.message_id)).toEqual([bigMessage.id, small.id]);
    expect(pushed[0]!.content).toBe(`[agent-bridge] Message ${bigMessage.id} from codex-sender (${MAX_BODY_CHARS} characters) is too large to show in one result; ` +
      `it stays unread. Read it in pages with inbox(id="${bigMessage.id}", offset=0).`);
    expect(pushed[1]!.content).toBe("channel small");
    expect(reader.unread().map((m) => m.id)).toEqual([bigMessage.id]);
    await push(bigMessage);
    expect(pushed).toHaveLength(2);
    expect(reader.unread().map((m) => m.id)).toEqual([bigMessage.id]);
  });
});

describe("AB-404 native child peers keep their scope", () => {
  it("lists only the parent's jobs supervised by this session, from slim summaries", async () => {
    const parent = env.node("claude-parent");
    await parent.setSessionId("parent-session"); await parent.start();
    await parent.nativeChild({ action: "start", agentId: "worker" });
    const summaries = vi.spyOn(parent, "projectJobSummaries").mockResolvedValue([
      { name: "codex-job-mine", agent: "codex", status: "running", owner: "claude-parent", supervisor: parent.currentSessionId!, hasSession: false },
      { name: "codex-job-other-owner", agent: "codex", status: "running", owner: "claude-else", supervisor: parent.currentSessionId!, hasSession: false },
      { name: "codex-job-other-session", agent: "codex", status: "done", owner: "claude-parent", supervisor: "another-session", hasSession: false },
    ]);
    const projectJobs = vi.spyOn(parent, "projectJobs");
    const call = await mcp(context(parent));
    const peers = await call("peers", { native_child: "worker" });
    expect(peers.text).toContain("Your native child bridge address is claude-parent/sub:worker.");
    expect(peers.text).toContain("codex-job-mine (codex, running)");
    expect(peers.text).not.toContain("codex-job-other-owner");
    expect(peers.text).not.toContain("codex-job-other-session");
    expect(summaries).toHaveBeenCalled();
    expect(projectJobs).not.toHaveBeenCalled();
  });
});
