import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nativeOwner } from "../src/core/recipient-ownership.js";
import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import { DELEGATION_METADATA_VERSION, JOBS_FILE } from "../src/core/constants.js";
import * as jsonStore from "../src/core/json-store.js";
import * as fileCache from "../src/core/file-cache.js";
import { DEFAULT_SIBLING_MAX_HOPS, isJobSendTarget } from "../src/core/job-messaging.js";
import { formatSiblingMessages } from "../src/mcp/format.js";
import { readStore } from "../src/mcp/jobs.js";
import { BridgeNode } from "../src/core/node.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { isSiblingNote, type BridgeMessage, type CodingAgent } from "../src/core/protocol.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { startUi } from "../src/cli/ui.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, type Job } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { SiblingLink } from "../src/mcp/siblings.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { retainFixtureJob } from "./owned-mail.js";

const MAX_HOPS = 3;
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv;
let supervisor: BridgeNode;
const nodes: BridgeNode[] = [];
const links: ParentLink[] = [];
const chats: SiblingLink[] = [];

beforeEach(async () => {
  env = makeEnv();
  // These tests require explicit cross-session grants, independent of optional
  // project-team sharing between masters in the same physical fixture folder.
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ projectGroups: false }));
  supervisor = env.node("claude-supervisor");
  await supervisor.start();
});

afterEach(async () => {
  for (const chat of chats.splice(0)) chat.close();
  for (const link of links.splice(0)) await link.close();
  for (const node of nodes.splice(0)) await node.stop();
  await env.cleanup();
});

async function sibling(id: string, agent: CodingAgent, owner = "supervisor-session", live = true, sendTo: string[] = []) {
  const name = `${agent}-job-${id}`;
  const job: Job = { id, name, agent, model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(),
    progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [], args: { send_to: sendTo } };
  const saved = readStore(join(env.home, JOBS_FILE)).find(j => j.id === id);
  if (saved) Object.assign(job, saved);
  job.args = { ...job.args, send_to: sendTo, title: `Task ${id}` };
  retainFixtureJob(env.home, job, saved?.owner ?? supervisor.name, saved?.supervisor ?? owner);
  const node = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db,
    agent: "other", jobAgent: agent, jobOwner: job.supervisor, jobParent: job.owner, jobTitle: `Task ${id}`,
    jobSendTo: sendTo,
    id: `job:${id}`, name, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  nodes.push(node);
  const chat = new SiblingLink(node, job, MAX_HOPS, nullLogger);
  chats.push(chat);
  const parent = new ParentLink(supervisor.name, () => {}, nullLogger, undefined, chat);
  links.push(parent);
  await parent.start();
  if (live) job.live = { post: (body, message) => parent.post(body, message) };
  await node.start();
  return { node, job, chat, parent, child: parentFromEnv(parent.childEnv())! };
}

