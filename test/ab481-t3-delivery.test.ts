import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { t3ChatForNativeSession, t3SendMessage, type SpawnFn, type T3SendOutcome } from "../src/core/t3-chat.js";
import { reportModActivity } from "../src/mcp/hook-ownership.js";
import { claudeWakeCandidate } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import { RewakeEndpoint, WAKE_HEADER, sessionFile, wakeMessageIds, type T3Delivery } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

/** A fake child process: records stdin, answers with the given stdout and exit code. */
function fakeSpawn(answer: { stdout?: string; code?: number; error?: Error; hang?: boolean }) {
  const calls: { command: string; args: string[]; stdin: string; killed: boolean }[] = [];
  const spawnFn = ((command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { call.killed = true; return true; } });
    const call = { command, args, stdin: "", killed: false };
    calls.push(call);
    child.stdin.on("data", (c: Buffer) => { call.stdin += c.toString("utf8"); });
    child.stdin.on("finish", () => {
      if (answer.hang) return;
      setImmediate(() => {
        if (answer.error) { child.emit("error", answer.error); return; }
        if (answer.stdout) child.stdout.write(answer.stdout);
        child.stdout.end();
        child.emit("close", answer.code ?? 0);
      });
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

describe("t3SendMessage (T3's CLI)", () => {
  const receipt = JSON.stringify({ threadId: "thread-1", delivery: "queued", runId: "run-7", status: "queued", messageId: "m" });

  it("sends the message on stdin, never on the command line, and reads T3's receipt", async () => {
    const posix = fakeSpawn({ stdout: `${receipt}\n` });
    const text = "hello \"world\" & | % ^ <x>";
    expect(await t3SendMessage("/home/u/.t3/bin/t3", "thread-1", text, { spawnFn: posix.spawnFn, platform: "linux" }))
      .toEqual({ state: "accepted", delivery: "queued", runId: "run-7" });
    expect(posix.calls[0]).toMatchObject({ command: "/home/u/.t3/bin/t3", args: ["thread", "send", "--json", "thread-1", "-"], stdin: text });
    const win = fakeSpawn({ stdout: receipt });
    expect((await t3SendMessage("C:\\Users\\u\\.t3\\bin\\t3.cmd", "thread-1", text, { spawnFn: win.spawnFn, platform: "win32" })).state).toBe("accepted");
    expect(win.calls[0]!.args).toEqual(["/d", "/s", "/c", "\"C:\\Users\\u\\.t3\\bin\\t3.cmd\" thread send --json thread-1 -"]);
    expect(win.calls[0]!.stdin).toBe(text);
  });

  it("separates refused (never reached T3) from unknown (T3 may have it), and never retries", async () => {
    expect((await t3SendMessage("/t3", "bad id; rm", "x", { spawnFn: fakeSpawn({}).spawnFn, platform: "linux" })).state).toBe("failed");
    expect((await t3SendMessage("/t3", "thread-1", "x", { spawnFn: fakeSpawn({ error: new Error("ENOENT") }).spawnFn, platform: "linux" })).state).toBe("failed");
    const exit1 = fakeSpawn({ stdout: "", code: 1 });
    expect((await t3SendMessage("/t3", "thread-1", "x", { spawnFn: exit1.spawnFn, platform: "linux" })).state).toBe("unknown");
    expect((await t3SendMessage("/t3", "thread-1", "x", { spawnFn: fakeSpawn({ stdout: JSON.stringify({ threadId: "other", delivery: "queued" }) }).spawnFn, platform: "linux" })).state).toBe("unknown");
    const hung = fakeSpawn({ hang: true });
    expect((await t3SendMessage("/t3", "thread-1", "x", { spawnFn: hung.spawnFn, platform: "linux", timeoutMs: 50 })).state).toBe("unknown");
    expect(hung.calls[0]!.killed).toBe(true);
    expect(exit1.calls).toHaveLength(1);
  });
});

describe("t3ChatForNativeSession (T3's store, read-only)", () => {
  let env: TestEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(async () => { await env.cleanup(); });

  function store(rows: { thread: string; native: string; deleted?: boolean; archived?: boolean }[]): string {
    const home = join(env.home, "t3"); mkdirSync(join(home, "userdata"), { recursive: true });
    const db = new DatabaseSync(join(home, "userdata", "statev2.sqlite"));
    db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, archived_at TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT, updated_at TEXT);`);
    for (const r of rows) {
      db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)").run(r.thread, r.deleted ? "2026-11-01" : null, r.archived ? "2026-11-01" : null);
      db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run(r.thread, JSON.stringify({ nativeThreadRef: { nativeId: r.native } }), "2026-11-01");
    }
    db.close();
    return home;
  }

  it("finds the chat by the provider's own session id; skips deleted/archived chats and never guesses between two", () => {
    const home = store([{ thread: "chat-a", native: "sess-a" }, { thread: "chat-b", native: "sess-b", deleted: true },
      { thread: "chat-c", native: "sess-c", archived: true }, { thread: "chat-d", native: "sess-d" }, { thread: "chat-e", native: "sess-d" }]);
    expect(t3ChatForNativeSession(home, "sess-a")).toBe("chat-a");
    for (const id of ["sess-b", "sess-c", "sess-d", "unknown"]) expect(t3ChatForNativeSession(home, id), id).toBeUndefined();
    expect(t3ChatForNativeSession(join(env.home, "missing"), "sess-a")).toBeUndefined();
  });
});

describe("RewakeEndpoint with T3 delivery", () => {
  let env: TestEnv;
  let me: BridgeNode;
  let peer: BridgeNode;
  let rewake: RewakeEndpoint;
  let ctx: ServerContext;
  let sent: { thread: string; text: string }[];
  let outcome: T3SendOutcome;

  async function setup(chat: string | null = "chat-1") {
    env = makeEnv();
    me = env.node("claude-w", "claude");
    peer = env.node("codex-p", "codex");
    await me.start(); await peer.start(); await me.setSessionId("sess-1");
    ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: me, log: nullLogger, home: env.home, cwd: () => env.home,
      channelActive: () => false, rewakeAvailable: true, jobs: new JobManager(me, nullLogger) } as ServerContext;
    sent = [];
    outcome = { state: "accepted", delivery: "started", runId: "run-1" };
    const t3: T3Delivery = { chat: (s) => (s === "sess-1" && chat ? chat : undefined), send: async (thread, text) => { sent.push({ thread, text }); return outcome; } };
    rewake = new RewakeEndpoint(env.home, me, (m) => claudeWakeCandidate(ctx, m), nullLogger, (event) => reportModActivity(ctx, event),
      undefined, undefined, undefined, t3, 300);
    await rewake.start();
    rewake.register("sess-1");
    ctx.wakeDelivery = rewake.delivery();
  }
  afterEach(async () => { await rewake.stop(); await env.cleanup(); });

  function wait(role?: string) {
    const reg = JSON.parse(readFileSync(sessionFile(env.home, "sess-1"), "utf8")) as { port: number; secret: string };
    return fetch(`http://127.0.0.1:${reg.port}/wait${role ? `?role=${role}` : ""}`, { headers: { authorization: `Bearer ${reg.secret}` }, signal: AbortSignal.timeout(4_000) })
      .then(async (r) => JSON.parse(await r.text()) as { text: string; superseded: boolean });
  }

  it("an idle session's message goes into its T3 chat once, readable, and is read when that turn's prompt shows it", async () => {
    await setup();
    // The mod polls too: while T3 delivers, it must not submit the same message as an invisible turn.
    let modText = "";
    const mod = wait("mod").then((r) => { modText = r.text; }, () => {});
    await peer.send({ to: me.name, body: "Build finished, 12 tests passed." });
    await until(() => sent.length === 1, 5_000);
    expect(sent[0]!.thread).toBe("chat-1");
    expect(sent[0]!.text.startsWith(WAKE_HEADER)).toBe(true);
    expect(sent[0]!.text).toContain("Build finished, 12 tests passed.");
    const [id] = wakeMessageIds(sent[0]!.text);
    // On its way to its own T3 turn: the Stop hooks step aside and no hook injects it as well.
    expect(ctx.wakeDelivery!.modActive!()).toBe(true);
    expect(await wait()).toEqual({ text: "", superseded: true });
    expect(ctx.wakeDelivery!.inFlight!(id!)).toBe(true);
    // T3's turn starts with that text as its prompt.
    ctx.wakeDelivery!.active();
    ctx.wakeDelivery!.confirmPrompt!(sent[0]!.text);
    expect(me.unread().map((m) => m.id)).not.toContain(id);
    ctx.wakeDelivery!.idle!();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(sent).toHaveLength(1);
    expect(modText).toBe("");
    void mod;
  });

  it("a busy session's message is left to the hooks; it goes to T3 only after the turn ends unshown", async () => {
    await setup();
    ctx.wakeDelivery!.active();
    await peer.send({ to: me.name, body: "while busy" });
    await new Promise((r) => setTimeout(r, 2_000));
    expect(sent).toHaveLength(0);
    ctx.wakeDelivery!.idle!();
    await until(() => sent.length === 1, 5_000);
  });

  it("a refused send gives the messages straight back to the mod; the mod takes them", async () => {
    await setup();
    outcome = { state: "failed", reason: "no CLI" };
    await peer.send({ to: me.name, body: "refused" });
    await until(() => sent.length === 1, 5_000);
    await until(() => !ctx.wakeDelivery!.modActive!(), 2_000);
    // Not in flight anymore: a hook of the next turn may show it.
    expect(ctx.wakeDelivery!.inFlight!(wakeMessageIds(sent[0]!.text)[0]!)).toBe(false);
    const mod = await wait("mod");
    expect(mod.text).toContain("refused");
  });

  it("a send that starts no turn stops T3 delivery; its messages go back to the mod as repeats", async () => {
    await setup();
    outcome = { state: "unknown", reason: "timeout" };
    await peer.send({ to: me.name, body: "lost" });
    await until(() => sent.length === 1, 5_000);
    const [id] = wakeMessageIds(sent[0]!.text);
    await until(() => !ctx.wakeDelivery!.modActive!(), 3_000);
    expect(ctx.wakeDelivery!.repeated!(id!)).toBe(true);
    expect((await wait("mod")).text).toContain("lost");
  });

  it("without a known T3 chat nothing changes: the Stop hooks wake the session as before", async () => {
    await setup(null);
    expect(ctx.wakeDelivery!.modActive!()).toBe(false);
    const woke = wait();
    await peer.send({ to: me.name, body: "plain wake" });
    expect((await woke).text).toContain("plain wake");
    expect(sent).toHaveLength(0);
  });
});


