import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { CodexWaker } from "../src/mcp/codex-wake.js";
import { until } from "./helpers.js";

/** `codex queue ...` is played by node running a script named "queue" in the node's cwd. */
function fakeCodex(dir: string, exitCode: number, delayMs: number): void {
  writeFileSync(
    join(dir, "queue"),
    `require("fs").appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x"); setTimeout(() => process.exit(${exitCode}), ${delayMs});`,
  );
}

function fakeNode(cwd: string) {
  const node = new EventEmitter() as EventEmitter & { autoWakeEnabled: boolean; cwd: string; inbox: BridgeMessage[]; unread: () => BridgeMessage[]; isNotificationAwaited: (m: BridgeMessage) => boolean };
  node.autoWakeEnabled = true;
  node.cwd = cwd;
  node.inbox = [];
  node.unread = () => node.inbox;
  node.isNotificationAwaited = () => false;
  return node;
}

const mail = (id: string): BridgeMessage => ({
  id,
  recipient: "codex-app",
  from: { id: "c", name: "claude-app", agent: "claude" },
  to: "codex-app",
  conversationId: id,
  replyTo: null,
  hop: 0,
  body: id,
  createdAt: Date.now(),
  readAt: null,
});

describe("CodexWaker", () => {
  let dir: string;
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").length : 0);
  const cfg = () => ({ codexBin: process.execPath, maxHops: 6 }) as BridgeConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ab-wake-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("wakes the fallback master for direct job mail with auto-wake off", async () => {
    fakeCodex(dir, 0, 0);
    const node = fakeNode(dir); node.autoWakeEnabled = false;
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("fallback-thread");
    node.inbox.push({ ...mail("note"), from: { id: "job:1234", name: "codex-job-1234", agent: "codex" }, conversationId: "job-1234:note" });
    node.emit("message", node.inbox[0]);
    expect((waker as unknown as { timer: unknown }).timer).toBeNull();
    node.inbox.push({ ...node.inbox[0]!, id: "fallback-note", conversationId: "job-1234:fallback" });
    node.emit("message", node.inbox[1]);
    await until(() => calls() === 1);
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
    expect(node.inbox).toHaveLength(2);
  });

  it("does not schedule a wake for a quiet sibling observer copy, including on an idle report", () => {
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push({ ...mail("m1"), conversationId: "siblings-conversation:note" });
    node.emit("message", node.inbox[0]);
    waker.setActivity("idle");
    expect((waker as unknown as { timer: unknown }).timer).toBeNull();
    expect(calls()).toBe(0);
  });

  it("wakes again when the queued turn ended while `codex queue` was still running and mail is left", async () => {
    fakeCodex(dir, 0, 200);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push(mail("m1"));
    node.emit("message", node.inbox[0]);
    await until(() => calls() === 1, 5_000);
    // The queued turn runs and ends before the queue command returns; new mail arrived meanwhile.
    waker.setActivity("busy");
    node.inbox.splice(0, 1, mail("m2"));
    node.emit("message", node.inbox[0]);
    waker.setActivity("idle");
    await until(() => calls() === 2, 6_000);
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
  });

  it("a failed queue call does not overwrite a busy state reported meanwhile", async () => {
    fakeCodex(dir, 1, 200);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push(mail("m1"));
    node.emit("message", node.inbox[0]);
    await until(() => calls() === 1, 5_000);
    waker.setActivity("busy"); // the user started a turn
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
    expect((waker as unknown as { state: string }).state).toBe("busy");
    // Mail for a busy session must not trigger a wake-up.
    node.inbox.push(mail("m2"));
    node.emit("message", node.inbox[1]);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls()).toBe(1);
  });

  it("does not retry a failing queue call on its own", async () => {
    fakeCodex(dir, 1, 0);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push(mail("m1"));
    node.emit("message", node.inbox[0]);
    await until(() => calls() === 1, 5_000);
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls()).toBe(1);
  });

  it("queues an awaited reply with auto-wake off and leaves mail unread if queuing fails", async () => {
    fakeCodex(dir, 1, 0);
    const node = fakeNode(dir); node.autoWakeEnabled = false;
    node.isNotificationAwaited = (m) => m.id === "awaited";
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push(mail("unrelated")); node.emit("message", node.inbox[0]);
    expect((waker as unknown as { timer: unknown }).timer).toBeNull();
    node.inbox.push(mail("awaited")); node.emit("message", node.inbox[1]);
    await until(() => calls() === 1);
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
    expect(node.inbox).toHaveLength(2); expect(node.autoWakeEnabled).toBe(false);
  });

  it("rechecks restored subscriptions on identity changes and keeps quiet and hop guards", async () => {
    fakeCodex(dir, 0, 0);
    const node = fakeNode(dir); node.autoWakeEnabled = false;
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger, { debounceMs: 20, queueTimeoutMs: 2_000 });
    waker.setThreadId("thread-1");
    node.inbox.push({ ...mail("awaited"), hop: 6 }, { ...mail("awaited"), conversationId: "files-progress-id" });
    node.isNotificationAwaited = () => true;
    node.emit("notification_waits_changed");
    expect((waker as unknown as { timer: unknown }).timer).toBeNull();
    node.inbox.push(mail("awaited")); node.emit("notification_waits_changed");
    await until(() => calls() === 1);
    await until(() => !(waker as unknown as { inFlight: boolean }).inFlight);
    expect(node.inbox).toHaveLength(3);
  });

});
