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
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { call.killed = true; return true; } });
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
    expect((await t3SendMessage("C:\\Users\\First Last\\.t3\\bin\\t3.cmd", "thread-1", text, { spawnFn: win.spawnFn, platform: "win32" })).state).toBe("accepted");
    // `cmd /s /c` strips one outer pair of quotes: the launcher path keeps its own quotes (paths with spaces).
    expect(win.calls[0]!.args).toEqual(["/d", "/s", "/c", "\"\"C:\\Users\\First Last\\.t3\\bin\\t3.cmd\" thread send --json thread-1 -\""]);
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
    // On Windows the launcher runs under cmd.exe: its whole tree goes, by this child's own PID.
    const hungWin = fakeSpawn({ hang: true });
    expect((await t3SendMessage("C:\\t3.cmd", "thread-1", "x", { spawnFn: hungWin.spawnFn, platform: "win32", timeoutMs: 50 })).state).toBe("unknown");
    expect(hungWin.calls[1]).toMatchObject({ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] });
    // Stopping the endpoint aborts a pending send the same way.
    const stopped = fakeSpawn({ hang: true });
    const ac = new AbortController();
    const pending = t3SendMessage("/t3", "thread-1", "x", { spawnFn: stopped.spawnFn, platform: "linux", signal: ac.signal });
    ac.abort();
    expect((await pending).state).toBe("unknown");
    expect(stopped.calls[0]!.killed).toBe(true);
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
  let sent: { thread: string; text: string; signal: AbortSignal }[];
  let outcome: T3SendOutcome;
  let hold: Promise<void> | null;

  async function setup(chat: string | null = "chat-1") {
    env = makeEnv();
    me = env.node("claude-w", "claude");
    peer = env.node("codex-p", "codex");
    await me.start(); await peer.start(); await me.setSessionId("sess-1");
    ctx = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: me, log: nullLogger, home: env.home, cwd: () => env.home,
      channelActive: () => false, rewakeAvailable: true, jobs: new JobManager(me, nullLogger) } as ServerContext;
    sent = [];
    hold = null;
    outcome = { state: "accepted", delivery: "started", runId: "run-1" };
    const t3: T3Delivery = {
      chat: (s) => (s === "sess-1" && chat ? chat : undefined),
      send: async (thread, text, signal) => { sent.push({ thread, text, signal }); if (hold) await hold; return outcome; },
    };
    rewake = new RewakeEndpoint(env.home, me, (m) => claudeWakeCandidate(ctx, m), nullLogger, (event) => reportModActivity(ctx, event),
      undefined, undefined, undefined, t3, 300);
    await rewake.start();
    rewake.register("sess-1");
    ctx.wakeDelivery = rewake.delivery();
  }
  afterEach(async () => { await rewake.stop(); await env.cleanup(); });

  function call(path: string, method = "GET", timeoutMs = 4_000) {
    const reg = JSON.parse(readFileSync(sessionFile(env.home, "sess-1"), "utf8")) as { port: number; secret: string };
    return fetch(`http://127.0.0.1:${reg.port}${path}`, { method, headers: { authorization: `Bearer ${reg.secret}` }, signal: AbortSignal.timeout(timeoutMs) });
  }
  /** A Stop-hook (or mod) poll; resolves with what it was handed, or "" if it was still waiting at the timeout. */
  function wait(role?: string, timeoutMs = 4_000): Promise<string> {
    return call(`/wait${role ? `?role=${role}` : ""}`, "GET", timeoutMs)
      .then(async (r) => (JSON.parse(await r.text()) as { text: string }).text, () => "");
  }

  it("an idle session's message goes into its T3 chat once, readable, and is read when that turn's prompt shows it", async () => {
    await setup();
    // A Stop hook waits too: while T3 delivers, it must not wake the session with the same message.
    const hook = wait(undefined, 3_000);
    await peer.send({ to: me.name, body: "Build finished, 12 tests passed." });
    await until(() => sent.length === 1, 5_000);
    expect(sent[0]!.thread).toBe("chat-1");
    expect(sent[0]!.text.startsWith(WAKE_HEADER)).toBe(true);
    expect(sent[0]!.text).toContain("Build finished, 12 tests passed.");
    const [id] = wakeMessageIds(sent[0]!.text);
    expect(ctx.wakeDelivery!.modActive!()).toBe(true);
    expect(ctx.wakeDelivery!.inFlight!(id!)).toBe(true);
    // T3's turn starts with that text as its prompt.
    ctx.wakeDelivery!.active();
    ctx.wakeDelivery!.confirmPrompt!(sent[0]!.text);
    expect(me.unread().map((m) => m.id)).not.toContain(id);
    expect(await hook).toBe("");
    ctx.wakeDelivery!.idle!();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(sent).toHaveLength(1);
  });

  it("the mod holds while T3 delivers, and its acknowledgements never confirm a T3 delivery", async () => {
    await setup();
    const mod = wait("mod", 3_000);
    await peer.send({ to: me.name, body: "for T3 only" });
    await until(() => sent.length === 1, 5_000);
    const [id] = wakeMessageIds(sent[0]!.text);
    // An unrelated mod turn report (or a legacy acknowledgement) while the T3 delivery waits for its prompt.
    expect((await call("/mod?busy=1", "POST")).status).toBe(204);
    expect((await call("/mod?busy=0", "POST")).status).toBe(204);
    expect(me.unread().map((m) => m.id)).toContain(id);
    expect(ctx.wakeDelivery!.inFlight!(id!)).toBe(true);
    expect(await mod).toBe("");
  });

  it("an unrelated turn neither confirms a T3 delivery nor sends its messages again", async () => {
    await setup();
    outcome = { state: "unknown", reason: "timeout" };
    await peer.send({ to: me.name, body: "send me once" });
    await until(() => sent.length === 1, 5_000);
    const [id] = wakeMessageIds(sent[0]!.text);
    // A user prompt starts and ends before the T3 delivery's prompt shows up.
    ctx.wakeDelivery!.active();
    ctx.wakeDelivery!.confirmPrompt!("an ordinary user prompt");
    await new Promise((r) => setTimeout(r, 500));
    ctx.wakeDelivery!.idle!();
    await new Promise((r) => setTimeout(r, 2_500));
    expect(sent).toHaveLength(1);
    // Its prompt never came: it goes back to the hooks as a repeat, never through T3 again.
    expect(ctx.wakeDelivery!.repeated!(id!)).toBe(true);
    expect(ctx.wakeDelivery!.inFlight!(id!)).toBe(false);
  });

  it("the confirmation window counts only a full idle stretch: a turn ending just before it runs out starts it over", async () => {
    await setup();
    outcome = { state: "unknown", reason: "timeout" };
    await peer.send({ to: me.name, body: "queued behind a turn" });
    await until(() => sent.length === 1, 5_000);
    const [id] = wakeMessageIds(sent[0]!.text);
    // A turn runs for most of the 300 ms window and ends just before it runs out.
    ctx.wakeDelivery!.active();
    await new Promise((r) => setTimeout(r, 250));
    ctx.wakeDelivery!.idle!();
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.wakeDelivery!.inFlight!(id!)).toBe(true);
    // A full idle window without its prompt: back to the hooks, as a repeat.
    await until(() => !ctx.wakeDelivery!.inFlight!(id!), 2_000);
    expect(ctx.wakeDelivery!.repeated!(id!)).toBe(true);
  });

  it("a send whose prompt showed up before the CLI returned is still ended when the endpoint stops", async () => {
    await setup();
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    await peer.send({ to: me.name, body: "prompt first" });
    await until(() => sent.length === 1, 5_000);
    ctx.wakeDelivery!.active();
    ctx.wakeDelivery!.confirmPrompt!(sent[0]!.text);
    await rewake.stop();
    expect(sent[0]!.signal.aborted).toBe(true);
    release();
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

  it("without the mod, a refused send wakes the session through the waiting Stop hook", async () => {
    await setup();
    outcome = { state: "failed", reason: "no CLI" };
    const hook = wait(undefined, 5_000);
    await peer.send({ to: me.name, body: "refused" });
    expect(await hook).toContain("refused");
    expect(sent).toHaveLength(1);
    expect(ctx.wakeDelivery!.modActive!()).toBe(false);
  });

  it("without the mod, a send whose prompt never shows wakes the session through the Stop hook, as a repeat", async () => {
    await setup();
    outcome = { state: "unknown", reason: "timeout" };
    const hook = wait(undefined, 5_000);
    await peer.send({ to: me.name, body: "lost" });
    const text = await hook;
    expect(text).toContain("lost");
    expect(ctx.wakeDelivery!.repeated!(wakeMessageIds(sent[0]!.text)[0]!)).toBe(true);
  });

  it("with the mod, a refused send gives the messages to the mod", async () => {
    await setup();
    outcome = { state: "failed", reason: "no CLI" };
    expect((await call("/mod?busy=0", "POST")).status).toBe(204);
    await peer.send({ to: me.name, body: "to the mod" });
    await until(() => sent.length === 1, 5_000);
    expect(await wait("mod")).toContain("to the mod");
  });

  it("stopping the endpoint aborts a pending send and leaves nothing behind", async () => {
    await setup();
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    await peer.send({ to: me.name, body: "pending at stop" });
    await until(() => sent.length === 1, 5_000);
    await rewake.stop();
    expect(sent[0]!.signal.aborted).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 500));
    expect(sent).toHaveLength(1);
  });

  it("without a known T3 chat nothing changes: the Stop hooks wake the session as before", async () => {
    await setup(null);
    expect(ctx.wakeDelivery!.modActive!()).toBe(false);
    const woke = wait();
    await peer.send({ to: me.name, body: "plain wake" });
    expect(await woke).toContain("plain wake");
    expect(sent).toHaveLength(0);
  });
});