describe("sibling job messaging", () => {
  it("marks a sibling message read only when the child consumes its context", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const sent = (await a.chat.send(b.job.name, "Review the capture")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(await a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: null }]);
    await b.child.inbox();
    await expect.poll(() => a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: expect.any(Number) }]);
  });

  it("preserves unconsumed turn-end sibling mail without starting a new turn", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const sent = (await a.chat.send(b.job.name, "One more detail")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(await b.parent.close()).toEqual([]);
    expect(b.node.unread().find((m) => m.id === sent.id)?.body).toBe("One more detail");
    expect(await a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: null }]);
  });
  it.each(["codex", "claude", "opencode"] as const)("exposes discovery and send through a delegated %s MCP server", async (agent) => {
    const a = await sibling("a", agent);
    const b = await sibling("b", "opencode");
    const client = new Client({ name: "test-sibling", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_DASHBOARD: "off",
        [DELEGATE_DEPTH_ENV]: "1", ...a.parent.childEnv() } as Record<string, string>, stderr: "ignore" });
    await client.connect(transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["checklist", "get_conversation", "health", "hook_event", "peers", "report_progress", "search_history", "send"]);
      const peers = await call("peers");
      expect(JSON.stringify(peers)).toContain(b.job.name);
      expect(JSON.stringify(peers)).toContain("Task b");
      expect(JSON.stringify(peers)).toContain("32 messages");
      expect(JSON.stringify(peers)).toContain("Explicit send_to grants: none");
      const sent = await call("send", { to: b.job.name, message: "Direct handover" });
      expect(sent.isError).toBeUndefined();
      const messageId = /Message (\S+) sent/.exec(JSON.stringify(sent))![1]!;
      await b.child.siblings.send(a.job.name, "Acknowledged", messageId);
      await until(() => supervisor.unread().length === 2);
      const hook = await call("hook_event", { event: "PostToolUse" });
      expect(JSON.stringify(hook)).toContain(b.job.name);
      expect(JSON.stringify(hook)).toContain("Acknowledged");
      expect((await call("send", { to: "unknown-job", message: "Wrong target" })).isError).toBe(true);
      writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
        { id: "past", name: "opencode-job-past", agent: "opencode", status: "failed", supervisor: "supervisor-session", finishedAt: 123, report: "Final findings" },
      ] }));
      expect(JSON.stringify(await call("peers"))).toContain("finished; will not answer");
      const finished = JSON.stringify(await call("send", { to: "opencode-job-past", message: "Any findings?" }));
      expect(finished).toContain("it will not answer");
      expect(finished).toContain("Final findings");
      expect(finished).toContain("1970-01-01T00:00:00.123Z");
    } finally {
      await client.close();
    }
  });

  it("lists only running siblings with titles and real agents, keeping them hidden from session peers", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    await sibling("c", "claude", "another-session");
    expect(await a.child.siblings.peers()).toEqual([{ name: b.job.name, title: "Task b", agent: "opencode", status: "running" }]);
    expect((await supervisor.peers()).map((p) => p.name)).toEqual([supervisor.name]);
    await b.node.updateJob({ jobTitle: "Updated task" });
    expect((await a.chat.peers())[0]!.title).toBe("Updated task");
    await b.node.stop();
    // The newly durable fixture keeps offline jobs discoverable too. Session
    // peers still hide runners; their queued channel keeps its exact job ID.
    await expect.poll(() => a.chat.peers()).toEqual([{ name: b.job.name, title: "Task b", agent: "opencode", status: "running" }]);
    expect((await supervisor.peers()).some(p => p.name === b.job.name)).toBe(false);
  });

  it("delivers threaded sibling replies and stores quiet supervisor copies without a conversation window", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const first = (await a.child.siblings.send(b.job.name, "The lock is yours")).messages[0]!;
    await until(() => supervisor.unread().length === 1);
    const received = await b.child.inbox();
    expect(received[0]).toMatchObject({ id: first.id, sibling: { from: { name: a.job.name, agent: "codex" }, hop: 0 } });
    const second = (await b.child.siblings.send(a.job.name, "Capture saved", first.id)).messages[0]!;
    expect(second).toMatchObject({ hop: 1, replyTo: first.id, conversationId: first.conversationId });
    await until(() => supervisor.unread().length === 2);
    expect(supervisor.unread().every(isSiblingNote)).toBe(true);
    expect(supervisor.unread().map((m) => m.body)).toEqual([
      `Sibling message to ${b.job.name}:\n\nThe lock is yours`, `Sibling message to ${a.job.name}:\n\nCapture saved`,
    ]);
    expect(a.node.lastSentAt).toBe(0);
    expect(supervisor.lastSentAt).toBe(0);
    expect(new JobManager(supervisor, nullLogger).isNote(supervisor.unread()[0]!)).toBe(true);
  });

  it("rejects other supervisors, self, broadcasts, unknown jobs and unrelated reply ids", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const other = await sibling("c", "opencode", "another-session");
    for (const target of [other.job.name, a.job.name, "*", supervisor.name, "codex-job-missing"]) {
      await expect(a.child.siblings.send(target, "hello")).rejects.toThrow(/no sibling/);
    }
    await expect(a.child.siblings.send(b.job.name, "reply", "unknown-id")).rejects.toThrow(/reply_to/);
    await expect(a.node.send({ to: other.job.name, body: "spoofed chat", conversationId: "siblings-forged" })).rejects.toThrow(/same supervisor/);
    expect(supervisor.unread()).toEqual([]);
    expect(await other.child.inbox()).toEqual([]);
  });

  it("lists completed siblings and queues their mail until their next turn", async () => {
    const a = await sibling("a", "codex");
    const past = { id: "past", name: "opencode-job-past", agent: "opencode", status: "done", startedAt: 1, finishedAt: 123, report: "Saved final report", supervisor: "supervisor-session", args: { title: "Earlier task" } };
    retainFixtureJob(env.home, past as unknown as Job, supervisor.name, "supervisor-session");
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 4, jobs: [
      ...readStore(join(env.home, JOBS_FILE)),
      { id: "other", name: "claude-job-other", agent: "claude", status: "failed", supervisor: "other-session" },
    ] }));
    expect(await a.child.siblings.peers()).toEqual([{ name: "opencode-job-past", title: "Earlier task", agent: "opencode", status: "done", finishedAt: 123 }]);
    await expect(a.child.siblings.send("claude-job-other", "Cross-session mail")).rejects.toThrow(/no sibling/);
    const queued = await a.child.siblings.send("opencode-job-past", "Next-turn handover");
    expect(queued.queuedFor).toEqual(["opencode-job-past"]);
    expect(queued.finishedRecipient).toEqual({ name: "opencode-job-past", status: "done", finishedAt: 123, report: "Saved final report" });
    const resumed = await sibling("past", "opencode");
    await until(() => resumed.node.hasSeen(queued.messages[0]!.id));
    expect(await resumed.child.inbox()).toMatchObject([{ sibling: { body: "Next-turn handover", from: { name: a.job.name } } }]);
  });

  it("uses terminal stored status while a finished runner is still connected", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
      { id: "b", name: b.job.name, agent: "opencode", status: "done", supervisor: "supervisor-session", finishedAt: 456, report: "Complete" },
    ] }));
    expect((await a.chat.peers())[0]).toMatchObject({ status: "done", finishedAt: 456 });
    expect((await a.chat.send(b.job.name, "Any result?")).finishedRecipient).toMatchObject({ status: "done", report: "Complete" });
  });

  it("keeps the sibling group stable when the supervisor session id becomes known after spawning", async () => {
    const jobs = new JobManager(supervisor, nullLogger);
    const held = () => new Promise<never>(() => {});
    const first = jobs.start("codex", null, "first", held);
    await supervisor.setSessionId("learned-session");
    const second = jobs.start("claude", null, "second", held);
    expect(second.supervisor).toBe(first.supervisor);
    jobs.cancelAll();
  });

  it("keeps completed batches and continued legacy jobs in the supervisor's group after restore", async () => {
    const path = join(env.home, JOBS_FILE);
    const jobs = new JobManager(supervisor, nullLogger, path);
    const first = jobs.start("codex", null, "first batch", async () => ({ sessionId: "thread-first", text: "done", isError: false, details: {} }));
    await until(() => first.status === "done");
    await supervisor.setSessionId("learned-session");
    const second = jobs.start("claude", null, "later batch", async () => ({ sessionId: "thread-second", text: "done", isError: false, details: {} }));
    await until(() => second.status === "done");
    expect(second.supervisor).toBe(first.supervisor);
    const stored = readStore(path);
    stored.push({ ...stored[0]!, id: "legacy", name: "codex-job-legacy", supervisor: undefined });
    writeFileSync(path, JSON.stringify({ version: 1, jobs: stored }));
    const restored = new JobManager(supervisor, nullLogger, path);
    restored.restore(() => () => () => new Promise<never>(() => {}));
    const legacy = restored.find("codex-job-legacy")!;
    expect(legacy.supervisor).toBe(first.supervisor);
    expect(restored.followUp(legacy.name, "continue").outcome).toBe("started");
    // A runner from before the migration still advertises the supervisor name until restarted.
    const old = await sibling("legacy", "codex", supervisor.name);
    const later = await sibling(second.id, "claude", first.supervisor);
    expect((await old.chat.peers()).map((p) => p.name)).toContain(later.job.name);
    const sent = await old.chat.send(later.job.name, "Cross-batch handover");
    expect(sent.deliveredTo).toEqual([later.job.name]);
    restored.cancelAll();
    jobs.cancelAll();
  });

  describe("source-witnessed legacy supervisor assignment", () => {
    // The supervisor's in-process broker starts a history worker thread whose startup
    // ask reconciliation takes the zero-wait jobs.json lease concurrently with restore.
    // A real EJOBLOCKED then pre-empts the one SIMULATED refusal each fixture asserts,
    // so these fixtures run without that unrelated second lease holder.
    let priorIngest: string | undefined;
    beforeAll(() => { priorIngest = process.env.AGENT_BRIDGE_HISTORY_INGEST; process.env.AGENT_BRIDGE_HISTORY_INGEST = "0"; });
    afterAll(() => {
      if (priorIngest === undefined) delete process.env.AGENT_BRIDGE_HISTORY_INGEST;
      else process.env.AGENT_BRIDGE_HISTORY_INGEST = priorIngest;
    });

    // Passive fixture access only: no production observer or manufactured witness.
    function state(jobs: JobManager) {
      return jobs as unknown as { history: Map<string, Job>; legacySupervisors: Map<string, unknown>;
        receipts: { value: { job: Record<string, unknown> } }[] };
    }

    function deferred(code: "STORE_UPGRADE_DEFERRED" | "EJOBLOCKED" = "STORE_UPGRADE_DEFERRED") {
      const path = join(env.home, JOBS_FILE), now = Date.now();
      const first = { id: "earlier", name: "codex-job-earlier", agent: "codex", model: null, owner: supervisor.name,
        supervisor: supervisor.id, rootSession: supervisor.id, rootName: supervisor.name, metadataVersion: DELEGATION_METADATA_VERSION,
        startedAt: now - 10, finishedAt: now, status: "done", sessionId: "original-native-context", workdir: null, worktree: null,
        prompt: "original accepted task", args: { title: "original title", future: { accepted: ["context"] } },
        masters: [supervisor.name], ownershipHistory: [], host: null, queuedMessages: [],
        future: { accepted: { payload: ["unknown retained bytes", { nested: true }] } } };
      const { supervisor: omitted, ...prior } = { ...first, id: "legacy", name: "codex-job-legacy" };
      const original = JSON.stringify({ version: 1, futureDocument: { keep: true }, jobs: [first, prior] });
      writeFileSync(path, original);
      let failures = 0, caught = 0, published = 0, assigned: Job | undefined;
      let controller: AbortController | undefined;
      const jobs = new JobManager(supervisor, { ...nullLogger, warn(message) {
        if (message === "could not save subagent jobs") caught++;
      } }, path);
      const originalWrite = jsonStore.writeJsonStore;
      const writer = vi.spyOn(jsonStore, "writeJsonStore").mockImplementation((target, value, previous) => {
        if (target === path && failures === 0) {
          failures++;
          assigned = state(jobs).history.get("legacy");
          controller = assigned?.controller;
          // SIMULATED write refusal. All other calls execute the original writer;
          // restore, retention, the catch and its normal retry remain source code.
          throw Object.assign(new Error(`SIMULATED ${code}`), { code });
        }
        originalWrite(target, value, previous);
        if (target === path) published++;
      });
      try {
        jobs.restore(() => () => () => new Promise<never>(() => {}));
        expect(failures).toBe(1);
        expect(caught).toBe(code === "EJOBLOCKED" ? 0 : 1);
        expect(published).toBe(0);
        expect(assigned).toBe(state(jobs).history.get("legacy"));
        expect(assigned!.supervisor).toBe(first.supervisor);
        expect(assigned!.controller).toBe(controller);
        expect(readFileSync(path, "utf8")).toBe(original);
        const retained = state(jobs).receipts.find(receipt => receipt.value.job.id === "legacy");
        expect(retained).toBeDefined();
        expect(retained!.value.job).toMatchObject({ ...prior, supervisor: first.supervisor });
      } catch (error) {
        writer.mockRestore(); jobs.setDormant(true); jobs.cancelAll(); throw error;
      }
      return { jobs, path, original, first, prior, legacy: assigned!, controller: controller!, writer,
        save(change: Record<string, unknown> = {}) {
          writeFileSync(path, JSON.stringify({ version: 1, futureDocument: { keep: true }, jobs: [first, { ...prior, ...change }] }));
        },
        close() { writer.mockRestore(); jobs.setDormant(true); jobs.cancelAll(); } };
    }

    it.each(["STORE_UPGRADE_DEFERRED", "EJOBLOCKED"] as const)("retains the exact assigned job immediately after one SIMULATED %s write refusal", async code => {
      await supervisor.setSessionId("learned-session");
      const fixture = deferred(code);
      try {
        // No yield, retry, polling or extra persistence before this lookup.
        const legacy = fixture.jobs.find("codex-job-legacy")!;
        expect(legacy).toBe(fixture.legacy);
        expect(legacy.controller).toBe(fixture.controller);
        expect(legacy.supervisor).toBe(fixture.first.supervisor);
        expect(legacy).toMatchObject(fixture.prior);
        expect(legacy.recoveredRecord).toEqual(fixture.prior);
        expect(readFileSync(fixture.path, "utf8")).toBe(fixture.original);
        expect(fixture.jobs.find(legacy.name)).toBe(legacy);
        expect(legacy.supervisor).toBe(fixture.first.supervisor);
        fixture.writer.mockRestore();
        // Only AFTER the immediate assertions, allow the ordinary source retry
        // to publish. This is eventual-publication coverage, not an assertion fix.
        await until(() => JSON.parse(readFileSync(fixture.path, "utf8")).version === jsonStore.JSON_STORE_VERSION);
        const saved = readStore(fixture.path).find(job => job.id === "legacy")!;
        expect(saved).toMatchObject({ ...fixture.prior, supervisor: fixture.first.supervisor });
        expect(JSON.parse(readFileSync(fixture.path, "utf8")).futureDocument).toEqual({ keep: true });
        expect(fixture.jobs.find(legacy.name)).toBe(legacy);
        expect(legacy.controller).toBe(fixture.controller);
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
      } finally { fixture.close(); }
    });

    it.each([
      ["supervisor", { supervisor: "explicit-durable-group" }],
      ["null", { supervisor: null }],
      ["number", { supervisor: 0 }],
      ["false", { supervisor: false }],
      ["empty string", { supervisor: "" }],
      ["array", { supervisor: [] }],
      ["object", { supervisor: { malformed: true } }],
    ] as const)("honors a present durable %s and never resurrects the old witness", (_label, change) => {
      const fixture = deferred();
      try {
        fixture.save(change);
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toEqual(change.supervisor);
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        fixture.save();
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toBeUndefined();
      } finally { fixture.close(); }
    });

    it("honors a SIMULATED undefined-present loaded row without altering its cached source", () => {
      const fixture = deferred(), originalClone = fileCache.cloneJson;
      const cloning = vi.spyOn(fileCache, "cloneJson").mockImplementation(<T,>(value: T): T => {
        const copy = originalClone(value);
        if (copy && typeof copy === "object" && "id" in copy && copy.id === "legacy") {
          // JSON cannot encode undefined: simulate only the selected, detached
          // loaded record after the original clone, never mutate a cached DTO.
          Object.defineProperty(copy, "supervisor", { value: undefined, enumerable: true, writable: true, configurable: true });
        }
        return copy;
      });
      try {
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toBeUndefined();
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        expect(readFileSync(fixture.path, "utf8")).toBe(fixture.original);
        cloning.mockRestore();
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toBeUndefined();
      } finally { cloning.mockRestore(); fixture.close(); }
    });

    it.each([
      ["owner", { owner: "foreign-owner" }],
      ["executor", { executionOwner: "different-executor" }],
      ["executor PID", { executionPid: 123 }],
      ["parent", { parentJob: "codex-job-parent" }],
      ["root session", { rootSession: "different-root" }],
      ["root name", { rootName: "different-owner" }],
      ["masters", { masters: ["different-master"] }],
      ["history", { ownershipHistory: [{ id: "handoff", at: 1, from: "former", to: "current", reason: "explicit-handoff" }] }],
      ["metadata", { metadataVersion: 99 }],
      ["remote", { remote: { host: "different-host" } }],
    ] as const)("invalidates the assignment on a durable %s change before any skipped import", (_label, change) => {
      const fixture = deferred();
      try {
        fixture.save(change);
        fixture.jobs.refreshOwnership();
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        // Returning to the old row cannot revive this source assignment.
        fixture.save();
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toBeUndefined();
      } finally { fixture.close(); }
    });

    it("imports a new durable turn without retaining the prior assignment or resetting its controller on passive refresh", () => {
      const fixture = deferred();
      try {
        fixture.save({ startedAt: fixture.prior.startedAt + 1 });
        const current = fixture.jobs.find(fixture.legacy.name)!;
        expect(current).toBe(fixture.legacy);
        expect(current.startedAt).toBe(fixture.prior.startedAt + 1);
        expect(current.supervisor).toBeUndefined();
        expect(current.controller).toBe(fixture.controller);
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        fixture.save();
        expect(fixture.jobs.find(current.name)!.supervisor).toBeUndefined();
      } finally { fixture.close(); }
    });

    it("honors handoff ownership and its existing historical grants without authorizing an unrelated manager", () => {
      const fixture = deferred();
      const foreign = new JobManager(new LocalCoordinator("foreign-owner", "foreign-session"), nullLogger, fixture.path);
      try {
        foreign.restore(() => undefined);
        expect(foreign.find(fixture.legacy.name, false)).toBeUndefined();
        expect(state(foreign).legacySupervisors.size).toBe(0);
        expect(readFileSync(fixture.path, "utf8")).toBe(fixture.original);
        fixture.save({ owner: "foreign-owner", supervisor: "foreign-group", rootName: "foreign-owner", rootSession: "foreign-session",
          masters: ["foreign-owner"],
          ownershipHistory: [{ id: "handoff", at: Date.now(), from: supervisor.name, to: "foreign-owner", reason: "explicit-handoff" }] });
        fixture.jobs.refreshOwnership();
        expect(state(fixture.jobs).history.has("legacy")).toBe(false);
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        // Existing controls retain the former owner's historical grant. The
        // lookup may expose a fresh foreign record, never the old assignment.
        const granted = fixture.jobs.find(fixture.legacy.name, false)!;
        expect(granted.owner).toBe("foreign-owner");
        expect(granted.supervisor).toBe("foreign-group");
        expect(granted).not.toBe(fixture.legacy);
        expect(granted.controller).not.toBe(fixture.controller);
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
      } finally { foreign.setDormant(true); foreign.cancelAll(); fixture.close(); }
    });

    it.each(["object", "controller", "local authority"] as const)("invalidates a changed %s even when the durable row is unchanged", kind => {
      const fixture = deferred();
      try {
        if (kind === "object") state(fixture.jobs).history.set("legacy", { ...fixture.legacy });
        else if (kind === "controller") fixture.legacy.controller = new AbortController();
        else fixture.legacy.masters!.push("local mutation");
        const current = fixture.jobs.find(fixture.legacy.name)!;
        expect(current.supervisor).toBeUndefined();
        expect(state(fixture.jobs).legacySupervisors.has("legacy")).toBe(false);
        if (kind === "object") {
          expect(current).not.toBe(fixture.legacy);
          state(fixture.jobs).history.set("legacy", fixture.legacy);
        } else if (kind === "controller") fixture.legacy.controller = fixture.controller;
        expect(fixture.jobs.find(fixture.legacy.name)!.supervisor).toBeUndefined();
      } finally { fixture.close(); }
    });
  });

  it("allows only explicit named session grants and preserves the supervisor's reply thread", async () => {
    const external = env.node("claude-reviewer");
    await external.start();
    const request = (await external.send({ to: supervisor.name, body: "Review this contract" })).messages[0]!;
    const denied = await sibling("denied", "codex");
    await expect(denied.child.siblings.send(external.name, "Unsolicited reply", request.id)).rejects.toThrow(/explicit send_to/);
    const allowed = await sibling("allowed", "codex", undefined, true, [external.name]);
    expect(await allowed.child.siblings.policy!()).toEqual({ maxHops: DEFAULT_SIBLING_MAX_HOPS, sendTo: [external.name] });
    const reply = (await allowed.child.siblings.send(external.name, "Review deliverable", request.id)).messages[0]!;
    expect(reply).toMatchObject({ replyTo: request.id, conversationId: request.conversationId, hop: 1 });
    await until(() => external.unread().length === 1);
    expect(external.unread()[0]!.from.name).toBe(allowed.job.name);
    for (const to of ["*", "claude", "codex", "opencode", "remote/session", "claude-*"]) expect(isJobSendTarget(to)).toBe(false);
    await expect(allowed.child.siblings.send(external.name, "Wrong reply", "missing")).rejects.toThrow(/reply_to/);
    await expect(external.send({ to: denied.job.name, body: "Other job request" })).rejects.toThrow("No message was stored");
    const unrelated = (await external.send({ to: "unrelated-session", body: "Other session request" })).messages[0]!;
    await expect(allowed.child.siblings.send(external.name, "Wrong job reply", unrelated.id)).rejects.toThrow(/reply_to/);
    await external.stop();
    await expect.poll(async () => (await supervisor.peers()).map((p) => p.name)).not.toContain(external.name);
    expect((await allowed.chat.send(external.name, "Queued deliverable")).queuedFor).toEqual([external.name]);
  });

  it("permits only exact cross-session job grants with quiet copies for both owners", async () => {
    const otherOwner = env.node("claude-other-owner");
    await otherOwner.start();
    const a = await sibling("a", "codex", "session-a", true, ["opencode-job-b"]);
    const b = await sibling("b", "opencode", "session-b");
    await supervisor.handoffSubagents({ to: otherOwner.name, jobs: [b.job.name] });
    await b.node.updateJob({ jobParent: otherOwner.name });
    // Settle the separate, durable handoff notices before measuring just the
    // quiet sibling observer copies created by the following send.
    await until(() => otherOwner.unread().some(m => m.conversationId.startsWith("handoff-")) && supervisor.unread().some(m => m.conversationId.startsWith("handoff-")));
    otherOwner.markRead(otherOwner.unread().map(m => m.id)); supervisor.markRead(supervisor.unread().map(m => m.id));
    const outsider = await sibling("outsider", "claude", "session-b");
    expect(await a.child.siblings.peers()).toEqual([{ name: b.job.name, title: "Task b", agent: "opencode", status: "running" }]);
    await expect(a.chat.send(outsider.job.name, "Not granted")).rejects.toThrow(/explicit send_to/);
    const first = (await a.child.siblings.send(b.job.name, "Contract update")).messages[0]!;
    await until(() => b.node.hasSeen(first.id) && otherOwner.unread().length === 1 && supervisor.unread().length === 1);
    const delivered = (await b.child.inbox())[0]?.body;
    expect(delivered).toContain("Contract update\n\n[agent-bridge routing hint:");
    expect(delivered).toContain(`answer via your supervisor ${otherOwner.name}`);
    expect(otherOwner.unread().every(isSiblingNote)).toBe(true);
    expect(supervisor.unread().every(isSiblingNote)).toBe(true);
    await expect(b.chat.send(a.job.name, "No reciprocal grant", first.id)).rejects.toThrow(/explicit send_to/);
    await b.node.stop();
    await expect.poll(() => a.chat.peers()).toEqual([expect.objectContaining({ name: b.job.name, status: "running" })]);
    const resumed = await sibling("b", "opencode", "session-b", true, [a.job.name]);
    await resumed.node.updateJob({ jobParent: otherOwner.name });
    const reply = (await resumed.chat.send(a.job.name, "Granted reply", first.id)).messages[0]!;
    expect(reply).toMatchObject({ hop: 1, conversationId: first.conversationId, replyTo: first.id });
    await expect(a.chat.send(b.job.name, "Wrong reply", "missing")).rejects.toThrow(/reply_to/);
    await expect(outsider.node.send({ to: a.job.name, body: "Forged thread", conversationId: first.conversationId })).rejects.toThrow(/explicit send_to/);
    let message = reply;
    for (let hop = 2; hop < DEFAULT_SIBLING_MAX_HOPS; hop++) {
      const sender = hop % 2 ? resumed : a;
      const recipient = hop % 2 ? a : resumed;
      message = (await sender.chat.send(recipient.job.name, `Detail ${hop}`, message.id)).messages[0]!;
    }
    await expect(a.chat.send(resumed.job.name, "Cross-session over budget", message.id)).rejects.toThrow(/Durable notice/);
    await until(() => a.node.unread().some((m) => m.conversationId.startsWith("sibling-drop-")));
    const notice = a.node.unread().find((m) => m.conversationId.startsWith("sibling-drop-"))!;
    // Different sockets have no shared delivery order: wait for this owner's exact copy too.
    await expect.poll(() => supervisor.get(notice.id)).toMatchObject({
      id: notice.id, recipient: supervisor.name, body: notice.body,
    });
    expect(notice.body).toContain("Cross-session over budget");
    expect(resumed.node.unread().some((m) => m.body === "Cross-session over budget")).toBe(false);
    await otherOwner.stop();
  });

  it("waits for supervisor hop notices when sender delivery arrives first", async () => {
    const a = await sibling("a", "codex", "session-a", true, ["opencode-job-b"]);
    const b = await sibling("b", "opencode", "session-b", true, [a.job.name]);
    const first = (await b.chat.send(a.job.name, "Contract question")).messages[0]!;
    // Hold only the supervisor's event before it enters the local inbox. This deterministically
    // reproduces independent socket delivery, while the real broker still persists both copies.
    const receiver = supervisor as unknown as { onEvent(event: string, data: unknown): void };
    const receive = receiver.onEvent.bind(receiver);
    let held: BridgeMessage | undefined;
    let release: NodeJS.Immediate | undefined;
    const gate = vi.spyOn(receiver, "onEvent").mockImplementation((event, data) => {
      const message = data as BridgeMessage;
      if (event === "message" && message.conversationId.startsWith("sibling-drop-")) held = message;
      else receive(event, data);
    });
    try {
      await expect(a.node.sendSibling({ to: b.job.name, body: "Delayed-owner over budget", replyTo: first.id }, 1)).rejects.toThrow(/Durable notice/);
      await until(() => held !== undefined && a.node.unread().some((m) => m.id === held!.id));
      const notice = a.node.get(held!.id)!;
      expect(supervisor.get(notice.id)).toBeUndefined();
      expect(await a.node.messageReceipt(notice.id)).toEqual(expect.arrayContaining([
        { recipient: supervisor.name, readAt: null },
      ]));
      // An immediate assertion here used to fail. Release on the next event-loop turn, without sleeps.
      release = setImmediate(() => { gate.mockRestore(); receive("message", held!); });
      await expect.poll(() => supervisor.get(notice.id)).toMatchObject({
        id: notice.id, recipient: supervisor.name, body: notice.body,
      });
      expect(notice.body).toContain("Delayed-owner over budget");
      expect(b.node.unread().some((m) => m.body === "Delayed-owner over budget")).toBe(false);
    } finally {
      if (release) clearImmediate(release);
      gate.mockRestore();
      if (held && !supervisor.hasSeen(held.id)) receive("message", held);
    }
  });

  it("returns the saved report for an explicitly granted finished job from another session", async () => {
    const a = await sibling("a", "codex", undefined, true, ["opencode-job-past"]);
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
      { id: "past", name: "opencode-job-past", agent: "opencode", status: "interrupted", supervisor: "other-session", owner: "claude-other", report: "Interrupted findings" },
    ] }));
    expect((await a.chat.peers())[0]).toMatchObject({ name: "opencode-job-past", status: "interrupted" });
    expect((await a.chat.send("opencode-job-past", "Follow up")).finishedRecipient).toMatchObject({ report: "Interrupted findings" });
    await expect(a.chat.send("opencode-job-missing", "Unknown job")).rejects.toThrow(/explicit send_to/);
  });

  it.each(["claude", "opencode"] as const)("keeps a handed-off pair authorized with quiet %s observer mail", async agent => {
    const a = await sibling("a", "codex"), b = await sibling("b", "opencode");
    const observer = env.node(`${agent}-observer`, agent); await observer.start();
    await supervisor.handoffSubagents({ to: observer.name, jobs: [a.job.name, b.job.name] });
    await a.node.updateJob({ jobParent: observer.name }); await b.node.updateJob({ jobParent: observer.name });
    await observer.refreshPending();
    expect(observer.unread().some(m => m.conversationId.startsWith("handoff-"))).toBe(true);
    observer.markRead(observer.unread().map(m => m.id));
    expect(await a.chat.peers()).toContainEqual(expect.objectContaining({ name: b.job.name }));
    const sent = (await a.chat.send(b.job.name, "Quiet observer copy")).messages[0]!;
    await expect.poll(() => observer.unread()).toEqual([expect.objectContaining({ body: expect.stringContaining("Quiet observer copy") })]);
    expect(observer.unread().every(isSiblingNote)).toBe(true);
    const ctx = { agent, node: observer, home: env.home, cfg: { ...DEFAULT_CONFIG }, log: nullLogger, cwd: () => env.home, channelActive: () => true } as ServerContext;
    expect(JSON.stringify(await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: observer.currentSessionId, stopHookActive: false }))).not.toContain("Quiet observer copy");
    expect(observer.unread()).toHaveLength(1);
    expect((await a.node.messageReceipt(sent.id))[0]!.readAt).toBeNull();
    const outsider = await sibling("outsider", "claude");
    await expect(a.chat.send(outsider.job.name, "No grant")).rejects.toThrow(/explicit send_to/);
  });

  it.each(["claude", "opencode"] as const)("keeps supervisor copies quiet for a %s notification client", async (agent) => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    const name = `${agent}-observer`;
    const client = new Client({ name: "test-observer", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DASHBOARD: "off",
        AGENT_BRIDGE_DELIVERY: "channel", [DELEGATE_DEPTH_ENV]: "0" } as Record<string, string>, stderr: "ignore" });
    const notifications: unknown[] = [];
    const method = agent === "claude" ? "notifications/claude/channel" : "notifications/agent-bridge/message";
    client.setNotificationHandler(z.object({ method: z.literal(method), params: z.unknown().optional() }), (n) => { notifications.push(n); });
    await client.connect(transport);
    try {
      await client.callTool({ name: "peers", arguments: {} });
      await client.callTool({ name: "hook_event", arguments: { event: "SessionStart", session_id: `observer-${agent}` } });
      // Keep the pair in the same authenticated supervisor family. Moving only
      // A deliberately revokes its implicit sibling access to B.
      const observer = (await supervisor.peers()).find(p => p.name === name)!;
      expect(observer).toMatchObject({ agent, sessionId: `observer-${agent}` });
      const handoff = await supervisor.handoffSubagents({ to: name, jobs: [a.job.name, b.job.name] });
      await a.node.updateJob({ jobParent: name });
      await b.node.updateJob({ jobParent: name });
      const handoffId = `${handoff.id}-inherited`, store = (supervisor as any).broker.store;
      expect(store.byId(handoffId)).toMatchObject({ recipient: name, recipientNative: nativeOwner(observer),
        recipientMailbox: { kind: "local", namespace: store.namespace }, body: expect.stringContaining("Inherited subagents") });
      const notificationIds = () => notifications.map(n => {
        const params = (n as { params: { message_id?: string; meta?: { message_id: string } } }).params;
        return agent === "claude" ? params.meta?.message_id : params.message_id;
      });
      // Both wires attest the same actual handoff ID. Claude pushes the body
      // and consumes it; opencode sends only an ID and requires an inbox read.
      await expect.poll(notificationIds).toEqual([handoffId]);
      if (agent === "claude") expect(JSON.stringify(notifications[0])).toContain("Inherited subagents");
      else expect(JSON.stringify(await client.callTool({ name: "inbox", arguments: { id: handoffId, mark_read: true } }))).toContain("Inherited subagents");
      await expect.poll(() => store.receipts(handoffId).find((r: { recipient: string }) => r.recipient === name)?.readAt).toBeTypeOf("number");
      // Durable ACK follows channel write/explicit consumption. The subsequent
      // MCP response is a wire barrier; retain all notifications and reject any
      // unexpected or duplicate event instead of clearing a hidden backlog.
      await client.callTool({ name: "peers", arguments: {} });
      expect(notificationIds()).toEqual([handoffId]);
      const settledNotifications = notifications.slice();
      await a.chat.send(b.job.name, "Quiet observer copy");
      await expect.poll(async () => JSON.stringify(await client.callTool({ name: "inbox", arguments: { mark_read: false } }))).toContain("Quiet observer copy");
      expect(notifications).toEqual(settledNotifications);
      const hook = await client.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: `observer-${agent}` } });
      expect(JSON.stringify(hook)).not.toContain("Quiet observer copy");
      expect(JSON.stringify(await client.callTool({ name: "inbox", arguments: { mark_read: false } }))).toContain("Quiet observer copy");
      expect(notifications).toEqual(settledNotifications);
    } finally {
      await client.close();
    }
  });

  it("keeps hop counts through replies and prevents another hop at the limit", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    let message = (await a.chat.send(b.job.name, "Contract question")).messages[0]!;
    for (let hop = 1; hop < DEFAULT_SIBLING_MAX_HOPS; hop++) {
      const sender = hop % 2 ? b : a;
      const recipient = hop % 2 ? a : b;
      message = (await sender.chat.send(recipient.job.name, `Contract detail ${hop}`, message.id)).messages[0]!;
      expect(message.hop).toBe(hop);
    }
    expect(formatSiblingMessages([message])).toContain("0 replies remain");
    await expect(a.chat.send(b.job.name, "Over budget", message.id)).rejects.toThrow(/32-message hop limit/);
    await until(() => supervisor.unread().length === DEFAULT_SIBLING_MAX_HOPS + 1);
    const notice = supervisor.unread().find((m) => m.conversationId.startsWith("sibling-drop-"))!;
    expect(notice.body).toContain("Over budget");
    expect(notice.body).toContain("target did not receive");
    await until(() => a.node.unread().some((m) => m.id === notice.id));
    expect(a.node.unread().find((m) => m.id === notice.id)?.body).toBe(notice.body);
    expect(b.node.unread().some((m) => m.body === "Over budget")).toBe(false);
  });

  it("deduplicates a retried send and its observer copy", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const args = { to: b.job.name, body: "One handover", dedupeKey: "retry-key" };
    const first = await a.node.sendSibling(args, MAX_HOPS);
    expect(await a.node.sendSibling(args, MAX_HOPS)).toEqual(first);
    await until(() => supervisor.unread().length === 1);
    expect(await b.child.inbox()).toHaveLength(1);
  });

  it("holds chat until a real next turn without answering approvals or restarting the job", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude", undefined, false);
    let approved = false;
    b.job.pendingApproval = () => { approved = true; };
    const sent = (await a.chat.send(b.job.name, "allow")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(b.job.queue).toEqual([]);
    b.job.live = { post: (body, message) => b.parent.post(body, message) };
    b.chat.flush();
    expect(await b.child.inbox()).toMatchObject([{ sibling: { from: { name: a.job.name }, body: "allow" } }]);
    expect(approved).toBe(false);
    expect(b.job.pendingApproval).toBeTypeOf("function");
    expect(b.job.awaitingAnswer).toBeUndefined();
  });

  it("injects siblings as colleagues through hooks and preserves unacknowledged parent messages", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    const parentMessage = b.parent.post("Stop after testing");
    const first = (await a.chat.send(b.job.name, "Capture is ready")).messages[0]!;
    await until(() => supervisor.unread().length === 1);
    const ctx = { node: null, log: nullLogger, parent: b.child } as unknown as ServerContext;
    const hook = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false }) as { reason: string };
    expect(hook.reason).toContain(`from="${a.job.name}" agent="codex"`);
    expect(hook.reason).toContain("not from your user");
    expect(hook.reason).toContain(`id="${parentMessage.id}" from="${supervisor.name}" relation="parent"`);
    await b.child.siblings.send(a.job.name, "Thanks", first.id);
    expect(await b.parent.close()).toEqual(["Stop after testing"]);
  });

  it("keeps sibling messages as history instead of restarting a completed report", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    b.job.live = { post: (body, message) => b.parent.post(`Sibling ${message!.from.name}: ${body}`, message) };
    await a.chat.send(b.job.name, "Finish the capture");
    await until(() => supervisor.unread().length === 1);
    await b.child.inbox();
    await b.child.send("Parent status note");
    expect(await b.parent.close()).toEqual([]);
  });

  it("writes observer copies to durable history even when the supervisor is offline", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const host = env.node("other-host", "other");
    await host.start();
    await supervisor.stop();
    await until(() => host.isBroker && a.node.isConnected && b.node.isConnected);
    await a.chat.send(b.job.name, "Offline handover");
    const replacement = env.node("claude-supervisor", "claude", false, supervisor.currentSessionId!);
    await replacement.start();
    await until(() => replacement.unread().length === 1);
    expect(replacement.unread()[0]!.body).toContain("Offline handover");
    expect(isSiblingNote(replacement.unread()[0]!)).toBe(true);
  });

  it("shows the direct message and its supervisor copy in the dashboard", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    await a.chat.send(b.job.name, "Dashboard handover");
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      const first = await fetch(ui.url, { redirect: "manual" });
      const cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
      const base = ui.url.replace(/\/\?t=.*$/, "");
      const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as {
        messages: { from_name: string; recipients: string; body: string }[];
      };
      expect(state.messages.filter((m) => m.from_name === a.job.name)).toHaveLength(2);
      expect(state.messages.some((m) => m.recipients === b.job.name && m.body === "Dashboard handover")).toBe(true);
      expect(state.messages.some((m) => m.recipients === supervisor.name && m.body.includes("Dashboard handover"))).toBe(true);
    } finally {
      await ui.close();
    }
  });
});
