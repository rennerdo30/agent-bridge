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
  const node = new EventEmitter() as EventEmitter & { autoWakeEnabled: boolean; cwd: string; inbox: BridgeMessage[]; unread: () => BridgeMessage[] };
  node.autoWakeEnabled = true;
  node.cwd = cwd;
  node.inbox = [];
  node.unread = () => node.inbox;
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

  it("wakes again when the queued turn ended while `codex queue` was still running and mail is left", async () => {
    fakeCodex(dir, 0, 800);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger);
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
    await new Promise((r) => setTimeout(r, 1_200)); // let the second queue call exit (it holds the folder)
  }, 15_000);

  it("a failed queue call does not overwrite a busy state reported meanwhile", async () => {
    fakeCodex(dir, 1, 800);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger);
    waker.setThreadId("thread-1");
    node.inbox.push(mail("m1"));
    node.emit("message", node.inbox[0]);
    await until(() => calls() === 1, 5_000);
    waker.setActivity("busy"); // the user started a turn
    await new Promise((r) => setTimeout(r, 1_200)); // the queue call fails meanwhile
    expect((waker as unknown as { state: string }).state).toBe("busy");
    // Mail for a busy session must not trigger a wake-up.
    node.inbox.push(mail("m2"));
    node.emit("message", node.inbox[1]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(calls()).toBe(1);
  }, 15_000);

  it("does not retry a failing queue call on its own", async () => {
    fakeCodex(dir, 1, 0);
    const node = fakeNode(dir);
    const waker = new CodexWaker(node as unknown as BridgeNode, cfg(), nullLogger);
    waker.setThreadId("thread-1");
    node.inbox.push(mail("m1"));
    node.emit("message", node.inbox[0]);
    await until(() => calls() === 1, 5_000);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(calls()).toBe(1);
  }, 15_000);
});
